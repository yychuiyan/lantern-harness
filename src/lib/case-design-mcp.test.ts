import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import connect from 'connect';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLanternMcpServer } from '../../cli/mcp-server.mjs';
import { lhFsPlugin } from '../../builtin/session/lh-fs.mjs';
import { setActiveRoot, __resetSpaceContext } from '../../builtin/session/space-context.mjs';
import { spaceConfigFile, spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import { lhCaseExecutionPlugin } from '../../lh-plugins/lh-case-execution.mjs';
import { lhCaseDesignPlugin } from '../../lh-plugins/lh-case-design.mjs';
import { lhCaseReviewPlugin } from '../../lh-plugins/lh-case-review.mjs';
import { ensurePluginPrompt } from '../../lh-plugins/plugin-prompts.mjs';
import { reqAnalysisStorePath, reqDocsDir } from '../../lh-plugins/lh-req-analysis.mjs';

test('真实 HTTP 与 MCP 生成、校验、入库、审查和计划共用资产', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-design-mcp-'));
  const app = connect();
  let server: http.Server | undefined;
  const client = new Client({ name: 'workflow-test', version: '1' });
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
      },
    });
    fs.mkdirSync(reqDocsDir(root), { recursive: true });
    fs.writeFileSync(path.join(reqDocsDir(root), '需求.md'), '创建工单');
    put(reqAnalysisStorePath(root), {
      version: 1,
      docs: [
        {
          id: 'ra_mcp',
          title: '创建工单',
          sourcePath: '需求.md',
          outline: [{ id: 'RO-1', title: '创建' }],
          stories: [{ id: 'US-001', title: '创建', sourceRefs: ['RO-1'] }],
          testPoints: { points: [{ id: 'TP-001', storyId: 'US-001', title: '创建' }] },
        },
      ],
    });
    ensurePluginPrompt('功能测试用例提示词.md', '# 编写用例', root);
    ensurePluginPrompt('用例质量评审提示词.md', '# 审查用例', root);
    for (const plugin of [
      lhFsPlugin(),
      lhCaseDesignPlugin(),
      lhCaseExecutionPlugin(),
      lhCaseReviewPlugin(),
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
      'lantern_case_generation_save',
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
          引用需求点: 'RO-1；TP-001',
        },
      ],
    };
    const checked = await call('lantern_case_generation_validate', payload);
    assert.equal(checked.ok, true);
    assert.equal(checked.coverage.TP.rate, 100);
    const saved = await call('lantern_case_generation_save', payload);
    assert.equal(saved.executable, true);
    assert.match(saved.path, /^功能测试\//);
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
  } finally {
    await client.close();
    await mcp?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
