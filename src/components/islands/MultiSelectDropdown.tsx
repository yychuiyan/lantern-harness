/**
 * 多选下拉：勾选列表；可选芯片输入样式与搜索过滤。
 * 面板 portal 到 body，避免被表格 overflow 裁切。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
  /**
   * 触发器按多行纯文本展示已选项（每项一行）；
   * 与 chips 同时开时优先 chips（胶囊 + ×）。
   */
  multiline?: boolean;
  /**
   * chips 模式下触发器内胶囊区域最大高度（px）；超出纵向滚动。
   * 不传则随内容撑开。
   */
  chipsMaxHeight?: number;
  /** 下拉内按标签过滤 */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** 追加到触发按钮的 class（表格单元格可去掉圆角边框） */
  triggerClassName?: string;
}

type Anchor = { left: number; top: number; width: number; openUp: boolean };

export default function MultiSelectDropdown({
  options,
  values,
  onChange,
  placeholder = '选择…',
  disabled = false,
  chips = false,
  multiline = false,
  chipsMaxHeight,
  searchable = false,
  searchPlaceholder = '搜索…',
  triggerClassName = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [anchor, setAnchor] = useState<Anchor>({ left: 0, top: 0, width: 220, openUp: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    function onDoc(e: globalThis.MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onScroll(e: Event) {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onResize() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
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

  function openMenu() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(rect.width, 180);
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const openUp = below + 280 > window.innerHeight && rect.top > 280;
    setAnchor({
      left,
      top: openUp ? rect.top - 4 : below,
      width,
      openUp,
    });
    setOpen(true);
  }

  const alignY = chips || multiline ? 'items-start' : 'items-center';
  const triggerClass = `${
    disabled
      ? `w-full min-h-9 flex ${alignY} justify-start gap-1 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-sm text-left text-stone-400 cursor-not-allowed`
      : `tw-field-trigger w-full min-h-9 flex ${alignY} justify-start gap-1 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-left text-stone-800 outline-none hover:border-stone-300 focus:ring-2 focus:ring-[#4176e6]/30`
  } ${triggerClassName}`;

  let panel: ReactNode = null;
  if (open && typeof document !== 'undefined') {
    panel = createPortal(
      <div
        ref={panelRef}
        className="tw-select-menu tw-dsh-scroll tw-popover-anim fixed z-[1000] max-h-72 overflow-auto rounded-lg p-1.5 shadow-lg ring-1 ring-stone-200"
        style={{
          left: anchor.left,
          width: anchor.width,
          ...(anchor.openUp ? { bottom: window.innerHeight - anchor.top } : { top: anchor.top }),
        }}
      >
        {searchable ? (
          <div className="sticky top-0 z-10 bg-white px-0.5 pb-2 pt-0.5">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 w-full rounded-md border border-stone-200 bg-stone-50 px-2.5 text-xs text-stone-700 outline-none focus:border-[#4176e6]/40 focus:bg-white"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ) : null}
        {filtered.length === 0 ? (
          <div className="px-3 py-2.5 text-sm text-stone-400">暂无可选项</div>
        ) : (
          <div className="flex flex-col gap-1">
            {filtered.map((o) => {
              const checked = values.includes(o.value);
              if (chips) {
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className={`flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${
                      checked ? 'bg-[#e8f0fe] text-[#1f4ec2]' : 'text-stone-700 hover:bg-stone-50'
                    }`}
                  >
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-5">
                      {o.label}
                    </span>
                    {checked ? (
                      <span
                        className="mt-0.5 shrink-0 text-[12px] font-medium text-[#3370ff]"
                        aria-hidden
                      >
                        ✓
                      </span>
                    ) : null}
                  </button>
                );
              }
              return (
                <label
                  key={o.value}
                  className={`flex cursor-pointer gap-2 rounded-md px-3 py-2 text-sm text-stone-700 hover:bg-stone-50 ${
                    multiline ? 'items-start' : 'items-center'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(o.value)}
                    className={`rounded border-stone-300 text-[#4176e6] focus:ring-[#4176e6]/40 ${
                      multiline ? 'mt-0.5' : ''
                    }`}
                  />
                  {multiline ? (
                    <span className="block min-w-0 flex-1 whitespace-pre-wrap break-words leading-5">
                      {o.label}
                    </span>
                  ) : (
                    <OverflowHint text={o.label} className="block min-w-0 flex-1 truncate" />
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>,
      document.body,
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={openMenu}
        className={triggerClass}
      >
        {chips ? (
          <span
            className="tw-dsh-scroll flex min-w-0 flex-1 flex-wrap content-start items-center gap-1.5 py-0.5 text-left"
            style={chipsMaxHeight ? { maxHeight: chipsMaxHeight, overflowY: 'auto' } : undefined}
            onWheel={(e) => {
              // 胶囊区可滚动时，避免滚轮冒泡把表格/页面一起带走
              if (!chipsMaxHeight) return;
              e.stopPropagation();
            }}
          >
            {selected.length === 0 ? (
              <span className="text-stone-400">{placeholder}</span>
            ) : (
              selected.map((o) => (
                <span
                  key={o.value}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-[#e8f0fe] px-2.5 py-0.5 text-[12px] leading-5 text-[#1f4ec2]"
                >
                  <span className="min-w-0 break-words whitespace-pre-wrap">{o.label}</span>
                  {disabled ? null : (
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`移除 ${o.label}`}
                      className="shrink-0 rounded-full px-0.5 text-[#5b7fd4] hover:bg-[#d2e3fc] hover:text-[#1f4ec2]"
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
                  )}
                </span>
              ))
            )}
          </span>
        ) : multiline ? (
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5 text-left">
            {selected.length === 0 ? (
              <span className="text-stone-400">{placeholder}</span>
            ) : (
              selected.map((o) => (
                <span
                  key={o.value}
                  className="block min-w-0 whitespace-pre-wrap break-words leading-5"
                >
                  {o.label}
                </span>
              ))
            )}
          </span>
        ) : (
          <OverflowHint
            text={summary}
            className={`block min-w-0 flex-1 truncate ${
              disabled || selectedLabels.length ? '' : 'text-stone-400'
            }`}
          />
        )}
      </button>
      {panel}
    </div>
  );
}
