/**
 * 多选下拉：勾选列表；可选芯片输入样式与搜索过滤。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import OverflowHint from './OverflowHint';

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface Props {
  options: MultiSelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  /** 触发器展示已选芯片（输入框样式）；默认摘要一行 */
  chips?: boolean;
  /** 下拉内按标签过滤 */
  searchable?: boolean;
  searchPlaceholder?: string;
}

export default function MultiSelectDropdown({
  options,
  values,
  onChange,
  placeholder = '选择…',
  disabled = false,
  chips = false,
  searchable = false,
  searchPlaceholder = '搜索…',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open || !searchable) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, searchable]);

  const selected = useMemo(
    () => options.filter((o) => values.includes(o.value)),
    [options, values],
  );
  const selectedLabels = selected.map((o) => o.label);
  const summary = disabled
    ? placeholder
    : selectedLabels.length === 0
      ? placeholder
      : selectedLabels.length <= 2
        ? selectedLabels.join('、')
        : `已选 ${selectedLabels.length} 项`;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  function toggle(v: string) {
    if (values.includes(v)) onChange(values.filter((x) => x !== v));
    else onChange([...values, v]);
  }

  function remove(v: string, e: MouseEvent) {
    e.stopPropagation();
    onChange(values.filter((x) => x !== v));
  }

  const triggerClass = disabled
    ? 'w-full min-h-9 flex items-center justify-start gap-1 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-sm text-left text-stone-400 cursor-not-allowed'
    : 'tw-field-trigger w-full min-h-9 flex items-center justify-start gap-1 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-left text-stone-800 outline-none hover:border-stone-300 focus:ring-2 focus:ring-[#4176e6]/30';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={triggerClass}
      >
        {chips && !disabled ? (
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {selected.length === 0 ? (
              <span className="text-stone-400">{placeholder}</span>
            ) : (
              selected.map((o) => (
                <span
                  key={o.value}
                  className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-700"
                >
                  <OverflowHint text={o.label} className="min-w-0 max-w-[9rem] truncate" />
                  <span
                    role="button"
                    tabIndex={-1}
                    className="shrink-0 rounded px-0.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700"
                    onClick={(e) => remove(o.value, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        remove(o.value, e as unknown as MouseEvent);
                      }
                    }}
                  >
                    ×
                  </span>
                </span>
              ))
            )}
          </span>
        ) : (
          <OverflowHint
            text={summary}
            className={`min-w-0 flex-1 truncate ${
              disabled || selectedLabels.length ? '' : 'text-stone-400'
            }`}
          />
        )}
      </button>
      {open ? (
        <div className="tw-select-menu tw-dsh-scroll tw-popover-anim absolute z-80 mt-1 max-h-72 w-full overflow-auto rounded-lg p-1 shadow-lg ring-1 ring-stone-200">
          {searchable ? (
            <div className="sticky top-0 z-10 bg-white p-1 pb-1.5">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-8 w-full rounded-md border border-stone-200 bg-stone-50 px-2 text-xs text-stone-700 outline-none focus:border-[#4176e6]/40 focus:bg-white"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          ) : null}
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-stone-400">暂无可选项</div>
          ) : (
            filtered.map((o) => {
              const checked = values.includes(o.value);
              return (
                <label
                  key={o.value}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-stone-700 hover:bg-stone-50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(o.value)}
                    className="rounded border-stone-300 text-[#4176e6] focus:ring-[#4176e6]/40"
                  />
                  <OverflowHint text={o.label} className="min-w-0 flex-1 truncate" />
                </label>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
