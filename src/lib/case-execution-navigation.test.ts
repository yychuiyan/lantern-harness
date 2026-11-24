import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';

import {
  installNavigationGuard,
  normalizeAllowedOrigins,
} from '../../lh-plugins/uiauto-explorer/navigation-guard.mjs';
import {
  callExplorer,
  startExplorer,
  stopAllExplorers,
} from '../../lh-plugins/uiauto-explorer/sessions.mjs';

let browser: Browser;
let target: http.Server;
let evil: http.Server;
let login: http.Server;
let targetBase = '';
let evilBase = '';
let loginBase = '';
let evilHits: string[] = [];
let root = '';
const cleanups: Array<() => void | Promise<void>> = [];

function listen(server: http.Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('测试服务没有端口');
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function guardedContext(origins: string[], blocked: Array<{ url: string }>) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const guard = await installNavigationGuard(context, origins, {
    onBlocked: (entry: { url: string }) => blocked.push(entry),
  });
  cleanups.push(async () => {
    await guard.dispose();
    await context.close();
  });
  const page = await context.newPage();
  await guard.guardPage(page);
  return { context, guard, page };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-navigation-guard-'));
  let evilOrigin = '';
  let loginOrigin = '';
  target = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `${evilOrigin}/redirect-destination` });
      return response.end();
    }
    if (request.url === '/chain') {
      response.writeHead(302, { location: '/chain-middle' });
      return response.end();
    }
    if (request.url === '/chain-middle') {
      response.writeHead(302, { location: `${evilOrigin}/chain-destination` });
      return response.end();
    }
    if (request.url === '/login-redirect') {
      response.writeHead(302, { location: `${loginOrigin}/done` });
      return response.end();
    }
    if (request.url === '/frame-redirect') {
      response.writeHead(302, { location: `${evilOrigin}/frame-destination` });
      return response.end();
    }
    if (request.url === '/popup-redirect') {
      response.writeHead(302, { location: `${evilOrigin}/popup-redirect-destination` });
      return response.end();
    }
    if (request.url === '/popup-chain') {
      response.writeHead(302, { location: '/popup-chain-middle' });
      return response.end();
    }
    if (request.url === '/popup-chain-middle') {
      response.writeHead(302, { location: `${evilOrigin}/popup-chain-destination` });
      return response.end();
    }
    if (request.url === '/popup-allowed') {
      response.writeHead(302, { location: '/popup-final' });
      return response.end();
    }
    if (request.url === '/popup-final') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      return response.end('<title>允许的弹窗</title><h1>允许的弹窗</h1>');
    }
    if (request.url === '/frame') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      return response.end(
        '<title>嵌入页面</title><h1>嵌入页面</h1><iframe src="/frame-redirect"></iframe>',
      );
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      `<title>目标系统</title><h1>目标系统</h1><button onclick="location.href='${evilOrigin}/script-destination'">脚本跳转</button><button onclick="window.open('${evilOrigin}/popup-destination','_blank')">打开弹窗</button><button onclick="window.open('/popup-redirect','_blank')">弹窗重定向</button><button onclick="window.open('/popup-chain','_blank')">弹窗重定向链</button><button onclick="window.open('/popup-allowed','_blank')">允许弹窗重定向</button>`,
    );
  });
  evil = http.createServer((request, response) => {
    evilHits.push(String(request.url || ''));
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<title>未授权站点</title><h1>未授权站点</h1>');
  });
  login = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<title>登录完成</title><h1>登录完成</h1>');
  });
  targetBase = await listen(target);
  evilBase = await listen(evil);
  loginBase = await listen(login);
  evilOrigin = new URL(evilBase).origin;
  loginOrigin = new URL(loginBase).origin;
  browser = await chromium.launch({ headless: true });
});

afterEach(async () => {
  evilHits = [];
  stopAllExplorers();
  while (cleanups.length) await cleanups.pop()?.();
});

after(async () => {
  await browser?.close();
  await Promise.all([
    new Promise<void>((resolve) => target?.close(() => resolve())),
    new Promise<void>((resolve) => evil?.close(() => resolve())),
    new Promise<void>((resolve) => login?.close(() => resolve())),
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('用例执行浏览器导航授权', () => {
  it('只接受合法 HTTP(S) origin 并去重', () => {
    assert.deepEqual(
      normalizeAllowedOrigins([
        'https://target.test/path',
        'https://target.test/other',
        'ftp://invalid.test',
        'https://name:password@invalid.test',
      ]),
      ['https://target.test'],
    );
  });

  it('服务端 302 和允许来源之间的多次重定向都在目标请求发出前拦截', async () => {
    const blocked: Array<{ url: string }> = [];
    const first = await guardedContext([targetBase, loginBase], blocked);
    await assert.rejects(
      first.page.goto(`${targetBase}/redirect`, { waitUntil: 'domcontentloaded' }),
      /ERR_BLOCKED_BY_CLIENT/,
    );
    assert.deepEqual(evilHits, []);
    assert.deepEqual(
      blocked.map((entry) => entry.url),
      [`${evilBase}/redirect-destination`],
    );

    const second = await guardedContext([targetBase, loginBase], blocked);
    await assert.rejects(
      second.page.goto(`${targetBase}/chain`, { waitUntil: 'domcontentloaded' }),
      /ERR_BLOCKED_BY_CLIENT/,
    );
    assert.deepEqual(evilHits, []);
    assert.ok(blocked.some((entry) => entry.url === `${evilBase}/chain-destination`));

    const framed = await guardedContext([targetBase, loginBase], blocked);
    await framed.page.goto(`${targetBase}/frame`, { waitUntil: 'domcontentloaded' });
    await framed.page.waitForTimeout(200);
    assert.deepEqual(evilHits, []);
    assert.ok(blocked.some((entry) => entry.url === `${evilBase}/frame-destination`));
  });

  it('明确允许的登录 origin 重定向仍可访问并保留最终 URL', async () => {
    const blocked: Array<{ url: string }> = [];
    const { page } = await guardedContext([targetBase, loginBase], blocked);
    await page.goto(`${targetBase}/login-redirect`, { waitUntil: 'domcontentloaded' });
    assert.equal(page.url(), `${loginBase}/done`);
    assert.equal(await page.title(), '登录完成');
    assert.deepEqual(blocked, []);
    assert.deepEqual(evilHits, []);

    await page.goto(targetBase, { waitUntil: 'domcontentloaded' });
    const popupPromise = page.context().waitForEvent('page', { timeout: 2000 });
    await page.getByText('允许弹窗重定向').click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
    assert.equal(popup.url(), `${targetBase}/popup-final`);
    assert.equal(await popup.title(), '允许的弹窗');
  });

  it('脚本跳转和新建弹窗首次导航也不能越过授权边界', async () => {
    const blocked: Array<{ url: string }> = [];
    const scripted = await guardedContext([targetBase, loginBase], blocked);
    await scripted.page.goto(targetBase, { waitUntil: 'domcontentloaded' });
    await scripted.page.getByText('脚本跳转').click();
    await scripted.page.waitForTimeout(200);
    assert.deepEqual(evilHits, []);
    assert.ok(blocked.some((entry) => entry.url === `${evilBase}/script-destination`));

    const popupCase = await guardedContext([targetBase, loginBase], blocked);
    await popupCase.page.goto(targetBase, { waitUntil: 'domcontentloaded' });
    const popupPromise = popupCase.context.waitForEvent('page', { timeout: 2000 });
    await popupCase.page.getByText('打开弹窗').click();
    const popup = await popupPromise;
    await popup.waitForTimeout(200).catch(() => undefined);
    assert.deepEqual(evilHits, []);
    assert.ok(blocked.some((entry) => entry.url === `${evilBase}/popup-destination`));

    await popupCase.page.goto(targetBase, { waitUntil: 'domcontentloaded' });
    const redirectPopupPromise = popupCase.context.waitForEvent('page', { timeout: 2000 });
    await popupCase.page.getByRole('button', { name: '弹窗重定向', exact: true }).click();
    await (await redirectPopupPromise).waitForTimeout(200).catch(() => undefined);
    assert.deepEqual(evilHits, []);
    assert.ok(blocked.some((entry) => entry.url === `${evilBase}/popup-redirect-destination`));

    await popupCase.page.goto(targetBase, { waitUntil: 'domcontentloaded' });
    const chainedPopupPromise = popupCase.context.waitForEvent('page', { timeout: 2000 });
    await popupCase.page.getByRole('button', { name: '弹窗重定向链', exact: true }).click();
    await (await chainedPopupPromise).waitForTimeout(200).catch(() => undefined);
    assert.deepEqual(evilHits, []);
    assert.ok(blocked.some((entry) => entry.url === `${evilBase}/popup-chain-destination`));
  });

  it('浏览器执行器返回可读的拦截原因并记录到网络日志', async () => {
    const sessionId = 'navigation-guard-runner';
    await startExplorer({
      baseDir: root,
      project: { dir: path.resolve('.') },
      sessionId,
      baseURL: targetBase,
      headed: false,
      storageState: '',
      allowedOrigins: [targetBase],
    });
    await assert.rejects(
      callExplorer(sessionId, 'open', { url: `${targetBase}/redirect`, settle: 0 }),
      /跨域导航已拦截：.*redirect-destination/,
    );
    const network = await callExplorer(sessionId, 'network', {});
    assert.ok(
      network.requests.some(
        (request: { blocked?: boolean; failure?: string }) =>
          request.blocked && request.failure === '跨域导航已拦截',
      ),
    );
    assert.ok(
      network.blockedNavigations.some(
        (entry: { url?: string }) => entry.url === `${evilBase}/redirect-destination`,
      ),
    );
    assert.deepEqual(evilHits, []);
  });
});
