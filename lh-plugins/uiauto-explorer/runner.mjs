/**
 * 浏览器探索子进程（由 lh-uiauto.mjs 拉起，一行一个 JSON 命令）。
 *
 * 为什么单开进程：
 * - 浏览器和 Playwright 都从「被挂载的项目」里解析，不污染 harness 自身依赖
 * - 崩溃 / 卡住只影响当前会话，SIGTERM 就能清干净
 *
 * 协议：
 *   启动参数 argv[2] = { projectDir, shotDir, baseURL, headed, storageState, slowMo }
 *   父 → 子：{ id, cmd, args }
 *   子 → 父：{ type: 'ready' } / { type: 'closed' } / { id, ok, result } / { id, ok: false, error }
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';

import { takeSnapshot, describeElement } from './snapshot.mjs';
import { probeLocators } from './locators.mjs';

const config = (() => {
  try {
    return JSON.parse(process.argv[2] || '{}');
  } catch {
    return {};
  }
})();

const projectDir = path.resolve(config.projectDir || '.');
const shotDir = path.resolve(config.shotDir || path.join(projectDir, '.lantern-shots'));
const storageState = config.storageState ? path.resolve(projectDir, config.storageState) : '';
const slowMo = Number.isFinite(Number(config.slowMo)) ? Number(config.slowMo) : 120;

fs.mkdirSync(shotDir, { recursive: true });

/** 被挂载项目里的 Playwright（优先 playwright，其次 @playwright/test） */
function loadPlaywright() {
  const requireFromProject = createRequire(path.join(projectDir, 'package.json'));
  for (const name of ['playwright', '@playwright/test']) {
    try {
      const mod = requireFromProject(name);
      if (mod && mod.chromium) return { mod, name };
    } catch {
      // 继续试下一个
    }
  }
  return null;
}

let browser = null;
let context = null;
let page = null;
/** 主动关闭（收到 close 命令 / SIGTERM）时不要上报「浏览器被用户关了」 */
let closing = false;
let shotSeq = 0;
let lastAction = '';
const consoleLog = [];
const networkLog = [];

function remember(list, entry, max = 120) {
  list.push(entry);
  if (list.length > max) list.shift();
}

async function settle(ms) {
  const wait = Number.isFinite(Number(ms)) ? Number(ms) : 260;
  if (wait > 0) await page.waitForTimeout(wait);
}

function describeError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n').slice(0, 6).join('\n');
}

async function resolveRef(ref) {
  const handle = await page.evaluateHandle((key) => {
    const store = window.__lanternRefs;
    return store ? (store.get(key) ?? null) : null;
  }, ref);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => undefined);
    throw new Error(`ref ${ref} 已失效（元素不在页面上），请先重新获取快照`);
  }
  return element;
}

async function snapshotResult(options = {}) {
  const snapshot = await takeSnapshot(page, {
    maxNodes: options.maxNodes ?? 400,
    maxText: options.maxText ?? 80,
    maxDepth: options.depth ?? 6,
    targetRef: options.targetRef ?? '',
    includeBoxes: Boolean(options.boxes),
  });
  return {
    url: snapshot.url,
    title: snapshot.title,
    count: snapshot.count,
    truncated: snapshot.truncated,
    snapshot: snapshot.text || '（页面上没有可交互元素）',
  };
}

async function ensurePage() {
  if (!page) throw new Error('浏览器还没打开页面，请先调用 ui_browser_open');
  return page;
}

const handlers = {
  async open(args) {
    const url = String(args.url || '/').trim() || '/';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
    await settle(args.settle ?? 400);
    lastAction = `打开 ${url}`;
    return snapshotResult(args);
  },

  async snapshot(args) {
    await ensurePage();
    return snapshotResult(args);
  },

  async action(args) {
    await ensurePage();
    const action = String(args.action || '');
    const ref = String(args.ref || '');
    const note = String(args.note || '');
    let label = '';
    const element = ref ? await resolveRef(ref) : null;
    try {
      if (action === 'click') {
        await element.click({ timeout: 15000 });
        label = '点击';
      } else if (action === 'fill') {
        await element.fill(String(args.text ?? ''), { timeout: 15000 });
        label = `填写「${String(args.text ?? '').slice(0, 40)}」`;
      } else if (action === 'select') {
        await element.selectOption(String(args.value ?? ''));
        label = `选择「${String(args.value ?? '')}」`;
      } else if (action === 'hover') {
        await element.hover({ timeout: 15000 });
        label = '悬停';
      } else if (action === 'press') {
        const key = String(args.key || 'Enter');
        if (element) await element.press(key, { timeout: 15000 });
        else await page.keyboard.press(key);
        label = `按键 ${key}`;
      } else if (action === 'check') {
        await element.check({ timeout: 15000 });
        label = '勾选';
      } else if (action === 'uncheck') {
        await element.uncheck({ timeout: 15000 });
        label = '取消勾选';
      } else if (action === 'scroll') {
        await page.mouse.wheel(0, Number(args.value) || 600);
        label = '滚动页面';
      } else if (action === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        label = '后退';
      } else if (action === 'reload') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        label = '刷新页面';
      } else {
        throw new Error(`不支持的动作：${action}`);
      }
    } finally {
      if (element) await element.dispose().catch(() => undefined);
    }

    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
    await settle(args.settle ?? 300);
    lastAction = note ? `${label}（${note}）` : label;
    if (args.snapshot === false) {
      return { action: lastAction, url: page.url(), title: await page.title(), snapshot: '' };
    }
    return { action: lastAction, ...(await snapshotResult(args)) };
  },

  async probe(args) {
    await ensurePage();
    const ref = String(args.ref || '');
    if (!ref) throw new Error('缺少 ref');
    const result = await probeLocators(page, { describeElement }, ref);
    return {
      ref,
      element: result.element,
      recommended: result.recommended,
      confidence: result.confidence,
      fragile: Boolean(result.fragile),
      warning: result.warning || '',
      candidates: result.candidates.slice(0, 6).map((item) => ({
        locator: item.locator,
        source: item.source,
        count: item.count,
        unique: item.unique,
        same: item.same,
      })),
    };
  },

  async waitFor(args) {
    await ensurePage();
    const text = String(args.text || '').trim();
    const timeout = Math.max(1000, Math.min(60000, Number(args.timeout) || 15000));
    if (text) {
      await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
      lastAction = `等待出现「${text.slice(0, 40)}」`;
    } else {
      const ms = Math.max(0, Math.min(15000, Number(args.ms) || 500));
      await settle(ms);
      lastAction = `等待 ${ms}ms`;
    }
    return { action: lastAction, ...(await snapshotResult(args)) };
  },

  async screenshot(args) {
    await ensurePage();
    shotSeq += 1;
    const raw = String(args.label || `step-${shotSeq}`);
    const name = `${String(shotSeq).padStart(2, '0')}-${raw
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)}.png`;
    const abs = path.join(shotDir, name);
    await page.screenshot({ path: abs, fullPage: Boolean(args.fullPage) });
    return { file: name, bytes: fs.statSync(abs).size };
  },

  async console() {
    return { messages: consoleLog.slice(-40) };
  },

  async network() {
    return { requests: networkLog.slice(-40) };
  },

  async state() {
    await ensurePage();
    return { url: page.url(), title: await page.title(), lastAction };
  },

  async close() {
    return { closed: true };
  },
};

async function start() {
  const loaded = loadPlaywright();
  if (!loaded) {
    throw new Error(
      '没有在被挂载项目里找到 playwright / @playwright/test，请先在该项目安装依赖（npm i -D @playwright/test）',
    );
  }
  const { chromium } = loaded.mod;
  browser = await chromium.launch({ headless: !config.headed, slowMo });
  // 用户手动关掉浏览器窗口（或进程崩了）时，主进程必须知道：
  // 否则这边继续等命令、模型那边一路重试，最后只能看到一串
  // 「Target page, context or browser has been closed」。
  browser.on('disconnected', () => {
    if (closing) return;
    closing = true;
    try {
      process.stdout.write(`${JSON.stringify({ type: 'closed', reason: 'browser-closed' })}\n`);
    } catch {
      // 管道已断就算了
    }
    // 给主进程一点时间读到最后一行，然后退出；不留在后台当僵尸
    setTimeout(() => process.exit(0), 50);
  });
  const contextOptions = { viewport: { width: 1440, height: 900 } };
  if (config.baseURL) contextOptions.baseURL = String(config.baseURL);
  if (storageState && fs.existsSync(storageState)) contextOptions.storageState = storageState;
  context = await browser.newContext(contextOptions);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  // 文档编号随导航递增：旧 ref 在刷新后一定失效，而不是误指到别的元素
  await page.addInitScript(() => {
    try {
      const next = Number(window.sessionStorage.getItem('__lantern_doc') || '0') + 1;
      window.sessionStorage.setItem('__lantern_doc', String(next));
      window.__lanternRefPrefix = `d${next}-`;
    } catch {
      window.__lanternRefPrefix = `d${Date.now().toString(36)}-`;
    }
  });

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      remember(consoleLog, { type: message.type(), text: message.text().slice(0, 500) });
    }
  });
  page.on('pageerror', (error) => {
    remember(consoleLog, { type: 'pageerror', text: String(error).slice(0, 500) });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      remember(networkLog, {
        status: response.status(),
        url: response.url().slice(0, 300),
        method: response.request().method(),
      });
    }
  });
  page.on('requestfailed', (request) => {
    remember(networkLog, {
      status: 0,
      url: request.url().slice(0, 300),
      method: request.method(),
      failure: request.failure()?.errorText ?? 'failed',
    });
  });

  process.stdout.write(`${JSON.stringify({ type: 'ready', playwright: loaded.name })}\n`);
}

async function shutdown() {
  closing = true;
  try {
    await context?.close();
  } catch {
    // ignore
  }
  try {
    await browser?.close();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.stdin.on('close', () => void shutdown());

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  const { id, cmd, args } = message || {};
  if (!id) return;
  const handler = handlers[cmd];
  if (!handler) {
    process.stdout.write(
      `${JSON.stringify({ id, ok: false, error: `未知命令：${String(cmd)}` })}\n`,
    );
    return;
  }
  Promise.resolve()
    .then(() => handler(args || {}))
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
      if (cmd === 'close') void shutdown();
    })
    .catch((err) => {
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: describeError(err) })}\n`);
    });
});

start().catch((err) => {
  process.stdout.write(`${JSON.stringify({ type: 'fatal', error: describeError(err) })}\n`);
  setTimeout(() => process.exit(1), 50);
});
