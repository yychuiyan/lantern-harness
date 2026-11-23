import assert from 'node:assert/strict';
import { it } from 'node:test';
import { businessLoginRequest } from './business-map-login';
import { BusinessMapApiError } from './business-map';

it('旧后端的 405 与错误落入地图版本校验都提示升级重启，不误报地图被修改', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, body] of [
      [405, { error: 'Method Not Allowed' }],
      [409, { error: '业务地图已被其他页面修改，请刷新后再试', code: 'revision_conflict' }],
    ] as const) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      await assert.rejects(businessLoginRequest('sys_fixture'), (error: unknown) => {
        assert.ok(error instanceof BusinessMapApiError);
        assert.equal(error.code, 'login_api_unavailable');
        assert.match(error.message, /重启 Lantern/);
        return true;
      });
    }
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: '登录配置已变更，请重新打开后修改' }), { status: 409 });
    await assert.rejects(businessLoginRequest('sys_fixture'), /登录配置已变更/);
  } finally {
    globalThis.fetch = original;
  }
});
