import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLanternMcpServer } from '../../cli/mcp-server.mjs';

test('MCP 暴露 UI 自动化项目、转换、探索、写盘和运行工具', async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, any> | null }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    const path = request.url || '/';
    calls.push({ method: request.method || 'GET', path, body });
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (path.startsWith('/__tb_uiauto/agent/session')) {
      response.end(
        JSON.stringify({
          ok: true,
          session: {
            id: 'session-1',
            projectId: 'project-1',
            target: 'ts',
            baseURL: 'http://oa.test',
            ir: { title: '知识库限额', steps: [{ action: 'goto', url: '/' }] },
          },
        }),
      );
      return;
    }
    response.end(JSON.stringify({ ok: true, projects: [], check: {}, preview: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务没有端口');
  const client = new Client({ name: 'automation-mcp-test', version: '1' });
  const mcp = createLanternMcpServer({
    apiBase: `http://127.0.0.1:${address.port}`,
    version: 'test',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as Record<string, any>;
  };
  try {
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
    const tools = await client.listTools();
    for (const name of [
      'lantern_uiauto_projects',
      'lantern_uiauto_project_mount',
      'lantern_uiauto_project_update',
      'lantern_uiauto_project_scaffold_preview',
      'lantern_uiauto_project_scaffold_create',
      'lantern_uiauto_project_setup_start',
      'lantern_case_automation_cases',
      'lantern_case_automation_iterations',
      'lantern_case_automation_assess',
      'lantern_case_automation_apply',
      'lantern_case_automation_status',
      'lantern_case_automation_flows',
      'lantern_case_automation_flow_preview',
      'lantern_case_automation_flow_create',
      'lantern_case_automation_run',
      'lantern_case_automation_run_get',
      'lantern_case_automation_run_stop',
      'lantern_uiauto_agent_session_get',
      'lantern_uiauto_agent_open',
      'lantern_uiauto_agent_snapshot',
      'lantern_uiauto_agent_action',
      'lantern_uiauto_agent_wait',
      'lantern_uiauto_agent_probe',
      'lantern_uiauto_agent_save',
      'lantern_uiauto_agent_emit',
      'lantern_uiauto_agent_verify',
      'lantern_uiauto_agent_write',
      'lantern_uiauto_agent_close',
    ]) {
      assert.ok(
        tools.tools.some((tool) => tool.name === name),
        `缺少 ${name}`,
      );
    }
    const applyTool = tools.tools.find((tool) => tool.name === 'lantern_case_automation_apply');
    assert.ok(
      (applyTool?.inputSchema as { properties?: Record<string, unknown> }).properties
        ?.selectedAutomationCaseIds,
      '应用评估必须明确选择原子自动化用例',
    );
    const saveTool = tools.tools.find((tool) => tool.name === 'lantern_case_generation_save');
    assert.ok(
      (saveTool?.inputSchema as { properties?: Record<string, unknown> }).properties?.folder,
      '用例保存必须支持 folder',
    );

    await call('lantern_uiauto_projects');
    await call('lantern_uiauto_project_scaffold_preview', {
      parentDir: '/tmp',
      name: 'oa-ui',
      stack: 'playwright',
      options: ['api'],
    });
    await call('lantern_case_automation_cases', { casePath: 'OA_功能测试用例.xlsx' });
    await call('lantern_case_automation_iterations', {
      projectId: 'project-1',
      casePath: 'OA_功能测试用例.xlsx',
    });
    await call('lantern_case_automation_assess', {
      casePath: 'OA_功能测试用例.xlsx',
      caseIds: ['case-1'],
      projectId: 'project-1',
      iteration: 'v1.2',
    });
    await call('lantern_case_automation_apply', {
      assessmentId: 'assessment-1',
      selectedSourceCaseIds: ['case-1'],
      selectedAutomationCaseIds: ['AUTO-1'],
    });
    await call('lantern_case_automation_run', { automationCaseIds: ['AUTO-1'] });
    await call('lantern_case_automation_flow_preview', {
      casePath: 'OA_功能测试用例.xlsx',
      automationCaseIds: ['AUTO-1', 'AUTO-2'],
      projectId: 'project-1',
      iteration: 'v1.2',
      title: 'OA 冒烟',
      kind: 'smoke',
    });
    await call('lantern_case_automation_flow_create', {
      casePath: 'OA_功能测试用例.xlsx',
      automationCaseIds: ['AUTO-1', 'AUTO-2'],
      projectId: 'project-1',
      iteration: 'v1.2',
      title: 'OA 冒烟',
      kind: 'smoke',
    });
    await call('lantern_case_automation_run_get', { batchId: 'batch-1' });
    await call('lantern_case_automation_run_stop', { batchId: 'batch-1' });
    await call('lantern_uiauto_agent_session_get', { sessionId: 'session-1' });
    await call('lantern_uiauto_agent_emit', { sessionId: 'session-1' });
    await call('lantern_uiauto_agent_write', { sessionId: 'session-1' });

    assert.ok(
      calls.some(
        (call) =>
          call.method === 'POST' &&
          call.path === '/__tb_case_automation/assess' &&
          call.body?.projectId === 'project-1',
      ),
    );
    assert.ok(
      calls.some(
        (call) => call.method === 'POST' && call.path === '/__tb_case_automation/runs/batch-1/stop',
      ),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === 'POST' &&
          call.path === '/__tb_case_automation/flows/preview' &&
          call.body?.kind === 'smoke',
      ),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === 'POST' &&
          call.path === '/__tb_case_automation/flows' &&
          call.body?.automationCaseIds?.length === 2,
      ),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === 'POST' &&
          call.path === '/__tb_uiauto/agent/emit' &&
          call.body?.projectId === 'project-1' &&
          call.body?.ir?.title === '知识库限额',
      ),
    );
  } finally {
    await client.close();
    await mcp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
