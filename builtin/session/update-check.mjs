/**
 * 版本检测与更新状态的共享逻辑（本地服务插件 + CLI 共用）。
 *
 * 只做四件事，且都不改任何业务数据：
 * 1. 版本号比较（段位数字，支持 `v` 前缀与预发布后缀）
 * 2. 向 npm registry 查最新版本（30 分钟缓存，可强制刷新）
 * 3. 判断当前包是怎么装的（npx / 全局 / 源码），以及全局安装位置
 * 4. 读写「正在更新」状态文件，让重启后的新进程能接上未完成的升级
 *
 * 网络失败一律降级为 `error` 字段，不抛出：页面只是少一个更新标记，
 * 不该因为公司网络连不上 registry 就报错。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';

import { getUserConfigDir } from '../../cli/user-config.mjs';

/** 最新版本缓存：同一进程内 30 分钟内不再打 registry */
export const CHECK_TTL_MS = 30 * 60 * 1000;
/** 状态文件里 `installing` 超过这个时间视为上一次升级中断 */
export const STATUS_STALE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/* ---------------------------- 版本号 ---------------------------- */

/**
 * 语义化版本比较：返回 -1 / 0 / 1。
 * 只按数字段比较，预发布（`1.0.0-beta.1`）视为小于同段正式版；
 * 段数不同按 0 补齐（`0.1` 等价 `0.1.0`）。
 * @param {string} [a]
 * @param {string} [b]
 */
export function compareVersions(a, b) {
  const parse = (raw) => {
    const text = String(raw ?? '')
      .trim()
      .replace(/^[vV]/, '');
    const [core, pre = ''] = text.split('-', 2);
    const nums = core
      .split('.')
      .map((x) => Number.parseInt(x, 10))
      .map((x) => (Number.isFinite(x) ? x : 0));
    return { nums, pre: pre.trim() };
  };
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = left.nums[i] ?? 0;
    const y = right.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // 正式版大于预发布：1.0.0 > 1.0.0-beta
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  if (left.pre === right.pre) return 0;
  return left.pre > right.pre ? 1 : -1;
}

/** 是否有可用的新版本（本地版本更高或相等都算没有） */
export function hasUpdate(latest, current) {
  if (!latest || !current) return false;
  return compareVersions(latest, current) > 0;
}

/* ------------------------- 安装方式与包管理器 ------------------------- */

/** 进程内缓存：pnpm / npm 的检测要 spawn 子进程，没必要每次请求都跑 */
let packageManagerCache = '';

/**
 * pnpm 是否「可用于全局安装」：既要有 pnpm，也要它的全局 bin 目录已在 PATH 上。
 * 没执行过 pnpm setup 时 `pnpm add -g` 会直接报 ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH，
 * 此时退避到 npm，否则用户会装不上（npm 随 Node 一起安装，必然可用）。
 */
export function isPnpmGlobalReady() {
  const probe = spawnSync('pnpm', ['bin', '-g'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return !probe.error && probe.status === 0;
}

/** 优先 pnpm（可直接用于全局安装时）；否则回退 npm */
export function resolvePackageManager() {
  // 每个页面加载都会问一次；缓存住，省掉重复 spawn pnpm 的开销
  if (!packageManagerCache) {
    packageManagerCache = isPnpmGlobalReady() ? 'pnpm' : 'npm';
  }
  return packageManagerCache;
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.error || r.status !== 0) return '';
  return String(r.stdout ?? '').trim();
}

const globalRootCache = new Map();

/**
 * 全局包的 node_modules 根目录；解析不到时返回空串。
 * npm：`npm root -g`；pnpm：`pnpm root -g`。
 * @param {string} pm
 */
export function resolveGlobalRoot(pm) {
  const key = pm || 'npm';
  if (globalRootCache.has(key)) return globalRootCache.get(key);
  const out =
    key === 'pnpm' ? runCapture('pnpm', ['root', '-g']) : runCapture('npm', ['root', '-g']);
  globalRootCache.set(key, out);
  return out;
}

/**
 * 全局安装的 `lantern` 可执行文件路径；找不到返回空串。
 * npm：`npm prefix -g`（Windows 下可执行文件直接在 prefix 里，其它平台在 prefix/bin）；
 * pnpm：`pnpm bin -g` 本身就是 bin 目录。
 * @param {string} pm
 */
export function resolveGlobalCli(pm) {
  const exe = process.platform === 'win32' ? 'lantern.cmd' : 'lantern';
  let dir = '';
  if (pm === 'pnpm') {
    dir = runCapture('pnpm', ['bin', '-g']);
  } else {
    const prefix = runCapture('npm', ['prefix', '-g']);
    if (prefix) dir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  }
  if (!dir) return '';
  const candidate = path.join(dir, exe);
  return fs.existsSync(candidate) ? candidate : '';
}

/**
 * 判断当前进程读到的包是怎么装的：
 * - `npx`：npx 临时缓存（`~/.npm/_npx/<hash>/node_modules/…`），装完不会自动替换
 * - `global`：包目录位于全局 node_modules 下，可以直接全局替换
 * - `dev`：仓库源码 / 其它本地安装，不能从页面里一键更新
 * @param {string} pkgRoot 包根目录（含 package.json）
 * @param {string} [pm] 不传则现算
 * @param {string} [globalRootOverride] 测试注入的全局 node_modules 根
 * @returns {'npx' | 'global' | 'dev'}
 */
export function detectInstallMode(pkgRoot, pm, globalRootOverride) {
  const abs = path.resolve(pkgRoot || '');
  if (!abs) return 'dev';
  if (abs.split(path.sep).includes('_npx')) return 'npx';
  const root =
    globalRootOverride === undefined
      ? resolveGlobalRoot(pm || resolvePackageManager())
      : globalRootOverride;
  if (root && (abs === root || abs.startsWith(`${root}${path.sep}`))) return 'global';
  // 解析不到全局根时退回结构判断；仍不确定就按源码处理（宁可只提示）
  return 'dev';
}

/* ------------------------------ 代理 ------------------------------ */

/**
 * 国内常见环境：系统挂了代理（Clash / Surge 等），浏览器能上 npm，
 * 但 Node 的 fetch（undici）**不读系统代理，也不读 HTTP(S)_PROXY**（Node 22 及更早），
 * 于是页面里的「检查更新」直接 `fetch failed`。
 *
 * 这里按顺序找代理：环境变量 → npm 配置 → macOS 系统代理（scutil）。
 * 只支持 http(s) 代理；socks 需要额外代理进程，直接跳过并走直连。
 */
const proxyCache = { resolved: false, url: '' };

/** @returns {string} 形如 `http://127.0.0.1:1082`，没有则空串 */
export function resolveProxyUrl() {
  if (proxyCache.resolved) return proxyCache.url;
  proxyCache.resolved = true;
  const pick = (...names) => {
    for (const name of names) {
      const v = (process.env[name] || '').trim();
      if (v) return v;
    }
    return '';
  };
  let candidate = pick(
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'HTTP_PROXY',
    'http_proxy',
  );
  if (!candidate) {
    for (const key of ['https-proxy', 'proxy']) {
      const raw = runCapture('npm', ['config', 'get', key]);
      if (raw && /^https?:\/\//i.test(raw)) {
        candidate = raw;
        break;
      }
    }
  }
  if (!candidate && process.platform === 'darwin') {
    // scutil --proxy 是 macOS 读系统代理的官方途径；输出是类似 plist 的键值对
    const out = runCapture('scutil', ['--proxy']);
    const on = /HTTPSEnable\s*:\s*1/.test(out);
    const host = /HTTPSProxy\s*:\s*(\S+)/.exec(out)?.[1] ?? '';
    const port = /HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1] ?? '';
    if (on && host && port) candidate = `http://${host}:${port}`;
  }
  // socks / pac 暂不支持：交给直连，失败时按网络问题提示
  proxyCache.url = /^https?:\/\//i.test(candidate) ? candidate : '';
  return proxyCache.url;
}

/** 给子进程（npm / pnpm 安装）补上代理环境变量；已有环境变量时不覆盖 */
export function proxyEnv() {
  const url = resolveProxyUrl();
  if (!url) return {};
  const env = {};
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) env.HTTPS_PROXY = url;
  if (!process.env.HTTP_PROXY && !process.env.http_proxy) {
    env.HTTP_PROXY = url;
    env.http_proxy = url;
  }
  return env;
}

/**
 * 走 HTTP 代理 CONNECT 隧道拿 HTTPS 响应，返回解析后的 JSON。
 * 不引入 undici 依赖：包发布后 node_modules 布局不可控，内置模块最稳。
 *
 * 隧道建好后直接说 HTTP/1.1，而不是把 socket 交给 https.request：
 * 后者会自己做 TLS/SNI 与 ALPN 协商，遇到只按 SNI 路由的本地代理容易握错证书。
 */
function getJsonViaProxy(targetUrl, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy = new URL(proxyUrl);
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const targetPort = Number(target.port) || 443;
    const targetPath = `${target.pathname}${target.search}`;

    let settled = false;
    let socket;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`代理连接超时（${proxy.host}）`)),
      Math.max(timeoutMs, 2000),
    );

    socket = net.connect({ host: proxy.hostname, port: proxyPort });
    socket.on('error', (e) => finish(new Error(`代理连接失败：${e.message}`)));
    socket.once('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${target.hostname}:${targetPort}\r\n${auth}\r\n`,
      );
    });

    // 阶段一：读 CONNECT 的响应头，多读到的字节要留给 TLS（这里通常没有）
    let handshake = '';
    const onHandshake = (chunk) => {
      handshake += chunk.toString('latin1');
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onHandshake);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(handshake)?.[1] ?? 0);
      if (status !== 200) {
        finish(new Error(`代理拒绝连接（HTTP ${status || '?'}）`));
        return;
      }
      const leftover = Buffer.from(handshake.slice(end + 4), 'latin1');
      openTunnel(leftover);
    };
    socket.on('data', onHandshake);

    // 阶段二：在隧道上做 TLS，再按 HTTP/1.1 取一次
    function openTunnel(leftover) {
      const secured = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['http/1.1'],
      });
      secured.on('error', (e) => finish(new Error(`TLS 失败：${e.message}`)));
      secured.once('secureConnect', () => {
        if (leftover.length) secured.unshift(leftover);
        secured.write(
          `GET ${targetPath} HTTP/1.1\r\nHost: ${target.hostname}\r\n` +
            'Accept: application/json\r\nConnection: close\r\n\r\n',
        );
      });
      const chunks = [];
      secured.on('data', (c) => chunks.push(c));
      secured.on('end', () => {
        try {
          finish(null, parseHttpJson(Buffer.concat(chunks)));
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      });
    }
  });
}

/** 把完整的 HTTP/1.1 响应解析成 JSON（支持 chunked，忽略压缩） */
export function parseHttpJson(raw) {
  const text = raw.toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  if (split === -1) throw new Error('代理返回内容不完整');
  const head = text.slice(0, split);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  if (status >= 400 || status === 0) throw new Error(`HTTP ${status || '?'}`);
  let body = text.slice(split + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    let out = '';
    let rest = body;
    while (rest.length) {
      const eol = rest.indexOf('\r\n');
      if (eol === -1) break;
      const size = Number.parseInt(rest.slice(0, eol).trim(), 16);
      if (!Number.isFinite(size) || size <= 0) break;
      out += rest.slice(eol + 2, eol + 2 + size);
      rest = rest.slice(eol + 2 + size + 2);
    }
    body = out;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('返回内容不是合法 JSON');
  }
}

/** 直连拿 JSON（undici fetch），失败抛出原始错误 */
async function getJsonDirect(targetUrl, timeoutMs) {
  const res = await fetch(targetUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---------------------------- registry ---------------------------- */

/** npm 配置的 registry，统一补上结尾斜杠；读不到用官方源 */
export function readRegistry() {
  const raw = runCapture('npm', ['config', 'get', 'registry']);
  if (!raw || raw === 'undefined' || raw === 'null' || !/^https?:\/\//i.test(raw)) {
    return DEFAULT_REGISTRY;
  }
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/** @type {{ latest: string, checkedAt: number, error: string, registry: string } | null} */
let latestCache = null;

/**
 * 查最新版本。失败返回 `{ latest: '', error }`，不抛出。
 * @param {{ force?: boolean }} [opts]
 */
export async function fetchLatestVersion(opts = {}) {
  const now = Date.now();
  if (!opts.force && latestCache && now - latestCache.checkedAt < CHECK_TTL_MS) {
    return { ...latestCache };
  }
  const registry = readRegistry();
  const url = `${registry}${encodeURIComponent('lantern-harness')}/latest`;
  try {
    const proxy = resolveProxyUrl();
    let data;
    try {
      // 有代理先走代理：Node 的 fetch 不认系统代理，直连在这类网络下必然失败
      data = proxy
        ? await getJsonViaProxy(url, proxy, FETCH_TIMEOUT_MS)
        : await getJsonDirect(url, FETCH_TIMEOUT_MS);
    } catch (proxied) {
      if (!proxy) throw proxied;
      // 代理坏了也别把「能直连」的网络堵死（比如代理已退出但系统设置还留着）
      data = await getJsonDirect(url, FETCH_TIMEOUT_MS);
    }
    const latest = typeof data?.version === 'string' ? data.version.trim() : '';
    if (!latest) throw new Error('返回内容缺少 version');
    latestCache = { latest, checkedAt: now, error: '', registry };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // `fetch failed` 对用户没有信息量：补一句该往哪查
    const hint = /fetch failed|timeout|ENOTFOUND|ECONNREFUSED|timed out/i.test(message)
      ? `无法连接 ${registry}（检查代理设置，或把 npm registry 换成可用镜像）`
      : message;
    latestCache = { latest: '', checkedAt: now, error: hint, registry };
  }
  return { ...latestCache };
}

/** 测试用：清掉版本缓存 */
export function __resetUpdateCheckCache() {
  latestCache = null;
  packageManagerCache = '';
  globalRootCache.clear();
  proxyCache.resolved = false;
  proxyCache.url = '';
}

/* --------------------------- 更新状态文件 --------------------------- */

export function getUpdateStatusPath() {
  return path.join(getUserConfigDir(), 'update-status.json');
}

/**
 * 读上一次更新的状态。文件缺失 / 损坏都返回 null；
 * `installing` 停留过久视为上次中断，标记为 failed，避免界面一直转圈。
 */
export function readUpdateStatus() {
  const file = getUpdateStatusPath();
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const phase = String(raw.phase ?? '');
    if (!['installing', 'restarting', 'done', 'failed'].includes(phase)) return null;
    const status = {
      phase,
      from: String(raw.from ?? ''),
      to: String(raw.to ?? ''),
      startedAt: String(raw.startedAt ?? ''),
      finishedAt: String(raw.finishedAt ?? ''),
      error: String(raw.error ?? ''),
    };
    if (phase === 'installing' || phase === 'restarting') {
      const started = Date.parse(status.startedAt);
      if (Number.isFinite(started) && Date.now() - started > STATUS_STALE_MS) {
        return {
          ...status,
          phase: 'failed',
          error: status.error || '更新未完成（服务可能已中断），请重试或使用 lantern update',
        };
      }
    }
    return status;
  } catch {
    return null;
  }
}

/**
 * 写更新状态（先写临时文件再改名，避免读到半份 JSON）。
 * @param {{ phase: 'installing' | 'restarting' | 'done' | 'failed', from?: string, to?: string, error?: string }} patch
 */
export function writeUpdateStatus(patch) {
  const prev = readUpdateStatus() ?? {
    phase: 'installing',
    from: '',
    to: '',
    startedAt: '',
    finishedAt: '',
    error: '',
  };
  const now = new Date().toISOString();
  const next = {
    phase: patch.phase,
    from: patch.from ?? prev.from,
    to: patch.to ?? prev.to,
    // 开始新一轮时重置计时；done / failed 保留原开始时间
    startedAt: patch.phase === 'installing' ? now : prev.startedAt || now,
    finishedAt: patch.phase === 'done' || patch.phase === 'failed' ? now : '',
    error: patch.error ?? '',
  };
  try {
    const file = getUpdateStatusPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 状态文件写不了不影响更新本身
  }
  return next;
}

/** 清掉更新状态（例如用户已确认刷新） */
export function clearUpdateStatus() {
  try {
    const file = getUpdateStatusPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

/** 更新日志里给用户看的路径 */
export function updateLogHint() {
  return path.join(getUserConfigDir(), 'logs', 'server.log');
}

/** 平台无关的临时目录（detached 子进程的 cwd，避开要替换的包目录） */
export function detachedCwd() {
  return os.tmpdir() || os.homedir();
}
