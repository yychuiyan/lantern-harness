import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildProbe } from '../../lh-plugins/uiauto-adapters/shared.mjs';
import {
  applyTaskOverrides,
  customToTasks,
  discoverRunTasks,
  normalizeCustomTasks,
  parseMakeTargets,
  parseMavenProfiles,
  parsePytestMarkers,
  pickRunScripts,
  taskCommandLine,
  taskView,
} from '../../lh-plugins/uiauto-adapters/tasks.mjs';

let tmp = '';

function makeProject(name: string, files: Record<string, string>): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uiauto-tasks-'));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('package.json scripts 发现', () => {
  it('只留测试类脚本，跳过 lint / 交互式命令', () => {
    const picked = pickRunScripts({
      test: 'playwright test',
      'test:smoke': "playwright test --grep '@p0'",
      'test:ui': 'playwright test --ui',
      'test:debug': 'playwright test --debug',
      lint: 'eslint .',
      format: 'prettier --write .',
      'report:allure': 'allure open reports/allure-report',
    }).map((item) => item.name);
    assert.deepEqual(picked, ['test', 'test:smoke']);
  });

  it('Playwright 脚本追加 reporters，非 Playwright 脚本不追加', () => {
    const root = makeProject('scripts', {
      'package.json': JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: {
          test: 'playwright test',
          'test:api': 'node scripts/api.mjs',
        },
      }),
    });
    const tasks = discoverRunTasks(buildProbe(root), 'playwright');
    const smoke = tasks.find((task) => task.id === 'script:test');
    assert.equal(smoke?.label, 'pnpm run test');
    assert.deepEqual(smoke?.args, ['--', '--reporter=list,json,html']);
    assert.equal(smoke?.failureFlags, true);
    const api = tasks.find((task) => task.id === 'script:test:api');
    assert.deepEqual(api?.args, []);
    assert.equal(api?.failureFlags, false);
  });
});

describe('Makefile 目标', () => {
  it('取带 ## 说明的测试目标，跳过 lint / format', () => {
    const targets = parseMakeTargets(
      [
        '.PHONY: test smoke lint',
        '',
        'test: ## 全量测试',
        '\t.venv/bin/python -m pytest -q',
        'smoke: ## 冒烟',
        '\t.venv/bin/python -m pytest -m smoke -q',
        'lint: ## Ruff 检查',
        '\truff check .',
        'format-check:',
        '\truff format --check .',
        'version := 1.0.0',
      ].join('\n'),
    );
    assert.deepEqual(
      targets.map((item) => item.name),
      ['test', 'smoke'],
    );
    assert.equal(targets[1].hint, '冒烟');
  });

  it('实际项目里 make 任务不追加失败参数', () => {
    const root = makeProject('makefile', {
      Makefile: 'smoke: ## 冒烟\n\tpytest -m smoke\n',
      'pyproject.toml': '[tool.pytest.ini_options]\n',
    });
    const task = discoverRunTasks(buildProbe(root), 'pytest').find(
      (item) => item.id === 'make:smoke',
    );
    assert.equal(task?.base, 'make smoke');
    assert.equal(task?.failureFlags, false);
    assert.equal(taskCommandLine(task, { bail: true }), 'make smoke');
  });
});

describe('pytest markers', () => {
  it('从 pyproject 的 markers 数组取名字与说明', () => {
    const markers = parsePytestMarkers({
      pyproject: [
        '[tool.pytest.ini_options]',
        'markers = [',
        '    "smoke: 核心主流程",',
        '    "regression: 重要功能",',
        ']',
        'addopts = ["-q"]',
      ].join('\n'),
    });
    assert.deepEqual(
      markers.map((item) => item.name),
      ['smoke', 'regression'],
    );
    assert.equal(markers[0].hint, '核心主流程');
  });

  it('从 pytest.ini 的 markers 段落取名字', () => {
    const markers = parsePytestMarkers({
      ini: ['[pytest]', 'markers =', '    smoke: 冒烟', '    edge: 边界'].join('\n'),
    });
    assert.deepEqual(
      markers.map((item) => item.name),
      ['smoke', 'edge'],
    );
  });

  it('marker 任务可追加 --lf / -x', () => {
    const root = makeProject('markers', {
      'pyproject.toml': '[tool.pytest.ini_options]\nmarkers = ["smoke: 冒烟"]\n',
      'conftest.py': '',
    });
    const task = discoverRunTasks(buildProbe(root), 'pytest').find(
      (item) => item.id === 'marker:smoke',
    );
    assert.match(task?.base ?? '', /-m pytest$/);
    assert.deepEqual(task?.args, ['-m', 'smoke']);
    assert.equal(taskCommandLine(task, { lastFailed: true }), `${task?.base} -m smoke --lf`);
    assert.equal(taskCommandLine(task, { bail: true }), `${task?.base} -m smoke -x`);
  });
});

describe('Maven profiles', () => {
  it('取 profile id 拼 -P，过滤带空格的 id', () => {
    const profiles = parseMavenProfiles(
      [
        '<profiles>',
        '<profile><id>smoke</id></profile>',
        '<profile><id>full test</id></profile>',
        '<profile><id>regression</id></profile>',
        '</profiles>',
      ].join(''),
    );
    assert.deepEqual(
      profiles.map((item) => item.id),
      ['smoke', 'regression'],
    );
  });

  it('Selenium + pom 时给 Maven profile 任务', () => {
    const root = makeProject('maven', {
      'pom.xml': '<profiles><profile><id>smoke</id></profile></profiles>',
    });
    const task = discoverRunTasks(buildProbe(root), 'selenium')[0];
    assert.equal(task?.label, 'mvn test -Psmoke');
    assert.equal(task?.failureFlags, false);
  });
});

describe('自定义任务', () => {
  it('名称为空时保留空串，空命令丢弃', () => {
    const tasks = normalizeCustomTasks([
      { name: '', command: 'npm run test:smoke' },
      { name: '冒烟', command: 'npm run test:smoke' },
      { name: '空', command: '   ' },
    ]);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].name, '');
    assert.equal(tasks[1].name, '冒烟');
    assert.ok(tasks[0].id);
  });

  it('下拉标签：有名称显示「名称（命令）」，没名称只显示命令', () => {
    const [named, unnamed] = customToTasks([
      { id: 'ut_1', name: '冒烟', command: 'npm run test:smoke' },
      { id: 'ut_2', name: '', command: 'npm run test:edge' },
    ]);
    assert.equal(named.label, '冒烟（npm run test:smoke）');
    assert.equal(unnamed.label, 'npm run test:edge');
    assert.equal(unnamed.display, 'npm run test:edge');
  });

  it('转成下拉任务后原样执行，不追加失败参数', () => {
    const [task] = customToTasks([
      { id: 'ut_1', name: '冒烟', command: 'uv run pytest -m "smoke or regression"' },
    ]);
    assert.equal(task.base, 'uv run pytest -m "smoke or regression"');
    assert.equal(task.custom, true);
    assert.equal(taskCommandLine(task, { bail: true }), task.base);
    assert.equal(taskView(task).command, task.base);
  });
});

describe('applyTaskOverrides', () => {
  const discovered = [
    {
      id: 'make:smoke',
      label: 'make smoke',
      display: 'smoke',
      base: 'make smoke',
      args: [],
      hint: '冒烟',
      kind: 'make',
      failureFlags: false,
      custom: false,
    },
    {
      id: 'make:unit',
      label: 'make unit',
      display: 'unit',
      base: 'make unit',
      args: [],
      hint: '单元',
      kind: 'make',
      failureFlags: false,
      custom: false,
    },
    {
      id: 'make:contract',
      label: 'make contract',
      display: 'contract',
      base: 'make contract',
      args: [],
      hint: '契约',
      kind: 'make',
      failureFlags: false,
      custom: false,
    },
  ];

  it('没改动时原样返回', () => {
    assert.equal(applyTaskOverrides(discovered, [], []).length, 3);
  });

  it('改命令：换成原样 shell 命令，不再追加框架参数', () => {
    const [task] = applyTaskOverrides(
      discovered,
      [{ id: 'make:smoke', name: '冒烟', command: 'make smoke --verbose' }],
      ['make:unit', 'make:contract'],
    );
    assert.equal(task.label, '冒烟（make smoke --verbose）');
    assert.equal(taskCommandLine(task, { lastFailed: true, bail: true }), 'make smoke --verbose');
    assert.equal(task.failureFlags, false);
    assert.equal(task.edited, true);
  });

  it('只改名称：命令沿用扫描结果，说明换成命令本身', () => {
    const [task] = applyTaskOverrides(discovered, [{ id: 'make:smoke', name: '冒烟' }], []);
    assert.equal(task.display, '冒烟');
    assert.equal(taskCommandLine(task), 'make smoke');
    assert.equal(task.hint, 'make smoke');
  });

  it('删掉的任务不再返回，且不会越界删除 full', () => {
    const tasks = applyTaskOverrides(discovered, [], ['make:unit', 'full']);
    assert.deepEqual(
      tasks.map((task) => task.id),
      ['make:smoke', 'make:contract'],
    );
  });

  it('指向已不存在的任务 id 时忽略改动', () => {
    const tasks = applyTaskOverrides(discovered, [{ id: 'make:gone', name: 'x' }], ['make:gone']);
    assert.equal(tasks.length, 3);
  });
});
