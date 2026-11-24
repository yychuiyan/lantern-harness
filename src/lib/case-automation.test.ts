import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  getBatch,
  listIterations,
  refreshAutomationLinks,
  sourceDocument,
} from '../../lh-plugins/case-automation/service.mjs';
import { caseContentFingerprint } from '../../lh-plugins/case-execution/assets.mjs';
import {
  automationSummaryForCase,
  automationSummaryForFile,
  rememberAssessments,
  upsertAutomationLinks,
  writeBatch,
} from '../../lh-plugins/case-automation/store.mjs';
import { readTable, writeTableAtomic } from '../../lh-plugins/case-automation/tables.mjs';
import { emitFiles } from '../../lh-plugins/uiauto-explorer/emit-files.mjs';
import { mergeAutomationSpecBlock } from '../../lh-plugins/uiauto-explorer/merge.mjs';
import { uiautoStorePaths } from '../../lh-plugins/lh-uiauto.mjs';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-case-automation-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('功能用例转 UI 自动化', () => {
  it('来源用例文档返回已记录的自动化评估状态', async () => {
    const dir = path.join(root, '用例管理', '功能测试');
    fs.mkdirSync(dir, { recursive: true });
    const relative = '功能测试/评估状态.md';
    fs.writeFileSync(
      path.join(root, '用例管理', relative),
      [
        '| 用例编号 | 用例标题 | 测试步骤 | 预期结果 | 用例状态 | 实际结果 |',
        '| --- | --- | --- | --- | --- | --- |',
        '| TC-1 | 创建工单 | 打开页面并提交 | 创建成功 | 待验证 |  |',
      ].join('\n'),
      'utf8',
    );
    const first = await sourceDocument(root, relative);
    assert.equal(first.cases[0]?.automation?.status, 'not_configured');
    rememberAssessments(root, relative, first.cases[0]!.id, [
      { decision: 'automatable', reason: '可由 UI 完成' },
    ]);
    const second = await sourceDocument(root, relative);
    assert.equal(second.cases[0]?.automation?.status, 'automatable');
    assert.equal(second.cases[0]?.automation?.total, 0);
  });

  it('CSV、Markdown、XLSX 自动化用例文件可增量读写', async () => {
    const headers = ['自动化用例编号', '自动化用例标题', '运行状态'];
    for (const ext of ['.csv', '.md', '.xlsx']) {
      const file = path.join(root, `自动化测试用例${ext}`);
      await writeTableAtomic(file, ext, headers, [
        { 自动化用例编号: 'AUTO-1', 自动化用例标题: '创建工单', 运行状态: '待运行' },
      ]);
      const first = await readTable(file, ext);
      const firstRows = first.rows as Array<Record<string, string>>;
      assert.equal(firstRows[0]?.['自动化用例标题'], '创建工单');
      firstRows.push({ 自动化用例编号: 'AUTO-2', 自动化用例标题: '查询工单', 运行状态: '' });
      await writeTableAtomic(file, ext, headers, firstRows);
      const second = await readTable(file, ext);
      const secondRows = second.rows as Array<Record<string, string>>;
      assert.equal(secondRows.length, 2);
      assert.equal(secondRows[1]?.['自动化用例编号'], 'AUTO-2');
    }
  });

  it('iteration 测试块带唯一 tag、annotation 和可替换边界', () => {
    const ir = {
      title: '创建工单',
      target: 'ts',
      automationCaseId: 'AUTO-ABC123',
      tag: '@smoke',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', locator: { kind: 'role', role: 'button', name: '新建工单' } },
        {
          action: 'expect',
          locator: { kind: 'text', value: '创建成功' },
          text: '创建成功',
        },
      ],
    };
    const incoming = emitFiles(ir, 'ts', { testDir: 'tests/iteration' }).files.find(
      (file) => file.role === 'spec',
    )?.content;
    assert.ok(incoming);
    assert.match(incoming, /@lantern-auto-abc123/);
    assert.match(incoming, /com\.lantern\.automationCaseId/);
    const existing = `import { test, expect } from '@playwright/test';\n\ntest('人工用例', async () => {\n  expect(true).toBeTruthy();\n});\n`;
    const first = mergeAutomationSpecBlock(existing, incoming!);
    assert.ok(first && !first.unchanged);
    assert.match(first.content, /人工用例/);
    const second = mergeAutomationSpecBlock(
      first.content,
      incoming!.replace('test.describe("创建工单"', 'test.describe("创建工单-更新"'),
    );
    assert.ok(second && !second.unchanged);
    assert.equal((second.content.match(/lantern-automation:start/g) || []).length, 1);
    assert.match(second.content, /创建工单-更新/);
    assert.match(second.content, /人工用例/);
  });

  it('自动化和评估状态可按 caseId 与文件聚合', () => {
    upsertAutomationLinks(root, [
      {
        automationCaseId: 'AUTO-1',
        title: '创建工单',
        source: {
          casePath: '功能测试/工单.xlsx',
          caseId: 'case-1',
          caseNo: '1',
          title: '创建工单',
          fingerprint: 'fp',
        },
        status: 'passed',
        projectId: 'p1',
        projectName: '工单 UI',
        iteration: 'v1.12',
        iterationFile: 'tests/iteration/v1.12.spec.ts',
        tag: '@lantern-auto-1',
      },
    ]);
    rememberAssessments(root, '功能测试/工单.xlsx', 'case-2', [
      { decision: 'needs_manual', reason: '需要短信验证码' },
    ]);
    const passed = automationSummaryForCase(root, '功能测试/工单.xlsx', 'case-1');
    assert.equal(passed.status, 'passed');
    assert.equal(passed.passed, 1);
    const manual = automationSummaryForCase(root, '功能测试/工单.xlsx', 'case-2');
    assert.equal(manual.status, 'needs_manual');
    assert.equal(automationSummaryForFile(root, '功能测试/工单.xlsx')?.status, 'partial');
  });

  it('只向 UI 项目列出其 iteration 文件并按源文件名预选', () => {
    const projectDir = path.join(root, 'framework');
    fs.mkdirSync(path.join(projectDir, 'tests', 'iteration'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'playwright.config.ts'),
      "export default { testDir: './tests' };\n",
    );
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"ui"}');
    fs.writeFileSync(path.join(projectDir, 'node_modules', '.bin', 'playwright'), '');
    fs.writeFileSync(path.join(projectDir, 'tests', 'iteration', 'v1.12.spec.ts'), '');
    fs.mkdirSync(path.dirname(uiautoStorePaths(root).projectsFile), { recursive: true });
    fs.writeFileSync(
      uiautoStorePaths(root).projectsFile,
      JSON.stringify({
        version: 1,
        projects: [{ id: 'ui-1', name: 'UI 项目', dir: projectDir, framework: 'playwright' }],
        runs: [],
      }),
    );
    const data = listIterations(root, 'ui-1', '产品V1.12_功能测试用例.xlsx');
    assert.equal(data.project.kind, 'ui');
    assert.equal(data.suggestedIteration, 'v1.12');
    assert.deepEqual(
      data.files.map((file: { name: string }) => file.name),
      ['v1.12.spec.ts'],
    );
  });

  it('源用例、iteration 文件或测试块变化时标记过期，恢复后解除', () => {
    const projectDir = path.join(root, 'framework');
    const spec = 'tests/iteration/v1.12.spec.ts';
    const specAbs = path.join(projectDir, spec);
    fs.mkdirSync(path.dirname(specAbs), { recursive: true });
    fs.writeFileSync(
      specAbs,
      [
        '/* lantern-automation:start AUTO-1 */',
        "test('创建工单', async () => {});",
        '/* lantern-automation:end AUTO-1 */',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(root, '用例管理', '自动化测试'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '用例管理', '自动化测试', '工单_自动化测试用例.md'),
      '| 自动化用例编号 |\n|---|\n| AUTO-1 |\n',
    );
    fs.mkdirSync(path.dirname(uiautoStorePaths(root).projectsFile), { recursive: true });
    fs.writeFileSync(
      uiautoStorePaths(root).projectsFile,
      JSON.stringify({
        version: 1,
        projects: [{ id: 'ui-1', name: 'UI 项目', dir: projectDir, framework: 'playwright' }],
        runs: [],
      }),
    );
    const document = {
      path: '功能测试/工单.xlsx',
      cases: [
        {
          id: 'case-1',
          title: '创建工单',
          precondition: '',
          steps: '点击新建',
          expected: '创建成功',
          fields: [],
        },
      ],
    };
    const fingerprint = caseContentFingerprint(document.cases[0]);
    upsertAutomationLinks(root, [
      {
        automationCaseId: 'AUTO-1',
        title: '创建工单',
        source: {
          casePath: document.path,
          caseId: 'case-1',
          fingerprint,
        },
        projectId: 'ui-1',
        automationFilePath: '自动化测试/工单_自动化测试用例.md',
        iterationFile: spec,
        scriptPath: spec,
        status: 'passed',
        tag: '@lantern-auto-1',
      },
    ]);

    const refresh = () =>
      refreshAutomationLinks(root, document) as Record<string, Record<string, string>>;
    let summary = refresh()['AUTO-1'];
    assert.equal(summary.status, 'passed');

    document.cases[0].steps = '点击新建工单';
    summary = refresh()['AUTO-1'];
    assert.equal(summary.status, 'stale');
    assert.match(summary.staleReason, /来源功能用例内容已变化/);

    document.cases[0].steps = '点击新建';
    summary = refresh()['AUTO-1'];
    assert.equal(summary.status, 'passed');

    fs.writeFileSync(specAbs, "test('其他用例', async () => {});\n");
    summary = refresh()['AUTO-1'];
    assert.equal(summary.status, 'stale');
    assert.match(summary.staleReason, /测试块已缺失/);
  });

  it('服务重启后遗留的运行批次显示为中断，不会永久停在运行中', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    writeBatch(root, {
      id,
      status: 'running',
      env: '',
      automationCaseIds: ['AUTO-1'],
      items: [],
      stop: false,
      activeRunId: '',
      createdAt: new Date().toISOString(),
    });
    const batch = getBatch(root, id);
    assert.equal(batch.status, 'interrupted');
    assert.match(batch.error, /服务已重启/);
  });
});
