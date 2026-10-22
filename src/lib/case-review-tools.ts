/**
 * 用例评审插件给模型用的工具：提交逐条判定 / 提交盲区清单。
 *
 * 模型在浏览器里跑（`streamChatWithTools`），工具只在内存里收集结果，
 * 由调用方合并、重算分数，再一次性 PUT 到 `/__tb_casereview/report`。
 */
import type { ToolDef } from './llm';
import {
  BLINDSPOT_ORDER,
  DIMENSION_ORDER,
  type BlindspotCategory,
  type BlindspotItem,
  type BlindspotSeverity,
  type CaseVerdict,
  type Deduction,
  type DimensionKey,
} from './case-review';

export interface CaseReviewToolContext {
  /** 收集模型的逐条判定 */
  onCases: (cases: CaseVerdict[], summary: string) => void;
  /** 收集模型探测到的盲区 */
  onBlindspots: (items: BlindspotItem[], summary: string) => void;
  /** 已经存在的盲区 id（补全时原地更新） */
  existingIds?: string[];
}

export const CASE_REVIEW_TOOL_GUIDE = `可用工具（只调用这些，不要自己编工具名）：
- case_save_review：提交逐条用例判定（verdict / 五个维度分 / 扣分原因与建议），一次提交整批。
- case_save_blindspots：提交探测到的场景盲区（四类之一 + 可执行字段），一次提交全部。

提交后不要重复提交同样的内容；工具返回 ok 之后再写最终回答。`;

const DIMENSION_ALIAS: Record<string, DimensionKey> = {
  coverage: 'coverage',
  steps: 'steps',
  expected: 'expected',
  data: 'data',
  convention: 'convention',
  需求覆盖: 'coverage',
  步骤可执行: 'steps',
  预期可判定: 'expected',
  数据与边界: 'data',
  规范完整: 'convention',
};

const CATEGORY_ALIAS: Record<string, BlindspotCategory> = {
  nonfunctional: 'nonfunctional',
  security: 'security',
  compatibility: 'compatibility',
  business: 'business',
  非功能: 'nonfunctional',
  安全: 'security',
  兼容: 'compatibility',
  业务: 'business',
};

function asObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback;
}

function dimensionOf(value: unknown): DimensionKey {
  const key = str(value, 40);
  return DIMENSION_ALIAS[key] ?? DIMENSION_ALIAS[key.toLowerCase()] ?? 'expected';
}

function categoryOf(value: unknown): BlindspotCategory {
  const key = str(value, 40);
  return CATEGORY_ALIAS[key] ?? CATEGORY_ALIAS[key.toLowerCase()] ?? 'business';
}

function severityOf(value: unknown): BlindspotSeverity {
  const v = str(value, 10).toLowerCase();
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'medium';
}

function priorityOf(value: unknown): string {
  const v = str(value, 4).toUpperCase();
  return ['P0', 'P1', 'P2', 'P3'].includes(v) ? v : 'P1';
}

function deductionOf(raw: unknown): Deduction | null {
  if (!raw || typeof raw !== 'object') return null;
  const reason = str((raw as Record<string, unknown>).reason, 1000);
  if (!reason) return null;
  const o = raw as Record<string, unknown>;
  return {
    dimension: dimensionOf(o.dimension),
    points: num(o.points, 0),
    reason,
    suggestion: str(o.suggestion, 1000),
  };
}

function caseVerdictOf(raw: unknown): CaseVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const no = str(o.no, 80);
  const title = str(o.title, 300);
  if (!no && !title) return null;
  const dimsRaw = o.dimensions && typeof o.dimensions === 'object' ? o.dimensions : {};
  const dimensions = {} as Record<DimensionKey, number>;
  for (const key of DIMENSION_ORDER)
    dimensions[key] = num((dimsRaw as Record<string, unknown>)[key], 0);
  const verdict = str(o.verdict, 20);
  // hard 是「判错误无效」的证据：只有给了证据，合并时才允许分数够高也判无效
  const hard = str(o.hard, 500);
  const parsed: CaseVerdict = {
    no,
    title,
    verdict: verdict === 'usable' || verdict === 'invalid' ? verdict : 'revise',
    score: num(o.score, 0),
    dimensions,
    deductions: Array.isArray(o.deductions)
      ? o.deductions
          .map(deductionOf)
          .filter((x): x is Deduction => Boolean(x))
          .slice(0, 20)
      : [],
  };
  if (hard) parsed.hard = hard;
  return parsed;
}

function blindspotOf(raw: unknown): BlindspotItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = str(o.title, 300);
  if (!title) return null;
  const id = str(o.id, 40);
  return {
    id: /^bs_[A-Za-z0-9_-]{4,40}$/.test(id) ? id : '',
    category: categoryOf(o.category),
    severity: severityOf(o.severity),
    title,
    why: str(o.why, 1000),
    precondition: str(o.precondition, 1000),
    steps: Array.isArray(o.steps)
      ? o.steps
          .map((x) => str(x, 1000))
          .filter(Boolean)
          .slice(0, 20)
      : [],
    expected: str(o.expected, 1000),
    priority: priorityOf(o.priority),
    added: false,
    caseNo: '',
  };
}

export const CASE_REVIEW_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'case_save_review',
      description:
        '提交用例质量评审结果：逐条给 verdict、五个维度分与扣分原因/建议。一次提交整批，不要一条调一次。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '整体结论，两三句话，指出最该先改的三条' },
          cases: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                no: { type: 'string', description: '用例编号，原样返回' },
                title: { type: 'string', description: '用例标题，原样返回' },
                verdict: {
                  type: 'string',
                  enum: ['usable', 'revise', 'invalid'],
                  description:
                    '可用 / 待修改 / 错误无效（系统最终按维度加权分与 hard 重算，分数与判定要自洽）',
                },
                hard: {
                  type: 'string',
                  description:
                    '判「错误无效」时必须写清硬伤证据（与需求哪条冲突 / 和哪条重复）；没有硬伤就留空',
                },
                dimensions: {
                  type: 'object',
                  description: '五维分数，0–100 整数',
                  properties: Object.fromEntries(
                    DIMENSION_ORDER.map((key) => [key, { type: 'number', description: key }]),
                  ),
                  required: [...DIMENSION_ORDER],
                },
                deductions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      dimension: { type: 'string', enum: [...DIMENSION_ORDER] },
                      points: { type: 'number', description: '这一项扣几分' },
                      reason: { type: 'string', description: '具体到位置与原因' },
                      suggestion: { type: 'string', description: '要补什么' },
                    },
                    required: ['dimension', 'reason'],
                  },
                },
              },
              required: ['no', 'verdict', 'dimensions'],
            },
          },
        },
        required: ['cases'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_save_blindspots',
      description:
        '提交场景遗漏补全的盲区清单：四类之一（nonfunctional / security / compatibility / business），每条带可执行字段。补全时带原 id 原地更新。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '整体结论：几条、四类各几条、风险最高的三条' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '补全已有条目时才带（bs_ 开头）' },
                category: { type: 'string', enum: [...BLINDSPOT_ORDER] },
                severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                title: { type: 'string', description: '一句话说清测什么' },
                why: { type: 'string', description: '为什么人工容易漏' },
                precondition: { type: 'string', description: '账号 / 数据 / 初始状态' },
                steps: { type: 'array', items: { type: 'string' } },
                expected: { type: 'string', description: '可判定的预期结果' },
                priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
              },
              required: ['category', 'title'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
];

/** 工具执行器：结果只落到 ctx，返回给模型的是短摘要 */
export async function runCaseReviewTool(
  name: string,
  argsJson: string,
  ctx: CaseReviewToolContext,
): Promise<string> {
  const args = asObject(argsJson);

  if (name === 'case_save_review') {
    const cases = (Array.isArray(args.cases) ? args.cases : [])
      .map(caseVerdictOf)
      .filter((x): x is CaseVerdict => Boolean(x));
    if (!cases.length) return JSON.stringify({ ok: false, error: '没有解析到任何用例判定' });
    ctx.onCases(cases, str(args.summary, 2000));
    return JSON.stringify({
      ok: true,
      count: cases.length,
      usable: cases.filter((c) => c.verdict === 'usable').length,
      invalid: cases.filter((c) => c.verdict === 'invalid').length,
    });
  }

  if (name === 'case_save_blindspots') {
    const items = (Array.isArray(args.items) ? args.items : [])
      .map(blindspotOf)
      .filter((x): x is BlindspotItem => Boolean(x))
      .slice(0, 300);
    if (!items.length) return JSON.stringify({ ok: false, error: '没有解析到任何盲区条目' });
    ctx.onBlindspots(items, str(args.summary, 2000));
    return JSON.stringify({
      ok: true,
      count: items.length,
      categories: BLINDSPOT_ORDER.map((key) => [
        key,
        items.filter((x) => x.category === key).length,
      ]).filter(([, n]) => Number(n) > 0),
    });
  }

  return JSON.stringify({ ok: false, error: `未知工具：${name}` });
}
