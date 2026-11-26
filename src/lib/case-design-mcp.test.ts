import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import connect from 'connect';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createLanternMcpServer } from '../../cli/mcp-server.mjs';
import { lhFsPlugin } from '../../builtin/session/lh-fs.mjs';
import { setActiveRoot, __resetSpaceContext } from '../../builtin/session/space-context.mjs';
import { spaceConfigFile, spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import { lhCaseExecutionPlugin } from '../../lh-plugins/lh-case-execution.mjs';
import { lhCaseDesignPlugin } from '../../lh-plugins/lh-case-design.mjs';
import { lhCaseBlindspotPlugin, lhCaseReviewPlugin } from '../../lh-plugins/lh-case-review.mjs';
import { ensurePluginPrompt } from '../../lh-plugins/plugin-prompts.mjs';
import { reqAnalysisStorePath, reqDocsDir } from '../../lh-plugins/lh-req-analysis.mjs';

test('真实 HTTP 与 MCP 生成、校验、入库、审查和计划共用资产', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-design-mcp-'));
  const app = connect();
  let server: http.Server | undefined;
  const client = new Client(
    { name: 'workflow-test', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  );
  let elicitDecision: 'accept' | 'decline' | 'cancel' = 'accept';
  let scopeDecision: 'accept' | 'decline' | 'cancel' = 'accept';
  const elicitationRequests: Array<Record<string, any>> = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    elicitationRequests.push(request.params as Record<string, any>);
    if (elicitDecision !== 'accept') return { action: elicitDecision };
    if (!('requestedSchema' in request.params)) return { action: 'decline' };
    const properties = request.params.requestedSchema.properties as Record<string, any>;
    if ('story_ids' in properties) {
      if (scopeDecision !== 'accept') return { action: scopeDecision };
      return {
        action: 'accept',
        content: {
          story_ids: properties.story_ids?.default || [],
          test_point_ids: properties.test_point_ids?.default || [],
        },
      };
    }
    return {
      action: 'accept',
      content: {
        case_type: 'api',
        requirement: 'analysis::ra_mcp',
        template: 'auto',
        xmind: 'auto',
        output_format: 'csv',
        business_systems: properties.business_systems?.default || [],
      },
    };
  });
  let mcp: ReturnType<typeof createLanternMcpServer> | undefined;
  const put = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as Record<string, any>;
  };
  try {
    __resetSpaceContext();
    setActiveRoot(root);
    put(spaceConfigFile(root, 'app.defaults.json'), {
      version: 1,
      plugins: {},
      model: { activeId: '', providers: [] },
    });
    put(spaceLocalFile(root, 'app.config.json'), {
      version: 1,
      plugins: {
        cases: true,
        caseGen: true,
        caseExecution: true,
        caseReview: true,
        reqAnalysis: true,
        reqBreakdowns: true,
        businessMap: true,
      },
    });
    fs.mkdirSync(reqDocsDir(root), { recursive: true });
    fs.writeFileSync(path.join(reqDocsDir(root), '需求.md'), '创建工单');
    fs.writeFileSync(path.join(reqDocsDir(root), '独立需求.md'), '独立需求正文');
    put(reqAnalysisStorePath(root), {
      version: 1,
      docs: [
        {
          id: 'ra_mcp',
          title: '创建工单',
          sourcePath: '需求.md',
          outline: [{ id: 'RO-1', title: '创建' }],
          stories: [
            { id: 'US-001', title: '创建', sourceRefs: ['RO-1'] },
            { id: 'US-002', title: '查询', sourceRefs: ['RO-1'] },
          ],
          testPoints: {
            points: [
              { id: 'TP-001', storyId: 'US-001', title: '创建' },
              { id: 'TP-002', storyId: 'US-002', title: '查询' },
            ],
          },
        },
      ],
    });
    ensurePluginPrompt('功能测试用例提示词.md', '# 编写用例', root);
    ensurePluginPrompt('接口测试用例提示词.md', '# 编写接口用例', root);
    ensurePluginPrompt('性能测试用例提示词.md', '# 编写性能用例', root);
    ensurePluginPrompt('用例质量评审提示词.md', '# 审查用例', root);
    fs.mkdirSync(path.join(root, '测试模板库', '接口测试用例'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '测试模板库', '接口测试用例', '接口测试用例模板.csv'),
      [
        '用例编号,需求编号,接口名称,请求方法,请求地址,请求参数,前置条件,测试步骤,预期结果,优先级,引用需求点,备注',
        '1,US-001,创建工单,POST,/api/tickets,{"title":"x"},已登录,提交请求,返回 201,RO-1；TP-001,待确认规则',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(root, '业务地图'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '业务地图', '业务地图.json'),
      JSON.stringify({
        version: 3,
        revision: 1,
        systems: [
          {
            id: 'sys_ticket',
            name: '创建工单',
            description: '创建并保存工单',
            directories: [],
            functions: [],
            flows: [],
          },
        ],
      }),
    );
    for (const plugin of [
      lhFsPlugin(),
      lhCaseDesignPlugin(),
      lhCaseExecutionPlugin(),
      lhCaseReviewPlugin(),
      lhCaseBlindspotPlugin(),
    ])
      plugin.configureServer({ middlewares: app } as never);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    mcp = createLanternMcpServer({ apiBase, version: 'test' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), mcp.connect(b)]);
    const tools = await client.listTools();
    for (const name of [
      'lantern_case_generation_setup',
      'lantern_case_generation_save',
      'lantern_case_blindspot_save',
      'lantern_uiauto_projects',
      'lantern_uiauto_project_update',
      'lantern_uiauto_project_scaffold_preview',
      'lantern_uiauto_project_scaffold_create',
      'lantern_case_automation_cases',
      'lantern_case_automation_iterations',
      'lantern_case_automation_assess',
      'lantern_case_automation_apply',
      'lantern_case_automation_run',
      'lantern_uiauto_agent_open',
      'lantern_uiauto_agent_wait',
      'lantern_uiauto_agent_emit',
      'lantern_uiauto_agent_write',
      'lantern_case_execution_plan_start',
    ])
      assert.ok(
        tools.tools.some((tool) => tool.name === name),
        `缺少 MCP 工具 ${name}`,
      );
    const context = await call('lantern_case_generation_context', { analysisId: 'ra_mcp' });
    assert.equal(context.caseType.id, 'functional');
    assert.equal(context.businessContexts[0].systemId, 'sys_ticket');
    const missingBreakdown = await client.callTool({
      name: 'lantern_case_generation_context',
      arguments: { analysisId: 'ra_mcp', requirementBreakdownId: 'missing-xmind' },
    });
    assert.equal(missingBreakdown.isError, true);
    assert.match(JSON.stringify(missingBreakdown.content), /所选需求拆解 XMind 不存在/);
    const chatSetup = await call('lantern_case_generation_setup', {
      prompt: '根据创建工单需求生成接口测试用例',
      caseType: 'api',
    });
    assert.equal(chatSetup.action, 'chat');
    assert.equal(chatSetup.recommended.caseType, 'api');
    assert.equal(chatSetup.recommended.storySelection, 'all');
    assert.equal(chatSetup.available.analyses[0].id, 'ra_mcp');
    assert.ok(
      chatSetup.available.caseTypes.some(
        (item: any) => item.id === 'api' && item.label === '接口测试',
      ),
    );
    assert.deepEqual(chatSetup.available.outputFormats, [
      { id: 'xlsx', label: 'Excel' },
      { id: 'csv', label: 'CSV' },
      { id: 'md', label: 'Markdown' },
    ]);
    assert.ok(
      chatSetup.available.templates.some(
        (item: any) => item.id === '接口测试用例/接口测试用例模板.csv',
      ),
    );
    const scopedChatSetup = await call('lantern_case_generation_setup', {
      analysisId: 'ra_mcp',
      storyIds: ['US-001'],
      testPointIds: ['TP-001'],
    });
    assert.deepEqual(scopedChatSetup.recommended.storyIds, ['US-001']);
    assert.deepEqual(scopedChatSetup.recommended.testPointIds, ['TP-001']);
    assert.equal(scopedChatSetup.recommended.storySelection, 'selected');
    assert.equal(scopedChatSetup.recommended.testPointSelection, 'selected');
    const scopedChatContext = await call(
      'lantern_case_generation_context',
      scopedChatSetup.recommended,
    );
    assert.deepEqual(
      scopedChatContext.analysis.stories.map((story: any) => story.id),
      ['US-001'],
    );
    assert.deepEqual(
      scopedChatContext.analysis.testPoints.points.map((point: any) => point.id),
      ['TP-001'],
    );
    const sourceSetup = await call('lantern_case_generation_setup', {
      sourcePath: '独立需求.md',
    });
    assert.equal(sourceSetup.recommended.analysisId, '');
    assert.equal(sourceSetup.recommended.sourcePath, '独立需求.md');
    assert.equal(sourceSetup.selectedAnalysis, null);
    const sourceContext = await call('lantern_case_generation_context', sourceSetup.recommended);
    assert.equal(sourceContext.analysis, null);
    assert.equal(sourceContext.sourcePath, '独立需求.md');
    assert.equal(sourceContext.source.content, '独立需求正文');
    const explicitAnalysisSetup = await call('lantern_case_generation_setup', {
      analysisId: 'ra_mcp',
    });
    assert.equal(explicitAnalysisSetup.recommended.analysisId, 'ra_mcp');
    const setup = await call('lantern_case_generation_setup', {
      prompt: '根据创建工单需求生成接口测试用例',
      storyIds: ['US-001'],
      testPointIds: ['TP-001'],
      presentation: 'form',
    });
    assert.equal(setup.action, 'accept');
    assert.equal(setup.config.caseType, 'api');
    assert.equal(setup.config.analysisId, 'ra_mcp');
    assert.deepEqual(setup.config.storyIds, ['US-001']);
    assert.deepEqual(setup.config.testPointIds, ['TP-001']);
    assert.equal(setup.config.storySelection, 'selected');
    assert.equal(setup.config.testPointSelection, 'selected');
    assert.equal(setup.config.businessSystemMode, 'manual');
    assert.equal(setup.config.requirementBreakdownMode, 'auto');
    assert.equal(setup.config.outputFormat, 'csv');
    assert.deepEqual(setup.config.businessSystemIds, ['sys_ticket']);
    const selectedContext = await call('lantern_case_generation_context', {
      ...setup.config,
      headers: undefined,
    });
    assert.deepEqual(
      selectedContext.analysis.stories.map((story: Record<string, unknown>) => story.id),
      ['US-001'],
    );
    assert.deepEqual(
      selectedContext.analysis.testPoints.points.map((point: Record<string, unknown>) => point.id),
      ['TP-001'],
    );
    const noBusinessContext = await call('lantern_case_generation_context', {
      ...setup.config,
      businessSystemMode: 'manual',
      businessSystemIds: [],
    });
    assert.deepEqual(noBusinessContext.businessContexts, []);
    assert.equal(elicitationRequests.length, 2);
    // Inspect the schema after the actual SDK transport has parsed it.
    const requirementField = elicitationRequests[0]!.requestedSchema.properties.requirement;
    assert.deepEqual(requirementField.oneOf, [
      { const: 'analysis::ra_mcp', title: '需求分析 · 创建工单（2 故事 / 2 测试点）' },
      { const: 'source::独立需求.md', title: '需求文档 · 独立需求.md' },
    ]);
    assert.equal(requirementField.default, 'analysis::ra_mcp');
    elicitDecision = 'decline';
    const cancelled = await call('lantern_case_generation_setup', {
      prompt: '根据创建工单需求生成测试用例',
      presentation: 'form',
    });
    assert.equal(cancelled.action, 'decline');
    assert.equal(cancelled.requiresConfirmation, true);
    assert.match(cancelled.message, /无法区分人工拒绝与客户端自动拒绝/);
    assert.ok(cancelled.available.analyses.length);
    assert.equal(cancelled.config, undefined);
    assert.ok(cancelled.configurationUrl.includes('/cases/configure/#'));
    assert.ok(cancelled.setupId);
    elicitDecision = 'cancel';
    const dismissed = await call('lantern_case_generation_setup', { presentation: 'form' });
    assert.equal(dismissed.action, 'cancel');
    assert.equal(dismissed.requiresConfirmation, true);
    elicitDecision = 'accept';
    scopeDecision = 'decline';
    const scopeDeclined = await call('lantern_case_generation_setup', { presentation: 'form' });
    assert.equal(scopeDeclined.action, 'decline');
    assert.match(scopeDeclined.message, /用户故事或测试点范围未确认/);
    assert.equal(scopeDeclined.config, undefined);
    scopeDecision = 'accept';
    const browser = await call('lantern_case_generation_setup', {
      presentation: 'browser',
      analysisId: 'ra_mcp',
    });
    assert.equal(browser.action, 'browser');
    assert.equal(browser.config, undefined);
    const confirmResponse = await fetch(
      `${apiBase}/__tb_case_design/setup-window/${browser.setupId}/confirm`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseType: 'functional',
          outputFormat: 'xlsx',
          reqSource: { kind: 'stories', docId: 'ra_mcp', storyIds: ['US-001'] },
          testPointIds: ['TP-001'],
          baseline: { revision: context.revision, sourceFileHash: context.sourceFileHash },
        }),
      },
    );
    assert.equal(confirmResponse.status, 200, await confirmResponse.text());
    const confirmedBrowser = await call('lantern_case_generation_setup', {
      setupId: browser.setupId,
    });
    assert.equal(confirmedBrowser.action, 'accept');
    assert.equal(confirmedBrowser.config.analysisId, 'ra_mcp');
    assert.equal(confirmedBrowser.config.sourcePath, undefined);
    assert.deepEqual(confirmedBrowser.config.storyIds, ['US-001']);
    assert.deepEqual(confirmedBrowser.config.testPointIds, ['TP-001']);
    const payload = {
      analysisId: 'ra_mcp',
      expectedRevision: context.revision,
      expectedSourceFileHash: context.sourceFileHash,
      title: 'MCP用例',
      format: 'csv',
      folder: '功能测试',
      rows: [
        {
          用例编号: '1',
          需求编号: 'US-001',
          用例标题: '创建工单',
          测试步骤: '填写并创建',
          预期结果: '创建成功',
          引用需求点: 'RO-1；TP-001；TP-002',
        },
      ],
    };
    const checked = await call('lantern_case_generation_validate', payload);
    assert.equal(checked.ok, true);
    assert.equal(checked.coverage.TP.rate, 100);
    const saved = await call('lantern_case_generation_save', payload);
    assert.equal(saved.executable, true);
    assert.match(saved.path, /^功能测试\//);
    const apiContext = await call('lantern_case_generation_context', {
      analysisId: 'ra_mcp',
      caseType: 'api',
    });
    assert.equal(apiContext.caseType.id, 'api');
    assert.equal(apiContext.caseType.casesFolder, '接口测试');
    assert.match(apiContext.skill, /接口用例/);
    assert.equal(apiContext.template.id, '接口测试用例/接口测试用例模板.csv');
    const apiHeaders = apiContext.headers as string[];
    assert.ok(apiHeaders.includes('请求方法'));
    const apiSaved = await call('lantern_case_generation_save', {
      analysisId: 'ra_mcp',
      caseType: 'api',
      expectedRevision: apiContext.revision,
      expectedSourceFileHash: apiContext.sourceFileHash,
      title: '接口用例',
      format: 'csv',
      headers: apiHeaders,
      rows: [
        Object.fromEntries(
          apiHeaders.map((header) => [
            header,
            header === '需求编号'
              ? 'US-001'
              : header === '引用需求点'
                ? 'RO-1；TP-001'
                : header === '用例状态' || header === '实际结果'
                  ? ''
                  : `${header}-值`,
          ]),
        ),
      ],
    });
    assert.match(apiSaved.path, /^接口测试\//);
    const performanceContext = await call('lantern_case_generation_context', {
      analysisId: 'ra_mcp',
      caseType: 'performance',
    });
    assert.equal(performanceContext.caseType.id, 'performance');
    assert.match(performanceContext.skill, /性能用例/);
    assert.equal(performanceContext.outputContract.folder, '性能测试');
    const detail = await call('lantern_case_execution_cases', { casePath: saved.path });
    assert.equal(detail.document.cases[0].status, '待验证');
    const review = await call('lantern_case_review_context', { casePath: saved.path });
    assert.ok(review.skill);
    await call('lantern_case_review_save', {
      casePath: saved.path,
      expectedFileHash: detail.document.fileHash,
      review: { score: 90, cases: [] },
    });
    const wrong = await client.callTool({
      name: 'lantern_case_review_save',
      arguments: { casePath: saved.path, expectedFileHash: 'obsolete', review: { score: 90 } },
    });
    assert.equal(wrong.isError, true);
    const plan = await call('lantern_case_execution_plan_create', {
      casePath: saved.path,
      expectedFileHash: detail.document.fileHash,
      caseIds: [detail.document.cases[0].id],
      engine: 'automation',
      projectId: 'missing',
      file: 'test_api.py',
      environment: { name: 'test', build: 'v1' },
    });
    assert.equal(plan.plan.status, 'draft');
    const report = await call('lantern_case_acceptance', { casePath: saved.path });
    assert.equal(report.acceptance.ready, false);
    const blindspotContext = await call('lantern_case_blindspot_context', {
      casePath: saved.path,
    });
    const blindspotSaved = await call('lantern_case_blindspot_save', {
      casePath: saved.path,
      expectedFileHash: blindspotContext.hash,
      blindspot: {
        context: { reqRef: 'RO-1', reqTitle: '创建' },
        items: [
          {
            category: 'business',
            severity: 'high',
            title: '重复提交创建工单时只生成一张工单',
            why: '人工容易只验证单次提交，遗漏重复点击和并发提交。',
            precondition: '已登录普通用户，创建工单表单已填写完整',
            steps: ['连续点击两次提交按钮', '查看工单列表中的新增记录数'],
            expected: '只生成一张工单，并提示请勿重复提交',
            priority: 'P1',
            reqAnchor: 'RO-1',
          },
        ],
        summary: '补充重复提交场景。',
      },
    });
    const blindspotItem = blindspotSaved.entry.blindspot.items[0];
    const blindspotDraft = await call('lantern_case_blindspot_draft', {
      casePath: saved.path,
      selectedIds: [blindspotItem.id],
    });
    assert.equal(blindspotDraft.requiresConfirmation, true);
    assert.equal(blindspotDraft.preview[0].reqAnchor, 'RO-1');
    const blindspotApplied = await call('lantern_case_blindspot_apply', {
      draftId: blindspotDraft.draftId,
      expectedRevision: blindspotDraft.revision,
    });
    assert.equal(blindspotApplied.ok, true);
    assert.equal(blindspotApplied.applied.length, 1);
  } finally {
    await client.close();
    await mcp?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
