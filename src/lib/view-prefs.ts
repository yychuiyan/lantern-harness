/**
 * 页面内「视图偏好」记忆：Tab、分组方式、状态 / 优先级筛选、搜索词、排序方式
 * 这类纯前端的展示选择。
 *
 * 存 localStorage 并按数据空间分键（`spaceScopedKey`），所以刷新、重开页面、
 * 切回同一个空间都会回到上次看的样子；换空间各记各的。
 * 枚举型读回时一律用调用方给的候选值校验，非法 / 缺失都回退默认值。
 */
import { spaceScopedKey } from './space-scope';

const KEY_PREFIX = 'tw.view.';

/** 读取偏好；缺失 / 非法 / 存储不可用时回退默认值 */
export function readViewPref<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const raw = localStorage.getItem(spaceScopedKey(`${KEY_PREFIX}${name}.v1`));
    return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 保存偏好；非法值直接拒绝，写入失败静默（隐私模式等不影响使用） */
export function writeViewPref(name: string, value: string): void {
  try {
    localStorage.setItem(spaceScopedKey(`${KEY_PREFIX}${name}.v1`), value);
  } catch {
    // 忽略：写不进去就只在本次会话生效
  }
}

/** 搜索词这类自由输入的上限：足够正常使用，也避免把超长串写进本地存储 */
const TEXT_MAX = 200;

/** 读取自由文本偏好（搜索词）；缺失 / 存储不可用时回退默认值 */
export function readViewText(name: string, fallback = ''): string {
  try {
    return localStorage.getItem(spaceScopedKey(`${KEY_PREFIX}${name}.v1`)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** 保存自由文本偏好；空串等同清空，写入失败静默 */
export function writeViewText(name: string, value: string): void {
  try {
    const key = spaceScopedKey(`${KEY_PREFIX}${name}.v1`);
    const text = value.slice(0, TEXT_MAX);
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // 忽略：写不进去就只在本次会话生效
  }
}
