import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyPluginDependencies,
  PLUGIN_CATALOG,
  PLUGIN_CATEGORIES,
  pluginEnabledWith,
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

  it('测试与需求链路各自归组', () => {
    const byId = new Map(PLUGIN_CATALOG.map((p) => [p.id, p]));
    for (const id of [
      'cases',
      'knowledgeLib',
      'templates',
      'caseGen',
      'testStats',
      'knowledgeGen',
      'caseExec',
      'uiAuto',
    ] as const) {
      assert.equal(byId.get(id)?.category, '测试技能', id);
    }
    for (const id of ['requirements', 'reqAnalysis', 'storyReview', 'testPoints'] as const) {
      assert.equal(byId.get(id)?.category, '需求管理', id);
    }
  });

  it('内置插件分类：提示词管理与生成提示词都是常开、无开关', () => {
    const byId = new Map(PLUGIN_CATALOG.map((p) => [p.id, p]));
    for (const id of ['prompts', 'promptGen'] as const) {
      assert.equal(byId.get(id)?.category, '内置插件', id);
      assert.equal(byId.get(id)?.alwaysOn, true, id);
      assert.equal(byId.get(id)?.defaultEnabled, true, id);
    }
  });

  it('内置常开项是「提示词管理」「生成提示词」；默认开启的还有「用户故事审查」「生成测试点」', () => {
    const on = PLUGIN_CATALOG.filter((p) => p.defaultEnabled).map((p) => p.id);
    assert.deepEqual(on.sort(), ['promptGen', 'prompts', 'storyReview', 'testPoints']);
    const always = PLUGIN_CATALOG.filter((p) => p.alwaysOn).map((p) => p.id);
    assert.deepEqual(always, ['prompts', 'promptGen']);
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
    projects: true,
    iterations: true,
    pmRequirements: true,
    bugs: true,
    reports: true,
    testStats: true,
    caseExec: true,
    uiAuto: true,
    reqAnalysis: true,
    storyReview: true,
    testPoints: true,
    dashboard: true,
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

  it('关闭项目列表会连带关闭迭代 / 需求 / 缺陷', () => {
    const next = applyPluginDependencies(flags(), { id: 'projects', enabled: false });
    assert.equal(next.projects, false);
    assert.equal(next.iterations, false);
    assert.equal(next.pmRequirements, false);
    assert.equal(next.bugs, false);
    assert.equal(next.tasks, true);
  });

  it('单独打开任一子项会带上项目列表', () => {
    for (const id of ['iterations', 'pmRequirements', 'bugs'] as const) {
      const next = applyPluginDependencies(
        flags({ projects: false, iterations: false, pmRequirements: false, bugs: false }),
        { id, enabled: true },
      );
      assert.equal(next.projects, true, id);
      assert.equal(next[id], true, id);
    }
  });

  it('打开需求分析会默认带上用户故事审查与生成测试点', () => {
    const next = applyPluginDependencies(
      flags({ reqAnalysis: false, storyReview: false, testPoints: false }),
      {
        id: 'reqAnalysis',
        enabled: true,
      },
    );
    assert.equal(next.reqAnalysis, true);
    assert.equal(next.storyReview, true);
    assert.equal(next.testPoints, true);
  });

  it('用户故事审查仍可单独关掉，关掉后不影响需求分析', () => {
    const next = applyPluginDependencies(flags(), { id: 'storyReview', enabled: false });
    assert.equal(next.storyReview, false);
    assert.equal(next.reqAnalysis, true);
    assert.equal(next.testPoints, true);
  });

  it('生成测试点仍可单独关掉，关掉后不影响需求分析', () => {
    const next = applyPluginDependencies(flags(), { id: 'testPoints', enabled: false });
    assert.equal(next.testPoints, false);
    assert.equal(next.reqAnalysis, true);
  });

  it('关掉需求分析会连带关掉用户故事审查与生成测试点', () => {
    const next = applyPluginDependencies(flags(), { id: 'reqAnalysis', enabled: false });
    assert.equal(next.reqAnalysis, false);
    assert.equal(next.storyReview, false);
    assert.equal(next.testPoints, false);
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

  it('覆盖全部插件；提示词管理、生成提示词、用户故事审查与生成测试点默认开，其余关闭', () => {
    const raw = JSON.parse(fs.readFileSync(defaultsFile, 'utf8')) as {
      plugins?: Record<string, boolean>;
    };
    const plugins = raw.plugins ?? {};
    // 生成提示词归到内置插件，默认打开且没有开关
    const onByDefault = new Set(['prompts', 'promptGen', 'storyReview', 'testPoints']);
    for (const p of PLUGIN_CATALOG) {
      assert.equal(typeof plugins[p.id], 'boolean', `默认配置缺少插件 ${p.id}`);
      assert.equal(plugins[p.id], onByDefault.has(p.id), `${p.id} 的新建空间默认值不符合预期`);
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

describe('按外部读到的开关计算最终状态', () => {
  it('缺省值回落到目录默认值', () => {
    const map = pluginEnabledWith({});
    assert.equal(map.prompts, true);
    assert.equal(map.storyReview, false);
    assert.equal(map.bugs, false);
    assert.equal(map.dashboard, false);
  });

  it('父插件关闭时连带关闭子插件', () => {
    const map = pluginEnabledWith({ projects: true, bugs: true, iterations: false });
    assert.equal(map.projects, true);
    assert.equal(map.bugs, true);
    assert.equal(map.iterations, false);
  });
});
