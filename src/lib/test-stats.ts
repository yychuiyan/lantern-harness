/**
 * 测试统计（空间级）：按维度记录每天的统计数量。
 * 存储：`<数据空间>/测试统计/测试统计.json`，由 lh-plugins/lh-stats.mjs 提供读写。
 * 维度列表由服务端维护（默认 7 个常用维度，用户可随时新增）。
 */

const API = '/__tb_test_stats';

/** 首次使用时给出的维度，与服务端默认值保持一致 */
export const DEFAULT_TEST_DIMENSIONS = [
  '功能测试用例',
  '自动化测试用例',
  '接口测试用例',
  '测试报告',
  '缺陷统计',
  '自动化缺陷统计',
  '测试计划',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COUNT = 9_999_999;

export interface TestStatsItem {
  id: string;
  /** 当前日期 YYYY-MM-DD */
  date: string;
  /** 测试统计维度（单选，存成单元素数组，兼容历史数据） */
  dimensions: string[];
  /** 统计数量 */
  count: number;
  /**
   * 刚点「+ 添加记录」生成、还没选维度的占位行。
   * 这类行也会落库（刷新后仍在），填好维度后自动变成正式记录。
   */
  draft: boolean;
  source: 'manual' | 'ai';
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestStatsInput {
  date?: string;
  dimensions?: string[];
  count?: number;
}

export type TestStatsPatch = Partial<TestStatsInput>;

export interface TestStatsList {
  items: TestStatsItem[];
  dimensions: string[];
}

function str(value: unknown, max = 80): string {
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

/** 维度去重 + 去掉空值，顺序保持用户选择顺序 */
export function normalizeDimensions(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const s = str(raw, 40);
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** 本地日期（不用 UTC，避免晚上 8 点后算成第二天） */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 宽松解析服务端返回（旧文件 / 手工改动都不至于让页面炸） */
export function normalizeTestStatsItem(raw: unknown): TestStatsItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // 维度是单选：历史数据里若存了多个，只保留第一个，避免界面上看不见的隐藏值
  const dimensions = normalizeDimensions(r.dimensions).slice(0, 1);
  const draft = !dimensions.length;
  // 缺维度的历史脏数据仍然丢弃；只有带 draft 标记的空占位行保留
  if (draft && r.draft !== true) return null;
  const now = new Date().toISOString();
  return {
    id: str(r.id, 64) || `ts_${Math.random().toString(16).slice(2, 10)}`,
    date: dateStr(r.date) || todayIso(),
    dimensions,
    count: toCount(r.count),
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

export async function fetchTestStatsHealth(): Promise<boolean> {
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
export async function syncTestStats(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/sync`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listTestStats(): Promise<TestStatsList> {
  const data = (await request('GET')) as { items?: unknown; dimensions?: unknown };
  const items = Array.isArray(data.items) ? data.items : [];
  const dimensions = normalizeDimensions(data.dimensions);
  return {
    items: items.map(normalizeTestStatsItem).filter((x): x is TestStatsItem => Boolean(x)),
    dimensions: dimensions.length ? dimensions : [...DEFAULT_TEST_DIMENSIONS],
  };
}

export async function createTestStats(
  items: TestStatsInput[],
  meta?: { mode?: 'manual' | 'ai'; sessionId?: string },
): Promise<{ items: TestStatsItem[]; dimensions: string[] }> {
  const data = (await request('POST', { items, ...meta })) as {
    items?: unknown;
    dimensions?: unknown;
  };
  const created = Array.isArray(data.items) ? data.items : [];
  return {
    items: created.map(normalizeTestStatsItem).filter((x): x is TestStatsItem => Boolean(x)),
    dimensions: normalizeDimensions(data.dimensions),
  };
}

export async function updateTestStats(
  id: string,
  patch: TestStatsPatch,
): Promise<{ item: TestStatsItem; dimensions: string[] }> {
  const data = (await request('PUT', { id, ...patch })) as {
    item?: unknown;
    dimensions?: unknown;
  };
  const item = normalizeTestStatsItem(data.item);
  if (!item) throw new Error('更新测试统计失败');
  return { item, dimensions: normalizeDimensions(data.dimensions) };
}

export async function deleteTestStats(ids: string[]): Promise<number> {
  const data = (await request('DELETE', { ids })) as { removed?: number };
  return Number(data.removed ?? 0);
}

/**
 * 表格默认顺序：日期从新到旧（递减），同一天按创建时间从新到旧。
 * 这样最新一天的数据总在最上面，翻到第 1 页就能看到最近记录。
 */
export function sortTestStats(items: TestStatsItem[]): TestStatsItem[] {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

export interface TestStatsFilter {
  keyword?: string;
}

export function filterTestStats(
  items: TestStatsItem[],
  filter: TestStatsFilter = {},
): TestStatsItem[] {
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  if (!keyword) return items;
  return items.filter((item) =>
    `${item.date} ${item.dimensions.join(' ')} ${item.count}`.toLowerCase().includes(keyword),
  );
}

/** 页头统计：记录数、覆盖维度数、统计数量合计 */
export function testStatsCounts(items: TestStatsItem[]) {
  const dimensions = new Set<string>();
  let total = 0;
  for (const item of items) {
    total += item.count;
    for (const d of item.dimensions) dimensions.add(d);
  }
  return { records: items.length, dimensions: dimensions.size, total };
}
