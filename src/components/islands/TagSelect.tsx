/**
 * 飞书风格的标签选择器：彩色胶囊 + 「查找或创建选项」。
 * 测试统计的「测试统计维度」与用例执行统计的「项目名称」都是单选。
 *
 * 面板 portal 到 body，避免被表格的 overflow 裁掉；位置按触发器实测矩形定位。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const TONES = [
  { key: 'blue', className: 'bg-[#d6e8ff] text-[#245bcc]' },
  { key: 'orange', className: 'bg-[#ffe4c8] text-[#9a5b00]' },
  { key: 'teal', className: 'bg-[#ccf1f0] text-[#0f6b6a]' },
  { key: 'yellow', className: 'bg-[#fff3c4] text-[#7a5c00]' },
  { key: 'green', className: 'bg-[#d3f5dd] text-[#1b6b38]' },
  { key: 'pink', className: 'bg-[#ffd9de] text-[#a12a3a]' },
  { key: 'purple', className: 'bg-[#e6ddff] text-[#5b3bb3]' },
  { key: 'gray', className: 'bg-stone-100 text-stone-600' },
] as const;

export type TagTone = (typeof TONES)[number];

/** 同一个标签永远同一个颜色：按字符做稳定哈希 */
export function tagTone(value: string): TagTone {
  let hash = 0;
  for (const ch of value) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return TONES[hash % TONES.length]!;
}

function TagPill(props: {
  label: string;
  onRemove?: () => void;
  muted?: boolean;
  /** 被省略号截断时是否弹气泡预览 */
  hint?: boolean;
  /** 下拉面板里的气泡需显示在面板层级之上 */
  hintLayer?: 'popover';
  /** 下拉选项使用更紧凑的字号 */
  small?: boolean;
  /** 允许多选 / 长名称换行显示（表格单元格与下拉面板都保持单行，这里只留给特殊场景） */
  wrap?: boolean;
}) {
  const tone = tagTone(props.label);
  const hint = props.hint !== false && !props.wrap;
  return (
    <span
      data-tag-tone={tone.key}
      className={`tw-tag-pill inline-flex max-w-full min-w-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium ${
        props.small ? 'text-[11px]' : 'text-xs'
      } ${props.muted ? 'bg-stone-100 text-stone-500' : tone.className}`}
    >
      {/* 单行显示：超出截断成省略号；data-hint-fit 让它只在真的被截断时才弹气泡预览 */}
      <span
        className={props.wrap ? 'min-w-0 break-words whitespace-normal' : 'min-w-0 truncate'}
        data-hint={hint ? props.label : undefined}
        data-hint-fit={hint ? '' : undefined}
        data-hint-layer={hint ? props.hintLayer : undefined}
      >
        {props.label}
      </span>
      {props.onRemove ? (
        <span
          role="button"
          tabIndex={-1}
          aria-label={`移除 ${props.label}`}
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove?.();
          }}
          className="-mr-0.5 flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm opacity-60 hover:bg-black/10 hover:opacity-100"
        >
          ×
        </span>
      ) : null}
    </span>
  );
}

interface CommonProps {
  options: readonly string[];
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  /** 表格单元格里用的紧凑触发器 */
  compact?: boolean;
  /** 允许输入不存在的值并创建（默认 true） */
  creatable?: boolean;
  className?: string;
}

interface PanelProps {
  options: readonly string[];
  selected: string[];
  creatable: boolean;
  query: string;
  onQuery: (query: string) => void;
  onPick: (value: string) => void;
  onClear: () => void;
  /** 传入才会显示「重命名」按钮；不传则该功能整块不出现 */
  onRenameOption?: (from: string, to: string) => void;
  /** 传入才会显示「删除」按钮 */
  onDeleteOption?: (name: string) => void;
}

const EDIT_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="10"
    height="10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const REMOVE_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="10"
    height="10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

function TagPanel(props: PanelProps) {
  const { options, selected, creatable, query } = props;
  const q = query.trim();
  /** 正在行内改名的选项（null = 没在改名） */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const editable = Boolean(props.onRenameOption || props.onDeleteOption);
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    if (!needle) return [...options];
    return options.filter((o) => o.toLowerCase().includes(needle));
  }, [options, q]);
  const canCreate = creatable && q.length > 0 && !options.includes(q);

  function startRename(option: string) {
    setEditing(option);
    setDraft(option);
  }

  function submitRename(option: string) {
    const next = draft.trim();
    setEditing(null);
    if (!next || next === option) return;
    props.onRenameOption?.(option, next);
  }

  return (
    <div className="flex max-h-72 flex-col">
      <div className="p-1 pb-0">
        <input
          autoFocus
          value={query}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              props.onQuery('');
              props.onClear();
              return;
            }
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (canCreate) {
              props.onPick(q);
              return;
            }
            const first = filtered[0];
            if (first) props.onPick(first);
          }}
          placeholder="查找或创建选项"
          className="h-8 w-full rounded-md border border-stone-200 bg-white px-2 text-sm text-stone-800 outline-none placeholder:text-stone-400 focus:border-[#3370ff]"
        />
      </div>
      <div className="mt-1 min-h-0 flex-1 space-y-1 overflow-auto p-1">
        {canCreate ? (
          <button
            type="button"
            onClick={() => props.onPick(q)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-stone-500 hover:bg-stone-50"
          >
            <span className="text-stone-400">+</span>
            <span className="truncate">创建「{q}」</span>
          </button>
        ) : null}
        {filtered.map((option) => {
          if (editing === option) {
            return (
              <div key={option} className="px-1 py-0.5">
                <input
                  autoFocus
                  aria-label={`重命名 ${option}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitRename(option);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                  className="h-8 w-full rounded-md border border-[#3370ff] px-2 text-sm text-stone-800 outline-none"
                />
              </div>
            );
          }
          const checked = selected.includes(option);
          return (
            <div
              key={option}
              className={`group/opt flex items-center gap-1 rounded-md pr-1 ${
                checked ? 'bg-[#dce8ff] hover:bg-[#d4e3ff]' : 'hover:bg-stone-100'
              }`}
            >
              <button
                type="button"
                onClick={() => props.onPick(option)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              >
                {/* 单行显示：放不下就省略号，悬停气泡预览完整名称（与表格单元格同一套） */}
                <TagPill label={option} hintLayer="popover" small />
              </button>
              {editable ? (
                // 悬停（或键盘聚焦到操作按钮）时才露出来，平时不干扰选词
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/opt:opacity-100 focus-within:opacity-100">
                  {props.onRenameOption ? (
                    <button
                      type="button"
                      aria-label={`重命名 ${option}`}
                      onClick={() => startRename(option)}
                      className="flex h-6 w-6 items-center justify-center rounded text-stone-400 hover:bg-stone-200/70 hover:text-stone-700"
                    >
                      {EDIT_ICON}
                    </button>
                  ) : null}
                  {props.onDeleteOption ? (
                    <button
                      type="button"
                      aria-label={`删除 ${option}`}
                      onClick={() => props.onDeleteOption?.(option)}
                      className="flex h-6 w-6 items-center justify-center rounded text-red-500 hover:bg-red-100 hover:text-red-600"
                    >
                      {REMOVE_ICON}
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
          );
        })}
        {filtered.length === 0 && !canCreate ? (
          <div className="px-2 py-2 text-sm text-stone-400">无匹配项</div>
        ) : null}
      </div>
    </div>
  );
}

interface Anchor {
  left: number;
  top: number;
  width: number;
  openUp: boolean;
}

/** 触发器 + portal 面板的公用逻辑 */
function useTagPicker() {
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [anchor, setAnchor] = useState<Anchor>({ left: 0, top: 0, width: 220, openUp: false });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
      setQuery('');
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      setOpen(false);
      setQuery('');
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      setQuery('');
      return;
    }
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(rect.width, 240);
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const openUp = below + 280 > window.innerHeight && rect.top > 280;
    setAnchor({
      left,
      top: openUp ? rect.top - 4 : below,
      width,
      openUp,
    });
    setQuery('');
    setOpen(true);
  }

  return { triggerRef, panelRef, open, setOpen, query, setQuery, anchor, toggle };
}

function TagTrigger(props: {
  ariaLabel: string;
  compact?: boolean;
  open: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={props.ariaLabel}
      aria-expanded={props.open}
      onClick={props.onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onClick();
        }
      }}
      className={`flex w-full cursor-pointer items-center gap-1 rounded-md border border-transparent text-sm transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:outline-none ${
        props.compact ? 'min-h-8 px-1.5 py-1' : 'min-h-9 px-2 py-1'
      }`}
    >
      {props.children}
    </div>
  );
}

export function SingleTagSelect(
  props: CommonProps & {
    value: string;
    onChange: (value: string) => void;
    /** 传入才会在下拉里出现「重命名」按钮（项目名称 / 测试统计维度都传） */
    onRenameOption?: (from: string, to: string) => void;
    /** 传入才会在下拉里出现「删除」按钮 */
    onDeleteOption?: (name: string) => void;
  },
) {
  const picker = useTagPicker();
  const { value, onChange } = props;

  function pick(next: string) {
    onChange(next);
    picker.setOpen(false);
    picker.setQuery('');
  }

  const panel =
    picker.open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={picker.panelRef}
            className="tw-select-menu tw-popover-anim fixed z-[1000] rounded-lg p-1 shadow-lg ring-1 ring-stone-200"
            style={{
              left: picker.anchor.left,
              width: picker.anchor.width,
              ...(picker.anchor.openUp
                ? { bottom: window.innerHeight - picker.anchor.top }
                : { top: picker.anchor.top }),
            }}
          >
            <TagPanel
              options={props.options}
              selected={value ? [value] : []}
              creatable={props.creatable !== false}
              query={picker.query}
              onQuery={picker.setQuery}
              onPick={pick}
              onClear={() => picker.setOpen(false)}
              onRenameOption={props.onRenameOption}
              onDeleteOption={props.onDeleteOption}
            />
            {value ? (
              <button
                type="button"
                onClick={() => pick('')}
                className="mt-1 w-full rounded-md border-t border-stone-100 px-2 py-1.5 text-center text-xs text-stone-400 hover:bg-stone-50 hover:text-stone-600"
              >
                清除选择
              </button>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={picker.triggerRef} className={props.className}>
      <TagTrigger
        ariaLabel={props.ariaLabel}
        compact={props.compact}
        open={picker.open}
        onClick={() => {
          if (props.disabled) return;
          picker.toggle();
        }}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {value ? (
            <TagPill
              label={value}
              onRemove={() => {
                onChange('');
              }}
            />
          ) : (
            <span className="truncate text-stone-300">{props.placeholder ?? '查找或创建选项'}</span>
          )}
        </span>
      </TagTrigger>
      {panel}
    </div>
  );
}
