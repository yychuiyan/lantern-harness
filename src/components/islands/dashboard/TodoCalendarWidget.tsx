/**
 * 待办日历：照飞书日历做日 / 周 / 月三视图，跨天待办按起止日期横跨多列。
 * 弹层（当天待办）与小时网格也在这个文件里，避免和卡片主体拆得太散。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  addDaysIso,
  addMonthsIso,
  layoutTodoMonthWeeks,
  layoutTodoSpans,
  monthRange,
  todoCoversDay,
  weekRange,
} from '../../../lib/dashboard';
import {
  TODO_PRIORITY_LABEL,
  TODO_STATUS_LABEL,
  effectiveTodoStatus,
  isTodoClosed,
  sortTodos,
  todayIso,
  type TodoItem,
  type TodoPriority,
} from '../../../lib/todos';
import { readViewPref, writeViewPref } from '../../../lib/view-prefs';
import {
  DashboardCard,
  IconCalendar,
  PluginOff,
  PriorityPill,
  SourceError,
  StatusPill,
} from './DashboardCard';
import { dateLabel } from './format';

const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];
/** 小时网格覆盖一整天：00:00 → 23:00（最后一行是 23:00 那一格） */
const HOUR_START = 0;
const HOUR_END = 24;
const HOUR_HEIGHT = 34;
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);

type CalendarMode = 'day' | 'week' | 'month';

const CALENDAR_MODES: { id: CalendarMode; label: string }[] = [
  { id: 'day', label: '日' },
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
];
const CALENDAR_MODE_IDS: readonly CalendarMode[] = CALENDAR_MODES.map((item) => item.id);

/** 日历配色：同一条待办在日 / 周 / 月视图里颜色一致（按 id 稳定散列，刷新不会变色） */
const CAL_TONES = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'lime', 'indigo'] as const;

export function todoTone(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `tw-cal-tone-${CAL_TONES[hash % CAL_TONES.length]}`;
}

/** 胶囊 / 横条的类名：已完成统一弱化，其余按待办取色 */
function barTone(item: TodoItem): string {
  return isTodoClosed(item.status) ? 'tw-cal-pill--done' : todoTone(item.id);
}
/** 左侧 2px 色条仍按重要紧急程度，颜色由内联样式给（未完成时） */
function barAccent(item: TodoItem): string | undefined {
  return isTodoClosed(item.status) ? undefined : CAL_DOT[item.priority];
}
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
/** 月视图：每个日期格子顶部放日期数字的高度，以及横条高度 */
const MONTH_DAY_ROW = 28;
const MONTH_BAR_H = 15;
const MONTH_BAR_GAP = 3;

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

/** 弹层标题：10月8日 周四 */
function dayTitle(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
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

export function TodoCalendarWidget(props: { todos: TodoItem[]; enabled: boolean; error?: string }) {
  const { todos, enabled, error } = props;
  const today = todayIso();
  const [mode, setMode] = useState<CalendarMode>(() =>
    readViewPref('dashboard.calendar', CALENDAR_MODE_IDS, 'week'),
  );
  const [anchor, setAnchor] = useState(today);
  const [now, setNow] = useState(() => new Date());
  /** 点开的日期弹层；位置在打开那一刻算好（fixed 坐标） */
  const [pop, setPop] = useState<TodoDayPopoverState | null>(null);
  /** 月视图容器高度：决定每周能铺几条横条（卡片拉高后自动多铺一条） */
  const [monthNode, setMonthNode] = useState<HTMLDivElement | null>(null);
  const [monthHeight, setMonthHeight] = useState(0);

  useEffect(() => {
    if (!monthNode) return;
    const sync = () => setMonthHeight(monthNode.clientHeight);
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(monthNode);
    return () => observer.disconnect();
  }, [monthNode]);

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
    /**
     * 月视图按周分行：跨天待办在每一周里都是一条连续的长条（跨周自动断开）。
     * 泳道按整月排好再按周裁（layoutTodoMonthWeeks）：同一条待办每一周都停在同一行，
     * 不会因为「这周从周几开始」在上下行之间跳。
     */
    const weeks = layoutTodoMonthWeeks(todos, days);
    const lanePitch = MONTH_BAR_H + MONTH_BAR_GAP;
    const weekHeight = monthHeight > 0 ? monthHeight / weeks.length : 0;
    const lanes = Math.max(
      1,
      Math.min(4, Math.floor((weekHeight - MONTH_DAY_ROW - 4) / lanePitch)),
    );
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="grid shrink-0 grid-cols-7 border-b border-stone-200 pb-1.5">
          {WEEKDAY_SHORT.map((label) => (
            <span key={label} className="text-center text-[11px] text-stone-400">
              周{label}
            </span>
          ))}
        </div>
        <div
          ref={setMonthNode}
          className="grid min-h-0 flex-1"
          style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
        >
          {weeks.map(({ days: week, spans }) => {
            const shown = spans.filter((span) => span.lane < lanes);
            const hidden = spans.filter((span) => span.lane >= lanes);
            return (
              <div
                key={week[0]}
                className="relative flex min-h-0 flex-col border-t border-stone-100"
              >
                <div className="grid shrink-0 grid-cols-7">
                  {week.map((day) => {
                    const otherMonth = Number(day.slice(5, 7)) !== month;
                    const isToday = day === today;
                    return (
                      <button
                        type="button"
                        key={day}
                        onClick={(e) => openDayPopover(day, e.currentTarget)}
                        className="flex h-7 min-w-0 items-center px-1.5 text-left transition-colors hover:bg-stone-50"
                      >
                        <span
                          className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums ${
                            isToday
                              ? 'bg-[#3370ff] font-semibold text-white'
                              : otherMonth
                                ? 'text-stone-300'
                                : 'text-stone-500'
                          }`}
                        >
                          {dayNumber(day)}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <div className="pointer-events-none absolute inset-0 grid grid-cols-7">
                    {week.map((day) => (
                      <div key={day} className="border-l border-stone-100" />
                    ))}
                  </div>
                  {shown.map(({ item, start, end, lane }) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={(e) =>
                        openDayPopover(week[start] ?? today, e.currentTarget, item.id)
                      }
                      className={`tw-cal-bar absolute flex items-center text-left ${barTone(item)}`}
                      style={{
                        top: lane * lanePitch,
                        left: `calc(100% * ${start} / 7)`,
                        width: `calc(100% * ${end - start + 1} / 7)`,
                        height: MONTH_BAR_H,
                        borderLeftColor: barAccent(item),
                      }}
                    >
                      <span className="truncate px-1">{item.title}</span>
                    </button>
                  ))}
                  {hidden.length > 0 ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        const first = hidden[0]!;
                        openDayPopover(week[first.start] ?? today, e.currentTarget);
                      }}
                      className="absolute right-1 bottom-0 rounded bg-white/85 px-1 text-[10px] leading-4 text-stone-400 transition-colors hover:text-[#3370ff]"
                    >
                      +{hidden.length}
                    </button>
                  ) : null}
                </div>
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
                  const daysInSpan = end - start + 1;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      onClick={(e) =>
                        openDayPopover(days[start] ?? today, e.currentTarget, item.id)
                      }
                      className={`tw-cal-bar absolute flex items-center gap-1 text-left ${barTone(item)}`}
                      style={{
                        top: lane * (CAL_BAR_H + CAL_BAR_GAP),
                        left: `calc(100% * ${start} / ${days.length})`,
                        width: `calc(100% * ${daysInSpan} / ${days.length})`,
                        height: CAL_BAR_H,
                        borderLeftColor: barAccent(item),
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
    <DashboardCard
      title="待办日历"
      icon={<IconCalendar />}
      tone="violet"
      href="todos/"
      action="打开待办"
      fill
    >
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
                writeViewPref('dashboard.calendar', item.id);
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
    </DashboardCard>
  );
}
