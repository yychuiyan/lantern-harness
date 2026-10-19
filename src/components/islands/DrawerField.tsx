/**
 * 记录抽屉（待办 / 任务）共用的字段样式。
 *
 * 待办与任务两个抽屉必须长得一样：同样的标签列宽、行距、输入框与胶囊。
 * 这里收口字段行、线性图标与胶囊下拉，避免两边各写一份后慢慢走样。
 */
import type { ReactNode } from 'react';
import SelectDropdown from './SelectDropdown';

/** 抽屉里的文本输入 / 日期触发器的外观 */
export const DRAWER_INPUT =
  'h-9 w-full rounded-md border border-transparent bg-transparent px-2 text-sm text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white placeholder:text-stone-400';

export function DrawerField(props: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-6 py-2">
      <div className="flex w-[132px] shrink-0 items-center gap-2 pt-1.5 text-sm text-stone-600">
        <span className="flex h-4 w-4 items-center justify-center text-stone-400">
          {props.icon}
        </span>
        <span className="truncate">{props.label}</span>
      </div>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

/**
 * 状态 / 紧急程度 / 所属任务：抽屉里的标准下拉（与项目管理一致：描边输入框 + 右侧箭头）。
 * 菜单宽度跟随输入框，避免短弹窗浮在长输入框下面显得错位。
 */
export function DrawerSelect(props: {
  ariaLabel: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  /** 触发器上显示的文字 */
  label: string;
  /** 选项左侧的颜色圆点（不传则只有文字） */
  optionDotClassName?: (value: string) => string;
  /** 兼容旧调用：菜单始终跟随输入框宽度，这里不再生效 */
  menuMinWidth?: number;
  disabled?: boolean;
}) {
  return (
    <SelectDropdown
      flat
      menuMatchTrigger
      ariaLabel={props.ariaLabel}
      options={props.options}
      value={props.value}
      onChange={props.onChange}
      disabled={props.disabled}
      className="w-full"
      renderTrigger={() => <span className="truncate">{props.label}</span>}
      renderOptionPrefix={
        props.optionDotClassName
          ? (option) => (
              <span
                className={`h-2 w-2 rounded-full ${props.optionDotClassName?.(option.value) ?? ''}`}
              />
            )
          : undefined
      }
    />
  );
}

/* ── 18px 线性图标（与飞书字段图标同位） ── */

export function IconText() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 19 11 5l6 14" />
      <path d="M7.5 14h7" />
      <path d="M18 9v10" />
    </svg>
  );
}

export function IconStatus() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </svg>
  );
}

export function IconTask() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

export function IconDate() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </svg>
  );
}

export function IconFormula() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 4h10l-5 7 5 9H7l5-9Z" />
    </svg>
  );
}

export function IconChevron(props: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform ${props.open ? '' : '-rotate-90'}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
