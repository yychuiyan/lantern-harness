import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  SUBAGENT_PRESETS,
  abortSubagent,
  listSubagentRecords,
  resetSubagentRegistryForTests,
  runSubagentTool,
  steerSubagent,
  type SubagentToolContext,
} from './session-subagent';

function stubCtx(partial?: Partial<SubagentToolContext>): SubagentToolContext {
  return {
    sessionId: 'sess_a',
    settings: {
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'x',
      model: 'test',
    },
    access: 'readonly',
    fsEnabled: false,
    webEnabled: false,
    runFs: async () => JSON.stringify({ error: 'no fs' }),
    runWeb: async () => JSON.stringify({ error: 'no web' }),
    ...partial,
  };
}

beforeEach(() => {
  resetSubagentRegistryForTests();
});

describe('session-subagent', () => {
  it('list_agents returns presets', async () => {
    const raw = await runSubagentTool('list_agents', '{}', stubCtx());
    const parsed = JSON.parse(raw) as {
      ok: boolean;
      presets: typeof SUBAGENT_PRESETS;
      maxConcurrent: number;
      sessionId: string;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.presets.length, 2);
    assert.ok(parsed.presets.some((p) => p.id === 'explore'));
    assert.equal(parsed.maxConcurrent, 2);
    assert.equal(parsed.sessionId, 'sess_a');
  });

  it('缺少 sessionId 时报错', async () => {
    const raw = await runSubagentTool('list_agents', '{}', stubCtx({ sessionId: '' }));
    const parsed = JSON.parse(raw) as { ok: boolean; error?: string };
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? '', /sessionId/);
  });

  it('spawn without prompt fails', async () => {
    const raw = await runSubagentTool('spawn_subagent', '{}', stubCtx());
    const parsed = JSON.parse(raw) as { ok: boolean; error?: string };
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? '', /prompt/);
  });

  it('abort unknown id fails', () => {
    const r = abortSubagent('missing', 'sess_a');
    assert.equal(r.ok, false);
  });

  it('subagent_list empty initially', async () => {
    const raw = await runSubagentTool('subagent_list', '{}', stubCtx());
    const parsed = JSON.parse(raw) as { agents: unknown[] };
    assert.equal(parsed.agents.length, 0);
    assert.equal(listSubagentRecords(true, 'sess_a').length, 0);
  });

  it('subagent_status 按 id 查询并隔离会话', async () => {
    const ctxA = stubCtx({ sessionId: 'sess_a' });
    const spawn = JSON.parse(
      await runSubagentTool(
        'spawn_subagent',
        JSON.stringify({ prompt: 'poll-me', background: true }),
        ctxA,
      ),
    ) as { ok: boolean; id?: string };
    assert.equal(spawn.ok, true);
    const okStatus = JSON.parse(
      await runSubagentTool('subagent_status', JSON.stringify({ id: spawn.id }), ctxA),
    ) as { ok: boolean; id?: string; status?: string };
    assert.equal(okStatus.ok, true);
    assert.equal(okStatus.id, spawn.id);
    assert.ok(
      okStatus.status === 'running' || okStatus.status === 'done' || okStatus.status === 'aborted',
    );

    const cross = JSON.parse(
      await runSubagentTool(
        'subagent_status',
        JSON.stringify({ id: spawn.id }),
        stubCtx({ sessionId: 'sess_b' }),
      ),
    ) as { ok: boolean; error?: string };
    assert.equal(cross.ok, false);
    assert.match(cross.error ?? '', /not found/);

    const missing = JSON.parse(
      await runSubagentTool('subagent_status', JSON.stringify({ id: 'sa_missing' }), ctxA),
    ) as { ok: boolean };
    assert.equal(missing.ok, false);
  });

  it('按 sessionId 隔离 list', async () => {
    const ctxA = stubCtx({ sessionId: 'sess_a' });
    const ctxB = stubCtx({ sessionId: 'sess_b' });
    const spawnA = JSON.parse(
      await runSubagentTool(
        'spawn_subagent',
        JSON.stringify({ prompt: 'task-a', background: true }),
        ctxA,
      ),
    ) as { ok: boolean; id?: string };
    const spawnB = JSON.parse(
      await runSubagentTool(
        'spawn_subagent',
        JSON.stringify({ prompt: 'task-b', background: true }),
        ctxB,
      ),
    ) as { ok: boolean; id?: string };
    assert.equal(spawnA.ok, true);
    assert.equal(spawnB.ok, true);
    const listA = JSON.parse(await runSubagentTool('subagent_list', '{}', ctxA)) as {
      agents: { id: string; sessionId: string }[];
    };
    const listB = JSON.parse(await runSubagentTool('subagent_list', '{}', ctxB)) as {
      agents: { id: string; sessionId: string }[];
    };
    assert.equal(listA.agents.length, 1);
    assert.equal(listB.agents.length, 1);
    assert.equal(listA.agents[0]!.id, spawnA.id);
    assert.equal(listB.agents[0]!.id, spawnB.id);
    assert.equal(listA.agents[0]!.sessionId, 'sess_a');
    // B 看不到 A 的 id
    assert.equal(abortSubagent(spawnA.id, 'sess_b').ok, false);
    assert.equal(steerSubagent(spawnA.id, 'go', 'sess_b').ok, false);
    // 同会话可 abort
    assert.equal(abortSubagent(spawnA.id, 'sess_a').ok, true);
  });
});
