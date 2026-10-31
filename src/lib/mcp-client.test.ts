import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MCP_HEADER_MASK_PREFIX,
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
