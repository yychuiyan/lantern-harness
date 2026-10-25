/**
 * 用例质量评审 + 场景遗漏补全：类型、接口、确定性规则与导出。
 *
 * 分工：
 * - 七项量化指标、硬伤判定、五维分数全部由本文件的规则算（不依赖模型）；
 * - 模型只补语义（维度分与扣分原因/建议），回来后再由本文件按同一套阈值重算判定；
 * - 补全写入文件由服务端 `/append` 完成，这里只负责拼行与标记。
 */
import type { PmTone } from '../components/islands/PmShared';
import { CASE_FIELDS } from './export';
import type { CaseRow } from './case-file';
import { CASE_FIELD_NAME, applyFieldMap, canonicalizeRows, caseFieldMap } from './case-fields';

export const CASE_REVIEW_API = '/__tb_casereview';
export const BLINDSPOT_API = '/__tb_caseblindspot';

/** 与 lh-plugins/plugin-prompts.mjs 保持一致 */
export const CASE_REVIEW_PROMPT_FILE = '用例质量评审提示词.md';
export const BLINDSPOT_PROMPT_FILE = '场景遗漏补全提示词.md';

/* ------------------------------ 类型 ------------------------------ */

export type Verdict = 'usable' | 'revise' | 'invalid';
export type DimensionKey = 'coverage' | 'steps' | 'expected' | 'data' | 'convention';
export type BlindspotCategory = 'nonfunctional' | 'security' | 'compatibility' | 'business';
export type BlindspotSeverity = 'high' | 'medium' | 'low';

export interface Deduction {
  dimension: DimensionKey;
  points: number;
  reason: string;
  suggestion: string;
}

export interface CaseVerdict {
  no: string;
  title: string;
  verdict: Verdict;
  score: number;
  dimensions: Record<DimensionKey, number>;
  deductions: Deduction[];
  /** 硬伤证据：规则命中，或模型判定「错误无效」时必须给的那一句证据 */
  hard?: string;
  /**
   * 显式「已修改」（旧数据或兼容）；跳转工作台不写。
   * 新路径优先靠 contentFp 与当前文件行对比自动识别。
   */
  fixed?: boolean;
  /**
   * 评审当时的用例正文指纹（标题 / 步骤 / 预期 / 前置）。
   * 与当前文件行对比，非「可用」且指纹变化 → 视为已修改。
   */
  contentFp?: string;
  /** 用户忽略：列表进「忽略」Tab，任意评审轮次都不再送模型 */
  ignored?: boolean;
}

export interface ReviewMetric {
  key: string;
  label: string;
  /** 0–1，或 -1 表示不适用（未挂需求时的覆盖率） */
  value: number;
  text: string;
  hint: string;
}

export interface DimensionScore {
  key: DimensionKey;
  label: string;
  score: number;
  weight: number;
}

export interface CaseReviewReport {
  at: string;
  score: number;
  counts: Record<Verdict, number>;
  dimensions: DimensionScore[];
  metrics: ReviewMetric[];
  cases: CaseVerdict[];
  summary: string;
  /** 是否有模型参与的语义判定 */
  modeled: boolean;
  /** 模型真正逐条评到的条数（可小于 cases.length：没评到的只有规则分） */
  modelCovered?: number;
}

export interface BlindspotItem {
  id: string;
  category: BlindspotCategory;
  severity: BlindspotSeverity;
  title: string;
  why: string;
  precondition: string;
  steps: string[];
  expected: string;
  priority: string;
  /**
   * 归属需求：写回时插到哪一组下面。
   * 优先抄已有需求编号原文（前缀不限）；需求没有编号时再补自定义编号（同组共用）；空则写回时由模型按标题 / why 推断或补号。
   */
  reqAnchor: string;
  added: boolean;
  caseNo: string;
}

export interface BlindspotReport {
  at: string;
  context: { reqRef: string; reqTitle: string };
  items: BlindspotItem[];
  summary: string;
}

export interface CaseReviewEntry {
  path: string;
  hash: string;
  updatedAt: string;
  review: CaseReviewReport | null;
  blindspot: BlindspotReport | null;
}

export interface CaseReviewSummary {
  path: string;
  exists: boolean;
  stale: boolean;
  at: string;
  score: number | null;
  counts: Record<Verdict, number> | null;
  modeled: boolean;
  blindspotCount: number;
  addedCount: number;
}

export interface CaseReviewPrompt {
  file: string;
  exists: boolean;
  review: string;
  error?: string;
}

export interface BlindspotPrompt {
  file: string;
  exists: boolean;
  detect: string;
  complete: string;
  error?: string;
}

/* ------------------------------ 口径 ------------------------------ */

export const DIMENSION_ORDER: DimensionKey[] = [
  'coverage',
  'steps',
  'expected',
  'data',
  'convention',
];

export const DIMENSION_META: Record<
  DimensionKey,
  { label: string; weight: number; hint: string; tone: PmTone }
> = {
  coverage: {
    label: '需求覆盖',
    weight: 25,
    hint: '对应需求点是否明确、主流程与关键分支是否走到',
    tone: 'blue',
  },
  steps: {
    label: '步骤可执行',
    weight: 25,
    hint: '一步一个动作、有编号、照着能点',
    tone: 'purple',
  },
  expected: {
    label: '预期可判定',
    weight: 20,
    hint: '状态 / 文案 / 数值写清楚，第三方能判对错',
    tone: 'green',
  },
  data: {
    label: '数据与边界',
    weight: 15,
    hint: '前置数据与角色齐备，覆盖空值 / 上下限 / 重复',
    tone: 'amber',
  },
  convention: {
    label: '规范完整',
    weight: 15,
    hint: '编号、标题、优先级、类型与模板一致',
    tone: 'gray',
  },
};

export const VERDICT_ORDER: Verdict[] = ['usable', 'revise', 'invalid'];

export const VERDICT_META: Record<
  Verdict,
  { label: string; tone: PmTone; hint: string; badge: string }
> = {
  usable: {
    label: '可用',
    tone: 'green',
    hint: '照着能执行，预期能判定',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  revise: {
    label: '待修改',
    tone: 'amber',
    hint: '能看懂但执行会卡住或结论扯皮',
    badge: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  invalid: {
    label: '错误无效',
    tone: 'red',
    hint: '存在硬伤，不能用',
    badge: 'bg-red-50 text-red-700 border-red-200',
  },
};

export const BLINDSPOT_ORDER: BlindspotCategory[] = [
  'nonfunctional',
  'security',
  'compatibility',
  'business',
];

export const BLINDSPOT_META: Record<
  BlindspotCategory,
  { label: string; hint: string; tone: PmTone; mark: string }
> = {
  nonfunctional: {
    label: '非功能',
    hint: '响应时间、并发、大数量、断网与重试',
    tone: 'purple',
    mark: '非功能',
  },
  security: {
    label: '安全边界与容错',
    hint: '越权、注入、重复提交、竞态与篡改',
    tone: 'amber',
    mark: '安全',
  },
  compatibility: {
    label: '兼容性',
    hint: '分辨率、浏览器 / 端、深浅色、时区与格式',
    tone: 'blue',
    mark: '兼容',
  },
  business: {
    label: '隐藏业务规则',
    hint: '金额精度、状态互斥、唯一性、跨模块联动',
    tone: 'green',
    mark: '业务',
  },
};

export const SEVERITY_META: Record<BlindspotSeverity, { label: string; tone: PmTone }> = {
  high: { label: '高', tone: 'red' },
  medium: { label: '中', tone: 'amber' },
  low: { label: '低', tone: 'gray' },
};

/** 判定阈值：≥85 可用，60–84 待修改，<60 错误无效 */
export const VERDICT_THRESHOLDS = { usable: 85, revise: 60 } as const;

/* ------------------------------ 规则 ------------------------------ */

/** 「正常 / 正确」这类没有判定依据的模糊预期 */
const VAGUE_EXPECT = /^(正常|正确|成功|符合预期|无异常|没问题|ok|okay|通过|显示正常)的?$/i;
const SPECIFIC_HINT =
  /(提示|跳转|弹窗|状态|变为|变成|显示|返回|报错|错误码|http\s*\d|\d+%|金额|数量|\d+\s*(ms|s|秒|条|元|位|个|行|次))|「[^」]+」|"[^"]+"/i;
const STEP_NOISE = /^(验证|测试|检查)[^，。]{0,4}(功能|流程|是否正确)?$/;

/** 按编号 / 换行切步骤 */
export function splitSteps(text: string): string[] {
  const raw = String(text ?? '').replace(/<br\s*\/?>/gi, '\n');
  const byLine = raw.split(/\r?\n/).map((s) => s.trim());
  const merged: string[] = [];
  for (const line of byLine) {
    if (!line) continue;
    // 一段里写「1、…；2、…」时再拆一次
    const parts = line
      .split(/(?=(?:^|[；;])\s*\d+\s*[、.．)）])/)
      .map((s) => s.replace(/^[；;\s]+/, '').trim())
      .filter(Boolean);
    merged.push(...(parts.length ? parts : [line]));
  }
  return merged.filter((s) => s.length > 0);
}

function expectedTestable(text: string): boolean {
  const v = String(text ?? '').trim();
  if (!v) return false;
  if (VAGUE_EXPECT.test(v)) return false;
  return SPECIFIC_HINT.test(v) && v.length >= 6;
}

function isBoundaryOrException(row: CaseRow): boolean {
  const hay = `${row['用例类型'] ?? ''} ${row['用例标题'] ?? ''} ${row['测试步骤'] ?? ''}`;
  return /(边界|异常|失败|为空|超时|越界|并发|重复|非法|错误)/.test(hay);
}

function fingerprint(row: CaseRow): string {
  const norm = (s: string) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  return `${norm(row['用例标题'] ?? '')}|${norm(row['测试步骤'] ?? '')}`;
}

/** 评审/改文件对比用：标题 · 步骤 · 预期 · 前置 · 用例状态（工作台修改提示常改字段） */
export function caseContentFingerprint(row: CaseRow): string {
  const norm = (s: string) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  return [
    norm(row[CASE_FIELD_NAME.title] ?? row['用例标题'] ?? ''),
    norm(row[CASE_FIELD_NAME.steps] ?? row['测试步骤'] ?? ''),
    norm(row[CASE_FIELD_NAME.expected] ?? row['预期结果'] ?? ''),
    norm(row[CASE_FIELD_NAME.precondition] ?? row['前置条件'] ?? ''),
    // 修改提示会把状态写成「待验证」；模板有该列时也算正文变化
    norm(row['用例状态'] ?? ''),
  ].join('|');
}

/** 报告里的条相对当前文件行是否改过正文（缺指纹或找不到行 → 否，避免误报） */
export function caseContentChanged(verdict: CaseVerdict, row: CaseRow | undefined): boolean {
  if (!verdict.contentFp || !row) return false;
  const now = caseContentFingerprint(row);
  if (now === verdict.contentFp) return false;
  const stored = verdict.contentFp.split('|');
  const cur = now.split('|');
  // 旧报告只有四段（无用例状态）：只比前四段，避免升级后全体误标「已修改」
  if (stored.length === 4 && cur.length >= 4) {
    return stored.join('|') !== cur.slice(0, 4).join('|');
  }
  return true;
}

function rowByCaseIdentity(rows: readonly CaseRow[]): Map<string, CaseRow> {
  const map = new Map<string, CaseRow>();
  for (const row of canonicalizeRows(rows)) {
    const no = String(row[CASE_FIELD_NAME.no] ?? row['用例编号'] ?? '').trim();
    const title = String(row[CASE_FIELD_NAME.title] ?? row['用例标题'] ?? '').trim();
    if (no) map.set(no, row);
    if (title && !map.has(title)) map.set(title, row);
  }
  return map;
}

/**
 * 视为「已修改」的身份键：显式 fixed，或非「可用」且 contentFp 与当前行不一致。
 * 已忽略的不进此集合。
 */
export function collectAutoFixedKeys(
  cases: readonly CaseVerdict[],
  rows: readonly CaseRow[],
): Set<string> {
  const byId = rowByCaseIdentity(rows);
  const keys = new Set<string>();
  for (const c of cases) {
    const key = caseIdentityKey(c);
    if (!key || c.ignored) continue;
    if (c.fixed) {
      keys.add(key);
      continue;
    }
    if (c.verdict === 'usable') continue;
    const row = byId.get(String(c.no ?? '').trim()) ?? byId.get(String(c.title ?? '').trim());
    if (caseContentChanged(c, row)) keys.add(key);
  }
  return keys;
}

/** 已忽略用例的身份键 */
export function collectIgnoredKeys(cases: readonly CaseVerdict[]): Set<string> {
  const keys = new Set<string>();
  for (const c of cases) {
    const key = caseIdentityKey(c);
    if (key && c.ignored) keys.add(key);
  }
  return keys;
}

/** 从对照需求里抽关键词（短句），用于粗粒度覆盖率 */
export function requirementKeywords(text: string, max = 80): string[] {
  const raw = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`]/g, ' ');
  const chunks = raw.split(/[\n。；;！!？?，,、|]+/);
  const out: string[] = [];
  for (const chunk of chunks) {
    const s = chunk.replace(/^[\s\-*\d.、)）]+/, '').trim();
    if (s.length < 3 || s.length > 24) continue;
    if (out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export interface RuleAudit {
  metrics: ReviewMetric[];
  cases: CaseVerdict[];
  dimensions: Record<DimensionKey, number>;
  score: number;
  counts: Record<Verdict, number>;
}

/**
 * 规则侧体检：七项指标 + 每条用例的五维分、硬伤与扣分项。
 * 不依赖模型，模型不可用时界面照样有结论。
 */
export function auditCases(rows: readonly CaseRow[], requirement = ''): RuleAudit {
  // 表头可能是用户模板里的别名（`测试项目` / `期望内容标准`），先补标准字段再判
  const list = canonicalizeRows(rows);
  const total = list.length;
  const keywords = requirementKeywords(requirement);

  const perCase = list.map((row) => {
    const no = String(row['用例编号'] ?? '').trim();
    const title = String(row['用例标题'] ?? '').trim();
    const steps = splitSteps(row['测试步骤'] ?? '');
    const expected = String(row['预期结果'] ?? '').trim();
    const pre = String(row['前置条件'] ?? '').trim();
    const priority = String(row['优先级'] ?? '')
      .trim()
      .toUpperCase();
    const type = String(row['用例类型'] ?? '').trim();
    const module = String(row['所属模块'] ?? '').trim();
    const hay = `${title} ${steps.join(' ')} ${expected}`;

    const hard: string[] = [];
    if (!title) hard.push('用例标题为空');
    if (!steps.length) hard.push('测试步骤为空');
    if (!expected) hard.push('预期结果为空');
    if (/^(同上|同前|同上一条|略)$/.test(expected)) hard.push('预期结果只有占位文字');

    const coverage = (() => {
      let s = module ? 60 : 25;
      if (keywords.length) {
        const hit = keywords.some((k) => hay.includes(k));
        s += hit ? 40 : 0;
      } else {
        s += 30;
      }
      return clamp(s);
    })();

    const stepsScore = (() => {
      if (!steps.length) return 0;
      let s = steps.length >= 3 ? 100 : steps.length === 2 ? 80 : 50;
      if (steps.some((x) => STEP_NOISE.test(x))) s -= 25;
      if (steps.length === 1 && steps[0].length > 80) s -= 15;
      return clamp(s);
    })();

    const expectedScore = (() => {
      if (!expected) return 0;
      if (VAGUE_EXPECT.test(expected)) return 45;
      if (!expectedTestable(expected)) return 65;
      return expected.length >= 12 ? 100 : 90;
    })();

    const dataScore = (() => {
      let s = pre ? 60 : 20;
      if (isBoundaryOrException(row)) s += 40;
      else s += 15;
      return clamp(s);
    })();

    const conventionScore = (() => {
      let s = 100;
      if (!no) s -= 25;
      if (title.length < 6 || title.length > 60) s -= 20;
      if (!['P0', 'P1', 'P2', 'P3'].includes(priority)) s -= 20;
      if (!type) s -= 20;
      return clamp(s);
    })();

    const dimensions: Record<DimensionKey, number> = {
      coverage,
      steps: stepsScore,
      expected: expectedScore,
      data: dataScore,
      convention: conventionScore,
    };

    const deductions: Deduction[] = [];
    if (!title) {
      deductions.push({
        dimension: 'convention',
        points: 15,
        reason: '用例标题为空，无法从列表里认出这条用例测什么',
        suggestion: '补一句「动词 + 对象 + 条件」的标题，例如「未登录用户提交订单时提示先登录」',
      });
    }
    if (!steps.length) {
      deductions.push({
        dimension: 'steps',
        points: 25,
        reason: '测试步骤为空，无法执行',
        suggestion: '按「一步一个动作」补步骤，从进入路径写到触发动作',
      });
    }
    if (!expected) {
      deductions.push({
        dimension: 'expected',
        points: 20,
        reason: '预期结果为空，无法判定是否通过',
        suggestion: '补可判定的结果：页面 / 状态 / 文案 / 数值',
      });
    } else if (!expectedTestable(expected)) {
      deductions.push({
        dimension: 'expected',
        points: 8,
        reason: `预期结果不够可判定：「${expected.slice(0, 30)}」`,
        suggestion: '写成具体状态或文案，例如「提示『手机号格式不正确』，输入框标红且不提交」',
      });
    }
    if (!pre) {
      deductions.push({
        dimension: 'data',
        points: 6,
        reason: '没有前置条件，执行者不知道该用什么账号 / 数据 / 状态',
        suggestion: '补上需要的角色、数据量与初始状态（如「已登录普通用户，购物车有 1 件商品」）',
      });
    }
    if (!isBoundaryOrException(row)) {
      deductions.push({
        dimension: 'data',
        points: 5,
        reason: '这条用例没有体现边界或异常路径',
        suggestion: '确认是否需要补一条空值 / 上下限 / 失败路径的用例',
      });
    }
    if (!no) {
      deductions.push({
        dimension: 'convention',
        points: 5,
        reason: '缺少用例编号，无法在报告或缺陷里互相引用',
        suggestion: '按项目规则补编号（如 TC-模块-001）',
      });
    }

    const score = weightedScore(dimensions);
    const verdict: Verdict = hard.length
      ? 'invalid'
      : score >= VERDICT_THRESHOLDS.usable
        ? 'usable'
        : score >= VERDICT_THRESHOLDS.revise
          ? 'revise'
          : 'invalid';

    return {
      no,
      title,
      verdict,
      score,
      dimensions,
      deductions,
      hard: hard.join('；'),
      contentFp: caseContentFingerprint(row),
    } satisfies CaseVerdict;
  });

  const counts: Record<Verdict, number> = { usable: 0, revise: 0, invalid: 0 };
  for (const c of perCase) counts[c.verdict] += 1;

  const dupSet = new Map<string, number>();
  for (const row of list) {
    const key = fingerprint(row);
    // 标题与步骤都空的指纹会互相「重复」，这类行按硬伤算，不计入重复率
    if (key === '|') continue;
    dupSet.set(key, (dupSet.get(key) ?? 0) + 1);
  }
  const dupRows = [...dupSet.values()].reduce((n, c) => n + (c > 1 ? c : 0), 0);

  const dims = averageDimensions(perCase);
  const score = weightedScore(dims);

  /** 文件里实际存在的标准字段（用 canonicalizeRows 补进来的那些） */
  const presentFields = CASE_FIELDS.filter((f) => list.some((row) => f in row));
  const complete = completeCount(list, presentFields);

  return {
    metrics: [
      {
        key: 'total',
        label: '用例总数',
        value: total,
        text: `${total}`,
        hint: '本文件里的用例条数',
      },
      {
        key: 'fieldComplete',
        label: '字段完整率',
        value: total ? complete / total : 0,
        text: percent(total ? complete / total : 0),
        hint: `文件里的 ${presentFields.length} 个字段是否都有内容`,
      },
      {
        key: 'stepExecutable',
        label: '步骤可执行率',
        value: total
          ? list.filter((r) => splitSteps(r['测试步骤'] ?? '').length >= 2).length / total
          : 0,
        text: percent(
          total
            ? list.filter((r) => splitSteps(r['测试步骤'] ?? '').length >= 2).length / total
            : 0,
        ),
        hint: '有编号且至少两步',
      },
      {
        key: 'expectedTestable',
        label: '预期可判定率',
        value: total ? list.filter((r) => expectedTestable(r['预期结果'] ?? '')).length / total : 0,
        text: percent(
          total ? list.filter((r) => expectedTestable(r['预期结果'] ?? '')).length / total : 0,
        ),
        hint: '排除「正常 / 符合预期」这类模糊表述',
      },
      {
        key: 'coverage',
        label: '需求覆盖率',
        value: keywords.length ? Math.min(1, dims.coverage / 100) : -1,
        text: keywords.length ? percent(Math.min(1, dims.coverage / 100)) : '—',
        hint: keywords.length ? '与对照需求的关键点做匹配' : '未挂对照需求，不计算',
      },
      {
        key: 'duplicate',
        label: '重复用例率',
        value: total ? dupRows / total : 0,
        text: percent(total ? dupRows / total : 0),
        hint: '标题 + 步骤完全相同',
      },
      {
        key: 'priority',
        label: '优先级合规率',
        value: total
          ? list.filter((r) =>
              ['P0', 'P1', 'P2', 'P3'].includes(String(r['优先级'] ?? '').toUpperCase()),
            ).length / total
          : 0,
        text: percent(
          total
            ? list.filter((r) =>
                ['P0', 'P1', 'P2', 'P3'].includes(String(r['优先级'] ?? '').toUpperCase()),
              ).length / total
            : 0,
        ),
        hint: '优先级为 P0–P3 之一',
      },
      {
        key: 'hard',
        label: '硬伤用例',
        value: perCase.filter((c) => c.hard).length,
        text: `${perCase.filter((c) => c.hard).length}`,
        hint: '标题 / 步骤 / 预期为空或冲突，直接判无效',
      },
    ],
    cases: perCase,
    dimensions: dims,
    score,
    counts,
  };
}

function clamp(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

function weightedScore(dims: Record<DimensionKey, number>): number {
  let sum = 0;
  for (const key of DIMENSION_ORDER) sum += dims[key] * (DIMENSION_META[key].weight / 100);
  return clamp(sum);
}

function averageDimensions(cases: readonly CaseVerdict[]): Record<DimensionKey, number> {
  const out = {} as Record<DimensionKey, number>;
  for (const key of DIMENSION_ORDER) {
    if (!cases.length) {
      out[key] = 0;
      continue;
    }
    out[key] = clamp(cases.reduce((n, c) => n + (c.dimensions[key] ?? 0), 0) / cases.length);
  }
  return out;
}

/**
 * 字段完整率：只看这份文件里真的有的字段。
 * 模板没有「用例类型」这一列时不该算它缺失，否则完整率永远是 0。
 */
function completeCount(rows: readonly CaseRow[], fields: readonly string[]): number {
  const need = fields.length ? fields : CASE_FIELDS;
  return rows.filter((row) => need.every((f) => String(row[f] ?? '').trim())).length;
}

export function percent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

const WEAK_DIM_HINT: Record<DimensionKey, string> = {
  coverage: '需求覆盖偏低：写清对应需求点 / 模块，补主流程或关键分支',
  steps: '步骤可执行偏低：拆成一步一个动作、补进入路径，避免笼统「验证功能」',
  expected: '预期可判定偏低：写出可核对的状态 / 文案 / 数值，避免「正常」「成功」',
  data: '数据与边界偏低：补前置账号与数据，并覆盖空值 / 上下限 / 异常路径',
  convention: '规范完整偏低：核对编号、标题、优先级、类型是否与模板一致',
};

/**
 * 把一条用例的扣分项收敛成「修改建议」列表：优先用建议，没有建议就退回原因。
 * 无扣分项但判定为待修改/错误无效时，按低于可用线的维度补建议。
 */
export function caseSuggestions(v: Partial<CaseVerdict>, max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const key = text.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text.length > 240 ? `${text.slice(0, 238)}…` : text);
  };
  for (const d of v.deductions ?? []) {
    push(String(d?.suggestion || d?.reason || ''));
    if (out.length >= max) return out;
  }
  if (out.length === 0 && (v.verdict === 'revise' || v.verdict === 'invalid') && v.dimensions) {
    for (const key of DIMENSION_ORDER) {
      const score = v.dimensions[key];
      if (typeof score === 'number' && score < VERDICT_THRESHOLDS.usable) {
        push(`${DIMENSION_META[key].label} ${score}：${WEAK_DIM_HINT[key]}`);
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

export function dimensionScores(dims: Record<DimensionKey, number>): DimensionScore[] {
  return DIMENSION_ORDER.map((key) => ({
    key,
    label: DIMENSION_META[key].label,
    score: clamp(dims[key] ?? 0),
    weight: DIMENSION_META[key].weight,
  }));
}

/**
 * 模型结论合并：维度分用模型的（缺失回落到规则分），扣分项优先用模型的；
 * 判定与总分由本文件按阈值重算，硬伤（规则命中或模型给出的证据）直接「错误无效」。
 *
 * 为什么不直接用模型给的 verdict：模型常常一边给 86 分一边判「错误无效」，
 * 页面就会出现「86 分 · 错误无效」这种自相矛盾的结果。这里只认两样东西——
 * 硬伤证据与加权分，模型想判无效就请把证据写进 `hard`，或把维度分压低。
 */
/** 用例在报告里的身份键：优先编号，否则标题（与 mergeModelReview 对齐） */
export function caseIdentityKey(c: { no?: string; title?: string }): string {
  return String(c.no ?? '').trim() || String(c.title ?? '').trim();
}

/** 盲区条目去重 / 已写回匹配键 */
export function blindspotIdentityKey(c: { category: string; title: string }): string {
  return `${c.category}|${c.title.trim()}`;
}

/**
 * @deprecated 旧「跳过已修改并升可用」；抽屉改用 stitchPartialReview。
 */
export function stitchReviewSkippingFixed(
  fullOrder: readonly CaseVerdict[],
  reviewed: CaseReviewReport,
  fixedKeys: ReadonlySet<string>,
  prevByKey: ReadonlyMap<string, CaseVerdict>,
  fullMetrics?: ReviewMetric[],
): CaseReviewReport {
  return stitchPartialReview(fullOrder, reviewed, fixedKeys, prevByKey, fullMetrics);
}

/**
 * 子集评审合并：reviewedKeys 用本轮结果；其余（含已忽略）保留上次判定。
 * 同步当前行 title / contentFp；保留 prev.ignored。
 */
export function stitchPartialReview(
  fullOrder: readonly CaseVerdict[],
  reviewed: CaseReviewReport,
  reviewedKeys: ReadonlySet<string>,
  prevByKey: ReadonlyMap<string, CaseVerdict>,
  fullMetrics?: ReviewMetric[],
): CaseReviewReport {
  const reviewedByKey = new Map(
    reviewed.cases.map((c) => [caseIdentityKey(c), c] as const).filter(([k]) => k),
  );
  const cases = fullOrder.map((base) => {
    const key = caseIdentityKey(base);
    if (key && reviewedKeys.has(key)) {
      const hit = reviewedByKey.get(key) ?? base;
      const prev = prevByKey.get(key);
      const next: CaseVerdict = {
        ...hit,
        contentFp: base.contentFp ?? hit.contentFp,
        title: hit.title || base.title,
        fixed: false,
      };
      if (prev?.ignored) next.ignored = true;
      else delete next.ignored;
      return next;
    }
    const prev = key ? prevByKey.get(key) : undefined;
    if (prev) {
      return {
        ...prev,
        title: base.title || prev.title,
        contentFp: base.contentFp ?? prev.contentFp,
        ...(prev.ignored ? { ignored: true } : {}),
      } satisfies CaseVerdict;
    }
    return base;
  });
  const counts: Record<Verdict, number> = { usable: 0, revise: 0, invalid: 0 };
  for (const c of cases) {
    if (c.ignored) continue;
    counts[c.verdict] += 1;
  }
  const dims = averageDimensions(cases.filter((c) => !c.ignored));
  const kept = fullOrder.length - reviewedKeys.size;
  const coveredBase = reviewed.modelCovered ?? reviewed.cases.length;
  return {
    ...reviewed,
    metrics: fullMetrics ?? reviewed.metrics,
    score: weightedScore(dims),
    counts,
    dimensions: dimensionScores(dims),
    cases,
    modelCovered: Math.min(cases.length, coveredBase + Math.max(0, kept)),
  };
}

/** 需改条数：待修改 + 错误无效，排除已忽略与已修改 */
export function countNeedFix(
  cases: readonly CaseVerdict[],
  autoFixedKeys?: ReadonlySet<string>,
): number {
  let n = 0;
  for (const c of cases) {
    if (c.ignored) continue;
    const key = caseIdentityKey(c);
    if (c.fixed || (key && autoFixedKeys?.has(key))) continue;
    if (c.verdict === 'revise' || c.verdict === 'invalid') n += 1;
  }
  return n;
}

export function mergeModelReview(
  rule: RuleAudit,
  modelCases: readonly Partial<CaseVerdict>[],
  summary: string,
): CaseReviewReport {
  const byNo = new Map<string, Partial<CaseVerdict>>();
  for (const item of modelCases) {
    const key = String(item.no ?? '').trim() || String(item.title ?? '').trim();
    if (key) byNo.set(key, item);
  }

  /** 模型真正逐条评到的条数：用来判断整批是否都被评过 */
  let covered = 0;
  const cases = rule.cases.map((base) => {
    const hit = byNo.get(base.no) ?? byNo.get(base.title);
    if (!hit) return base;
    covered += 1;
    const dimensions = { ...base.dimensions };
    for (const key of DIMENSION_ORDER) {
      const v = hit.dimensions?.[key];
      if (typeof v === 'number' && Number.isFinite(v)) dimensions[key] = clamp(v);
    }
    const modelDeductions = Array.isArray(hit.deductions)
      ? hit.deductions
          .filter((d) => d && d.reason)
          .map((d) => ({
            dimension: (DIMENSION_ORDER.includes(d.dimension)
              ? d.dimension
              : 'expected') as DimensionKey,
            points: clamp(Number(d.points) || 0),
            reason: String(d.reason ?? '').slice(0, 1000),
            suggestion: String(d.suggestion ?? '').slice(0, 1000),
          }))
      : [];
    const score = weightedScore(dimensions);
    // 模型给的 hard 只当作证据，不当作分数：有证据才允许「分数够高也算无效」
    const hard = base.hard || String(hit.hard ?? '').trim() || undefined;
    const verdict: Verdict = hard
      ? 'invalid'
      : score >= VERDICT_THRESHOLDS.usable
        ? 'usable'
        : score >= VERDICT_THRESHOLDS.revise
          ? 'revise'
          : 'invalid';
    const next: CaseVerdict = {
      ...base,
      verdict,
      score,
      dimensions,
      deductions: modelDeductions.length ? modelDeductions : base.deductions,
      fixed: false,
    };
    // 只有真的有证据才挂 hard 字段，避免旧报告里留下空串
    if (hard) next.hard = hard;
    else delete next.hard;
    return next;
  });

  const counts: Record<Verdict, number> = { usable: 0, revise: 0, invalid: 0 };
  for (const c of cases) counts[c.verdict] += 1;
  const dims = averageDimensions(cases);

  return {
    at: new Date().toISOString(),
    score: weightedScore(dims),
    counts,
    dimensions: dimensionScores(dims),
    metrics: rule.metrics,
    cases,
    summary: summary.trim(),
    modeled: true,
    modelCovered: covered,
  };
}

/**
 * 读旧报告时对齐一次判定与标题：
 * - 老版本会直接采信模型给的 verdict，出现过「86 分却错误无效」；按分数与硬伤重算；
 * - 老版本表头映射错时标题是空的，按编号从当前文件回填。
 * 只在内存里修，不写回磁盘；重新评审后自然就是新结果。
 */
export function normalizeReport(
  report: CaseReviewReport,
  rows?: readonly CaseRow[],
): CaseReviewReport {
  const titleByNo = new Map<string, string>();
  const byId = rows?.length ? rowByCaseIdentity(rows) : new Map<string, CaseRow>();
  if (rows?.length) {
    for (const row of canonicalizeRows(rows)) {
      const no = String(row[CASE_FIELD_NAME.no] ?? '').trim();
      const title = String(row[CASE_FIELD_NAME.title] ?? '').trim();
      if (no && title) titleByNo.set(no, title);
    }
  }

  let changed = false;
  const cases = report.cases.map((item) => {
    const title = item.title || titleByNo.get(String(item.no ?? '').trim()) || '';
    const row =
      byId.get(String(item.no ?? '').trim()) ?? byId.get(String(item.title ?? '').trim() || title);
    // 旧报告缺指纹：用当前行作基线回填，不因此标「已修改」
    const contentFp = item.contentFp || (row ? caseContentFingerprint(row) : undefined);
    // 已显式标已修改：只回填标题 / 指纹，不按分数改写判定
    if (item.fixed) {
      if (title === item.title && contentFp === item.contentFp) return item;
      changed = true;
      return {
        ...item,
        title,
        ...(contentFp ? { contentFp } : {}),
      } satisfies CaseVerdict;
    }
    const verdict: Verdict = item.hard
      ? 'invalid'
      : item.score >= VERDICT_THRESHOLDS.usable
        ? 'usable'
        : item.score >= VERDICT_THRESHOLDS.revise
          ? 'revise'
          : 'invalid';
    if (title === item.title && verdict === item.verdict && contentFp === item.contentFp) {
      return item;
    }
    changed = true;
    return {
      ...item,
      title,
      verdict,
      ...(contentFp ? { contentFp } : {}),
    } satisfies CaseVerdict;
  });
  if (!changed) return report;

  const counts: Record<Verdict, number> = { usable: 0, revise: 0, invalid: 0 };
  for (const c of cases) {
    if (c.ignored) continue;
    counts[c.verdict] += 1;
  }
  return { ...report, cases, counts };
}

/** 没跑模型时（或模型失败）的纯规则报告 */
export function ruleReviewReport(rule: RuleAudit, summary = ''): CaseReviewReport {
  return {
    at: new Date().toISOString(),
    score: rule.score,
    counts: rule.counts,
    dimensions: dimensionScores(rule.dimensions),
    metrics: rule.metrics,
    cases: rule.cases,
    summary:
      summary ||
      `规则判定：可用 ${rule.counts.usable} · 待修改 ${rule.counts.revise} · 错误无效 ${rule.counts.invalid}。未接入模型，语义类问题（与需求冲突、预期与步骤无关）未计入。`,
    modeled: false,
  };
}

/* ------------------------------ 补全 ------------------------------ */

export function groupBlindspots(
  items: readonly BlindspotItem[],
): { key: BlindspotCategory; items: BlindspotItem[] }[] {
  return BLINDSPOT_ORDER.map((key) => ({
    key,
    items: items.filter((x) => x.category === key),
  })).filter((g) => g.items.length > 0);
}

/** 补全用例编号：TC-BL-001，跳过文件里已有的编号 */
export function nextBlindspotNumbers(existing: readonly CaseRow[], count: number): string[] {
  const used = new Set(existing.map((r) => String(r['用例编号'] ?? '').trim()).filter(Boolean));
  const out: string[] = [];
  let n = 1;
  while (out.length < count) {
    const no = `TC-BL-${String(n).padStart(3, '0')}`;
    n += 1;
    if (used.has(no)) continue;
    out.push(no);
  }
  return out;
}

/**
 * 把勾选的盲区拼成待写回的行。
 * 标题加 `[补全·非功能]` 这类前缀，方便在用例库里一眼认出是补进来的。
 * 传了 headers 时按文件的真实表头写（`测试项目` 这类别名列也会被填上）。
 */
export function blindspotToRows(
  items: readonly BlindspotItem[],
  headers: readonly string[],
  existing: readonly CaseRow[],
): CaseRow[] {
  const nos = nextBlindspotNumbers(existing, items.length);
  const fields = headers.length ? [...headers] : [...CASE_FIELDS];
  const map = headers.length ? caseFieldMap(headers) : {};
  return items.map((item, i) => {
    const meta = BLINDSPOT_META[item.category] ?? BLINDSPOT_META.business;
    const row: CaseRow = {};
    for (const f of fields) row[f] = '';
    row['用例编号'] = nos[i] ?? '';
    row['用例标题'] = `[补全·${meta.mark}] ${item.title}`;
    row['前置条件'] = item.precondition;
    row['测试步骤'] = item.steps.join('\n');
    row['预期结果'] = item.expected;
    row['优先级'] = item.priority;
    row['用例类型'] = `场景补全·${meta.label}`;
    // 有归属需求时填进标准「需求编号」列；Ideal 一类按模块/测试项目分组的文件，
    // 工作台写回会按同组邻行改填真实分组列，这里先给一个可映射的锚点。
    // 「引用需求点」与需求编号分开：写回补全场景时填文档条目名，备注标补充。
    if (item.reqAnchor.trim()) {
      const anchor = item.reqAnchor.trim();
      row['需求编号'] = anchor;
      row['所属模块'] = anchor;
      row['引用需求点'] = anchor;
      const remarkCol = fields.find((h) => /备注/.test(h)) ?? '备注';
      const prevRemark = String(row[remarkCol] ?? '').trim();
      row[remarkCol] = prevRemark
        ? prevRemark.includes('补充：')
          ? prevRemark
          : `${prevRemark}；补充：场景补全`
        : '补充：场景补全';
    }
    // 文件表头是别名时（标题列叫「测试项目」），把标准字段的值搬到那一列
    return applyFieldMap(row, map);
  });
}

/* ------------------------------ 导出 ------------------------------ */

export function reviewToMarkdown(
  fileName: string,
  review: CaseReviewReport | null,
  blindspot: BlindspotReport | null,
): string {
  const lines: string[] = [];
  lines.push(`# 用例质量评审报告 · ${fileName}`);
  lines.push('');
  if (review) {
    lines.push(`- 评审时间：${review.at}`);
    lines.push(`- 总分：${review.score}`);
    lines.push(
      `- 三档：可用 ${review.counts.usable} · 待修改 ${review.counts.revise} · 错误无效 ${review.counts.invalid}`,
    );
    lines.push(`- 来源：${review.modeled ? '规则 + 模型' : '仅规则'}`);
    lines.push('');
    lines.push('## 五维得分');
    lines.push('');
    for (const d of review.dimensions) {
      lines.push(`- ${d.label}（权重 ${d.weight}）：${d.score}`);
    }
    lines.push('');
    lines.push('## 量化指标');
    lines.push('');
    for (const m of review.metrics) lines.push(`- ${m.label}：${m.text}`);
    if (review.summary) {
      lines.push('');
      lines.push('## 结论');
      lines.push('');
      lines.push(review.summary);
    }
    lines.push('');
    lines.push('## 逐条明细');
    lines.push('');
    for (const c of review.cases) {
      lines.push(
        `### ${c.no || '（无编号）'} ${c.title || '（无标题）'} · ${VERDICT_META[c.verdict].label} ${c.score}`,
      );
      if (c.hard) lines.push(`- 硬伤：${c.hard}`);
      for (const d of c.deductions) {
        lines.push(
          `- [${DIMENSION_META[d.dimension]?.label ?? d.dimension} −${d.points}] ${d.reason}`,
        );
        if (d.suggestion) lines.push(`  - 建议：${d.suggestion}`);
      }
      lines.push('');
    }
  } else {
    lines.push('- 还没有质量评审结果。');
    lines.push('');
  }

  if (blindspot?.items.length) {
    lines.push('## 场景补全');
    lines.push('');
    lines.push(`- 探测时间：${blindspot.at}`);
    if (blindspot.context.reqTitle) lines.push(`- 对照需求：${blindspot.context.reqTitle}`);
    lines.push('');
    for (const group of groupBlindspots(blindspot.items)) {
      const meta = BLINDSPOT_META[group.key];
      lines.push(`### ${meta.label}（${group.items.length}）`);
      lines.push('');
      for (const item of group.items) {
        lines.push(
          `- **[${SEVERITY_META[item.severity].label}] ${item.title}**${item.added ? `（已补全 ${item.caseNo}）` : ''}`,
        );
        if (item.reqAnchor) lines.push(`  - 归属需求：${item.reqAnchor}`);
        if (item.why) lines.push(`  - 为什么容易漏：${item.why}`);
        if (item.precondition) lines.push(`  - 前置条件：${item.precondition}`);
        if (item.steps.length) lines.push(`  - 步骤：${item.steps.join(' → ')}`);
        if (item.expected) lines.push(`  - 预期：${item.expected}`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function downloadReviewMarkdown(
  fileName: string,
  review: CaseReviewReport | null,
  blindspot: BlindspotReport | null,
): string {
  const safe = fileName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const day = new Date().toISOString().slice(0, 10);
  const name = `${safe}-用例评审-${day}.md`;
  const blob = new Blob([reviewToMarkdown(fileName, review, blindspot)], {
    type: 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

/* ------------------------------ 接口 ------------------------------ */

async function request<T>(base: string, pathSuffix: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${pathSuffix}`, {
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

async function health(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export function fetchCaseReviewHealth(): Promise<boolean> {
  return health(CASE_REVIEW_API);
}

export function fetchBlindspotHealth(): Promise<boolean> {
  return health(BLINDSPOT_API);
}

export async function fetchCaseReviewPrompt(): Promise<CaseReviewPrompt> {
  try {
    const json = await request<{ file: string; exists: boolean; review: string }>(
      CASE_REVIEW_API,
      '/prompt',
    );
    return {
      file: json.file || CASE_REVIEW_PROMPT_FILE,
      exists: json.exists === true,
      review: json.review ?? '',
    };
  } catch (err) {
    return {
      file: CASE_REVIEW_PROMPT_FILE,
      exists: false,
      review: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchBlindspotPrompt(): Promise<BlindspotPrompt> {
  try {
    const json = await request<{
      file: string;
      exists: boolean;
      detect: string;
      complete: string;
    }>(BLINDSPOT_API, '/prompt');
    return {
      file: json.file || BLINDSPOT_PROMPT_FILE,
      exists: json.exists === true,
      detect: json.detect ?? '',
      complete: json.complete ?? '',
    };
  } catch (err) {
    return {
      file: BLINDSPOT_PROMPT_FILE,
      exists: false,
      detect: '',
      complete: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function syncCaseReviewPrompt(enabled: boolean): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(CASE_REVIEW_API, '/prompt/sync', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export function syncBlindspotPrompt(enabled: boolean): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(BLINDSPOT_API, '/prompt/sync', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export async function fetchCaseReviewSummaries(): Promise<CaseReviewSummary[]> {
  const json = await request<{ files: CaseReviewSummary[] }>(CASE_REVIEW_API, '/summaries');
  return json.files ?? [];
}

export async function fetchCaseReviewEntry(filePath: string): Promise<{
  entry: CaseReviewEntry | null;
  stale: boolean;
}> {
  const json = await request<{ entry: CaseReviewEntry | null; stale: boolean }>(
    CASE_REVIEW_API,
    `/report?path=${encodeURIComponent(filePath)}`,
  );
  return { entry: json.entry ?? null, stale: json.stale === true };
}

export async function saveCaseReviewEntry(
  filePath: string,
  patch: { review?: CaseReviewReport | null; blindspot?: BlindspotReport | null },
): Promise<CaseReviewEntry> {
  const json = await request<{ entry: CaseReviewEntry }>(CASE_REVIEW_API, '/report', {
    method: 'PUT',
    body: JSON.stringify({ path: filePath, ...patch }),
  });
  return json.entry;
}

export async function appendCaseRows(opts: {
  path: string;
  headers: string[];
  rows: CaseRow[];
  marks?: Record<string, string>;
}): Promise<{ appended: number; backup: string }> {
  return request<{ appended: number; backup: string }>(CASE_REVIEW_API, '/append', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export interface CaseReviewBackupItem {
  name: string;
  /** 相对空间根的路径 */
  path: string;
  size: number;
  mtime: number;
}

export async function fetchCaseReviewBackups(): Promise<CaseReviewBackupItem[]> {
  const json = await request<{ items: CaseReviewBackupItem[] }>(CASE_REVIEW_API, '/backups');
  return json.items ?? [];
}

export async function deleteCaseReviewBackups(names: string[]): Promise<{ deleted: string[] }> {
  const json = await request<{ deleted: string[] }>(CASE_REVIEW_API, '/backups/delete', {
    method: 'POST',
    body: JSON.stringify({ names }),
  });
  return { deleted: json.deleted ?? [] };
}
