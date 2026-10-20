/**
 * 首屏 / 刷新时的 DOM 缓存。
 *
 * `client:only` 的岛屿（侧栏菜单、自动化测试页）在 JS 跑起来之前是空的，
 * 每次刷新都会先闪一下空白再长出内容。这里把上一次渲染好的 HTML 存进
 * localStorage，页面解析到岛屿位置时用内联脚本原样铺一遍，React 挂载后再撤掉，
 * 于是「刷新」看到的是上一次的样子，数据仍由岛屿挂载后重新拉取。
 *
 * 内联脚本不能 import，键的拼法与 `spaceScopedKey` 保持一致（见 HydrateCache.astro）。
 */
import { spaceScopedKey } from './space-scope';

/** 单个缓存的体积上限：超过就不存，避免把 localStorage 写满 */
const MAX_HTML = 160_000;

export function hydrateCacheKey(name: string): string {
  return spaceScopedKey(`tw.hydrate.${name}`);
}

export function writeHydrateCache(name: string, html: string): void {
  const value = String(html || '').trim();
  if (!value || value.length > MAX_HTML) return;
  try {
    localStorage.setItem(hydrateCacheKey(name), value);
  } catch {
    // 配额满 / 隐私模式：忽略
  }
}

export function clearHydrateCache(name: string): void {
  try {
    localStorage.removeItem(hydrateCacheKey(name));
  } catch {
    // ignore
  }
}
