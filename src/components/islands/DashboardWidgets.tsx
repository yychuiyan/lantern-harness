/**
 * 仪表盘卡片：待办概览、休息倒计时、今日待办、进行中任务、测试统计柱状图、待办日历。
 * 只做展示与轻量交互（勾选完成待办 / 周历翻页），数据由 DashboardBoard 统一拉取。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  activeTasks as pickActiveTasks,
  addDaysIso,
  addMonthsIso,
  axisTicks,
  dashboardKpis,
  latestStatsByDimension,
  layoutTodoSpans,
  monthRange,
  pageSlice,
  restCountdown,
  todayTodos as pickTodayTodos,
  todoCoversDay,
  weekRange,
  type DashboardWidgetId,
} from '../../lib/dashboard';
import { EMPTY_CALENDAR, loadHolidayCalendar, type HolidayCalendar } from '../../lib/cn-holidays';
import type { TestStatsItem } from '../../lib/test-stats';
import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL, type TaskItem } from '../../lib/tasks';
import {
  TODO_PRIORITY_LABEL,
  TODO_STATUS_LABEL,
  effectiveTodoStatus,
  isTodoClosed,
  sortTodos,
  todayIso,
  type TodoItem,
  type TodoPriority,
} from '../../lib/todos';

const base = import.meta.env.BASE_URL;

const LINK_CLASS =
  'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] leading-4 text-stone-400 transition-colors hover:bg-stone-100 hover:text-[#3370ff] whitespace-nowrap';

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

/** 卡片外壳：标题 + 右上角「打开 XX」入口 */
function Card(props: {
  title: string;
  href?: string;
  action?: string;
  /** 内容区是否自己管理滚动（日历这类要铺满高度的卡片关掉） */
  fill?: boolean;
  children: ReactNode;
}) {
  const { title, href, action, fill, children } = props;
  return (
    <section className="tw-dash-surface flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white p-5">
      <div className="flex shrink-0 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-stone-900">
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
        className={`mt-4 flex min-h-0 flex-1 flex-col ${fill ? '' : 'tw-dash-scroll overflow-y-auto'}`}
      >
        {children}
      </div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center py-8 text-sm text-stone-400">
      {children}
    </p>
  );
}

function PluginOff({ name, detail }: { name: string; detail?: string }) {
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

function SourceError({ message }: { message: string }) {
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
function TruncatedText(props: { text: string; className?: string }) {
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

const TH =
  'tw-dash-th sticky top-0 z-1 whitespace-nowrap border-b border-stone-200 px-2.5 py-2 text-left text-[11px] font-medium text-stone-400';
const TD = 'px-2.5 py-2.5 align-middle';

function StatusPill({ status, label }: { status: string; label: string }) {
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

function PriorityPill({ priority, label }: { priority: string; label: string }) {
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

/** 2026-10-28 → 2026/10/28；空值显示破折号 */
function dateLabel(iso: string): string {
  return iso ? iso.split('-').join('/') : '—';
}

/** 表格底部分页：共 N 条 + 上一页 / 页码 / 下一页 */
function Pager(props: {
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

/** 待办概览：进行中待办 / 进行中任务 / 已逾期 / 两个完成率 */
function KpiWidget(props: {
  todos: TodoItem[];
  tasks: TaskItem[];
  todosOn: boolean;
  tasksOn: boolean;
}) {
  const { todos, tasks, todosOn, tasksOn } = props;
  const kpis = dashboardKpis(todos, tasks);

  const cells: {
    key: string;
    label: string;
    value?: number | string;
    rate?: number;
    href?: string;
    danger?: boolean;
    bar?: string;
    off?: boolean;
  }[] = [
    {
      key: 'todoInProgress',
      label: '进行中待办',
      value: todosOn ? kpis.todoInProgress : '—',
      href: todosOn ? 'todos/' : undefined,
      off: !todosOn,
    },
    {
      key: 'taskInProgress',
      label: '进行中任务',
      value: tasksOn ? kpis.taskInProgress : '—',
      href: tasksOn ? 'tasks/' : undefined,
      off: !tasksOn,
    },
    {
      key: 'overdue',
      label: '已逾期',
      value: todosOn ? kpis.overdue : '—',
      href: todosOn ? 'todos/' : undefined,
      danger: todosOn && kpis.overdue > 0,
      off: !todosOn,
    },
    {
      key: 'todoRate',
      label: '待办完成率',
      rate: todosOn ? kpis.todoRate : undefined,
      href: todosOn ? 'todos/' : undefined,
      bar: 'bg-[#3370ff]',
      off: !todosOn,
    },
    {
      key: 'taskRate',
      label: '任务完成率',
      rate: tasksOn ? kpis.taskRate : undefined,
      href: tasksOn ? 'tasks/' : undefined,
      bar: 'bg-[#34c724]',
      off: !tasksOn,
    },
  ];

  return (
    <div className="grid h-full min-h-0 flex-1 auto-rows-fr grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-2.5">
      {cells.map((cell) => {
        const body = (
          <>
            <p className="truncate text-xs leading-5 text-stone-400">{cell.label}</p>
            {cell.rate !== undefined ? (
              <>
                <p className="text-[26px] leading-8 font-semibold tracking-tight text-stone-900 tabular-nums">
                  {cell.rate}
                  <span className="ml-0.5 text-sm font-normal text-stone-400">%</span>
                </p>
                <div className="tw-dash-track mt-1 h-1.5 w-full overflow-hidden rounded-full">
                  <div
                    className={`h-full rounded-full transition-[width] ${cell.bar ?? 'bg-[#3370ff]'}`}
                    style={{ width: `${Math.min(100, Math.max(0, cell.rate))}%` }}
                  />
                </div>
              </>
            ) : (
              <p
                className={`text-[26px] leading-8 font-semibold tracking-tight tabular-nums ${
                  cell.danger ? 'text-[#c02a26]' : 'text-stone-900'
                } ${cell.off ? 'text-stone-300' : ''}`}
              >
                {cell.value}
              </p>
            )}
          </>
        );
        const shell = `flex min-w-0 flex-col justify-center rounded-xl border px-3.5 py-3 transition-colors ${
          cell.off
            ? 'border-dashed border-stone-200 bg-transparent'
            : 'tw-dash-tile hover:border-stone-200'
        }`;
        return cell.href ? (
          <a key={cell.key} href={`${base}${cell.href}`} className={shell}>
            {body}
          </a>
        ) : (
          <div key={cell.key} className={shell}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** 休息倒计时：每秒刷新，只影响本卡片；节假日与调休按 public/cn-holidays.json 算 */
function CountdownWidget() {
  const [now, setNow] = useState(() => new Date());
  const [calendar, setCalendar] = useState<HolidayCalendar>(EMPTY_CALENDAR);

  useEffect(() => {
    let alive = true;
    void loadHolidayCalendar().then((next) => {
      if (alive) setCalendar(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const cd = restCountdown(now, calendar);
  const pad = (value: number) => String(value).padStart(2, '0');
  /** 四个单位排成一行：00天 00时 00分 00秒（不换行） */
  const blocks = [
    { value: cd.days, label: '天' },
    { value: cd.hours, label: '时' },
    { value: cd.minutes, label: '分' },
    { value: cd.seconds, label: '秒' },
  ];
  // 该年安排还没公布时，说明一下倒计时只按法定假日算（调休待补）
  const provisional = calendar.provisionalYears.has(Number(cd.targetDate.slice(0, 4)));

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-3.5 overflow-hidden">
      <div className="tw-dash-tile tw-countdown-tile flex flex-1 items-center justify-center rounded-xl border px-4 py-5">
        {/* 四个单位一行，字号随卡片宽度缩放：窄卡不挤、宽卡更舒展 */}
        <p className="tw-countdown-row w-full">
          {blocks.map((block) => (
            <span key={block.label} className="tw-countdown-part">
              <span className="tw-countdown-num">{pad(block.value)}</span>
              <span className="tw-countdown-unit">{block.label}</span>
            </span>
          ))}
        </p>
      </div>
      <p className="shrink-0 text-center text-xs text-stone-400">
        {cd.resting
          ? cd.target === '周末'
            ? '周末愉快，好好休息'
            : `${cd.target}假期，好好休息`
          : `距${cd.target} 00:00`}
        {provisional ? (
          <span className="text-stone-300"> · {cd.targetDate.slice(0, 4)} 安排待公布</span>
        ) : null}
      </p>
    </div>
  );
}

/** 今日待办：开始 ~ 截止区间包含今天的未完成待办，表格展示 + 分页 */
function TodayTodosWidget(props: {
  todos: TodoItem[];
  enabled: boolean;
  error?: string;
  onToggle: (item: TodoItem) => Promise<void>;
}) {
  const { todos, enabled, error, onToggle } = props;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const today = todayIso();
  const all = pickTodayTodos(todos, today);
  const paged = pageSlice(all, page, 5);
  const overdue = todos.filter((item) => effectiveTodoStatus(item, today) === 'overdue').length;

  let body: ReactNode;
  if (!enabled) {
    body = <PluginOff name="待办事项" detail="启用后这里会显示今天进行中的待办" />;
  } else if (error) {
    body = <SourceError message={error} />;
  } else if (!paged.total) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 py-6 text-center">
        <p className="text-sm text-stone-400">今天没有进行中的待办</p>
        {overdue > 0 ? (
          <a href={`${base}todos/`} className="text-xs text-[#c02a26] hover:underline">
            另有 {overdue} 条已逾期
          </a>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="tw-dash-scroll min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[440px] table-fixed border-collapse text-[12px]">
            <colgroup>
              <col />
              <col style={{ width: 80 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 84 }} />
              <col style={{ width: 84 }} />
            </colgroup>
            <thead>
              <tr>
                <th className={TH}>待办名称</th>
                <th className={TH}>待办状态</th>
                <th className={TH}>所属任务</th>
                <th className={TH}>开始日期</th>
                <th className={TH}>截止日期</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((item) => {
                const busy = busyId === item.id;
                const status = effectiveTodoStatus(item, today);
                return (
                  <tr
                    key={item.id}
                    className="border-b border-stone-100 transition-colors last:border-0 hover:bg-stone-50"
                  >
                    <td className={TD}>
                      <span className="flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`标记完成 ${item.title}`}
                          onClick={() => {
                            setBusyId(item.id);
                            void onToggle(item).finally(() => setBusyId(null));
                          }}
                          className="group/tick flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-stone-300 transition-colors hover:border-[#3370ff] focus-visible:border-[#3370ff] disabled:opacity-40"
                        >
                          {/* 悬停 / 聚焦时在圈里点一个小圆点，而不是把整圈填满 */}
                          <span
                            className={`h-2 w-2 rounded-full bg-[#3370ff] transition-opacity ${
                              busy
                                ? 'animate-pulse opacity-100'
                                : 'opacity-0 group-hover/tick:opacity-100 group-focus-visible/tick:opacity-100'
                            }`}
                          />
                        </button>
                        <TruncatedText text={item.title} className="min-w-0 text-stone-700" />
                      </span>
                    </td>
                    <td className={TD}>
                      <StatusPill status={status} label={TODO_STATUS_LABEL[status]} />
                    </td>
                    <td className={TD}>
                      {item.linkedTask ? (
                        <TruncatedText
                          text={item.linkedTask}
                          className="rounded-md bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500"
                        />
                      ) : (
                        <span className="text-stone-300">—</span>
                      )}
                    </td>
                    <td
                      className={`${TD} whitespace-nowrap text-[11px] text-stone-400 tabular-nums`}
                    >
                      {dateLabel(item.startDate)}
                    </td>
                    <td
                      className={`${TD} whitespace-nowrap text-[11px] tabular-nums ${
                        status === 'overdue' ? 'text-[#c02a26]' : 'text-stone-400'
                      }`}
                    >
                      {dateLabel(item.dueDate)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager page={paged.page} pages={paged.pages} total={paged.total} onPage={setPage} />
      </div>
    );
  }

  return (
    <Card title="今日待办" href="todos/" action="打开待办">
      {body}
    </Card>
  );
}

/** 进行中任务：表格展示（任务描述 / 状态 / 紧急程度 / 起止日期）+ 分页 */
function ActiveTasksWidget(props: { tasks: TaskItem[]; enabled: boolean; error?: string }) {
  const { tasks, enabled, error } = props;
  const today = todayIso();
  const [page, setPage] = useState(1);
  const paged = pageSlice(pickActiveTasks(tasks), page, 5);

  let body: ReactNode;
  if (!enabled) {
    body = <PluginOff name="任务管理" detail="启用后这里会显示进行中的任务" />;
  } else if (error) {
    body = <SourceError message={error} />;
  } else if (!paged.total) {
    body = <Empty>没有进行中的任务</Empty>;
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="tw-dash-scroll min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[440px] table-fixed border-collapse text-[12px]">
            <colgroup>
              <col />
              <col style={{ width: 80 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 84 }} />
              <col style={{ width: 84 }} />
            </colgroup>
            <thead>
              <tr>
                <th className={TH}>任务描述</th>
                <th className={TH}>任务状态</th>
                <th className={TH}>重要紧急程度</th>
                <th className={TH}>开始日期</th>
                <th className={TH}>结束日期</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((item) => {
                const overdue = Boolean(item.dueDate) && item.dueDate < today;
                return (
                  <tr
                    key={item.id}
                    className="border-b border-stone-100 transition-colors last:border-0 hover:bg-stone-50"
                  >
                    <td className={TD}>
                      <TruncatedText text={item.title} className="text-stone-700" />
                    </td>
                    <td className={TD}>
                      <StatusPill status={item.status} label={TASK_STATUS_LABEL[item.status]} />
                    </td>
                    <td className={TD}>
                      <PriorityPill
                        priority={item.priority}
                        label={item.priority ? TASK_PRIORITY_LABEL[item.priority] : '—'}
                      />
                    </td>
                    <td
                      className={`${TD} whitespace-nowrap text-[11px] text-stone-400 tabular-nums`}
                    >
                      {dateLabel(item.startDate)}
                    </td>
                    <td
                      className={`${TD} whitespace-nowrap text-[11px] tabular-nums ${
                        overdue ? 'text-[#c02a26]' : 'text-stone-400'
                      }`}
                    >
                      {dateLabel(item.dueDate)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager page={paged.page} pages={paged.pages} total={paged.total} onPage={setPage} />
      </div>
    );
  }

  return (
    <Card title="进行中任务" href="tasks/" action="打开任务">
      {body}
    </Card>
  );
}

/** 测试统计：每个维度取最新一天的计数，照飞书柱状图（纵轴刻度 + 网格线 + 柱顶数值） */
function TestChartWidget(props: { items: TestStatsItem[]; enabled: boolean; error?: string }) {
  const { items, enabled, error } = props;
  const bars = latestStatsByDimension(items, 10);
  const max = bars.reduce((acc, bar) => Math.max(acc, bar.count), 0);
  const ticks = axisTicks(max, 3);
  const axisMax = ticks[ticks.length - 1] ?? 1;

  let body: ReactNode;
  if (!enabled) {
    body = <PluginOff name="测试统计" detail="启用后这里会按维度显示最新一天的数量" />;
  } else if (error) {
    body = <SourceError message={error} />;
  } else if (!bars.length) {
    body = <Empty>还没有测试统计数据</Empty>;
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 text-[11px] leading-4 text-stone-500">
          <span className="h-2 w-2 rounded-full bg-[#3370ff]" aria-hidden="true" />
          统计数量
        </div>
        <div className="mt-8 flex min-h-0 flex-1 flex-col">
          {/* 绘图区：左侧留出刻度栏；刻度与网格线共用同一套百分比坐标 */}
          <div className="relative min-h-[88px] flex-1">
            <div className="absolute inset-y-0 left-0 w-8" aria-hidden="true">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-1 -translate-y-1/2 text-[10px] leading-none text-stone-400 tabular-nums"
                  style={{ bottom: `${(tick / axisMax) * 100}%` }}
                >
                  {tick}
                </span>
              ))}
            </div>
            <div className="absolute inset-y-0 left-9 right-0">
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute inset-x-0 border-t border-stone-100"
                  style={{ bottom: `${(tick / axisMax) * 100}%` }}
                  aria-hidden="true"
                />
              ))}
              <div className="absolute inset-0 flex items-end gap-1.5">
                {bars.map((bar) => (
                  <div
                    key={bar.dimension}
                    className="flex h-full min-w-0 flex-1 items-end justify-center"
                  >
                    <div
                      className="group/bar relative w-full max-w-8 rounded-t-[3px] bg-[#3370ff]"
                      style={{
                        height: bar.count > 0 ? `${(bar.count / axisMax) * 100}%` : '1px',
                      }}
                    >
                      {/* 数量：照飞书贴在柱顶上方（柱太高时自动让到柱内顶部） */}
                      <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 text-[10px] leading-none text-[#3370ff] tabular-nums">
                        {bar.count}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3 flex shrink-0 gap-1.5 pl-9">
            {bars.map((bar) => (
              <div key={bar.dimension} className="min-w-0 flex-1 text-center">
                <TruncatedText
                  text={bar.dimension}
                  className="text-[10px] leading-4 text-stone-400"
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card title="测试统计" href="test-stats/" action="打开测试统计">
      {body}
    </Card>
  );
}

const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];
const HOUR_START = 8;
const HOUR_END = 22;
const HOUR_HEIGHT = 34;
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);

type CalendarMode = 'day' | 'week' | 'month';

const CALENDAR_MODES: { id: CalendarMode; label: string }[] = [
  { id: 'day', label: '日' },
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
];

/** 日历胶囊：左侧色条按紧急程度，已完成整体弱化（颜色写在 global.css，深色主题一起适配） */
const CAL_PILL: Record<TodoPriority, string> = {
  urgent_important: 'tw-cal-pill--urgent-important',
  important: 'tw-cal-pill--important',
  urgent: 'tw-cal-pill--urgent',
  normal: 'tw-cal-pill--normal',
  '': 'tw-cal-pill--none',
};
const CAL_PILL_DONE = 'tw-cal-pill--done';
/** 弹层列表左侧的小色条：直接用实色，深浅主题下都看得见 */
const CAL_DOT: Record<TodoPriority, string> = {
  urgent_important: '#e5484d',
  important: '#f5a524',
  urgent: '#e3b341',
  normal: '#3370ff',
  '': '#c7c7cc',
};
/** 全天区横条高度 / 上下间距（跨天待办按泳道叠放） */
const CAL_BAR_H = 18;
const CAL_BAR_GAP = 3;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function dayNumber(iso: string): number {
  return Number(iso.slice(8, 10));
}

/** 周一 = 0 … 周日 = 6 */
function weekdayIndex(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getDay() + 6) % 7;
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${y}年${m}月`;
}

/** 周 / 日视图标题：同年只写一次年份，跨月补上月份 */
function rangeLabel(days: readonly string[]): string {
  const first = days[0] ?? '';
  const last = days[days.length - 1] ?? '';
  const [fy, fm, fd] = first.split('-').map(Number);
  const [ly, lm, ld] = last.split('-').map(Number);
  if (first === last) return `${fy}年${fm}月${fd}日（周${WEEKDAY_SHORT[weekdayIndex(first)]}）`;
  if (fy !== ly) return `${fy}年${fm}月${fd}日 – ${ly}年${lm}月${ld}日`;
  if (fm !== lm) return `${fy}年${fm}月${fd}日 – ${lm}月${ld}日`;
  return `${fy}年${fm}月${fd}日 – ${ld}日`;
}

function TodoPill({ item, onOpen }: { item: TodoItem; onOpen?: (el: HTMLElement) => void }) {
  const done = isTodoClosed(item.status);
  return (
    <button
      type="button"
      onClick={(e) => {
        if (!onOpen) return;
        e.stopPropagation();
        onOpen(e.currentTarget);
      }}
      className={`tw-cal-pill block w-full truncate text-left ${done ? CAL_PILL_DONE : CAL_PILL[item.priority]}`}
    >
      {item.title}
    </button>
  );
}

/** 弹层标题：10月8日 周四 */
function dayTitle(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}月${d}日 周${WEEKDAY_SHORT[weekdayIndex(iso)] ?? ''}`;
}

const DAY_POP_WIDTH = 288;

export interface TodoDayPopoverState {
  day: string;
  left: number;
  top?: number;
  bottom?: number;
  /** 小三角横向位置（相对弹层左边缘），指向点开它的日期格 / 横条 */
  arrowX: number;
  /** 小三角贴在上边（弹层在锚点下方）还是下边（弹层翻到上方） */
  arrowSide: 'top' | 'bottom';
  /** 从横条点进来时直接展开这条待办的详情 */
  detailId: string | null;
}

/**
 * 日历的「当天待办」弹层：先列这一天的全部待办，点其中一条再看详情。
 *
 * 走 portal + fixed：卡片本身是 `overflow-hidden`，弹层挂在卡片里会被裁掉；
 * 贴格子下方展开，下方放不下时翻到上方，左右夹在视口内。
 * 关闭：右上角 ×、点空白、Esc（详情里先退回列表）、页面滚动 / 窗口缩放（位置锚点会失效）。
 */
function TodoDayPopover({
  state,
  todos,
  today,
  onClose,
}: {
  state: TodoDayPopoverState;
  todos: TodoItem[];
  today: string;
  onClose: () => void;
}) {
  const { day, detailId } = state;
  const panelRef = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(detailId);

  useEffect(() => setOpenId(detailId), [day, detailId]);

  const items = useMemo(
    () => sortTodos(todos.filter((item) => todoCoversDay(item, day))),
    [todos, day],
  );
  const detail = openId ? (items.find((item) => item.id === openId) ?? null) : null;

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (
        panelRef.current &&
        event.target instanceof Node &&
        !panelRef.current.contains(event.target)
      )
        onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 详情里先退回列表，再按一次才关弹层
      setOpenId((current) => {
        if (current) return null;
        onClose();
        return null;
      });
    };
    const onViewportChange = () => onClose();
    // 点击画布其它地方、页面任何一层滚动 / 缩放都会让弹层锚点失效，统一关掉；
    // 弹层自己列表的滚动要放行，否则滚两条记录弹层就没了
    const onAnyScroll = (event: Event) => {
      if (
        panelRef.current &&
        event.target instanceof Node &&
        panelRef.current.contains(event.target)
      )
        return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onAnyScroll, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onAnyScroll, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={detail ? detail.title : `${dayTitle(day)} 的待办`}
      className="tw-cal-pop"
      style={{ left: state.left, top: state.top, bottom: state.bottom }}
    >
      <span
        aria-hidden="true"
        className={`tw-cal-pop-arrow tw-cal-pop-arrow--${state.arrowSide}`}
        style={{ left: state.arrowX }}
      />
      <div className="tw-cal-pop-head">
        {detail ? (
          <button
            type="button"
            aria-label="返回当天待办"
            onClick={() => setOpenId(null)}
            className="tw-cal-pop-icon"
          >
            ‹
          </button>
        ) : null}
        <span className="tw-cal-pop-title">{detail ? detail.title : dayTitle(day)}</span>
        {detail ? null : <span className="tw-cal-pop-count">{items.length} 条</span>}
        <button type="button" aria-label="关闭" onClick={onClose} className="tw-cal-pop-icon">
          ×
        </button>
      </div>

      {detail ? (
        <div className="tw-cal-pop-detail">
          <div className="tw-cal-pop-field">
            <span className="tw-cal-pop-label">待办名称</span>
            <span className="tw-cal-pop-value">{detail.title}</span>
          </div>
          <div className="tw-cal-pop-field">
            <span className="tw-cal-pop-label">待办状态</span>
            <span>
              <StatusPill
                status={effectiveTodoStatus(detail, today)}
                label={TODO_STATUS_LABEL[effectiveTodoStatus(detail, today)]}
              />
            </span>
          </div>
          {detail.priority ? (
            <div className="tw-cal-pop-field">
              <span className="tw-cal-pop-label">重要紧急程度</span>
              <span>
                <PriorityPill
                  priority={detail.priority}
                  label={TODO_PRIORITY_LABEL[detail.priority]}
                />
              </span>
            </div>
          ) : null}
          <div className="tw-cal-pop-dates">
            <div className="tw-cal-pop-field">
              <span className="tw-cal-pop-label">开始日期</span>
              <span className="tw-cal-pop-value">{dateLabel(detail.startDate)}</span>
            </div>
            <div className="tw-cal-pop-field">
              <span className="tw-cal-pop-label">截止日期</span>
              <span className="tw-cal-pop-value">{dateLabel(detail.dueDate)}</span>
            </div>
          </div>
          {detail.note ? (
            <div className="tw-cal-pop-field">
              <span className="tw-cal-pop-label">备注</span>
              <span className="tw-cal-pop-value tw-cal-pop-note">{detail.note}</span>
            </div>
          ) : null}
        </div>
      ) : items.length === 0 ? (
        <p className="tw-cal-pop-empty">这一天没有待办</p>
      ) : (
        <div className="tw-cal-pop-list">
          {items.map((item) => {
            const status = effectiveTodoStatus(item, today);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setOpenId(item.id)}
                className="tw-cal-pop-row"
              >
                <span
                  className="tw-cal-pop-bar"
                  style={{
                    background: isTodoClosed(item.status) ? '#d1d5db' : CAL_DOT[item.priority],
                  }}
                />
                <span className="tw-cal-pop-row-title">{item.title}</span>
                {status === 'overdue' ? (
                  <span className="tw-cal-pop-tag tw-cal-pop-tag--overdue">
                    {TODO_STATUS_LABEL.overdue}
                  </span>
                ) : isTodoClosed(item.status) ? (
                  <span className="tw-cal-pop-tag">{TODO_STATUS_LABEL[item.status]}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** 周 / 日视图的小时网格：08:00–22:00，今天带红色当前时间线；卡片拉高时行高跟着撑开 */
function TimeGrid({ days, today, now }: { days: string[]; today: string; now: Date }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [boxHeight, setBoxHeight] = useState(0);
  const todayIndex = days.indexOf(today);

  const minGridHeight = HOUR_HEIGHT * HOURS.length;
  /**
   * 行高按可用高度均分。这里必须向下取整：浮点除法会让 14 行加起来比容器多 1px，
   * 多出的 1px 就足以让卡片里冒出一条几乎占满高度的滚动条。
   * 除不尽的余数补给最后一行，保证正好撑满。
   */
  const baseHeight =
    boxHeight > 0 ? Math.max(HOUR_HEIGHT, Math.floor(boxHeight / HOURS.length)) : HOUR_HEIGHT;
  const remainder = boxHeight > minGridHeight ? boxHeight - baseHeight * HOURS.length : 0;
  const lastHour = HOUR_END - 1;
  const rowHeight = (hour: number) => (hour === lastHour ? baseHeight + remainder : baseHeight);
  const gridHeight = baseHeight * HOURS.length + remainder;
  /** 内容放得下就别给滚动条（也不要把视图滚到当前时间） */
  const fits = boxHeight > 0 && gridHeight <= boxHeight + 1;

  const nowTop = ((now.getHours() * 60 + now.getMinutes() - HOUR_START * 60) / 60) * baseHeight;
  const inRange = nowTop >= 0 && nowTop <= gridHeight;
  const cols = `44px repeat(${days.length}, minmax(0, 1fr))`;

  // 量一下可用高度：卡片被拉高时把 14 个小时行均分，而不是底部留一片空白
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => setBoxHeight(el.clientHeight);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 只有一天放不下（卡片太矮）才把当前时间滚到可视区上方；放得下就停在 00:00 顶部
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = !fits && todayIndex >= 0 && inRange ? Math.max(0, nowTop - 80) : 0;
    // 只在天数变化（切换日 / 周）时对齐，不跟随每分钟
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length, boxHeight, fits]);

  return (
    <div
      ref={scrollRef}
      className={`tw-dash-scroll min-h-[120px] flex-1 ${fits ? 'overflow-hidden' : 'overflow-y-auto'}`}
    >
      <div className="relative grid" style={{ gridTemplateColumns: cols }}>
        {HOURS.map((hour) => (
          <div key={hour} className="contents">
            <div className="relative" style={{ height: rowHeight(hour) }}>
              <span className="absolute -top-1.5 right-1.5 text-[10px] text-stone-400 tabular-nums">
                {pad2(hour)}:00
              </span>
            </div>
            {days.map((day) => (
              <div
                key={`${day}-${hour}`}
                className="border-t border-l border-stone-100"
                style={{ height: rowHeight(hour) }}
              />
            ))}
          </div>
        ))}
        {todayIndex >= 0 && inRange ? (
          <div
            className="pointer-events-none absolute flex items-center"
            style={{
              top: nowTop,
              left: `calc(44px + (100% - 44px) * ${todayIndex} / ${days.length})`,
              width: `calc((100% - 44px) / ${days.length})`,
            }}
          >
            <span className="absolute right-full mr-1 text-[10px] text-[#f54a45] tabular-nums">
              {pad2(now.getHours())}:{pad2(now.getMinutes())}
            </span>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#f54a45]" />
            <span className="h-px flex-1 bg-[#f54a45]" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 待办日历：照飞书日历做日 / 周 / 月三视图，跨天待办按起止日期横跨多列 */
function TodoCalendarWidget(props: { todos: TodoItem[]; enabled: boolean; error?: string }) {
  const { todos, enabled, error } = props;
  const today = todayIso();
  const [mode, setMode] = useState<CalendarMode>('week');
  const [anchor, setAnchor] = useState(today);
  const [now, setNow] = useState(() => new Date());
  /** 点开的日期弹层；位置在打开那一刻算好（fixed 坐标） */
  const [pop, setPop] = useState<TodoDayPopoverState | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const closePopover = () => setPop(null);

  const days =
    mode === 'month' ? monthRange(anchor) : mode === 'day' ? [anchor] : weekRange(anchor);

  /** 跨天待办铺成横条：起止日期之间的每一天都算覆盖（周 / 日视图） */
  const spanLayout = layoutTodoSpans(todos, days);
  /** 全天区最多铺几条泳道：太多会把下面的时间网格挤没，日视图放得松一些 */
  const visibleLanes = Math.min(spanLayout.lanes, mode === 'day' ? 6 : 3);
  const cols = `44px repeat(${days.length}, minmax(0, 1fr))`;

  const step = (dir: -1 | 1) => {
    setPop(null);
    if (mode === 'month') setAnchor(addMonthsIso(anchor, dir));
    else setAnchor(addDaysIso(anchor, dir * (mode === 'week' ? 7 : 1)));
  };

  /**
   * 在格子 / 横条旁边弹出当天待办，并在弹层上画一个小三角指回它；
   * `detailId` 用于点横条时直接看详情。
   */
  const openDayPopover = (
    day: string,
    anchorEl: HTMLElement | null,
    detailId: string | null = null,
  ) => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const gap = 10;
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    // 下方放不下且上方更宽裕时向上翻
    const openUp = spaceBelow < 300 && spaceAbove > spaceBelow;
    const left = Math.min(
      Math.max(8, r.left + r.width / 2 - DAY_POP_WIDTH / 2),
      Math.max(8, window.innerWidth - DAY_POP_WIDTH - 8),
    );
    // 三角夹在圆角以内，避免贴边溢出
    const arrowX = Math.round(
      Math.min(DAY_POP_WIDTH - 20, Math.max(20, r.left + r.width / 2 - left)),
    );
    setPop({
      day,
      detailId,
      left,
      arrowX,
      arrowSide: openUp ? 'bottom' : 'top',
      top: openUp ? undefined : r.bottom + gap,
      bottom: openUp ? Math.max(8, window.innerHeight - r.top + gap) : undefined,
    });
  };

  let body: ReactNode;
  if (!enabled) {
    body = <PluginOff name="待办事项" detail="启用后这里会按截止日期显示待办日历" />;
  } else if (error) {
    body = <SourceError message={error} />;
  } else if (mode === 'month') {
    const month = Number(anchor.slice(5, 7));
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="grid shrink-0 grid-cols-7 border-b border-stone-200 pb-1.5">
          {WEEKDAY_SHORT.map((label) => (
            <span key={label} className="text-center text-[11px] text-stone-400">
              周{label}
            </span>
          ))}
        </div>
        <div className="grid flex-1 grid-cols-7 [grid-auto-rows:minmax(0,1fr)]">
          {days.map((day) => {
            // 跨天的待办在覆盖到的每一天都露一段，起止日期都能看到
            const list = sortTodos(todos.filter((item) => todoCoversDay(item, day)));
            const shown = list.slice(0, 2);
            const rest = list.length - shown.length;
            const otherMonth = Number(day.slice(5, 7)) !== month;
            const isToday = day === today;
            return (
              <div
                key={day}
                role="button"
                tabIndex={0}
                onClick={(e) => openDayPopover(day, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  openDayPopover(day, e.currentTarget);
                }}
                className="flex min-w-0 cursor-pointer flex-col gap-0.5 border-t border-l border-stone-100 p-1 text-left transition-colors hover:bg-stone-50"
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] tabular-nums ${
                    isToday
                      ? 'bg-[#3370ff] font-semibold text-white'
                      : otherMonth
                        ? 'text-stone-300'
                        : 'text-stone-500'
                  }`}
                >
                  {dayNumber(day)}
                </span>
                {shown.map((item) => (
                  <TodoPill
                    key={item.id}
                    item={item}
                    onOpen={(el) => openDayPopover(day, el, item.id)}
                  />
                ))}
                {rest > 0 ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDayPopover(day, e.currentTarget.parentElement);
                    }}
                    className="mt-auto w-fit self-end px-1 text-left text-[10px] leading-4 text-stone-400 transition-colors hover:text-[#3370ff]"
                  >
                    还有 {rest} 条记录
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="grid shrink-0 border-b border-stone-200"
          style={{ gridTemplateColumns: cols }}
        >
          <div />
          {days.map((day) => (
            <button
              type="button"
              key={day}
              onClick={(e) => openDayPopover(day, e.currentTarget)}
              className="flex flex-col items-center gap-0.5 py-1 transition-colors hover:bg-stone-50"
            >
              <span className="text-[11px] text-stone-400">
                周{WEEKDAY_SHORT[weekdayIndex(day)] ?? ''}
              </span>
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-[13px] tabular-nums ${
                  day === today
                    ? 'bg-[#3370ff] font-semibold text-white'
                    : 'font-medium text-stone-700'
                }`}
              >
                {dayNumber(day)}
              </span>
            </button>
          ))}
        </div>
        {/*
          全天区：跨天待办画成一条横跨多列的色条（起 → 止），
          列分隔线单独画在底层，横条叠在上面，和飞书日历一致。
        */}
        <div className="relative shrink-0 border-b border-stone-200">
          <div
            className="pointer-events-none absolute inset-y-0 right-0 left-[44px] grid"
            style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
          >
            {days.map((day) => (
              <div key={day} className="border-l border-stone-100" />
            ))}
          </div>
          <div className="flex items-start">
            <div className="flex h-[22px] w-11 shrink-0 items-center justify-end pr-1.5 text-[10px] text-stone-400">
              全天
            </div>
            <div
              className="relative min-w-0 flex-1 overflow-hidden"
              style={{ height: Math.max(1, visibleLanes) * (CAL_BAR_H + CAL_BAR_GAP) }}
            >
              {spanLayout.spans
                .filter((span) => span.lane < visibleLanes)
                .map(({ item, start, end, lane }) => {
                  const done = isTodoClosed(item.status);
                  const daysInSpan = end - start + 1;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      onClick={(e) =>
                        openDayPopover(days[start] ?? today, e.currentTarget, item.id)
                      }
                      className={`tw-cal-bar absolute flex items-center gap-1 text-left ${
                        done ? CAL_PILL_DONE : CAL_PILL[item.priority]
                      }`}
                      style={{
                        top: lane * (CAL_BAR_H + CAL_BAR_GAP),
                        left: `calc(100% * ${start} / ${days.length})`,
                        width: `calc(100% * ${daysInSpan} / ${days.length})`,
                        height: CAL_BAR_H,
                      }}
                    >
                      <span className="truncate px-1">{item.title}</span>
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
        <TimeGrid days={days} today={today} now={now} />
      </div>
    );
  }

  return (
    <Card title="待办日历" href="todos/" action="打开待办" fill>
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setPop(null);
            setAnchor(today);
          }}
          className="h-7 rounded-lg border border-stone-200 bg-white px-2.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900"
        >
          今天
        </button>
        <button
          type="button"
          aria-label="上一页"
          onClick={() => step(-1)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="下一页"
          onClick={() => step(1)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          ›
        </button>
        <span className="ml-1 text-[13px] font-semibold text-stone-800 tabular-nums">
          {mode === 'month' ? monthLabel(anchor) : rangeLabel(days)}
        </span>
        <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-stone-100 p-0.5">
          {CALENDAR_MODES.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => {
                setPop(null);
                setMode(item.id);
              }}
              className={`h-6 w-8 rounded-md text-[11px] transition-colors ${
                mode === item.id
                  ? 'bg-white font-medium text-stone-900 shadow-sm'
                  : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {body}
      {pop ? (
        <TodoDayPopover state={pop} todos={todos} today={today} onClose={closePopover} />
      ) : null}
    </Card>
  );
}

export interface DashboardWidgetData {
  todos: TodoItem[];
  tasks: TaskItem[];
  stats: TestStatsItem[];
  todosOn: boolean;
  tasksOn: boolean;
  statsOn: boolean;
  errors: { todos?: string; tasks?: string; stats?: string };
  /** 勾选今日待办：交给 board 落库并刷新（状态在仪表盘里只读） */
  onToggleTodo: (item: TodoItem) => Promise<void>;
}

/** 按 id 渲染卡片内容；栅格跨度由 board 根据 DASHBOARD_WIDGETS 决定 */
export function DashboardWidgetBody({
  id,
  data,
}: {
  id: DashboardWidgetId;
  data: DashboardWidgetData;
}) {
  switch (id) {
    case 'kpi':
      return (
        <Card title="待办概览">
          <KpiWidget
            todos={data.todos}
            tasks={data.tasks}
            todosOn={data.todosOn}
            tasksOn={data.tasksOn}
          />
        </Card>
      );
    case 'countdown':
      return (
        <Card title="休息倒计时">
          <CountdownWidget />
        </Card>
      );
    case 'todayTodos':
      return (
        <TodayTodosWidget
          todos={data.todos}
          enabled={data.todosOn}
          error={data.errors.todos}
          onToggle={data.onToggleTodo}
        />
      );
    case 'activeTasks':
      return (
        <ActiveTasksWidget tasks={data.tasks} enabled={data.tasksOn} error={data.errors.tasks} />
      );
    case 'testChart':
      return (
        <TestChartWidget items={data.stats} enabled={data.statsOn} error={data.errors.stats} />
      );
    case 'todoCalendar':
      return (
        <TodoCalendarWidget todos={data.todos} enabled={data.todosOn} error={data.errors.todos} />
      );
  }
}
