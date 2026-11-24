import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import connect from 'connect';
import * as XLSX from 'xlsx';
import { after, before, beforeEach, describe, it } from 'node:test';

import { __resetSpaceContext, setActiveRoot } from '../../builtin/session/space-context.mjs';
import { spaceConfigFile, spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import { lhCaseExecutionPlugin } from '../../lh-plugins/lh-case-execution.mjs';

let tmp = '';
let server: http.Server | null = null;
let base = '';
let statsItems: Array<Record<string, unknown>> = [];

function caseBuffer() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['用例编号', '用例标题', '前置条件', '测试步骤', '预期结果', '用例状态', '实际结果'],
    ['TC-001', '创建工单', '已登录', '打开页面并提交', '创建成功', '待验证', ''],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '功能测试');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

async function json<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${route}`, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-case-execution-api-'));
  __resetSpaceContext();
  setActiveRoot(tmp);
  const defaults = spaceConfigFile(tmp, 'app.defaults.json');
  fs.mkdirSync(path.dirname(defaults), { recursive: true });
  fs.writeFileSync(
    defaults,
    JSON.stringify({ version: 1, plugins: {}, model: { activeId: '', providers: [] } }),
  );
  const local = spaceLocalFile(tmp, 'app.config.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(
    local,
    JSON.stringify({ version: 1, plugins: { cases: true, caseExecution: true } }),
  );
  const cases = path.join(tmp, '用例管理');
  fs.mkdirSync(cases, { recursive: true });
  fs.writeFileSync(path.join(cases, '功能用例.xlsx'), caseBuffer());

  const app = connect();
  app.use('/__tb_case_exec', async (req, res, next) => {
    const method = req.method || 'GET';
    if (method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          ok: true,
          projects: [...new Set(statsItems.map((item) => item.project))].filter(Boolean),
          items: statsItems,
        }),
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (method === 'POST') {
      statsItems.push(
        ...(body.items || []).map((item: Record<string, unknown>, index: number) => ({
          ...item,
          id: `ce_${statsItems.length + index + 1}`,
        })),
      );
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          ok: true,
          projects: [...new Set(statsItems.map((item) => item.project))].filter(Boolean),
          items: statsItems,
        }),
      );
    }
    if (method === 'PUT') {
      statsItems = statsItems.map((item) => (item.id === body.id ? { ...item, ...body } : item));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, item: statsItems.find((x) => x.id === body.id) }));
    }
    return next();
  });
  const plugin = lhCaseExecutionPlugin();
  const configure = plugin.configureServer as unknown as (server: {
    config: { root: string };
    middlewares: connect.Server;
  }) => void;
  configure({ config: { root: tmp }, middlewares: app });
  const started = http.createServer(app);
  server = started;
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve));
  const address = started.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  statsItems = [];
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  __resetSpaceContext();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('用例执行 API', () => {
  it('列出用例文件和执行字段', async () => {
    const health = await json<{ enabled: boolean }>('/__tb_case_run/health?health=1');
    assert.equal(health.enabled, true);
    const files = await json<{
      files: Array<{ path: string; executable: boolean; caseCount: number }>;
    }>('/__tb_case_run/files');
    assert.equal(files.files[0]?.path, '功能用例.xlsx');
    assert.equal(files.files[0]?.executable, true);
    assert.equal(files.files[0]?.caseCount, 1);
    const document = await json<{
      document: {
        fileHash: string;
        cases: Array<{ title: string; rowIndex: number }>;
      };
    }>('/__tb_case_run/cases?path=' + encodeURIComponent('功能用例.xlsx'));
    assert.equal(document.document.cases[0]?.title, '创建工单');
    assert.equal(document.document.cases[0]?.rowIndex, 0);
  });

  it('手动记录状态和实际结果并保留旧字段', async () => {
    const document = await json<{
      document: { fileHash: string };
    }>('/__tb_case_run/cases?path=' + encodeURIComponent('功能用例.xlsx'));
    await json('/__tb_case_run/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        casePath: '功能用例.xlsx',
        expectedFileHash: document.document.fileHash,
        rowIndex: 0,
        status: '通过',
        actualResult: '工单创建成功',
      }),
    });
    const updated = await json<{
      document: { cases: Array<{ status: string; actual: string; title: string }> };
    }>('/__tb_case_run/cases?path=' + encodeURIComponent('功能用例.xlsx'));
    assert.equal(updated.document.cases[0]?.status, '通过');
    assert.equal(updated.document.cases[0]?.actual, '工单创建成功');
    assert.equal(updated.document.cases[0]?.title, '创建工单');
  });

  it('详情字段自动保存到原文件并更新文件哈希', async () => {
    const before = await json<{
      document: { fileHash: string };
    }>('/__tb_case_run/cases?path=' + encodeURIComponent('功能用例.xlsx'));
    const saved = await json<{
      applied: { fileHash: string };
    }>('/__tb_case_run/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        casePath: '功能用例.xlsx',
        expectedFileHash: before.document.fileHash,
        rowIndex: 0,
        updates: [
          { header: '用例标题', value: '创建工单（详情已编辑）' },
          { header: '前置条件', value: '已登录并具备创建权限' },
        ],
      }),
    });
    assert.notEqual(saved.applied.fileHash, before.document.fileHash);
    const updated = await json<{
      document: { cases: Array<{ title: string; precondition: string }> };
    }>('/__tb_case_run/cases?path=' + encodeURIComponent('功能用例.xlsx'));
    assert.equal(updated.document.cases[0]?.title, '创建工单（详情已编辑）');
    assert.equal(updated.document.cases[0]?.precondition, '已登录并具备创建权限');
  });

  it('缺陷地址列缺失时自动追加并可重新读取', async () => {
    const before = await json<{
      document: { fileHash: string };
    }>('/__tb_case_run/cases?path=' + encodeURIComponent('功能用例.xlsx'));
    await json('/__tb_case_run/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        casePath: '功能用例.xlsx',
        expectedFileHash: before.document.fileHash,
        rowIndex: 0,
        updates: [{ header: '缺陷地址', value: 'https://jira.example.com/browse/BUG-9' }],
      }),
    });
    const updated = await json<{
      document: {
        columns: { defectUrl: string };
        cases: Array<{ defectUrl: string }>;
      };
    }>('/__tb_case_run/cases?path=' + encodeURIComponent('功能用例.xlsx'));
    assert.equal(updated.document.columns.defectUrl, '缺陷地址');
    assert.equal(updated.document.cases[0]?.defectUrl, 'https://jira.example.com/browse/BUG-9');
  });

  it('统计同步兼容历史 P/F 状态，待验证不计为已执行', async () => {
    fs.writeFileSync(
      path.join(tmp, '用例管理', '历史状态.csv'),
      '用例编号,用例标题,用例状态,实际结果\n1,通过案例,P,成功\n2,失败案例,F,失败\n3,待测案例,待验证,\n',
    );
    const result = await json<{ preview: { total: number; executed: number; pending: number } }>(
      '/__tb_case_run/stats/sync',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          casePath: '历史状态.csv',
          project: '历史状态',
          date: '2026-11-24',
          mode: 'preview',
        }),
      },
    );
    assert.equal(result.preview.total, 3);
    assert.equal(result.preview.executed, 2);
    assert.equal(result.preview.pending, 1);
  });

  it('统计同步先预览，已有记录只有明确覆盖才更新', async () => {
    const preview = await json<{
      preview: { total: number; executed: number; pending: number; existing: unknown };
    }>('/__tb_case_run/stats/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        casePath: '功能用例.xlsx',
        project: '功能用例',
        date: '2026-11-23',
        mode: 'preview',
      }),
    });
    assert.equal(preview.preview.total, 1);
    assert.equal(preview.preview.executed, 1);
    await json('/__tb_case_run/stats/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        casePath: '功能用例.xlsx',
        project: '功能用例',
        date: '2026-11-23',
        mode: 'skip',
      }),
    });
    assert.equal(statsItems.length, 1);
    const skipped = await json<{ skipped: boolean }>('/__tb_case_run/stats/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        casePath: '功能用例.xlsx',
        project: '功能用例',
        date: '2026-11-23',
        mode: 'skip',
      }),
    });
    assert.equal(skipped.skipped, true);
    await json('/__tb_case_run/stats/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        casePath: '功能用例.xlsx',
        project: '功能用例',
        date: '2026-11-23',
        mode: 'overwrite',
      }),
    });
    assert.equal(statsItems.length, 1);
  });
});
