/**
 * 分组 = 物理归档：菜单分组的成员在磁盘上应搬进分组文件夹，取消分组后搬回空间根。
 * 这些用例直接用临时空间目录跑 syncNavGroups / scanNavGroups，不启动服务。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  autoEnableDetectedPlugins,
  markPluginsDisabled,
  scanNavGroups,
  syncNavGroups,
} from '../../builtin/session/lh-nav-groups.mjs';
import { prepareSpaceDir } from '../../cli/data-root.mjs';
import { resolveContentRoot } from '../../builtin/session/space-layout.mjs';
import { DOC_ROOT_DIRS } from '../../lh-plugins/lh-project-docs.mjs';

const REQ = DOC_ROOT_DIRS.requirements.dirName;
const CASES = DOC_ROOT_DIRS.cases.dirName;

let space = '';

function write(rel: string, body: string) {
  const abs = path.join(space, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

function exists(rel: string) {
  return fs.existsSync(path.join(space, rel));
}

describe('分组文件夹与内容目录', () => {
  before(() => {
    space = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-nav-'));
    write(`${REQ}/a.md`, '# a');
    write(`${CASES}/b.md`, '# b');
  });

  after(() => {
    try {
      fs.rmSync(space, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('组内菜单对应的内容目录搬进分组文件夹', () => {
    const out = syncNavGroups(space, [{ id: 'g_docs', name: '文档组', items: ['requirements'] }]);
    assert.deepEqual(out.warnings, []);
    assert.equal(exists(`文档组/${REQ}/a.md`), true, '内容应跟着分组走');
    assert.equal(exists(`${REQ}`), false, '空间根上不应再留同名目录');
    assert.equal(exists(`${CASES}/b.md`), true, '未分组的内容不动');
    assert.equal(resolveContentRoot(space, REQ).grouped, true);
    assert.equal(exists(`${CASES}`), true);
  });

  it('从文件夹结构也能还原出组内菜单', () => {
    const scanned = scanNavGroups(space);
    const g = scanned.groups.find((x) => x.name === '文档组');
    assert.ok(g, '应识别出文档组');
    assert.deepEqual(g!.items, ['requirements']);
  });

  it('取消分组后内容目录搬回空间根', () => {
    const out = syncNavGroups(space, []);
    assert.deepEqual(out.warnings, []);
    assert.equal(exists(`${REQ}/a.md`), true);
    assert.equal(exists(`文档组/${REQ}`), false);
    assert.equal(resolveContentRoot(space, REQ).grouped, false);
  });

  it('删除分组时组内内容先搬出来，再删空的分组目录', () => {
    syncNavGroups(space, [{ id: 'g_cases', name: '用例组', items: ['cases'] }]);
    assert.equal(exists(`用例组/${CASES}/b.md`), true);

    const out = syncNavGroups(space, []);
    assert.deepEqual(out.warnings, []);
    assert.equal(exists(`${CASES}/b.md`), true, '内容不能跟着分组一起消失');
    assert.equal(exists('用例组'), false, '只剩清单的分组目录应被删掉');
  });
});

describe('新建空间的插件默认开关', () => {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  let fresh = '';
  let defaults: Record<string, boolean> = {};

  before(() => {
    // 隔离识别账本，避免写进真实的 ~/.config
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-user-cfg-'));
    fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fresh-space-'));
    prepareSpaceDir(fresh);
    const raw = fs.readFileSync(
      path.join(fresh, '.lantern', 'config', 'app.defaults.json'),
      'utf8',
    );
    defaults = (JSON.parse(raw).plugins ?? {}) as Record<string, boolean>;
  });

  after(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    try {
      fs.rmSync(fresh, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('除提示词管理外，所有插件默认关闭', () => {
    for (const id of [
      'cases',
      'caseGen',
      'promptGen',
      'knowledgeLib',
      'knowledgeGen',
      'requirements',
      'templates',
      'knowledge',
      'memory',
      'pluginDev',
    ]) {
      assert.equal(defaults[id], false, `${id} 新建空间默认应关闭`);
    }
    assert.equal(defaults.prompts, true, '提示词管理是内置常开项');
  });

  it('种子文件不触发自动开插件，用户放入内容后仍会', () => {
    const seeded = autoEnableDetectedPlugins(fresh, defaults, []);
    assert.equal(seeded.changed, false, '种子文件不应让插件自动打开');
    assert.equal(seeded.plugins.prompts, true, '提示词管理始终开启');
    assert.equal(seeded.plugins.templates, false);

    const dir = path.join(fresh, DOC_ROOT_DIRS.cases.dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), '# a', 'utf8');
    const out = autoEnableDetectedPlugins(fresh, defaults, []);
    assert.equal(out.plugins.cases, true, '用户放入的内容仍应自动打开对应插件');
  });

  it('用户手动关掉的插件不会被自动识别重新打开', () => {
    // 第二个空间：内容已存在，但用户在自动识别之前就关掉了 cases
    const space2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-manual-off-'));
    fs.mkdirSync(path.join(space2, '.lantern'), { recursive: true });
    fs.writeFileSync(
      path.join(space2, '.lantern', 'space.json'),
      JSON.stringify({ kind: 'lantern-harness-space', id: 'sp_off', name: '手动关闭' }),
      'utf8',
    );
    fs.mkdirSync(path.join(space2, DOC_ROOT_DIRS.cases.dirName), { recursive: true });
    fs.writeFileSync(path.join(space2, DOC_ROOT_DIRS.cases.dirName, 'a.md'), '# a', 'utf8');

    markPluginsDisabled(space2, ['cases']);
    const out = autoEnableDetectedPlugins(space2, { ...defaults, cases: false }, []);
    assert.equal(out.plugins.cases, false, '手动关闭的开关应保持关闭');

    fs.rmSync(space2, { recursive: true, force: true });
  });

  it('空间目录改名后不会重跑自动识别并覆盖开关', () => {
    const before = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-rename-a-'));
    fs.mkdirSync(path.join(before, '.lantern'), { recursive: true });
    fs.writeFileSync(
      path.join(before, '.lantern', 'space.json'),
      JSON.stringify({ kind: 'lantern-harness-space', id: 'sp_rename', name: '改名空间' }),
      'utf8',
    );
    fs.mkdirSync(path.join(before, DOC_ROOT_DIRS.cases.dirName), { recursive: true });
    fs.writeFileSync(path.join(before, DOC_ROOT_DIRS.cases.dirName, 'a.md'), '# a', 'utf8');
    const first = autoEnableDetectedPlugins(before, defaults, []);
    assert.equal(first.plugins.cases, true);

    // 用户随即关掉，并把整个空间目录改名
    const after = `${before}-renamed`;
    fs.renameSync(before, after);
    const second = autoEnableDetectedPlugins(after, { ...defaults, cases: false }, []);
    assert.equal(second.plugins.cases, false, '改名后不应因为账本换 key 而重新打开');

    fs.rmSync(after, { recursive: true, force: true });
  });
});
