import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import OverflowHint from './OverflowHint';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /**
   * 菜单项第二行的补充信息（例如项目目录路径）。
   * 只有传了才渲染第二行，其它调用方的菜单外观完全不变。
   */
  secondary?: string;
  /** 该选项置灰不可选（例如自动识别后锁定框架，其余框架只展示不给切） */
  disabled?: boolean;
  /** 弱化显示（例如「不选择」这类占位项）：灰字，仍可点 */
  muted?: boolean;
}

interface Props<T extends string> {
  options: ReadonlyArray<SelectOption<T>>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** 触发器占满父宽 */
  className?: string;
  /** 紧凑尺寸：用于工具栏 / 分页条等与其它控件同行的场景（去掉上边距、降低高度） */
  compact?: boolean;
  /** 无可见 label 时给触发器补无障碍名称 */
  ariaLabel?: string;
  /**
   * 选中项是否显示对钩。
   * 默认 false：选中项用浅蓝底 + 强调色文字标识（不用对钩，菜单更轻）；
   * 个别需要勾选语义的场景可显式置 true。
   */
  showCheck?: boolean;
  /**
   * 触发按钮与选项是否居中。
   * 默认 false（左对齐 + 右侧箭头），适合「按修改时间」这类文字选项；
   * 分页的每页条数等窄控件可置 true，让 1~2 位数字居中，视觉更稳。
   */
  centerContent?: boolean;
  /** 不要默认的输入框外观：由 triggerClassName 决定（表格里的状态 / 紧急程度胶囊） */
  unstyled?: boolean;
  /** 追加到触发按钮上的类 */
  triggerClassName?: string;
  /** 隐藏右侧箭头（胶囊触发器用） */
  hideChevron?: boolean;
  /** 无上边距、保持 h-9：放在工具栏里与搜索框同高（区别于 compact 的 h-8） */
  flat?: boolean;
  /** 菜单最小宽度（像素）；仅在 menuMatchTrigger=false 时生效 */
  menuMinWidth?: number;
  /**
   * 菜单宽度是否跟随触发器。
   * 默认 true：菜单至少与触发器同宽——抽屉里的整行下拉与输入框对齐，不会浮出一块短菜单；
   * 只有确实需要固定窄菜单的极窄控件才置 false。
   */
  menuMatchTrigger?: boolean;
  /** 自定义触发器内容 */
  renderTrigger?: (option: SelectOption<T> | undefined, state: { open: boolean }) => ReactNode;
  /** 选项左侧的装饰（例如状态 / 紧急程度对应的颜色点） */
  renderOptionPrefix?: (option: SelectOption<T>) => ReactNode;
  /**
   * 选项右侧的行内操作（例如项目列表里的删除按钮）。
   * 默认悬停才显示；点击不会选中该选项。
   */
  renderOptionAction?: (option: SelectOption<T>) => ReactNode;
  /**
   * 菜单顶部加一个搜索框，按名称 / 值过滤选项。
   * 选项很多时（任务、迭代、需求）比长列表翻找快；少数固定选项的下拉不用开。
   */
  searchable?: boolean;
  /** 搜索框占位文案 */
  searchPlaceholder?: string;
  /**
   * 触发器文字被省略号截断时，气泡里显示的完整文案（不用原生 title，样式全站统一）。
   * 不传时用当前选项的 label；需要补目录等额外信息时再传。
   */
  triggerTitle?: string;
  /**
   * 触发器不出气泡（有的触发框本身已经能看清、或旁边另有说明）。
   * 只影响触发器，菜单里的选项仍按各自内容决定是否弹气泡。
   */
  hideTriggerHint?: boolean;
  /**
   * 菜单展开时把触发器的值显示成灰色（等同占位描述文字）：
   * 值本身不可编辑，只是「当前值」的提示；不选任何项时仍是原值，不会丢。
   */
  dimWhenOpen?: boolean;
}

function Chevron({ className = 'w-4 h-4 text-stone-400 shrink-0' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * 菜单里的搜索框：只有菜单打开时才挂载，挂载即聚焦，直接打字就能过滤。
 * 除方向键 / 回车 / Esc 之外都拦下，避免被 Listbox 的 typeahead 抢走按键。
 */
function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Listbox 打开后会把焦点挪到列表容器（方便方向键导航），下一帧再抢回来，
    // 这样点开下拉就能直接打字搜索。方向键 / 回车 / Esc 仍传给 Listbox 处理。
    const id = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    // 搜索框固定在菜单顶部（不随选项滚动），下面才是滚动区：
    // 以前把搜索框做成滚动容器里的 sticky，滚动时上方仍会漏出半行选项文字。
    <div className="shrink-0 border-b border-stone-100 bg-white px-1.5 py-1.5">
      <div className="relative">
        <svg
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m16.5 16.5 4 4" />
        </svg>
        <input
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            const pass = ['Escape', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key);
            if (!pass) event.stopPropagation();
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          spellCheck={false}
          className="h-8 w-full rounded-md border border-stone-200 bg-stone-50 pl-7 pr-2 text-sm text-stone-700 outline-none transition-colors placeholder:text-stone-400 focus:border-[#4176e6]"
        />
      </div>
    </div>
  );
}

function Check() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default function SelectDropdown<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  className = '',
  compact = false,
  ariaLabel,
  showCheck = false,
  centerContent = false,
  unstyled = false,
  triggerClassName = '',
  hideChevron = false,
  flat = false,
  menuMinWidth,
  menuMatchTrigger = true,
  renderTrigger,
  renderOptionPrefix,
  renderOptionAction,
  searchable = false,
  searchPlaceholder = '搜索…',
  triggerTitle,
  hideTriggerHint = false,
  dimWhenOpen = false,
}: Props<T>) {
  const current = options.find((o) => o.value === value);
  const [query, setQuery] = useState('');
  /** 搜索只影响菜单里列出什么，点击触发器打开时重置，避免下次打开还留着上次的关键字 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  /* 居中对齐时用 absolute 定位把箭头摘出文档流，避免它参与 flex 居中导致文字偏移 */
  const alignCls = centerContent ? 'relative justify-center' : 'justify-between';
  const chevronCls = centerContent
    ? 'w-4 h-4 text-stone-400 shrink-0 absolute right-2.5'
    : undefined;

  const baseCls = unstyled
    ? 'w-full flex items-center cursor-pointer outline-none disabled:cursor-not-allowed'
    : compact
      ? 'tw-field-trigger w-full h-8 flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-2.5 text-sm text-left text-stone-700 outline-none cursor-pointer hover:border-stone-400 focus:ring-2 focus:ring-[#4176e6]/30 focus:border-[#4176e6] disabled:bg-stone-50 disabled:text-stone-400 disabled:cursor-not-allowed'
      : flat
        ? 'tw-field-trigger w-full h-9 flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-2.5 text-sm text-left text-stone-700 outline-none cursor-pointer hover:border-stone-300 focus:ring-2 focus:ring-[#4176e6]/30 focus:border-[#4176e6] disabled:bg-stone-50 disabled:text-stone-400 disabled:cursor-not-allowed'
        : 'tw-field-trigger w-full h-9 flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 text-sm text-left text-stone-800 outline-none cursor-pointer hover:border-stone-300 focus:ring-2 focus:ring-[#4176e6]/30 focus:border-[#4176e6] disabled:bg-stone-50 disabled:text-stone-400 disabled:cursor-not-allowed';

  return (
    <Listbox
      value={value}
      onChange={(next: T) => {
        setQuery('');
        onChange(next);
      }}
      disabled={disabled}
    >
      {({ open }) => (
        <div
          className={`relative ${unstyled ? '' : compact ? 'inline-block' : flat ? '' : 'mt-1'} ${className}`}
        >
          <ListboxButton
            aria-label={ariaLabel}
            onClick={() => {
              // 每次打开都从完整列表开始
              if (searchable) setQuery('');
            }}
            className={`${baseCls} ${alignCls} ${triggerClassName} ${
              dimWhenOpen && open ? 'text-stone-400' : ''
            }`}
          >
            {renderTrigger ? (
              renderTrigger(current, { open })
            ) : (
              // 文字被省略号截断时才弹气泡补全；传了 triggerTitle 时用它（可附带目录等说明）
              <OverflowHint
                text={triggerTitle ?? current?.label ?? value}
                className="min-w-0 flex-1 truncate"
                disabled={hideTriggerHint}
              />
            )}
            {hideChevron ? null : <Chevron className={chevronCls} />}
          </ListboxButton>
          <ListboxOptions
            transition
            // padding：菜单翻折 / 位移时与视口边缘至少留 12px；
            // 同时 size 中间件会按「可用高度 - padding」写内联 max-height，
            // 底部因此不再贴着窗口底（原来的 max-h-* 会被内联样式盖掉，改用 --anchor-max-height 兜上限）
            anchor={{ to: 'bottom start', gap: 4, padding: 12 }}
            style={!menuMatchTrigger && menuMinWidth ? { minWidth: menuMinWidth } : undefined}
            className={`tw-select-menu tw-menu-anim z-80 flex max-h-64 flex-col overflow-hidden rounded-lg shadow-lg ring-1 ring-stone-200 [--anchor-max-height:16rem] focus:outline-none ${
              menuMatchTrigger
                ? 'w-max min-w-(--button-width) max-w-[360px]'
                : 'w-max min-w-[150px] max-w-[360px]'
            }`}
          >
            {searchable ? (
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={searchPlaceholder}
                ariaLabel={ariaLabel ? `${ariaLabel}搜索` : '搜索选项'}
              />
            ) : null}
            {/* 选项区单独滚动：与顶部搜索框分层，滚动内容不会从搜索框上方漏出来 */}
            <div className="min-h-0 flex-1 space-y-1 overflow-auto p-1 pb-2">
              {searchable && filtered.length === 0 ? (
                <div className="px-3 py-2 text-sm text-stone-400">无匹配项</div>
              ) : null}
              {filtered.map((o) => (
                <ListboxOption
                  key={o.value}
                  value={o.value}
                  disabled={o.disabled}
                  className={`group flex select-none items-center gap-2 rounded-md px-3 py-2 text-sm leading-5 data-[focus]:bg-stone-50 data-[selected]:bg-(--tw-accent-soft) ${
                    o.disabled
                      ? 'cursor-not-allowed text-stone-300 data-[focus]:bg-transparent data-[selected]:bg-transparent data-[selected]:font-normal'
                      : 'cursor-pointer'
                  } ${
                    showCheck
                      ? 'text-stone-700 data-[selected]:text-stone-900'
                      : 'data-[selected]:text-(--tw-accent) data-[selected]:font-medium'
                  } ${o.muted ? 'text-stone-400 data-[selected]:text-stone-500' : ''} ${
                    // 有颜色点 / 对钩时统一左对齐：逐项居中会让长短不一的标签左右错位
                    centerContent && !showCheck && !renderOptionPrefix ? 'justify-center px-2' : ''
                  }`}
                >
                  {showCheck ? (
                    <span className="w-4 shrink-0 text-[#4176e6] opacity-0 group-data-[selected]:opacity-100">
                      <Check />
                    </span>
                  ) : renderOptionPrefix ? (
                    <span className="flex w-3.5 shrink-0 items-center justify-center">
                      {renderOptionPrefix(o)}
                    </span>
                  ) : null}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <OverflowHint text={o.label} className="min-w-0 w-full truncate" />
                    {o.secondary ? (
                      <OverflowHint
                        text={o.secondary}
                        className="min-w-0 w-full truncate font-mono text-[10px] font-normal leading-4 text-stone-400"
                      />
                    ) : null}
                  </span>
                  {renderOptionAction ? (
                    <span
                      className="ml-0.5 flex shrink-0 items-center"
                      // 行内操作（删除等）不该顺带选中这一项
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                      }}
                    >
                      {renderOptionAction(o)}
                    </span>
                  ) : null}
                </ListboxOption>
              ))}
            </div>
          </ListboxOptions>
        </div>
      )}
    </Listbox>
  );
}
