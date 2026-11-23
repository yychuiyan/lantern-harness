import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadBrowserRuntime } from './sources.mjs';
import {
  businessLoginDir,
  businessLoginStatePath,
  hasLoginChallenge,
  resolveBusinessLoginState,
} from './auth-paths.mjs';
import { runSsoLoginAndSave } from '../uiauto-sso.mjs';

const MODES = ['none', 'password', 'sso', 'manual'];
/** @type {(message: string, statusCode?: number) => never} */
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
const str = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
function httpUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    /* invalid */
  }
  fail('请填写有效的 HTTP / HTTPS 登录地址');
}
function read(root, id) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(businessLoginDir(root, id), 'config.json'), 'utf8'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return { mode: 'none', revision: '' };
    throw error;
  }
}
function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createBusinessLoginService({
  browserRuntime = loadBrowserRuntime,
  ssoLogin = runSsoLoginAndSave,
} = {}) {
  const sessions = new Map();
  const key = (root, id) => path.resolve(businessLoginDir(root, id));
  function status(root, system) {
    const config = read(root, system.id);
    const session = sessions.get(key(root, system.id));
    const { password, ...publicConfig } = config;
    // 公共响应只提供密码是否已配置，不回显密码或浏览器中的 token / Cookie。
    const statePath = resolveBusinessLoginState(root, system);
    return {
      config: publicConfig,
      hasPassword: Boolean(password),
      stateReady: Boolean(statePath && fs.existsSync(statePath)),
      status: session?.status || 'idle',
      message: session?.message || '',
      savedAt: config.savedAt || '',
    };
  }
  function save(root, system, input) {
    const previous = read(root, system.id);
    if (input.revision !== previous.revision) fail('登录配置已变更，请重新打开后修改', 409);
    if (sessions.has(key(root, system.id))) fail('请先完成或取消正在进行的登录', 409);
    if (!MODES.includes(input.mode)) fail('登录方式无效');
    const mode = input.mode;
    const next = {
      mode,
      username: str(input.username, 500),
      password:
        input.clearPassword === true
          ? ''
          : typeof input.password === 'string' && input.password
            ? input.password.slice(0, 8000)
            : previous.password || '',
      loginUrl: input.loginUrl ? httpUrl(input.loginUrl) : '',
      endpoint: str(input.endpoint),
      bodyTemplate:
        str(input.bodyTemplate, 8000) || '{"username":"{{username}}","password":"{{password}}"}',
      tokenPath: str(input.tokenPath, 300),
      tokenStorageKey: str(input.tokenStorageKey, 300) || 'token',
      usernameSelector: str(input.usernameSelector, 1000),
      passwordSelector: str(input.passwordSelector, 1000),
      submitSelector: str(input.submitSelector, 1000),
    };
    if (mode === 'sso' && next.endpoint) httpUrl(next.endpoint, system.entryUrl);
    const oldComparable = Object.fromEntries(
      Object.keys(next).map((name) => [name, previous[name]]),
    );
    const changed = JSON.stringify(oldComparable) !== JSON.stringify(next);
    writePrivate(path.join(businessLoginDir(root, system.id), 'config.json'), {
      ...next,
      revision: crypto.randomUUID(),
      savedAt: changed ? '' : previous.savedAt || '',
    });
    if (changed) fs.rmSync(businessLoginStatePath(root, system.id), { force: true });
    return status(root, system);
  }
  async function closeSession(session) {
    if (!session) return;
    clearTimeout(session.timer);
    session.abort?.abort();
    if (sessions.get(session.key) === session) sessions.delete(session.key);
    await session.browser?.close().catch(() => {});
  }
  async function complete(root, system) {
    const session = sessions.get(key(root, system.id));
    if (!session?.context || session.status !== 'awaiting_login') fail('没有等待完成的登录窗口');
    const pages = session.context.pages();
    const page = pages.at(-1);
    if (
      !page ||
      new URL(page.url()).origin !== new URL(system.entryUrl).origin ||
      (await hasLoginChallenge(page))
    )
      fail('请先在登录窗口完成验证码或 SSO，并进入业务系统后再保存');
    const state = await session.context.storageState();
    if (sessions.get(session.key) !== session) fail('登录已取消，请重新打开登录窗口');
    writePrivate(businessLoginStatePath(root, system.id), state);
    const config = read(root, system.id);
    writePrivate(path.join(businessLoginDir(root, system.id), 'config.json'), {
      ...config,
      savedAt: new Date().toISOString(),
    });
    await closeSession(session);
    return { ...status(root, system), status: 'ready', message: '登录态已保存，可继续自动识别' };
  }
  async function start(root, system, { manual = false } = {}) {
    if (sessions.has(key(root, system.id))) fail('已有登录操作，请先完成或取消', 409);
    const config = read(root, system.id);
    httpUrl(system.entryUrl);
    if (config.mode === 'none') fail('请先选择登录方式并保存配置');
    if (config.mode === 'sso' && !manual && !config.endpoint) fail('请先配置登录接口地址');
    if (
      !manual &&
      ['password', 'sso'].includes(config.mode) &&
      (!config.username || !config.password)
    )
      fail('请先配置登录账号和密码');
    const session = {
      key: key(root, system.id),
      status: 'opening',
      message: '正在打开登录',
      abort: new AbortController(),
    };
    sessions.set(session.key, session);
    try {
      if (config.mode === 'sso' && !manual) {
        const dir = businessLoginDir(root, system.id);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const result = await ssoLogin({
          dir,
          baseURL: system.entryUrl,
          signal: session.abort.signal,
          envMap: {
            ADMIN_USERNAME: config.username,
            ADMIN_PASSWORD: config.password,
            LOGIN_API_URL: httpUrl(config.endpoint, system.entryUrl),
            LOGIN_API_BODY: config.bodyTemplate,
            LOGIN_API_TOKEN_PATH: config.tokenPath,
            LOGIN_TOKEN_STORAGE_KEY: config.tokenStorageKey,
          },
        });
        session.abort.signal.throwIfAborted();
        if (!result.ok)
          fail(
            '接口登录失败，请检查接口地址、账号密码和 Token 提取配置；需要验证码时可改用手动登录',
          );
        const statePath = businessLoginStatePath(root, system.id);
        fs.chmodSync(statePath, 0o600);
        const latest = read(root, system.id);
        writePrivate(path.join(dir, 'config.json'), {
          ...latest,
          savedAt: new Date().toISOString(),
        });
        await closeSession(session);
        return {
          ...status(root, system),
          status: 'ready',
          message: '接口登录态已保存，可继续自动识别',
        };
      }
      const runtime = browserRuntime([
        system.sourceDir,
        fileURLToPath(new URL('../..', import.meta.url)),
        process.cwd(),
      ]);
      session.browser = await runtime.chromium.launch({ headless: false });
      session.abort.signal.throwIfAborted();
      session.context = await session.browser.newContext();
      session.browser.on('disconnected', () => {
        if (sessions.get(session.key) === session) {
          clearTimeout(session.timer);
          sessions.delete(session.key);
        }
      });
      session.timer = setTimeout(() => void closeSession(session), 15 * 60_000);
      session.timer.unref?.();
      const page = await session.context.newPage();
      await page.goto(config.loginUrl || system.entryUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      session.status = 'awaiting_login';
      session.message = '请在登录窗口完成登录或验证码，进入业务页面后点击「保存登录态」';
      if (config.mode === 'password' && !manual) {
        const username = page
          .locator(
            config.usernameSelector ||
              'input[autocomplete="username"],input[name="username"],input[type="email"],input[type="text"]',
          )
          .filter({ visible: true })
          .first();
        const password = page
          .locator(config.passwordSelector || 'input[type="password"]')
          .filter({ visible: true })
          .first();
        await username.fill(config.username, { timeout: 5000 });
        await password.fill(config.password, { timeout: 5000 });
        const captcha = page.locator(
          'input[autocomplete="one-time-code"]:visible,input[name*="captcha" i]:visible,input[placeholder*="验证码"]:visible',
        );
        if (!(await captcha.count())) {
          await page
            .locator(config.submitSelector || 'button[type="submit"],input[type="submit"]')
            .filter({ visible: true })
            .first()
            .click({ timeout: 5000 });
          await page.waitForTimeout(500);
          if (
            new URL(page.url()).origin === new URL(system.entryUrl).origin &&
            !(await hasLoginChallenge(page))
          )
            return await complete(root, system);
        }
      }
      return status(root, system);
    } catch (error) {
      // 页面选择器失败时仍保留窗口，用户可继续手动登录；不回显可能包含凭据的异常。
      if (!session.abort.signal.aborted && session.context && session.status === 'awaiting_login')
        return status(root, system);
      await closeSession(session);
      if (error.statusCode) throw error;
      fail('登录未完成，请检查系统入口或浏览器运行环境后重试');
    }
  }
  return {
    status,
    save,
    start,
    complete,
    invalidate: async (root, system) => {
      await closeSession(sessions.get(key(root, system.id)));
      fs.rmSync(businessLoginStatePath(root, system.id), { force: true });
      const config = read(root, system.id);
      if (config.revision)
        writePrivate(path.join(businessLoginDir(root, system.id), 'config.json'), {
          ...config,
          savedAt: '',
        });
    },
    cancel: async (root, system) => {
      await closeSession(sessions.get(key(root, system.id)));
      return status(root, system);
    },
    remove: async (root, system) => {
      await closeSession(sessions.get(key(root, system.id)));
      fs.rmSync(businessLoginDir(root, system.id), { recursive: true, force: true });
    },
    close: async () => {
      await Promise.all([...sessions.values()].map(closeSession));
    },
  };
}
