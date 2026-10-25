import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defaultTimeoutMs, withToolTimeout, wrapRunTool } from './tool-run-policy';

describe('tool-run-policy', () => {
  it('defaultTimeoutMs 按工具名分层', () => {
    assert.equal(defaultTimeoutMs('bash'), 120_000);
    assert.equal(defaultTimeoutMs('web_fetch'), 35_000);
    assert.equal(defaultTimeoutMs('mcp__x__y'), 60_000);
    assert.ok(defaultTimeoutMs('fs_read') < defaultTimeoutMs('bash'));
  });

  it('withToolTimeout 超时抛错', async () => {
    await assert.rejects(() => withToolTimeout(new Promise(() => {}), 50, 'slow'), /timed out/);
  });

  it('wrapRunTool 正常路径透传', async () => {
    const fast = wrapRunTool(async (name) => `ran:${name}`);
    assert.equal(await fast('fs_read', '{}'), 'ran:fs_read');
  });
});
