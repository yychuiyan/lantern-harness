import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import connect from 'connect';

import { setActiveRoot, __resetSpaceContext } from '../../builtin/session/space-context.mjs';
import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import { lhMemoryPlugin } from '../../lh-plugins/lh-memory.mjs';

async function json(base: string, route: string, init?: RequestInit) {
  const response = await fetch(base + route, init);
  const data = (await response.json()) as Record<string, any>;
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), data);
  return data;
}

test('记忆建议支持 revision 批量预览、重复拦截和一次性回执', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-memory-review-'));
  const app = connect();
  const server = http.createServer(app);
  try {
    __resetSpaceContext();
    setActiveRoot(root);
    fs.mkdirSync(path.dirname(spaceLocalFile(root, 'app.config.json')), { recursive: true });
    fs.writeFileSync(
      spaceLocalFile(root, 'app.config.json'),
      JSON.stringify({ version: 1, plugins: { memory: true } }),
    );
    const memoryDir = path.join(root, '.lantern', 'local', 'memories');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '[2026-11-25] 包管理器用 pnpm\n');
    fs.writeFileSync(
      path.join(memoryDir, 'SUGGESTIONS.jsonl'),
      [
        JSON.stringify({
          id: 'sg_keep_1',
          time: '2026-11-26T01:00:00.000Z',
          cwd: null,
          target: 'memory',
          content: '包管理器用 pnpm',
          reason: '重复项',
          hits: 1,
        }),
        JSON.stringify({
          id: 'sg_keep_2',
          time: '2026-11-26T01:01:00.000Z',
          cwd: null,
          target: 'memory',
          content: '测试优先使用真实材料',
          reason: '质量约定',
          hits: 1,
        }),
      ].join('\n') + '\n',
    );
    lhMemoryPlugin().configureServer({ middlewares: app } as never);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no port');
    const base = `http://127.0.0.1:${address.port}`;
    const context = await json(base, '/__tb_memory/suggestions/context');
    assert.equal(context.count, 2);
    assert.ok(context.duplicates.sg_keep_1);
    await assert.rejects(
      json(base, '/__tb_memory/suggestions/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: ['sg_keep_1', 'sg_keep_2'],
          action: 'approve',
          expectedRevision: context.revision,
        }),
      }),
      /避免重复/,
    );
    const draft = await json(base, '/__tb_memory/suggestions/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['sg_keep_1', 'sg_keep_2'],
        action: 'approve',
        expectedRevision: context.revision,
        allowDuplicates: true,
      }),
    });
    assert.equal(draft.requiresConfirmation, true);
    const receipt = await json(base, '/__tb_memory/suggestions/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['sg_keep_1', 'sg_keep_2'],
        action: 'approve',
        expectedRevision: draft.revision,
        draftId: draft.draftId,
        allowDuplicates: true,
      }),
    });
    assert.equal(receipt.items.length, 2);
    const after = await json(base, '/__tb_memory/suggestions/context');
    assert.equal(after.count, 0);
    const memory = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
    assert.match(memory, /测试优先使用真实材料/);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
