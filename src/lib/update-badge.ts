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
import { fetchUpdateInfo } from './update';

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
