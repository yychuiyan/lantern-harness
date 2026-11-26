import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import connect from 'connect';
import * as XLSX from 'xlsx';

import { setActiveRoot, __resetSpaceContext } from '../../builtin/session/space-context.mjs';
import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import { lhCaseBlindspotPlugin, lhCaseReviewPlugin } from '../../lh-plugins/lh-case-review.mjs';

async function json(base: string, route: string, init?: RequestInit) {
  const response = await fetch(base + route, init);
  const data = (await response.json()) as Record<string, any>;
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), data);
  return data;
}

test('场景补全先预览、后按归属分组写回，并在成功后标记已补全', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-blindspot-review-'));
  const app = connect();
  const server = http.createServer(app);
  try {
    __resetSpaceContext();
    setActiveRoot(root);
    fs.mkdirSync(path.dirname(spaceLocalFile(root, 'app.config.json')), { recursive: true });
    fs.writeFileSync(
      spaceLocalFile(root, 'app.config.json'),
      JSON.stringify({
        version: 1,
        plugins: { cases: true, caseReview: true, caseBlindspot: true },
      }),
    );
    const casesDir = path.join(root, '用例管理', '功能测试');
    fs.mkdirSync(casesDir, { recursive: true });
    const caseFile = path.join(casesDir, '工单.md');
    const before = [
      '| 用例编号 | 用例标题 | 需求编号 | 前置条件 | 测试步骤 | 预期结果 | 优先级 | 用例类型 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| TC-1 | 创建工单 | REQ-1 | 已登录 | 1. 填表并提交 | 提示创建成功 | P1 | 功能 |',
      '| TC-2 | 关闭工单 | REQ-2 | 工单已创建 | 1. 点击关闭 | 状态变为已关闭 | P1 | 功能 |',
      '',
    ].join('\n');
    fs.writeFileSync(caseFile, before);
    lhCaseReviewPlugin().configureServer({ middlewares: app } as never);
    lhCaseBlindspotPlugin().configureServer({ middlewares: app } as never);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no port');
    const base = `http://127.0.0.1:${address.port}`;
    await json(base, '/__tb_casereview/report', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '功能测试/工单.md',
        blindspot: {
          at: new Date().toISOString(),
          context: { reqRef: 'req-1', reqTitle: '工单需求' },
          summary: '发现一个分组场景',
          items: [
            {
              id: 'bs_security_001',
              category: 'security',
              severity: 'high',
              title: '重复提交',
              why: '重复点击可能创建多单',
              precondition: '已登录',
              steps: ['快速连续提交两次'],
              expected: '只创建一张工单并提示重复提交',
              priority: 'P0',
              reqAnchor: 'REQ-1',
              added: false,
              caseNo: '',
            },
          ],
        },
      }),
    });

    const draft = await json(base, '/__tb_caseblindspot/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '功能测试/工单.md',
        selectedIds: ['bs_security_001'],
      }),
    });
    assert.equal(draft.requiresConfirmation, true);
    assert.equal(fs.readFileSync(caseFile, 'utf8'), before, 'draft must not change the case file');
    assert.match(draft.preview[0].placement, /REQ-1/);
    const storedBefore = await json(
      base,
      '/__tb_casereview/report?path=' + encodeURIComponent('功能测试/工单.md'),
    );
    assert.equal(storedBefore.entry.blindspot.items[0].added, false);

    const receipt = await json(base, '/__tb_caseblindspot/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, expectedRevision: draft.revision }),
    });
    assert.match(receipt.receipt, /已把 1 条场景补全写入/);
    assert.equal(receipt.applied[0].id, 'bs_security_001');
    const after = fs.readFileSync(caseFile, 'utf8');
    assert.ok(after.indexOf('重复提交') > after.indexOf('创建工单'));
    assert.ok(after.indexOf('重复提交') < after.indexOf('关闭工单'));
    const storedAfter = await json(
      base,
      '/__tb_casereview/report?path=' + encodeURIComponent('功能测试/工单.md'),
    );
    assert.equal(storedAfter.entry.blindspot.items[0].added, true);
    await assert.rejects(
      json(base, '/__tb_caseblindspot/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: draft.draftId, expectedRevision: draft.revision }),
      }),
      /已处理|不能重复/,
    );
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('场景补全对 xlsx 按真实列序插入并保留其它数据行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-blindspot-xlsx-'));
  const app = connect();
  const server = http.createServer(app);
  try {
    __resetSpaceContext();
    setActiveRoot(root);
    fs.mkdirSync(path.dirname(spaceLocalFile(root, 'app.config.json')), { recursive: true });
    fs.writeFileSync(
      spaceLocalFile(root, 'app.config.json'),
      JSON.stringify({ version: 1, plugins: { cases: true, caseReview: true } }),
    );
    const casesDir = path.join(root, '用例管理');
    fs.mkdirSync(casesDir, { recursive: true });
    const caseFile = path.join(casesDir, '功能测试用例.xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      ['用例编号', '用例标题', '需求编号', '测试步骤', '预期结果', '用例状态'],
      ['TC-1', '创建工单', 'REQ-1', '提交', '创建成功', '通过'],
      ['TC-2', '关闭工单', 'REQ-2', '关闭', '已关闭', '待验证'],
    ]);
    sheet.C1!.s = { font: { bold: true }, fill: { fgColor: { rgb: 'FFF2CC' } } };
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '功能测试');
    fs.writeFileSync(caseFile, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    lhCaseReviewPlugin().configureServer({ middlewares: app } as never);
    lhCaseBlindspotPlugin().configureServer({ middlewares: app } as never);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no port');
    const base = `http://127.0.0.1:${address.port}`;
    await json(base, '/__tb_casereview/report', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '功能测试用例.xlsx',
        blindspot: {
          at: new Date().toISOString(),
          context: { reqRef: 'req-1', reqTitle: '工单需求' },
          summary: '',
          items: [
            {
              id: 'bs_business_001',
              category: 'business',
              severity: 'medium',
              title: '重复关闭',
              why: '',
              precondition: '工单已关闭',
              steps: ['再次点击关闭'],
              expected: '提示已关闭且状态不变',
              priority: 'P1',
              reqAnchor: 'REQ-1',
              added: false,
              caseNo: '',
            },
          ],
        },
      }),
    });
    const draft = await json(base, '/__tb_caseblindspot/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '功能测试用例.xlsx', selectedIds: ['bs_business_001'] }),
    });
    await json(base, '/__tb_caseblindspot/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, expectedRevision: draft.revision }),
    });
    const parsed = XLSX.read(fs.readFileSync(caseFile), { type: 'buffer' });
    const out = XLSX.utils.sheet_to_json<Record<string, string>>(parsed.Sheets['功能测试'], {
      defval: '',
    });
    assert.deepEqual(
      out.map((row) => row['用例编号']),
      ['TC-1', 'TC-BL-001', 'TC-2'],
    );
    assert.equal(out[2]?.['用例标题'], '关闭工单');
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
