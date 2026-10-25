import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isPrivateHostname,
  isPrivateIp,
  shouldBlockHost,
  shouldBlockIp,
} from '../../builtin/session/web-fetch-policy.mjs';

describe('web-fetch-policy', () => {
  it('拦截 localhost / 私网主机名', () => {
    assert.equal(isPrivateHostname('localhost'), true);
    assert.equal(isPrivateHostname('foo.localhost'), true);
    assert.equal(isPrivateHostname('127.0.0.1'), true);
    assert.equal(isPrivateHostname('10.0.0.1'), true);
    assert.equal(isPrivateHostname('192.168.1.1'), true);
    assert.equal(isPrivateHostname('172.16.0.1'), true);
    assert.equal(isPrivateHostname('169.254.1.1'), true);
    assert.equal(isPrivateHostname('100.64.0.1'), true);
    assert.equal(isPrivateHostname('::1'), true);
    assert.equal(isPrivateHostname('fd12::1'), true);
    assert.equal(isPrivateHostname('fe80::1'), true);
    assert.equal(isPrivateHostname('example.com'), false);
    assert.equal(isPrivateHostname('8.8.8.8'), false);
  });

  it('allowPrivate 时不拦截', () => {
    assert.equal(shouldBlockHost('localhost', false), true);
    assert.equal(shouldBlockHost('localhost', true), false);
    assert.equal(shouldBlockIp('127.0.0.1', false), true);
    assert.equal(shouldBlockIp('127.0.0.1', true), false);
  });

  it('IPv4-mapped IPv6', () => {
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateHostname('::ffff:10.1.2.3'), true);
  });
});
