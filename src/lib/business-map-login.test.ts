import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { before, after, beforeEach, afterEach, describe, it } from 'node:test';
import { chromium, type Browser, type LaunchOptions } from 'playwright';
import { createBusinessLoginService } from '../../lh-plugins/business-map/login.mjs';
import {
  businessLoginDir,
  businessLoginStatePath,
} from '../../lh-plugins/business-map/auth-paths.mjs';
import { collectPages, walkFiles } from '../../lh-plugins/business-map/sources.mjs';

const password = ' pass"\\$&word ';
const token = 'fixture-private-token-1234567890';
describe('业务地图登录与采集闭环', () => {
  let root = '',
    base = '',
    server: http.Server,
    browser: Browser;
  let service: ReturnType<typeof createBusinessLoginService>;
  let writes = 0;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const system = () => ({
    id: 'sys_login_test',
    name: '登录测试',
    entryUrl: base + '/app',
    sourceDir: '',
    loginState: '',
  });
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-login-'));
    process.env.XDG_CONFIG_HOME = path.join(root, 'user-config');
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      if (req.url === '/api/login') {
        const input = JSON.parse(body);
        assert.equal(input.password, password);
        assert.equal(input.username, 'tester');
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: { token } }));
      }
      if (req.url === '/business-write') {
        writes++;
        return res.end('unexpected');
      }
      if (req.url === '/session' && req.method === 'POST') {
        const input = new URLSearchParams(body);
        if (input.get('username') === 'tester' && input.get('password') === password) {
          res.setHeader('Set-Cookie', 'auth=fixture; Path=/; HttpOnly; SameSite=Lax');
          res.writeHead(302, { Location: '/app' });
          return res.end();
        }
        res.statusCode = 403;
        return res.end('invalid');
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.url === '/token-app')
        return res.end(
          `<html><body><script>document.body.innerHTML=localStorage.getItem('token')===${JSON.stringify(token)}?'<h1>费用查询</h1><p>按金额查询报销状态</p>':'<input type="password">';fetch('/business-write',{method:'POST'}).catch(()=>{});</script></body></html>`,
        );
      if (req.url === '/app' && req.headers.cookie?.includes('auth=fixture'))
        return res.end(
          '<html><body><h1>费用查询</h1><p>报销状态与审核进度</p><script>fetch("/business-write",{method:"POST"}).catch(()=>{});</script></body></html>',
        );
      res.end(
        `<html><body><form method="POST" action="/session"><input name="username"><input type="password" name="password">${req.url === '/captcha' ? '<input placeholder="验证码" name="captcha">' : ''}<button type="submit">登录</button></form></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  });
  beforeEach(() => {
    fs.rmSync(path.join(root, 'user-config'), { recursive: true, force: true });
    writes = 0;
    service = createBusinessLoginService({
      browserRuntime: () => ({
        chromium: {
          launch: async (options: LaunchOptions) => {
            browser = await chromium.launch({ ...options, headless: true });
            return browser;
          },
        },
      }),
    });
  });
  afterEach(async () => {
    await service.close();
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
  });
  function save(mode: string, extra = {}) {
    return service.save(root, system(), {
      revision: '',
      mode,
      username: 'tester',
      password,
      ...extra,
    });
  }
  async function collect(target = system()) {
    writes = 0;
    return collectPages(
      root,
      target,
      {
        entryUrl: target.entryUrl,
        sources: { page: { enabled: true } },
        pageUrls: [],
        maxPages: 1,
        maxDepth: 0,
      },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
  }
  it('密码仅写本机受限文件，空密码保留、过期版本拒绝、改配置使登录态失效', async () => {
    const saved = save('password');
    assert.equal(saved.hasPassword, true);
    assert.ok(!JSON.stringify(saved).includes(password));
    const configFile = path.join(businessLoginDir(root, system().id), 'config.json');
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    assert.deepEqual(walkFiles(path.join(root, 'user-config'), /\.json$/), []);
    const kept = service.save(root, system(), { ...saved.config, password: '' });
    assert.equal(kept.hasPassword, true);
    assert.throws(
      () => service.save(root, system(), { ...saved.config, password: 'changed' }),
      /已变更/,
    );
    fs.mkdirSync(path.dirname(businessLoginStatePath(root, system().id)), { recursive: true });
    fs.writeFileSync(businessLoginStatePath(root, system().id), '{}');
    const changed = service.save(root, system(), { ...kept.config, username: 'other' });
    assert.equal(changed.stateReady, false);
    const cleared = service.save(root, system(), { ...changed.config, clearPassword: true });
    assert.equal(cleared.hasPassword, false);
  });
  it('账号密码真实提交保存 Cookie，采集复用登录态且仍阻止业务写请求', async () => {
    save('password');
    const result = await service.start(root, system());
    assert.equal(result.status, 'ready');
    assert.equal(result.stateReady, true);
    assert.equal(fs.statSync(businessLoginStatePath(root, system().id)).mode & 0o777, 0o600);
    const collected = await collect();
    assert.ok(collected.evidence.some((e: { content: string }) => e.content.includes('费用查询')));
    assert.equal(writes, 0);
    assert.ok(!JSON.stringify(collected).includes(password));
    await service.invalidate(root, system());
    assert.equal(service.status(root, system()).stateReady, false);
  });
  it('验证码时不自动提交，等待用户完成后保存同一浏览器的登录态', async () => {
    save('password', { loginUrl: base + '/captcha' });
    const result = await service.start(root, system());
    assert.equal(result.status, 'awaiting_login');
    assert.equal(result.stateReady, false);
    await assert.rejects(service.complete(root, system()), /完成验证码/);
    const page = browser.contexts()[0]!.pages()[0]!;
    assert.equal(await page.locator('[name="username"]').inputValue(), 'tester');
    await page.locator('[name="captcha"]').fill('fixture-user-input');
    await page.locator('button').click();
    await page.waitForURL(base + '/app');
    const complete = await service.complete(root, system());
    assert.equal(complete.stateReady, true);
    assert.equal(complete.status, 'ready');
  });
  it('手动登录可取消；未保存登录态的采集进入登录提示而非分析登录页', async () => {
    save('manual');
    const missing = await collect();
    assert.equal(missing.evidence.length, 0);
    assert.ok(missing.issues.some((s: string) => s.includes('登录态失效')));
    assert.equal((await service.start(root, system())).status, 'awaiting_login');
    const cancelled = await service.cancel(root, system());
    assert.equal(cancelled.stateReady, false);
    assert.equal(cancelled.status, 'idle');
    assert.equal(browser.isConnected(), false);
  });
  it('复用 SSO 接口登录，特殊字符密码正确传递，Token 只用于采集', async () => {
    save('sso', { endpoint: '/api/login' });
    const target = { ...system(), entryUrl: base + '/token-app' };
    const result = await service.start(root, target);
    assert.equal(result.stateReady, true);
    assert.ok(!JSON.stringify(result).includes(token));
    const collected = await collect(target);
    assert.ok(collected.evidence.some((e: { content: string }) => e.content.includes('费用查询')));
    assert.ok(!JSON.stringify(collected).includes(token));
    assert.equal(writes, 0);
    const anotherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-login-other-'));
    try {
      assert.equal(service.status(anotherRoot, target).stateReady, false);
    } finally {
      fs.rmSync(anotherRoot, { recursive: true, force: true });
    }
  });
});
