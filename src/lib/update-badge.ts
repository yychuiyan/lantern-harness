/**
 * 侧栏版本号旁的「可更新」圆点。
 *
 * 只做探测与提示，不做自动更新：是否升级由用户在「设置 → 通用 → 平台版本」
 * 里点「更新并重启」决定。
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
import { fetchUpdateInfo, type UpdateInfo } from './update';

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

/* ── 旧构建自动刷新 ─────────────────────────────────────────
 * 用户在别处（终端 / 另一个标签页）完成更新后，服务端已是新版本、
 * 当前页面还是旧构建：自动刷新一次拿到新资源。 */
/** 服务端已经是新版本、当前页面还是旧构建时，自动刷新的节流标记 */
const STALE_RELOAD_KEY = 'tw.update.stale.reload.v1';

/** 更新进行中（可能在别的标签页触发）：不触发旧构建刷新 */
function updateInFlight(info: UpdateInfo): boolean {
  const phase = info.status?.phase;
  return phase === 'installing' || phase === 'restarting';
}

/**
 * 只在项目本地启动的服务（dev）里处理「旧页面挂着旧构建」：
 * 当前服务已经切到新前端、当前标签页还是旧资源时，自动刷新一次拿到新构建。
 *
 * npm / 全局安装仍保持手动更新：这里只解决 dev 场景里切页还带着旧前端的问题，
 * 不改变「设置里手动更新并重启」这条链路。60 秒内只刷一次，避免死循环。
 */
function reloadIfStalePage(info: UpdateInfo) {
  if (info.mode !== 'dev') return;
  if (updateInFlight(info)) return;
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
    // 只提示，不自动装：npm / 全局安装仍走设置页「更新并重启」。
    // dev 模式里若当前页已落后于本地服务，就自动刷新到当前服务版本，
    // 避免切页后还继续带着旧构建。
    if (stalePage) reloadIfStalePage(info);
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
