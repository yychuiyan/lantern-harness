/**
 * 仪表盘卡片的公共外壳与小零件。
 * 视觉参考 luckytask「我的工作台」：圆角卡片 + 标题前的浅色图标块 + 悬停轻抬。
 */
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const base = import.meta.env.BASE_URL;

const LINK_CLASS =
  'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] leading-4 text-stone-400 transition-colors hover:bg-stone-100 hover:text-[#3370ff] whitespace-nowrap';

export type DashboardTone = 'blue' | 'indigo' | 'violet' | 'emerald' | 'amber' | 'red';

function ChevronRight() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path
        d="M4.5 2.75 7.75 6 4.5 9.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 标题前的浅色图标块（颜色写在 global.css，深浅主题各一套） */
export function DashboardIconTile({
  tone,
  children,
}: {
  tone: DashboardTone;
  children: ReactNode;
}) {
  return (
    <span className="tw-dash-ico" data-tone={tone} aria-hidden="true">
      {children}
    </span>
  );
}

/** 卡片外壳：图标 + 标题 + 右上角「打开 XX」入口 */
export function DashboardCard(props: {
  title: string;
  icon?: ReactNode;
  tone?: DashboardTone;
  href?: string;
  action?: string;
  /** 内容区是否自己管理滚动（日历这类要铺满高度的卡片关掉） */
  fill?: boolean;
  children: ReactNode;
}) {
  const { title, icon, tone = 'blue', href, action, fill, children } = props;
  return (
    <section className="tw-dash-surface flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white p-4">
      <div className="flex shrink-0 items-center gap-2">
        {icon ? <DashboardIconTile tone={tone}>{icon}</DashboardIconTile> : null}
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight text-stone-900">
          {title}
        </h2>
        {href && action ? (
          <a href={`${base}${href}`} className={LINK_CLASS}>
            {action}
            <ChevronRight />
          </a>
        ) : null}
      </div>
      <div
        className={`mt-3 flex min-h-0 flex-1 flex-col ${fill ? '' : 'tw-dash-scroll overflow-y-auto'}`}
      >
        {children}
      </div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center py-8 text-sm text-stone-400">
      {children}
    </p>
  );
}

export function PluginOff({ name, detail }: { name: string; detail?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-8 text-center">
      <p className="text-sm text-stone-500">「{name}」插件未启用</p>
      {detail ? <p className="text-xs leading-5 text-stone-400">{detail}</p> : null}
      <a
        href={`${base}plugins/`}
        className="mt-1 rounded-md bg-stone-100 px-2.5 py-1 text-xs font-medium text-[#3370ff] transition-colors hover:bg-[#e8f0fe]"
      >
        去开启
      </a>
    </div>
  );
}

export function SourceError({ message }: { message: string }) {
  return (
    <p className="flex flex-1 items-center justify-center px-2 py-6 text-center text-xs text-[#c02a26]">
      读取失败：{message}
    </p>
  );
}

/**
 * 单行截断 + 悬停气泡：只有真的被截断（scrollWidth 超出）才出气泡，
 * 气泡用 portal 挂到 body，避免被卡片的 overflow:hidden 裁掉。
 */
export function TruncatedText(props: { text: string; className?: string }) {
  const { text, className } = props;
  const ref = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const open = () => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth + 1) return;
    const rect = el.getBoundingClientRect();
    setTip({ x: rect.left + rect.width / 2, y: rect.top });
  };

  return (
    <>
      <span
        ref={ref}
        className={`block truncate ${className ?? ''}`}
        onMouseEnter={open}
        onMouseLeave={() => setTip(null)}
      >
        {text}
      </span>
      {tip
        ? createPortal(
            <span role="tooltip" className="tw-dash-tip" style={{ left: tip.x, top: tip.y }}>
              {text}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

/** 表格里的状态胶囊：与待办 / 任务页同一套浅色底 */
const STATUS_PILL: Record<string, string> = {
  pool: 'bg-stone-100 text-stone-600',
  in_progress: 'bg-[#e1eaff] text-[#1f4ec2]',
  pending: 'bg-stone-100 text-stone-600',
  done: 'bg-[#d9f5d2] text-[#1d7a12]',
  closed: 'bg-stone-100 text-stone-400',
  cancelled: 'bg-stone-100 text-stone-400',
  overdue: 'bg-[#fee4e3] text-[#c02a26]',
};

/** 表格里的紧急程度胶囊：浅底 + 同色系文字，避免整屏实色块 */
const PRIORITY_SOLID: Record<string, string> = {
  urgent_important: 'bg-[#fee4e3] text-[#c02a26]',
  important: 'bg-[#fff1e3] text-[#a85b00]',
  urgent: 'bg-[#fff7d6] text-[#8a6100]',
  normal: 'bg-stone-100 text-stone-600',
  '': 'bg-transparent text-stone-400',
};

export const TH =
  'tw-dash-th sticky top-0 z-1 whitespace-nowrap border-b border-stone-200 px-2.5 py-2 text-left text-[11px] font-medium text-stone-400';
export const TD = 'px-2.5 py-2.5 align-middle';

export function StatusPill({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] leading-4 ${
        STATUS_PILL[status] ?? STATUS_PILL.pending
      }`}
    >
      {label}
    </span>
  );
}

export function PriorityPill({ priority, label }: { priority: string; label: string }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] leading-4 ${
        PRIORITY_SOLID[priority] ?? PRIORITY_SOLID['']
      }`}
    >
      {label}
    </span>
  );
}

/** 表格底部分页：共 N 条 + 上一页 / 页码 / 下一页 */
export function Pager(props: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const { page, pages, total, onPage } = props;
  if (total <= 0) return null;
  return (
    <div className="mt-auto flex shrink-0 items-center justify-end gap-3 border-t border-stone-100 pt-2.5 text-[11px] text-stone-400">
      <span className="tabular-nums">共 {total} 条</span>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label="上一页"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:pointer-events-none disabled:opacity-30"
        >
          ‹
        </button>
        <span className="min-w-5 text-center text-stone-600 tabular-nums">{page}</span>
        <button
          type="button"
          aria-label="下一页"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:pointer-events-none disabled:opacity-30"
        >
          ›
        </button>
      </div>
    </div>
  );
}

/* ============ 图标（线性风格，和侧栏 / 项目管理保持一致） ============ */

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconOverview() {
  return (
    <Svg>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function IconTodos() {
  return (
    <Svg>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" />
    </Svg>
  );
}

export function IconTasks() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function IconTimer() {
  return (
    <Svg>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 1.5M9 2h6" />
    </Svg>
  );
}

export function IconChart() {
  return (
    <Svg>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </Svg>
  );
}

export function IconCalendar() {
  return (
    <Svg>
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
      <path d="M8 2.5v4M16 2.5v4M3 9.5h18" />
    </Svg>
  );
}

export function IconAlert() {
  return (
    <Svg>
      <path d="M12 3.5c3-2 6 0 6 3.5 0 4.5-2.2 7.5-6 10-3.8-2.5-6-5.5-6-10 0-3.5 3-5.5 6-3.5Z" />
      <path d="M12 8.5v3.5" />
    </Svg>
  );
}

export function IconTrend() {
  return (
    <Svg>
      <path d="m3 16 5.5-5.5 3.5 3.5L21 5" />
      <path d="M15 5h6v6" />
    </Svg>
  );
}

export function IconProject() {
  return (
    <Svg>
      <path d="M3 7.5h6l2 2.5h10v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 10V6a2 2 0 0 1 2-2h4l2 3.5" />
    </Svg>
  );
}

export function IconSpaces() {
  return (
    <Svg>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
    </Svg>
  );
}
