import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveLoginApiEndpoint,
  resolveLoginToken,
  resolveTokenStorageKey,
  LOGIN_API_ENDPOINT_KEYS,
} from '../../lh-plugins/uiauto-sso.mjs';

describe('uiauto-sso：登录接口地址别名 / 通配', () => {
  it('优先 LOGIN_API_PATH，其次 LOGIN_API_URL 等', () => {
    assert.deepEqual(resolveLoginApiEndpoint({}), { key: '', value: '' });
    assert.deepEqual(resolveLoginApiEndpoint({ LOGIN_API_URL: 'https://x/login' }), {
      key: 'LOGIN_API_URL',
      value: 'https://x/login',
    });
    assert.deepEqual(
      resolveLoginApiEndpoint({
        LOGIN_API_PATH: '/api/auth/login',
        LOGIN_API_URL: 'https://x/login',
      }),
      { key: 'LOGIN_API_PATH', value: '/api/auth/login' },
    );
    assert.deepEqual(resolveLoginApiEndpoint({ LOGIN_API_ENDPOINT: '/sso' }), {
      key: 'LOGIN_API_ENDPOINT',
      value: '/sso',
    });
    assert.deepEqual(resolveLoginApiEndpoint({ LOGIN_URL: '/a' }), {
      key: 'LOGIN_URL',
      value: '/a',
    });
  });

  it('通配 LOGIN_API_*，但跳过 BODY / TOKEN_PATH', () => {
    assert.deepEqual(
      resolveLoginApiEndpoint({
        LOGIN_API_BODY: '{"u":"{{username}}"}',
        LOGIN_API_TOKEN_PATH: 'data.token',
        LOGIN_API_SSO_URL: 'https://sso.example/token',
      }),
      { key: 'LOGIN_API_SSO_URL', value: 'https://sso.example/token' },
    );
    assert.deepEqual(
      resolveLoginApiEndpoint({
        LOGIN_API_BODY: '{"a":1}',
        LOGIN_API_TOKEN_PATH: 'data.token',
      }),
      { key: '', value: '' },
    );
  });

  it('别名列表稳定包含 PATH 与 URL', () => {
    assert.ok(LOGIN_API_ENDPOINT_KEYS.includes('LOGIN_API_PATH'));
    assert.ok(LOGIN_API_ENDPOINT_KEYS.includes('LOGIN_API_URL'));
  });

  it('未配 TOKEN_PATH 时从常见字段猜 token，storage key 默认 token', () => {
    assert.deepEqual(resolveLoginToken({ data: { token: 'abc12345' } }, ''), {
      token: 'abc12345',
      path: 'data.token',
    });
    assert.deepEqual(resolveLoginToken({ access_token: 'xyzxyzxy' }, ''), {
      token: 'xyzxyzxy',
      path: 'access_token',
    });
    assert.deepEqual(resolveLoginToken({ data: { token: 'abc12345' } }, 'data.token'), {
      token: 'abc12345',
      path: 'data.token',
    });
    // 自定义 data.xxxToken
    assert.deepEqual(
      resolveLoginToken(
        { code: 0, data: { userId: 1, accessToken: 'tok_abcdefg' }, message: 'ok' },
        '',
      ),
      { token: 'tok_abcdefg', path: 'data.accessToken' },
    );
    // 热线类：data.authorization
    assert.deepEqual(
      resolveLoginToken({ code: 0, data: { authorization: 'eyJhbGciOi.test.sign' } }, ''),
      { token: 'eyJhbGciOi.test.sign', path: 'data.authorization' },
    );
    assert.equal(resolveTokenStorageKey({}), 'token');
    assert.equal(resolveTokenStorageKey({ LOGIN_TOKEN_STORAGE_KEY: 'auth' }), 'auth');
  });
});
