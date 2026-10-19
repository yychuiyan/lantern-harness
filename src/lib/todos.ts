/**
 * 待办事项（空间级）：页面与工作台 AI 工具共用同一份数据。
 * 存储：`<数据空间>/待办事项/待办.json`，由 lh-plugins/lh-todos.mjs 提供读写。
 * 待办周期 / 剩余天数 / 是否延期都是派生值，不落库。
 */

const API = '/__tb_todos';

/** 已延期：过了截止日期仍未结束，由系统自动写入（也可手动改回进行中） */
export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'overdue' | 'cancelled';

/** 紧急程度：重要紧急 / 重要不紧急 / 紧急不重要 / 普通（空串 = 未设置） */
export type TodoPriority = 'urgent_important' | 'important' | 'urgent' | 'normal' | '';

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  priority: TodoPriority;
  /** 关联任务号（自由文本；关联到任务管理时同步写入任务名称，便于搜索与 AI 读取） */
  linkedTask: string;
  /** 关联的任务管理 id（空串 = 未关联） */
  taskId: string;
  /** 开始日期 YYYY-MM-DD */
  startDate: string;
  /** 截止日期 YYYY-MM-DD */
  dueDate: string;
  /** 结束日期 YYYY-MM-DD（只读派生：已完成 / 已取消才有值） */
  taskEndDate: string;
  note: string;
  source: 'manual' | 'ai';
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

/** 新建 / 更新时允许提交的字段（结束日期不在此列：由状态派生，见 lh-todos.mjs） */
export interface TodoInput {
  title: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  linkedTask?: string;
  taskId?: string;
  startDate?: string;
  dueDate?: string;
  note?: string;
}

export type TodoPatch = Partial<Omit<TodoInput, 'title'>> & { title?: string };

export const TODO_STATUSES: readonly TodoStatus[] = [
  'pending',
  'in_progress',
  'done',
  'overdue',
  'cancelled',
];

export const TODO_PRIORITIES: readonly TodoPriority[] = [
  'urgent_important',
  'important',
  'urgent',
  'normal',
];

export const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
  pending: '待开始',
  in_progress: '进行中',
  done: '已完成',
  /** 过了截止日期仍未结束，由系统自动标记 */
  overdue: '已延期',
  cancelled: '已取消',
};

export const TODO_PRIORITY_LABEL: Record<TodoPriority, string> = {
  urgent_important: '重要紧急',
  important: '重要不紧急',
  urgent: '紧急不重要',
  normal: '普通',
  '': '—',
};

const STATUS_SET = new Set<string>(TODO_STATUSES);
const PRIORITY_SET = new Set<string>(TODO_PRIORITIES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function dateStr(value: unknown): string {
  const s = str(value, 10);
  return DATE_RE.test(s) ? s : '';
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

export function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === 'string' && PRIORITY_SET.has(value);
}

/** 结束态：只有这两个状态会写结束日期 */
export function isTodoClosed(status: TodoStatus): boolean {
  return status === 'done' || status === 'cancelled';
}

/** 服务端 / 工具入参 → 干净的一份待办字段（标题为空返回 null） */
export function normalizeTodoInput(raw: unknown): TodoInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 200);
  if (!title) return null;
  const out: TodoInput = { title };
  if (isTodoStatus(r.status)) out.status = r.status;
  if (isTodoPriority(r.priority)) out.priority = r.priority;
  if ('linkedTask' in r) out.linkedTask = str(r.linkedTask, 200);
  if ('taskId' in r) out.taskId = str(r.taskId, 64);
  if ('startDate' in r) out.startDate = dateStr(r.startDate);
  if ('dueDate' in r) out.dueDate = dateStr(r.dueDate);
  if ('note' in r) out.note = str(r.note);
  return out;
}

/** 宽松解析服务端返回（旧文件 / 手工改动都不至于让页面炸） */
export function normalizeTodoItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  const stored = isTodoStatus(r.status) ? r.status : 'pending';
  const dueDate = dateStr(r.dueDate);
  // 过了截止日期仍未结束：库里通常是 overdue，旧数据也在这里兜底成「已延期」
  const status = !isTodoClosed(stored) && dueDate && dueDate < todayIso() ? 'overdue' : stored;
  return {
    id: str(r.id, 64) || `td_${Math.random().toString(16).slice(2, 10)}`,
    title,
    status,
    priority: isTodoPriority(r.priority) ? r.priority : '',
    linkedTask: str(r.linkedTask, 200),
    taskId: str(r.taskId, 64),
    startDate: dateStr(r.startDate),
    dueDate,
    // 与服务端一致：结束日期只在结束态有意义，未结束不保留旧值
    taskEndDate: isTodoClosed(status) ? dateStr(r.taskEndDate) : '',
    note: str(r.note),
    source: r.source === 'ai' ? 'ai' : 'manual',
    sessionId: str(r.sessionId, 120),
    createdAt: str(r.createdAt, 40) || now,
    updatedAt: str(r.updatedAt, 40) || now,
    doneAt: str(r.doneAt, 40) || null,
  };
}

async function request(method: string, body?: unknown, suffix = ''): Promise<unknown> {
  const res = await fetch(`${API}${suffix}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export async function fetchTodosHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listTodos(): Promise<TodoItem[]> {
  const data = (await request('GET')) as { items?: unknown };
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map(normalizeTodoItem).filter((x): x is TodoItem => Boolean(x));
}

export async function createTodos(
  items: TodoInput[],
  meta?: { mode?: 'manual' | 'ai'; sessionId?: string },
): Promise<TodoItem[]> {
  const data = (await request('POST', { items, ...meta })) as { items?: unknown };
  const created = Array.isArray(data.items) ? data.items : [];
  return created.map(normalizeTodoItem).filter((x): x is TodoItem => Boolean(x));
}

export async function updateTodo(id: string, patch: TodoPatch): Promise<TodoItem> {
  const data = (await request('PUT', { id, ...patch })) as { item?: unknown };
  const item = normalizeTodoItem(data.item);
  if (!item) throw new Error('更新待办失败');
  return item;
}

export async function deleteTodos(ids: string[]): Promise<number> {
  const data = (await request('DELETE', { ids })) as { removed?: number };
  return Number(data.removed ?? 0);
}

/** 本地日期（不用 UTC，避免晚上 8 点后算成第二天） */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/** 两个日期相差的天数（b - a），任一非法返回 null */
export function daysBetween(a: string, b: string): number | null {
  if (!DATE_RE.test(a) || !DATE_RE.test(b)) return null;
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

/** 待办周期：开始 ~ 截止，含首尾；缺日期返回 null */
export function todoCycleDays(item: Pick<TodoItem, 'startDate' | 'dueDate'>): number | null {
  const diff = daysBetween(item.startDate, item.dueDate);
  return diff === null ? null : diff + 1;
}

/** 剩余天数：负数 = 逾期；缺截止日期返回 null */
export function todoRemainingDays(
  item: Pick<TodoItem, 'dueDate'>,
  today: string = todayIso(),
): number | null {
  return daysBetween(today, item.dueDate);
}

/**
 * 结束日期：由状态派生，不在表单里手填。
 * 已完成 / 已取消有值（完成当天），待开始 / 进行中 / 已延期为空。
 */
export function todoEndDate(item: Pick<TodoItem, 'status' | 'taskEndDate'>): string {
  return isTodoClosed(item.status) ? item.taskEndDate : '';
}

/** 展示用状态：未结束且已过截止日期 → overdue（与库里的自动标记保持一致） */
export function effectiveTodoStatus(
  item: Pick<TodoItem, 'status' | 'dueDate'>,
  today: string = todayIso(),
): TodoStatus {
  if (item.status === 'done' || item.status === 'cancelled' || item.status === 'overdue') {
    return item.status;
  }
  const remain = todoRemainingDays(item, today);
  if (remain !== null && remain < 0) return 'overdue';
  return item.status;
}

/** 表格默认顺序：已延期最前，其次进行中 / 待开始，再看截止日期（无期的排后），最后按优先级 */
export function sortTodos(items: TodoItem[]): TodoItem[] {
  const weight = (s: TodoStatus): number => {
    if (s === 'overdue') return 0;
    if (s === 'in_progress') return 1;
    if (s === 'pending') return 2;
    if (s === 'done') return 3;
    return 4;
  };
  const prioWeight = (p: TodoPriority): number => {
    if (p === 'urgent_important') return 0;
    if (p === 'important') return 1;
    if (p === 'urgent') return 2;
    if (p === 'normal') return 3;
    return 4;
  };
  return [...items].sort((a, b) => {
    const w = weight(a.status) - weight(b.status);
    if (w !== 0) return w;
    const ad = a.dueDate || '9999-12-31';
    const bd = b.dueDate || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const p = prioWeight(a.priority) - prioWeight(b.priority);
    if (p !== 0) return p;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

export interface TodoFilter {
  status?: TodoStatus | 'all';
  priority?: TodoPriority | 'all';
  keyword?: string;
  today?: string;
}

export function filterTodos(items: TodoItem[], filter: TodoFilter = {}): TodoItem[] {
  const status = filter.status ?? 'all';
  const priority = filter.priority ?? 'all';
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  const today = filter.today ?? todayIso();
  return items.filter((item) => {
    if (status !== 'all' && effectiveTodoStatus(item, today) !== status) return false;
    if (priority !== 'all' && item.priority !== priority) return false;
    if (keyword) {
      const hay = `${item.title} ${item.linkedTask} ${item.note}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

/** 统计（给页头与工具返回的 summary 用） */
export function todoCounts(items: TodoItem[], today: string = todayIso()) {
  const counts = {
    total: items.length,
    pending: 0,
    in_progress: 0,
    done: 0,
    cancelled: 0,
    overdue: 0,
  };
  for (const item of items) {
    const st = effectiveTodoStatus(item, today);
    if (st === 'overdue') counts.overdue += 1;
    else counts[st] += 1;
  }
  return counts;
}
