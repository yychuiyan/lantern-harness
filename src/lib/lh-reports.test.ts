import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import connect from 'connect';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  lhReportsPlugin,
  REPORT_PROMPT_FILE,
  REPORT_ROOT_DIR,
} from '../../lh-plugins/lh-reports.mjs';
import { DOC_ROOT_DIRS } from '../../lh-plugins/lh-project-docs.mjs';
import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import { __resetSpaceContext, setActiveRoot } from '../../builtin/session/space-context.mjs';

const PROMPTS_DIR = DOC_ROOT_DIRS.prompts.dirName;

describe('lh-reports', () => {
  let tmp = '';
  let server: http.Server | null = null;
  let base = '';

  const promptFile = () => path.join(tmp, PROMPTS_DIR, REPORT_PROMPT_FILE);
  const reportDir = (name: string) => path.join(tmp, REPORT_ROOT_DIR, name);

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reports-'));
    __resetSpaceContext();
    setActiveRoot(tmp);

    const app = connect();
    const plugin = lhReportsPlugin();
    const configureServer = plugin.configureServer as unknown as (server: {
      config: { root: string };
      middlewares: connect.Server;
    }) => void;
    configureServer({ config: { root: tmp }, middlewares: app });

    const started = http.createServer(app);
    server = started;
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve));
    const addr = started.address();
    if (!addr || typeof addr === 'string') throw new Error('未能取得监听端口');
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(() => resolve(undefined)));
    __resetSpaceContext();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    // 每个用例从「插件关闭」的干净状态开始
    fs.rmSync(path.join(tmp, PROMPTS_DIR), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, REPORT_ROOT_DIR), { recursive: true, force: true });
    fs.rmSync(spaceLocalFile(tmp, 'reports.json'), { force: true });
  });

  async function sync(enabled: boolean) {
    const res = await fetch(`${base}/__tb_reports/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    assert.equal(res.ok, true);
    return (await res.json()) as {
      ok: boolean;
      created?: boolean;
      removed?: boolean;
      enabled: boolean;
      file?: string;
    };
  }

  it('打开时生成提示词，关闭时保留（不删用户文件）', async () => {
    assert.equal(fs.existsSync(promptFile()), false);

    const on = await sync(true);
    assert.equal(on.ok, true);
    assert.equal(on.created, true);
    assert.equal(fs.existsSync(promptFile()), true);
    const body = fs.readFileSync(promptFile(), 'utf8');
    assert.ok(body.includes('工作汇报'));

    const off = await sync(false);
    assert.equal(off.ok, true);
    assert.equal(off.enabled, false);
    assert.equal(off.removed, false);
    // 提示词管理页面里的文件要一直在：关闭只是停用
    assert.equal(fs.existsSync(promptFile()), true);
    assert.equal(fs.readFileSync(promptFile(), 'utf8'), body);
  });

  it('关闭后重新打开仍是原来那份，改过的内容不丢', async () => {
    await sync(true);
    fs.writeFileSync(promptFile(), '我自己的汇报提示词\n', 'utf8');

    await sync(false);
    assert.equal(fs.readFileSync(promptFile(), 'utf8'), '我自己的汇报提示词\n');

    const again = await sync(true);
    assert.equal(again.created, false);
    assert.equal(fs.readFileSync(promptFile(), 'utf8'), '我自己的汇报提示词\n');
  });

  it('读取接口返回当前空间的提示词正文', async () => {
    await sync(true);
    fs.writeFileSync(promptFile(), '自定义正文\n', 'utf8');

    const res = await fetch(`${base}/__tb_reports/prompt`);
    assert.equal(res.ok, true);
    const data = (await res.json()) as { exists: boolean; content?: string };
    assert.equal(data.exists, true);
    assert.equal(data.content, '自定义正文\n');
  });

  it('文件不存在时读取返回空正文', async () => {
    const res = await fetch(`${base}/__tb_reports/prompt`);
    assert.equal(res.ok, true);
    const data = (await res.json()) as { exists: boolean; content?: string };
    assert.equal(data.exists, false);
    assert.equal(data.content, '');
  });

  it('打开时铺出 工作汇报/日报|周报|月报 三个目录', async () => {
    await sync(true);
    for (const name of ['日报', '周报', '月报']) {
      assert.equal(fs.existsSync(reportDir(name)), true, `缺少 ${name} 目录`);
    }
  });

  it('列表按类型返回文件，带生成日期与文件名', async () => {
    await sync(true);
    fs.writeFileSync(path.join(reportDir('日报'), '2026-10-18.md'), '# 今天的日报', 'utf8');
    fs.writeFileSync(path.join(reportDir('周报'), '2026-W42.md'), '# 本周', 'utf8');
    // 非文本文件不进列表
    fs.writeFileSync(path.join(reportDir('日报'), 'x.docx'), 'binary', 'utf8');

    const res = await fetch(`${base}/__tb_reports/list?kind=day`);
    assert.equal(res.ok, true);
    const data = (await res.json()) as {
      dir: string;
      items: { name: string; generatedAt: number; url: string }[];
    };
    assert.equal(data.dir, '工作汇报/日报');
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].name, '2026-10-18.md');
    assert.ok(data.items[0].generatedAt > 0);
    assert.ok(data.items[0].url.includes('/__tb_reports/file?'));
  });

  it('页面读取接口能取回文件正文，且不能跳出汇报目录', async () => {
    await sync(true);
    const file = path.join(reportDir('月报'), '2026-10.md');
    fs.writeFileSync(file, '# 十月月报', 'utf8');

    const res = await fetch(`${base}/__tb_reports/file?kind=month&name=2026-10.md`);
    assert.equal(res.ok, true);
    assert.equal((await res.text()).trim(), '# 十月月报');

    const escape = await fetch(`${base}/__tb_reports/file?kind=month&name=../../secret.md`);
    assert.equal(escape.ok, false);
  });

  it('在本地打开：文件不存在或跳出目录时拒绝，不调用系统程序', async () => {
    await sync(true);
    const missing = await fetch(`${base}/__tb_reports/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'day', name: '不存在.md' }),
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);

    const escape = await fetch(`${base}/__tb_reports/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'day', name: '../../secret.md' }),
    });
    assert.equal(escape.ok, false);

    const badKind = await fetch(`${base}/__tb_reports/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'nope', name: '2026-10-18.md' }),
    });
    assert.equal(badKind.ok, false);
  });

  it('关闭插件不删已有汇报与三个目录', async () => {
    await sync(true);
    fs.writeFileSync(path.join(reportDir('日报'), '2026-10-18.md'), '# 保留', 'utf8');

    await sync(false);
    assert.equal(fs.existsSync(promptFile()), true);
    assert.equal(fs.readFileSync(path.join(reportDir('日报'), '2026-10-18.md'), 'utf8'), '# 保留');
    assert.equal(fs.existsSync(reportDir('周报')), true);
  });

  it('提示词下拉列出提示词管理里的文件，可在页面上切换', async () => {
    await sync(true);
    const mine = path.join(tmp, PROMPTS_DIR, '我的汇报.md');
    fs.writeFileSync(mine, '按我的格式写\n', 'utf8');

    const listRes = await fetch(`${base}/__tb_reports/prompts`);
    assert.equal(listRes.ok, true);
    const list = (await listRes.json()) as {
      promptFile: string;
      items: { name: string; selected: boolean }[];
    };
    const names = list.items.map((x) => x.name);
    assert.ok(names.includes(REPORT_PROMPT_FILE));
    assert.ok(names.includes('我的汇报.md'));
    // 空间默认提示词不该出现在汇报提示词候选里
    assert.equal(names.includes('默认提示词.md'), false);

    const pick = await fetch(`${base}/__tb_reports/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: '我的汇报.md' }),
    });
    assert.equal(pick.ok, true);

    const prompt = await fetch(`${base}/__tb_reports/prompt`);
    const data = (await prompt.json()) as { file: string; content: string };
    assert.equal(data.file, '我的汇报.md');
    assert.equal(data.content, '按我的格式写\n');

    // 关闭再打开：选择不丢，文件也不丢
    await sync(false);
    await sync(true);
    assert.equal(fs.existsSync(mine), true);
    assert.equal(fs.readFileSync(mine, 'utf8'), '按我的格式写\n');
    const state = await fetch(`${base}/__tb_reports/state`);
    const stateData = (await state.json()) as { promptFile: string; enabled: boolean };
    assert.equal(stateData.promptFile, '我的汇报.md');
    assert.equal(stateData.enabled, true);
  });

  it('选中的提示词被改名后回退到默认提示词，不会留空', async () => {
    await sync(true);
    const mine = path.join(tmp, PROMPTS_DIR, '临时提示词.md');
    fs.writeFileSync(mine, '临时\n', 'utf8');
    await fetch(`${base}/__tb_reports/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: '临时提示词.md' }),
    });

    fs.rmSync(mine, { force: true });
    const res = await fetch(`${base}/__tb_reports/state`);
    const data = (await res.json()) as { promptFile: string; exists: boolean };
    assert.equal(data.promptFile, REPORT_PROMPT_FILE);
    assert.equal(data.exists, true);
  });
});
