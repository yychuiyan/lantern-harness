/**
 * 表格顶栏「字段」显隐：按空间记 hidden key 列表；始终显示的列不可关。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { readViewJson, writeViewJson } from '../../lib/view-prefs';

export type TableFieldOption = { key: string; label: string };

/** 默认始终显示：勾选 / 标题 / 填充 / 操作 */
export const TABLE_COL_ALWAYS_DEFAULT = new Set(['select', 'title', 'filler', 'action']);

/**
 * @param prefKey 经 spaceScopedKey / 页面约定后的偏好名
 * @param fields 可配置显隐的字段（不含始终显示列）
 * @param alwaysKeys 不可隐藏的列 key
 */
export function useTableFieldVisibility(
  prefKey: string,
  fields: readonly TableFieldOption[],
  alwaysKeys: ReadonlySet<string> = TABLE_COL_ALWAYS_DEFAULT,
) {
  const fieldKeys = useMemo(() => new Set(fields.map((f) => f.key)), [fields]);
  const [hidden, setHidden] = useState<string[]>(() => {
    const raw = readViewJson<unknown>(prefKey, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((k): k is string => typeof k === 'string' && fieldKeys.has(k));
  });

  useEffect(() => {
    setHidden((prev) => {
      const next = prev.filter((k) => fieldKeys.has(k));
      return next.length === prev.length ? prev : next;
    });
  }, [fieldKeys]);

  const isVisible = useCallback(
    (key: string) => {
      if (alwaysKeys.has(key)) return true;
      if (!fieldKeys.has(key)) return true;
      return !hidden.includes(key);
    },
    [alwaysKeys, fieldKeys, hidden],
  );

  const toggle = useCallback(
    (key: string) => {
      if (alwaysKeys.has(key) || !fieldKeys.has(key)) return;
      setHidden((prev) => {
        const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
        writeViewJson(prefKey, next);
        return next;
      });
    },
    [alwaysKeys, fieldKeys, prefKey],
  );

  return { isVisible, toggle, hidden, fields };
}

/** 过滤表格 col 定义：只保留始终显示 + 当前可见的可配置列 */
export function filterTableCols<T extends { key: string }>(
  cols: readonly T[],
  isVisible: (key: string) => boolean,
): T[] {
  return cols.filter((c) => isVisible(c.key));
}

/** 顶栏「字段」按钮：勾选显示 / 隐藏列 */
export function TableFieldConfigButton(props: {
  fields: readonly TableFieldOption[];
  isVisible: (key: string) => boolean;
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="字段配置"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors ${
          open
            ? 'border-[#3370ff]/40 bg-[#e1eaff] text-[#1f4ec2]'
            : 'border-stone-200 text-stone-600 hover:bg-stone-50 hover:text-stone-800'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h10M4 18h14" />
        </svg>
        字段
      </button>
      {open ? (
        <div className="tw-select-menu absolute right-0 z-80 mt-1 w-52 overflow-hidden rounded-lg bg-white p-1 shadow-lg ring-1 ring-stone-200">
          <div className="px-2.5 py-1.5 text-[11px] font-medium tracking-wide text-stone-400">
            显示字段
          </div>
          {props.fields.map((f) => {
            const on = props.isVisible(f.key);
            return (
              <label
                key={f.key}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => props.onToggle(f.key)}
                  className="rounded border-stone-300 text-[#4176e6] focus:ring-[#4176e6]/40"
                />
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
