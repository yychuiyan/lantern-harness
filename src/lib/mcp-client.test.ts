import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mcpToolName,
  normalizeMcpServers,
  parseMcpToolName,
  sanitizeMcpSegment,
} from '../../builtin/session/mcp-client.mjs';

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
});
