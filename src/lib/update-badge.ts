/**
 * 侧栏版本号旁的「可更新」圆点。
 *
 * 三种情况都要亮：
 * 1. npm 上有比服务端版本更新的版本（`hasUpdate`）；
 * 2. 服务端已经是新版本、但当前页面还是旧构建（`current !== APP_VERSION`）——
 *    更新完没刷新时就是这种，侧栏显示的版本号和真实服务对不上；
 * 3. 页面上没有版本号（不该发生，兜底隐藏）。
 *
 * 查询本身有服务端 30 分钟缓存，刚发版时可能一直返回「已是最新」，
 * 所以这里带 `refresh=1` 强制刷新，但同一标签页 5 分钟内只问一次 registry。
 * 服务正在重启 / 离线时请求会失败，退避重试几次，不要一次失败就永久隐藏。
 */
import { APP_VERSION } from './app-version';
import { OPEN_SETTINGS_EVENT } from './settings';
import { fetchUpdateInfo, startUpdate, type UpdateInfo } from './update';

const DOT_ID = 'tw-update-dot';
/** 同一标签页里真正问 registry 的最小间隔（服务端缓存是 30 分钟，这里更短才追得上发版） */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const LAST_CHECK_KEY = 'tw.update.badge.checked-at.v1';
/** 请求失败（服务重启中 / 离线）后的重试间隔与次数 */
const RETRY_MS = 15 * 1000;
const MAX_RETRIES = 4;

let retries = 0;
let retryTimer: number | null = null;
let checking = false;

/* ── 静默更新 ───────────────────────────────────────────────
 * 发现新版本时不再等用户点：后台直接跑 `lantern update`，页面继续用旧版本，
 * 等服务重启回来再自动刷新一次。锁写在 localStorage 里，多标签页不会重复触发。 */
const SILENT_LOCK_KEY = 'tw.update.silent.lock.v1';
/** 服务端已经是新版本、当前页面还是旧构建时，自动刷新的节流标记 */
const STALE_RELOAD_KEY = 'tw.update.stale.reload.v1';
/** 更新失败后多久再自动重试（同一版本），避免一直重装 */
const SILENT_RETRY_MS = 30 * 60 * 1000;
const POLL_MS = 2500;
/** 安装 + 重启的等待上限：npm 慢的时候会久一点 */
const POLL_TIMEOUT_MS = 6 * 60 * 1000;

let silentRunning = false;
/** 页面连的不是 lantern 自己的服务（或 dev 模式）时，本次页面不再尝试静默更新 */
let silentDisabled = false;

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function readSilentLock(): { version: string; at: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SILENT_LOCK_KEY) || 'null') as {
      version?: unknown;
      at?: unknown;
    } | null;
    if (!raw || typeof raw.version !== 'string') return null;
    return { version: raw.version, at: Number(raw.at) || 0 };
  } catch {
    return null;
  }
}

function writeSilentLock(version: string) {
  try {
    localStorage.setItem(SILENT_LOCK_KEY, JSON.stringify({ version, at: Date.now() }));
  } catch {
    /* 隐私模式：最多是多个标签页各试一次 */
  }
}

function clearSilentLock() {
  try {
    localStorage.removeItem(SILENT_LOCK_KEY);
  } catch {
    /* ignore */
  }
}

/** 更新进行中（可能在别的标签页触发）：不打日志、不重复启动安装 */
function updateInFlight(info: UpdateInfo): boolean {
  const phase = info.status?.phase;
  return phase === 'installing' || phase === 'restarting';
}

/**
 * 轮询到服务带着新版本回来 → 刷新页面。
 * 重启期间请求会失败（fetchUpdateInfo 返回 null），继续等即可。
 */
async function waitForUpdatedVersion(latest: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const next = await fetchUpdateInfo(true);
    if (!next) continue;
    if (next.status?.phase === 'failed') return false;
    const arrived =
      Boolean(latest) && Boolean(next.current) && next.current === latest && !next.hasUpdate;
    if (arrived || next.status?.phase === 'done') {
      if (next.hasUpdate && next.status?.phase === 'done') {
        // 状态说完成、registry 还说有新版（缓存没刷）：再等下一轮，别反复刷新
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * 服务端已经升级完，但当前页还是旧构建（更新期间一直没刷新的标签页）：
 * 直接刷新一次，顺带拿到新版本的前端资源。60 秒内只刷一次，避免死循环。
 */
function reloadIfStalePage(info: UpdateInfo) {
  if (info.mode === 'dev') return;
  if (silentRunning || updateInFlight(info)) return;
  if (!info.current || info.current === APP_VERSION) return;
  try {
    const at = Number(localStorage.getItem(STALE_RELOAD_KEY)) || 0;
    if (Date.now() - at < 60_000) return;
    localStorage.setItem(STALE_RELOAD_KEY, String(Date.now()));
  } catch {
    /* 隐私模式：不做节流，最多刷新一次 */
  }
  window.location.reload();
}

async function silentUpdate(info: UpdateInfo, dot: HTMLElement) {
  if (silentDisabled || silentRunning) return;
  if (info.mode === 'dev') {
    silentDisabled = true;
    return;
  }
  const inFlight = updateInFlight(info);
  if (!inFlight) {
    if (!info.hasUpdate || !info.latest) return;
    const lock = readSilentLock();
    if (lock?.version === info.latest && Date.now() - lock.at < SILENT_RETRY_MS) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    writeSilentLock(info.latest);
  }

  silentRunning = true;
  // 更新期间侧栏版本号保持高亮，明确告诉用户「在后台升级」
  dot.hidden = false;
  dot.closest('.tw-nav-brand-ver')?.classList.add('has-update');
  dot.setAttribute('aria-label', `正在后台更新到 v${info.latest || ''}`);

  try {
    if (!inFlight) {
      const started = await startUpdate(info.latest);
      if (!started.ok) {
        // 不是本进程托管的服务 / 已有更新在进行：这次不重试，避免无意义的轮询
        silentDisabled = true;
        return;
      }
    }
    const ok = await waitForUpdatedVersion(info.latest);
    if (ok) {
      clearSilentLock();
      window.location.reload();
      return;
    }
    // 失败 / 超时：保留锁并刷新时间戳，SILENT_RETRY_MS 后再试
    writeSilentLock(info.latest || info.current);
  } finally {
    silentRunning = false;
  }
}

function lastCheckedAt(): number {
  try {
    return Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
  } catch {
    return 0;
  }
}

function markChecked() {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    /* 隐私模式写不进去就不用节流 */
  }
}

function setBadge(dot: HTMLElement, latest: string, visible: boolean) {
  dot.hidden = !visible;
  // 版本号胶囊同步高亮：只有一个 6px 圆点太容易被忽略
  dot.closest('.tw-nav-brand-ver')?.classList.toggle('has-update', visible);
  if (visible)
    dot.setAttribute('aria-label', latest ? `有新版本可用 v${latest}` : '有新版本可更新');
}

function scheduleRetry(dot: HTMLElement, force: boolean) {
  if (retries >= MAX_RETRIES) return;
  retries += 1;
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void check(dot, force);
  }, RETRY_MS);
}

async function check(dot: HTMLElement, force: boolean) {
  if (checking) return;
  checking = true;
  try {
    const info = await fetchUpdateInfo(force);
    if (!info) {
      // 服务重启 / 断网：保持当前显示，稍后再试
      scheduleRetry(dot, force);
      return;
    }
    retries = 0;
    markChecked();
    const stalePage = Boolean(info.current) && info.current !== APP_VERSION;
    setBadge(dot, info.latest, Boolean(info.hasUpdate) || stalePage);
    // 有新版本（或上次更新还没跑完）就静默升掉，完成后自动刷新
    void silentUpdate(info, dot);
    if (!info.hasUpdate) reloadIfStalePage(info);
  } finally {
    checking = false;
  }
}

function bind() {
  const dot = document.getElementById(DOT_ID);
  if (!dot) return;
  if (dot.dataset.bound !== '1') {
    dot.dataset.bound = '1';
    dot.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { tab: 'general' } }));
    });
  }
  // 5 分钟内已经问过 registry 就走服务端缓存，避免每次翻页都打一次
  const force = Date.now() - lastCheckedAt() > CHECK_INTERVAL_MS;
  retries = 0;
  void check(dot, force);
}

export function initUpdateBadge() {
  document.addEventListener('astro:page-load', bind);
  // 切回标签页时再看一眼：更新完成 / 刚发版都能及时亮起来
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') bind();
  });
  if (document.readyState !== 'loading') bind();
}
