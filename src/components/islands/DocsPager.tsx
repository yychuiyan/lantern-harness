/**
 * 文档库分页条：页码信息 + 每页条数选择器 + 首页/上一页/下一页/末页。
 *
 * 各文档库页面共用；usePageSize 负责「每页条数」的取值与持久化。
 */
import { useCallback, useState } from 'react';
import {
  isPageSizeOption,
  PAGE_SIZE_OPTIONS,
  readPageSize,
  writePageSize,
} from '../../lib/docs-page-size';
import SelectDropdown from './SelectDropdown';

const BTN_CLS =
  'h-8 px-3 shrink-0 whitespace-nowrap text-sm text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer';

/** 每页条数下拉项（SelectDropdown 的取值为字符串） */
const PAGE_SIZE_CHOICES: ReadonlyArray<{ value: string; label: string }> = PAGE_SIZE_OPTIONS.map(
  (n) => ({ value: String(n), label: String(n) }),
);

/**
 * 每页条数状态：初值取已保存偏好（缺失 / 非法时用页面默认值），变更即持久化。
 * 默认与各文档库共用一个键；其它页面可传 storageKey 用自己的键。
 */
export function usePageSize(defaultSize: number, storageKey?: string) {
  const [pageSize, setPageSizeState] = useState(() => readPageSize(defaultSize, storageKey));

  const setPageSize = useCallback(
    (n: number) => {
      if (!isPageSizeOption(n)) return;
      writePageSize(n, storageKey);
      setPageSizeState(n);
    },
    [storageKey],
  );

  return [pageSize, setPageSize] as const;
}

export default function DocsPager({
  page,
  totalPages,
  pageSize,
  busy = false,
  onPage,
  onPageSize,
  className = '',
}: {
  /** 当前页（已钳制到有效范围） */
  page: number;
  totalPages: number;
  pageSize: number;
  busy?: boolean;
  onPage: (page: number) => void;
  /** 切换每页条数（调用方需同时把页码归 1） */
  onPageSize: (size: number) => void;
  /** 覆盖外层间距等 */
  className?: string;
}) {
  return (
    <div
      className={`shrink-0 px-4 py-3 border-t border-stone-100 flex items-center justify-between gap-2 flex-wrap ${className}`.trim()}
    >
      <span className="text-xs text-stone-500 flex items-center gap-1.5">
        <span>
          第 {page} / {totalPages} 页 ·
        </span>
        <SelectDropdown
          compact
          centerContent
          options={PAGE_SIZE_CHOICES}
          value={String(pageSize)}
          onChange={(v) => onPageSize(Number(v))}
          disabled={busy}
          ariaLabel="每页条数"
          showCheck={false}
          className="w-18"
        />
        <span>条</span>
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={busy || page <= 1}
          onClick={() => onPage(1)}
          className={BTN_CLS}
        >
          首页
        </button>
        <button
          type="button"
          disabled={busy || page <= 1}
          onClick={() => onPage(page - 1)}
          className={BTN_CLS}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={busy || page >= totalPages}
          onClick={() => onPage(page + 1)}
          className={BTN_CLS}
        >
          下一页
        </button>
        <button
          type="button"
          disabled={busy || page >= totalPages}
          onClick={() => onPage(totalPages)}
          className={BTN_CLS}
        >
          末页
        </button>
      </div>
    </div>
  );
}
