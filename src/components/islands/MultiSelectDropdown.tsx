/**
 * 简单多选下拉：勾选列表，展示已选摘要。
 */
import { useEffect, useRef, useState } from 'react';

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
}

export default function MultiSelectDropdown({
  options,
  values,
  onChange,
  placeholder = '选择…',
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selectedLabels = options.filter((o) => values.includes(o.value)).map((o) => o.label);
  const summary = disabled
    ? placeholder
    : selectedLabels.length === 0
      ? placeholder
      : selectedLabels.length <= 2
        ? selectedLabels.join('、')
        : `已选 ${selectedLabels.length} 项`;

  function toggle(v: string) {
    if (values.includes(v)) onChange(values.filter((x) => x !== v));
    else onChange([...values, v]);
  }

  return (
    <div className="relative mt-1" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={
          disabled
            ? 'w-full h-9 flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 text-sm text-left text-stone-400 cursor-not-allowed'
            : 'tw-field-trigger w-full h-9 flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white px-3 text-sm text-left text-stone-800 outline-none hover:border-stone-300 focus:ring-2 focus:ring-[#4176e6]/30'
        }
      >
        <OverflowHint
          text={summary}
          className={`min-w-0 flex-1 truncate ${disabled || selectedLabels.length ? '' : 'text-stone-400'}`}
        />
        <svg className="w-4 h-4 text-stone-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open ? (
        <div className="tw-select-menu tw-dsh-scroll tw-popover-anim absolute z-80 mt-1 max-h-72 w-full overflow-auto rounded-lg p-1 shadow-lg ring-1 ring-stone-200">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-stone-400">暂无可选项</div>
          ) : (
            options.map((o) => {
              const checked = values.includes(o.value);
              return (
                <label
                  key={o.value}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-stone-700 cursor-pointer hover:bg-stone-50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(o.value)}
                    className="rounded border-stone-300 text-[#4176e6] focus:ring-[#4176e6]/40"
                  />
                  {/* 测试点标题普遍超长：被省略号截断时悬停出气泡看全文 */}
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
