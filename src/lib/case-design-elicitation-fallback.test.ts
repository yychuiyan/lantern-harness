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
import { lhCaseDesignPlugin } from '../../lh-plugins/lh-case-design.mjs';
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
  } finally {
    await client?.close();
    await mcp?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
