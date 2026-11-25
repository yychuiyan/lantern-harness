import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import connect from 'connect';

import { lhCaseReviewPlugin } from '../../lh-plugins/lh-case-review.mjs';
import { setActiveRoot, __resetSpaceContext } from '../../builtin/session/space-context.mjs';
import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';

test('手动备份进入对应备份列表；补全与重排写回不会新增备份', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-case-backup-api-'));
  const app = connect();
  const server = http.createServer(app);
  let cleanup = false;
  try {
    __resetSpaceContext();
    setActiveRoot(root);
    fs.mkdirSync(path.dirname(spaceLocalFile(root, 'app.config.json')), { recursive: true });
    fs.writeFileSync(
      spaceLocalFile(root, 'app.config.json'),
      JSON.stringify({ version: 1, plugins: { cases: true, caseReview: true } }),
    );
    const caseDir = path.join(root, '用例管理', '性能测试');
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(
      path.join(caseDir, '压测.md'),
      '| 用例编号 | 用例标题 |\n| --- | --- |\n| 1 | 原用例 |\n',
      'utf8',
    );
    lhCaseReviewPlugin().configureServer({ middlewares: app } as never);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务没有端口');
    const base = `http://127.0.0.1:${address.port}`;
    const createdResponse = await fetch(`${base}/__tb_casereview/backups/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '性能测试/压测.md' }),
    });
    const created = (await createdResponse.json()) as {
      ok: boolean;
      backup: string;
    };
    assert.equal(created.ok, true);
    assert.match(created.backup, /^性能测试\/备份列表\//);
    const listedResponse = await fetch(`${base}/__tb_casereview/backups`);
    const listed = (await listedResponse.json()) as {
      items: Array<{ casesPath: string }>;
    };
    assert.ok(listed.items.some((item) => item.casesPath === created.backup));
    const appendResponse = await fetch(`${base}/__tb_casereview/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '性能测试/压测.md',
        headers: ['用例编号', '用例标题'],
        rows: [{ 用例编号: '2', 用例标题: '补全用例' }],
      }),
    });
    assert.equal(appendResponse.ok, true);
    const rewriteResponse = await fetch(`${base}/__tb_casereview/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '性能测试/压测.md',
        headers: ['用例编号', '用例标题'],
        rows: [
          { 用例编号: '1', 用例标题: '原用例' },
          { 用例编号: '2', 用例标题: '补全用例' },
        ],
      }),
    });
    assert.equal(rewriteResponse.ok, true);
    const afterResponse = await fetch(`${base}/__tb_casereview/backups`);
    const after = (await afterResponse.json()) as { items: unknown[] };
    assert.equal(after.items.length, 1);
    cleanup = true;
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetSpaceContext();
    if (cleanup || fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  }
});
