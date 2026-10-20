/**
 * 插件提示词（提示词管理里的「工作汇报提示词 / Playwright提示词」）行为回归：
 * 打开补种子、已有不覆盖、插件开启期间锁定、关闭后可解锁。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import connect from 'connect';
import { after, beforeEach, describe, it } from 'node:test';

import {
  ensurePluginPrompt,
  isPluginOnInSpace,
  pluginPromptLock,
  pluginPromptPath,
  readPluginPrompt,
  UI_AUTO_PROMPT_FILE,
} from '../../lh-plugins/plugin-prompts.mjs';
import { lhUiautoPlugin } from '../../lh-plugins/lh-uiauto.mjs';
import { lhPromptsPlugin } from '../../lh-plugins/lh-project-docs.mjs';
import { __resetSpaceContext, setActiveRoot } from '../../builtin/session/space-context.mjs';
import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';

describe('插件提示词文件', () => {
  let tmp = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-plugin-prompts-'));
    __resetSpaceContext();
    setActiveRoot(tmp);
  });

  after(() => {
    __resetSpaceContext();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function setPlugin(id: string, on: boolean) {
    const file = spaceLocalFile(tmp, 'app.config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.writeFileSync(
      file,
      JSON.stringify({ ...cur, plugins: { ...(cur.plugins ?? {}), [id]: on } }, null, 2),
      'utf8',
    );
  }

  it('缺就补种子，已有内容不覆盖', () => {
    const first = ensurePluginPrompt(UI_AUTO_PROMPT_FILE, '种子正文', tmp);
    assert.equal(first.created, true);
    assert.equal(fs.readFileSync(pluginPromptPath(UI_AUTO_PROMPT_FILE, tmp), 'utf8'), '种子正文');

    fs.writeFileSync(pluginPromptPath(UI_AUTO_PROMPT_FILE, tmp), '我改过的提示词', 'utf8');
    const again = ensurePluginPrompt(UI_AUTO_PROMPT_FILE, '种子正文', tmp);
    assert.equal(again.created, false);
    assert.equal(readPluginPrompt(UI_AUTO_PROMPT_FILE, tmp), '我改过的提示词');
  });

  it('没人改过的种子会跟着内置模板升级，改过的不动', () => {
    ensurePluginPrompt(UI_AUTO_PROMPT_FILE, '第一版正文\n', tmp);
    const upgraded = ensurePluginPrompt(UI_AUTO_PROMPT_FILE, '第二版正文\n', tmp);
    assert.equal(upgraded.updated, true);
    assert.equal(readPluginPrompt(UI_AUTO_PROMPT_FILE, tmp), '第二版正文\n');

    fs.writeFileSync(pluginPromptPath(UI_AUTO_PROMPT_FILE, tmp), '我自己写的正文\n', 'utf8');
    const kept = ensurePluginPrompt(UI_AUTO_PROMPT_FILE, '第三版正文\n', tmp);
    assert.equal(kept.updated, false);
    assert.equal(readPluginPrompt(UI_AUTO_PROMPT_FILE, tmp), '我自己写的正文\n');
  });

  it('插件开着时不允许删除，关掉后解锁', () => {
    ensurePluginPrompt(UI_AUTO_PROMPT_FILE, '种子正文', tmp);

    setPlugin('uiAuto', true);
    assert.equal(isPluginOnInSpace('uiAuto', tmp), true);
    assert.match(pluginPromptLock(UI_AUTO_PROMPT_FILE, tmp), /关闭对应插件/);

    setPlugin('uiAuto', false);
    assert.equal(isPluginOnInSpace('uiAuto', tmp), false);
    assert.equal(pluginPromptLock(UI_AUTO_PROMPT_FILE, tmp), '');
  });

  it('不相干的提示词不受影响', () => {
    setPlugin('uiAuto', true);
    assert.equal(pluginPromptLock('我自己的提示词.md', tmp), '');
    assert.equal(pluginPromptLock(UI_AUTO_PROMPT_FILE, tmp).length > 0, true);
  });
});

describe('UI 自动化测试提示词接口', () => {
  let tmp = '';
  let server: http.Server | null = null;
  let base = '';

  beforeEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve(undefined)));
      server = null;
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-uiauto-prompt-'));
    __resetSpaceContext();
    setActiveRoot(tmp);

    const app = connect();
    const plugin = lhUiautoPlugin();
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
    await new Promise<void>((resolve) => server?.close(() => resolve(undefined)));
    __resetSpaceContext();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('打开插件时补种子，接口返回两段正文', async () => {
    const sync = await fetch(`${base}/__tb_uiauto/prompt/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(sync.ok, true);
    const synced = (await sync.json()) as { created: boolean; file: string };
    assert.equal(synced.created, true);
    assert.equal(synced.file, UI_AUTO_PROMPT_FILE);

    const res = await fetch(`${base}/__tb_uiauto/prompt`);
    const data = (await res.json()) as { exists: boolean; plan: string; agent: string };
    assert.equal(data.exists, true);
    assert.match(data.plan, /资深测试设计师/);
    assert.match(data.agent, /\{\{plan\}\}/);
  });

  it('用户改过的提示词不会被种子盖掉', async () => {
    fs.mkdirSync(path.dirname(pluginPromptPath(UI_AUTO_PROMPT_FILE, tmp)), { recursive: true });
    fs.writeFileSync(
      pluginPromptPath(UI_AUTO_PROMPT_FILE, tmp),
      '## 规划阶段\n\n我自己的规划\n\n## 探索阶段\n\n我自己的探索\n',
      'utf8',
    );
    await fetch(`${base}/__tb_uiauto/prompt/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const data = (await (await fetch(`${base}/__tb_uiauto/prompt`)).json()) as {
      plan: string;
      agent: string;
    };
    assert.equal(data.plan, '我自己的规划');
    assert.equal(data.agent, '我自己的探索');
  });

  it('关闭插件不删文件，再打开仍引用同一份', async () => {
    await fetch(`${base}/__tb_uiauto/prompt/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const file = pluginPromptPath(UI_AUTO_PROMPT_FILE, tmp);
    fs.writeFileSync(file, '## 探索阶段\n\n保留我\n', 'utf8');

    const off = (await (
      await fetch(`${base}/__tb_uiauto/prompt/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    ).json()) as { removed: boolean; exists: boolean };
    assert.equal(off.removed, false);
    assert.equal(off.exists, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '## 探索阶段\n\n保留我\n');
  });
});

describe('提示词管理：插件开启时服务端拒绝删除', () => {
  let tmp = '';
  let server: http.Server | null = null;
  let base = '';

  beforeEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve(undefined)));
      server = null;
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prompt-lock-'));
    __resetSpaceContext();
    setActiveRoot(tmp);
    const cfg = spaceLocalFile(tmp, 'app.config.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ plugins: { uiAuto: true } }), 'utf8');

    const app = connect();
    const plugin = lhPromptsPlugin();
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
    await new Promise<void>((resolve) => server?.close(() => resolve(undefined)));
    __resetSpaceContext();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('删除被插件引用的提示词返回 403，文件保留', async () => {
    ensurePluginPrompt(UI_AUTO_PROMPT_FILE, '## 探索阶段\n\n正文\n', tmp);
    const res = await fetch(`${base}/__tb_prompts/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: UI_AUTO_PROMPT_FILE }),
    });
    assert.equal(res.status, 403);
    const data = (await res.json()) as { error?: string };
    assert.match(String(data.error), /关闭对应插件/);
    assert.equal(fs.existsSync(pluginPromptPath(UI_AUTO_PROMPT_FILE, tmp)), true);
  });

  it('普通提示词不受插件开关影响（改名不返回 403）', async () => {
    fs.mkdirSync(path.dirname(pluginPromptPath('我的提示词.md', tmp)), { recursive: true });
    fs.writeFileSync(pluginPromptPath('我的提示词.md', tmp), '正文\n', 'utf8');
    const res = await fetch(`${base}/__tb_prompts/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '我的提示词.md', name: '改个名字.md' }),
    });
    assert.notEqual(res.status, 403);
  });
});
