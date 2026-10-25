/**
 * 会话子代理（tool-subagent* MVP）：
 * 进程内同步/后台 spawn；只读探索或通用读写；禁止嵌套 spawn。
 */

import type { AccessLevel, LLMSettings } from './settings';
import type { ChatMessage, ToolDef } from './llm';
import { streamChatWithTools } from './llm';
import { FS_SYSTEM_HINT, fsToolsForAccess } from './fs-tools';
import { WEB_SYSTEM_HINT, WEB_TOOLS } from './web-tools';

export type SubagentStatus = 'running' | 'done' | 'error' | 'aborted';

export interface SubagentPreset {
  id: string;
  label: string;
  description: string;
  /** explore=强制只读；general=跟随父级权限（仍无 bash） */
  mode: 'explore' | 'general';
}

export interface SubagentRecord {
  id: string;
  /** 所属聊天会话；list/abort/steer 按此隔离 */
  sessionId: string;
  agent: string;
  prompt: string;
  forked: boolean;
  status: SubagentStatus;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  toolCalls?: number;
}

export interface SubagentToolContext {
  settings: LLMSettings;
  /** 当前聊天会话 id（必填，用于注册表分桶） */
  sessionId: string;
  parentSignal?: AbortSignal;
  access: AccessLevel;
  fsEnabled: boolean;
  webEnabled: boolean;
  /** fork 时注入的父会话片段（不含 system） */
  parentMessages?: ChatMessage[];
  onHint?: (text: string) => void;
  runFs: (name: string, args: string, access: AccessLevel) => Promise<string>;
  runWeb: (name: string, args: string) => Promise<string>;
}

export const SUBAGENT_PRESETS: SubagentPreset[] = [
  {
    id: 'explore',
    label: '探索',
    description: '只读查文件 / 搜网页，汇总结论（不可写盘、无 bash）',
    mode: 'explore',
  },
  {
    id: 'general',
    label: '通用',
    description: '可读写工作区文件 + 网页（无 bash、不可再派生子代理）',
    mode: 'general',
  },
];

export const SUBAGENT_SYSTEM_HINT =
  '你可以使用子代理工具（进程内；默认与主会话同模型，可在设置里改子代理模型）：\n' +
  '- list_agents：列出可用预设与正在运行/最近完成的子代理（仅本会话）\n' +
  '- spawn_subagent：派生子代理执行独立任务（默认等待完成；background=true 则后台跑）\n' +
  '- fork_subagent：带着当前对话上下文 fork 子代理并行干活（仍是子代理，不是分叉会话）\n' +
  '- subagent_list / subagent_status / subagent_await / subagent_abort：查看、查询、等待、中断\n' +
  '- subagent_message：向运行中的子代理追加指示（steer）\n' +
  '适合可隔离的探索/子任务；主会话勿把全部工作塞给子代理。';

export const SUBAGENT_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List available subagent presets and recent/running subagents.',
      parameters: {
        type: 'object',
        properties: {
          includeRecent: {
            type: 'boolean',
            description: 'Include recent finished agents (default true)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description:
        'Spawn a subagent to run a focused task. Default waits until done and returns the result.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Preset id: explore | general (default explore)',
          },
          prompt: { type: 'string', description: 'Task for the subagent' },
          background: {
            type: 'boolean',
            description: 'If true, return id immediately; use subagent_await later',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fork_subagent',
      description:
        'Fork a subagent with a slice of the current conversation context, then run a task.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Preset id: explore | general' },
          prompt: { type: 'string', description: 'Task for the forked subagent' },
          background: { type: 'boolean' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'subagent_list',
      description: 'List running and recent subagents for this page session.',
      parameters: {
        type: 'object',
        properties: {
          includeDone: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'subagent_status',
      description: 'Get status of one subagent by id in this page session (no wait).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'subagent_await',
      description: 'Wait for a background subagent to finish and return its result.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          timeoutMs: { type: 'number', description: 'Default 120000' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'subagent_abort',
      description: 'Abort a running subagent in this chat session.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'subagent_message',
      description:
        'Steer a running subagent by queueing an extra user instruction (applied mid-run when possible).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          message: { type: 'string', description: 'Extra instruction for the subagent' },
        },
        required: ['id', 'message'],
      },
    },
  },
];

const MAX_CONCURRENT = 2;
/** workflow 扇出时放宽并发（仍封顶，防失控） */
const MAX_CONCURRENT_WORKFLOW = 6;
const MAX_RECENT = 24;
const MAX_FORK_MESSAGES = 12;
const MAX_RESULT_CHARS = 12_000;

const registry = new Map<string, SubagentRecord>();
const controllers = new Map<string, AbortController>();
const waiters = new Map<string, Promise<SubagentRecord>>();
/** 运行中追加指示（steer） */
const steerQueues = new Map<string, string[]>();

function uid(): string {
  return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function resolvePreset(raw: unknown): SubagentPreset {
  const id = String(raw ?? 'explore').trim() || 'explore';
  return SUBAGENT_PRESETS.find((p) => p.id === id) ?? SUBAGENT_PRESETS[0]!;
}

function requireSessionId(ctx: SubagentToolContext): string {
  const id = String(ctx.sessionId ?? '').trim();
  if (!id) throw new Error('sessionId is required for subagent tools');
  return id;
}

function runningCount(sessionId?: string): number {
  let n = 0;
  for (const r of registry.values()) {
    if (r.status !== 'running') continue;
    if (sessionId && r.sessionId !== sessionId) continue;
    n++;
  }
  return n;
}

function trimRegistry(): void {
  if (registry.size <= MAX_RECENT) return;
  const sorted = [...registry.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const r of sorted) {
    if (registry.size <= MAX_RECENT) break;
    if (r.status === 'running') continue;
    registry.delete(r.id);
    controllers.delete(r.id);
    waiters.delete(r.id);
    steerQueues.delete(r.id);
  }
}

function publicRecord(r: SubagentRecord): Omit<SubagentRecord, never> {
  return {
    id: r.id,
    sessionId: r.sessionId,
    agent: r.agent,
    prompt: r.prompt.slice(0, 200),
    forked: r.forked,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    result: r.result,
    error: r.error,
    toolCalls: r.toolCalls,
  };
}

function takeSteers(id: string): string[] {
  const q = steerQueues.get(id);
  if (!q?.length) return [];
  steerQueues.set(id, []);
  return q;
}

function effectiveAccess(preset: SubagentPreset, parent: AccessLevel): AccessLevel {
  if (preset.mode === 'explore') return 'readonly';
  return parent === 'full' ? 'readwrite' : parent;
}

async function executeSubagent(
  rec: SubagentRecord,
  preset: SubagentPreset,
  ctx: SubagentToolContext,
  forked: boolean,
): Promise<void> {
  const ac = new AbortController();
  controllers.set(rec.id, ac);
  const onParentAbort = () => ac.abort();
  ctx.parentSignal?.addEventListener('abort', onParentAbort);

  let toolCalls = 0;
  try {
    if (ac.signal.aborted || ctx.parentSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const access = effectiveAccess(preset, ctx.access);
    const tools: ToolDef[] = [];
    let system =
      `你是 Lantern Harness 子代理「${preset.id}」（${preset.label}）。\n` +
      `任务：独立完成用户交给你的子任务，给出简洁可核对的结论。\n` +
      `- 不要声称自己是主会话；不要尝试再派生子代理或执行 shell\n` +
      `- 工具轮次有限，优先检索再结论`;
    if (ctx.fsEnabled) {
      tools.push(...(fsToolsForAccess(access) as unknown as ToolDef[]));
      system += `\n\n${FS_SYSTEM_HINT}`;
    }
    if (ctx.webEnabled) {
      tools.push(...(WEB_TOOLS as unknown as ToolDef[]));
      system += `\n\n${WEB_SYSTEM_HINT}`;
    }
    if (!tools.length) {
      system += '\n（当前无 fs/web 工具，仅凭已有上下文回答。）';
    }

    const messages: ChatMessage[] = [{ role: 'system', content: system }];
    if (forked && ctx.parentMessages?.length) {
      const slice = ctx.parentMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-MAX_FORK_MESSAGES)
        .map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content.slice(0, 4000)
              : JSON.stringify(m.content).slice(0, 4000),
        }));
      messages.push(...slice);
    }
    messages.push({
      role: 'user',
      content: `【子代理任务】\n${rec.prompt}`,
    });

    ctx.onHint?.(`子代理 ${rec.id}（${preset.id}）运行中…`);
    let content = '';
    const maxSteerPasses = 3;
    for (let pass = 0; pass < maxSteerPasses; pass++) {
      if (ac.signal.aborted || ctx.parentSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const steers = takeSteers(rec.id);
      const turnMessages: ChatMessage[] = [...messages];
      if (pass > 0 || steers.length) {
        turnMessages.push({
          role: 'user',
          content: [
            steers.length ? `【追加指示】\n${steers.join('\n')}` : '',
            content.trim() ? `【此前进展】\n${content.trim().slice(0, 6000)}` : '',
            pass > 0 ? '请在此前基础上继续完成任务，给出简洁结论。' : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        });
      }
      let passContent = '';
      for await (const chunk of streamChatWithTools(ctx.settings, turnMessages, ac.signal, {
        tools: tools.length ? tools : undefined,
        maxToolRounds: 4,
        thinking: false,
        runTool: tools.length
          ? async (name, args) => {
              toolCalls++;
              ctx.onHint?.(`子代理 ${rec.id}: ${name}`);
              if (name.startsWith('fs_')) return ctx.runFs(name, args, access);
              if (name.startsWith('web_')) return ctx.runWeb(name, args);
              return JSON.stringify({ error: `subagent cannot use tool: ${name}` });
            }
          : undefined,
      })) {
        if (chunk.type === 'content') passContent += chunk.delta;
      }
      if (passContent.trim()) content = passContent.trim();
      // 本轮结束后若还有排队指示，再跑一轮
      if (!steerQueues.get(rec.id)?.length) break;
    }

    const text = content.trim().slice(0, MAX_RESULT_CHARS);
    rec.status = 'done';
    rec.result = text || '(子代理无文本输出)';
    rec.toolCalls = toolCalls;
    rec.updatedAt = Date.now();
  } catch (e) {
    const aborted =
      (e instanceof DOMException && e.name === 'AbortError') ||
      ac.signal.aborted ||
      Boolean(ctx.parentSignal?.aborted);
    rec.status = aborted ? 'aborted' : 'error';
    rec.error = aborted ? 'aborted' : e instanceof Error ? e.message : String(e);
    rec.toolCalls = toolCalls;
    rec.updatedAt = Date.now();
  } finally {
    ctx.parentSignal?.removeEventListener('abort', onParentAbort);
    controllers.delete(rec.id);
    steerQueues.delete(rec.id);
    trimRegistry();
  }
}

function beginSubagent(
  prompt: string,
  agentRaw: unknown,
  ctx: SubagentToolContext,
  forked: boolean,
  maxConcurrent: number,
): { ok: true; rec: SubagentRecord; job: Promise<SubagentRecord> } | { ok: false; error: string } {
  if (!prompt) return { ok: false, error: 'prompt is required' };
  let sessionId = '';
  try {
    sessionId = requireSessionId(ctx);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (runningCount(sessionId) >= maxConcurrent) {
    return { ok: false, error: `too many running subagents (max ${maxConcurrent})` };
  }
  const preset = resolvePreset(agentRaw);
  const now = Date.now();
  const rec: SubagentRecord = {
    id: uid(),
    sessionId,
    agent: preset.id,
    prompt: prompt.slice(0, 4000),
    forked,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
  registry.set(rec.id, rec);
  const job = executeSubagent(rec, preset, ctx, forked).then(() => rec);
  waiters.set(rec.id, job);
  return { ok: true, rec, job };
}

function startSubagent(
  args: { agent?: unknown; prompt?: unknown; background?: unknown },
  ctx: SubagentToolContext,
  forked: boolean,
): Promise<string> | string {
  const prompt = String(args.prompt ?? '').trim();
  const started = beginSubagent(prompt, args.agent, ctx, forked, MAX_CONCURRENT);
  if (!started.ok) return JSON.stringify({ ok: false, error: started.error });

  const background = args.background === true;
  if (background) {
    void started.job.finally(() => {
      /* keep record */
    });
    return JSON.stringify({
      ok: true,
      id: started.rec.id,
      agent: started.rec.agent,
      status: 'running',
      forked,
      hint: 'Use subagent_await to get the result',
    });
  }

  return started.job.then((done) =>
    JSON.stringify(
      {
        ok: done.status === 'done',
        id: done.id,
        agent: done.agent,
        status: done.status,
        forked: done.forked,
        toolCalls: done.toolCalls ?? 0,
        result: done.result,
        error: done.error,
      },
      null,
      2,
    ),
  );
}

/**
 * workflow 引擎调用：同步跑一个子代理，失败/中断返回 null（对齐 dsh agent()）。
 */
export async function runIsolatedSubagentTask(
  prompt: string,
  ctx: SubagentToolContext,
  opts?: { agent?: string; forked?: boolean },
): Promise<{ ok: boolean; id: string; text: string | null; error?: string }> {
  const started = beginSubagent(
    prompt.trim(),
    opts?.agent ?? 'explore',
    ctx,
    Boolean(opts?.forked),
    MAX_CONCURRENT_WORKFLOW,
  );
  if (!started.ok) {
    return { ok: false, id: '', text: null, error: started.error };
  }
  const done = await started.job;
  if (done.status === 'done') {
    return { ok: true, id: done.id, text: done.result ?? null };
  }
  return {
    ok: false,
    id: done.id,
    text: null,
    error: done.error ?? done.status,
  };
}

export function listSubagentRecords(includeDone = true, sessionId?: string): SubagentRecord[] {
  return [...registry.values()]
    .filter((r) => (sessionId ? r.sessionId === sessionId : true))
    .filter((r) => includeDone || r.status === 'running')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(publicRecord);
}

export function abortSubagent(
  idRaw: unknown,
  sessionId?: string,
): {
  ok: boolean;
  error?: string;
  record?: SubagentRecord;
} {
  const id = String(idRaw ?? '').trim();
  if (!id) return { ok: false, error: 'id is required' };
  const rec = registry.get(id);
  if (!rec) return { ok: false, error: 'subagent not found' };
  if (sessionId && rec.sessionId !== sessionId) {
    return { ok: false, error: 'subagent not found' };
  }
  if (rec.status !== 'running') {
    return { ok: true, record: publicRecord(rec) };
  }
  controllers.get(id)?.abort();
  return { ok: true, record: { ...publicRecord(rec), status: 'aborted' } };
}

export function steerSubagent(
  idRaw: unknown,
  messageRaw: unknown,
  sessionId?: string,
): { ok: boolean; error?: string; queued?: number } {
  const id = String(idRaw ?? '').trim();
  const message = String(messageRaw ?? '').trim();
  if (!id) return { ok: false, error: 'id is required' };
  if (!message) return { ok: false, error: 'message is required' };
  const rec = registry.get(id);
  if (!rec) return { ok: false, error: 'subagent not found' };
  if (sessionId && rec.sessionId !== sessionId) {
    return { ok: false, error: 'subagent not found' };
  }
  if (rec.status !== 'running') {
    return { ok: false, error: 'subagent is not running' };
  }
  const q = steerQueues.get(id) ?? [];
  q.push(message.slice(0, 4000));
  steerQueues.set(id, q);
  return { ok: true, queued: q.length };
}

async function awaitSubagent(
  idRaw: unknown,
  timeoutMsRaw: unknown,
  sessionId?: string,
): Promise<string> {
  const id = String(idRaw ?? '').trim();
  if (!id) return JSON.stringify({ ok: false, error: 'id is required' });
  const timeoutMs =
    typeof timeoutMsRaw === 'number' && Number.isFinite(timeoutMsRaw)
      ? Math.min(Math.max(1000, timeoutMsRaw), 300_000)
      : 120_000;
  const existing = registry.get(id);
  if (!existing || (sessionId && existing.sessionId !== sessionId)) {
    return JSON.stringify({ ok: false, error: 'subagent not found' });
  }
  if (existing.status !== 'running') {
    return JSON.stringify({ ok: existing.status === 'done', ...publicRecord(existing) }, null, 2);
  }
  const job = waiters.get(id);
  if (!job) return JSON.stringify({ ok: false, error: 'subagent waiter missing' });
  const timed = await Promise.race([
    job,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
  if (!timed) {
    return JSON.stringify({
      ok: false,
      id,
      status: 'running',
      error: `timeout after ${timeoutMs}ms`,
    });
  }
  return JSON.stringify(
    {
      ok: timed.status === 'done',
      ...publicRecord(timed),
    },
    null,
    2,
  );
}

/** 测试用：清空内存注册表 */
export function resetSubagentRegistryForTests(): void {
  for (const ac of controllers.values()) ac.abort();
  registry.clear();
  controllers.clear();
  waiters.clear();
  steerQueues.clear();
}

export async function runSubagentTool(
  name: string,
  argsJson: string,
  ctx: SubagentToolContext,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }

  let sessionId = '';
  try {
    sessionId = requireSessionId(ctx);
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }

  if (name === 'list_agents') {
    const includeRecent = args.includeRecent !== false;
    return JSON.stringify(
      {
        ok: true,
        presets: SUBAGENT_PRESETS,
        agents: listSubagentRecords(includeRecent, sessionId),
        running: runningCount(sessionId),
        maxConcurrent: MAX_CONCURRENT,
        sessionId,
      },
      null,
      2,
    );
  }
  if (name === 'subagent_list') {
    return JSON.stringify(
      {
        ok: true,
        agents: listSubagentRecords(args.includeDone !== false, sessionId),
        running: runningCount(sessionId),
        sessionId,
      },
      null,
      2,
    );
  }
  if (name === 'subagent_status') {
    const id = String(args.id ?? '').trim();
    if (!id) return JSON.stringify({ ok: false, error: 'id is required' });
    const rec = registry.get(id);
    if (!rec || rec.sessionId !== sessionId) {
      return JSON.stringify({ ok: false, error: 'subagent not found' });
    }
    return JSON.stringify({ ok: true, ...publicRecord(rec) }, null, 2);
  }
  if (name === 'subagent_abort') {
    return JSON.stringify(abortSubagent(args.id, sessionId), null, 2);
  }
  if (name === 'subagent_message') {
    return JSON.stringify(steerSubagent(args.id, args.message, sessionId), null, 2);
  }
  if (name === 'subagent_await') {
    return await awaitSubagent(args.id, args.timeoutMs, sessionId);
  }
  if (name === 'spawn_subagent') {
    return await Promise.resolve(startSubagent(args, ctx, false));
  }
  if (name === 'fork_subagent') {
    return await Promise.resolve(startSubagent(args, ctx, true));
  }
  return JSON.stringify({ error: `unknown tool: ${name}` });
}
