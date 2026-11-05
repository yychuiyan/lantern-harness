/**
 * 流式工具轮回归：思考 / 正文边收边推，tool_calls 在流内累积、流结束才执行。
 * 运行：npx tsx --test src/lib/llm-stream-tools.test.ts
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  streamChat,
  streamChatWithTools,
  type ChatMessage,
  type StreamChunk,
  type ToolDef,
} from './llm';

const settings = { baseURL: 'http://stub.local/v1', apiKey: 'k', model: 'deepseek-flash' };

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

/** 把一组 SSE 事件包成一个 200 响应 */
function sse(events: unknown[]): Response {
  const text = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** 按顺序发放响应，并记录每次请求体 */
function stubFetch(responses: Response[]): Array<Record<string, any>> {
  const bodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, any>);
    const next = responses.shift();
    if (!next) throw new Error('stub: 没有更多响应了');
    return next;
  }) as unknown as typeof fetch;
  return bodies;
}

function delta(payload: Record<string, unknown>, finish?: string): unknown {
  return { choices: [{ index: 0, delta: payload, finish_reason: finish ?? null }] };
}

const tools: ToolDef[] = [
  {
    type: 'function',
    function: { name: 'fs_list', description: '列出目录', parameters: { type: 'object' } },
  },
];

const messages: ChatMessage[] = [{ role: 'user', content: '看看 src 目录' }];

describe('streamChat 流式 tool_calls 累积', () => {
  it('分片参数拼接成完整调用，思考先到、调用后到', async () => {
    stubFetch([
      sse([
        delta({ reasoning_content: '先看看目录' }),
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'fs_list', arguments: '' },
            },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"src"}' } }] }),
        delta({}, 'tool_calls'),
      ]),
    ]);

    const seen: StreamChunk[] = [];
    for await (const chunk of streamChat(settings, messages, undefined, { tools }))
      seen.push(chunk);

    assert.equal(seen[0]?.type, 'reasoning');
    const done = seen.filter((c) => c.type === 'tool_calls_done');
    assert.equal(done.length, 1);
    const calls = done[0]?.type === 'tool_calls_done' ? done[0].calls : [];
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.function.name, 'fs_list');
    assert.equal(calls[0]?.function.arguments, '{"path":"src"}');
    assert.equal(calls[0]?.id, 'call_a');
    // 调用信号是最后一个 chunk，不会抢先于思考
    assert.equal(seen.at(-1)?.type, 'tool_calls_done');
  });

  it('声明工具时请求体带 tools / tool_choice', async () => {
    const bodies = stubFetch([sse([delta({ content: 'ok' }, 'stop')])]);
    for await (const _chunk of streamChat(settings, messages, undefined, { tools })) {
      // drain
    }
    const body = bodies[0];
    assert.equal(body?.tool_choice, 'auto');
    assert.equal((body?.tools as any[])?.[0]?.function?.name, 'fs_list');
  });

  it('并行多条调用按 index 归位', async () => {
    stubFetch([
      sse([
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'c0',
              type: 'function',
              function: { name: 'fs_list', arguments: '{}' },
            },
            { index: 1, id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '' } },
          ],
        }),
        delta({ tool_calls: [{ index: 1, function: { arguments: '{"path":"a"}' } }] }),
        delta({}, 'tool_calls'),
      ]),
    ]);
    const calls: any[] = [];
    for await (const chunk of streamChat(settings, messages, undefined, { tools })) {
      if (chunk.type === 'tool_calls_done') calls.push(...chunk.calls);
    }
    assert.deepEqual(
      calls.map((c) => [c.function.name, c.function.arguments]),
      [
        ['fs_list', '{}'],
        ['fs_read', '{"path":"a"}'],
      ],
    );
  });

  it('长度截断直接报错，不交付半截调用', async () => {
    stubFetch([
      sse([
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'c0',
              type: 'function',
              function: { name: 'fs_list', arguments: '{"path"' },
            },
          ],
        }),
        delta({}, 'length'),
      ]),
    ]);
    const seen: StreamChunk[] = [];
    await assert.rejects(async () => {
      for await (const chunk of streamChat(settings, messages, undefined, { tools }))
        seen.push(chunk);
    }, /长度上限/);
    assert.equal(
      seen.some((c) => c.type === 'tool_calls_done'),
      false,
    );
  });
});

describe('streamChatWithTools 真流式工具轮', () => {
  it('一轮调工具、二轮出正文，思考即时产出且 reasoning_content 回传', async () => {
    const bodies = stubFetch([
      sse([
        delta({ reasoning_content: '先看看目录' }),
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'fs_list', arguments: '' },
            },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"src"}' } }] }),
        delta({}, 'tool_calls'),
      ]),
      sse([
        delta({ reasoning_content: '看到了' }),
        delta({ content: '结果如下' }),
        delta({}, 'stop'),
      ]),
    ]);

    const ran: Array<[string, string]> = [];
    const seen: StreamChunk[] = [];
    for await (const chunk of streamChatWithTools(settings, messages, undefined, {
      tools,
      runTool: async (name, args) => {
        ran.push([name, args]);
        return 'a.ts\nb.ts';
      },
    })) {
      seen.push(chunk);
    }

    // 工具只执行一次，参数是拼接后的完整 JSON
    assert.deepEqual(ran, [['fs_list', '{"path":"src"}']]);
    // 调用信号不交给 UI
    assert.equal(
      seen.some((c) => c.type === 'tool_calls_done'),
      false,
    );
    // 思考在两轮里都即时产出，早于工具执行
    const firstReasoning = seen.findIndex((c) => c.type === 'reasoning');
    const toolRunning = seen.findIndex((c) => c.type === 'tool' && c.status === 'running');
    assert.ok(firstReasoning >= 0 && firstReasoning < toolRunning);
    // 正文照常流式
    assert.equal(
      seen
        .filter((c) => c.type === 'content')
        .map((c) => (c as any).delta)
        .join(''),
      '结果如下',
    );

    // 第二次请求必须带上 reasoning_content 与 tool 结果
    const second = bodies[1];
    const list = second?.messages as Array<Record<string, any>>;
    const assistant = list.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.equal(assistant?.reasoning_content, '先看看目录');
    assert.equal(assistant?.tool_calls?.[0]?.id, 'call_a');
    assert.ok(list.some((m) => m.role === 'tool' && m.tool_call_id === 'call_a'));
    assert.equal((second?.tools as any[])?.length, 1);
  });

  it('参数非法时整批不派发', async () => {
    stubFetch([
      sse([
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'c0',
              type: 'function',
              function: { name: 'fs_list', arguments: '{}' },
            },
            {
              index: 1,
              id: 'c1',
              type: 'function',
              function: { name: 'fs_read', arguments: '{"path":' },
            },
          ],
        }),
        delta({}, 'tool_calls'),
      ]),
    ]);
    const ran: string[] = [];
    await assert.rejects(async () => {
      for await (const _chunk of streamChatWithTools(settings, messages, undefined, {
        tools,
        runTool: async (name) => {
          ran.push(name);
          return 'ok';
        },
      })) {
        // drain
      }
    }, /不是合法 JSON/);
    // 合法的那条也不跑
    assert.deepEqual(ran, []);
  });

  it('windows 风格的非法转义先修复再执行', async () => {
    stubFetch([
      sse([
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'c0',
              type: 'function',
              function: { name: 'fs_read', arguments: String.raw`{"path":"C:\Users\me"}` },
            },
          ],
        }),
        delta({}, 'tool_calls'),
      ]),
      sse([delta({ content: '完成' }, 'stop')]),
    ]);
    const ran: string[] = [];
    for await (const _chunk of streamChatWithTools(settings, messages, undefined, {
      tools,
      runTool: async (_name, args) => {
        ran.push(args);
        return 'ok';
      },
    })) {
      // drain
    }
    assert.equal(ran.length, 1);
    assert.equal(JSON.parse(ran[0]!).path, String.raw`C:\Users\me`);
  });
});

describe('正文真流式（不被攒到最后一起吐）', () => {
  it('网络分片到达时正文就边收边推，不等流结束', async () => {
    const parts = Array.from({ length: 12 }, (_, i) => `第${i + 1}段文字内容。`);
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          for (const p of parts) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(delta({ content: p }))}\n\n`));
            await new Promise((r) => setTimeout(r, 30));
          }
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const t0 = Date.now();
    const stamps: Array<{ at: number; delta: string }> = [];
    let endedAt = 0;
    for await (const chunk of streamChatWithTools(settings, messages)) {
      if (chunk.type === 'content') stamps.push({ at: Date.now() - t0, delta: chunk.delta });
    }
    endedAt = Date.now() - t0;

    assert.ok(stamps.length >= 3, `正文应分成多次推进，实际 ${stamps.length} 次`);
    const firstAt = stamps[0]!.at;
    // 第一段必须在流结束前就到（提前量应接近总时长，而不是 0）
    assert.ok(
      endedAt - firstAt > 150,
      `首段正文到得太晚：first=${firstAt}ms end=${endedAt}ms，疑似攒到最后才吐`,
    );
    // 拼起来仍是完整正文
    assert.equal(stamps.map((s) => s.delta).join(''), parts.join(''));
  });

  it('正文里只是提到 DSML 字样时，后面的内容仍然照常流式', async () => {
    // 旧闸门只要看到 "DSML" 就把剩余正文全部扣住，直到流结束才一起吐
    const text =
      '先说结论：这里提到的 DSML 只是模型内部的标签写法，并不影响阅读。' +
      '下面继续讲正事：第一步先看目录结构，第二步再跑单测，第三步整理改动说明，' +
      '最后收尾并给出验证结论与遗留风险。'.repeat(4);
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += 10) parts.push(text.slice(i, i + 10));

    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          for (const p of parts) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(delta({ content: p }))}\n\n`));
            await new Promise((r) => setTimeout(r, 8));
          }
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const t0 = Date.now();
    const stamps: Array<{ at: number; delta: string }> = [];
    for await (const chunk of streamChatWithTools(settings, messages)) {
      if (chunk.type === 'content') stamps.push({ at: Date.now() - t0, delta: chunk.delta });
    }

    assert.equal(stamps.map((s) => s.delta).join(''), text);
    // 被闸门扣住时正文只会在结尾一次性到达（1~2 个 chunk）
    assert.ok(stamps.length >= 8, `DSML 字样不该闸住正文，实际只推了 ${stamps.length} 次`);
  });
});
