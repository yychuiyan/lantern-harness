/**
 * 人生管理（空间级）：六张关联表，一个插件开关。
 * 存储：`<空间>/<实体目录>/<实体目录>.json`，由 lh-plugins/lh-life.mjs 读写。
 * 进度 / 待办数量 / 周期等为派生值，不落库。
 */

const API = '/__tb_life';

export type LifeEntity =
  | 'krTodos'
  | 'krTasks'
  | 'objectives'
  | 'reviews'
  | 'yearPlans'
  | 'lifeStages'
  | 'planTypes'
  | 'yearCycles'
  | 'lifeCycles';

export type KrTodoStatus = 'pending' | 'in_progress' | 'overdue' | 'done' | 'stalled' | 'closed';

export type KrTaskStatus = 'pool' | 'in_progress' | 'done' | 'incomplete' | 'closed';
export type YearPlanStatus = 'in_progress' | 'incomplete' | 'done';
export type LifePriority = 'urgent_important' | 'important' | 'urgent' | 'normal' | '';
/** 计划类型目录 id（旧枚举键读入时会映射） */
export type PlanType = string;
export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4' | '';

export interface PlanTypeItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** 年度周期目录项；年度计划 / Objective 的 yearCycle 存 id */
export interface YearCycleItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** 人生周期目录项；人生阶段的 lifeCycle 存 id（如「第一辈子(29-34)」） */
export interface LifeCycleItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface KrTodoItem {
  id: string;
  title: string;
  status: KrTodoStatus;
  krTaskId: string;
  startDate: string;
  dueDate: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface KrTaskItem {
  id: string;
  title: string;
  status: KrTaskStatus;
  priority: LifePriority;
  planType: PlanType;
  objectiveId: string;
  aiComment: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectiveItem {
  id: string;
  title: string;
  /** 年度周期目录 id */
  yearCycle: string;
  quarter: Quarter;
  /** 所属年度计划 id；选定后会同步进该计划的 objectiveIds */
  yearPlanId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewItem {
  id: string;
  title: string;
  objectiveId: string;
  score: number;
  experience: string;
  createdAt: string;
  updatedAt: string;
}

export interface YearPlanItem {
  id: string;
  title: string;
  /** 年度周期目录 id */
  yearCycle: string;
  planType: PlanType;
  status: YearPlanStatus;
  objectiveIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LifeStageItem {
  id: string;
  title: string;
  /** 人生周期目录 id */
  lifeCycle: string;
  planType: PlanType;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface LifeStore {
  krTodos: KrTodoItem[];
  krTasks: KrTaskItem[];
  objectives: ObjectiveItem[];
  reviews: ReviewItem[];
  yearPlans: YearPlanItem[];
  lifeStages: LifeStageItem[];
  planTypes: PlanTypeItem[];
  yearCycles: YearCycleItem[];
  lifeCycles: LifeCycleItem[];
}

export const LIFE_ENTITIES: readonly LifeEntity[] = [
  'krTodos',
  'krTasks',
  'objectives',
  'reviews',
  'yearPlans',
  'lifeStages',
  'planTypes',
  'yearCycles',
  'lifeCycles',
];

export const KR_TODO_STATUSES: readonly KrTodoStatus[] = [
  'pending',
  'in_progress',
  'overdue',
  'stalled',
  'done',
  'closed',
];

export const KR_TASK_STATUSES: readonly KrTaskStatus[] = [
  'pool',
  'in_progress',
  'incomplete',
  'done',
  'closed',
];

export const YEAR_PLAN_STATUSES: readonly YearPlanStatus[] = ['in_progress', 'incomplete', 'done'];

export const LIFE_PRIORITIES: readonly LifePriority[] = [
  'urgent_important',
  'urgent',
  'important',
  'normal',
];

/** @deprecated 旧固定枚举；新数据以 planTypes 目录为准 */
export const PLAN_TYPES: readonly string[] = ['learning', 'work', 'family', 'side'];

/** 旧枚举键 → 种子 id */
export const LEGACY_PLAN_TYPE_IDS: Record<string, string> = {
  learning: 'pt_learning',
  work: 'pt_work',
  family: 'pt_family',
  side: 'pt_side',
};

export const QUARTERS: readonly Quarter[] = ['Q1', 'Q2', 'Q3', 'Q4'];

export const KR_TODO_STATUS_LABEL: Record<KrTodoStatus, string> = {
  pending: '待开始',
  in_progress: '进行中',
  overdue: '已延期',
  done: '已完成',
  stalled: '已停滞',
  closed: '已关闭',
};

export const KR_TASK_STATUS_LABEL: Record<KrTaskStatus, string> = {
  pool: '任务池',
  in_progress: '进行中',
  done: '已完成',
  incomplete: '未完成',
  closed: '已关闭',
};

export const YEAR_PLAN_STATUS_LABEL: Record<YearPlanStatus, string> = {
  in_progress: '进行中',
  incomplete: '未完成',
  done: '已完成',
};

export const LIFE_PRIORITY_LABEL: Record<LifePriority, string> = {
  urgent_important: '重要紧急',
  urgent: '紧急不重要',
  important: '重要不紧急',
  normal: '不重要不紧急',
  '': '—',
};

/** @deprecated 仅兼容旧枚举展示；优先用 planTypeLabel(planTypes, id) */
export const PLAN_TYPE_LABEL: Record<string, string> = {
  learning: '学习成长',
  work: '工作管理',
  family: '家庭生活',
  side: '副业赚钱',
  pt_learning: '学习成长',
  pt_work: '工作管理',
  pt_family: '家庭生活',
  pt_side: '副业赚钱',
  '': '—',
};

const PLAN_TYPE_PILL_PALETTE = [
  'bg-[#3370ff] text-white',
  'bg-[#34c724] text-white',
  'bg-[#ff8800] text-white',
  'bg-[#7c3aed] text-white',
  'bg-[#0ea5e9] text-white',
  'bg-[#e11d48] text-white',
] as const;

export function sortPlanTypes(types: readonly PlanTypeItem[]): PlanTypeItem[] {
  return [...types].sort((a, b) => {
    const tu = (b.updatedAt || '').localeCompare(a.updatedAt || '');
    if (tu !== 0) return tu;
    return a.name.localeCompare(b.name, 'zh');
  });
}

export function sortYearCycles(types: readonly YearCycleItem[]): YearCycleItem[] {
  return [...types].sort((a, b) => {
    const tu = (b.updatedAt || '').localeCompare(a.updatedAt || '');
    if (tu !== 0) return tu;
    return a.name.localeCompare(b.name, 'zh');
  });
}

export function sortLifeCycles(types: readonly LifeCycleItem[]): LifeCycleItem[] {
  return [...types].sort((a, b) => {
    const tu = (b.updatedAt || '').localeCompare(a.updatedAt || '');
    if (tu !== 0) return tu;
    return a.name.localeCompare(b.name, 'zh');
  });
}

export function defaultPlanTypeId(types: readonly PlanTypeItem[]): string {
  return sortPlanTypes(types)[0]?.id ?? '';
}

export function planTypeLabel(types: readonly PlanTypeItem[], id: string): string {
  if (!id) return '';
  const hit = types.find((t) => t.id === id);
  if (hit) return hit.name;
  return PLAN_TYPE_LABEL[id] || id;
}

export function yearCycleLabel(types: readonly YearCycleItem[], id: string): string {
  if (!id) return '';
  const hit = types.find((t) => t.id === id);
  if (hit) return hit.name;
  return id;
}

export function lifeCycleLabel(types: readonly LifeCycleItem[], id: string): string {
  if (!id) return '';
  const hit = types.find((t) => t.id === id);
  if (hit) return hit.name;
  return id;
}

export function resolveYearCycleId(raw: unknown, types: readonly YearCycleItem[]): string {
  const s = str(raw, 40);
  if (!s) return '';
  if (types.some((t) => t.id === s)) return s;
  const byName = types.find((t) => t.name === s);
  return byName?.id ?? '';
}

export function resolveLifeCycleId(raw: unknown, types: readonly LifeCycleItem[]): string {
  const s = str(raw, 60);
  if (!s) return '';
  if (types.some((t) => t.id === s)) return s;
  const byName = types.find((t) => t.name === s);
  return byName?.id ?? '';
}

export function planTypePillClass(id: string): string {
  if (!id) return 'bg-stone-300 text-stone-600';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PLAN_TYPE_PILL_PALETTE[h % PLAN_TYPE_PILL_PALETTE.length];
}

export function resolvePlanTypeId(raw: unknown, planTypeIds: ReadonlySet<string>): string {
  const s = str(raw, 64);
  if (!s) return '';
  if (planTypeIds.has(s)) return s;
  const mapped = LEGACY_PLAN_TYPE_IDS[s];
  if (mapped && planTypeIds.has(mapped)) return mapped;
  return '';
}

/** OKR 复盘「经验收获」新建默认三段提纲 */
export const REVIEW_EXPERIENCE_TEMPLATE =
  '1) 有什么是做得好的\n2) 有什么是做得不够好的\n3) 总结如何下次做得更好';

export const QUARTER_LABEL: Record<Quarter, string> = {
  Q1: 'Q1(1月-3月)',
  Q2: 'Q2(4月-6月)',
  Q3: 'Q3(7月-9月)',
  Q4: 'Q4(10月-12月)',
  '': '—',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 起止日期间隔天数（含首尾，与待办事项「待办周期」一致） */
export function cycleDays(startDate: string, dueDate: string): number | null {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(dueDate)) return null;
  const a = Date.parse(`${startDate}T00:00:00`);
  const b = Date.parse(`${dueDate}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

export function formatCycleDays(days: number | null): string {
  if (days == null) return '—';
  return `${days} 天`;
}

export function emptyLifeStore(): LifeStore {
  return {
    krTodos: [],
    krTasks: [],
    objectives: [],
    reviews: [],
    yearPlans: [],
    lifeStages: [],
    planTypes: [],
    yearCycles: [],
    lifeCycles: [],
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizePlanTypeItem(raw: unknown): PlanTypeItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name, 40);
  const id = str(o.id, 64);
  if (!name || !id) return null;
  return {
    id,
    name,
    createdAt: str(o.createdAt, 40),
    updatedAt: str(o.updatedAt, 40),
  };
}

function normalizeYearCycleItem(raw: unknown): YearCycleItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name, 40);
  const id = str(o.id, 64);
  if (!name || !id) return null;
  return {
    id,
    name,
    createdAt: str(o.createdAt, 40),
    updatedAt: str(o.updatedAt, 40),
  };
}

function normalizeLifeCycleItem(raw: unknown): LifeCycleItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name, 60);
  const id = str(o.id, 64);
  if (!name || !id) return null;
  return {
    id,
    name,
    createdAt: str(o.createdAt, 40),
    updatedAt: str(o.updatedAt, 40),
  };
}

export function normalizeLifeStore(raw: unknown): LifeStore {
  if (!raw || typeof raw !== 'object') return emptyLifeStore();
  const o = raw as Record<string, unknown>;
  const planTypes = asArray<unknown>(o.planTypes)
    .map(normalizePlanTypeItem)
    .filter((x): x is PlanTypeItem => Boolean(x));
  const planTypeIds = new Set(planTypes.map((x) => x.id));
  const yearCycles = asArray<unknown>(o.yearCycles)
    .map(normalizeYearCycleItem)
    .filter((x): x is YearCycleItem => Boolean(x));
  const lifeCycles = asArray<unknown>(o.lifeCycles)
    .map(normalizeLifeCycleItem)
    .filter((x): x is LifeCycleItem => Boolean(x));

  const mapPlanType = <T extends { planType?: unknown }>(item: T): T => ({
    ...item,
    planType: resolvePlanTypeId(item.planType, planTypeIds),
  });

  const mapYearCycle = <T extends { yearCycle?: unknown }>(item: T): T => ({
    ...item,
    yearCycle: resolveYearCycleId(item.yearCycle, yearCycles),
  });

  const mapLifeCycle = <T extends { lifeCycle?: unknown; ageRange?: unknown }>(item: T): T => {
    const raw = item.lifeCycle || item.ageRange;
    const { ageRange: _drop, ...rest } = item as T & { ageRange?: unknown };
    return {
      ...rest,
      lifeCycle: resolveLifeCycleId(raw, lifeCycles),
    } as T;
  };

  const yearPlans = asArray<YearPlanItem>(o.yearPlans).map(mapPlanType).map(mapYearCycle);
  const yearPlanIds = new Set(yearPlans.map((p) => p.id));
  const objectives = asArray<ObjectiveItem>(o.objectives)
    .map(mapYearCycle)
    .map((item) => {
      const yearPlanId = str(item.yearPlanId, 64);
      return {
        ...item,
        yearPlanId: yearPlanId && yearPlanIds.has(yearPlanId) ? yearPlanId : '',
      };
    });

  return {
    krTodos: asArray(o.krTodos),
    krTasks: asArray<KrTaskItem>(o.krTasks).map(mapPlanType),
    objectives,
    reviews: asArray(o.reviews),
    yearPlans,
    lifeStages: asArray<LifeStageItem>(o.lifeStages).map(mapPlanType).map(mapLifeCycle),
    planTypes,
    yearCycles,
    lifeCycles,
  };
}

export async function fetchLifeStore(): Promise<LifeStore> {
  const res = await fetch(API, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(str(data?.error) || `读取失败（${res.status}）`);
  return normalizeLifeStore(data);
}

export async function fetchLifeHealth(): Promise<{ ok: boolean; files?: Record<string, string> }> {
  const res = await fetch(`${API}?health=1`, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  return { ok: Boolean(data?.ok), files: data?.files };
}

export async function createLifeItems(
  entity: LifeEntity,
  items: Record<string, unknown>[],
): Promise<{ items: unknown[]; total: number }> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ entity, items }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(str(data?.error) || `创建失败（${res.status}）`);
  return { items: asArray(data.items), total: Number(data.total) || 0 };
}

export async function updateLifeItem(
  entity: LifeEntity,
  id: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ entity, id, ...patch }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(str(data?.error) || `更新失败（${res.status}）`);
  return data.item;
}

export async function deleteLifeItems(
  entity: LifeEntity,
  ids: string[],
): Promise<{ removed: number; total: number }> {
  const res = await fetch(API, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ entity, ids }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(str(data?.error) || `删除失败（${res.status}）`);
  return { removed: Number(data.removed) || 0, total: Number(data.total) || 0 };
}

/** 某 KR 任务下的待办统计与进度 */
export function krTaskTodoStats(
  taskId: string,
  todos: KrTodoItem[],
): { count: number; done: number; progress: number; titles: string[]; summary: string } {
  const list = todos.filter((t) => t.krTaskId === taskId);
  const done = list.filter((t) => t.status === 'done').length;
  const count = list.length;
  const progress = count === 0 ? 0 : Math.round((done / count) * 100);
  const titles = list.map((t) => t.title);
  const byStatus = new Map<string, number>();
  for (const t of list) {
    byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  }
  const summary =
    count === 0
      ? '暂无待办'
      : [...byStatus.entries()]
          .map(([s, n]) => `${KR_TODO_STATUS_LABEL[s as KrTodoStatus] ?? s} ${n}`)
          .join(' · ');
  return { count, done, progress, titles, summary };
}

/**
 * 年度计划可选的 Objective：与计划同一年度周期，或已挂到该计划的目标。
 * 无年度周期且无已选时返回空。
 */
export function objectivesForYearPlan(
  yearCycle: string,
  objectives: readonly ObjectiveItem[],
  opts?: { yearPlanId?: string; selectedIds?: readonly string[] },
): ObjectiveItem[] {
  const cycle = str(yearCycle, 64);
  const planId = str(opts?.yearPlanId, 64);
  const selected = new Set((opts?.selectedIds ?? []).map((x) => str(x, 64)).filter(Boolean));
  return objectives.filter((o) => {
    if (cycle && o.yearCycle === cycle) return true;
    if (planId && o.yearPlanId === planId) return true;
    if (selected.has(o.id)) return true;
    return false;
  });
}

/** Objective 完成度：关联 KR 任务进度均值 */
export function objectiveProgress(
  objectiveId: string,
  tasks: KrTaskItem[],
  todos: KrTodoItem[],
): number {
  const linked = tasks.filter((t) => t.objectiveId === objectiveId);
  if (!linked.length) return 0;
  const sum = linked.reduce((acc, t) => acc + krTaskTodoStats(t.id, todos).progress, 0);
  return Math.round(sum / linked.length);
}

export function objectiveKeyResults(objectiveId: string, tasks: KrTaskItem[]): string[] {
  return tasks.filter((t) => t.objectiveId === objectiveId).map((t) => t.title);
}

/**
 * @deprecated 改用 store.yearCycles 目录；保留给旧测试：从年度计划收集 yearCycle id。
 */
export function yearCyclesFromPlans(plans: YearPlanItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of plans) {
    const y = str(p.yearCycle, 40);
    if (!y || seen.has(y)) continue;
    seen.add(y);
    out.push(y);
  }
  return out;
}

export function filterByKeyword<T extends { title: string; note?: string }>(
  items: T[],
  keyword: string,
): T[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (x) => x.title.toLowerCase().includes(q) || (x.note ?? '').toLowerCase().includes(q),
  );
}
