/**
 * 任务管理（空间级，独立插件）：任务列表页与待办的「所属任务」共用同一份数据。
 * 存储：`<数据空间>/.lantern/local/tasks.json`，由 lh-plugins/lh-tasks.mjs 提供读写。
 * 任务周期 / 待办数量 / 完成进度都是派生值，不落库。
 */

const API = '/__tb_tasks';

export type TaskStatus = 'pool' | 'in_progress' | 'done' | 'closed';
export type TaskPriority = 'urgent_important' | 'important' | 'urgent' | 'normal' | '';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** 开始日期 YYYY-MM-DD */
  startDate: string;
  /** 截止日期 YYYY-MM-DD */
  dueDate: string;
  note: string;
  source: 'manual' | 'ai';
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

export interface TaskInput {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  startDate?: string;
  dueDate?: string;
  note?: string;
}

export type TaskPatch = Partial<Omit<TaskInput, 'title'>> & { title?: string };

export const TASK_STATUSES: readonly TaskStatus[] = ['pool', 'in_progress', 'done', 'closed'];

export const TASK_PRIORITIES: readonly TaskPriority[] = [
  'urgent_important',
  'important',
  'urgent',
  'normal',
];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pool: '任务池',
  in_progress: '进行中',
  done: '已完成',
  closed: '已关闭',
};

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent_important: '重要紧急',
  important: '重要不紧急',
  urgent: '紧急不重要',
  normal: '普通',
  '': '—',
};

const STATUS_SET = new Set<string>(TASK_STATUSES);
const PRIORITY_SET = new Set<string>(TASK_PRIORITIES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function dateStr(value: unknown): string {
  const s = str(value, 10);
  return DATE_RE.test(s) ? s : '';
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && PRIORITY_SET.has(value);
}

/** 工具 / 表单入参 → 干净的一份任务字段（标题为空返回 null） */
export function normalizeTaskInput(raw: unknown): TaskInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 200);
  if (!title) return null;
  const out: TaskInput = { title };
  if (isTaskStatus(r.status)) out.status = r.status;
  if (isTaskPriority(r.priority)) out.priority = r.priority;
  if ('startDate' in r) out.startDate = dateStr(r.startDate);
  if ('dueDate' in r) out.dueDate = dateStr(r.dueDate);
  if ('note' in r) out.note = str(r.note);
  return out;
}

export function normalizeTaskItem(raw: unknown): TaskItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  return {
    id: str(r.id, 64) || `tk_${Math.random().toString(16).slice(2, 10)}`,
    title,
    status: isTaskStatus(r.status) ? r.status : 'pool',
    priority: isTaskPriority(r.priority) ? r.priority : '',
    startDate: dateStr(r.startDate),
    dueDate: dateStr(r.dueDate),
    note: str(r.note),
    source: r.source === 'ai' ? 'ai' : 'manual',
    sessionId: str(r.sessionId, 120),
    createdAt: str(r.createdAt, 40) || now,
    updatedAt: str(r.updatedAt, 40) || now,
    doneAt: str(r.doneAt, 40) || null,
  };
}

async function request(method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(API, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export async function fetchTasksHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listTasks(): Promise<TaskItem[]> {
  const data = (await request('GET')) as { items?: unknown };
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map(normalizeTaskItem).filter((x): x is TaskItem => Boolean(x));
}

export async function createTasks(
  items: TaskInput[],
  meta?: { mode?: 'manual' | 'ai'; sessionId?: string },
): Promise<TaskItem[]> {
  const data = (await request('POST', { items, ...meta })) as { items?: unknown };
  const created = Array.isArray(data.items) ? data.items : [];
  return created.map(normalizeTaskItem).filter((x): x is TaskItem => Boolean(x));
}

export async function updateTask(id: string, patch: TaskPatch): Promise<TaskItem> {
  const data = (await request('PUT', { id, ...patch })) as { item?: unknown };
  const item = normalizeTaskItem(data.item);
  if (!item) throw new Error('更新任务失败');
  return item;
}

export async function deleteTasks(ids: string[]): Promise<number> {
  const data = (await request('DELETE', { ids })) as { removed?: number };
  return Number(data.removed ?? 0);
}

function toUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/** 任务周期：开始 ~ 截止，含首尾；缺日期返回 null */
export function taskCycleDays(item: Pick<TaskItem, 'startDate' | 'dueDate'>): number | null {
  if (!DATE_RE.test(item.startDate) || !DATE_RE.test(item.dueDate)) return null;
  return Math.round((toUtcMs(item.dueDate) - toUtcMs(item.startDate)) / 86_400_000) + 1;
}

export interface TaskTodoStat {
  total: number;
  done: number;
  /** 0~100，无待办时为 0 */
  percent: number;
}

/** 按 taskId 汇总待办数量与完成进度 */
export function taskTodoStats(
  todos: ReadonlyArray<{ taskId?: string; status: string }>,
): Record<string, TaskTodoStat> {
  const map: Record<string, TaskTodoStat> = {};
  for (const todo of todos) {
    const id = todo.taskId?.trim();
    if (!id) continue;
    const stat = (map[id] ??= { total: 0, done: 0, percent: 0 });
    stat.total += 1;
    if (todo.status === 'done') stat.done += 1;
  }
  for (const stat of Object.values(map)) {
    stat.percent = stat.total ? Math.round((stat.done / stat.total) * 100) : 0;
  }
  return map;
}

export interface TaskFilter {
  status?: TaskStatus | 'all' | 'urgent';
  priority?: TaskPriority | 'all';
  keyword?: string;
}

export function filterTasks(items: TaskItem[], filter: TaskFilter = {}): TaskItem[] {
  const status = filter.status ?? 'all';
  const priority = filter.priority ?? 'all';
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  return items.filter((item) => {
    if (status === 'urgent') {
      if (item.priority !== 'urgent_important' && item.priority !== 'urgent') return false;
    } else if (status !== 'all' && item.status !== status) {
      return false;
    }
    if (priority !== 'all' && item.priority !== priority) return false;
    if (keyword) {
      const hay = `${item.title} ${item.note}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

export function sortTasks(items: TaskItem[]): TaskItem[] {
  const weight = (s: TaskStatus): number => {
    if (s === 'in_progress') return 0;
    if (s === 'pool') return 1;
    if (s === 'done') return 2;
    return 3;
  };
  const prioWeight = (p: TaskPriority): number => {
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

export function taskCounts(items: TaskItem[]) {
  const counts = { total: items.length, pool: 0, in_progress: 0, done: 0, closed: 0, urgent: 0 };
  for (const item of items) {
    counts[item.status] += 1;
    if (item.priority === 'urgent_important' || item.priority === 'urgent') counts.urgent += 1;
  }
  return counts;
}
