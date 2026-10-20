/**
 * 提示词「引用中」首帧缓存（sessionStorage）。
 *
 * 提示词库是 client:only 岛屿：刷新时 list 有缓存能立刻画出来，
 * 但「哪些提示词被插件挂载」要等 /uiauto 接口回来才知道，
 * 于是「引用中」会先消失再出现。这里把上次算好的挂载表存一份，
 * 首帧直接按它标注；后台刷新拿到权威值后覆盖。
 */
import { spaceScopedKey } from './space-scope';

const KEY = 'tw.prompts.mounted.v1';

export function readMountedPromptsCache(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(spaceScopedKey(KEY));
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [path, owner] of Object.entries(data)) {
      if (typeof path === 'string' && typeof owner === 'string') out[path] = owner;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeMountedPromptsCache(map: Record<string, string>): void {
  try {
    sessionStorage.setItem(spaceScopedKey(KEY), JSON.stringify(map));
  } catch {
    // 隐私模式写不进去：忽略，下次刷新仍可能闪一下
  }
}
