/**
 * 用例执行统计（空间级）：按项目记录每一轮用例执行情况。
 * 存储：`<数据空间>/用例执行统计/用例执行统计.json`，由 lh-plugins/lh-stats.mjs 提供读写。
 * 「当前剩余用例」「执行比例」是派生值，不落库。
 */

const API = '/__tb_case_exec';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COUNT = 9_999_999;

export interface CaseExecItem {
  id: string;
  /** 当前日期 YYYY-MM-DD */
  date: string;
  /** 项目名称（可从已有项目里选，也可直接输入新项目） */
  project: string;
  /** 开始日期 YYYY-MM-DD */
  startDate: string;
  /** 结束日期 YYYY-MM-DD */
  endDate: string;
  /** 用例总数 */
  total: number;
  /** 待执行用例 */
  pending: number;
  /** 已执行用例 */
  executed: number;
  /**
   * 刚点「+ 添加记录」生成、还没填项目名称的占位行。
   * 这类行也会落库（刷新后仍在），填好项目后自动变成正式记录。
   */
  draft: boolean;
  source: 'manual' | 'ai';
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaseExecInput {
  date?: string;
  project?: string;
  startDate?: string;
  endDate?: string;
  total?: number;
  pending?: number;
  executed?: number;
}

export type CaseExecPatch = Partial<CaseExecInput>;

export interface CaseExecList {
  items: CaseExecItem[];
  projects: string[];
}

function str(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function dateStr(value: unknown): string {
  const s = str(value, 10);
  return DATE_RE.test(s) ? s : '';
}

export function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_COUNT, Math.round(n));
}

/** 本地日期（不用 UTC，避免晚上 8 点后算成第二天） */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 宽松解析服务端返回（旧文件 / 手工改动都不至于让页面炸） */
export function normalizeCaseExecItem(raw: unknown): CaseExecItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const project = str(r.project);
  const draft = !project;
  // 缺项目名称的历史脏数据仍然丢弃；只有带 draft 标记的空占位行保留
  if (draft && r.draft !== true) return null;
  const now = new Date().toISOString();
  return {
    id: str(r.id, 64) || `ce_${Math.random().toString(16).slice(2, 10)}`,
    date: dateStr(r.date) || todayIso(),
    project,
    startDate: dateStr(r.startDate),
    endDate: dateStr(r.endDate),
    total: toCount(r.total),
    pending: toCount(r.pending),
    executed: toCount(r.executed),
    draft,
    source: r.source === 'ai' ? 'ai' : 'manual',
    sessionId: str(r.sessionId, 120),
    createdAt: str(r.createdAt, 40) || now,
    updatedAt: str(r.updatedAt, 40) || now,
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

export async function fetchCaseExecHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 兜底同步：没有记录时不落空文件，目录与 JSON 由第一次写记录创建。
 * 幂等：文件已存在就只读再写一遍，不会清空数据。
 */
export async function syncCaseExec(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/sync`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listCaseExec(): Promise<CaseExecList> {
  const data = (await request('GET')) as { items?: unknown; projects?: unknown };
  const items = Array.isArray(data.items) ? data.items : [];
  const projects = Array.isArray(data.projects)
    ? data.projects.map((x) => str(x)).filter(Boolean)
    : [];
  return {
    items: items.map(normalizeCaseExecItem).filter((x): x is CaseExecItem => Boolean(x)),
    projects,
  };
}

export async function createCaseExec(
  items: CaseExecInput[],
  meta?: { mode?: 'manual' | 'ai'; sessionId?: string },
): Promise<{ items: CaseExecItem[]; projects: string[] }> {
  const data = (await request('POST', { items, ...meta })) as {
    items?: unknown;
    projects?: unknown;
  };
  const created = Array.isArray(data.items) ? data.items : [];
  const projects = Array.isArray(data.projects)
    ? data.projects.map((x) => str(x)).filter(Boolean)
    : [];
  return {
    items: created.map(normalizeCaseExecItem).filter((x): x is CaseExecItem => Boolean(x)),
    projects,
  };
}

export async function updateCaseExec(
  id: string,
  patch: CaseExecPatch,
): Promise<{ item: CaseExecItem; projects: string[] }> {
  const data = (await request('PUT', { id, ...patch })) as {
    item?: unknown;
    projects?: unknown;
  };
  const item = normalizeCaseExecItem(data.item);
  if (!item) throw new Error('更新用例执行统计失败');
  const projects = Array.isArray(data.projects)
    ? data.projects.map((x) => str(x)).filter(Boolean)
    : [];
  return { item, projects };
}

export async function deleteCaseExec(ids: string[]): Promise<number> {
  const data = (await request('DELETE', { ids })) as { removed?: number };
  return Number(data.removed ?? 0);
}

/** 当前剩余用例 = 用例总数 − 已执行用例 */
export function caseExecRemaining(item: Pick<CaseExecItem, 'total' | 'executed'>): number {
  return Math.max(item.total - item.executed, 0);
}

/** 执行比例（0–100）：已执行 ÷ 用例总数；总数为 0 时按 0 处理 */
export function caseExecPercent(item: Pick<CaseExecItem, 'total' | 'executed'>): number {
  if (item.total <= 0) return 0;
  return Math.min(100, Math.max(0, (item.executed / item.total) * 100));
}

/** 执行比例展示：保留两位小数，与截图里的 26.67% 一致 */
export function formatCaseExecPercent(item: Pick<CaseExecItem, 'total' | 'executed'>): string {
  return `${caseExecPercent(item).toFixed(2)}%`;
}

/**
 * 表格默认顺序：日期从新到旧（递减），同一天按创建时间从新到旧。
 * 这样最新一天的数据总在最上面，翻到第 1 页就能看到最近记录。
 */
export function sortCaseExec(items: CaseExecItem[]): CaseExecItem[] {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

export interface CaseExecFilter {
  keyword?: string;
}

export function filterCaseExec(items: CaseExecItem[], filter: CaseExecFilter = {}): CaseExecItem[] {
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  if (!keyword) return items;
  return items.filter((item) =>
    `${item.date} ${item.project} ${item.startDate} ${item.endDate}`
      .toLowerCase()
      .includes(keyword),
  );
}

/** 页头统计：记录数、项目数、平均执行率 */
export function caseExecCounts(items: CaseExecItem[]) {
  const projects = new Set(items.map((x) => x.project).filter(Boolean));
  const total = items.reduce((sum, x) => sum + x.total, 0);
  const executed = items.reduce((sum, x) => sum + x.executed, 0);
  return {
    records: items.length,
    projects: projects.size,
    total,
    executed,
    percent: total > 0 ? Math.min(100, (executed / total) * 100) : 0,
  };
}
