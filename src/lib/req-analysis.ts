/**
 * 需求分析：类型、接口封装、拆解工具与体检规则。
 *
 * - 一次分析 = 一份文档：来源需求文档 + 需求条目 + 用户故事 + 体检报告，落在
 *   `<当前数据空间>/需求分析/需求分析.json`（见 lh-plugins/lh-req-analysis.mjs）。
 * - 拆解 / 体检 / 补写都在浏览器里跑模型（`streamChatWithTools`），工具调用落到本文件
 *   的接口封装上；模型只提交白名单字段，编号由服务端分配。
 * - `auditStories` 是纯函数：覆盖率、字段完整性、维度覆盖都不靠模型自觉，
 *   模型侧的体检只补语义缺口（漏角色、替代流程不成立、验收不可测…）。
 */
import type { PmTone } from '../components/islands/PmShared';
import type { TestPointReport } from './test-points';

export const REQ_ANALYSIS_API = '/__tb_reqanalysis';
/** 与 lh-plugins/plugin-prompts.mjs 保持一致 */
export const REQ_ANALYSIS_PROMPT_FILE = '需求分析提示词.md';
export const REQ_ANALYSIS_DIR = '需求分析';
/** 单批提交给模型的原始需求上限（字符） */
export const REQ_CHUNK_CHARS = 12_000;
/** 审查 / 补写时附带的原文上限：原文再长也只给前这么多字，避免单次请求过大 */
export const REQ_REVIEW_SOURCE_CHARS = 20_000;

export type ReqDocStatus = 'draft' | 'decomposed' | 'checked' | 'accepted';
export type ReqPriority = 'P0' | 'P1' | 'P2';
export type ReqStage = 'idle' | 'outline' | 'stories' | 'audit' | 'points' | 'done';
export type ReqOutlineKind = 'query' | 'mutate';
export type ReqGapType =
  | 'uncovered-outline'
  | 'pending-confirm'
  | 'missing-field'
  | 'missing-scenario'
  | 'missing-dimension'
  | 'untestable-acceptance'
  | 'conflict'
  | 'over-split'
  | 'other';
export type ReqGapSeverity = 'high' | 'medium' | 'low';
export type ReqGapOrigin = 'rule' | 'model';

export interface ReqOutlineItem {
  id: string;
  title: string;
  quote: string;
  /** 文档条目原文切片（父级）；子点可空 */
  body?: string;
  /** 查询 / 修改；父级文档条目无 kind */
  kind?: ReqOutlineKind;
  /** 所属文档条目 id；父级无 parentId */
  parentId?: string;
}

export interface ReqFlowStep {
  actor?: string;
  action: string;
  result?: string;
}

export interface ReqAltFlow {
  name: string;
  trigger: string;
  steps: string[];
}

export interface ReqException {
  scenario: string;
  expected: string;
}

export interface ReqAcceptance {
  given: string;
  when: string;
  then: string;
}

export interface ReqStory {
  id: string;
  title: string;
  role: string;
  goal: string;
  value: string;
  /** 对应 outline 条目的 id：覆盖率靠它确定性计算 */
  sourceRefs: string[];
  priority: ReqPriority;
  preconditions: string[];
  mainFlow: ReqFlowStep[];
  altFlows: ReqAltFlow[];
  exceptions: ReqException[];
  postconditions: string[];
  acceptance: ReqAcceptance[];
  dimensions: string[];
}

/** 模型提交的故事：id 可缺省（服务端按 seq 分配） */
export type ReqStoryDraft = Omit<ReqStory, 'id'> & { id?: string };

export interface ReqGap {
  id: string;
  /** 相关故事；全局缺口为空串 */
  storyId: string;
  /** 关联需求点 / 文档条目 id（未覆盖类） */
  outlineId?: string;
  type: ReqGapType;
  severity: ReqGapSeverity;
  title: string;
  detail: string;
  suggestion: string;
  origin: ReqGapOrigin;
  /** 用户在缺口清单里勾选的状态 */
  selected: boolean;
  /** 产品/人工确认结论；「填结论」写入，补写时带给模型 */
  conclusion?: string;
}

/** 已忽略的待确认缺口（不进正式故事，可恢复 / 落成） */
export interface ReqIgnoredGap extends ReqGap {
  ignoredAt: string;
}

export interface ReqCoverage {
  total: number;
  covered: number;
  rate: number;
}

export interface ReqDimensionCoverage {
  key: string;
  label: string;
  covered: boolean;
  /** 覆盖该维度的故事 id */
  stories: string[];
}

export interface ReqCheckReport {
  at: string;
  summary: string;
  coverage: ReqCoverage;
  dimensions: ReqDimensionCoverage[];
  gaps: ReqGap[];
}

export interface ReqProgress {
  stage: ReqStage;
  done: number;
  total: number;
  message: string;
  at: string;
}

/** 需求文档库里的一个来源文件（word / excel 也能直接拆） */
export interface ReqSourceFile {
  path: string;
  name: string;
  /** 去掉点的扩展名：md / txt / docx / xlsx … */
  format: string;
  /** false 表示暂时不能拆解（pdf / doc / ppt） */
  supported: boolean;
  /** 最近修改时间（ms）；旧服务可能没有 */
  mtime?: number;
  /** 上传/创建时间（ms，birthtime）；旧服务可能没有 */
  ctime?: number;
}

export interface ReqSourceText {
  path: string;
  content: string;
  format: string;
  chars: number;
  truncated: boolean;
}

export interface ReqAnalysisDoc {
  id: string;
  title: string;
  sourcePath: string;
  sourceTitle: string;
  /** 源文档指纹：变了提示「需重新拆解」 */
  sourceHash: string;
  status: ReqDocStatus;
  outline: ReqOutlineItem[];
  stories: ReqStory[];
  check: ReqCheckReport | null;
  /** 已忽略的待确认缺口 */
  ignoredGaps?: ReqIgnoredGap[];
  /** 「生成测试点」插件的产出；插件关闭或还没生成时为 null */
  testPoints: TestPointReport | null;
  /**
   * 多迭代历史记忆：关联的更早分析 id 列表。
   * `undefined` = 尚未设置（打开时可自动建议）；`[]` = 用户清空不用；非空 = 按所选检索注入。
   */
  priorMemoryDocIds?: string[];
  progress: ReqProgress | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReqDocPatch {
  title?: string;
  sourcePath?: string;
  sourceTitle?: string;
  sourceHash?: string;
  status?: ReqDocStatus;
  outline?: ReqOutlineItem[];
  stories?: ReqStoryDraft[];
  /** 整份替换（重新拆解）时从 US-001 重新编号 */
  replaceStories?: boolean;
  check?: ReqCheckReport | null;
  ignoredGaps?: ReqIgnoredGap[];
  testPoints?: TestPointReport | null;
  priorMemoryDocIds?: string[];
  progress?: ReqProgress | null;
}

export interface ReqPrompt {
  file: string;
  exists: boolean;
  /** 「## 拆解需求」：整理查/改子点；旧「## 拆解」会复用到此 */
  decompose: string;
  /** 「## 生成用户故事」；旧「## 拆解」会复用到此 */
  stories: string;
  audit: string;
  fix: string;
  error?: string;
}

export interface ReqPromptSync {
  ok: boolean;
  enabled: boolean;
  file: string;
  created?: boolean;
  updated?: boolean;
  exists?: boolean;
  removed?: boolean;
}

export const REQ_STATUS_META: Record<ReqDocStatus, { label: string; tone: PmTone }> = {
  draft: { label: '待拆解', tone: 'gray' },
  decomposed: { label: '已拆解', tone: 'blue' },
  checked: { label: '已审查', tone: 'amber' },
  accepted: { label: '已验收', tone: 'green' },
};

export const REQ_PRIORITY_TONE: Record<ReqPriority, PmTone> = {
  P0: 'red',
  P1: 'amber',
  P2: 'gray',
};

export const GAP_TYPE_LABEL: Record<ReqGapType, string> = {
  'uncovered-outline': '待确认·未覆盖',
  'pending-confirm': '待确认',
  'missing-field': '字段缺失',
  'missing-scenario': '场景遗漏',
  'missing-dimension': '维度缺失',
  'untestable-acceptance': '验收不可测',
  conflict: '与原文冲突',
  'over-split': '过度拆分',
  other: '其它',
};

/** 主缺口清单只保留「待确认」类；字段/维度质检不进主列表 */
export const MAIN_CONFIRM_GAP_TYPES: ReadonlySet<ReqGapType> = new Set([
  'uncovered-outline',
  'pending-confirm',
  'conflict',
  'other',
]);

export function isMainConfirmGap(gap: Pick<ReqGap, 'type'>): boolean {
  return MAIN_CONFIRM_GAP_TYPES.has(gap.type);
}

export function filterMainConfirmGaps(gaps: readonly ReqGap[]): ReqGap[] {
  return gaps.filter(isMainConfirmGap);
}

export const GAP_SEVERITY_LABEL: Record<ReqGapSeverity, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export const GAP_SEVERITY_TONE: Record<ReqGapSeverity, PmTone> = {
  high: 'red',
  medium: 'amber',
  low: 'gray',
};

/**
 * 体检维度：既用于覆盖率矩阵，也用于确定性规则（故事正文里出现关键词就算覆盖到）。
 * 只放「漏了会出事、又常被漏掉」的六类，不追求大而全。
 */
export const REQ_DIMENSIONS: ReadonlyArray<{
  key: string;
  label: string;
  keywords: string[];
  hint: string;
}> = [
  {
    key: 'permission',
    label: '权限与角色',
    keywords: ['权限', '角色', '授权', '越权', '未登录', '登录', '管理员', '普通用户'],
    hint: '补充不同角色 / 未登录 / 越权访问时这条流程的行为。',
  },
  {
    key: 'boundary',
    label: '边界值',
    keywords: ['边界', '上限', '下限', '最大', '最小', '长度', '超长', '字数', '为空', '空值'],
    hint: '补充字段长度、数量上限、刚好等于阈值时的表现。',
  },
  {
    key: 'concurrency',
    label: '并发与幂等',
    keywords: ['并发', '重复', '幂等', '同时', '加锁', '冲突', '重复提交'],
    hint: '补充重复提交、多人同时操作同一数据时的结果。',
  },
  {
    key: 'empty',
    label: '空数据',
    keywords: ['空数据', '无数据', '没有数据', '空列表', '暂无', '空态'],
    hint: '补充列表为空、首次使用、数据被清空时的空态。',
  },
  {
    key: 'failure',
    label: '超时与失败',
    keywords: ['超时', '失败', '异常', '错误', '重试', '断网', '不可用', '降级', '回滚'],
    hint: '补充依赖超时、接口失败、网络中断时的提示与回滚。',
  },
  {
    key: 'i18n',
    label: '国际化与时区',
    keywords: ['国际化', '时区', '多语言', '语言', '翻译', 'utc', '夏令时'],
    hint: '补充跨时区时间展示、多语言文案与本地化格式。',
  },
];

/** 写操作：这类故事必须写异常分支，否则基本等于没考虑失败 */
const WRITE_ACTION_RE =
  /创建|新增|新建|保存|提交|删除|编辑|修改|更新|上传|导入|导出|发布|审批|撤回|绑定|解绑|发送|支付|下单|配置|启停|启用|停用/;

/* ------------------------------ 接口 ------------------------------ */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${REQ_ANALYSIS_API}${path}`, {
    ...init,
    headers:
      init?.body === undefined
        ? undefined
        : { 'Content-Type': 'application/json', ...init?.headers },
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export async function fetchReqAnalysisHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${REQ_ANALYSIS_API}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listReqDocs(): Promise<ReqAnalysisDoc[]> {
  const json = await request<{ docs: ReqAnalysisDoc[] }>('/list');
  return json.docs ?? [];
}

export async function createReqDoc(input: {
  sourcePath: string;
  sourceTitle?: string;
  sourceHash?: string;
  title?: string;
}): Promise<ReqAnalysisDoc> {
  const json = await request<{ doc: ReqAnalysisDoc }>('/create', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return json.doc;
}

export async function updateReqDoc(id: string, patch: ReqDocPatch): Promise<ReqAnalysisDoc> {
  const json = await request<{ doc: ReqAnalysisDoc }>('/', {
    method: 'PUT',
    body: JSON.stringify({ id, ...patch }),
  });
  return json.doc;
}

export async function deleteReqDoc(id: string): Promise<void> {
  await request('/delete', { method: 'POST', body: JSON.stringify({ id }) });
}

export async function fetchReqPrompt(): Promise<ReqPrompt> {
  try {
    const json = await request<Omit<ReqPrompt, 'file'> & { file: string }>('/prompt');
    const decompose = json.decompose ?? '';
    const stories = (json as { stories?: string }).stories ?? '';
    return {
      file: json.file || REQ_ANALYSIS_PROMPT_FILE,
      exists: json.exists === true,
      decompose,
      stories: stories || decompose,
      audit: json.audit ?? '',
      fix: json.fix ?? '',
    };
  } catch (err) {
    return {
      file: REQ_ANALYSIS_PROMPT_FILE,
      exists: false,
      decompose: '',
      stories: '',
      audit: '',
      fix: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 开关联动：enabled=true 缺提示词就补种子；false 只停用、不删文件 */
export async function syncReqPrompt(enabled: boolean): Promise<ReqPromptSync> {
  const json = await request<ReqPromptSync>('/prompt/sync', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
  return json;
}

/** 读取来源需求文档正文（只读，不改需求文档库） */
export async function readReqSource(path: string): Promise<string> {
  const info = await readReqSourceFile(path);
  return info.content;
}

/**
 * 审查 / 补写用的原文节选：超长按上限截断，读不到返回空串（不让审查流程整个失败）。
 */
export async function readReqSourceExcerpt(
  path: string,
  maxChars: number = REQ_REVIEW_SOURCE_CHARS,
): Promise<{ text: string; total: number; truncated: boolean }> {
  try {
    const text = (await readReqSource(path)).trim();
    return {
      text: text.slice(0, maxChars),
      total: text.length,
      truncated: text.length > maxChars,
    };
  } catch {
    return { text: '', total: 0, truncated: false };
  }
}

/** 来源文档清单（路径 + 格式 + 能否拆解），由插件自己遍历需求文档库 */
export async function listReqSources(): Promise<ReqSourceFile[]> {
  const json = await request<{ files: ReqSourceFile[] }>('/sources');
  return json.files ?? [];
}

/**
 * 读来源正文：md / txt / csv 直读，docx / xlsx / xls 由服务端抽文本。
 * 抽出来的正文与原始文件无关，不写回需求文档库。
 */
export async function readReqSourceFile(path: string): Promise<ReqSourceText> {
  return request<ReqSourceText>(`/source?path=${encodeURIComponent(path)}`);
}

/* ------------------------------ 工具函数 ------------------------------ */

const PUNCT_RE = /[\s\p{P}\p{S}]+/gu;

function keyOf(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(PUNCT_RE, '');
}

function uniq(list: string[]): string[] {
  return Array.from(new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean)));
}

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function strList(value: unknown, max = 30, itemMax = 500): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => str(x, itemMax))
    .filter(Boolean)
    .slice(0, max);
}

/** 32 位 FNV-1a：体检缺口 id 要稳定（跨次体检的勾选状态才留得住） */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 来源文档指纹：按内容算，不看修改时间（拷贝 / 另存不会误报） */
export function sourceHashOf(text: string): string {
  return shortHash(String(text ?? ''));
}

function clampReqName(value: string, max = 80): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 分析记录 / 顶栏展示用的「需求文档文件名」（带扩展名），不是 Ideal 大模块名 */
export function reqSourceFileName(doc: {
  sourceTitle?: string;
  sourcePath?: string;
  title?: string;
}): string {
  const raw = String(doc.sourceTitle || doc.sourcePath || '').trim();
  if (raw) {
    const base = raw.split(/[/\\]/).pop()?.trim();
    if (base) return base;
  }
  return String(doc.title || '').trim() || '未命名文档';
}

/** 从文件名去掉扩展名与常见「_需求文档」尾巴，仅作兜底 */
export function reqNameFromFileName(fileNameOrPath: string): string {
  const base =
    String(fileNameOrPath ?? '')
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.[^.]+$/, '')
      .trim() || '';
  return (
    clampReqName(
      base
        .replace(/_?需求文档$/u, '')
        .replace(/_?需求说明$/u, '')
        .replace(/_?需求$/u, '')
        .trim(),
    ) || '未命名需求'
  );
}

/** 分析展示名：来源标题 → 标题 → 路径文件名 */
export function reqAnalysisLabel(
  doc: Pick<ReqAnalysisDoc, 'title' | 'sourcePath' | 'sourceTitle'>,
): string {
  return String(doc.sourceTitle || doc.title || '').trim() || reqNameFromFileName(doc.sourcePath);
}

/**
 * 产品 / 版本解析用 stem：只剥真实文档扩展名，避免把 `v1.16.0` 的 `.0` 当成扩展名切掉。
 */
function reqVersionLabelStem(titleOrPath: string): string {
  let base =
    String(titleOrPath ?? '')
      .split(/[/\\]/)
      .pop()
      ?.trim() || '';
  base = base.replace(/\.(xlsx|xls|docx|doc|md|txt|csv)$/i, '');
  return base
    .replace(/_?需求文档$/u, '')
    .replace(/_?需求说明$/u, '')
    .replace(/_?需求$/u, '')
    .replace(/迭代版本$/u, '')
    .replace(/版本$/u, '')
    .trim();
}

/**
 * 产品族键：去掉版本号与「版本/迭代版本」后的前缀。
 * 例：`政企通v1.16.0版本_需求文档` → `政企通`
 */
export function reqProductFamilyKey(titleOrPath: string): string {
  let base = reqVersionLabelStem(titleOrPath);
  base = base.replace(/v?\d+(?:\.\d+)*/gi, '');
  return base.replace(/[\s_\-—·()（）[\]【】]+/gu, '').toLowerCase();
}

/**
 * 解析版本元组；失败返回 null。
 * 例：`政企通v1.16.0` → `[1, 16, 0]`
 */
export function reqVersionTuple(titleOrPath: string): number[] | null {
  const stem = reqVersionLabelStem(titleOrPath);
  const m = /v(\d+(?:\.\d+)*)/i.exec(stem) || /(\d+(?:\.\d+)+)/.exec(stem);
  if (!m?.[1]) return null;
  return m[1].split('.').map((n) => {
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
  });
}

/** 版本比较：负 = a&lt;b，0 = 相等，正 = a&gt;b */
export function compareReqVersionTuples(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const da = a[i] ?? 0;
    const db = b[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * 同产品、版本严格低于当前的历史分析，按版本旧→新。
 * 当前或候选解析不出版本 / 产品族时跳过。
 */
export function listPriorReqAnalyses(
  current: Pick<ReqAnalysisDoc, 'id' | 'title' | 'sourcePath' | 'sourceTitle'>,
  allDocs: readonly ReqAnalysisDoc[],
): ReqAnalysisDoc[] {
  const label = reqAnalysisLabel(current);
  const family = reqProductFamilyKey(label);
  const ver = reqVersionTuple(label);
  if (!family || !ver) return [];
  return allDocs
    .filter((doc) => {
      if (doc.id === current.id) return false;
      const other = reqAnalysisLabel(doc);
      if (reqProductFamilyKey(other) !== family) return false;
      const ov = reqVersionTuple(other);
      if (!ov) return false;
      return compareReqVersionTuples(ov, ver) < 0;
    })
    .sort((a, b) => {
      const va = reqVersionTuple(reqAnalysisLabel(a)) ?? [];
      const vb = reqVersionTuple(reqAnalysisLabel(b)) ?? [];
      return compareReqVersionTuples(va, vb);
    });
}

export interface PriorOutlineIndexEntry {
  docId: string;
  docLabel: string;
  point: ReqOutlineItem;
}

export interface PriorOutlineHit extends PriorOutlineIndexEntry {
  score: number;
}

/** 展平历史分析的查/改覆盖目标，供检索 */
export function buildPriorOutlineIndex(docs: readonly ReqAnalysisDoc[]): PriorOutlineIndexEntry[] {
  const out: PriorOutlineIndexEntry[] = [];
  for (const doc of docs) {
    const docLabel = reqAnalysisLabel(doc);
    for (const point of outlineCoverageItems(doc.outline)) {
      out.push({ docId: doc.id, docLabel, point });
    }
  }
  return out;
}

/** 抽检索用 token：英文词 + 中文双字 */
function priorMemoryTokens(text: string): string[] {
  const raw = String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return [];
  const tokens: string[] = [];
  for (const m of raw.matchAll(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{2}/gu)) {
    tokens.push(m[0]!);
  }
  // 再补连续中文双字
  const hans = raw.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < hans.length - 1; i++) {
    tokens.push(hans.slice(i, i + 2));
  }
  return [...new Set(tokens)].slice(0, 80);
}

const PRIOR_MEMORY_MAX_ITEMS = 40;
const PRIOR_MEMORY_MAX_CHARS = 7000;

/**
 * 按当前批原文检索相关历史子点；本地打分，限额截断。
 */
export function retrievePriorOutlineHits(
  queryText: string,
  index: readonly PriorOutlineIndexEntry[],
  opts?: { maxItems?: number; maxChars?: number },
): PriorOutlineHit[] {
  if (!index.length) return [];
  const maxItems = Math.max(1, opts?.maxItems ?? PRIOR_MEMORY_MAX_ITEMS);
  const maxChars = Math.max(200, opts?.maxChars ?? PRIOR_MEMORY_MAX_CHARS);
  const qTokens = priorMemoryTokens(queryText);
  const qLower = String(queryText ?? '').toLowerCase();
  if (!qTokens.length && !qLower.trim()) return [];

  const scored: PriorOutlineHit[] = [];
  for (const entry of index) {
    const title = entry.point.title || '';
    const quote = (entry.point.quote || entry.point.body || '').slice(0, 200);
    const blob = `${title} ${quote}`.toLowerCase();
    let score = 0;
    if (title && qLower.includes(title.toLowerCase())) score += 8;
    if (quote && quote.length >= 4 && qLower.includes(quote.toLowerCase().slice(0, 40))) {
      score += 5;
    }
    const pTokens = priorMemoryTokens(`${title} ${quote}`);
    for (const t of pTokens) {
      if (qTokens.includes(t)) score += t.length >= 3 ? 2 : 1;
    }
    if (score <= 0) continue;
    scored.push({ ...entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.docLabel.localeCompare(b.docLabel, 'zh') ||
      a.point.id.localeCompare(b.point.id),
  );

  const hits: PriorOutlineHit[] = [];
  let chars = 0;
  for (const hit of scored) {
    if (hits.length >= maxItems) break;
    const line = formatPriorHitLine(hit);
    if (hits.length > 0 && chars + line.length + 1 > maxChars) break;
    hits.push(hit);
    chars += line.length + 1;
  }
  return hits;
}

function formatPriorHitLine(hit: PriorOutlineHit): string {
  const kind = hit.point.kind === 'query' ? '查询' : hit.point.kind === 'mutate' ? '修改' : '子点';
  const quote = (hit.point.quote || hit.point.body || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `- [${hit.docLabel}] ${hit.point.id} [${kind}] ${hit.point.title}${
    quote ? `（${quote}）` : ''
  }`;
}

/**
 * 拼进拆解 / 生成故事的 prompt。
 * 历史 RO id 仅供对照，禁止写入本版 sourceRefs。
 */
export function formatPriorMemoryForPrompt(hits: readonly PriorOutlineHit[]): string {
  if (!hits.length) return '';
  const docs = [...new Set(hits.map((h) => h.docLabel))];
  const lines = [
    '## 历史迭代需求条目（检索参考，勿当作本版文档条目 id）',
    `来源版本：${docs.join('、')}。下列 id 属于历史分析，禁止写入本版 sourceRefs；仅作能力对照与延伸参考。`,
    ...hits.map(formatPriorHitLine),
  ];
  return lines.join('\n');
}

/**
 * 从已选 id 解析历史文档；过滤已删 / 无条目的。
 */
export function resolvePriorMemoryDocs(
  selectedIds: readonly string[] | undefined,
  allDocs: readonly ReqAnalysisDoc[],
): ReqAnalysisDoc[] {
  if (!selectedIds?.length) return [];
  const byId = new Map(allDocs.map((d) => [d.id, d]));
  const out: ReqAnalysisDoc[] = [];
  for (const id of selectedIds) {
    const doc = byId.get(id);
    if (!doc) continue;
    if (!outlineCoverageItems(doc.outline).length) continue;
    out.push(doc);
  }
  return out;
}

/**
 * 从需求正文推断「需求名称」（产品 / 模块名），不是文件名。
 * 优先级：Markdown 一级标题 →「需求名称」类标签 → Ideal 表「大模块」列众数 → 文首短【名称】 → 文件名兜底。
 */
export function inferRequirementName(content: string, fileFallback = ''): string {
  const text = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  const fallback = reqNameFromFileName(fileFallback);

  if (!text) return fallback;

  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1?.[1]) {
    const name = clampReqName(h1[1]);
    if (name) return name;
  }

  const labeled = text.match(
    /^(?:需求名称|需求名|需求标题|项目名称|系统名称|产品名称)\s*[:：]\s*(.+)$/m,
  );
  if (labeled?.[1]) {
    const name = clampReqName(labeled[1]);
    if (name) return name;
  }

  // Ideal 需求表：表头含「大模块」，取前若干行该列众数（通常是产品名）
  const headerLine = text
    .split('\n')
    .find((line) => /大模块/.test(line) && /小模块|优化/.test(line));
  if (headerLine) {
    const headers = headerLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const idx = headers.findIndex((h) => h === '大模块' || /^大模块$/.test(h));
    if (idx >= 0) {
      const freq = new Map<string, number>();
      // sheet_to_csv 多行单元格会打断行：只扫看起来像「首列短文本」的行
      for (const line of text.split('\n').slice(0, 200)) {
        if (/^大模块/.test(line)) continue;
        const m = line.match(/^"?([^,"\n]{1,40})"?,/);
        if (!m?.[1]) continue;
        const cell = m[1].trim();
        if (!cell || cell === '大模块') continue;
        // 跳过明显是正文开头的长句
        if (/[。；;]/.test(cell) || cell.length > 24) continue;
        freq.set(cell, (freq.get(cell) ?? 0) + 1);
      }
      const ranked = [...freq.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'),
      );
      if (ranked[0]?.[0]) return clampReqName(ranked[0][0]);
    }
  }

  // 文首【短名】：Ideal 正文常用【政企通】，取较短的那个（排除「政企通页面管理」这类小节标题优先用更短的产品名）
  const brackets = [...text.matchAll(/【([^】\n]{1,40})】/g)]
    .map((m) => clampReqName(m[1] ?? ''))
    .filter((name) => name && name.length <= 20 && !/[：:]/.test(name));
  if (brackets.length) {
    const unique = [...new Set(brackets)];
    unique.sort((a, b) => a.length - b.length || brackets.indexOf(a) - brackets.indexOf(b));
    // 若最短名是其它名称的前缀（政企通 ⊂ 政企通页面管理），取最短
    return unique[0]!;
  }

  return fallback;
}

/** Ideal 表一行：大模块 / 小模块 / 展示标题（【短名】或小模块）/ 行正文 */
export interface IdealReqRow {
  big: string;
  small: string;
  title: string;
  /** 该行需求原文（第三列起） */
  body: string;
}

/**
 * Ideal 行在「优化/问题内容」之后还有截图 / 提出人 / 日期 / 类型 / 优先级等列。
 * sheet_to_csv 多行单元格结束时常把这些列粘在同一行或下一行，需剥掉只留需求正文。
 */
function isIdealMetaCsvLine(line: string): boolean {
  const s = String(line ?? '').trim();
  if (!s) return false;
  // 正文单元格收尾：`",,,,于赟,2026年9月20日,需求,高,...`
  if (/^"+,{2,}/.test(s)) return true;
  if (/^,{2,}/.test(s) && /(待开发|已开发|需求\s*,\s*高|v\d+\.\d+)/.test(s)) return true;
  // 整行几乎是元数据 CSV，没有【】/编号需求句
  if (
    !/【/.test(s) &&
    !/^\d+[、.]/.test(s) &&
    /,/.test(s) &&
    /(待开发|已关闭|已完成|需求\s*,\s*[高低中]|v\d+\.\d+|^\d{4}年\d{1,2}月)/.test(s)
  ) {
    return true;
  }
  return false;
}

function stripIdealMetaTail(body: string): string {
  let text = String(body ?? '');
  // 正文结束引号紧跟空列 + 元数据
  const q = text.search(/"\s*,{2,}/);
  if (q >= 0) text = text.slice(0, q);
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (isIdealMetaCsvLine(line)) break;
    // 行内夹带：`……操作记录…" ,,,,于赟,...`
    const inline = line.search(/"\s*,{2,}/);
    if (inline >= 0) {
      kept.push(line.slice(0, inline));
      break;
    }
    kept.push(line);
  }
  return kept.join('\n').replace(/^"/, '').replace(/"$/, '').trim();
}

function finalizeIdealRow(row: IdealReqRow): IdealReqRow {
  const body = stripIdealMetaTail(row.body).slice(0, 4000);
  const bracket = body.match(/【([^】\n]{1,40})】/);
  const title = clampReqName(bracket?.[1] || row.title || row.small);
  return { ...row, title: title || row.small, body: body || `【${title || row.small}】` };
}

/** 标题归一（比较用）：去掉空白、标点、符号 */
function reqNameKey(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 容错 CSV 记录解析：引号包住的多行单元格、`""` 转义都按标准 CSV 处理。
 * Excel `sheet_to_csv` 出来的就是这个形态，逐行正则拆会在「正文里带逗号 / 换行」时错位。
 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      fieldStart = true;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      fieldStart = true;
      continue;
    }
    field += ch;
    fieldStart = false;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') records.push(row);
  return records;
}

/**
 * 同一「小模块」下的多行（Excel 一行一条需求）用正文首句补一个区分词：
 * 标题重复时播种会被按标题合并，24 行只剩几行就是这么丢的。
 */
function idealRowTitleHint(body: string, base: string): string {
  const trimmed = String(body ?? '').trim();
  const head = trimmed.startsWith(`【${base}】`)
    ? trimmed.slice(base.length + 2).trim()
    : trimmed.replace(/^【[^】]{1,40}】/, '').trim();
  const firstLine = head.split('\n').find((line) => line.trim()) ?? '';
  const cut = firstLine.split(/[。；;：:，,、\s]/)[0]?.trim() ?? '';
  return cut.length >= 2 ? clampReqName(cut, 14) : '';
}

/** 逐行给标题去重：基础名（【短名】/小模块）重名时补正文区分词，还重就带序号 */
function disambiguateIdealRowTitles(rows: IdealReqRow[]): IdealReqRow[] {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  return rows.map((row) => {
    const base = row.title || row.small;
    const key = reqNameKey(base);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n === 1 && !used.has(key)) {
      used.add(key);
      return row;
    }
    const hint = idealRowTitleHint(row.body, base);
    let seq = n;
    let title = clampReqName(hint ? `${base} · ${hint}` : `${base}（${seq}）`);
    while (used.has(reqNameKey(title))) {
      seq += 1;
      title = clampReqName(hint ? `${base} · ${hint}（${seq}）` : `${base}（${seq}）`);
    }
    used.add(reqNameKey(title));
    return { ...row, title };
  });
}

/** 一段表格文本（CSV 或 Markdown/Word 的 `a | b | c` 行）里找表头并返回数据记录 */
function idealTableRecords(body: string): string[][] {
  const isHeader = (rec: string[]): boolean =>
    /大模块/.test(rec[0] ?? '') && /小模块/.test(rec[1] ?? '');
  const csv = parseCsvRecords(body);
  const csvAt = csv.findIndex(isHeader);
  if (csvAt >= 0) return csv.slice(csvAt + 1);
  // Word 表格抽出来是 `大模块 | 小模块 | 优化/问题内容`：同一列语义，按 `|` 切
  const piped = body
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split(/\s*\|\s*/)
        .map((cell) => cell.trim()),
    )
    .filter((rec) => rec.length >= 2);
  const pipeAt = piped.findIndex(isHeader);
  return pipeAt >= 0 ? piped.slice(pipeAt + 1) : [];
}

/**
 * Ideal 表按行抽大模块/小模块/正文（只保留「优化/问题内容」列）。
 * **一行一条需求**：同一小模块下的多行不再合并（Excel 里每行就是一条需求）。
 * 多行单元格按 CSV 规则解析，正文里的逗号 / 换行不会截断；Word 表格（` | ` 分隔）同样支持。
 */
function parseIdealReqRows(content: string): IdealReqRow[] {
  const text = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text) return [];
  const rows: IdealReqRow[] = [];
  // 抽取时每个工作表前有 `## 名称`：记录不跨表，逐表解析
  for (const section of text.split(/^(?=##\s+)/m)) {
    const body = section.replace(/^##\s+.*\n?/, '');
    if (!/大模块/.test(body) || !/小模块/.test(body)) continue;
    for (const rec of idealTableRecords(body)) {
      const big = (rec[0] ?? '').trim();
      const small = (rec[1] ?? '').trim();
      const cell = (rec[2] ?? '').trim();
      if (!small || small === '小模块' || big === '大模块') continue;
      // 小模块列写着整段正文的行是错位的续行，丢掉
      if (/[。；;]/.test(small) || small.length > 40) continue;
      if (!cell) continue;
      rows.push(finalizeIdealRow({ big, small, title: small, body: cell }));
    }
  }
  return disambiguateIdealRowTitles(rows);
}

/** 从需求正文切出文档级条目（Ideal 行 / 章节），供 outline 父级播种 */
export interface DocOutlineEntry {
  title: string;
  body: string;
  quote: string;
}

/**
 * 按需求文档结构抽条目：Ideal 小模块行优先，否则 Markdown ##/### 章节。
 * 不做查询/修改拆分——子点由拆解在父级下补。
 */
export function extractDocOutlineEntries(content: string): DocOutlineEntry[] {
  const ideal = parseIdealReqRows(content);
  if (ideal.length) {
    return ideal.map((row) => ({
      // 一行一条：用该行自己的标题（【短名】/小模块 + 区分词），不再按小模块合并
      title: row.title || row.small,
      body: row.body || `【${row.title || row.small}】`,
      quote: (row.body || row.title || row.small).replace(/\s+/g, ' ').slice(0, 80),
    }));
  }

  const text = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return [];

  const sections: DocOutlineEntry[] = [];
  const skip = /^(概述|简介|目录|修订|附录|背景|术语|参考)/;
  // **按最深一级标题切**：文档里 `## 模块` + `### 需求条目` 并存时，只取 ### 那层，
  // 否则每个模块标题也会播成一条没有正文的需求（Word 文档这种结构最常见）。
  const levels = [...text.matchAll(/^(#{2,3})\s+\S/gm)].map((m) => m[1]!.length);
  const depth = levels.includes(3) ? 3 : 2;
  const parts = text.split(new RegExp(`(?=^#{${depth}}\\s+)`, 'm')).filter((p) => p.trim());
  if (parts.length > 1 || new RegExp(`^#{${depth}}\\s+`, 'm').test(text)) {
    for (const part of parts) {
      const hm = part.match(new RegExp(`^#{${depth}}\\s+(.+?)\\s*$`, 'm'));
      if (!hm) continue;
      const title = clampReqName(hm[1] ?? '');
      if (!title || title.length > 40 || skip.test(title)) continue;
      const body = part
        .replace(new RegExp(`^#{${depth}}\\s+.+?\\s*\\n?`), '')
        .trim()
        .slice(0, 4000);
      if (!body && sections.some((s) => s.title === title)) continue;
      sections.push({
        title,
        body: body || title,
        quote: (body || title).replace(/\s+/g, ' ').slice(0, 80),
      });
    }
    if (sections.length) return dedupeDocEntries(sections);
  }

  const order = extractReqSectionOrder(content);
  return dedupeDocEntries(
    order.map((title) => ({
      title,
      body: title,
      quote: title.slice(0, 80),
    })),
  );
}

function dedupeDocEntries(entries: DocOutlineEntry[]): DocOutlineEntry[] {
  const seen = new Set<string>();
  const out: DocOutlineEntry[] = [];
  for (const entry of entries) {
    const key = entry.title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** 把文档条目播成父级 outline（无 kind）；id 形如 RO-E-1 */
export function seedOutlineFromDoc(
  content: string,
  existing: ReqOutlineItem[] = [],
): ReqOutlineItem[] {
  const entries = extractDocOutlineEntries(content);
  if (!entries.length) return existing.filter((item) => !item.kind);
  const byTitle = new Map(
    existing
      .filter((item) => !item.kind && !item.parentId)
      .map((item) => [item.title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''), item]),
  );
  const taken = new Set(existing.map((item) => item.id));
  const parents: ReqOutlineItem[] = [];
  entries.forEach((entry, i) => {
    const key = entry.title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const prev = byTitle.get(key);
    if (prev) {
      parents.push({
        ...prev,
        title: entry.title,
        quote: entry.quote || prev.quote,
        body: entry.body || prev.body,
        kind: undefined,
        parentId: undefined,
      });
      return;
    }
    let id = `RO-E-${i + 1}`;
    let n = 1;
    while (taken.has(id)) id = `RO-E-${i + 1}-${n++}`;
    taken.add(id);
    parents.push({
      id,
      title: entry.title,
      quote: entry.quote,
      body: entry.body,
    });
  });
  // 保留仍挂在这些父级下的子点
  const parentIds = new Set(parents.map((p) => p.id));
  const children = existing.filter((item) => item.parentId && parentIds.has(item.parentId));
  return [...parents, ...children];
}

/** 覆盖率 / 未覆盖：有子点时只计子点，否则计父级本身 */
export function outlineCoverageItems(outline: readonly ReqOutlineItem[]): ReqOutlineItem[] {
  const children = outline.filter((item) => item.kind && item.parentId);
  if (children.length) return children;
  return outline.filter((item) => !item.parentId);
}

/** 尚未被任何故事 sourceRefs 挂上的覆盖目标 */
export function uncoveredOutlineItems(
  outline: readonly ReqOutlineItem[],
  stories: readonly ReqStory[],
): ReqOutlineItem[] {
  const referenced = new Set(stories.flatMap((story) => story.sourceRefs));
  return outlineCoverageItems(outline).filter((item) => !referenced.has(item.id));
}

export interface StoryGenOutlineBatch {
  /** 所属文档条目；孤儿覆盖目标时为空 */
  parent: ReqOutlineItem | null;
  /** 本批必须挂上 sourceRefs 的覆盖目标 */
  mustCover: ReqOutlineItem[];
}

/**
 * 按父级把覆盖目标切成生成批次；同一父级子点超过 maxPerBatch 时再切开。
 * 用于「按需求点驱动」生成用户故事。
 */
export function batchOutlineForStoryGen(
  outline: readonly ReqOutlineItem[],
  maxPerBatch = 12,
): StoryGenOutlineBatch[] {
  const cap = Math.max(1, Math.floor(maxPerBatch) || 12);
  const targets = outlineCoverageItems(outline);
  if (!targets.length) return [];

  const parents = outline.filter((item) => !item.parentId && !item.kind);
  const parentById = new Map(parents.map((p) => [p.id, p]));
  const byParent = new Map<string, ReqOutlineItem[]>();
  const orphans: ReqOutlineItem[] = [];

  for (const item of targets) {
    const pid = item.parentId || '';
    if (pid && parentById.has(pid)) {
      const list = byParent.get(pid) ?? [];
      list.push(item);
      byParent.set(pid, list);
    } else {
      orphans.push(item);
    }
  }

  const batches: StoryGenOutlineBatch[] = [];
  const pushChunks = (parent: ReqOutlineItem | null, items: ReqOutlineItem[]) => {
    for (let i = 0; i < items.length; i += cap) {
      batches.push({ parent, mustCover: items.slice(i, i + cap) });
    }
  };

  for (const parent of parents) {
    const kids = byParent.get(parent.id);
    if (kids?.length) pushChunks(parent, kids);
  }
  if (orphans.length) pushChunks(null, orphans);
  return batches;
}

export interface OutlineParentGroup {
  parent: ReqOutlineItem;
  points: ReqOutlineItem[];
  coveredCount: number;
  totalPoints: number;
  coveringStories: ReqStory[];
}

/** 子点摘录在父级原文中的位置；对不上返回很大的数，便于排到后面 */
export function outlineExcerptIndex(parentBody: string, point: ReqOutlineItem): number {
  const body = String(parentBody ?? '');
  if (!body) return Number.MAX_SAFE_INTEGER;
  // 与展开原文共用定位：忽略换行/空格差异（模型 quote 常压成一行）
  const start = locatePointInParentBody(point, body);
  return start >= 0 ? start : Number.MAX_SAFE_INTEGER;
}

/** 同一父级下的子点按原文出现序排序（稳定） */
export function sortPointsByParentBody(
  parent: ReqOutlineItem,
  points: readonly ReqOutlineItem[],
): ReqOutlineItem[] {
  if (points.length <= 1) return [...points];
  const body = parent.body || parent.quote || '';
  return [...points]
    .map((p, index) => ({ p, index, rank: outlineExcerptIndex(body, p) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index))
    .map((x) => x.p);
}

/** 同父级子点序号 id：`{parentId}-{n}`（n 从 1 起） */
export function childPointId(parentId: string, index1: number): string {
  return `${parentId}-${index1}`;
}

/** 同 parentId 子点（保留 outline 出现序） */
export function siblingsOfParent(
  outline: readonly ReqOutlineItem[],
  parentId: string,
): ReqOutlineItem[] {
  return outline.filter((item) => item.parentId === parentId);
}

/**
 * 把某父级下的子点换成给定顺序，并重编号为 `{parentId}-1..n`。
 * 返回 oldId→newId；临时占位 id（`__new_` 前缀）不进映射。
 */
export function rewriteParentChildren(
  outline: readonly ReqOutlineItem[],
  parentId: string,
  orderedChildren: readonly ReqOutlineItem[],
): { outline: ReqOutlineItem[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const renumbered: ReqOutlineItem[] = orderedChildren.map((child, i) => {
    const newId = childPointId(parentId, i + 1);
    const oldId = child.id;
    if (oldId && !oldId.startsWith('__new_') && oldId !== newId) {
      idMap.set(oldId, newId);
    }
    const next: ReqOutlineItem = {
      id: newId,
      title: child.title,
      quote: child.quote,
      kind: child.kind,
      parentId,
    };
    if (child.body) next.body = child.body;
    return next;
  });
  const without = outline.filter((item) => item.parentId !== parentId);
  const parentIdx = without.findIndex((item) => item.id === parentId);
  const nextOutline =
    parentIdx < 0
      ? [...without, ...renumbered]
      : [...without.slice(0, parentIdx + 1), ...renumbered, ...without.slice(parentIdx + 1)];
  return { outline: nextOutline, idMap };
}

/** 按原文出现序排好某父级子点并顺延编号 */
export function normalizeParentChildrenByDocOrder(
  outline: readonly ReqOutlineItem[],
  parent: ReqOutlineItem,
): { outline: ReqOutlineItem[]; idMap: Map<string, string> } {
  const siblings = siblingsOfParent(outline, parent.id);
  if (!siblings.length) return { outline: [...outline], idMap: new Map() };
  const ordered = sortPointsByParentBody(parent, siblings);
  return rewriteParentChildren(outline, parent.id, ordered);
}

/** 所有文档父级：按原文序 + `{parentId}-{n}` 顺延 */
export function normalizeAllOutlineChildrenByDocOrder(outline: readonly ReqOutlineItem[]): {
  outline: ReqOutlineItem[];
  idMap: Map<string, string>;
} {
  let current = [...outline];
  const idMap = new Map<string, string>();
  const parents = current.filter((item) => !item.parentId && !item.kind);
  for (const parent of parents) {
    const result = normalizeParentChildrenByDocOrder(current, parent);
    current = result.outline;
    for (const [from, to] of result.idMap) idMap.set(from, to);
  }
  return { outline: current, idMap };
}

export type OutlinePointDraft = {
  title: string;
  kind: ReqOutlineKind;
  quote: string;
  body?: string;
};

/**
 * 旧式 RO-{batch}-{n} 先按原文序收成 `{parentId}-{n}`，再做插删。
 * 返回规范化后的 outline、锚点当前 id，以及累计 idMap。
 */
function ensureParentLocalIds(
  outline: readonly ReqOutlineItem[],
  pointId: string,
): {
  outline: ReqOutlineItem[];
  pointId: string;
  idMap: Map<string, string>;
  parentId: string;
  error?: string;
} {
  const anchor = outline.find((item) => item.id === pointId);
  if (!anchor?.parentId || !anchor.kind) {
    return {
      outline: [...outline],
      pointId,
      idMap: new Map(),
      parentId: '',
      error: '必须是已有的查询/修改子点',
    };
  }
  const parent = outline.find(
    (item) => item.id === anchor.parentId && !item.parentId && !item.kind,
  );
  if (!parent) {
    return {
      outline: [...outline],
      pointId,
      idMap: new Map(),
      parentId: anchor.parentId,
      error: '找不到所属需求条目',
    };
  }
  const siblings = siblingsOfParent(outline, parent.id);
  const alreadyLocal = siblings.every((p) => p.id.startsWith(`${parent.id}-`));
  if (alreadyLocal) {
    return { outline: [...outline], pointId, idMap: new Map(), parentId: parent.id };
  }
  const normalized = normalizeParentChildrenByDocOrder(outline, parent);
  const nextPointId = normalized.idMap.get(pointId) ?? pointId;
  return {
    outline: normalized.outline,
    pointId: nextPointId,
    idMap: normalized.idMap,
    parentId: parent.id,
  };
}

/** 合并两步编号映射为「旧 id → 最终 id」；单次查找即可，勿再追链 */
function mergeIdMaps(a: Map<string, string>, b: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [from, to] of a) {
    out.set(from, b.get(to) ?? to);
  }
  for (const [from, to] of b) {
    if (!out.has(from)) out.set(from, to);
  }
  return out;
}

/** 在指定子点下方插入新子点，同父级序号顺延 */
export function insertOutlineAfter(
  outline: readonly ReqOutlineItem[],
  afterId: string,
  drafts: readonly OutlinePointDraft[],
): { outline: ReqOutlineItem[]; idMap: Map<string, string>; addedIds: string[]; error?: string } {
  const prepared = ensureParentLocalIds(outline, afterId);
  if (prepared.error) {
    return {
      outline: [...outline],
      idMap: new Map(),
      addedIds: [],
      error: prepared.error.includes('必须是')
        ? 'afterId 必须是已有的查询/修改子点'
        : prepared.error,
    };
  }
  if (!drafts.length) {
    return { outline: prepared.outline, idMap: prepared.idMap, addedIds: [] };
  }
  const parentId = prepared.parentId;
  const siblings = siblingsOfParent(prepared.outline, parentId);
  const idx = siblings.findIndex((item) => item.id === prepared.pointId);
  if (idx < 0) {
    return {
      outline: prepared.outline,
      idMap: prepared.idMap,
      addedIds: [],
      error: '找不到锚点子点',
    };
  }
  const placeholders: ReqOutlineItem[] = drafts.map((draft, i) => {
    const item: ReqOutlineItem = {
      id: `__new_${i}`,
      title: draft.title,
      quote: draft.quote,
      kind: draft.kind,
      parentId,
    };
    if (draft.body) item.body = draft.body;
    return item;
  });
  const nextSiblings = [...siblings.slice(0, idx + 1), ...placeholders, ...siblings.slice(idx + 1)];
  const rewritten = rewriteParentChildren(prepared.outline, parentId, nextSiblings);
  const addedIds = drafts.map((_, i) => childPointId(parentId, idx + 2 + i));
  return {
    outline: rewritten.outline,
    idMap: mergeIdMaps(prepared.idMap, rewritten.idMap),
    addedIds,
  };
}

/** 删除子点后同父级序号顺延 */
export function removeOutlinePoint(
  outline: readonly ReqOutlineItem[],
  pointId: string,
): {
  outline: ReqOutlineItem[];
  idMap: Map<string, string>;
  removedId: string;
  removedIds: Set<string>;
  error?: string;
} {
  const prepared = ensureParentLocalIds(outline, pointId);
  if (prepared.error) {
    return {
      outline: [...outline],
      idMap: new Map(),
      removedId: pointId,
      removedIds: new Set([pointId]),
      error: prepared.error.includes('必须是') ? '只能删除查询/修改子点' : prepared.error,
    };
  }
  const parentId = prepared.parentId;
  const removedId = prepared.pointId;
  // 被删点的所有旧 id（含规范化前）；不可与 survivor 新号混用同一 removed 判断
  const removedIds = new Set<string>([pointId, removedId]);
  for (const [from, to] of prepared.idMap) {
    if (to === removedId || from === removedId) removedIds.add(from);
  }
  const nextSiblings = siblingsOfParent(prepared.outline, parentId).filter(
    (item) => item.id !== removedId,
  );
  const rewritten = rewriteParentChildren(prepared.outline, parentId, nextSiblings);
  const survivorPrepare = new Map(
    [...prepared.idMap].filter(([from, to]) => !removedIds.has(from) && !removedIds.has(to)),
  );
  return {
    outline: rewritten.outline,
    idMap: mergeIdMaps(survivorPrepare, rewritten.idMap),
    removedId,
    removedIds,
  };
}

/** 修改子点标题 / 类型 / 原文（quote / body），id 不变 */
export function updateOutlinePointText(
  outline: readonly ReqOutlineItem[],
  pointId: string,
  patch: { quote: string; body?: string; title?: string; kind?: ReqOutlineKind },
): { outline: ReqOutlineItem[]; error?: string } {
  const idx = outline.findIndex((item) => item.id === pointId);
  if (idx < 0) return { outline: [...outline], error: '找不到需求点' };
  const current = outline[idx]!;
  if (!current.parentId || !current.kind) {
    return { outline: [...outline], error: '只能修改查询/修改子点的原文' };
  }
  if (patch.kind && patch.kind !== 'query' && patch.kind !== 'mutate') {
    return { outline: [...outline], error: 'kind 只能是 query 或 mutate' };
  }
  const next = [...outline];
  const updated: ReqOutlineItem = {
    ...current,
    quote: patch.quote,
  };
  if (patch.title !== undefined && patch.title.trim()) {
    updated.title = patch.title.trim();
  }
  if (patch.kind) updated.kind = patch.kind;
  if (patch.body !== undefined) {
    if (patch.body) updated.body = patch.body;
    else delete updated.body;
  }
  next[idx] = updated;
  return { outline: next };
}

/**
 * 按 id 映射改写故事 / 缺口引用。
 * removed 中的 id 直接摘掉；其余单次查 idMap（映射须已是旧→最终号）。
 * 删除顺延时后继会占用被删旧号，故不对映射结果再判 removed。
 */
export function remapOutlineRefs<
  T extends {
    stories: ReqStory[];
    check: ReqCheckReport | null;
    ignoredGaps?: ReqIgnoredGap[];
  },
>(doc: T, idMap: ReadonlyMap<string, string>, removed: ReadonlySet<string> = new Set()): T {
  if (!idMap.size && !removed.size) return doc;
  const mapRef = (id: string): string | null => {
    if (removed.has(id)) return null;
    return idMap.get(id) ?? id;
  };
  const mapList = (ids: string[]): string[] =>
    uniq(ids.map(mapRef).filter((id): id is string => Boolean(id)));

  const stories = doc.stories.map((story) => ({
    ...story,
    sourceRefs: mapList(story.sourceRefs),
  }));
  const mapGap = <G extends ReqGap>(gap: G): G => {
    if (!gap.outlineId) return gap;
    const nextId = mapRef(gap.outlineId);
    if (nextId === gap.outlineId) return gap;
    if (nextId == null) return { ...gap, outlineId: undefined };
    return { ...gap, outlineId: nextId };
  };
  const check = doc.check ? { ...doc.check, gaps: doc.check.gaps.map(mapGap) } : doc.check;
  const ignoredGaps = doc.ignoredGaps?.map(mapGap);
  return { ...doc, stories, check, ignoredGaps };
}

/** 条目 Tab：按文档父级分组；组内子点跟 outline 出现序（权威顺序，插删后已顺延编号） */
export function groupOutlineParents(
  outline: readonly ReqOutlineItem[],
  stories: readonly ReqStory[] = [],
): OutlineParentGroup[] {
  const parents = outline.filter((item) => !item.parentId && !item.kind);
  const orphans = outline.filter((item) => item.kind && !item.parentId);
  const referenced = new Set(stories.flatMap((s) => s.sourceRefs));
  const byParent = new Map<string, ReqOutlineItem[]>();
  for (const item of outline) {
    if (!item.parentId) continue;
    const list = byParent.get(item.parentId) ?? [];
    list.push(item);
    byParent.set(item.parentId, list);
  }
  const groups: OutlineParentGroup[] = parents.map((parent) => {
    // 权威顺序 = outline 出现序；旧数据若尚未顺延编号，展示仍按原文出现序兜底
    const raw = byParent.get(parent.id) ?? [];
    const parentLocal = raw.length > 0 && raw.every((p) => p.id.startsWith(`${parent.id}-`));
    const points = parentLocal ? raw : sortPointsByParentBody(parent, raw);
    const targets = points.length ? points : [parent];
    const coveredCount = targets.filter((p) => referenced.has(p.id)).length;
    const coveringStories = stories.filter((s) =>
      s.sourceRefs.some((id) => id === parent.id || points.some((p) => p.id === id)),
    );
    return {
      parent,
      points,
      coveredCount,
      totalPoints: targets.length,
      coveringStories,
    };
  });
  if (orphans.length && !parents.length) {
    // 旧数据：扁平列表，每条自成一组
    for (const item of outline) {
      groups.push({
        parent: item,
        points: item.kind ? [item] : [],
        coveredCount: referenced.has(item.id) ? 1 : 0,
        totalPoints: 1,
        coveringStories: stories.filter((s) => s.sourceRefs.includes(item.id)),
      });
    }
  } else if (orphans.length) {
    const fakeParent: ReqOutlineItem = {
      id: '__orphan__',
      title: '其它需求点',
      quote: '',
      body: '',
    };
    groups.push({
      parent: fakeParent,
      points: orphans,
      coveredCount: orphans.filter((p) => referenced.has(p.id)).length,
      totalPoints: orphans.length,
      coveringStories: stories.filter((s) => orphans.some((p) => s.sourceRefs.includes(p.id))),
    });
  }
  return groups;
}

/** 文档序：父级播种序 + 组内子点出现序 → id → 序号 */
export function outlineDocOrderIndex(outline: readonly ReqOutlineItem[]): Map<string, number> {
  const map = new Map<string, number>();
  let i = 0;
  for (const group of groupOutlineParents(outline)) {
    if (!map.has(group.parent.id)) map.set(group.parent.id, i++);
    for (const point of group.points) {
      if (!map.has(point.id)) map.set(point.id, i++);
    }
  }
  return map;
}

/** 生成测试点：单点子点原文上限（优先 body，否则 quote） */
const TEST_POINTS_OUTLINE_EXCERPT_MAX = 500;
/** 生成测试点：需求点块总字符硬顶 */
const TEST_POINTS_OUTLINE_BLOCK_MAX = 12_000;

/**
 * 拼进「生成测试点」user：按文档条目分组列出查/改需求点 + 短原文。
 * 超总长时先保标题行，再截各点原文。
 */
export function formatOutlinePointsForTestPoints(
  outline: readonly ReqOutlineItem[],
  opts?: { excerptMax?: number; blockMax?: number },
): string {
  if (!outline.length) return '（无需求点）';
  const excerptMax = Math.max(40, opts?.excerptMax ?? TEST_POINTS_OUTLINE_EXCERPT_MAX);
  const blockMax = Math.max(40, opts?.blockMax ?? TEST_POINTS_OUTLINE_BLOCK_MAX);
  const groups = groupOutlineParents(outline);
  if (!groups.length) return '（无需求点）';

  type Row = { kind: 'parent' | 'empty' | 'point' | 'excerpt'; text: string; shrinkable: boolean };
  const rows: Row[] = [];
  for (const group of groups) {
    const parentLabel =
      group.parent.id === '__orphan__'
        ? `- ${group.parent.title}`
        : `- ${group.parent.id} ${group.parent.title}`;
    rows.push({ kind: 'parent', text: parentLabel, shrinkable: false });
    if (!group.points.length) {
      rows.push({ kind: 'empty', text: '  （尚无查/改子点）', shrinkable: false });
      continue;
    }
    for (const point of group.points) {
      const kindLabel = point.kind === 'query' ? '查询' : point.kind === 'mutate' ? '修改' : '子点';
      rows.push({
        kind: 'point',
        text: `  - ${point.id} [${kindLabel}] ${point.title}`,
        shrinkable: false,
      });
      const raw = (point.body || point.quote || '').replace(/\s+/g, ' ').trim();
      if (raw) {
        const clipped = raw.length > excerptMax ? `${raw.slice(0, excerptMax).trimEnd()}…` : raw;
        rows.push({ kind: 'excerpt', text: `    原文：${clipped}`, shrinkable: true });
      }
    }
  }

  const joinRows = (list: Row[]) => list.map((r) => r.text).join('\n');
  const cap = (text: string) => (text.length <= blockMax ? text : text.slice(0, blockMax));
  let out = joinRows(rows);
  if (out.length <= blockMax) return out;

  // 超长：逐步缩短原文行，仍超则丢掉原文，最后硬顶
  const next = rows.map((row) => ({ ...row }));
  for (let pass = 0; pass < 3 && joinRows(next).length > blockMax; pass++) {
    const budget = Math.max(40, Math.floor(excerptMax / (pass + 2)));
    for (let i = 0; i < next.length; i++) {
      const row = next[i]!;
      if (!row.shrinkable || row.kind !== 'excerpt') continue;
      const body = row.text.replace(/^ {4}原文：/, '');
      if (body.length <= budget) continue;
      next[i] = {
        ...row,
        text: `    原文：${body.slice(0, budget).trimEnd()}…`,
      };
    }
  }
  out = joinRows(next);
  if (out.length <= blockMax) return out;
  return cap(joinRows(next.filter((row) => !row.shrinkable)));
}

/** 故事按首个 sourceRefs 的文档序排；无来源靠后（稳定） */
export function sortStoriesByOutlineDocOrder(
  stories: readonly ReqStory[],
  outline: readonly ReqOutlineItem[],
): ReqStory[] {
  if (stories.length <= 1) return [...stories];
  const order = outlineDocOrderIndex(outline);
  const rank = (story: ReqStory): number => {
    if (!story.sourceRefs.length) return Number.MAX_SAFE_INTEGER;
    let best = Number.MAX_SAFE_INTEGER;
    for (const id of story.sourceRefs) {
      const r = order.get(id);
      if (r != null && r < best) best = r;
    }
    return best;
  };
  return [...stories]
    .map((s, index) => ({ s, index, r: rank(s) }))
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.index - b.index))
    .map((x) => x.s);
}

export function outlineTitleById(outline: readonly ReqOutlineItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of outline) {
    const kindLabel = item.kind === 'query' ? '查询' : item.kind === 'mutate' ? '修改' : '';
    map.set(item.id, kindLabel ? `${item.title}（${kindLabel}）` : item.title);
  }
  return map;
}

/** 展示 / 导出用：`RO-id 标题（查询）` */
export function outlineLabelById(outline: readonly ReqOutlineItem[]): Map<string, string> {
  const titles = outlineTitleById(outline);
  const map = new Map<string, string>();
  for (const item of outline) {
    const title = titles.get(item.id) || item.title;
    map.set(item.id, `${item.id} ${title}`.trim());
  }
  return map;
}

export function formatSourceRefsLabel(
  refs: readonly string[],
  outline: readonly ReqOutlineItem[],
): string {
  if (!refs.length) return '';
  const labels = outlineLabelById(outline);
  return refs.map((id) => labels.get(id) || id).join('；');
}

const EXCERPT_EXPAND_MAX = 2000;
/** 短 quote 扩写时单点最多取这么长，避免吞掉后面兄弟子点的原文 */
const EXCERPT_POINT_MAX = 800;

/** 把「去掉空白后的下标」映射回原文下标（quote 常被压成一行，父级 body 仍有换行） */
function mapCompactIndexToBody(body: string, compactIndex: number): number {
  let compact = 0;
  for (let i = 0; i < body.length; i++) {
    if (/\s/.test(body[i]!)) continue;
    if (compact === compactIndex) return i;
    compact += 1;
  }
  return -1;
}

/** 去空白后的针在 compactBody 中唯一时，映射回原文下标 */
function uniqueCompactIndexToBody(
  body: string,
  compactBody: string,
  compactNeedle: string,
): number {
  if (!compactNeedle || compactNeedle.length < 4) return -1;
  const first = compactBody.indexOf(compactNeedle);
  if (first < 0) return -1;
  if (compactBody.indexOf(compactNeedle, first + compactNeedle.length) >= 0) return -1;
  return mapCompactIndexToBody(body, first);
}

/** 在父级原文中定位子点摘录起点；找不到返回 -1 */
export function locateQuoteInParentBody(quote: string, parentBody: string): number {
  const q = String(quote ?? '').trim();
  const body = String(parentBody ?? '');
  if (!q || !body) return -1;

  let start = body.indexOf(q);
  const compactQ = q.replace(/\s+/g, '');
  const compactBody = body.replace(/\s+/g, '');

  // 整段去空白匹配（短 quote / 压成一行的长 quote）；多命中时不用，避免钉错段
  if (start < 0 && compactQ) {
    start = uniqueCompactIndexToBody(body, compactBody, compactQ);
  }

  // 前缀降级：长摘录常因 OCR/续行对不上整段，用逐步缩短的针；短针须唯一
  if (start < 0) {
    const minNeedle = Math.min(4, compactQ.length);
    for (const len of [64, 48, 32, 24, 16, 12, 8, 4]) {
      if (len < minNeedle) continue;
      const requireUnique = len <= 8;
      if (q.length >= len) {
        const rawNeedle = q.slice(0, len);
        const hit = requireUnique ? uniqueIndexOf(body, rawNeedle) : body.indexOf(rawNeedle);
        if (hit >= 0) {
          start = hit;
          break;
        }
      }
      const compactNeedle = compactQ.slice(0, Math.min(len, compactQ.length));
      if (compactNeedle.length < minNeedle) continue;
      const mapped = requireUnique
        ? uniqueCompactIndexToBody(body, compactBody, compactNeedle)
        : (() => {
            const ci = compactBody.indexOf(compactNeedle);
            return ci >= 0 ? mapCompactIndexToBody(body, ci) : -1;
          })();
      if (mapped >= 0) {
        start = mapped;
        break;
      }
    }
  }

  // 【章节标题】：仅当 】后几乎没有实质正文时才用段首；否则会把「排序」等点钉到章首、排到预览前
  if (start < 0) {
    const section = /^(【[^】]{2,30}】)/u.exec(q);
    if (section) {
      const after = q.slice(section[0].length).replace(/\s+/g, '');
      if (after.length < 4) {
        start = body.indexOf(section[1]!);
      }
    }
  }

  if (start < 0) return -1;
  const lookBehind = body.slice(Math.max(0, start - 80), start);
  const lineStart = lookBehind.lastIndexOf('\n');
  if (lineStart >= 0) start = start - (lookBehind.length - lineStart - 1);
  return start;
}

/** 针在全文只出现一次才采纳，避免「树状展示」等公共词把多点钉到同一处 */
function uniqueIndexOf(haystack: string, needle: string): number {
  if (!needle || needle.length < 4) return -1;
  const first = haystack.indexOf(needle);
  if (first < 0) return -1;
  if (haystack.indexOf(needle, first + needle.length) >= 0) return -1;
  return first;
}

/** 标题回退用的候选针：整题 → 按与/、/及拆段 → 尾缀，长针优先 */
function titleLocateNeedles(title: string): string[] {
  let t = String(title ?? '')
    .replace(/[（(]?(查询|修改)[)）]?$/u, '')
    .replace(/^(政企通页面管理|政企通)/, '')
    .trim();
  if (!t) return [];
  const parts = t
    .split(/[与、及]/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  const raw = [t, ...parts];
  if (t.length > 12) raw.push(t.slice(-12));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of raw) {
    if (seen.has(n) || n.length < 4) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

function locatePointInParentBody(point: ReqOutlineItem, parentBody: string): number {
  const byQuote = locateQuoteInParentBody(point.quote || point.body || '', parentBody);
  if (byQuote >= 0) return byQuote;
  for (const needle of titleLocateNeedles(point.title ?? '')) {
    const i = uniqueIndexOf(parentBody, needle);
    if (i >= 0) return i;
  }
  return -1;
}

/** 从 start 起找本点段落结束：章节标题 / 分隔线；空行后若不再是编号续行也停 */
function findPointSegmentEnd(body: string, start: number, endCap: number): number {
  // 本点从编号项起头 → 下一项编号即边界（一项一点；无兄弟子点时也不吞 4、）
  const startsWithNumber = /^\d+[、.]/.test(
    body.slice(start, Math.min(body.length, start + 24)).trimStart(),
  );
  let i = start;
  while (i < endCap) {
    const nl = body.indexOf('\n', i);
    if (nl < 0 || nl >= endCap) return endCap;
    let j = nl + 1;
    while (j < endCap && (body[j] === '\n' || body[j] === '\r' || body[j] === ' ')) j += 1;
    if (j >= endCap) return nl;
    const next = body.slice(j, Math.min(endCap, j + 40));
    // 明确章节边界
    if (/^【|^#{2,3}\s|^-{3,}/.test(next)) return nl;
    if (startsWithNumber && /^\d+[、.]/.test(next)) return nl;
    // 空行后换话题（非编号续行）→ 本点结束
    if (j > nl + 1 && !/^\d+[、.]/.test(next)) return nl;
    i = nl + 1;
  }
  return endCap;
}

/**
 * 硬切点是否落在「导语/整表能力 → 下一编号」之间（允许软扩重叠）。
 * 本点已从编号项起头、下一点也是编号项时返回 false：按项硬切（按钮/字段通用）。
 */
function cutsMidNumberedList(body: string, start: number, endBefore: number): boolean {
  if (endBefore <= start || endBefore >= body.length) return false;
  const head = body.slice(start, endBefore);
  const tail = body.slice(endBefore, Math.min(body.length, endBefore + 48)).trimStart();
  if (!/^\d+[、.]/.test(tail)) return false;
  // 1、暂存 | 2、发给承办 —— 各点各一条，硬切
  if (/^\d+[、.]/.test(head.trimStart())) return false;
  // 本段已含编号但未以编号起头（整表 quote 含 1、被从 2、切开）→ 软扩
  if (/\d+[、.]/.test(head)) return true;
  // 列表导语后紧接编号（如「下面分：」|「1、…」）
  const lastLine = head.trimEnd().split(/\n/).pop()?.trim() ?? '';
  return /下面分|如下|包括|分别为|计有|默认字段/u.test(lastLine) || /[：:）)]\s*$/u.test(lastLine);
}

/**
 * 在父级原文里把短 quote 扩成连续切片。
 * - opts.endBefore：切到下一个兄弟子点之前（按文档序各点各一段）
 * - 若硬切落在连续编号列表中间（如「五个子菜单」被下一点从「2、」切开），
 *   允许与下一点原文重叠，扩到段落/章节边界
 * - 否则：扩到段落/章节边界，最多 max 字；短 quote 不再吞掉后面大段
 */
export function expandQuoteInParentBody(
  quote: string,
  parentBody: string,
  max = EXCERPT_EXPAND_MAX,
  opts?: { endBefore?: number },
): string {
  const body = String(parentBody ?? '');
  const start = locateQuoteInParentBody(quote, body);
  if (start < 0) return '';

  const softCap = Math.min(body.length, start + max);
  const endBefore = opts?.endBefore != null && opts.endBefore > start ? opts.endBefore : undefined;

  // 有明确下一点边界时优先硬切；编号列表中途除外（允许重叠）
  // 硬切终点还要按【/--- 段首收紧，避免下一点在下一章字段上时把【首页】等段标题切进来
  if (endBefore != null && !cutsMidNumberedList(body, start, endBefore)) {
    const segEnd = findPointSegmentEnd(body, start, Math.min(softCap, endBefore));
    return body.slice(start, Math.min(softCap, endBefore, segEnd)).trim();
  }

  const end = findPointSegmentEnd(body, start, softCap);
  return body.slice(start, Math.max(end, start + 1)).trim();
}

/**
 * 在父级正文中按「本点起点 → 下一点 / 段落边界」裁一段展示原文。
 * 有 endBefore 时优先硬切（编号列表中途除外，走软扩）。
 */
function slicePointInParentBody(
  parentBody: string,
  selfStart: number,
  endBefore: number | undefined,
): string {
  const softCap = Math.min(parentBody.length, selfStart + EXCERPT_POINT_MAX);
  let end = endBefore != null ? Math.min(softCap, endBefore) : softCap;
  if (endBefore != null && cutsMidNumberedList(parentBody, selfStart, endBefore)) {
    end = findPointSegmentEnd(parentBody, selfStart, softCap);
  } else {
    end = findPointSegmentEnd(parentBody, selfStart, end);
  }
  return parentBody.slice(selfStart, end).trim();
}

/**
 * 本点 body 若已吞进下一兄弟的 quote/首行，裁到该处之前。
 * 「变更需求点」改过的短 body 不含下一点时原样返回，页面才能立刻看到修改。
 */
function trimOwnBodyByNextSibling(
  ownBody: string,
  point: ReqOutlineItem,
  peers: readonly ReqOutlineItem[],
  starts: readonly { id: string; start: number }[],
  selfStart: number,
): string {
  if (!ownBody || selfStart < 0 || !starts.length) return ownBody;
  const after = starts
    .filter((s) => s.id !== point.id && s.start > selfStart)
    .sort((a, b) => a.start - b.start);
  const nextId = after[0]?.id;
  if (!nextId) return ownBody;
  const next = peers.find((p) => p.id === nextId);
  if (!next) return ownBody;
  const needles = [
    (next.quote || '').trim(),
    (next.body || '').trim().split(/\n/)[0]?.trim() || '',
  ].filter((n) => n.length >= 4);
  for (const needle of needles) {
    const idx = ownBody.indexOf(needle);
    if (idx > 0) return ownBody.slice(0, idx).trim();
    const firstLine = needle.split(/\n/)[0]?.trim() || '';
    if (firstLine.length >= 4 && firstLine !== needle) {
      const i2 = ownBody.indexOf(firstLine);
      if (i2 > 0) return ownBody.slice(0, i2).trim();
    }
  }
  return ownBody;
}

/**
 * 子点展开原文：有本点 body 时优先展示（变更需求点保存后立刻可见）；
 * 仅当 body 明显吞到下一兄弟 quote 时才裁切。无 body 时再按父级「本点→下一点」硬切扩写 quote。
 * 不再整段回退父级全文（避免每个点点开都像「父级原文」）。
 */
export function outlinePointExcerpt(
  point: ReqOutlineItem,
  parent?: ReqOutlineItem | null,
  siblings?: readonly ReqOutlineItem[],
): { text: string; fromParent: boolean } {
  const ownBody = (point.body || '').trim();
  const quote = (point.quote || '').trim();
  const parentBody = (parent?.body || parent?.quote || '').trim();
  if (!parentBody) {
    return { text: ownBody || quote || '（无原文切片）', fromParent: false };
  }

  const peers =
    siblings && siblings.length
      ? sortPointsByParentBody(parent ?? { id: '', title: '', quote: '' }, siblings)
      : [];
  const starts = peers.map((p) => ({ id: p.id, start: locatePointInParentBody(p, parentBody) }));
  // 定位优先级：quote → body 前缀 → 标题；避免公共标题词把起点拽到兄弟同一处
  const quoteStart = quote ? locateQuoteInParentBody(quote, parentBody) : -1;
  const bodyStart = ownBody ? locateQuoteInParentBody(ownBody, parentBody) : -1;
  const selfStart =
    quoteStart >= 0
      ? quoteStart
      : bodyStart >= 0
        ? bodyStart
        : locatePointInParentBody(point, parentBody);
  let endBefore: number | undefined;
  if (selfStart >= 0 && starts.length) {
    const after = starts
      .filter((s) => s.id !== point.id && s.start > selfStart)
      .sort((a, b) => a.start - b.start);
    if (after[0]) endBefore = after[0].start;
  }
  const colliding =
    selfStart >= 0 && starts.some((s) => s.id !== point.id && s.start === selfStart);

  // 本点已有 body（含「变更需求点」保存）：优先展示；仅吞兄弟时裁切
  if (ownBody) {
    const text = peers.length
      ? trimOwnBodyByNextSibling(ownBody, point, peers, starts, selfStart)
      : ownBody;
    return { text, fromParent: false };
  }

  // 无 body、有兄弟且能定位到下一点：按父级硬切扩写，避免长 quote 吞并
  if (peers.length && selfStart >= 0 && !colliding && endBefore != null) {
    const trimmed = slicePointInParentBody(parentBody, selfStart, endBefore);
    if (trimmed) {
      return { text: trimmed, fromParent: false };
    }
  }

  if (quote) {
    // 与兄弟定位撞车：不软扩抢同一段，直接用本点 quote，避免标题/正文串台
    if (colliding) {
      return { text: quote, fromParent: false };
    }
    const needExpand = quote.length < 400 || quote.length < parentBody.length * 0.35;
    if (needExpand) {
      const expanded = expandQuoteInParentBody(quote, parentBody, EXCERPT_POINT_MAX, { endBefore });
      if (expanded) {
        // 扩出来仍明显长于 quote 才用；否则直接展示 quote
        if (expanded.length > quote.length || endBefore != null) {
          return { text: expanded, fromParent: false };
        }
      }
    }
    return { text: quote, fromParent: false };
  }

  // 无 quote / body：尝试按标题在父级中切到下一点
  if (selfStart >= 0 && !colliding) {
    const slice = slicePointInParentBody(parentBody, selfStart, endBefore);
    if (slice) return { text: slice, fromParent: false };
  }

  return { text: '（未定位到该需求点对应原文）', fromParent: false };
}

export function gapStableKey(
  gap: Pick<ReqGap, 'type' | 'storyId' | 'title' | 'outlineId'>,
): string {
  const title = keyOf(gap.title ?? '');
  return `${gap.type}|${gap.storyId || ''}|${gap.outlineId || ''}|${title}`;
}

/**
 * 判断两条缺口是否像同一问题（稳定键，或同 type+storyId 且标题规范化后相等/包含）。
 * 用于忽略过滤与复审合并，减轻模型换皮重报。
 */
export function gapsLikelySame(
  a: Pick<ReqGap, 'type' | 'storyId' | 'title' | 'outlineId'>,
  b: Pick<ReqGap, 'type' | 'storyId' | 'title' | 'outlineId'>,
): boolean {
  if (gapStableKey(a) === gapStableKey(b)) return true;
  if (a.type !== b.type) return false;
  if ((a.storyId || '') !== (b.storyId || '')) return false;
  const ta = keyOf(a.title ?? '');
  const tb = keyOf(b.title ?? '');
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer = ta.length <= tb.length ? tb : ta;
  return shorter.length >= 8 && longer.includes(shorter);
}

export function filterIgnoredFromGaps(
  gaps: readonly ReqGap[],
  ignored: readonly ReqIgnoredGap[] | undefined,
): ReqGap[] {
  if (!ignored?.length) return [...gaps];
  return gaps.filter((gap) => !ignored.some((item) => gapsLikelySame(gap, item)));
}

/**
 * 复审落盘：滤掉已忽略（含换皮），并把新结果并回上轮条目（保留 id / 勾选 / 结论 / 标题）。
 * - allowNew:true（初审 / 全量扫描）：以 next 为准（上轮未再报的视为已消失）
 * - allowNew:false（默认复审）：刷新匹配项；未再报的上轮待确认先保留；丢模型新开条；
 *   uncovered-outline 仍可按规则进出
 */
export function reconcileAuditGaps(
  prev: readonly ReqGap[],
  next: readonly ReqGap[],
  ignored?: readonly ReqIgnoredGap[],
  opts?: { allowNew?: boolean },
): { gaps: ReqGap[]; suppressed: number } {
  const allowNew = opts?.allowNew !== false;
  const filtered = filterIgnoredFromGaps(next, ignored);

  const usedPrev = new Set<string>();
  const out: ReqGap[] = [];
  let suppressed = 0;

  const acceptNew = (gap: ReqGap): boolean => {
    if (allowNew) return true;
    return gap.type === 'uncovered-outline';
  };

  for (const gap of filtered) {
    const match = prev.length
      ? prev.find((item) => item.id === gap.id && !usedPrev.has(item.id)) ||
        prev.find((item) => !usedPrev.has(item.id) && gapsLikelySame(item, gap))
      : undefined;
    if (!match) {
      if (!acceptNew(gap)) {
        suppressed += 1;
        continue;
      }
      out.push({ ...gap });
      continue;
    }
    usedPrev.add(match.id);
    out.push({
      ...gap,
      id: match.id,
      title: match.title,
      selected: match.selected || gap.selected,
      conclusion: gap.conclusion?.trim() || match.conclusion,
    });
  }

  if (!allowNew) {
    // 复审：上轮未再报的非「未覆盖」项先保留（模型常漏复述）；未覆盖以本轮规则/模型为准
    for (const item of prev) {
      if (usedPrev.has(item.id)) continue;
      if (item.type === 'uncovered-outline') continue;
      if (ignored?.some((ig) => gapsLikelySame(item, ig))) continue;
      out.push({ ...item });
    }
  }

  return { gaps: out, suppressed };
}

/** 拼进审查 user 消息：上轮待确认 + 已忽略，约束模型复审合并而非换表 */
export function formatAuditHistoryForPrompt(input: {
  pending?: readonly ReqGap[];
  ignored?: readonly ReqIgnoredGap[];
}): string {
  const pending = input.pending ?? [];
  const ignored = input.ignored ?? [];
  if (!pending.length && !ignored.length) return '';

  const lines: string[] = [];
  if (pending.length) {
    lines.push('## 上轮待确认（复审底稿：只更新/收敛，禁止新开条；问题仍在则沿用原 title）');
    for (const gap of pending) {
      lines.push(
        `- id=${gap.id} type=${gap.type} storyId=${gap.storyId || '-'} outlineId=${gap.outlineId || '-'}`,
      );
      lines.push(`  title: ${gap.title}`);
      if (gap.detail?.trim()) lines.push(`  detail: ${gap.detail.trim()}`);
      if (gap.conclusion?.trim()) {
        lines.push(`  conclusion: ${gap.conclusion.trim()}（已有结论待补写，勿另开一条）`);
      }
    }
    lines.push('');
  }
  if (ignored.length) {
    lines.push('## 已忽略（禁止再报同类，不要求标题字面一致）');
    for (const gap of ignored) {
      lines.push(
        `- type=${gap.type} storyId=${gap.storyId || '-'} outlineId=${gap.outlineId || '-'} title: ${gap.title}`,
      );
    }
  }
  return lines.join('\n').trim();
}

/** 故事卡片「待补全」：字段/场景完整性，不进主缺口清单 */
export interface StoryCompletenessHint {
  key: string;
  label: string;
}

export function storyCompletenessHints(story: ReqStory): StoryCompletenessHint[] {
  const hints: StoryCompletenessHint[] = [];
  if (!story.role) hints.push({ key: 'role', label: '缺角色' });
  if (!story.goal) hints.push({ key: 'goal', label: '缺目标' });
  if (!story.preconditions.length) hints.push({ key: 'preconditions', label: '缺前置条件' });
  if (!story.mainFlow.length) hints.push({ key: 'mainFlow', label: '缺主流程' });
  if (!story.sourceRefs.length) hints.push({ key: 'sourceRefs', label: '未挂需求点' });
  if (!story.exceptions.length) hints.push({ key: 'exceptions', label: '缺异常场景' });
  else if (hasWriteAction(story) && story.exceptions.length < 2) {
    hints.push({ key: 'write-exceptions', label: '写操作异常不足' });
  }
  if (!story.altFlows.length && hasWriteAction(story)) {
    hints.push({ key: 'altFlows', label: '缺替代流程' });
  }
  if (!story.acceptance.length) hints.push({ key: 'acceptance', label: '缺验收标准' });
  else if (story.acceptance.some((a) => !a.then)) {
    hints.push({ key: 'acceptance-then', label: '验收缺 then' });
  }
  return hints;
}

/**
 * Ideal 需求表：按行提取「小模块」原文（用例「子模块」应对齐这一列）。
 * 保持表格行序、按小模块去重。
 */
export function extractIdealSmallModules(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of parseIdealReqRows(content)) {
    const key = reqNameKey(row.small);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row.small);
  }
  return out;
}

/**
 * 从 Ideal 原文抽出可再解析的「小模块行序」提示块。
 * 用户故事模式下拼进 reqBlock，让入库排序仍能按 Ideal 小模块，而不是按 US-001…末位。
 */
export function formatIdealSmallModuleOrderBlock(content: string): string {
  const rows = parseIdealReqRows(content);
  if (!rows.length) return '';
  const esc = (s: string) => (/[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    'Ideal 小模块行序（用例「子模块 / 小模块」填下列原文：层级路径取最后一段；最终文件按「需求条目 → 条目内测试点」排序，此序只做兜底）：',
    '大模块,小模块,优化/问题内容',
  ];
  // 用例只有「子模块」一列：按小模块去重保序，同一小模块下的多行不重复出现
  const seenSmall = new Set<string>();
  for (const r of rows) {
    const key = reqNameKey(r.small);
    if (!key || seenSmall.has(key)) continue;
    seenSmall.add(key);
    lines.push(`${esc(r.big)},${esc(r.small)},【${r.title}】`);
  }
  return lines.join('\n');
}

const REQ_SECTION_ORDER_MARK = '需求章节顺序';

/** Markdown / 普通需求文：按 ##、### 标题抽章节名（去重保序） */
export function extractMarkdownSectionTitles(content: string): string[] {
  const text = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return [];
  const titles: string[] = [];
  const seen = new Set<string>();
  const skip = /^(概述|简介|目录|修订|附录|背景|术语|参考)/;
  for (const m of text.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)) {
    const title = clampReqName(m[1] ?? '');
    if (!title || title.length > 40 || skip.test(title) || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return titles;
}

function parseReqSectionOrderStub(content: string): string[] {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  const start = text.indexOf(REQ_SECTION_ORDER_MARK);
  if (start < 0) return [];
  const slice = text.slice(start, start + 4000);
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const m of slice.matchAll(/^\s*\d+[.)、]\s*(.+?)\s*$/gm)) {
    const title = clampReqName(m[1] ?? '');
    if (!title || title.length > 40 || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return titles;
}

/**
 * 需求文档章节顺序（通用）：Ideal 小模块 → 显式「需求章节顺序」块 → 【短名】→ Markdown 二级/三级标题。
 * 用例入库按此序排，适配不同需求格式，不绑死某一业务域。
 */
export function extractReqSectionOrder(content: string): string[] {
  const smalls = extractIdealSmallModules(content);
  if (smalls.length) return smalls;
  const stub = parseReqSectionOrderStub(content);
  if (stub.length) return stub;
  const titles = extractIdealRequirementTitles(content);
  if (titles.length) return titles;
  return extractMarkdownSectionTitles(content);
}

/**
 * 从来源需求正文生成可再解析的「章节顺序」提示块（故事模式注入 reqBlock 用）。
 * Ideal 表优先；否则用【短名】/ Markdown 标题列一版编号清单。
 */
export function formatReqSectionOrderBlock(content: string): string {
  const ideal = formatIdealSmallModuleOrderBlock(content);
  if (ideal) return ideal;
  const order = extractReqSectionOrder(content);
  if (order.length < 2) return '';
  return [
    `${REQ_SECTION_ORDER_MARK}（用例「模块 / 子模块 / 标题」应对齐下列原文；最终文件按此序排列，优先于用户故事 US 编号）：`,
    ...order.map((t, i) => `${i + 1}. ${t}`),
  ].join('\n');
}

/**
 * Ideal 需求表：按行提取需求标题（一行一条）。
 * 优先取该行正文首个【短名】，否则用「小模块」列；保持表格行序、按小模块去重。
 */
export function extractIdealRequirementTitles(content: string): string[] {
  const ideal = parseIdealReqRows(content);
  if (ideal.length) return ideal.map((r) => r.title);

  // 非 Ideal 表：按出现顺序收集【短名】，去重
  const text = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/【([^】\n]{1,40})】/g)) {
    const title = clampReqName(m[1] ?? '');
    if (!title || title.length > 24 || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return titles;
}

/** 当前标题是否还停在「文件名」上（用户没改过 / 从未按正文纠正） */
export function reqTitleLooksLikeFileName(title: string, sourcePathOrTitle: string): boolean {
  const current = clampReqName(title);
  if (!current) return true;
  const rawBase =
    String(sourcePathOrTitle ?? '')
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.[^.]+$/, '')
      .trim() || '';
  const cleaned = reqNameFromFileName(sourcePathOrTitle);
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const n = norm(current);
  return n === norm(rawBase) || n === norm(cleaned) || n === norm(`${cleaned}_需求文档`);
}

export function gapId(type: string, storyId: string, title: string): string {
  return `g_${shortHash(`${type}|${storyId}|${title}`)}`;
}

export function normalizeStoryDraft(raw: unknown): ReqStory {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const priority = str(o.priority, 4);
  return {
    id: str(o.id, 20),
    title: str(o.title, 200),
    role: str(o.role, 120),
    goal: str(o.goal, 500),
    value: str(o.value, 500),
    sourceRefs: strList(o.sourceRefs, 20, 40),
    priority: priority === 'P0' || priority === 'P1' || priority === 'P2' ? priority : 'P1',
    preconditions: strList(o.preconditions),
    mainFlow: (Array.isArray(o.mainFlow) ? o.mainFlow : [])
      .map((x) => {
        const step = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        return {
          actor: str(step.actor, 80),
          action: str(step.action, 500),
          result: str(step.result, 500),
        };
      })
      .filter((x) => x.action)
      .slice(0, 40),
    altFlows: (Array.isArray(o.altFlows) ? o.altFlows : [])
      .map((x) => {
        const flow = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        return {
          name: str(flow.name, 120) || '替代流程',
          trigger: str(flow.trigger, 500),
          steps: strList(flow.steps, 20),
        };
      })
      .slice(0, 20),
    exceptions: (Array.isArray(o.exceptions) ? o.exceptions : [])
      .map((x) => {
        const item = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        return { scenario: str(item.scenario, 500), expected: str(item.expected, 500) };
      })
      .filter((x) => x.scenario)
      .slice(0, 30),
    postconditions: strList(o.postconditions),
    acceptance: (Array.isArray(o.acceptance) ? o.acceptance : [])
      .map((x) => {
        const item = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        return {
          given: str(item.given, 500),
          when: str(item.when, 500),
          then: str(item.then, 500),
        };
      })
      .filter((x) => x.given || x.when || x.then)
      .slice(0, 30),
    dimensions: strList(o.dimensions, 12, 40),
  };
}

function cloneStory(story: ReqStory): ReqStory {
  return {
    ...story,
    sourceRefs: [...story.sourceRefs],
    preconditions: [...story.preconditions],
    mainFlow: story.mainFlow.map((x) => ({ ...x })),
    altFlows: story.altFlows.map((x) => ({ ...x, steps: [...x.steps] })),
    exceptions: story.exceptions.map((x) => ({ ...x })),
    postconditions: [...story.postconditions],
    acceptance: story.acceptance.map((x) => ({ ...x })),
    dimensions: [...story.dimensions],
  };
}

/** 去重键：标题归一化 + 主流程首步（同一目标换了措辞也能认出来） */
export function storyKey(story: Pick<ReqStory, 'title' | 'mainFlow'>): string {
  const first = story.mainFlow?.[0];
  return `${keyOf(story.title)}|${first ? keyOf(`${first.action}${first.result ?? ''}`) : ''}`;
}

/**
 * 合并故事集（分批拆解 / 补写共用）：
 * - 先按 id 认（补写时模型会带回原 id，标题被改了也不重复）；
 * - 再按「标题 + 主流程首步」认；
 * - 命中时只补空字段、并集 sourceRefs / dimensions，不覆盖用户已经改过的内容。
 */
export function mergeStories(existing: ReqStory[], incoming: unknown[]): ReqStory[] {
  const out = existing.map(cloneStory);
  const byId = new Map(out.filter((s) => s.id).map((s) => [s.id, s]));
  const byKey = new Map(out.map((s) => [storyKey(s), s]));

  for (const raw of incoming) {
    const draft = normalizeStoryDraft(raw);
    if (!draft.title) continue;
    const hit = (draft.id && byId.get(draft.id)) || byKey.get(storyKey(draft));
    if (!hit) {
      const created: ReqStory = { ...draft, id: '' };
      out.push(created);
      byKey.set(storyKey(created), created);
      continue;
    }
    if (!hit.role && draft.role) hit.role = draft.role;
    if (!hit.goal && draft.goal) hit.goal = draft.goal;
    if (!hit.value && draft.value) hit.value = draft.value;
    hit.sourceRefs = uniq([...hit.sourceRefs, ...draft.sourceRefs]);
    hit.dimensions = uniq([...hit.dimensions, ...draft.dimensions]);
    if (!hit.preconditions.length) hit.preconditions = [...draft.preconditions];
    if (!hit.mainFlow.length) hit.mainFlow = draft.mainFlow.map((x) => ({ ...x }));
    if (!hit.altFlows.length) hit.altFlows = draft.altFlows.map((x) => ({ ...x }));
    if (!hit.exceptions.length) hit.exceptions = draft.exceptions.map((x) => ({ ...x }));
    if (!hit.postconditions.length) hit.postconditions = [...draft.postconditions];
    if (!hit.acceptance.length) hit.acceptance = draft.acceptance.map((x) => ({ ...x }));
    // 优先级只升不降：P0 的诉求不能被后续批次降成 P2
    if (draft.priority === 'P0' && hit.priority !== 'P0') hit.priority = 'P0';
    else if (draft.priority === 'P1' && hit.priority === 'P2') hit.priority = 'P1';
  }
  return out;
}

/** 标题相似度：相等 / 包含优先，否则按二字片段重合计分 */
function titleMatchScore(a: string, b: string): number {
  const ka = keyOf(a);
  const kb = keyOf(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1000;
  if (ka.includes(kb) || kb.includes(ka)) return 800 + Math.min(ka.length, kb.length);
  const shorter = ka.length <= kb.length ? ka : kb;
  const longer = ka.length <= kb.length ? kb : ka;
  let shared = 0;
  for (let i = 0; i < shorter.length - 1; i++) {
    if (longer.includes(shorter.slice(i, i + 2))) shared += 1;
  }
  // 短标题（如「节点修改」）二字片段本来就少，按覆盖比例加成
  const maxDigrams = Math.max(1, shorter.length - 1);
  return shared + Math.round((shared / maxDigrams) * 10);
}

/** 至少约一半二字片段重合，或短标题几乎全覆盖 */
const TITLE_MATCH_MIN = 4;

/**
 * 给空 sourceRefs 的故事按标题挂需求点（查/改子点优先）。
 * 已有引用不动；一对一贪心，避免多条故事抢同一点。
 */
export function fillMissingSourceRefs(
  stories: readonly ReqStory[],
  outline: readonly ReqOutlineItem[],
): { stories: ReqStory[]; filled: number } {
  const out = stories.map(cloneStory);
  if (!outline.length) return { stories: out, filled: 0 };

  const childIds = new Set(outline.filter((item) => item.parentId).map((item) => item.parentId!));
  const candidates = [
    ...outline.filter((item) => item.kind === 'query' || item.kind === 'mutate'),
    ...outline.filter((item) => !item.kind && !item.parentId && !childIds.has(item.id)),
  ];
  if (!candidates.length) return { stories: out, filled: 0 };

  const taken = new Set(
    out.flatMap((story) => story.sourceRefs).filter((id) => candidates.some((c) => c.id === id)),
  );
  let filled = 0;
  for (const story of out) {
    if (story.sourceRefs.length) continue;
    let best: ReqOutlineItem | null = null;
    let bestScore = 0;
    for (const item of candidates) {
      if (taken.has(item.id)) continue;
      const score = titleMatchScore(story.title, item.title);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    if (!best || bestScore < TITLE_MATCH_MIN) continue;
    story.sourceRefs = [best.id];
    taken.add(best.id);
    filled += 1;
  }
  return { stories: out, filled };
}

/* ------------------------------ 体检（确定性规则） ------------------------------ */

function storySearchText(story: ReqStory): string {
  return [
    story.title,
    story.role,
    story.goal,
    story.value,
    ...story.dimensions,
    ...story.preconditions,
    ...story.postconditions,
    ...story.mainFlow.map((x) => `${x.actor ?? ''} ${x.action} ${x.result ?? ''}`),
    ...story.altFlows.map((x) => `${x.name} ${x.trigger} ${x.steps.join(' ')}`),
    ...story.exceptions.map((x) => `${x.scenario} ${x.expected}`),
    ...story.acceptance.map((x) => `${x.given} ${x.when} ${x.then}`),
  ].join(' ');
}

export function hasWriteAction(story: ReqStory): boolean {
  return story.mainFlow.some((step) => WRITE_ACTION_RE.test(step.action));
}

function ruleGap(
  type: ReqGapType,
  storyId: string,
  title: string,
  detail: string,
  suggestion: string,
  severity: ReqGapSeverity,
  outlineId = '',
): ReqGap {
  return {
    id: gapId(type, storyId || outlineId, title),
    storyId,
    outlineId: outlineId || undefined,
    type,
    severity,
    title,
    detail,
    suggestion,
    origin: 'rule',
    selected: false,
  };
}

/** 规则里「泛化」的标题：模型给了更具体的问题时，用它替换掉的只是措辞 */
const GENERIC_GAP_TITLES = new Set([
  '缺少角色',
  '缺少目标',
  '缺少前置条件',
  '缺少主流程',
  '没有异常场景',
  '写操作缺少异常分支',
  '缺少验收标准',
  '验收标准缺 then',
  '没有关联需求条目',
  '只写了主流程',
]);

/**
 * 确定性体检：主缺口只报「待确认·未覆盖」。
 * 字段/场景完整性见 `storyCompletenessHints`（故事卡提示，不进主清单）。
 * 维度矩阵仍计算，但无原文依据时不硬报维度缺口。
 */
export function auditStories(doc: {
  outline: ReqOutlineItem[];
  stories: ReqStory[];
}): ReqCheckReport {
  const outline = doc.outline ?? [];
  const stories = doc.stories ?? [];
  const gaps: ReqGap[] = [];
  const targets = outlineCoverageItems(outline);
  const referenced = new Set(stories.flatMap((s) => s.sourceRefs));

  for (const item of targets) {
    if (referenced.has(item.id)) continue;
    const kindLabel = item.kind === 'query' ? '查询' : item.kind === 'mutate' ? '修改' : '';
    const label = kindLabel ? `${item.title}（${kindLabel}）` : item.title;
    gaps.push(
      ruleGap(
        'uncovered-outline',
        '',
        `${label}：还没有用户故事挂上`,
        `需求点「${label}」在文档里有，但目前没有任何故事引用它。可能是漏拆了，也可能这块其实不用测。`,
        `跟业务确认要不要覆盖：要的话补一条故事（或在已有故事里挂上这个点）；不要的话直接忽略。`,
        'high',
        item.id,
      ),
    );
  }

  const dimensions: ReqDimensionCoverage[] = REQ_DIMENSIONS.map((dim) => {
    const hits = stories
      .filter((story) => {
        const text = storySearchText(story).toLowerCase();
        return dim.keywords.some((kw) => text.includes(kw.toLowerCase()));
      })
      .map((story) => story.id);
    return { key: dim.key, label: dim.label, covered: hits.length > 0, stories: hits };
  });

  const covered = targets.filter((item) => referenced.has(item.id)).length;
  const coverage: ReqCoverage = {
    total: targets.length,
    covered,
    rate: targets.length ? covered / targets.length : 0,
  };

  return {
    at: new Date().toISOString(),
    summary: `规则检查：${stories.length} 个故事、${targets.length} 个需求点，覆盖率 ${
      targets.length ? Math.round(coverage.rate * 100) : 0
    }%，${gaps.length} 项待确认未覆盖。`,
    coverage,
    dimensions,
    gaps,
  };
}

/**
 * 把规则缺口和模型缺口合到一份报告里。
 * 同一个 `storyId + type` 上：规则那条是泛化措辞时，用模型的具体描述替换；
 * 标题不同则都保留（一个故事同一类问题可以有多条具体缺口）。
 */
export function mergeCheckGaps(rule: ReqGap[], model: ReqGap[]): ReqGap[] {
  const out = rule.map((gap) => ({ ...gap }));
  const byKey = new Map(out.map((gap) => [`${gap.storyId}|${gap.type}`, gap]));
  const seen = new Set(out.map((gap) => gap.id));
  for (const gap of model) {
    if (seen.has(gap.id)) continue;
    const key = `${gap.storyId}|${gap.type}`;
    const hit = byKey.get(key);
    if (!hit) {
      out.push({ ...gap });
      byKey.set(key, gap);
      seen.add(gap.id);
      continue;
    }
    if (GENERIC_GAP_TITLES.has(hit.title)) {
      hit.title = gap.title;
      hit.detail = [hit.detail, gap.detail].filter(Boolean).join(' / ');
      hit.suggestion = gap.suggestion || hit.suggestion;
      hit.severity = gap.severity;
      continue;
    }
    if (keyOf(hit.title) === keyOf(gap.title)) continue;
    out.push({ ...gap });
    seen.add(gap.id);
  }
  return out;
}

/**
 * 重新体检后尽量留住勾选与已填结论（按 id，其次按稳定键 / 近似标题）。
 * 复审主路径请用 {@link reconcileAuditGaps}（含忽略过滤）；本函数仍供仅合并选择态的调用。
 */
export function preserveGapSelection(prev: ReqGap[], next: ReqGap[]): ReqGap[] {
  const used = new Set<string>();
  return next.map((gap) => {
    const prevGap =
      prev.find((item) => item.id === gap.id && !used.has(item.id)) ||
      prev.find((item) => !used.has(item.id) && gapsLikelySame(item, gap));
    if (!prevGap) return gap;
    used.add(prevGap.id);
    return {
      ...gap,
      id: prevGap.id,
      title: prevGap.title,
      selected: prevGap.selected || gap.selected,
      conclusion: gap.conclusion?.trim() || prevGap.conclusion,
    };
  });
}

export function countSelectedGaps(gaps: ReqGap[]): number {
  return gaps.filter((gap) => gap.selected).length;
}

/* ------------------------------ 拆解：分批 ------------------------------ */

export interface ReqSourceChunk {
  index: number;
  title: string;
  text: string;
}

function splitLongText(text: string, max: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const block of text.split(/\n{2,}/)) {
    const piece = current ? `${current}\n\n${block}` : block;
    if (piece.length <= max) {
      current = piece;
      continue;
    }
    if (current) out.push(current);
    if (block.length <= max) {
      current = block;
      continue;
    }
    // 单个块还是太长：硬切，保证每批不超过上限
    for (let i = 0; i < block.length; i += max) out.push(block.slice(i, i + max));
    current = '';
  }
  if (current) out.push(current);
  return out;
}

/**
 * 按 `##` 章节切批：单批不超过 `maxChars`，超长章节按段落再切。
 * 短文档只返回一批（index 0，title 为空），页面上不提示「已分批」。
 */
export function splitRequirementSections(
  raw: string,
  maxChars: number = REQ_CHUNK_CHARS,
): ReqSourceChunk[] {
  const text = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return [];
  const max = Math.max(2000, Math.floor(maxChars));
  if (text.length <= max) return [{ index: 0, title: '', text }];

  const parts: { title: string; text: string }[] = [];
  let title = '';
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) parts.push({ title, text: body });
    buffer = [];
  };
  for (const line of text.split('\n')) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[1];
    }
    buffer.push(line);
  }
  flush();
  if (!parts.length) return [{ index: 0, title: '', text }];

  const chunks: ReqSourceChunk[] = [];
  let current = '';
  let currentTitle = '';
  const pushCurrent = () => {
    const body = current.trim();
    if (!body) return;
    for (const piece of body.length > max ? splitLongText(body, max) : [body]) {
      chunks.push({ index: chunks.length, title: currentTitle, text: piece });
    }
    current = '';
  };
  for (const part of parts) {
    const piece = current ? `${current}\n\n${part.text}` : part.text;
    if (piece.length <= max) {
      if (!current) currentTitle = part.title;
      current = piece;
      continue;
    }
    pushCurrent();
    currentTitle = part.title;
    current = part.text;
    if (current.length > max) pushCurrent();
  }
  pushCurrent();
  return chunks.length ? chunks : [{ index: 0, title: '', text }];
}

/* ------------------------------ 导出 ------------------------------ */

function mdLine(label: string, value: string): string {
  return value ? `- **${label}**：${value}` : '';
}

function bullets(items: string[]): string[] {
  return items.filter(Boolean).map((x) => `- ${x}`);
}

/** 单条用户故事 → Markdown 段落（导出与下游取数共用，避免格式漂移） */
export function storyToMarkdown(
  story: ReqStory,
  outline: readonly ReqOutlineItem[] = [],
): string[] {
  const lines: string[] = [];
  lines.push(`### ${story.id} ${story.title}`);
  lines.push('');
  const sourceLabel = outline.length
    ? formatSourceRefsLabel(story.sourceRefs, outline)
    : story.sourceRefs.join('、');
  const head = [
    mdLine('角色', story.role),
    mdLine('目标', story.goal),
    mdLine('价值', story.value),
    mdLine('优先级', story.priority),
    mdLine('来源条目', sourceLabel),
  ].filter(Boolean);
  lines.push(...head);
  if (head.length) lines.push('');

  if (story.preconditions.length) {
    lines.push('**前置条件**');
    lines.push(...bullets(story.preconditions));
    lines.push('');
  }
  if (story.mainFlow.length) {
    lines.push('**主流程**');
    story.mainFlow.forEach((step, i) => {
      const who = step.actor ? `${step.actor}：` : '';
      lines.push(`${i + 1}. ${who}${step.action}${step.result ? ` → ${step.result}` : ''}`);
    });
    lines.push('');
  }
  if (story.altFlows.length) {
    lines.push('**替代流程**');
    for (const flow of story.altFlows) {
      lines.push(`- **${flow.name}**${flow.trigger ? `（触发：${flow.trigger}）` : ''}`);
      flow.steps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
    }
    lines.push('');
  }
  if (story.exceptions.length) {
    lines.push('**异常场景**');
    for (const item of story.exceptions) {
      lines.push(`- ${item.scenario}${item.expected ? ` → ${item.expected}` : ''}`);
    }
    lines.push('');
  }
  if (story.postconditions.length) {
    lines.push('**后置条件**');
    lines.push(...bullets(story.postconditions));
    lines.push('');
  }
  if (story.acceptance.length) {
    lines.push('**验收标准**');
    for (const item of story.acceptance) {
      lines.push(
        `- Given ${item.given || '（未写）'}；When ${item.when || '（未写）'}；Then ${item.then || '（未写）'}`,
      );
    }
    lines.push('');
  }
  if (story.dimensions.length) {
    lines.push(`**覆盖维度**：${story.dimensions.join('、')}`);
    lines.push('');
  }
  if (lines[lines.length - 1] !== '') lines.push('');
  return lines;
}

/**
 * 用户故事 → Markdown（下游取数用：用例生成把选中的故事拼进上下文）。
 * `storyIds` 为空表示整份分析的全部故事。
 */
export function storiesToMarkdown(doc: ReqAnalysisDoc, storyIds?: string[]): string {
  const wanted = new Set((storyIds ?? []).filter(Boolean));
  const stories = wanted.size ? doc.stories.filter((s) => wanted.has(s.id)) : doc.stories;
  const lines: string[] = [];
  lines.push(`# ${doc.title || '需求分析'} · 用户故事`);
  lines.push('');
  lines.push(
    `> 来源需求文档：\`${doc.sourcePath || '（未指定）'}\` · 状态：${REQ_STATUS_META[doc.status].label} · 更新：${doc.updatedAt}`,
  );
  lines.push('');

  if (doc.outline.length) {
    lines.push('## 需求条目');
    lines.push('');
    lines.push('> 「引用需求点」请填下列真实 RO id，格式「RO-id 标题」；不要填 US-…。');
    lines.push('');
    for (const group of groupOutlineParents(doc.outline, stories)) {
      lines.push(`### ${group.parent.id} ${group.parent.title}`);
      if (group.parent.quote || group.parent.body) {
        const q = (group.parent.quote || group.parent.body || '')
          .replace(/\s+/g, ' ')
          .slice(0, 200);
        lines.push(`> ${q}`);
      }
      if (group.points.length) {
        for (const point of group.points) {
          const kind = point.kind === 'query' ? '查询' : point.kind === 'mutate' ? '修改' : '';
          lines.push(`- **${point.id}** ${point.title}${kind ? `（${kind}）` : ''}`);
          if (point.quote) lines.push(`  > ${point.quote.replace(/\n+/g, ' ')}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## 用户故事');
  lines.push('');
  if (!stories.length) {
    lines.push('- （暂无）');
    lines.push('');
  }
  const ordered = sortStoriesByOutlineDocOrder(stories, doc.outline);
  for (const story of ordered) lines.push(...storyToMarkdown(story, doc.outline));
  return lines.join('\n');
}

/** 导出 Markdown：用户故事 + 体检摘要（浏览器下载，不落盘） */
export function toMarkdown(doc: ReqAnalysisDoc): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title || '需求分析'}`);
  lines.push('');
  lines.push(
    `> 来源：\`${doc.sourcePath || '（未指定）'}\` · 状态：${REQ_STATUS_META[doc.status].label} · 更新：${doc.updatedAt}`,
  );
  lines.push('');

  lines.push('## 需求条目');
  lines.push('');
  if (!doc.outline.length) lines.push('- （暂无）');
  for (const group of groupOutlineParents(doc.outline, doc.stories)) {
    lines.push(`- **${group.parent.id}** ${group.parent.title}`);
    if (group.parent.quote) lines.push(`   > ${group.parent.quote.replace(/\n+/g, ' ')}`);
    for (const point of group.points) {
      const kind = point.kind === 'query' ? '查询' : point.kind === 'mutate' ? '修改' : '';
      lines.push(`  - **${point.id}** ${point.title}${kind ? `（${kind}）` : ''}`);
      if (point.quote) lines.push(`    > ${point.quote.replace(/\n+/g, ' ')}`);
    }
  }
  lines.push('');

  lines.push('## 用户故事');
  lines.push('');
  if (!doc.stories.length) lines.push('- （暂无）');
  for (const story of sortStoriesByOutlineDocOrder(doc.stories, doc.outline)) {
    lines.push(...storyToMarkdown(story, doc.outline));
  }

  lines.push('## 审查摘要');
  lines.push('');
  if (!doc.check) {
    lines.push('- 还没有跑过审查。');
  } else {
    const pct = doc.check.coverage.total ? Math.round(doc.check.coverage.rate * 100) : 0;
    lines.push(`- 覆盖率：${doc.check.coverage.covered}/${doc.check.coverage.total}（${pct}%）`);
    lines.push(
      `- 维度覆盖：${
        doc.check.dimensions.map((d) => `${d.label}${d.covered ? ' ✓' : ' ✗'}`).join(' · ') ||
        '（无）'
      }`,
    );
    if (doc.check.summary) {
      lines.push('');
      lines.push(doc.check.summary);
    }
    lines.push('');
    lines.push('### 缺口清单');
    lines.push('');
    if (!doc.check.gaps.length) {
      lines.push('- 没有发现缺口。');
    }
    const ordered = [...doc.check.gaps].sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 } as const;
      return rank[a.severity] - rank[b.severity];
    });
    for (const gap of ordered) {
      const where = gap.storyId ? `${gap.storyId} ` : '';
      lines.push(
        `- **[${GAP_SEVERITY_LABEL[gap.severity]}] ${GAP_TYPE_LABEL[gap.type]}** · ${where}${gap.title}`,
      );
      if (gap.detail) lines.push(`  - 原因：${gap.detail}`);
      if (gap.suggestion) lines.push(`  - 建议：${gap.suggestion}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function exportFileName(doc: ReqAnalysisDoc): string {
  const base = (doc.title || doc.sourcePath.split('/').pop() || '需求分析')
    .replace(/\.(md|markdown|txt)$/i, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .trim();
  return `${base || '需求分析'}-用户故事.md`;
}

/* ------------------------------ 提示词分段 ------------------------------ */

/** 解析提示词文件的分段正文（与 lh-plugins/req-analysis-prompt.mjs 同一套规则） */
export function parseReqSections(text: string): {
  decompose: string;
  stories: string;
  audit: string;
  fix: string;
} {
  const raw = String(text ?? '');
  const out = { decompose: '', stories: '', audit: '', fix: '' };
  if (!raw.trim()) return out;
  let current: '' | 'decompose' | 'stories' | 'legacy' | 'audit' | 'fix' = '';
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (current === 'decompose') out.decompose = body;
    else if (current === 'stories') out.stories = body;
    else if (current === 'legacy') {
      if (body) {
        if (!out.decompose) out.decompose = body;
        if (!out.stories) out.stories = body;
      }
    } else if (current === 'audit') out.audit = body;
    else if (current === 'fix') out.fix = body;
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const name = (heading[1] ?? '').trim();
      if (/拆解需求|整理需求|整理条目/.test(name)) current = 'decompose';
      else if (/生成用户故事/.test(name)) current = 'stories';
      else if (/^拆解$/.test(name) || /^(拆分|分析)$/.test(name)) current = 'legacy';
      else if (/拆解|拆分/.test(name) && !/需求|故事|审查|补写/.test(name)) current = 'legacy';
      else if (/体检|审查|检查|评审/.test(name)) current = 'audit';
      else if (/补写|修订|修复|补齐/.test(name)) current = 'fix';
      else current = '';
      continue;
    }
    if (!current && (/^#\s/.test(line) || /^>\s?/.test(line))) continue;
    if (current) buffer.push(line);
  }
  flush();
  if (out.decompose && !out.stories) out.stories = out.decompose;
  if (out.stories && !out.decompose) out.decompose = out.stories;
  return out;
}
