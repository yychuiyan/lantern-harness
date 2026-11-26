import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import connect from 'connect';

import { setActiveRoot, __resetSpaceContext } from '../../builtin/session/space-context.mjs';
import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import { lhTestReportReviewPlugin } from '../../lh-plugins/test-report-review.mjs';

async function json(base: string, route: string, init?: RequestInit) {
  const response = await fetch(base + route, init);
  const data = (await response.json()) as Record<string, any>;
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), data);
  return data;
}

test('测试报告从真实材料计算统计，并在确认后原子写入', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-report-review-'));
  const app = connect();
  const server = http.createServer(app);
  try {
    __resetSpaceContext();
    setActiveRoot(root);
    fs.mkdirSync(path.dirname(spaceLocalFile(root, 'app.config.json')), { recursive: true });
    fs.writeFileSync(
      spaceLocalFile(root, 'app.config.json'),
      JSON.stringify({ version: 1, plugins: { cases: true, testReports: true, testStats: true } }),
    );
    const casesDir = path.join(root, '用例管理', '功能测试');
    fs.mkdirSync(casesDir, { recursive: true });
    fs.writeFileSync(
      path.join(casesDir, '工单.md'),
      [
        '| 用例编号 | 用例标题 | 用例状态 | 实际结果 | 缺陷编号 |',
        '| --- | --- | --- | --- | --- |',
        '| TC-1 | 创建工单 | 通过 | 创建成功 | |',
        '| TC-2 | 重复提交 | 不通过 | 生成两张 | BUG-9 |',
        '| TC-3 | 关闭工单 | 待验证 | | |',
        '',
      ].join('\n'),
    );
    const statsDir = path.join(root, '测试统计');
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(
      path.join(statsDir, '测试统计.json'),
      JSON.stringify({
        version: 1,
        dimensions: ['功能测试用例', '缺陷统计'],
        items: [
          {
            id: 'ts_1',
            date: '2026-11-26',
            dimensions: ['功能测试用例'],
            count: 3,
            draft: false,
            source: 'manual',
            sessionId: '',
            createdAt: '2026-11-26T01:00:00.000Z',
            updatedAt: '2026-11-26T01:00:00.000Z',
          },
        ],
      }),
    );
    fs.mkdirSync(path.join(root, '报告管理', '功能测试报告'), { recursive: true });
    lhTestReportReviewPlugin().configureServer({ middlewares: app } as never);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no port');
    const base = `http://127.0.0.1:${address.port}`;
    const context = await json(base, '/__tb_test_report_review/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'functional' }),
    });
    assert.equal(context.stats.total, 3);
    assert.equal(context.stats.passed, 1);
    assert.equal(context.stats.failed, 1);
    assert.equal(context.stats.pending, 1);
    assert.equal(context.stats.defects, 1);
    assert.ok(context.gaps.some((gap: string) => gap.includes('用例执行统计')));

    await assert.rejects(
      json(base, '/__tb_test_report_review/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'functional',
          reportPath: '功能测试报告/功能测试报告.md',
          casePaths: ['功能测试/工单.md'],
          body: '# 报告',
          declaredStats: { total: 99 },
          expectedSourceRevision: context.sourceRevision,
        }),
      }),
      /统计与来源不一致/,
    );

    const draft = await json(base, '/__tb_test_report_review/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'functional',
        reportPath: '功能测试报告/功能测试报告.md',
        casePaths: ['功能测试/工单.md'],
        body: '# 功能测试报告\n\n- 总数 3\n- 不通过 1',
        declaredStats: context.stats,
        expectedSourceRevision: context.sourceRevision,
      }),
    });
    assert.equal(draft.requiresConfirmation, true);
    assert.equal(
      fs.existsSync(path.join(root, '报告管理', '功能测试报告', '功能测试报告.md')),
      false,
    );
    const receipt = await json(base, '/__tb_test_report_review/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, expectedRevision: draft.revision }),
    });
    assert.equal(receipt.created, true);
    assert.match(
      fs.readFileSync(path.join(root, '报告管理', '功能测试报告', '功能测试报告.md'), 'utf8'),
      /总数 3/,
    );
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
