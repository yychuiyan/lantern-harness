/**
 * 侧栏版本号旁的「可更新」圆点。
 *
 * 每次页面加载（含 View Transitions 软导航）静默查一次，
 * 失败就保持隐藏：离线或服务重启期间不应该冒红点或弹错误。
 */
import { OPEN_SETTINGS_EVENT } from './settings';
import { fetchUpdateInfo } from './update';

const DOT_ID = 'tw-update-dot';

function hide(dot: HTMLElement) {
  dot.hidden = true;
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
  void (async () => {
    const info = await fetchUpdateInfo();
    if (!info || !info.hasUpdate) return hide(dot);
    dot.hidden = false;
  })();
}

export function initUpdateBadge() {
  document.addEventListener('astro:page-load', bind);
  if (document.readyState !== 'loading') bind();
}
