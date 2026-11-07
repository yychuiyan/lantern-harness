/**
 * 新建项目「检查」步骤的纯函数回归：补丁应用、模型输出归一化、确定性体检。
 *
 * 这里不拉服务也不调模型：流水线本身只在浏览器里跑，能被单测覆盖的是它的输入输出约定。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applySkeletonPatches,
  buildScaffoldAuditPrompt,
  isSafeSkeletonPath,
  normalizePatches,
  parseFindings,
  patchTargets,
  platformFindings,
  type SkeletonPatch,
} from './ui-auto-scaffold-audit';
import { auditScaffold } from '../../lh-plugins/uiauto-scaffold/audit.mjs';
import { parseSkeleton, renderFromSkeleton } from '../../lh-plugins/uiauto-scaffold/library.mjs';
import { builtinSkeletonText } from '../../lh-plugins/uiauto-scaffold/templates/playwright-ts.mjs';

const BASE = JSON.stringify(
  {
    schema: 1,
    id: 'demo',
    stack: 'playwright',
    layout: { testDir: 'tests', pagesDir: 'pages' },
    options: [
      { id: 'authState', label: '登录态示例', hint: '' },
      { id: 'ci', label: 'CI', hint: '' },
    ],
    defaultOptions: ['ci'],
    files: [
      { path: 'package.json', content: '{"name":"demo"}' },
      { path: 'playwright.config.ts', content: 'export default { testDir: "tests" };' },
      { path: 'tests/smoke/a.spec.ts', content: "test('a @smoke', () => {});" },
    ],
  },
  null,
  2,
);

describe('骨架补丁应用', () => {
  it('addFile 新增文件，已存在则覆盖正文', () => {
    const next = JSON.parse(
      applySkeletonPatches(BASE, [
        {
          action: 'addFile',
          path: 'fixtures/cleanup.ts',
          content: 'export {};',
          when: 'authState',
        },
      ]),
    );
    const file = next.files.find((item: { path: string }) => item.path === 'fixtures/cleanup.ts');
    assert.equal(file.content, 'export {};');
    assert.equal(file.when, 'authState');

    const replaced = JSON.parse(
      applySkeletonPatches(BASE, [
        { action: 'addFile', path: 'tests/smoke/a.spec.ts', content: 'updated' },
      ]),
    );
    assert.equal(
      replaced.files.find((item: { path: string }) => item.path === 'tests/smoke/a.spec.ts')
        .content,
      'updated',
    );
  });

  it('replaceFile 必须命中已有文件，removeFile 不会删光骨架', () => {
    assert.throws(
      () => applySkeletonPatches(BASE, [{ action: 'replaceFile', path: 'nope.ts', content: 'x' }]),
      /不在骨架里/,
    );
    const next = JSON.parse(
      applySkeletonPatches(BASE, [{ action: 'removeFile', path: 'tests/smoke/a.spec.ts' }]),
    );
    assert.equal(next.files.length, 2);
  });

  it('setOptions 增删选项，并把被删项从默认勾选里摘掉', () => {
    const next = JSON.parse(
      applySkeletonPatches(BASE, [
        { action: 'setOptions', add: [{ id: 'trace', label: 'Trace' }], remove: ['ci'] },
      ]),
    );
    assert.deepEqual(
      next.options.map((item: { id: string }) => item.id),
      ['authState', 'trace'],
    );
    assert.deepEqual(next.defaultOptions, []);
  });

  it('拒绝不安全路径与坏 JSON', () => {
    assert.equal(isSafeSkeletonPath('../etc/passwd'), false);
    assert.equal(isSafeSkeletonPath('/tmp/a.ts'), false);
    assert.equal(isSafeSkeletonPath('C:/a.ts'), false);
    assert.equal(isSafeSkeletonPath('src/a.ts'), true);
    assert.throws(
      () => applySkeletonPatches('not json', [{ action: 'addFile', path: 'a.ts', content: 'x' }]),
      /合法 JSON/,
    );
    assert.throws(
      () => applySkeletonPatches(BASE, [{ action: 'addFile', path: '../x.ts', content: 'x' }]),
      /不安全/,
    );
  });

  it('补丁目标可读：文件用 +/-/~ 前缀，选项单独列出', () => {
    assert.deepEqual(
      patchTargets([
        { action: 'addFile', path: 'a.ts', content: 'x' },
        { action: 'removeFile', path: 'b.ts' },
        { action: 'replaceFile', path: 'c.ts', content: 'x' },
        { action: 'setOptions', add: [{ id: 'trace', label: 'T' }], remove: ['ci'] },
      ]),
      ['+a.ts', '-b.ts', '~c.ts', '选项 +trace -ci'],
    );
  });
});

describe('模型输出归一化', () => {
  it('容忍代码围栏与前后废话，只取最外层 JSON', () => {
    const parsed = parseFindings(
      '先说明一下\n```json\n{"findings":[{"id":"f1","level":"warn","title":"缺 cleanup","patches":[{"action":"addFile","path":"fixtures/cleanup.ts","content":"x"}]}],"notes":"ok"}\n```\n完毕',
    );
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.findings[0].level, 'warn');
    assert.equal(parsed.findings[0].source, 'model');
    assert.equal(parsed.findings[0].patches.length, 1);
    assert.equal(parsed.notes, 'ok');
  });

  it('非法 level 归到 warn，重复 id 与超量条目被丢掉', () => {
    const list = Array.from({ length: 20 }, (_, index) => ({
      id: index < 2 ? 'dup' : `f${index}`,
      level: 'fatal',
      title: `t${index}`,
    }));
    const parsed = parseFindings(JSON.stringify({ findings: list }));
    assert.equal(parsed.findings.length, 12);
    assert.equal(parsed.findings[0].level, 'warn');
    assert.equal(parsed.findings.filter((item) => item.id === 'dup').length, 1);
  });

  it('坏补丁被过滤，好补丁保留', () => {
    const patches = normalizePatches([
      { action: 'addFile', path: '../evil.ts', content: 'x' },
      { action: 'addFile', path: 'a.ts', content: '' },
      { action: 'setOptions', add: [{ id: 'Bad-Id', label: 'x' }] },
      { action: 'setOptions', add: [{ id: 'trace', label: 'Trace', hint: 'on' }] },
      { action: 'nope', path: 'a.ts' },
    ]);
    assert.equal(patches.length, 1);
    const only = patches[0] as Extract<SkeletonPatch, { action: 'setOptions' }>;
    assert.deepEqual(only.add, [{ id: 'trace', label: 'Trace', hint: 'on' }]);
  });

  it('不是 JSON 时抛错，由调用方降级为「只有平台检查」', () => {
    assert.throws(() => parseFindings('模型直接说了段人话'), /没有 JSON/);
  });
});

describe('确定性体检（auditScaffold）', () => {
  const auditOf = (
    options: string[],
    mutate?: (files: Array<{ path: string; content: string }>) => void,
  ) => {
    const skeleton = parseSkeleton(builtinSkeletonText('playwright-ts'), {
      fallbackId: 'playwright-ts',
    });
    const rendered = renderFromSkeleton(skeleton, {
      projectName: 'demo-e2e',
      baseURL: 'https://demo.example.com',
      options,
    });
    const files = rendered.files.map((file) => ({
      path: file.path,
      content: String(file.content ?? ''),
    }));
    mutate?.(files);
    return auditScaffold({
      skeleton,
      files,
      options: rendered.options,
      targetDir: '/tmp/demo-e2e',
    });
  };

  it('内置骨架默认勾选下能通过结构检查', () => {
    const result = auditOf(['authState', 'ci', 'lint']);
    assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
    assert.ok(result.summary.files > 10);
    assert.ok(result.logs.some((entry) => entry.stage === 'structure'));
  });

  it('缺 package.json / 代码里写 networkidle 会被点名', () => {
    const result = auditOf(['authState', 'ci', 'lint'], (files) => {
      const pkg = files.find((file) => file.path === 'package.json');
      files.splice(files.indexOf(pkg as { path: string; content: string }), 1);
      const spec = files.find((file) => /^tests\/.*\.spec\.ts$/.test(file.path));
      if (spec) spec.content += "\nawait page.waitForLoadState('networkidle');\n";
    });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((item) => item.id === 'missing-package.json'));
    assert.ok(result.checks.some((item) => item.id === 'networkidle'));
  });

  it('勾了选项却没产出文件 → error（选项与 when 标记对不上）', () => {
    const result = auditOf(['authState', 'ci', 'lint'], (files) => {
      const index = files.findIndex((file) => file.path === 'tests/auth.setup.ts');
      if (index >= 0) files.splice(index, 1);
    });
    assert.ok(result.checks.some((item) => item.id === 'login-state-missing'));
  });

  it('目标目录问题变成 target 阶段的问题项', () => {
    const skeleton = parseSkeleton(builtinSkeletonText('playwright-ts'), {
      fallbackId: 'playwright-ts',
    });
    const rendered = renderFromSkeleton(skeleton, {
      projectName: 'demo-e2e',
      baseURL: 'https://demo.example.com',
      options: [],
    });
    const result = auditScaffold({
      skeleton,
      files: rendered.files.map((file) => ({
        path: file.path,
        content: String(file.content ?? ''),
      })),
      options: rendered.options,
      targetDir: '/tmp/demo-e2e',
      targetProblem: '目标目录已有文件',
    });
    assert.ok(result.checks.some((item) => item.id === 'target-dir' && item.level === 'error'));
  });

  it('平台问题转成统一的 findings，不可勾选应用', () => {
    const items = platformFindings([
      { id: 'missing-x', level: 'error', title: '缺文件', detail: '说明', file: 'x.ts' },
    ]);
    assert.equal(items[0].source, 'platform');
    assert.equal(items[0].patches.length, 0);
    assert.equal(items[0].file, 'x.ts');
  });
});

describe('模型输入（buildScaffoldAuditPrompt）', () => {
  /** 内置骨架 41k+ 字符：正是它把旧的「截断全文」方案逼出假缺失 */
  const promptOf = () => {
    const raw = builtinSkeletonText('playwright-ts');
    return buildScaffoldAuditPrompt({
      space: {
        ok: true,
        id: 'playwright-ts',
        stack: 'playwright',
        source: 'space',
        modified: false,
        raw,
        options: ['authState', 'ci', 'lint', 'husky', 'allure', 'docker', 'webServer'],
        defaultOptions: ['authState', 'ci', 'lint'],
        files: 37,
        promptFile: '自动化项目提示词.md',
      },
      platform: null,
      project: {
        stack: 'playwright',
        name: 'demo-e2e',
        parentDir: '/tmp',
        baseURL: 'https://demo.example.com',
        options: ['authState', 'lint'],
      },
    });
  };

  it('清单列出骨架里的全部文件，尾部文件不会被截掉', () => {
    const prompt = promptOf();
    const skeleton = parseSkeleton(builtinSkeletonText('playwright-ts'), {
      fallbackId: 'playwright-ts',
    });
    for (const file of skeleton.files) {
      assert.ok(
        prompt.includes(`- ${file.path}（`),
        `清单缺少 ${file.path}；模型会把它当成「文件缺失」`,
      );
    }
    // 旧实现截断在 24000 字符，这几个文件不在前 18 个，正是假缺失的来源
    for (const path of ['tests/auth.setup.ts', 'eslint.config.mjs', '.husky/pre-commit']) {
      assert.ok(prompt.includes(path), `${path} 必须出现在提示词里`);
    }
  });

  it('不再出现「骨架过长已截断」，并明确告知节选 ≠ 缺失', () => {
    const prompt = promptOf();
    assert.ok(!prompt.includes('骨架过长已截断'));
    assert.match(prompt, /正文里没有出现 ≠ 文件不存在/);
    assert.match(prompt, /仅当勾选 authState/);
  });
});
