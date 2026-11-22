import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildLoginOrchestratePlan,
  detectHardLoginFactors,
  detectLoginWall,
  loginWallAutoSteps,
  normalizeLoginStrategy,
  resolveLoginWallHighlight,
  suggestLoginWallPath,
} from './ui-auto-login-wall';

describe('ui-auto-login-wall', () => {
  it('detects captcha as hard factor and suggests sso', () => {
    const text = '登录页出现验证码，需要手动登录';
    assert.equal(detectLoginWall(text), true);
    assert.equal(detectHardLoginFactors(text), true);
    assert.equal(suggestLoginWallPath(text), 'sso');
  });

  it('suggests ui orchestrate for plain password login', () => {
    const text = '当前在登录页，请输入用户名和密码后点登录';
    assert.equal(detectLoginWall(text), true);
    assert.equal(detectHardLoginFactors(text), false);
    assert.equal(suggestLoginWallPath(text), 'ui_orchestrate');
  });

  it('respects project preference over detection', () => {
    assert.equal(resolveLoginWallHighlight('sso', '请输入用户名密码'), 'sso');
    assert.equal(resolveLoginWallHighlight('ui_orchestrate', '有验证码'), 'ui_orchestrate');
    assert.equal(resolveLoginWallHighlight('ask_each_time', '有验证码'), 'sso');
  });

  it('normalizes unknown strategy to ask_each_time', () => {
    assert.equal(normalizeLoginStrategy('nope'), 'ask_each_time');
    assert.equal(normalizeLoginStrategy('sso'), 'sso');
  });

  it('builds a 5-step login orchestrate plan', () => {
    const plan = buildLoginOrchestratePlan('/admin/login');
    assert.equal(plan.length, 5);
    assert.equal(plan[0].action, 'goto');
    assert.equal(plan[0].url, '/admin/login');
    assert.equal(plan[1].value, '${ADMIN_USERNAME}');
    assert.equal(plan[2].value, '${ADMIN_PASSWORD}');
  });

  it('auto chain: auth.setup first, then SSO, else empty', () => {
    assert.deepEqual(loginWallAutoSteps({}), []);
    assert.deepEqual(loginWallAutoSteps({ ssoConfigured: true }), ['sso']);
    assert.deepEqual(loginWallAutoSteps({ authSetupDetected: true }), ['auth_setup']);
    assert.deepEqual(loginWallAutoSteps({ ssoConfigured: true, authSetupDetected: true }), [
      'auth_setup',
      'sso',
    ]);
  });
});
