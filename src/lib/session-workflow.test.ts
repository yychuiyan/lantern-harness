import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runWorkflowEngine, runWorkflowTool, scriptLooksUnsafe } from './session-workflow';
import type { SubagentToolContext } from './session-subagent';

function stubCtx(): SubagentToolContext {
  return {
    sessionId: 'sess_wf',
    settings: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'x', model: 'test' },
    access: 'readonly',
    fsEnabled: false,
    webEnabled: false,
    runFs: async () => '{}',
    runWeb: async () => '{}',
  };
}

describe('session-workflow', () => {
  it('rejects unsafe scripts', () => {
    assert.ok(scriptLooksUnsafe('return eval("1")'));
    assert.ok(scriptLooksUnsafe('return require("fs")'));
    assert.equal(scriptLooksUnsafe('return { ok: true }'), null);
  });

  it('runs pure script without agents', async () => {
    const out = await runWorkflowEngine(
      { name: 'sum', description: 'add' },
      'phase("calc"); log("n", args.n); return { n: args.n, doubled: args.n * 2 };',
      { n: 3 },
      stubCtx(),
    );
    assert.equal(out.ok, true);
    assert.equal(out.stopReason, 'completed');
    assert.equal(out.agentsStarted, 0);
    assert.deepEqual(out.result, { n: 3, doubled: 6 });
    assert.ok(out.phases?.includes('calc'));
  });

  it('tool rejects missing meta.name', async () => {
    const raw = await runWorkflowTool(
      'workflow',
      JSON.stringify({ meta: { description: 'x' }, script: 'return 1' }),
      stubCtx(),
    );
    assert.match(raw, /meta\.name|error/i);
  });

  it('parallel without agent calls works', async () => {
    const out = await runWorkflowEngine(
      { name: 'p', description: 'parallel' },
      'const xs = await parallel([async () => 1, async () => 2]); return xs;',
      {},
      stubCtx(),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(out.result, [1, 2]);
  });
});
