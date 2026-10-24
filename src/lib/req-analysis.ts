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
export type ReqGapType =
  | 'uncovered-outline'
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
  type: ReqGapType;
  severity: ReqGapSeverity;
  title: string;
  detail: string;
  suggestion: string;
  origin: ReqGapOrigin;
  /** 用户在缺口清单里勾选的状态 */
  selected: boolean;
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
  /** 「生成测试点」插件的产出；插件关闭或还没生成时为 null */
  testPoints: TestPointReport | null;
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
  testPoints?: TestPointReport | null;
  progress?: ReqProgress | null;
}

export interface ReqPrompt {
  file: string;
  exists: boolean;
  decompose: string;
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
  'uncovered-outline': '条目未覆盖',
  'missing-field': '字段缺失',
  'missing-scenario': '场景遗漏',
  'missing-dimension': '维度缺失',
  'untestable-acceptance': '验收不可测',
  conflict: '与原文冲突',
  'over-split': '过度拆分',
  other: '其它',
};

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
    return {
      file: json.file || REQ_ANALYSIS_PROMPT_FILE,
      exists: json.exists === true,
      decompose: json.decompose ?? '',
      audit: json.audit ?? '',
      fix: json.fix ?? '',
    };
  } catch (err) {
    return {
      file: REQ_ANALYSIS_PROMPT_FILE,
      exists: false,
      decompose: '',
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

/** Ideal 表一行：大模块 / 小模块 / 展示标题（【短名】或小模块） */
export interface IdealReqRow {
  big: string;
  small: string;
  title: string;
}

function parseIdealReqRows(content: string): IdealReqRow[] {
  const text = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return [];
  const headerLine = text.split('\n').find((line) => /大模块/.test(line) && /小模块/.test(line));
  if (!headerLine) return [];
  const rows: IdealReqRow[] = [];
  const seenSmall = new Set<string>();
  for (const line of text.split('\n')) {
    if (/^大模块/.test(line)) continue;
    // 仅匹配「行首」：大模块,小模块,正文开头…（多行单元格的续行不会命中）
    const m = line.match(/^"?([^,"\n]{1,40})"?,"?([^,"\n]{1,40})"?,("?[^,\n]*)/);
    if (!m) continue;
    const big = m[1]!.trim();
    const small = m[2]!.trim();
    if (!small || small === '小模块' || big === '大模块') continue;
    if (/[。；;]/.test(small) || small.length > 30) continue;
    if (seenSmall.has(small)) continue;
    seenSmall.add(small);
    const head = (m[3] || '').replace(/^"/, '');
    const bracket = head.match(/【([^】\n]{1,40})】/);
    const title = clampReqName(bracket?.[1] || small);
    if (!title) continue;
    rows.push({ big, small, title });
  }
  return rows;
}

/**
 * Ideal 需求表：按行提取「小模块」原文（用例「子模块」应对齐这一列）。
 * 保持表格行序、按小模块去重。
 */
export function extractIdealSmallModules(content: string): string[] {
  return parseIdealReqRows(content).map((r) => r.small);
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
    'Ideal 小模块行序（用例「子模块 / 小模块」填下列原文；最终文件按此序排列，优先于用户故事 US 编号）：',
    '大模块,小模块,优化/问题内容',
  ];
  for (const r of rows) {
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
): ReqGap {
  return {
    id: gapId(type, storyId, title),
    storyId,
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
 * 确定性体检：这部分是硬结论，模型改不了。
 * 覆盖率按 outline × story.sourceRefs 做集合运算；维度覆盖按关键词命中。
 */
export function auditStories(doc: {
  outline: ReqOutlineItem[];
  stories: ReqStory[];
}): ReqCheckReport {
  const outline = doc.outline ?? [];
  const stories = doc.stories ?? [];
  const gaps: ReqGap[] = [];

  const referenced = new Set(stories.flatMap((s) => s.sourceRefs));
  for (const item of outline) {
    if (referenced.has(item.id)) continue;
    gaps.push(
      ruleGap(
        'uncovered-outline',
        '',
        `需求条目未覆盖：${item.title}`,
        `条目 ${item.id}「${item.title}」没有任何用户故事引用。`,
        `补一条覆盖该条目的用户故事，或在已有故事的 sourceRefs 里加上 ${item.id}。`,
        'high',
      ),
    );
  }

  for (const story of stories) {
    const who = `${story.id} ${story.title}`;
    if (!story.role) {
      gaps.push(
        ruleGap(
          'missing-field',
          story.id,
          '缺少角色',
          `${who} 没有写清谁在用这个功能。`,
          '补一个来自原文的角色；原文没写就标注「推断」。',
          'medium',
        ),
      );
    }
    if (!story.goal) {
      gaps.push(
        ruleGap(
          'missing-field',
          story.id,
          '缺少目标',
          `${who} 没有写用户要达成什么。`,
          '补一句用户目标（想要什么结果）。',
          'medium',
        ),
      );
    }
    if (!story.preconditions.length) {
      gaps.push(
        ruleGap(
          'missing-field',
          story.id,
          '缺少前置条件',
          `${who} 没有前置条件。`,
          '补进入这条流程前必须成立的状态。',
          'low',
        ),
      );
    }
    if (!story.mainFlow.length) {
      gaps.push(
        ruleGap(
          'missing-field',
          story.id,
          '缺少主流程',
          `${who} 没有主流程步骤。`,
          '按「动作 + 结果」补主流程。',
          'high',
        ),
      );
    }
    if (!story.sourceRefs.length) {
      gaps.push(
        ruleGap(
          'missing-field',
          story.id,
          '没有关联需求条目',
          `${who} 的 sourceRefs 为空，覆盖率无法统计。`,
          '把这条故事挂到对应的需求条目 id 上。',
          'low',
        ),
      );
    }
    if (!story.exceptions.length) {
      gaps.push(
        ruleGap(
          'missing-scenario',
          story.id,
          '没有异常场景',
          `${who} 只写了顺利路径，没有异常分支。`,
          '至少补 3 条：输入非法、权限不足、依赖失败 / 超时。',
          'high',
        ),
      );
    } else if (hasWriteAction(story) && story.exceptions.length < 2) {
      gaps.push(
        ruleGap(
          'missing-scenario',
          story.id,
          '写操作缺少异常分支',
          `${who} 包含写操作，但只写了 ${story.exceptions.length} 条异常。`,
          '补重复提交 / 并发修改 / 保存失败时的表现与回滚。',
          'medium',
        ),
      );
    }
    if (!story.altFlows.length && hasWriteAction(story)) {
      gaps.push(
        ruleGap(
          'missing-scenario',
          story.id,
          '只写了主流程',
          `${who} 没有替代流程：分支条件、可跳过步骤、不同入口都没覆盖。`,
          '按触发条件补至少一条替代路径。',
          'low',
        ),
      );
    }
    if (!story.acceptance.length) {
      gaps.push(
        ruleGap(
          'untestable-acceptance',
          story.id,
          '缺少验收标准',
          `${who} 没有 Given / When / Then。`,
          '每条验收写成 Given / When / Then，then 必须可判定。',
          'high',
        ),
      );
    } else if (story.acceptance.some((a) => !a.then)) {
      gaps.push(
        ruleGap(
          'untestable-acceptance',
          story.id,
          '验收标准缺 then',
          `${who} 有 ${story.acceptance.filter((a) => !a.then).length} 条验收没有写 then。`,
          '补上「应该看到什么 / 查到什么」，不要停在操作步骤。',
          'high',
        ),
      );
    }
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

  for (const dim of dimensions) {
    if (dim.covered) continue;
    const hint = REQ_DIMENSIONS.find((x) => x.key === dim.key)?.hint ?? '';
    gaps.push(
      ruleGap(
        'missing-dimension',
        '',
        `维度缺失：${dim.label}`,
        `所有用户故事都没有覆盖「${dim.label}」相关场景。`,
        hint,
        'medium',
      ),
    );
  }

  const covered = outline.filter((item) => referenced.has(item.id)).length;
  const coverage: ReqCoverage = {
    total: outline.length,
    covered,
    rate: outline.length ? covered / outline.length : 0,
  };

  return {
    at: new Date().toISOString(),
    summary: `规则检查：${stories.length} 个故事、${outline.length} 条需求条目，覆盖率 ${
      outline.length ? Math.round(coverage.rate * 100) : 0
    }%，发现 ${gaps.length} 个问题。`,
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

/** 重新体检后尽量留住用户的勾选状态（按稳定 id） */
export function preserveGapSelection(prev: ReqGap[], next: ReqGap[]): ReqGap[] {
  const selected = new Set(prev.filter((gap) => gap.selected).map((gap) => gap.id));
  if (!selected.size) return next;
  return next.map((gap) => (selected.has(gap.id) ? { ...gap, selected: true } : gap));
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
export function storyToMarkdown(story: ReqStory): string[] {
  const lines: string[] = [];
  lines.push(`### ${story.id} ${story.title}`);
  lines.push('');
  const head = [
    mdLine('角色', story.role),
    mdLine('目标', story.goal),
    mdLine('价值', story.value),
    mdLine('优先级', story.priority),
    mdLine('来源条目', story.sourceRefs.join('、')),
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
    doc.outline.forEach((item, i) => {
      lines.push(`${i + 1}. **${item.id}** ${item.title}`);
    });
    lines.push('');
  }

  lines.push('## 用户故事');
  lines.push('');
  if (!stories.length) {
    lines.push('- （暂无）');
    lines.push('');
  }
  for (const story of stories) lines.push(...storyToMarkdown(story));
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
  doc.outline.forEach((item, i) => {
    lines.push(`${i + 1}. **${item.id}** ${item.title}`);
    if (item.quote) lines.push(`   > ${item.quote.replace(/\n+/g, ' ')}`);
  });
  lines.push('');

  lines.push('## 用户故事');
  lines.push('');
  if (!doc.stories.length) lines.push('- （暂无）');
  for (const story of doc.stories) lines.push(...storyToMarkdown(story));

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
  audit: string;
  fix: string;
} {
  const raw = String(text ?? '');
  const out = { decompose: '', audit: '', fix: '' };
  if (!raw.trim()) return out;
  let current: '' | 'decompose' | 'audit' | 'fix' = '';
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (current) out[current] = body;
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1];
      if (/拆解|拆分|分析/.test(name)) current = 'decompose';
      else if (/体检|审查|检查|评审/.test(name)) current = 'audit';
      else if (/补写|修订|修复|补齐/.test(name)) current = 'fix';
      else current = '';
      continue;
    }
    if (!current && (/^#\s/.test(line) || /^>\s?/.test(line))) continue;
    if (current) buffer.push(line);
  }
  flush();
  return out;
}
