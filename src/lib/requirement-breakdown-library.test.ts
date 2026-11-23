import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import connect from 'connect';
import JSZip from 'jszip';
import { after, before, beforeEach, describe, it } from 'node:test';

import { __resetSpaceContext, setActiveRoot } from '../../builtin/session/space-context.mjs';
import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import {
  lhReqBreakdownLibraryPlugin,
  readRequirementBreakdownXMind,
  recordRequirementBreakdown,
  requirementBreakdownIteration,
  requirementBreakdownLibraryRoot,
  requirementBreakdownProject,
  requirementBreakdownStorePath,
  requirementBreakdownTitle,
  REQ_BREAKDOWN_STORE_FILE,
  REQ_BREAKDOWN_XMIND_DIR,
} from '../../lh-plugins/lh-req-breakdown-library.mjs';
import { lhReqAnalysisPlugin } from '../../lh-plugins/lh-req-analysis.mjs';

const XMIND_NAME = '上海12345市民服务热线V1.12_需求规格说明书.docx';

async function xmindBuffer(title = '需求原文'): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'content.json',
    JSON.stringify([
      {
        id: 'sheet-1',
        class: 'sheet',
        title,
        rootTopic: {
          id: 'root-topic',
          title,
          children: {
            attached: [{ id: 'topic-1', title: '工单受理' }],
          },
        },
      },
    ]),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

function analysisDoc(at = '2026-11-23T01:00:00.000Z') {
  return {
    id: 'ra_breakdown_1',
    title: '上海12345市民服务热线V1.12 需求分析',
    sourceTitle: XMIND_NAME,
    sourcePath: `上海12345市民服务热线V1.12/${XMIND_NAME}`,
    sourceHash: 'a'.repeat(64),
    updatedAt: '2026-11-23T01:00:01.000Z',
    sourceExport: {
      at,
      groups: [
        {
          category: '工单系统',
          items: [
            {
              title: '信访办数据推送',
              body: '编号 | XQ-000-20260828-01 功能名称 | 信访办数据推送 功能描述 | 1、将派单方向为市信访办。 2、未完成自动推送的工单进入收单界面。输入参数 | 提出人 | 关丹',
            },
          ],
        },
      ],
    },
  };
}

describe('需求拆解库', () => {
  let tmp = '';
  let server: http.Server | null = null;
  let base = '';
  const opened: string[] = [];
  const trashed: string[] = [];

  function enable(enabled = true) {
    const file = spaceLocalFile(tmp, 'app.config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        plugins: {
          reqAnalysis: true,
          reqBreakdowns: enabled,
          storyReview: false,
          testPoints: false,
        },
      }),
    );
  }

  async function json<T>(route: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${route}`, init);
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) {
      throw Object.assign(new Error(data.error || `HTTP ${res.status}`), {
        status: res.status,
        data,
      });
    }
    return data;
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-breakdown-library-'));
    __resetSpaceContext();
    setActiveRoot(tmp);
    enable();
    const app = connect();
    const analysisPlugin = lhReqAnalysisPlugin();
    const configureAnalysis = analysisPlugin.configureServer as unknown as (server: {
      config: { root: string };
      middlewares: connect.Server;
    }) => void;
    configureAnalysis({ config: { root: tmp }, middlewares: app });
    const plugin = lhReqBreakdownLibraryPlugin({
      openLocalPath: async (file: string) => {
        opened.push(file);
      },
      trashLocalPath: async (file: string) => {
        trashed.push(file);
        fs.rmSync(file, { force: true });
      },
    });
    const configure = plugin.configureServer as unknown as (server: {
      config: { root: string };
      middlewares: connect.Server;
    }) => void;
    configure({ config: { root: tmp }, middlewares: app });
    const started = http.createServer(app);
    server = started;
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve));
    const address = started.address();
    if (!address || typeof address === 'string') throw new Error('未取得监听端口');
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    opened.length = 0;
    trashed.length = 0;
    enable();
    fs.rmSync(requirementBreakdownLibraryRoot(tmp), { recursive: true, force: true });
    fs.rmSync(requirementBreakdownStorePath(tmp), { force: true });
    fs.rmSync(`${requirementBreakdownStorePath(tmp)}.v1.bak`, { force: true });
    fs.rmSync(path.join(tmp, '需求分析'), { recursive: true, force: true });
  });

  it('按来源文件名生成固定标题并从路径提取项目、迭代', () => {
    assert.equal(
      requirementBreakdownTitle(XMIND_NAME),
      '上海12345市民服务热线V1.12_需求拆解.xmind',
    );
    assert.equal(
      requirementBreakdownTitle('上海12345市民服务热线V1.12_需求拆解.xmind'),
      '上海12345市民服务热线V1.12_需求拆解.xmind',
    );
    assert.equal(requirementBreakdownIteration(XMIND_NAME), 'V1.12');
    assert.equal(requirementBreakdownProject(`项目甲/V2.0/${XMIND_NAME}`), 'V2.0');
    assert.equal(requirementBreakdownProject(''), '未分类');
  });

  it('自动生成真实 XMind，重复拆解增量入库，同一批次不重复', async () => {
    const doc = analysisDoc();
    const first = await recordRequirementBreakdown(tmp, doc);
    assert.ok(first);
    assert.equal(first.title, '上海12345市民服务热线V1.12_需求拆解.xmind');
    assert.equal(first.fileName, first.title);
    assert.equal(first.iteration, 'V1.12');
    assert.equal(first.project, '上海12345市民服务热线V1.12');
    assert.equal(first.exists, true);
    assert.equal(path.dirname(first.localPath), requirementBreakdownLibraryRoot(tmp));
    assert.ok(fs.existsSync(first.localPath));

    const parsed = await readRequirementBreakdownXMind(first.localPath);
    assert.equal(parsed.tree[0]?.title, XMIND_NAME);
    assert.ok(parsed.tree.some((node) => node.title === 'XQ-000-20260828-01'));
    assert.match(parsed.text, /1、将派单方向为市信访办/);
    assert.equal(parsed.text.includes('输入参数'), false);

    const sameBatch = await recordRequirementBreakdown(tmp, doc);
    assert.equal(sameBatch?.id, first.id);

    const second = await recordRequirementBreakdown(tmp, analysisDoc('2026-11-23T02:00:00.000Z'));
    assert.ok(second);
    assert.notEqual(second.id, first.id);
    assert.match(
      second.fileName,
      /^上海12345市民服务热线V1\.12_需求拆解_\d{8}-\d{6}(?:-\d+)?\.xmind$/,
    );
    assert.equal(fs.existsSync(first.localPath), true);
    assert.equal(fs.existsSync(second.localPath), true);
  });

  it('旧版嵌套目录和可见 JSON 自动迁移为平铺文件与隐藏元数据', async () => {
    const root = requirementBreakdownLibraryRoot(tmp);
    const nested = path.join(root, REQ_BREAKDOWN_XMIND_DIR, '上海12345市民服务热线', 'V1.12');
    const fileName = '上海12345市民服务热线V1.12_需求拆解.xmind';
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, REQ_BREAKDOWN_XMIND_DIR, '.DS_Store'), '');
    fs.writeFileSync(
      path.join(root, REQ_BREAKDOWN_XMIND_DIR, '上海12345市民服务热线', '.DS_Store'),
      '',
    );
    fs.writeFileSync(path.join(nested, '.DS_Store'), '');
    const file = path.join(nested, fileName);
    fs.writeFileSync(file, await xmindBuffer('旧版需求'));
    const stat = fs.statSync(file);
    fs.writeFileSync(
      path.join(root, REQ_BREAKDOWN_STORE_FILE),
      JSON.stringify({
        version: 1,
        revision: 4,
        seq: 1,
        entries: [
          {
            id: 'rbl_legacy',
            title: fileName,
            project: '上海12345市民服务热线',
            iteration: 'V1.12',
            sourceTitle: XMIND_NAME,
            sourcePath: `上海12345市民服务热线/${XMIND_NAME}`,
            kind: 'generated',
            fileName,
            relativePath: `${REQ_BREAKDOWN_XMIND_DIR}/上海12345市民服务热线/V1.12/${fileName}`,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            note: '迁移保留备注',
            createdAt: '2026-11-23T01:00:00.000Z',
            updatedAt: '2026-11-23T01:00:00.000Z',
          },
        ],
      }),
    );

    const listed = await json<{
      revision: number;
      entries: Array<{ id: string; localPath: string; note: string; relativePath: string }>;
    }>('/__tb_req_breakdowns/list');
    assert.equal(listed.revision, 4);
    assert.equal(listed.entries[0]?.id, 'rbl_legacy');
    assert.equal(listed.entries[0]?.note, '迁移保留备注');
    assert.equal(listed.entries[0]?.relativePath, fileName);
    assert.equal(listed.entries[0]?.localPath, path.join(root, fileName));
    assert.equal(fs.existsSync(path.join(root, fileName)), true);
    assert.equal(fs.existsSync(path.join(root, REQ_BREAKDOWN_STORE_FILE)), false);
    assert.equal(fs.existsSync(path.join(root, REQ_BREAKDOWN_XMIND_DIR)), false);
    assert.equal(fs.existsSync(requirementBreakdownStorePath(tmp)), true);
    assert.equal(fs.existsSync(`${requirementBreakdownStorePath(tmp)}.v1.bak`), true);
  });

  it('直接放入目录的外部 XMind 自动入库，非 XMind 和重复读取不产生重复记录', async () => {
    const root = requirementBreakdownLibraryRoot(tmp);
    fs.mkdirSync(root, { recursive: true });
    const external = path.join(root, '外部新增需求V2.0_需求拆解.xmind');
    fs.writeFileSync(external, await xmindBuffer('外部新增需求'));
    fs.writeFileSync(path.join(root, '说明.md'), '# 不进入拆解库');

    const first = await json<{
      revision: number;
      entries: Array<{
        id: string;
        title: string;
        kind: string;
        fileName: string;
        project: string;
        iteration: string;
        fileHash?: string;
      }>;
    }>('/__tb_req_breakdowns/list');
    assert.equal(first.revision, 1);
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0]?.title, '外部新增需求V2.0_需求拆解.xmind');
    assert.equal(first.entries[0]?.kind, 'uploaded');
    assert.equal(first.entries[0]?.fileName, path.basename(external));
    assert.equal(first.entries[0]?.project, '手动上传');
    assert.equal(first.entries[0]?.iteration, 'V2.0');
    assert.match(first.entries[0]?.fileHash || '', /^[a-f0-9]{64}$/);

    const second = await json<{ revision: number; entries: Array<{ id: string }> }>(
      '/__tb_req_breakdowns/list',
    );
    assert.equal(second.revision, first.revision);
    assert.deepEqual(
      second.entries.map((entry) => entry.id),
      first.entries.map((entry) => entry.id),
    );
  });

  it('外部重命名复用原条目，外部修改后更新哈希且不会按大小和时间误认领其它文件', async () => {
    const first = await recordRequirementBreakdown(tmp, analysisDoc());
    assert.ok(first);
    const root = requirementBreakdownLibraryRoot(tmp);
    const renamedName = '外部重命名需求V1.12_需求拆解.xmind';
    const renamed = path.join(root, renamedName);
    fs.renameSync(first.localPath, renamed);

    const afterRename = await json<{
      revision: number;
      entries: Array<{
        id: string;
        title: string;
        fileName: string;
        relativePath: string;
        localPath: string;
        fileHash?: string;
      }>;
    }>('/__tb_req_breakdowns/list');
    assert.equal(afterRename.entries.length, 1);
    assert.equal(afterRename.entries[0]?.id, first.id);
    assert.equal(afterRename.entries[0]?.title, renamedName);
    assert.equal(afterRename.entries[0]?.fileName, renamedName);
    assert.equal(afterRename.entries[0]?.relativePath, renamedName);
    assert.equal(afterRename.entries[0]?.localPath, renamed);
    const originalHash = afterRename.entries[0]?.fileHash;

    fs.writeFileSync(renamed, await xmindBuffer('外部修改后的需求'));
    const afterEdit = await json<{
      revision: number;
      entries: Array<{ id: string; fileHash?: string; size: number }>;
    }>('/__tb_req_breakdowns/list');
    assert.equal(afterEdit.entries.length, 1);
    assert.equal(afterEdit.entries[0]?.id, first.id);
    assert.notEqual(afterEdit.entries[0]?.fileHash, originalHash);
    assert.equal(afterEdit.entries[0]?.size, fs.statSync(renamed).size);

    const tracked = afterRename.entries[0]!;
    fs.renameSync(renamed, path.join(root, '待删除的旧文件.xmind'));
    fs.rmSync(path.join(root, '待删除的旧文件.xmind'));
    const mistakenA = path.join(root, '同时间同大小-A.xmind');
    const mistakenB = path.join(root, '同时间同大小-B.xmind');
    fs.writeFileSync(mistakenA, await xmindBuffer('内容 A'));
    fs.writeFileSync(mistakenB, await xmindBuffer('内容 B'));
    const fixed = new Date('2026-11-23T03:00:00.000Z');
    fs.utimesSync(mistakenA, fixed, fixed);
    fs.utimesSync(mistakenB, fixed, fixed);
    fs.writeFileSync(
      requirementBreakdownStorePath(tmp),
      JSON.stringify({
        version: 2,
        revision: afterEdit.revision,
        seq: 1,
        entries: [
          {
            ...tracked,
            title: tracked.title,
            fileName: '已消失.xmind',
            relativePath: '已消失.xmind',
            size: fs.statSync(mistakenA).size,
            mtime: fixed.toISOString(),
            fileHash: originalHash,
          },
        ],
      }),
    );
    const afterMismatch = await json<{
      entries: Array<{ id: string; fileName: string; exists: boolean }>;
    }>('/__tb_req_breakdowns/list');
    assert.equal(afterMismatch.entries.length, 3);
    const missing = afterMismatch.entries.find((entry) => entry.id === tracked.id);
    assert.equal(missing?.fileName, '已消失.xmind');
    assert.equal(missing?.exists, false);
  });

  it('需求分析保存 sourceExport 时自动触发入库', async () => {
    const created = await json<{
      doc: { id: string };
      revision: string;
    }>('/__tb_reqanalysis/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '自动入库需求',
        sourceTitle: XMIND_NAME,
        sourcePath: `自动入库项目/${XMIND_NAME}`,
        sourceHash: 'b'.repeat(64),
      }),
    });
    await json('/__tb_reqanalysis', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: created.doc.id,
        expectedRevision: created.revision,
        sourceExport: analysisDoc().sourceExport,
      }),
    });
    const listed = await json<{
      entries: Array<{ title: string; project: string; kind: string }>;
    }>('/__tb_req_breakdowns/list');
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0]?.title, '上海12345市民服务热线V1.12_需求拆解.xmind');
    assert.equal(listed.entries[0]?.project, '自动入库项目');
    assert.equal(listed.entries[0]?.kind, 'generated');
  });

  it('插件关闭时接口拒绝，历史分析可显式补录', async () => {
    enable(false);
    await assert.rejects(
      json('/__tb_req_breakdowns/list'),
      (error: unknown) => (error as { status?: number }).status === 403,
    );

    enable(true);
    const analysisDir = path.join(tmp, '需求分析');
    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(
      path.join(analysisDir, '需求分析.json'),
      JSON.stringify({ docs: [analysisDoc()] }),
    );
    const candidates = await json<{
      revision: number;
      candidates: Array<{ analysisId: string; recorded: boolean }>;
    }>('/__tb_req_breakdowns/backfill');
    assert.equal(candidates.revision, 0);
    assert.equal(candidates.candidates[0]?.analysisId, 'ra_breakdown_1');
    assert.equal(candidates.candidates[0]?.recorded, false);
    const backfilled = await json<{
      revision: number;
      created: Array<{ title: string }>;
      failed: unknown[];
    }>('/__tb_req_breakdowns/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: candidates.revision,
        analysisIds: ['ra_breakdown_1'],
      }),
    });
    assert.equal(backfilled.created.length, 1);
    assert.equal(backfilled.failed.length, 0);
  });

  it('手动上传校验 XMind，并支持改名、备注、打开和可恢复删除', async () => {
    const contentBase64 = (await xmindBuffer('手写需求')).toString('base64');
    const imported = await json<{
      revision: number;
      entry: {
        id: string;
        title: string;
        fileName: string;
        localPath: string;
        project: string;
        iteration: string;
      };
    }>('/__tb_req_breakdowns/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: XMIND_NAME.replace(/\.docx$/, '.xmind'),
        contentBase64,
        expectedRevision: 0,
      }),
    });
    assert.equal(imported.entry.fileName, '上海12345市民服务热线V1.12_需求拆解.xmind');
    assert.equal(imported.entry.project, '手动上传');
    assert.equal(imported.entry.iteration, 'V1.12');

    const updated = await json<{
      revision: number;
      entry: { id: string; title: string; fileName: string; note: string; localPath: string };
    }>(`/__tb_req_breakdowns/entries/${imported.entry.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: imported.revision,
        title: '客服热线需求',
        note: '已人工校验',
      }),
    });
    assert.equal(updated.entry.title, '客服热线需求_需求拆解.xmind');
    assert.equal(updated.entry.fileName, updated.entry.title);
    assert.equal(updated.entry.note, '已人工校验');
    assert.equal(fs.existsSync(updated.entry.localPath), true);

    await json(`/__tb_req_breakdowns/entries/${imported.entry.id}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.deepEqual(opened, [updated.entry.localPath]);

    const deleted = await json<{ revision: number }>(
      `/__tb_req_breakdowns/entries/${imported.entry.id}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: updated.revision }),
      },
    );
    assert.deepEqual(trashed, [updated.entry.localPath]);
    assert.equal(deleted.revision, updated.revision + 1);
    const list = await json<{ entries: unknown[] }>('/__tb_req_breakdowns/list');
    assert.equal(list.entries.length, 0);
  });

  it('无效 XMind、旧 revision 和缺少 revision 都被拒绝', async () => {
    await assert.rejects(
      json('/__tb_req_breakdowns/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '坏文件.xmind',
          contentBase64: Buffer.from('not-a-zip').toString('base64'),
          expectedRevision: 0,
        }),
      }),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
    await assert.rejects(
      json('/__tb_req_breakdowns/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '缺修订.xmind',
          contentBase64: (await xmindBuffer()).toString('base64'),
        }),
      }),
      (error: unknown) => (error as { status?: number }).status === 428,
    );
  });
});
