/**
 * 用例执行统计（空间级）：按项目记录每一轮用例执行情况。
 * 存储：`<数据空间>/用例执行统计/用例执行统计.json`，由 lh-plugins/lh-stats.mjs 提供读写。
 * 项目名称选项按「新增时间」排列，可在下拉里重命名（同步改记录）或删除（仅限没被引用）。
 * 「已执行用例」由「用例总数 − 待执行用例」自动算出（展示与统计都按这条口径，
 * 只有总数与待执行的历史记录也一样）；「当前剩余用例」「执行比例」是派生值，不落库。
 */

const API = '/__tb_case_exec';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COUNT = 9_999_999;

export interface CaseExecItem {
  id: string;
  /** 统计日期 YYYY-MM-DD（同一项目可有多条，一天一条） */
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

async function request(method: string, body?: unknown, path = ''): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

/** 服务端返回的 items / projects 归一（列表、新建、改名、删除都用同一套） */
function parseList(data: { items?: unknown; projects?: unknown }): CaseExecList {
  const items = Array.isArray(data.items) ? data.items : [];
  const projects = Array.isArray(data.projects)
    ? data.projects.map((x) => str(x)).filter(Boolean)
    : [];
  return {
    items: items.map(normalizeCaseExecItem).filter((x): x is CaseExecItem => Boolean(x)),
    projects,
  };
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
  return parseList((await request('GET')) as { items?: unknown; projects?: unknown });
}

export async function createCaseExec(
  items: CaseExecInput[],
  meta?: { mode?: 'manual' | 'ai'; sessionId?: string },
): Promise<{ items: CaseExecItem[]; projects: string[] }> {
  return parseList((await request('POST', { items, ...meta })) as { items?: unknown });
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

/**
 * 重命名项目名称：服务端原位替换（保持新增顺序），同名时合并；
 * 引用该项目的记录会一起改名，返回改动的记录数与刷新后的数据。
 */
export async function renameCaseExecProject(
  from: string,
  to: string,
): Promise<CaseExecList & { replaced: number }> {
  const data = (await request('PUT', { from, to }, '/options')) as {
    items?: unknown;
    projects?: unknown;
    replaced?: number;
  };
  return { ...parseList(data), replaced: Number(data.replaced ?? 0) };
}

/** 删除未被任何记录引用的项目名称（还有记录在用会被服务端拒绝） */
export async function deleteCaseExecProject(name: string): Promise<CaseExecList> {
  return parseList((await request('DELETE', { name }, '/options')) as { items?: unknown });
}

/** 某个项目名称被多少条记录引用（删除前先拦一道，省一次往返） */
export function countCaseExecByProject(
  items: Pick<CaseExecItem, 'project'>[],
  project: string,
): number {
  const name = project.trim();
  if (!name) return 0;
  return items.filter((x) => x.project === name).length;
}

/** 已执行用例 = 用例总数 − 待执行用例（填完总数与待执行后自动算，不会小于 0） */
export function caseExecExecuted(total: number, pending: number): number {
  return Math.max(toCount(total) - toCount(pending), 0);
}

/** 参与派生计算的最小字段集（历史记录可能没写过 executed） */
export interface CaseExecNumbers {
  total: number;
  pending: number;
  executed?: number;
}

/**
 * 展示 / 统计用的已执行用例：一律按「用例总数 − 待执行用例」算，
 * 所以只有总数与待执行的历史记录（executed 还是 0）也会自动补上正确的已执行数。
 * 待执行与已执行都还是 0（刚填完总数、还没开始填）时按 0 处理，
 * 不凭总数推断成「全部执行完」；用例总数为 0 时回落到落库值。
 */
export function caseExecResolveExecuted(item: CaseExecNumbers): number {
  const total = toCount(item.total);
  const pending = toCount(item.pending);
  const stored = toCount(item.executed ?? 0);
  if (total <= 0) return stored;
  if (pending <= 0 && stored <= 0) return 0;
  return Math.min(total, Math.max(total - pending, 0));
}

/** 当前剩余用例 = 用例总数 − 已执行用例（与待执行用例同值，自动算） */
export function caseExecRemaining(item: CaseExecNumbers): number {
  return Math.max(toCount(item.total) - caseExecResolveExecuted(item), 0);
}

/**
 * 项目基线：该项目**最早一条记录**（日期升序，同一天按创建时间升序）的用例总数。
 * 同一项目每天新增一行，新行的用例总数就是上一轮的剩余量，所以只有最早那条才是
 * 这个项目的原始规模；执行比例按它当分母才是「项目累计做完多少」。
 * 用例总数为 0 的记录当不了分母，直接跳过（取第一条填了总数的记录）。
 */
export function caseExecBaselines(
  items: Pick<CaseExecItem, 'project' | 'date' | 'createdAt' | 'total'>[],
): Map<string, number> {
  const first = new Map<string, { date: string; createdAt: string; total: number }>();
  for (const item of items) {
    const project = item.project.trim();
    const total = toCount(item.total);
    if (!project || total <= 0) continue;
    const prev = first.get(project);
    const earlier =
      !prev ||
      item.date < prev.date ||
      (item.date === prev.date && item.createdAt < prev.createdAt);
    if (earlier) first.set(project, { date: item.date, createdAt: item.createdAt, total });
  }
  const out = new Map<string, number>();
  for (const [project, value] of first) out.set(project, value.total);
  return out;
}

/**
 * 该行视角下的**累计已执行用例** = 项目基线 − 该行当前剩余（不超过基线）。
 *
 * 用来和百分比配对显示：同一项目每天新增一行，行的「用例总数」只是当天剩余量，
 * 拿它当分子会算出「99 / 196」却配着 74.49% 这种前后不一致的读数；
 * 这里统一按基线口径折算，百分比 = 该值 ÷ 基线，两者永远对得上。
 * 没有基线（没填项目名 / 总数为 0）时回落到这一行自己的已执行。
 */
export function caseExecCumulativeExecuted(
  item: CaseExecNumbers,
  projectBaseline?: number,
): number {
  const base = toCount(projectBaseline ?? item.total);
  if (base <= 0) return caseExecResolveExecuted(item);
  return Math.min(base, Math.max(base - caseExecRemaining(item), 0));
}

/**
 * 执行比例（0–100）：累计已执行用例 ÷ 项目基线总数。
 * 基线取该项目最早一条记录的用例总数（`caseExecBaselines`）；不传时回落到这一行
 * 自己的用例总数（单条记录 / 单行口径）。基线为 0 时按 0 处理。
 */
export function caseExecPercent(item: CaseExecNumbers, projectBaseline?: number): number {
  const base = toCount(projectBaseline ?? item.total);
  if (base <= 0) return 0;
  return (caseExecCumulativeExecuted(item, base) / base) * 100;
}

/** 执行比例展示：保留两位小数 */
export function formatCaseExecPercent(item: CaseExecNumbers, projectBaseline?: number): string {
  return `${caseExecPercent(item, projectBaseline).toFixed(2)}%`;
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

/**
 * 表格的一级分组：一个项目（含开始 / 结束日期）当父行，按统计日期展开成子行。
 *
 * - 未命名占位行（刚点「+ 添加项目」生成、还没选项目）各自成组，key 用 `draft:<id>`；
 * - 子行沿用 `sortCaseExec`（统计日期倒序，同日按创建时间倒序）；
 * - 周期取该组**最新一条**写了开始 / 结束日期的记录（父行改周期会写穿整组，见
 *   `updateCaseExecCycle`），「基线 / 累计已执行 / 执行率」与页头整体口径一致；
 * - 关键词：项目名称命中就保留整组，只有子行命中时只保留命中的子行
 *   （基线仍按整组算，不会因为搜索把分母改小）。
 */
export interface CaseExecGroup {
  /** 分组键：已命名用项目名称，未命名占位用 `draft:<记录 id>` */
  key: string;
  /** 项目名称（空串 = 还没填的占位组） */
  project: string;
  /** 该组要显示的子行（统计日期倒序；筛选时可能只保留命中的几条） */
  items: CaseExecItem[];
  /** 组内最新一条的统计日期（组排序用） */
  latestDate: string;
  /** 组周期：最新一条非空记录的起止日期 */
  startDate: string;
  endDate: string;
  /** 基线：该项目第一条记录的用例总数 */
  baseline: number;
  /** 累计已执行 = max(基线 − 最新一条的当前剩余, 0) */
  executed: number;
  /** 累计执行率（0–100） */
  percent: number;
  draft: boolean;
}

export function groupCaseExec(items: CaseExecItem[], filter: CaseExecFilter = {}): CaseExecGroup[] {
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  const buckets = new Map<string, CaseExecItem[]>();
  for (const item of items) {
    const project = item.project.trim();
    const key = project || `draft:${item.id}`;
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }

  const out: CaseExecGroup[] = [];
  for (const [key, bucket] of buckets) {
    const all = sortCaseExec(bucket);
    const project = all[0]?.project.trim() ?? '';
    let visible = all;
    if (keyword && !`${project}`.toLowerCase().includes(keyword)) {
      visible = all.filter((x) =>
        `${x.date} ${x.startDate} ${x.endDate} ${x.total} ${x.pending}`
          .toLowerCase()
          .includes(keyword),
      );
      if (!visible.length) continue;
    }

    // 周期取最新一条写了日期的记录：父行改过周期后整组一致，老数据混合值也收敛
    const cycle = all.find((x) => x.startDate || x.endDate) ?? all[0];
    const baseline = project ? (caseExecBaselines(all).get(project) ?? 0) : 0;
    // 进度只看填了用例总数的记录：刚加的「添加统计」空行不该把执行率抬到 100%
    const progressItem = all.find((x) => toCount(x.total) > 0) ?? all[0];
    const latestRemaining = progressItem ? caseExecRemaining(progressItem) : baseline;
    const executed = baseline > 0 ? Math.min(baseline, Math.max(baseline - latestRemaining, 0)) : 0;

    out.push({
      key,
      project,
      items: visible,
      latestDate: all[0]?.date ?? '',
      startDate: cycle?.startDate ?? '',
      endDate: cycle?.endDate ?? '',
      baseline,
      executed,
      percent: baseline > 0 ? (executed / baseline) * 100 : 0,
      draft: !project,
    });
  }

  // 组按「最新统计日期」倒序，同一天按最新记录的创建时间倒序
  return out.sort((a, b) => {
    if (a.latestDate !== b.latestDate) return a.latestDate < b.latestDate ? 1 : -1;
    const at = a.items[0]?.createdAt ?? '';
    const bt = b.items[0]?.createdAt ?? '';
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
}

/**
 * 改整组的起止日期：一个项目只有一个周期，父行改一次就把该项目的所有记录一起改，
 * 避免逐条 PUT 互相覆盖。
 */
export async function updateCaseExecCycle(
  name: string,
  patch: { startDate?: string; endDate?: string },
): Promise<CaseExecList & { updated: number }> {
  const data = (await request('PUT', { name, ...patch }, '/project-cycle')) as {
    items?: unknown;
    projects?: unknown;
    updated?: number;
  };
  return { ...parseList(data), updated: Number(data.updated ?? 0) };
}

/**
 * 每个项目的累计进度：已执行 = 基线 − 该项目**最新一条记录**的当前剩余。
 * 同一项目每天新增一行时，最新一行的剩余就是这个项目此刻还没做的量；
 * 这样即使某轮把「用例总数」重填成更大的值（超出基线），也不会把整体率算过 100%。
 */
export interface CaseExecProjectProgress {
  project: string;
  /** 基线：该项目第一条记录的用例总数 */
  baseline: number;
  /** 该项目最新一条记录的当前剩余 */
  remaining: number;
  /** 累计已执行 = max(基线 − 最新剩余, 0) */
  executed: number;
}

export function caseExecProjectProgress(
  items: Pick<CaseExecItem, 'project' | 'date' | 'createdAt' | 'total' | 'pending' | 'executed'>[],
): Map<string, CaseExecProjectProgress> {
  const baselines = caseExecBaselines(items);
  const out = new Map<string, CaseExecProjectProgress>();
  if (baselines.size === 0) return out;
  /** 每个项目最新一条（日期最大，同日取创建时间更晚的） */
  const latest = new Map<string, { date: string; createdAt: string; remaining: number }>();
  for (const item of items) {
    const project = item.project.trim();
    if (!baselines.has(project)) continue;
    // 刚加的「添加统计」行还没填总数：它不算进度数据点，否则会被当成「剩余 0 = 全做完」
    if (toCount(item.total) <= 0) continue;
    const prev = latest.get(project);
    const newer =
      !prev ||
      item.date > prev.date ||
      (item.date === prev.date && item.createdAt >= prev.createdAt);
    if (newer) {
      latest.set(project, {
        date: item.date,
        createdAt: item.createdAt,
        remaining: caseExecRemaining(item),
      });
    }
  }
  for (const [project, value] of baselines) {
    const remaining = latest.get(project)?.remaining ?? value;
    out.set(project, {
      project,
      baseline: value,
      remaining,
      executed: Math.max(value - remaining, 0),
    });
  }
  return out;
}

/**
 * 页头统计：记录数、项目数、整体执行率。
 * 整体执行率与行内同一口径：Σ各项目（基线 − 最新剩余）÷ Σ各项目基线，
 * 分母按项目只算一次（不累加每轮的用例总数），结果不超过 100%。
 */
export function caseExecCounts(items: CaseExecItem[]) {
  const projects = new Set(items.map((x) => x.project).filter(Boolean));
  const progress = caseExecProjectProgress(items);
  const total = items.reduce((sum, x) => sum + x.total, 0);
  const executed = [...progress.values()].reduce((sum, x) => sum + x.executed, 0);
  const baseline = [...progress.values()].reduce((sum, x) => sum + x.baseline, 0);
  return {
    records: items.length,
    projects: projects.size,
    total,
    /** 各项目第一条用例总数之和：整体执行率的分母 */
    baseline,
    executed,
    percent: baseline > 0 ? Math.min(100, (executed / baseline) * 100) : 0,
  };
}
