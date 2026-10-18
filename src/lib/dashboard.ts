/**
 * 仪表盘（扩展插件）的纯函数与类型：卡片清单、布局归一化、KPI、倒计时、
 * 最新一天的测试统计、周视图范围。
 *
 * 数据全部来自现有三个接口（待办 / 任务 / 测试统计），这里只做聚合与派生，
 * 不落库、不新增中间件；布局偏好由 view-prefs 存浏览器本地。
 */
import type { TaskItem } from './tasks';
import { sortTasks } from './tasks';
import { EMPTY_CALENDAR, isRestDay, restDayName, type HolidayCalendar } from './cn-holidays';
import type { TestStatsItem } from './test-stats';
import type { TodoItem } from './todos';
import { effectiveTodoStatus, isTodoClosed, sortTodos, todayIso } from './todos';

export type DashboardWidgetId =
  'kpi' | 'countdown' | 'todayTodos' | 'activeTasks' | 'testChart' | 'todoCalendar';

export interface DashboardWidgetDef {
  id: DashboardWidgetId;
  title: string;
  /** 卡片一句话说明（「编辑组件」弹层里展示） */
  desc: string;
  /** 默认宽度：12 列画布里的列数（整行 12 / 半行 6） */
  w: number;
  /** 默认高度：行数（行高 DASHBOARD_ROW_HEIGHT） */
  h: number;
  /** 最小宽度（列），避免拖到太窄内容挤成一团 */
  minW?: number;
  /** 卡片内容的最小高度（px），日历这类有固定表头的卡压太矮会把网格挤没 */
  minHeight?: number;
}

/** 卡片清单（声明顺序即「编辑组件」里的展示顺序、也是默认布局的摆放顺序） */
export const DASHBOARD_WIDGETS: readonly DashboardWidgetDef[] = [
  { id: 'kpi', title: '待办概览', desc: '进行中 / 已逾期 / 完成率', w: 12, h: 10, minW: 6 },
  {
    id: 'countdown',
    title: '休息倒计时',
    desc: '距下一个休息日 00:00（含节假日与调休）',
    w: 6,
    h: 11,
    minW: 4,
  },
  {
    id: 'todayTodos',
    title: '今日待办',
    desc: '开始 ~ 截止区间含今天，可勾选完成',
    w: 6,
    h: 12,
    minW: 4,
  },
  { id: 'activeTasks', title: '进行中任务', desc: '状态为进行中的任务', w: 6, h: 19, minW: 4 },
  { id: 'testChart', title: '测试统计', desc: '各维度最新一天的数量', w: 6, h: 19, minW: 4 },
  {
    id: 'todoCalendar',
    title: '待办日历',
    desc: '日 / 周 / 月视图',
    w: 12,
    h: 36,
    minW: 6,
    minHeight: 320,
  },
];

export const DASHBOARD_WIDGET_IDS: readonly DashboardWidgetId[] = DASHBOARD_WIDGETS.map(
  (w) => w.id,
);

const WIDGET_ID_SET = new Set<string>(DASHBOARD_WIDGET_IDS);

export function isDashboardWidgetId(value: unknown): value is DashboardWidgetId {
  return typeof value === 'string' && WIDGET_ID_SET.has(value);
}

export function getDashboardWidget(id: DashboardWidgetId): DashboardWidgetDef {
  return DASHBOARD_WIDGETS.find((w) => w.id === id)!;
}

/**
 * 12 列自由画布上的位置与尺寸（照飞书仪表盘：x / y / w / h 都是栅格单位）。
 * 画布用绝对定位渲染，不再有「同一行」的概念，卡片高度互不影响。
 */
export interface DashboardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardLayout {
  /** 用户主动隐藏的卡片（位置信息保留，重新添加时尽量放回原处） */
  hidden: DashboardWidgetId[];
  /** 每张卡在画布上的坐标；没存过的卡用默认位置 */
  rects: Partial<Record<DashboardWidgetId, DashboardRect>>;
}

export const DASHBOARD_COLS = 12;
/** 行高：高度按 20px 一档调整，拖起来是连续的 */
export const DASHBOARD_ROW_HEIGHT = 20;
/** 卡片四周留白（画布格子的 padding）；两张卡之间的视觉间距 = 2 × 该值 */
export const DASHBOARD_CELL_INSET = 8;
/** 内容高度范围（px）：太矮会挤掉内容，太高会撑出很长的滚动 */
export const DASHBOARD_MIN_HEIGHT = 180;
export const DASHBOARD_MAX_HEIGHT = 960;
export const DASHBOARD_MAX_ROWS = Math.ceil(
  (DASHBOARD_MAX_HEIGHT + DASHBOARD_CELL_INSET * 2) / DASHBOARD_ROW_HEIGHT,
);

/** px 高度换算成行数（含卡片上下留白） */
export function dashboardRowsForHeight(px: number): number {
  return Math.max(1, Math.ceil((px + DASHBOARD_CELL_INSET * 2) / DASHBOARD_ROW_HEIGHT));
}

/** 某张卡的最小行数：卡片自带下限优先，且不低于通用下限 */
export function dashboardMinRows(id: DashboardWidgetId): number {
  return Math.max(
    dashboardRowsForHeight(DASHBOARD_MIN_HEIGHT),
    dashboardRowsForHeight(getDashboardWidget(id).minHeight ?? 0),
  );
}

/** 某张卡的最小列数 */
export function dashboardMinCols(id: DashboardWidgetId): number {
  return Math.max(1, getDashboardWidget(id).minW ?? 4);
}

function rectsOverlap(a: DashboardRect, b: DashboardRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 默认摆放：按声明顺序把半行卡两两并排、整行卡单独占一行。
 * 只在「全部添加」和没有历史布局时用；之后由用户自由拖拽。
 */
function packDefaultRects(
  ids: readonly DashboardWidgetId[],
): Record<DashboardWidgetId, DashboardRect> {
  const rects = {} as Record<DashboardWidgetId, DashboardRect>;
  let y = 0;
  let pending: { top: number; h: number } | null = null;

  for (const id of ids) {
    const def = getDashboardWidget(id);
    const w = Math.min(DASHBOARD_COLS, Math.max(dashboardMinCols(id), def.w));
    if (w >= DASHBOARD_COLS) {
      if (pending) {
        y = pending.top + pending.h;
        pending = null;
      }
      rects[id] = { x: 0, y, w: DASHBOARD_COLS, h: def.h };
      y += def.h;
    } else if (!pending) {
      pending = { top: y, h: def.h };
      rects[id] = { x: 0, y, w, h: def.h };
    } else {
      rects[id] = { x: DASHBOARD_COLS - w, y: pending.top, w, h: def.h };
      y = pending.top + Math.max(pending.h, def.h);
      pending = null;
    }
  }
  return rects;
}

const DEFAULT_RECTS = packDefaultRects(DASHBOARD_WIDGET_IDS);

/** 单张卡的默认位置（不共享对象，调用方可以放心改） */
export function defaultDashboardRect(id: DashboardWidgetId): DashboardRect {
  return { ...DEFAULT_RECTS[id] };
}

/** 首次进入：组件全部先关掉，由用户自己在「编辑组件」里挑（飞书那种空白画布） */
export function defaultDashboardLayout(): DashboardLayout {
  return {
    hidden: [...DASHBOARD_WIDGET_IDS],
    rects: {},
  };
}

/**
 * 把六张卡全部放回画布（「编辑组件」里的「全部添加」）。
 * 已经摆过的卡保留原坐标与大小，只补上没位置的卡，避免点一下就把排好的布局打回默认。
 */
export function allDashboardWidgetsLayout(layout?: DashboardLayout): DashboardLayout {
  const rects = { ...(layout?.rects ?? {}) };
  for (const id of DASHBOARD_WIDGET_IDS) {
    if (!rects[id]) rects[id] = defaultDashboardRect(id);
  }
  return normalizeDashboardLayout({ hidden: [], rects });
}

function idList(raw: unknown): DashboardWidgetId[] {
  if (!Array.isArray(raw)) return [];
  const out: DashboardWidgetId[] = [];
  for (const x of raw) {
    if (!isDashboardWidgetId(x) || out.includes(x)) continue;
    out.push(x);
  }
  return out;
}

/** 旧版「宽度覆盖」：只在迁移旧布局时用 */
function spanMap(raw: unknown): Partial<Record<DashboardWidgetId, 'half' | 'full'>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<DashboardWidgetId, 'half' | 'full'>> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDashboardWidgetId(id)) continue;
    if (value !== 'half' && value !== 'full') continue;
    out[id] = value;
  }
  return out;
}

/** 旧版「高度覆盖」：只在迁移旧布局时用 */
function heightMap(raw: unknown): Partial<Record<DashboardWidgetId, number>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<DashboardWidgetId, number>> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDashboardWidgetId(id)) continue;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) continue;
    out[id] = Math.round(Math.min(DASHBOARD_MAX_HEIGHT, Math.max(DASHBOARD_MIN_HEIGHT, n)));
  }
  return out;
}

/**
 * 旧布局（order / spans / heights）→ 坐标画布。
 * 仪表盘还没发版，正常不会走到这里；留着是为了本地已经拖过布局的浏览器升级后不丢位置。
 */
function migrateLegacyLayout(r: Record<string, unknown>): DashboardLayout {
  const hidden = idList(r.hidden);
  const order = idList(r.order);
  for (const id of DASHBOARD_WIDGET_IDS) {
    if (!order.includes(id)) order.push(id);
  }
  const spans = spanMap(r.spans);
  const heights = heightMap(r.heights);
  const rects: Partial<Record<DashboardWidgetId, DashboardRect>> = {};
  let y = 0;
  let pending: { top: number; h: number } | null = null;

  for (const id of order) {
    if (hidden.includes(id)) continue;
    const def = getDashboardWidget(id);
    const w =
      spans[id] === 'full'
        ? DASHBOARD_COLS
        : spans[id] === 'half'
          ? Math.max(dashboardMinCols(id), 6)
          : def.w;
    const h = heights[id] ? dashboardRowsForHeight(heights[id]!) : def.h;
    if (w >= DASHBOARD_COLS) {
      if (pending) {
        y = pending.top + pending.h;
        pending = null;
      }
      rects[id] = { x: 0, y, w: DASHBOARD_COLS, h };
      y += h;
    } else if (!pending) {
      pending = { top: y, h };
      rects[id] = { x: 0, y, w, h };
    } else {
      rects[id] = { x: DASHBOARD_COLS - w, y: pending.top, w, h };
      y = pending.top + Math.max(pending.h, h);
      pending = null;
    }
  }
  return { hidden, rects };
}

/** 单张卡的坐标归一化：非法值丢弃，越界 / 过小 / 过大夹回允许范围 */
function rectOf(id: DashboardWidgetId, raw: unknown): DashboardRect | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const read = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const x = read(r.x);
  const y = read(r.y);
  const w = read(r.w);
  const h = read(r.h);
  if (x === null || y === null || w === null || h === null) return null;
  const minW = dashboardMinCols(id);
  const width = Math.max(minW, Math.min(DASHBOARD_COLS, w));
  const height = Math.max(dashboardMinRows(id), Math.min(DASHBOARD_MAX_ROWS, h));
  return {
    x: Math.max(0, Math.min(DASHBOARD_COLS - width, x)),
    y: Math.max(0, y),
    w: width,
    h: height,
  };
}

/**
 * 把互相压住的可见卡片逐个往下推开（上方的卡不动，只挪下方那张）。
 * 用于两处：读取历史布局时兜底（老版本拖乱的数据不能一进来就叠在一起），
 * 以及缩放 / 拖动松手后的收边。返回 true 表示有过改动。
 */
function resolveOverlaps(
  hidden: readonly DashboardWidgetId[],
  rects: Partial<Record<DashboardWidgetId, DashboardRect>>,
): void {
  const hiddenSet = new Set(hidden);
  // 按 y / x 从左上到右下依次落位：每张卡只看已经落好的卡，被压住就挪到它们下方
  const order = DASHBOARD_WIDGET_IDS.filter((id) => !hiddenSet.has(id) && rects[id]).sort(
    (a, b) => rects[a]!.y - rects[b]!.y || rects[a]!.x - rects[b]!.x,
  );
  const placed: DashboardRect[] = [];
  for (const id of order) {
    const rect = rects[id]!;
    for (let guard = 0; guard <= order.length; guard += 1) {
      const hits = placed.filter((item) => rectsOverlap(item, rect));
      if (hits.length === 0) break;
      rect.y = Math.max(...hits.map((item) => item.y + item.h));
    }
    placed.push(rect);
  }
}

/**
 * 布局归一化：隐藏项去重、坐标夹到画布内、互相压住的卡往下让位；
 * 没有 rects 时尝试迁移旧布局。没存过布局（首次打开插件）→ 六张卡全部关闭。
 */
export function normalizeDashboardLayout(raw: unknown): DashboardLayout {
  const layout = parseDashboardLayout(raw);
  resolveOverlaps(layout.hidden, layout.rects);
  return layout;
}

function parseDashboardLayout(raw: unknown): DashboardLayout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultDashboardLayout();
  const r = raw as Record<string, unknown>;
  if (!r.rects || typeof r.rects !== 'object') {
    if (Array.isArray(r.order)) return migrateLegacyLayout(r);
    return { hidden: idList(r.hidden), rects: {} };
  }
  const rects: Partial<Record<DashboardWidgetId, DashboardRect>> = {};
  for (const [id, value] of Object.entries(r.rects as Record<string, unknown>)) {
    if (!isDashboardWidgetId(id)) continue;
    const rect = rectOf(id, value);
    if (rect) rects[id] = rect;
  }
  return { hidden: idList(r.hidden), rects };
}

/**
 * 窄屏（手机 / 分栏）用的堆叠坐标：既有坐标不动，只按「从上到下、从左到右」的阅读顺序
 * 排成一列满宽卡片，返回的 y 是连续累加的行号。窗口变宽后仍用原来的画布坐标。
 */
export function stackedDashboardWidgets(
  layout: DashboardLayout,
): { id: DashboardWidgetId; rect: DashboardRect }[] {
  const ordered = [...visibleDashboardWidgets(layout)].sort(
    (a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x,
  );
  let y = 0;
  return ordered.map(({ id, rect }) => {
    const next: DashboardRect = { x: 0, y, w: DASHBOARD_COLS, h: rect.h };
    y += rect.h;
    return { id, rect: next };
  });
}

/** 卡片生效坐标：用户改过用用户的，否则默认位置 */
export function dashboardRect(layout: DashboardLayout, id: DashboardWidgetId): DashboardRect {
  return layout.rects[id] ?? defaultDashboardRect(id);
}

export function visibleDashboardWidgets(
  layout: DashboardLayout,
): { id: DashboardWidgetId; def: DashboardWidgetDef; rect: DashboardRect }[] {
  const hidden = new Set(layout.hidden);
  return DASHBOARD_WIDGET_IDS.filter((id) => !hidden.has(id)).map((id) => ({
    id,
    def: getDashboardWidget(id),
    rect: dashboardRect(layout, id),
  }));
}

/**
 * 把一张卡放回画布：原来有位置且没和别的卡重叠就放回原处，
 * 否则排到画布最下方（飞书画布新组件也是追加在底部）。
 */
export function placeDashboardWidget(
  layout: DashboardLayout,
  id: DashboardWidgetId,
): DashboardLayout {
  const hidden = new Set(layout.hidden);
  // 可见卡里没存过坐标的按默认位置算，否则「重新添加」可能和它叠在一起
  const others = DASHBOARD_WIDGET_IDS.filter((wid) => wid !== id && !hidden.has(wid)).map(
    (wid) => [wid, layout.rects[wid] ?? defaultDashboardRect(wid)] as const,
  );
  const existing = layout.rects[id];
  const available =
    existing && !others.some(([, rect]) => rectsOverlap(existing, rect)) ? existing : null;
  const rect = available ?? {
    x: 0,
    y: others.reduce((bottom, [, item]) => Math.max(bottom, item.y + item.h), 0),
    w: getDashboardWidget(id).w,
    h: getDashboardWidget(id).h,
  };
  return normalizeDashboardLayout({ ...layout, rects: { ...layout.rects, [id]: rect } });
}

/**
 * 缩放卡片后收边：把与被改卡片重叠的卡依次向下推开，
 * 再沿被推开的卡继续往下传递（飞书那种「拉高就把下面的卡挤下去」）。
 * 只处理可见卡片；隐藏卡保留原坐标，重新添加时还放得回去。
 */
export function settleDashboardOverlaps(
  layout: DashboardLayout,
  id: DashboardWidgetId,
): DashboardLayout {
  const hidden = new Set(layout.hidden);
  if (hidden.has(id)) return layout;

  const ids = DASHBOARD_WIDGET_IDS.filter((wid) => !hidden.has(wid));
  // 逐个复制：后面会改 y，不能动到 React state 里的坐标对象
  const rects: Partial<Record<DashboardWidgetId, DashboardRect>> = {};
  for (const wid of DASHBOARD_WIDGET_IDS) {
    const rect = layout.rects[wid];
    if (rect) rects[wid] = { ...rect };
  }
  for (const wid of ids) {
    if (!rects[wid]) rects[wid] = defaultDashboardRect(wid);
  }
  // 从上往下处理：先让最上面的卡让位，后面的卡再按需被推得更少
  const order = [...ids].sort((a, b) => rects[a]!.y - rects[b]!.y || rects[a]!.x - rects[b]!.x);

  const queue: DashboardWidgetId[] = [id];
  // 每次推开都只会让 y 变大，循环一定有界；给个上限防御脏数据
  let guard = 500;
  while (queue.length > 0 && guard > 0) {
    guard -= 1;
    const current = queue.shift()!;
    const base = rects[current]!;
    for (const other of order) {
      if (other === current) continue;
      const rect = rects[other]!;
      if (!rectsOverlap(base, rect)) continue;
      rect.y = base.y + base.h;
      queue.push(other);
    }
  }
  return { hidden: layout.hidden, rects };
}

export interface DashboardKpis {
  /** 进行中待办 */
  todoInProgress: number;
  /** 进行中任务 */
  taskInProgress: number;
  /** 已逾期待办（未完成且过了截止日期） */
  overdue: number;
  todoDone: number;
  /** 可计完成 = 全部待办 - 已取消 */
  todoTotal: number;
  todoRate: number;
  taskDone: number;
  /** 可计完成 = 全部任务 - 已关闭 - 已取消 */
  taskTotal: number;
  taskRate: number;
}

function rate(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

export function dashboardKpis(
  todos: readonly TodoItem[],
  tasks: readonly TaskItem[],
  today: string = todayIso(),
): DashboardKpis {
  let todoInProgress = 0;
  let overdue = 0;
  let todoDone = 0;
  let todoTotal = 0;
  for (const item of todos) {
    if (item.status === 'cancelled') continue;
    todoTotal += 1;
    if (item.status === 'done') todoDone += 1;
    if (item.status === 'in_progress') todoInProgress += 1;
    if (effectiveTodoStatus(item, today) === 'overdue') overdue += 1;
  }
  let taskInProgress = 0;
  let taskDone = 0;
  let taskTotal = 0;
  for (const item of tasks) {
    if (item.status === 'closed' || item.status === 'cancelled') continue;
    taskTotal += 1;
    if (item.status === 'done') taskDone += 1;
    if (item.status === 'in_progress') taskInProgress += 1;
  }
  return {
    todoInProgress,
    taskInProgress,
    overdue,
    todoDone,
    todoTotal,
    todoRate: rate(todoDone, todoTotal),
    taskDone,
    taskTotal,
    taskRate: rate(taskDone, taskTotal),
  };
}

/**
 * 待办的生效区间：开始时间 ~ 截止时间（含两端）。
 * 只填一端时退化为那一天（只填截止时间 = 当天截止，只填开始时间 = 从那天开始且无截止日）。
 * 两端填反了按较小的当开始，避免这类脏数据整天都不出现。
 */
function todoRange(item: TodoItem): { start: string; end: string } | null {
  const start = item.startDate || item.dueDate;
  const end = item.dueDate || item.startDate;
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** 今日待办：开始时间 ~ 截止时间的区间包含今天，且未完成 / 未取消 */
export function todayTodos(todos: readonly TodoItem[], today: string = todayIso()): TodoItem[] {
  return sortTodos(
    todos.filter((item) => {
      if (isTodoClosed(item.status)) return false;
      const range = todoRange(item);
      return Boolean(range && range.start <= today && today <= range.end);
    }),
  );
}

/** 进行中任务（顺序与任务管理页一致） */
export function activeTasks(tasks: readonly TaskItem[]): TaskItem[] {
  return sortTasks(tasks.filter((item) => item.status === 'in_progress'));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseLocalDate(iso: string): Date | null {
  if (!DATE_RE.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 日期加减（本地日期，跨月 / 跨年安全）；非法输入返回原值 */
export function addDaysIso(iso: string, days: number): string {
  const date = parseLocalDate(iso);
  if (!date) return iso;
  date.setDate(date.getDate() + days);
  return isoOf(date);
}

/** `to - from` 相差多少天（本地日期）；任一非法时返回 0 */
export function daysBetweenIso(from: string, to: string): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** 月份加减：先归到 1 号再换月，避免 31 号 + 1 月跳到下下月 */
export function addMonthsIso(iso: string, months: number): string {
  const date = parseLocalDate(iso);
  if (!date) return iso;
  return isoOf(new Date(date.getFullYear(), date.getMonth() + months, 1));
}

/** 月视图范围：固定 6 行 × 7 列，从包含 1 号的那一周的周一算起 */
export function monthRange(anchor: string = todayIso()): string[] {
  const date = parseLocalDate(anchor) ?? new Date();
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return isoOf(d);
  });
}

/** 周视图范围：返回 Monday → Sunday 的 7 个日期（本地日期） */
export function weekRange(anchor: string = todayIso()): string[] {
  const date = parseLocalDate(anchor) ?? new Date();
  // getDay(): 0 = 周日，1 = 周一 …… 6 = 周六
  const offset = (date.getDay() + 6) % 7;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return isoOf(d);
  });
}

export interface RestCountdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** 今天就已经在休息（周末 / 法定节假日）：显示 00:00:00:00 */
  resting: boolean;
  /** 倒计时的终点是哪个休息日：「周末」或节日名（「国庆节」） */
  target: string;
  /** 终点的日期（YYYY-MM-DD），用来判断该年的安排是否还没公布 */
  targetDate: string;
}

const REST_ZERO: RestCountdown = {
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
  resting: true,
  target: '周末',
  targetDate: '',
};

/**
 * 距离下一个休息日 00:00 的天 / 时 / 分 / 秒。
 *
 * 休息日按 `cn-holidays` 的数据算（法定节假日 + 周末，调休补班的周末不算）：
 * 法定假期提前开始倒计时，调休补班的周六 / 周日会顺延到下一个真正的休息日。
 * 今天已经在休息则返回全 0。
 */
export function restCountdown(
  now: Date = new Date(),
  calendar: HolidayCalendar = EMPTY_CALENDAR,
): RestCountdown {
  const today = isoOf(now);
  if (isRestDay(calendar, today)) {
    return { ...REST_ZERO, target: restDayName(calendar, today) ?? '周末', targetDate: today };
  }

  let targetIso: string | null = null;
  let cursor = today;
  for (let i = 1; i <= 400; i += 1) {
    cursor = addDaysIso(cursor, 1);
    if (isRestDay(calendar, cursor)) {
      targetIso = cursor;
      break;
    }
  }
  if (!targetIso) return { ...REST_ZERO, resting: false };

  const target = parseLocalDate(targetIso);
  const diff = Math.max(0, (target?.getTime() ?? now.getTime()) - now.getTime());
  const totalSeconds = Math.floor(diff / 1000);
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
    resting: false,
    target: restDayName(calendar, targetIso) ?? '周末',
    targetDate: targetIso,
  };
}

export interface DashboardStatBar {
  dimension: string;
  count: number;
  date: string;
}

/**
 * 每个维度取最新一天的计数：日期新的优先，同一天取最新创建；
 * 跳过占位行与空维度，按数量降序（同数量按维度名稳定排序）。
 */
export function latestStatsByDimension(
  items: readonly TestStatsItem[],
  limit = 10,
): DashboardStatBar[] {
  const latest = new Map<string, TestStatsItem>();
  for (const item of items) {
    if (item.draft) continue;
    const dimension = item.dimensions[0]?.trim();
    if (!dimension) continue;
    const current = latest.get(dimension);
    if (
      !current ||
      item.date > current.date ||
      (item.date === current.date && item.createdAt > current.createdAt)
    ) {
      latest.set(dimension, item);
    }
  }
  return [...latest.values()]
    .map((item) => ({
      dimension: item.dimensions[0]!,
      count: item.count,
      date: item.date,
    }))
    .sort((a, b) => b.count - a.count || a.dimension.localeCompare(b.dimension, 'zh'))
    .slice(0, Math.max(0, limit));
}

/**
 * 柱状图纵轴刻度：0 起、约 4 段，步长取 1 / 2 / 5 × 10^n，
 * 这样 1060 会得到 0 / 500 / 1000 / 1500，而不是 0 / 265 / 530 …
 */
export function axisTicks(max: number, segments = 3): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const rawStep = max / Math.max(1, segments);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = Math.max(
    1,
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude,
  );
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 1000; value += step) {
    ticks.push(Math.round(value));
  }
  return ticks;
}

/** 分页：页码从 1 开始，越界 / 非法输入自动夹到合法范围 */ export function pageSlice<T>(
  items: readonly T[],
  page: number,
  size: number,
): { items: T[]; page: number; pages: number; total: number } {
  const total = items.length;
  const per = Math.max(1, Math.floor(size));
  const pages = Math.max(1, Math.ceil(total / per));
  const current = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  return {
    items: items.slice((current - 1) * per, current * per),
    page: current,
    pages,
    total,
  };
}

/** 待办在日历上占的连续区间（按可见日列表的下标，已裁到可见范围内） */
export interface TodoCalendarSpan {
  item: TodoItem;
  /** 起始列下标（闭区间） */
  start: number;
  /** 结束列下标（闭区间） */
  end: number;
  /** 第几条泳道（同一行里上下叠放，避免互相盖住） */
  lane: number;
}

/**
 * 把待办铺成跨天的横条：`startDate` → `dueDate` 之间每天都算覆盖，
 * 日历周 / 日视图用「一条横跨多列」的方式展示（飞书那种），而不是只落在截止日。
 *
 * 只在 `days` 范围内裁剪：跨出可视范围的待办会被切到首列 / 末列。
 * 泳道按开始时间贪心分配，能并排就不叠行。
 */
export function layoutTodoSpans(
  todos: readonly TodoItem[],
  days: readonly string[],
): { spans: TodoCalendarSpan[]; lanes: number } {
  if (days.length === 0) return { spans: [], lanes: 0 };
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const laneEnds: number[] = [];
  const spans: TodoCalendarSpan[] = [];
  const candidates = todos
    .filter((item) => item.status !== 'cancelled')
    .map((item) => {
      const startDate = item.startDate || item.dueDate;
      const dueDate = item.dueDate || item.startDate;
      if (!startDate || !dueDate) return null;
      const from = startDate <= dueDate ? startDate : dueDate;
      const to = startDate <= dueDate ? dueDate : startDate;
      if (to < first || from > last) return null;
      const start = Math.max(0, Math.min(days.length - 1, daysBetweenIso(first, from)));
      const end = Math.max(0, Math.min(days.length - 1, daysBetweenIso(first, to)));
      return { item, start, end };
    })
    .filter((x): x is { item: TodoItem; start: number; end: number } => Boolean(x))
    // 先排开始早的，同起点时长更长的优先，横条才不会互相挤断
    .sort((a, b) => a.start - b.start || b.end - a.end);

  for (const entry of candidates) {
    let lane = laneEnds.findIndex((end) => end < entry.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(entry.end);
    } else {
      laneEnds[lane] = entry.end;
    }
    spans.push({ ...entry, lane });
  }
  return { spans, lanes: laneEnds.length };
}

/** 某一天是否被待办覆盖（月视图逐格展示用） */
export function todoCoversDay(item: TodoItem, day: string): boolean {
  if (item.status === 'cancelled') return false;
  const startDate = item.startDate || item.dueDate;
  const dueDate = item.dueDate || item.startDate;
  if (!startDate || !dueDate) return false;
  const from = startDate <= dueDate ? startDate : dueDate;
  const to = startDate <= dueDate ? dueDate : startDate;
  return day >= from && day <= to;
}
