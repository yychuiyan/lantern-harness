/**
 * 文档库「每页条数」偏好：可选档位 + localStorage 记忆（按数据空间分键）。
 *
 * 纯函数模块（不含 React）；配套 hook 见 DocsPager 的 usePageSize。
 * localStorage 属不可信输入，读回时必须校验档位是否合法。
 */
import { spaceScopedKey } from './space-scope';

/** 可选档位：覆盖现有两个默认值（10 条 / 5 条） */
export const PAGE_SIZE_OPTIONS = [5, 10, 20, 50] as const;

export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

const STORAGE_KEY = 'tw.docs.page-size.v1';

/** 是否为允许的档位 */
export function isPageSizeOption(n: unknown): n is PageSizeOption {
  return typeof n === 'number' && (PAGE_SIZE_OPTIONS as readonly number[]).includes(n);
}

/** 读取已保存的每页条数；缺失 / 非法 / 存储不可用时回退到页面默认值 */
export function readPageSize(defaultSize: number, storageKey: string = STORAGE_KEY): number {
  try {
    const raw = localStorage.getItem(spaceScopedKey(storageKey));
    const n = raw === null ? NaN : Number(raw);
    return isPageSizeOption(n) ? n : defaultSize;
  } catch {
    return defaultSize;
  }
}

/** 保存每页条数；非法值直接拒绝，写入失败静默（隐私模式等不影响使用） */
export function writePageSize(n: number, storageKey: string = STORAGE_KEY): void {
  if (!isPageSizeOption(n)) return;
  try {
    localStorage.setItem(spaceScopedKey(storageKey), String(n));
  } catch {
    // 忽略：写不进去就只在本次会话生效
  }
}
