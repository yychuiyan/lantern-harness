import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAccessLevel, parseToolProfile, resolveAgentPolicy } from './agent-policy';

describe('agent-policy', () => {
  it('parseAccessLevel', () => {
    assert.equal(parseAccessLevel('full'), 'full');
    assert.equal(parseAccessLevel('nope', 'readonly'), 'readonly');
  });

  it('parseToolProfile 认布尔与别名', () => {
    assert.equal(parseToolProfile('true'), 'fs-readonly');
    assert.equal(parseToolProfile('fs_ro'), 'fs-readonly');
    assert.equal(parseToolProfile('off'), 'none');
    assert.equal(parseToolProfile('fs'), 'fs');
  });

  it('CLI access 覆盖配置；readonly 降级 fs 写档', () => {
    const p = resolveAgentPolicy({
      configAccess: 'full',
      cliAccess: 'readonly',
      cliToolProfile: 'fs',
      workspace: '/tmp/ws',
      defaultToolProfile: 'none',
    });
    assert.equal(p.access, 'readonly');
    assert.equal(p.toolProfile, 'fs-readonly');
    assert.equal(p.workspace, '/tmp/ws');
  });

  it('无 CLI 时用配置 access；ask 默认无工具', () => {
    const p = resolveAgentPolicy({
      configAccess: 'readwrite',
      defaultToolProfile: 'none',
    });
    assert.equal(p.access, 'readwrite');
    assert.equal(p.toolProfile, 'none');
  });
});
