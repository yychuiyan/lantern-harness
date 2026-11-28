import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

import { renderTsFlowSpec } from '../../lh-plugins/uiauto-explorer/emit-files.mjs';
import { mergeAutomationSpecBlock } from '../../lh-plugins/uiauto-explorer/merge.mjs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createAutomationFlow,
  previewAutomationFlow,
} from '../../lh-plugins/case-automation/flows.mjs';
import {
  CASE_AUTOMATION_FLOW_PROMPT_TEMPLATE,
  CASE_AUTOMATION_PROMPT_TEMPLATE,
} from '../../lh-plugins/case-automation-prompt.mjs';
import {
  applyFlowRunResult,
  refreshAutomationLinks,
  syncPassedSources,
  updateAutomationRow,
} from '../../lh-plugins/case-automation/service.mjs';
import {
  readAutomationLinks,
  readFlowStore,
  upsertAutomationLinks,
} from '../../lh-plugins/case-automation/store.mjs';
import { readTable } from '../../lh-plugins/case-automation/tables.mjs';
import { caseContentFingerprint } from '../../lh-plugins/case-execution/assets.mjs';
import { loadCaseDocument } from '../../lh-plugins/case-execution/files.mjs';
import {
  businessMapFilePath,
  supplementAutomationFlow,
} from '../../lh-plugins/lh-business-map.mjs';
import { uiautoCachePaths, uiautoStorePaths } from '../../lh-plugins/lh-uiauto.mjs';
import { saveGeneratedSession } from '../../lh-plugins/uiauto-explorer/sessions.mjs';
import { UI_AUTO_PROMPT_TEMPLATE } from '../../lh-plugins/uiauto-prompt.mjs';

let root = '';

function createProject() {
  const projectDir = path.join(root, 'framework');
  fs.mkdirSync(path.join(projectDir, 'tests', 'iteration'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'auth', 'clerk.json'), '{"cookies":[],"origins":[]}');
  fs.writeFileSync(path.join(projectDir, 'auth', 'auditor.json'), '{"cookies":[],"origins":[]}');
  fs.writeFileSync(
    path.join(projectDir, 'playwright.config.ts'),
    "export default { testDir: './tests', use: { baseURL: 'http://127.0.0.1:4321' } };\n",
  );
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"ui"}');
  fs.writeFileSync(path.join(projectDir, 'node_modules', '.bin', 'playwright'), '');
  fs.mkdirSync(path.dirname(uiautoStorePaths(root).projectsFile), { recursive: true });
  fs.writeFileSync(
    uiautoStorePaths(root).projectsFile,
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: 'ui-1',
          name: '坐席 UI',
          dir: projectDir,
          framework: 'playwright',
          baseURL: 'http://127.0.0.1:4321',
          roles: [
            {
              id: 'clerk',
              name: '受理员',
              storageState: 'auth/clerk.json',
              status: 'ready',
            },
            {
              id: 'auditor',
              name: '审核员',
              storageState: 'auth/auditor.json',
              status: 'ready',
            },
          ],
        },
      ],
      runs: [],
    }),
  );
  return projectDir;
}

function createCaseFile() {
  const relative = '功能测试/工单.md';
  fs.mkdirSync(path.join(root, '用例管理', '功能测试'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '用例管理', relative),
    [
      '| 用例编号 | 用例标题 | 模块 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 用例状态 | 实际结果 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| TC-1 | 创建工单 | 坐席系统 / 工单 | P0 | 受理员登录 | 提交工单 | 创建成功 | 待验证 |  |',
      '| TC-2 | 审核工单 | 坐席系统 / 工单 | P0 | 审核员登录且已有工单 | 审核通过 | 审核成功 | 待验证 |  |',
    ].join('\n'),
  );
  return relative;
}

function source(casePath: string, caseId: string, title: string) {
  const content =
    caseId === 'case-1'
      ? {
          title: '创建工单',
          precondition: '受理员登录',
          steps: '提交工单',
          expected: '创建成功',
          fields: [],
        }
      : {
          title: '审核工单',
          precondition: '审核员登录且已有工单',
          steps: '审核通过',
          expected: '审核成功',
          fields: [],
        };
  return {
    casePath,
    caseId,
    caseNo: caseId === 'case-1' ? 'TC-1' : 'TC-2',
    title,
    fingerprint: caseContentFingerprint(content),
  };
}

function createAtomicFixtures(casePath: string, projectDir: string) {
  fs.mkdirSync(path.join(root, '提示词管理'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '提示词管理', '冒烟与回归流程编排.md'),
    '# 冒烟与回归流程编排\n\n多角色独立 Context，检查点按 test.step 回写。\n',
  );
  const sessionBase = uiautoCachePaths(root).dir;
  const cases = [
    {
      id: 'AUTO-CLERK',
      title: '受理员创建工单',
      roleId: 'clerk',
      caseId: 'case-1',
      sourceTitle: '创建工单',
      steps: [
        { action: 'goto', url: '/ticket' },
        {
          action: 'fill',
          locator: { kind: 'label', value: '客户姓名' },
          value: '张三',
        },
        {
          action: 'click',
          locator: { kind: 'role', role: 'button', name: '提交' },
          captureAs: 'ticketNo',
          captureSource: 'text',
        },
        { action: 'expect', locator: { kind: 'text', value: '创建成功' }, text: '创建成功' },
      ],
    },
    {
      id: 'AUTO-AUDITOR',
      title: '审核员审批工单',
      roleId: 'auditor',
      caseId: 'case-2',
      sourceTitle: '审核工单',
      steps: [
        { action: 'goto', url: '/ticket/audit' },
        {
          action: 'fill',
          locator: { kind: 'label', value: '工单编号' },
          valueFrom: 'ticketNo',
        },
        {
          action: 'click',
          locator: { kind: 'role', role: 'button', name: '通过' },
        },
        { action: 'expect', locator: { kind: 'text', value: '审核成功' }, text: '审核成功' },
      ],
    },
  ];
  for (const item of cases) {
    saveGeneratedSession(sessionBase, {
      projectId: 'ui-1',
      title: item.title,
      target: 'ts',
      baseURL: 'http://127.0.0.1:4321',
      source: item.sourceTitle,
      plan: item.steps,
      ir: {
        title: item.title,
        target: 'ts',
        baseURL: 'http://127.0.0.1:4321',
        storageState: '',
        source: item.sourceTitle,
        steps: item.steps,
      },
      automationCaseId: item.id,
      keepAlive: true,
      status: 'verified',
    });
  }
  upsertAutomationLinks(root, [
    {
      automationCaseId: 'AUTO-CLERK',
      title: '受理员创建工单',
      source: source(casePath, 'case-1', '创建工单'),
      caseKind: 'atomic',
      actorRoleId: 'clerk',
      requiredRoleIds: ['clerk'],
      projectId: 'ui-1',
      projectName: '坐席 UI',
      framework: 'playwright',
      iteration: 'v1.0',
      iterationFile: 'tests/iteration/v1.0.spec.ts',
      automationFilePath: '自动化测试/工单_自动化测试用例.md',
      status: 'connected',
      tag: '@lantern-auto-clerk',
    },
    {
      automationCaseId: 'AUTO-AUDITOR',
      title: '审核员审批工单',
      source: source(casePath, 'case-2', '审核工单'),
      caseKind: 'atomic',
      actorRoleId: 'auditor',
      requiredRoleIds: ['auditor'],
      projectId: 'ui-1',
      projectName: '坐席 UI',
      framework: 'playwright',
      iteration: 'v1.0',
      iterationFile: 'tests/iteration/v1.0.spec.ts',
      automationFilePath: '自动化测试/工单_自动化测试用例.md',
      status: 'connected',
      tag: '@lantern-auto-auditor',
    },
  ]);
  fs.mkdirSync(path.join(root, '用例管理', '自动化测试'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '用例管理', '自动化测试', '工单_自动化测试用例.md'),
    '| 自动化用例编号 |\n|---|\n| AUTO-CLERK |\n| AUTO-AUDITOR |\n',
  );
  fs.mkdirSync(path.join(projectDir, 'tests', 'iteration'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'tests', 'iteration', 'v1.0.spec.ts'),
    "import { test } from '@playwright/test';\ntest('已有用例', async () => {});\n",
  );
}

function createBusinessMap() {
  const file = businessMapFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      revision: 3,
      systems: [
        {
          id: 'sys-1',
          name: '坐席系统',
          description: '',
          directories: [],
          functions: [],
          flows: [],
          proposals: [],
          status: 'draft',
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-case-flow-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('冒烟 / 回归流程用例编排', () => {
  it('自动化与流程技能写清执行方式、角色、检查点和能力边界', () => {
    for (const value of [
      'executionMode',
      'manualReason',
      'flowRequired',
      'storageState',
      'scopeAction=keep',
    ]) {
      assert.match(CASE_AUTOMATION_PROMPT_TEMPLATE, new RegExp(value));
    }
    for (const value of [
      '独立 Browser Context',
      'storageState',
      'captureAs',
      'valueFrom',
      '缺少前序 `captureAs`',
      'not_reached',
      'revision',
    ]) {
      assert.match(CASE_AUTOMATION_FLOW_PROMPT_TEMPLATE, new RegExp(value));
    }
    for (const value of ['actorRoleId', 'storageState', 'test.step', 'flowData']) {
      assert.match(UI_AUTO_PROMPT_TEMPLATE, new RegExp(value));
    }
  });

  it('预览不写文件；确认后生成多 Context 脚本、检查点并补齐业务地图', async () => {
    const projectDir = createProject();
    const casePath = createCaseFile();
    createAtomicFixtures(casePath, projectDir);
    createBusinessMap();
    const payload = {
      casePath,
      projectId: 'ui-1',
      iteration: 'v1.0',
      automationCaseIds: ['AUTO-CLERK', 'AUTO-AUDITOR'],
      title: '工单受理审核冒烟',
      kind: 'smoke' as const,
      businessSystemId: 'sys-1',
      autoSupplementBusinessMap: true,
      expectedBusinessMapRevision: 3,
    };

    const preview = await previewAutomationFlow(root, payload);
    assert.equal(preview.checkpoints.length, 2);
    assert.equal(preview.mapPatch?.createdDirectories?.length, 1);
    assert.deepEqual(
      preview.mapPatch?.createdDirectories?.map((item: { name: string }) => item.name),
      ['工单'],
    );
    assert.equal(preview.mapPatch?.addedFunctions?.length, 2);
    assert.deepEqual(preview.mapPatch?.addedStepTitles, ['受理员创建工单', '审核员审批工单']);
    assert.equal(fs.existsSync(path.join(projectDir, 'tests', 'iteration', 'v1.0.spec.ts')), true);
    assert.doesNotMatch(
      fs.readFileSync(path.join(projectDir, 'tests', 'iteration', 'v1.0.spec.ts'), 'utf8'),
      /工单受理审核冒烟/,
    );
    assert.equal(JSON.parse(fs.readFileSync(businessMapFilePath(root), 'utf8')).revision, 3);

    const result = await createAutomationFlow(root, payload);
    const spec = fs.readFileSync(
      path.join(projectDir, 'tests', 'iteration', 'v1.0.spec.ts'),
      'utf8',
    );
    assert.match(spec, /已有用例/);
    assert.match(spec, /工单受理审核冒烟/);
    assert.match(
      spec,
      /browser\.newContext\(\{ storageState, baseURL: "http:\/\/127\.0\.0\.1:4321" \}\)/,
    );
    assert.match(spec, /test\.step\("受理员创建工单"/);
    assert.match(spec, /flowData\["ticketNo"\]/);
    assert.match(spec, /roleFor\("auditor"\)/);
    assert.equal(result.flow.checkpoints.length, 2);
    assert.equal(result.flow.requiredRoles.length, 2);
    const map = JSON.parse(fs.readFileSync(businessMapFilePath(root), 'utf8'));
    assert.equal(map.revision, 4);
    assert.equal(map.systems[0].functions.length, 2);
    assert.equal(map.systems[0].flows[0].steps.length, 2);
    assert.equal(map.systems[0].flows[0].steps[0].system, '坐席系统');
    assert.equal(readFlowStore(root).items.length, 1);
    const flowTable = await readTable(
      path.join(root, '用例管理', result.draft.automationFile || ''),
      path.extname(result.draft.automationFile || ''),
    );
    const flowRow = flowTable.rows.find(
      (row) => (row as Record<string, string>)['流程用例编号'] === result.flow.flowCaseId,
    ) as Record<string, string> | undefined;
    assert.equal(flowRow?.['用例类型'], '流程');
    assert.equal(flowRow?.['来源自动化用例'], 'AUTO-CLERK、AUTO-AUDITOR');
    assert.match(flowRow?.['检查点'] || '', /受理员创建工单/);
    let allLinks = readAutomationLinks(root).items;
    const flowLink = allLinks.find(
      (item: { automationCaseId?: string }) => item.automationCaseId === result.flow.flowCaseId,
    );
    assert.ok(flowLink);
    assert.equal(
      allLinks
        .filter((item: { automationCaseId?: string }) =>
          ['AUTO-CLERK', 'AUTO-AUDITOR', result.flow.flowCaseId].includes(
            item.automationCaseId || '',
          ),
        )
        .every(
          (item: { automationFileHash?: string }) =>
            item.automationFileHash === flowLink.automationFileHash,
        ),
      true,
    );
    assert.equal(
      await updateAutomationRow(root, flowLink, {
        运行状态: '已通过',
        实际结果: '流程通过',
        报告地址: '/reports/flow',
      }),
      true,
    );
    const updatedFlowTable = await readTable(
      path.join(root, '用例管理', result.draft.automationFile || ''),
      path.extname(result.draft.automationFile || ''),
    );
    const updatedFlowRow = updatedFlowTable.rows.find(
      (row) => (row as Record<string, string>)['流程用例编号'] === result.flow.flowCaseId,
    ) as Record<string, string> | undefined;
    assert.equal(updatedFlowRow?.['运行状态'], '已通过');
    assert.equal(updatedFlowRow?.['报告地址'], '/reports/flow');
    allLinks = readAutomationLinks(root).items;
    const updatedFlowLink = allLinks.find(
      (item: { automationCaseId?: string }) => item.automationCaseId === result.flow.flowCaseId,
    );
    assert.equal(
      allLinks
        .filter((item: { automationCaseId?: string }) =>
          ['AUTO-CLERK', 'AUTO-AUDITOR', result.flow.flowCaseId].includes(
            item.automationCaseId || '',
          ),
        )
        .every(
          (item: { automationFileHash?: string }) =>
            item.automationFileHash === updatedFlowLink?.automationFileHash,
        ),
      true,
    );
  });

  it('同一迭代的多条流程配置隔离，重新生成使用新的登录态', async () => {
    const spec = (id: string, state: string) =>
      renderTsFlowSpec({
        title: id,
        automationCaseId: id,
        roleStorageStates: { clerk: state },
        steps: [{ action: 'goto', url: 'https://example.org', actorRoleId: 'clerk' }],
      });
    // 模拟旧版已生成文件：角色常量在测试块外。
    const modern = spec('FLOW-A', 'old.json');
    const declaration = /\s*const ROLE_STATES: Record<string, string> = \{[\s\S]*?\};/.exec(
      modern,
    )![0];
    const legacy = declaration + '\n' + modern.replace(declaration, '');
    const first = mergeAutomationSpecBlock(legacy, spec('FLOW-B', 'other.json'))!;
    const updated = mergeAutomationSpecBlock(first.content, spec('FLOW-A', 'new.json'))!;
    const contexts: string[] = [];
    const jobs: Promise<void>[] = [];
    const browser = {
      newContext: async ({ storageState }: { storageState: string }) => {
        contexts.push(storageState);
        return { newPage: async () => ({ goto: async () => {} }), close: async () => {} };
      },
    };
    const test = Object.assign(
      (
        _title: string,
        _options: unknown,
        callback: (
          fixtures: { browser: typeof browser },
          info: { annotations: { type: string; description: string }[] },
        ) => Promise<void>,
      ) => {
        jobs.push(callback({ browser }, { annotations: [] }));
      },
      { describe: (_title: string, callback: () => void) => callback(), use: () => {} },
    );
    const output = ts.transpileModule(updated.content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(output, { exports: {}, require: () => ({ test }) });
    await Promise.all(jobs);
    assert.deepEqual(contexts.sort(), ['new.json', 'other.json']);
  });

  it('标题互相包含的检查点精确回写，不把失败标成通过', () => {
    const next = applyFlowRunResult(
      root,
      { automationCaseId: 'FLOW-1', flowCaseId: 'FLOW-1' },
      {
        flowCaseId: 'FLOW-1',
        checkpoints: [
          { id: 'cp-1', title: '复核审核' },
          { id: 'cp-2', title: '审核' },
          { id: 'cp-3', title: '归档' },
        ],
      },
      {
        steps: [
          { title: '流程 › 复核审核', status: 'passed' },
          { title: '流程 › 审核', status: 'error', error: 'assertion failed' },
        ],
      },
      { id: 'run-1' },
      'failed',
      ['assertion failed'],
    );
    assert.deepEqual(
      next.checkpointResults.map((item: { status: string }) => item.status),
      ['passed', 'failed', 'not_reached'],
    );
    assert.match(next.failureSummary, /失败检查点：审核/);
  });

  for (const change of ['modify', 'delete'] as const) {
    it(`非首条来源用例 ${change} 后流程过期，恢复后可重新运行`, async () => {
      const projectDir = createProject();
      const casePath = createCaseFile();
      createAtomicFixtures(casePath, projectDir);
      const { flow } = await createAutomationFlow(root, {
        casePath,
        projectId: 'ui-1',
        iteration: 'v1.0',
        automationCaseIds: ['AUTO-CLERK', 'AUTO-AUDITOR'],
        kind: 'smoke',
      });
      const original = await loadCaseDocument(root, casePath);
      assert.notEqual(refreshAutomationLinks(root, original)[flow.flowCaseId].status, 'stale');
      const changed = { ...original, cases: original.cases.map((item) => ({ ...item })) };
      if (change === 'delete') changed.cases.splice(1, 1);
      else changed.cases[1]!.expected = '新的审核结果';
      const refreshed = refreshAutomationLinks(root, changed);
      assert.equal(refreshed[flow.flowCaseId].status, 'stale');
      assert.match(refreshed[flow.flowCaseId].staleReason, /来源功能用例/);
      assert.equal(refreshAutomationLinks(root, original)[flow.flowCaseId].status, 'connected');
    });
  }

  it('同名功能按目录匹配，同一功能的两个检查点不会被去重', () => {
    createBusinessMap();
    const file = businessMapFilePath(root);
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    map.systems[0].directories = [
      {
        id: 'dir-a',
        parentId: '',
        name: 'A',
        order: 0,
        menuPath: ['A'],
      },
      {
        id: 'dir-b',
        parentId: '',
        name: 'B',
        order: 1,
        menuPath: ['B'],
      },
    ];
    map.systems[0].functions = [
      {
        id: 'fn-a',
        name: '查询',
        directoryId: 'dir-a',
      },
      {
        id: 'fn-b',
        name: '查询',
        directoryId: 'dir-b',
      },
    ];
    fs.writeFileSync(file, JSON.stringify(map));

    const result = supplementAutomationFlow(root, {
      expectedRevision: 3,
      systemId: 'sys-1',
      flowName: '同名功能流程',
      checkpoints: [
        {
          id: 'cp-a-1',
          title: 'A 查询第一条',
          functionName: '查询',
          directoryPath: ['坐席系统', 'A'],
          role: '受理员',
        },
        {
          id: 'cp-a-2',
          title: 'A 查询第二条',
          functionName: '查询',
          directoryPath: ['坐席系统', 'A'],
          role: '受理员',
        },
        {
          id: 'cp-a-3',
          title: 'A 查询第一条',
          functionName: '查询',
          directoryPath: ['坐席系统', 'A'],
          role: '审核员',
        },
      ],
    });

    assert.deepEqual(result.addedFunctionIds, []);
    assert.equal(result.flow.steps.length, 3);
    assert.ok(
      result.flow.steps.every((step: { functionId?: string }) => step.functionId === 'fn-a'),
    );
    assert.deepEqual(result.createdDirectories, []);
  });

  it('流程写入中途失败时回滚脚本、流程、关联和业务地图', async () => {
    const projectDir = createProject();
    const casePath = createCaseFile();
    createAtomicFixtures(casePath, projectDir);
    createBusinessMap();
    const original = path.join(root, '用例管理', '自动化测试', '工单_自动化测试用例.md');
    const broken = path.join(root, '用例管理', '自动化测试', '工单_自动化测试用例.bin');
    fs.renameSync(original, broken);
    fs.writeFileSync(broken, Buffer.from([0, 1, 2, 3, 4, 5]));
    upsertAutomationLinks(
      root,
      readAutomationLinks(root).items.map((item: Record<string, unknown>) => ({
        ...item,
        automationFilePath: '自动化测试/工单_自动化测试用例.bin',
      })),
    );
    const beforeSpec = fs.readFileSync(
      path.join(projectDir, 'tests', 'iteration', 'v1.0.spec.ts'),
      'utf8',
    );

    await assert.rejects(() =>
      createAutomationFlow(root, {
        casePath,
        projectId: 'ui-1',
        iteration: 'v1.0',
        automationCaseIds: ['AUTO-CLERK', 'AUTO-AUDITOR'],
        title: '应回滚的流程',
        kind: 'regression',
        businessSystemId: 'sys-1',
        autoSupplementBusinessMap: true,
        expectedBusinessMapRevision: 3,
      }),
    );

    assert.equal(
      fs.readFileSync(path.join(projectDir, 'tests', 'iteration', 'v1.0.spec.ts'), 'utf8'),
      beforeSpec,
    );
    assert.equal(JSON.parse(fs.readFileSync(businessMapFilePath(root), 'utf8')).revision, 3);
    assert.equal(readFlowStore(root).items.length, 0);
    assert.equal(readAutomationLinks(root).items.length, 2);
  });

  it('流程顺序缺少上游捕获值时阻止生成', async () => {
    const projectDir = createProject();
    const casePath = createCaseFile();
    createAtomicFixtures(casePath, projectDir);
    await assert.rejects(
      () =>
        previewAutomationFlow(root, {
          casePath,
          projectId: 'ui-1',
          iteration: 'v1.0',
          automationCaseIds: ['AUTO-AUDITOR', 'AUTO-CLERK'],
          title: '反向流程',
          kind: 'regression',
          autoSupplementBusinessMap: false,
        }),
      /没有提供该捕获值/,
    );
  });

  it('运行结果按检查点回写，后续未执行检查点不会被误报通过', () => {
    const projectDir = createProject();
    const casePath = createCaseFile();
    createAtomicFixtures(casePath, projectDir);
    const now = new Date().toISOString();
    const flow = {
      flowCaseId: 'FLOW-1',
      automationCaseId: 'FLOW-1',
      title: '工单流程',
      kind: 'smoke',
      status: 'connected',
      businessSystemId: '',
      businessFlowId: '',
      sourceAutomationCaseIds: ['AUTO-CLERK', 'AUTO-AUDITOR'],
      sourceFunctionalCaseIds: ['case-1', 'case-2'],
      requiredRoles: [],
      checkpoints: [
        {
          id: 'cp-1',
          title: '受理员创建工单',
          actorRoleId: 'clerk',
          automationCaseId: 'AUTO-CLERK',
          expected: '创建成功',
        },
        {
          id: 'cp-2',
          title: '审核员审批工单',
          actorRoleId: 'auditor',
          automationCaseId: 'AUTO-AUDITOR',
          expected: '审核成功',
        },
      ],
      pathConditions: [],
      sharedDataKeys: ['ticketNo'],
      cleanup: [],
      gateEligible: true,
      projectId: 'ui-1',
      projectName: '坐席 UI',
      iteration: 'v1.0',
      iterationFile: 'tests/iteration/v1.0.spec.ts',
      uiSessionId: '',
      createdAt: now,
      updatedAt: now,
    };
    const link = {
      automationCaseId: 'FLOW-1',
      flowCaseId: 'FLOW-1',
      caseKind: 'flow',
      title: '工单流程',
      status: 'running',
      projectId: 'ui-1',
      iterationFile: 'tests/iteration/v1.0.spec.ts',
      scriptPath: 'tests/iteration/v1.0.spec.ts',
      tag: '@lantern-flow-1',
    };
    const next = applyFlowRunResult(
      root,
      link,
      flow,
      {
        steps: [
          {
            title: '工单流程 › 受理员创建工单',
            status: 'passed',
            durationMs: 30,
            error: '',
          },
          {
            title: '工单流程 › 审核员审批工单',
            status: 'error',
            durationMs: 50,
            error: 'locator("审批按钮") not found',
          },
        ],
      },
      { id: 'run-1', reportUrl: '/report' },
      'failed',
      ['locator("审批按钮") not found'],
    );
    assert.equal(next.checkpointResults[0]?.status, 'passed');
    assert.equal(next.checkpointResults[1]?.status, 'failed');
    assert.equal(next.failureCategory, 'locator');
    assert.match(next.failureSummary, /审核员审批工单/);
    assert.equal(readFlowStore(root).items[0]?.checkpointResults[1]?.status, 'failed');
  });

  it('流程依赖的业务地图 revision 变化后标记 stale', () => {
    const projectDir = createProject();
    const casePath = createCaseFile();
    createAtomicFixtures(casePath, projectDir);
    createBusinessMap();
    const document = {
      path: casePath,
      cases: [
        {
          id: 'case-1',
          title: '创建工单',
          precondition: '',
          steps: '提交工单',
          expected: '创建成功',
          fields: [],
        },
        {
          id: 'case-2',
          title: '审核工单',
          precondition: '',
          steps: '审核通过',
          expected: '审核成功',
          fields: [],
        },
      ],
    };
    upsertAutomationLinks(root, [
      {
        automationCaseId: 'FLOW-1',
        flowCaseId: 'FLOW-1',
        caseKind: 'flow',
        title: '流程',
        source: {
          ...source(casePath, 'case-1', '创建工单'),
          fingerprint: caseContentFingerprint(document.cases[0]!),
        },
        status: 'connected',
        projectId: 'ui-1',
        iterationFile: 'tests/iteration/v1.0.spec.ts',
        scriptPath: 'tests/iteration/v1.0.spec.ts',
        tag: '@lantern-flow-1',
        requiredRoleIds: ['clerk'],
        businessSystemId: 'sys-1',
        businessFlowId: 'flow-1',
        dependencyHash: 'old-hash',
      },
    ]);
    const refreshed = refreshAutomationLinks(root, document) as Record<
      string,
      Record<string, string>
    >;
    assert.equal(refreshed['FLOW-1']?.status, 'stale');
    assert.match(refreshed['FLOW-1']?.staleReason || '', /业务地图/);
  });

  it('缺角色登录态或业务地图 revision 过期时不写流程、脚本或地图', async () => {
    const projectDir = createProject();
    const casePath = createCaseFile();
    createAtomicFixtures(casePath, projectDir);
    createBusinessMap();
    const payload = {
      casePath,
      projectId: 'ui-1',
      iteration: 'v1.0',
      automationCaseIds: ['AUTO-CLERK', 'AUTO-AUDITOR'],
      title: '工单受理审核回归',
      kind: 'regression' as const,
      businessSystemId: 'sys-1',
      autoSupplementBusinessMap: true,
      expectedBusinessMapRevision: 3,
    };
    const before = fs.readFileSync(
      path.join(projectDir, 'tests', 'iteration', 'v1.0.spec.ts'),
      'utf8',
    );

    await assert.rejects(
      () =>
        previewAutomationFlow(root, {
          ...payload,
          expectedBusinessMapRevision: 2,
        }),
      /业务地图已被其他页面修改/,
    );
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'tests', 'iteration', 'v1.0.spec.ts'), 'utf8'),
      before,
    );
    assert.equal(JSON.parse(fs.readFileSync(businessMapFilePath(root), 'utf8')).revision, 3);

    const store = JSON.parse(fs.readFileSync(uiautoStorePaths(root).projectsFile, 'utf8'));
    store.projects[0].roles.find((role: { id: string }) => role.id === 'auditor').storageState = '';
    fs.writeFileSync(uiautoStorePaths(root).projectsFile, JSON.stringify(store));
    await assert.rejects(
      () =>
        previewAutomationFlow(root, {
          ...payload,
          autoSupplementBusinessMap: false,
        }),
      /storageState.*审核员|审核员.*storageState/,
    );
    store.projects[0].roles.find((role: { id: string }) => role.id === 'auditor').storageState =
      'auth/auditor.json';
    store.projects[0].roles.find((role: { id: string }) => role.id === 'auditor').status =
      'invalid';
    fs.writeFileSync(uiautoStorePaths(root).projectsFile, JSON.stringify(store));
    await assert.rejects(
      () =>
        previewAutomationFlow(root, {
          ...payload,
          autoSupplementBusinessMap: false,
        }),
      /登录态已失效/,
    );
  });

  it('流程通过只回写流程，不把来源功能用例批量标为通过', async () => {
    const projectDir = createProject();
    const casePath = createCaseFile();
    createAtomicFixtures(casePath, projectDir);
    upsertAutomationLinks(root, [
      {
        automationCaseId: 'FLOW-PASSED',
        flowCaseId: 'FLOW-PASSED',
        caseKind: 'flow',
        title: '流程通过',
        source: source(casePath, 'case-1', '创建工单'),
        status: 'passed',
        projectId: 'ui-1',
        iterationFile: 'tests/iteration/v1.0.spec.ts',
        scriptPath: 'tests/iteration/v1.0.spec.ts',
        tag: '@lantern-flow-passed',
        requiredRoleIds: ['clerk'],
      },
    ]);
    await syncPassedSources(root, [casePath]);
    const document = await loadCaseDocument(root, casePath);
    assert.equal(document.cases[0]?.status, '待验证');
    assert.equal(document.cases[1]?.status, '待验证');
  });

  it('流程编排读取运行中的技能，技能变化后流程标记过期', async () => {
    const projectDir = createProject();
    const casePath = createCaseFile();
    createAtomicFixtures(casePath, projectDir);
    const currentDocument = await loadCaseDocument(root, casePath);
    upsertAutomationLinks(
      root,
      readAutomationLinks(root).items.map((item: Record<string, any>) => {
        const currentCase = currentDocument.cases.find(
          (caseItem: { id: string; no: string }) =>
            caseItem.id === item.source?.caseId ||
            (item.source?.caseNo && caseItem.no === item.source.caseNo),
        );
        return currentCase
          ? {
              ...item,
              source: {
                ...item.source,
                caseId: currentCase.id,
                fingerprint: caseContentFingerprint(currentCase),
              },
            }
          : item;
      }),
    );
    const result = await createAutomationFlow(root, {
      casePath,
      projectId: 'ui-1',
      iteration: 'v1.0',
      automationCaseIds: ['AUTO-CLERK', 'AUTO-AUDITOR'],
      title: '技能依赖流程',
      kind: 'regression',
    });
    const document = currentDocument;
    let refreshed = refreshAutomationLinks(root, document) as Record<
      string,
      Record<string, string>
    >;
    assert.equal(
      refreshed[result.flow.flowCaseId]?.status,
      'connected',
      JSON.stringify(refreshed[result.flow.flowCaseId]),
    );
    fs.writeFileSync(
      path.join(root, '提示词管理', '冒烟与回归流程编排.md'),
      '# 冒烟与回归流程编排\n\n技能规则已更新。\n',
    );
    refreshed = refreshAutomationLinks(root, document) as Record<string, Record<string, string>>;
    assert.equal(refreshed[result.flow.flowCaseId]?.status, 'stale');
    assert.match(refreshed[result.flow.flowCaseId]?.staleReason || '', /关键依赖/);
  });

  it('相对地址流程缺少项目 baseURL 时在写入前阻断', async () => {
    const projectDir = createProject();
    const casePath = createCaseFile();
    createAtomicFixtures(casePath, projectDir);
    const store = JSON.parse(fs.readFileSync(uiautoStorePaths(root).projectsFile, 'utf8'));
    store.projects[0].baseURL = '';
    fs.writeFileSync(uiautoStorePaths(root).projectsFile, JSON.stringify(store));
    await assert.rejects(
      () =>
        previewAutomationFlow(root, {
          casePath,
          projectId: 'ui-1',
          iteration: 'v1.0',
          automationCaseIds: ['AUTO-CLERK', 'AUTO-AUDITOR'],
          title: '缺项目地址',
          kind: 'smoke',
        }),
      /配置 baseURL/,
    );
  });
});
