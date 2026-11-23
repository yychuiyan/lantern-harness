import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MCP_HEADER_MASK_PREFIX,
  callMcpTool,
  closeAllMcpClients,
  listMcpTools,
  mcpConfigPath,
  saveMcpServers,
  coerceMcpServersInput,
  maskSecretValue,
  mcpToolName,
  mergeMcpHeaders,
  normalizeMcpServers,
  parseMcpToolName,
  redactMcpHeaders,
  sanitizeMcpSegment,
} from '../../builtin/session/mcp-client.mjs';
import { parseMcpServersJson } from './mcp-tools.ts';

describe('mcp-client naming/config', () => {
  it('sanitize 与 mcp__ 命名', () => {
    assert.equal(sanitizeMcpSegment('my server!'), 'my_server');
    assert.equal(mcpToolName('memory', 'search-notes'), 'mcp__memory__search-notes');
    assert.deepEqual(parseMcpToolName('mcp__memory__search-notes'), {
      server: 'memory',
      tool: 'search-notes',
    });
    assert.equal(parseMcpToolName('bash'), null);
  });

  it('normalizeMcpServers 过滤非法项', () => {
    const servers = normalizeMcpServers({
      servers: [
        { name: 'ok', transport: 'stdio', command: 'node', args: ['a.js'] },
        { name: 'bad', transport: 'stdio' },
        { name: 'http1', transport: 'http', url: 'https://example.com/mcp' },
        { name: 'ok', transport: 'stdio', command: 'dup' },
      ],
    });
    assert.equal(servers.length, 2);
    assert.equal(servers[0]!.name, 'ok');
    assert.equal(servers[1]!.name, 'http1');
  });

  it('headers 脱敏与回写合并', () => {
    assert.equal(maskSecretValue('abcdEFGH'), `${MCP_HEADER_MASK_PREFIX}EFGH`);
    assert.deepEqual(redactMcpHeaders({ Authorization: 'secret-token-9999', 'X-Custom': 'ok' }), {
      Authorization: `${MCP_HEADER_MASK_PREFIX}9999`,
      'X-Custom': 'ok',
    });
    assert.deepEqual(
      mergeMcpHeaders(
        { Authorization: 'secret-token-9999' },
        { Authorization: `${MCP_HEADER_MASK_PREFIX}9999` },
      ),
      { Authorization: 'secret-token-9999' },
    );
    assert.deepEqual(mergeMcpHeaders({ Authorization: 'old' }, { Authorization: 'brand-new' }), {
      Authorization: 'brand-new',
    });
  });

  it('兼容 Trae / Claude Desktop 的 mcpServers', () => {
    const servers = coerceMcpServersInput({
      mcpServers: {
        Tavily: {
          command: 'python',
          args: ['-m', 'mcp_server_tavily'],
          env: { TAVILY_API_KEY: 'k' },
        },
      },
    });
    assert.equal(servers.length, 1);
    assert.equal(servers[0]!.name, 'Tavily');
    assert.equal(servers[0]!.command, 'python');
    assert.deepEqual(servers[0]!.env, { TAVILY_API_KEY: 'k' });

    const parsed = parseMcpServersJson(`{
      "mcpServers": {
        "Playwright": {
          "command": "npx",
          "args": ["-y", "@executeautomation/playwright-mcp-server"],
          "env": {}
        }
      }
    }`);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.servers[0]!.name, 'Playwright');
      assert.equal(parsed.servers[0]!.transport, 'stdio');
    }
  });
});

describe('mcp-client 远端结果透传', () => {
  it('真实 stdio 连接保留原始内容与 annotation，切换空间清理旧连接', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-mcp-client-'));
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-mcp-empty-'));
    const fixture = path.join(root, 'server.mjs');
    fs.writeFileSync(
      fixture,
      `
      import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
      const server = new McpServer({name: 'fixture', version: '1'});
      server.registerTool('smartsheet.list_records', {annotations: {readOnlyHint: true}}, async () => ({
        content: [{type: 'text', text: 'x'.repeat(90000)}, {type: 'image', mimeType: 'image/png', data: 'aGVsbG8='}],
        structuredContent: {records: [{record_id: 'r1'}]}
      }));
      await server.connect(new StdioServerTransport());
    `,
    );
    try {
      saveMcpServers(root, [
        { name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture] },
      ]);
      const listed = await listMcpTools(root);
      assert.deepEqual(listed.errors, []);
      assert.equal(listed.tools[0]?.annotations?.readOnlyHint, true);
      const result = await callMcpTool(listed.tools[0]!.name, {}, root);
      assert.equal(result.ok, true);
      assert.ok(result.text);
      assert.ok(result.content);
      assert.equal(result.text.length, 80000);
      assert.equal(result.content[0].text.length, 90000);
      assert.equal(result.content[1].type, 'image');
      assert.deepEqual(result.structuredContent, { records: [{ record_id: 'r1' }] });
      const empty = await listMcpTools(otherRoot);
      assert.deepEqual(empty.tools, []);
      const old = await callMcpTool(listed.tools[0]!.name, {}, otherRoot);
      assert.equal(old.ok, false);
      fs.mkdirSync(path.dirname(mcpConfigPath(otherRoot)), { recursive: true });
      fs.writeFileSync(mcpConfigPath(otherRoot), '{invalid json');
      const broken = await listMcpTools(otherRoot);
      assert.deepEqual(broken.tools, []);
      assert.equal(broken.errors.length, 1);
    } finally {
      await closeAllMcpClients();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
