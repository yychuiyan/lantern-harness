import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import type { ReactNode } from 'react';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
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
   * 默认 true（勾选语义明确）；分页 / 排序等轻量工具栏可置 false，改用颜色标识选中。
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
  /** 菜单最小宽度（像素）；默认与触发器同宽 */
  menuMinWidth?: number;
  /** 自定义触发器内容 */
  renderTrigger?: (option: SelectOption<T> | undefined) => ReactNode;
  /** 选项左侧的装饰（例如状态 / 紧急程度对应的颜色点） */
  renderOptionPrefix?: (option: SelectOption<T>) => ReactNode;
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
  showCheck = true,
  centerContent = false,
  unstyled = false,
  triggerClassName = '',
  hideChevron = false,
  flat = false,
  menuMinWidth,
  renderTrigger,
  renderOptionPrefix,
}: Props<T>) {
  const current = options.find((o) => o.value === value);

  /* 居中对齐时用 absolute 定位把箭头摘出文档流，避免它参与 flex 居中导致文字偏移 */
  const alignCls = centerContent ? 'relative justify-center' : 'justify-between';
  const chevronCls = centerContent
    ? 'w-4 h-4 text-stone-400 shrink-0 absolute right-2.5'
    : undefined;

  const baseCls = unstyled
    ? 'w-full flex items-center cursor-pointer outline-none disabled:cursor-not-allowed'
    : compact
      ? 'w-full h-8 flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-2.5 text-sm text-left text-stone-700 outline-none cursor-pointer hover:border-stone-400 focus:ring-2 focus:ring-[#4176e6]/30 focus:border-[#4176e6] disabled:bg-stone-50 disabled:text-stone-400 disabled:cursor-not-allowed'
      : flat
        ? 'w-full h-9 flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-2.5 text-sm text-left text-stone-700 outline-none cursor-pointer hover:border-stone-300 focus:ring-2 focus:ring-[#4176e6]/30 focus:border-[#4176e6] disabled:bg-stone-50 disabled:text-stone-400 disabled:cursor-not-allowed'
        : 'w-full h-9 flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 text-sm text-left text-stone-800 outline-none cursor-pointer hover:border-stone-300 focus:ring-2 focus:ring-[#4176e6]/30 focus:border-[#4176e6] disabled:bg-stone-50 disabled:text-stone-400 disabled:cursor-not-allowed';

  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <div
        className={`relative ${unstyled ? '' : compact ? 'inline-block' : flat ? '' : 'mt-1'} ${className}`}
      >
        <ListboxButton
          aria-label={ariaLabel}
          className={`${baseCls} ${alignCls} ${triggerClassName}`}
        >
          {renderTrigger ? (
            renderTrigger(current)
          ) : (
            <span className="truncate">{current?.label ?? value}</span>
          )}
          {hideChevron ? null : <Chevron className={chevronCls} />}
        </ListboxButton>
        <ListboxOptions
          transition
          anchor={{ to: 'bottom start', gap: 4 }}
          style={menuMinWidth ? { minWidth: menuMinWidth } : undefined}
          className="tw-select-menu tw-menu-anim z-80 max-h-56 w-max min-w-(--button-width) max-w-[320px] space-y-1 overflow-auto rounded-lg p-1 shadow-lg ring-1 ring-stone-200 focus:outline-none"
        >
          {options.map((o) => (
            <ListboxOption
              key={o.value}
              value={o.value}
              className={`group cursor-pointer select-none flex items-center gap-2 rounded-md px-3 py-2 text-sm leading-5 data-[focus]:bg-stone-50 data-[selected]:bg-(--tw-accent-soft) ${
                showCheck
                  ? 'text-stone-700 data-[selected]:text-stone-900'
                  : 'data-[selected]:text-(--tw-accent) data-[selected]:font-medium'
              } ${
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
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
