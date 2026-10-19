/**
 * 项目管理（空间级）：四个插件各自独立的数据目录。
 *
 * 存储：`<数据空间>/<插件目录>/<插件目录>.json`（项目列表 / 迭代管理 / 需求管理 / 缺陷管理），
 * 由 lh-plugins/lh-pm.mjs 提供读写；目录只在真的有数据时创建。
 * 迭代进度 / 逾期天数 / 项目统计都是派生值，不落库。
 */

const API = '/__tb_pm';

export type PmEntity = 'projects' | 'iterations' | 'requirements' | 'bugs';

export type ProjectStatus = 'planning' | 'in_progress' | 'archived';
export type IterationStatus = 'planning' | 'in_progress' | 'done';
export type RequirementPriority = 'urgent' | 'high' | 'medium' | 'low';
export type RequirementStatus =
  'pending' | 'todo' | 'in_progress' | 'testing' | 'done' | 'cancelled';
export type BugSeverity = 'critical' | 'major' | 'minor' | 'trivial';
export type BugStatus = 'pending' | 'todo' | 'in_progress' | 'verifying' | 'closed';

export interface ProjectItem {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IterationItem {
  id: string;
  projectId: string;
  name: string;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate: string;
  status: IterationStatus;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptanceCriterion {
  text: string;
  done: boolean;
}

export interface RequirementItem {
  id: string;
  /** 展示编号，如 REQ-001 */
  autoId: string;
  projectId: string;
  /** 空串 = 未关联迭代 */
  iterationId: string;
  title: string;
  priority: RequirementPriority;
  status: RequirementStatus;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  githubIssue: string;
  /** 换行分隔的附件地址 */
  attachment: string;
  createdAt: string;
  updatedAt: string;
}

export interface BugItem {
  id: string;
  /** 展示编号，如 BUG-001 */
  autoId: string;
  projectId: string;
  iterationId: string;
  requirementId: string;
  title: string;
  severity: BugSeverity;
  status: BugStatus;
  reproduceSteps: string;
  expectedResult: string;
  actualResult: string;
  environment: string;
  githubIssue: string;
  attachment: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

export interface PmStore {
  projects: ProjectItem[];
  iterations: IterationItem[];
  requirements: RequirementItem[];
  bugs: BugItem[];
}

export const PROJECT_STATUSES: readonly ProjectStatus[] = ['planning', 'in_progress', 'archived'];
export const ITERATION_STATUSES: readonly IterationStatus[] = ['planning', 'in_progress', 'done'];
export const REQUIREMENT_PRIORITIES: readonly RequirementPriority[] = [
  'urgent',
  'high',
  'medium',
  'low',
];
export const REQUIREMENT_STATUSES: readonly RequirementStatus[] = [
  'pending',
  'todo',
  'in_progress',
  'testing',
  'done',
  'cancelled',
];
export const BUG_SEVERITIES: readonly BugSeverity[] = ['critical', 'major', 'minor', 'trivial'];
export const BUG_STATUSES: readonly BugStatus[] = [
  'pending',
  'todo',
  'in_progress',
  'verifying',
  'closed',
];

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  planning: '规划中',
  in_progress: '进行中',
  archived: '已归档',
};

export const ITERATION_STATUS_LABEL: Record<IterationStatus, string> = {
  planning: '规划中',
  in_progress: '进行中',
  done: '已完成',
};

export const REQUIREMENT_PRIORITY_LABEL: Record<RequirementPriority, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};

export const REQUIREMENT_STATUS_LABEL: Record<RequirementStatus, string> = {
  pending: '待评估',
  todo: '待开发',
  in_progress: '开发中',
  testing: '测试中',
  done: '已完成',
  cancelled: '已取消',
};

export const BUG_SEVERITY_LABEL: Record<BugSeverity, string> = {
  critical: '致命',
  major: '严重',
  minor: '一般',
  trivial: '轻微',
};

export const BUG_STATUS_LABEL: Record<BugStatus, string> = {
  pending: '待确认',
  todo: '待修复',
  in_progress: '修复中',
  verifying: '待验证',
  closed: '已关闭',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function dateStr(value: unknown): string {
  const s = str(value, 10);
  return DATE_RE.test(s) ? s : '';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const s = str(value, 40);
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function isIterationStatus(value: unknown): value is IterationStatus {
  return typeof value === 'string' && (ITERATION_STATUSES as readonly string[]).includes(value);
}

export function isRequirementStatus(value: unknown): value is RequirementStatus {
  return typeof value === 'string' && (REQUIREMENT_STATUSES as readonly string[]).includes(value);
}

export function isRequirementPriority(value: unknown): value is RequirementPriority {
  return typeof value === 'string' && (REQUIREMENT_PRIORITIES as readonly string[]).includes(value);
}

export function isBugStatus(value: unknown): value is BugStatus {
  return typeof value === 'string' && (BUG_STATUSES as readonly string[]).includes(value);
}

export function isBugSeverity(value: unknown): value is BugSeverity {
  return typeof value === 'string' && (BUG_SEVERITIES as readonly string[]).includes(value);
}

function criteriaList(raw: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(raw)) return [];
  const out: AcceptanceCriterion[] = [];
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const label = str((item as Record<string, unknown>).text, 500);
    if (!label) continue;
    out.push({ text: label, done: (item as Record<string, unknown>).done === true });
  }
  return out;
}

function normalizeProject(raw: unknown): ProjectItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 200);
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id: str(r.id, 64) || `pj_${Math.random().toString(16).slice(2, 10)}`,
    name,
    description: str(r.description),
    status: oneOf(r.status, PROJECT_STATUSES, 'planning'),
    createdAt: str(r.createdAt, 40) || now,
    updatedAt: str(r.updatedAt, 40) || now,
  };
}

function normalizeIteration(raw: unknown): IterationItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 200);
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id: str(r.id, 64) || `it_${Math.random().toString(16).slice(2, 10)}`,
    projectId: str(r.projectId, 64),
    name,
    startDate: dateStr(r.startDate),
    endDate: dateStr(r.endDate),
    status: oneOf(r.status, ITERATION_STATUSES, 'planning'),
    remark: str(r.remark),
    createdAt: str(r.createdAt, 40) || now,
    updatedAt: str(r.updatedAt, 40) || now,
  };
}

function normalizeRequirement(raw: unknown): RequirementItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // 需求描述是多行文本，前端与本地插件都放宽到 2000 字
  const title = str(r.title, 2000);
  if (!title) return null;
  const now = new Date().toISOString();
  return {
    id: str(r.id, 64) || `rq_${Math.random().toString(16).slice(2, 10)}`,
    autoId: str(r.autoId, 20),
    projectId: str(r.projectId, 64),
    iterationId: str(r.iterationId, 64),
    title,
    priority: oneOf(r.priority, REQUIREMENT_PRIORITIES, 'medium'),
    status: oneOf(r.status, REQUIREMENT_STATUSES, 'pending'),
    description: str(r.description),
    acceptanceCriteria: criteriaList(r.acceptanceCriteria),
    githubIssue: str(r.githubIssue, 50),
    attachment: str(r.attachment),
    createdAt: str(r.createdAt, 40) || now,
    updatedAt: str(r.updatedAt, 40) || now,
  };
}

function normalizeBug(raw: unknown): BugItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  return {
    id: str(r.id, 64) || `bg_${Math.random().toString(16).slice(2, 10)}`,
    autoId: str(r.autoId, 20),
    projectId: str(r.projectId, 64),
    iterationId: str(r.iterationId, 64),
    requirementId: str(r.requirementId, 64),
    title,
    severity: oneOf(r.severity, BUG_SEVERITIES, 'minor'),
    status: oneOf(r.status, BUG_STATUSES, 'pending'),
    reproduceSteps: str(r.reproduceSteps),
    expectedResult: str(r.expectedResult),
    actualResult: str(r.actualResult),
    environment: str(r.environment, 500),
    githubIssue: str(r.githubIssue, 50),
    attachment: str(r.attachment),
    remark: str(r.remark),
    createdAt: str(r.createdAt, 40) || now,
    updatedAt: str(r.updatedAt, 40) || now,
  };
}

function normalizeList<T>(raw: unknown, fn: (x: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(fn).filter((x): x is T => Boolean(x));
}

export function emptyPmStore(): PmStore {
  return { projects: [], iterations: [], requirements: [], bugs: [] };
}

export function normalizePmStore(raw: unknown): PmStore {
  if (!raw || typeof raw !== 'object') return emptyPmStore();
  const r = raw as Record<string, unknown>;
  return {
    projects: normalizeList(r.projects, normalizeProject),
    iterations: normalizeList(r.iterations, normalizeIteration),
    requirements: normalizeList(r.requirements, normalizeRequirement),
    bugs: normalizeList(r.bugs, normalizeBug),
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

export async function fetchPmHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchPmStore(): Promise<PmStore> {
  return normalizePmStore(await request('GET'));
}

/**
 * 打开插件时调一次：如果空间里还留着旧版 `项目管理/项目管理.json`，
 * 顺便把里面的数据拆到各自目录。没有任何数据时不建目录。
 */
export async function syncPmStore(): Promise<void> {
  await fetchPmStore();
}

export type PmInput = Record<string, unknown>;

function normalizeEntity(entity: PmEntity, raw: unknown): unknown {
  if (entity === 'projects') return normalizeProject(raw);
  if (entity === 'iterations') return normalizeIteration(raw);
  if (entity === 'requirements') return normalizeRequirement(raw);
  return normalizeBug(raw);
}

export async function createPmItems<T>(
  entity: PmEntity,
  items: PmInput[],
  meta?: { mode?: 'manual' | 'ai'; sessionId?: string },
): Promise<T[]> {
  const data = (await request('POST', { entity, items, ...meta })) as { items?: unknown };
  const list = Array.isArray(data.items) ? data.items : [];
  return list.map((raw) => normalizeEntity(entity, raw)).filter((x): x is T => Boolean(x));
}

export async function updatePmItem<T>(entity: PmEntity, id: string, patch: PmInput): Promise<T> {
  const data = (await request('PUT', { entity, id, ...patch })) as { item?: unknown };
  const item = normalizeEntity(entity, data.item);
  if (!item) throw new Error('更新记录失败');
  return item as T;
}

export async function deletePmItems(
  entity: PmEntity,
  ids: string[],
): Promise<{ removed: number; cascaded: number }> {
  const data = (await request('DELETE', { entity, ids })) as {
    removed?: number;
    cascaded?: number;
  };
  return { removed: Number(data.removed ?? 0), cascaded: Number(data.cascaded ?? 0) };
}

/* ------------------------------ 派生值 ------------------------------ */

function toUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/** 两个日期相差的天数（b - a），任一非法返回 null */
export function daysBetween(a: string, b: string): number | null {
  if (!DATE_RE.test(a) || !DATE_RE.test(b)) return null;
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

/** 本地日期（不用 UTC，避免晚上 8 点后算成第二天） */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 迭代进度：按日期流逝算，含首尾。未开始 0、已结束 100、缺日期 0。
 * 与 luckytask 一致，它是「时间进度」而不是需求完成度。
 */
export function iterationProgressPercent(
  item: Pick<IterationItem, 'startDate' | 'endDate'>,
  today: string = todayIso(),
): number {
  const total = daysBetween(item.startDate, item.endDate);
  if (total === null) return 0;
  const span = total + 1;
  const elapsed = daysBetween(item.startDate, today);
  if (elapsed === null) return 0;
  return Math.min(100, Math.max(0, Math.round(((elapsed + 1) / span) * 100)));
}

/** 逾期天数：负数 = 还剩几天；已结束或无截止日期返回 null */
export function iterationOverdueDays(
  item: Pick<IterationItem, 'endDate' | 'status'>,
  today: string = todayIso(),
): number | null {
  if (item.status === 'done') return null;
  const diff = daysBetween(item.endDate, today);
  if (diff === null) return null;
  return diff > 0 ? diff : null;
}

export interface ProjectStats {
  iterations: number;
  requirements: number;
  requirementsDone: number;
  bugs: number;
  bugsClosed: number;
  /** 0~100，没有需求时为 0 */
  requirementPercent: number;
  /** 0~100，没有缺陷时为 100 */
  bugClosedPercent: number;
}

/** 按项目汇总迭代 / 需求 / 缺陷数量与完成度 */
export function projectStats(store: PmStore): Record<string, ProjectStats> {
  const map: Record<string, ProjectStats> = {};
  for (const p of store.projects) {
    map[p.id] = {
      iterations: 0,
      requirements: 0,
      requirementsDone: 0,
      bugs: 0,
      bugsClosed: 0,
      requirementPercent: 0,
      bugClosedPercent: 100,
    };
  }
  for (const it of store.iterations) {
    const stat = map[it.projectId];
    if (stat) stat.iterations += 1;
  }
  for (const rq of store.requirements) {
    const stat = map[rq.projectId];
    if (!stat) continue;
    stat.requirements += 1;
    if (rq.status === 'done') stat.requirementsDone += 1;
  }
  for (const bug of store.bugs) {
    const stat = map[bug.projectId];
    if (!stat) continue;
    stat.bugs += 1;
    if (bug.status === 'closed') stat.bugsClosed += 1;
  }
  for (const stat of Object.values(map)) {
    stat.requirementPercent = stat.requirements
      ? Math.round((stat.requirementsDone / stat.requirements) * 100)
      : 0;
    stat.bugClosedPercent = stat.bugs ? Math.round((stat.bugsClosed / stat.bugs) * 100) : 100;
  }
  return map;
}

/* ------------------------------ 筛选 ------------------------------ */

export interface ProjectFilter {
  status?: ProjectStatus | 'all';
  keyword?: string;
}

export function filterProjects(items: ProjectItem[], filter: ProjectFilter = {}): ProjectItem[] {
  const status = filter.status ?? 'all';
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  return items.filter((item) => {
    if (status !== 'all' && item.status !== status) return false;
    if (keyword) {
      const hay = `${item.name} ${item.description}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

export interface IterationFilter {
  projectId?: string | 'all';
  status?: IterationStatus | 'all';
  keyword?: string;
}

export function filterIterations(
  items: IterationItem[],
  filter: IterationFilter = {},
): IterationItem[] {
  const projectId = filter.projectId ?? 'all';
  const status = filter.status ?? 'all';
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  return items.filter((item) => {
    if (projectId !== 'all' && item.projectId !== projectId) return false;
    if (status !== 'all' && item.status !== status) return false;
    if (keyword) {
      const hay = `${item.name} ${item.remark}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

export interface RequirementFilter {
  projectId?: string | 'all';
  iterationId?: string | 'all';
  status?: RequirementStatus | 'all';
  priority?: RequirementPriority | 'all';
  keyword?: string;
}

export function filterRequirements(
  items: RequirementItem[],
  filter: RequirementFilter = {},
): RequirementItem[] {
  const projectId = filter.projectId ?? 'all';
  const iterationId = filter.iterationId ?? 'all';
  const status = filter.status ?? 'all';
  const priority = filter.priority ?? 'all';
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  return items.filter((item) => {
    if (projectId !== 'all' && item.projectId !== projectId) return false;
    if (iterationId !== 'all' && item.iterationId !== iterationId) return false;
    if (status !== 'all' && item.status !== status) return false;
    if (priority !== 'all' && item.priority !== priority) return false;
    if (keyword) {
      const hay = `${item.autoId} ${item.title} ${item.description}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

export interface BugFilter {
  projectId?: string | 'all';
  iterationId?: string | 'all';
  status?: BugStatus | 'all';
  severity?: BugSeverity | 'all';
  keyword?: string;
}

export function filterBugs(items: BugItem[], filter: BugFilter = {}): BugItem[] {
  const projectId = filter.projectId ?? 'all';
  const iterationId = filter.iterationId ?? 'all';
  const status = filter.status ?? 'all';
  const severity = filter.severity ?? 'all';
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  return items.filter((item) => {
    if (projectId !== 'all' && item.projectId !== projectId) return false;
    if (iterationId !== 'all' && item.iterationId !== iterationId) return false;
    if (status !== 'all' && item.status !== status) return false;
    if (severity !== 'all' && item.severity !== severity) return false;
    if (keyword) {
      const hay = `${item.autoId} ${item.title} ${item.reproduceSteps}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

/** 项目名 / 迭代名查找：先精确，再忽略大小写；找不到返回空串 */
export function findByName<T extends { id: string; name: string }>(
  items: T[],
  name: string,
): string {
  const target = name.trim();
  if (!target) return '';
  const exact = items.find((x) => x.name === target);
  if (exact) return exact.id;
  const lower = target.toLowerCase();
  return items.find((x) => x.name.toLowerCase() === lower)?.id ?? '';
}

/** 需求按标题查找（AI 工具传 requirement 名称时用） */
export function findRequirementByTitle(items: RequirementItem[], title: string): string {
  const target = title.trim();
  if (!target) return '';
  const lower = target.toLowerCase();
  return (
    items.find((x) => x.title === target)?.id ??
    items.find((x) => x.title.toLowerCase() === lower)?.id ??
    items.find((x) => x.autoId.toLowerCase() === lower)?.id ??
    ''
  );
}

/* ------------------------------ 缺陷描述 / 附件 ------------------------------ */

/** 缺陷没有独立标题字段：取描述第一行前 60 个字当标题 */
export function bugTitleFromDescription(description: string): string {
  const line = description
    .split('\n')
    .map((x) => x.trim())
    .find(Boolean);
  if (!line) return '';
  return Array.from(line).slice(0, 60).join('');
}

export interface PmAttachment {
  url: string;
  name: string;
}

/** 附件字段是一串换行分隔的地址；名字从 `p` 参数里的文件名取 */
export function parseAttachments(value: string): PmAttachment[] {
  return value
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((url) => ({ url, name: attachmentName(url) }));
}

export function joinAttachments(list: PmAttachment[]): string {
  return list.map((x) => x.url).join('\n');
}

/** 附件地址是不是图片：名字从 `p` 参数里取，取不到就看扩展名 */
export function isPmImageAttachment(url: string): boolean {
  try {
    const p = new URL(url, 'http://localhost').searchParams.get('p') ?? '';
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(decodeURIComponent(p));
  } catch {
    return false;
  }
}

function attachmentName(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost');
    const p = parsed.searchParams.get('p');
    const source = p ? decodeURIComponent(p) : parsed.pathname;
    const base = source.split('/').filter(Boolean).pop() ?? source;
    // 落盘时文件名前面加了时间戳与随机段，展示时去掉
    return base.replace(/^\d{10,}-[a-z0-9]+-/, '');
  } catch {
    return url;
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

/** 上传附件（文件 / 图片）：服务端落到当前空间的「缺陷管理/附件」下 */
export async function uploadPmFiles(files: File[]): Promise<PmAttachment[]> {
  if (!files.length) return [];
  const payload = await Promise.all(
    files.map(async (file) => ({
      name: file.name || 'attachment',
      type: file.type || 'application/octet-stream',
      data: toBase64(await file.arrayBuffer()),
    })),
  );
  const data = (await request('POST', { upload: payload })) as { files?: unknown };
  const list = Array.isArray(data.files) ? data.files : [];
  return list
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      const url = typeof r.url === 'string' ? r.url : '';
      if (!url) return null;
      const name = typeof r.name === 'string' && r.name ? r.name : attachmentName(url);
      return { url, name };
    })
    .filter((x): x is PmAttachment => Boolean(x));
}

/**
 * 让服务端删掉这些附件里「没有其他缺陷引用」的文件。
 * - 点附件上的 X：立即传当前缺陷 id，本条的引用不算，文件会当场从磁盘消失；
 * - 关抽屉：把这次出现过的地址都传一遍，未保存的草稿附件一并收掉。
 * 可重复调用，正被其他缺陷引用的地址不会被删。
 */
export async function cleanupPmAttachments(urls: string[], bugId = ''): Promise<void> {
  const list = urls.filter(Boolean);
  if (!list.length) return;
  try {
    await request('POST', bugId ? { cleanup: list, bugId } : { cleanup: list });
  } catch {
    // 清理失败不影响主流程：文件顶多留着，不影响缺陷数据
  }
}
