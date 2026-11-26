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
import { setActiveRoot, __resetSpaceContext } from '../../builtin/session/space-context.mjs';
import { spaceConfigFile, spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import {
  lhCaseDesignPlugin,
  caseDesignContext,
  caseDesignSetup,
  saveCaseDesign,
} from '../../lh-plugins/lh-case-design.mjs';
import { ensurePluginPrompt } from '../../lh-plugins/plugin-prompts.mjs';
import { reqAnalysisStorePath, reqDocsDir } from '../../lh-plugins/lh-req-analysis.mjs';

test('不支持 MCP elicitation 的客户端获得推荐配置降级结果', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-design-fallback-'));
  const app = connect();
  let server: http.Server | undefined;
  let mcp: ReturnType<typeof createLanternMcpServer> | undefined;
  let client: Client | undefined;
  const put = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
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
      plugins: { cases: true, caseGen: true, reqAnalysis: true },
    });
    fs.mkdirSync(reqDocsDir(root), { recursive: true });
    fs.writeFileSync(path.join(reqDocsDir(root), '创建工单.md'), '创建工单');
    put(reqAnalysisStorePath(root), {
      version: 1,
      docs: [
        {
          id: 'ra_fallback',
          title: '创建工单',
          sourcePath: '创建工单.md',
          outline: [{ id: 'RO-1', title: '创建' }],
          stories: [{ id: 'US-001', title: '创建', sourceRefs: ['RO-1'] }],
          testPoints: { points: [{ id: 'TP-001', storyId: 'US-001', title: '创建' }] },
        },
      ],
    });
    ensurePluginPrompt('功能测试用例提示词.md', '# 编写用例', root);
    lhCaseDesignPlugin().configureServer({ middlewares: app } as never);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    mcp = createLanternMcpServer({ apiBase, version: 'test' });
    client = new Client({ name: 'no-elicitation', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), mcp.connect(b)]);
    const result = await client.callTool({
      name: 'lantern_case_generation_setup',
      arguments: { prompt: '生成创建工单测试用例', presentation: 'form' },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const data = result.structuredContent as Record<string, any>;
    assert.equal(data.action, 'fallback');
    assert.equal(data.recommended.analysisId, 'ra_fallback');
    assert.equal(data.available.analyses[0].id, 'ra_fallback');
    assert.match(data.message, /不得自动/);

    // A moved analysis source must not block setup, context, or baseline-protected saving.
    const movedDir = path.join(reqDocsDir(root), '新目录');
    fs.mkdirSync(movedDir);
    fs.renameSync(path.join(reqDocsDir(root), '创建工单.md'), path.join(movedDir, '创建工单.md'));
    const movedSetup = await caseDesignSetup(root, { analysisId: 'ra_fallback' });
    assert.equal(movedSetup.recommended.sourcePath, '新目录/创建工单.md');
    assert.match(movedSetup.warnings.join(' '), /唯一同名文档/);
    const context = await caseDesignContext(root, { analysisId: 'ra_fallback' });
    assert.equal(context.sourcePath, '新目录/创建工单.md');
    assert.ok(context.sourceFileHash);
    const saved = await saveCaseDesign(root, {
      analysisId: 'ra_fallback',
      expectedRevision: context.revision,
      expectedSourceFileHash: context.sourceFileHash,
      format: 'csv',
      headers: [
        '用例编号',
        '需求编号',
        '用例标题',
        '前置条件',
        '测试步骤',
        '预期结果',
        '优先级',
        '引用需求点',
      ],
      rows: [
        {
          用例编号: '1',
          需求编号: 'US-001',
          用例标题: '创建工单',
          前置条件: '已登录',
          测试步骤: '提交工单',
          预期结果: '创建成功',
          优先级: 'P1',
          引用需求点: 'RO-1；TP-001',
        },
      ],
    });
    assert.equal(saved.ok, true);
    assert.equal(
      JSON.parse(fs.readFileSync(reqAnalysisStorePath(root), 'utf8')).docs[0].sourcePath,
      '创建工单.md',
    );

    // Ambiguous names must not silently bind another document.
    fs.mkdirSync(path.join(reqDocsDir(root), '另一目录'));
    fs.writeFileSync(path.join(reqDocsDir(root), '另一目录', '创建工单.md'), '另一份需求');
    const ambiguous = await caseDesignSetup(root, { analysisId: 'ra_fallback' });
    assert.equal(ambiguous.recommended.sourcePath, '创建工单.md');
    assert.equal(ambiguous.selectedAnalysis?.stories.length, 1);
    assert.match(ambiguous.warnings.join(' '), /来源文档不存在/);
    await assert.rejects(caseDesignContext(root, { analysisId: 'ra_fallback' }), /来源文档不存在/);
    fs.rmSync(movedDir, { recursive: true });
    fs.rmSync(path.join(reqDocsDir(root), '另一目录'), { recursive: true });
    const missing = await client.callTool({
      name: 'lantern_case_generation_setup',
      arguments: { analysisId: 'ra_fallback', presentation: 'chat' },
    });
    assert.notEqual(missing.isError, true);
    assert.match(
      (missing.structuredContent as Record<string, any>).warnings.join(' '),
      /来源文档不存在/,
    );
    await assert.rejects(caseDesignSetup(root, { sourcePath: '不存在.md' }), /来源文档不存在/);
  } finally {
    await client?.close();
    await mcp?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
