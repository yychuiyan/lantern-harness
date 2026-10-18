/**
 * 日期选择：触发器只显示 YYYY/MM/DD，点开是一张白色卡片日历（跟飞书一致的交互）。
 * 不用 <input type="date">：原生控件在每套系统里样式不同，表格里还会顶出一个小日历图标。
 *
 * 弹层用 fixed + portal：表格容器是 overflow:auto，绝对定位的日历会被裁掉。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;
const PANEL_WIDTH = 272;

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDate(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 显示用：2026-10-18 → 2026/10/18 */
export function formatDateDisplay(value: string): string {
  const parsed = parseDate(value);
  if (!parsed) return '';
  return `${parsed.y}/${String(parsed.m + 1).padStart(2, '0')}/${String(parsed.d).padStart(2, '0')}`;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 触发器类 */
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** 允许清空（默认 true） */
  clearable?: boolean;
}

export default function DatePicker({
  value,
  onChange,
  placeholder = '选择日期',
  className = '',
  disabled = false,
  ariaLabel,
  clearable = true,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const selected = parseDate(value);
  const today = todayIso();
  const [view, setView] = useState(() => {
    const base = selected ?? parseDate(today)!;
    return { y: base.y, m: base.m };
  });

  // 每次打开都把视图对齐到当前值（或今天）
  useEffect(() => {
    if (!open) return;
    const base = parseDate(value) ?? parseDate(today)!;
    setView({ y: base.y, m: base.m });
  }, [open, value, today]);

  useEffect(() => {
    if (!open) return;
    function place() {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const height = panelRef.current?.offsetHeight ?? 340;
      const below = rect.bottom + 6;
      const above = rect.top - height - 6;
      const top = below + height > window.innerHeight - 8 && above > 8 ? above : below;
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - PANEL_WIDTH - 8),
      );
      setPos({ top, left });
    }
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // 表格滚动 / 窗口变化时直接收起，避免日历浮在别处
    const close = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const lead = first.getDay();
    const start = new Date(view.y, view.m, 1 - lead);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return {
        iso: isoOf(d.getFullYear(), d.getMonth(), d.getDate()),
        day: d.getDate(),
        inMonth: d.getMonth() === view.m,
      };
    });
  }, [view]);

  function pick(iso: string) {
    onChange(iso);
    setOpen(false);
  }

  function shift(delta: number) {
    setView((prev) => {
      const m = prev.m + delta;
      if (m < 0) return { y: prev.y - 1, m: 11 };
      if (m > 11) return { y: prev.y + 1, m: 0 };
      return { ...prev, m };
    });
  }

  const display = formatDateDisplay(value);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel ?? placeholder}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full min-w-0 items-center text-left outline-none disabled:cursor-not-allowed ${className}`}
      >
        {display ? (
          <span className="truncate tabular-nums">{display}</span>
        ) : (
          <span className="truncate text-stone-400">{placeholder}</span>
        )}
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="选择日期"
              style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH }}
              className="tw-date-panel tw-menu-anim fixed z-120 rounded-xl border border-stone-200 bg-white p-3 shadow-xl"
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="pl-1 text-sm font-semibold text-stone-800">
                  {view.y}年{view.m + 1}月
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="上个月"
                    onClick={() => shift(-1)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m15 6-6 6 6 6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    aria-label="下个月"
                    onClick={() => shift(1)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-7 text-center text-xs text-stone-500">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="py-1">
                    {w}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-y-0.5 text-center text-sm">
                {cells.map((c) => {
                  const isSelected = c.iso === value;
                  const isToday = c.iso === today;
                  return (
                    <button
                      key={c.iso}
                      type="button"
                      onClick={() => pick(c.iso)}
                      aria-label={c.iso}
                      aria-current={isSelected ? 'date' : undefined}
                      className={`mx-auto flex h-8 w-8 items-center justify-center rounded-md tabular-nums transition-colors ${
                        isSelected
                          ? 'bg-[#3370ff] font-medium text-white'
                          : c.inMonth
                            ? 'text-stone-700 hover:bg-stone-100'
                            : 'text-stone-300 hover:bg-stone-50'
                      } ${isToday && !isSelected ? 'ring-1 ring-stone-300 ring-inset' : ''}`}
                    >
                      {c.day}
                    </button>
                  );
                })}
              </div>

              <div className="mt-2 flex items-center justify-between border-t border-stone-100 pt-2 text-sm">
                <button
                  type="button"
                  onClick={() => {
                    onChange('');
                    setOpen(false);
                  }}
                  disabled={!clearable}
                  className="rounded-md px-2 py-1 text-[#3370ff] transition-colors hover:bg-[#eef3ff] disabled:opacity-40"
                >
                  清除
                </button>
                <button
                  type="button"
                  onClick={() => pick(today)}
                  className="rounded-md px-2 py-1 text-[#3370ff] transition-colors hover:bg-[#eef3ff]"
                >
                  今天
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
