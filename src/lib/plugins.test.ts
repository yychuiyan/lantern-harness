import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyPluginDependencies,
  PLUGIN_CATALOG,
  PLUGIN_CATEGORIES,
  type PluginId,
} from './plugins';
import { NAV_ENTRIES } from './nav-menu';

describe('插件分类', () => {
  it('每个插件都有分类，且分类名在固定清单内', () => {
    for (const p of PLUGIN_CATALOG) {
      assert.ok(PLUGIN_CATEGORIES.includes(p.category), `${p.id} 缺少有效分类`);
    }
  });

  it('默认开启的两个插件也归入分类', () => {
    const byId = new Map(PLUGIN_CATALOG.map((p) => [p.id, p]));
    assert.equal(byId.get('memory')?.category, '记忆与检索');
    assert.equal(byId.get('pluginDev')?.category, '开发工具');
  });

  it('只有「提示词管理」是内置常开的默认项', () => {
    const on = PLUGIN_CATALOG.filter((p) => p.defaultEnabled).map((p) => p.id);
    assert.deepEqual(on, ['prompts']);
    const always = PLUGIN_CATALOG.filter((p) => p.alwaysOn).map((p) => p.id);
    assert.deepEqual(always, ['prompts']);
  });
});

function flags(over: Partial<Record<PluginId, boolean>> = {}): Record<PluginId, boolean> {
  return {
    cases: true,
    caseGen: true,
    prompts: true,
    promptGen: true,
    knowledgeLib: true,
    knowledgeGen: true,
    requirements: true,
    templates: true,
    knowledge: true,
    memory: true,
    pluginDev: true,
    todos: true,
    tasks: true,
    ...over,
  };
}

describe('applyPluginDependencies', () => {
  it('用例管理关闭时生成测试用例视为关闭', () => {
    const next = applyPluginDependencies(flags({ cases: false, caseGen: true }));
    assert.equal(next.cases, false);
    assert.equal(next.caseGen, false);
  });

  it('单独打开生成测试用例时会带上用例管理', () => {
    const next = applyPluginDependencies(flags({ cases: false, caseGen: false }), {
      id: 'caseGen',
      enabled: true,
    });
    assert.equal(next.cases, true);
    assert.equal(next.caseGen, true);
  });

  it('关闭用例管理时一并关闭生成测试用例', () => {
    const next = applyPluginDependencies(flags(), { id: 'cases', enabled: false });
    assert.equal(next.cases, false);
    assert.equal(next.caseGen, false);
    assert.equal(next.promptGen, true);
  });

  it('提示词管理是内置常开项，关闭操作不生效', () => {
    const next = applyPluginDependencies(flags({ prompts: false, promptGen: true }), {
      id: 'prompts',
      enabled: false,
    });
    assert.equal(next.prompts, true);
    assert.equal(next.promptGen, true);
  });

  it('单独打开生成提示词时会带上提示词管理', () => {
    const next = applyPluginDependencies(flags({ prompts: false, promptGen: false }), {
      id: 'promptGen',
      enabled: true,
    });
    assert.equal(next.prompts, true);
    assert.equal(next.promptGen, true);
  });

  it('知识库管理关闭时生成知识库视为关闭', () => {
    const next = applyPluginDependencies(flags({ knowledgeLib: false, knowledgeGen: true }));
    assert.equal(next.knowledgeLib, false);
    assert.equal(next.knowledgeGen, false);
  });

  it('单独打开生成知识库时会带上知识库管理', () => {
    const next = applyPluginDependencies(flags({ knowledgeLib: false, knowledgeGen: false }), {
      id: 'knowledgeGen',
      enabled: true,
    });
    assert.equal(next.knowledgeLib, true);
    assert.equal(next.knowledgeGen, true);
  });

  it('需求文档库 / 测试模板库各自独立，互不牵连', () => {
    const next = applyPluginDependencies(flags(), { id: 'requirements', enabled: false });
    assert.equal(next.requirements, false);
    assert.equal(next.templates, true);
    assert.equal(next.cases, true);
    assert.equal(next.caseGen, true);
  });
});

describe('插件的侧栏入口', () => {
  it('需求文档库与测试模板库都绑定了插件', () => {
    const byId = new Map(NAV_ENTRIES.map((e) => [e.id, e]));
    assert.equal(byId.get('requirements')?.plugin, 'requirements');
    assert.equal(byId.get('templates')?.plugin, 'templates');
  });

  it('菜单项绑定的插件都在注册表里', () => {
    const ids = new Set(PLUGIN_CATALOG.map((p) => p.id));
    for (const entry of NAV_ENTRIES) {
      if (!entry.plugin) continue;
      assert.ok(ids.has(entry.plugin), `缺少插件注册：${entry.plugin}`);
    }
  });
});

describe('新建空间默认配置', () => {
  const defaultsFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../config/app.defaults.json',
  );

  it('覆盖全部插件；仅提示词管理默认开启，其余关闭', () => {
    const raw = JSON.parse(fs.readFileSync(defaultsFile, 'utf8')) as {
      plugins?: Record<string, boolean>;
    };
    const plugins = raw.plugins ?? {};
    for (const p of PLUGIN_CATALOG) {
      assert.equal(typeof plugins[p.id], 'boolean', `默认配置缺少插件 ${p.id}`);
      assert.equal(plugins[p.id], p.id === 'prompts', `${p.id} 的新建空间默认值不符合预期`);
    }
  });

  it('不残留目录外的插件键', () => {
    const raw = JSON.parse(fs.readFileSync(defaultsFile, 'utf8')) as {
      plugins?: Record<string, boolean>;
    };
    const ids = new Set(PLUGIN_CATALOG.map((p) => p.id));
    for (const key of Object.keys(raw.plugins ?? {})) {
      assert.ok(ids.has(key as PluginId), `默认配置里有未注册的插件：${key}`);
    }
  });
});
