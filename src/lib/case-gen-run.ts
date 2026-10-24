/**
 * 用例生成插件：构建系统提示、解析 JSON、写入 cases/、生成用户可见摘要
 */
import { caseTypeMeta, listCaseTypes, type CaseOutputFormat, type CaseType } from './case-sessions';
import {
  normalizeCaseRows,
  rowsToCsv,
  rowsToMarkdown,
  rowsToXlsxBase64,
  type CaseRow,
} from './case-template';
import { caseFieldMap, CASE_FIELD_NAME } from './case-fields';
import { CASE_FIELDS } from './export';
import { caseGenReqSource, type CaseGenPluginConfig } from './case-gen-config';
import { isPluginEnabled, pluginDisabledMessage } from './plugins';
import { writeDocsBinary, writeDocsText } from './project-docs';

export interface CaseGenMetaPayload {
  docTitle: string;
  cases: unknown[];
  coverageRate: number | null;
  uncovered: string[];
  writeNote: string;
}

export function extractCaseJsonPayload(text: string): CaseGenMetaPayload | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0] ?? text.match(/\[[\s\S]*\]/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return {
        docTitle: '',
        cases: parsed,
        coverageRate: null,
        uncovered: [],
        writeNote: '',
      };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const cases = obj['用例'] ?? obj.cases ?? obj.items;
      if (!Array.isArray(cases) || cases.length === 0) return null;
      const titleRaw = obj['需求名称'] ?? obj['文档名称'] ?? obj.docTitle ?? obj.title;
      const docTitle = typeof titleRaw === 'string' ? titleRaw.trim() : '';
      const covRaw = obj['覆盖需求率'] ?? obj.coverageRate ?? obj.coverage;
      let coverageRate: number | null = null;
      if (typeof covRaw === 'number' && Number.isFinite(covRaw)) {
        coverageRate = Math.max(0, Math.min(100, Math.round(covRaw)));
      } else if (typeof covRaw === 'string' && covRaw.trim()) {
        const n = parseInt(covRaw.replace(/%/g, ''), 10);
        if (Number.isFinite(n)) coverageRate = Math.max(0, Math.min(100, n));
      }
      const uncoveredRaw = obj['未覆盖说明'] ?? obj.uncovered ?? obj.omissions;
      const uncovered = Array.isArray(uncoveredRaw)
        ? uncoveredRaw.map((x) => String(x).trim()).filter(Boolean)
        : typeof uncoveredRaw === 'string' && uncoveredRaw.trim()
          ? [uncoveredRaw.trim()]
          : [];
      const noteRaw = obj['编写说明'] ?? obj.note ?? obj.summary;
      const writeNote = typeof noteRaw === 'string' ? noteRaw.trim() : '';
      return { docTitle, cases, coverageRate, uncovered, writeNote };
    }
  } catch {
    return null;
  }
  return null;
}

function safeFileBase(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '-')
      .slice(0, 64) || 'cases'
  );
}

/**
 * 把需求文档名收成「需求 + 迭代版本」前缀。
 * 例：`政企通v1.16.0版本_需求文档.xlsx` → `政企通v1.16.0迭代版本`
 */
export function caseGenReqStem(title: string): string {
  let base =
    String(title ?? '')
      .trim()
      .split(/[/\\]/)
      .pop()
      ?.trim() || '';
  base = base.replace(/\.(xlsx|xls|docx|doc|md|txt|csv)$/i, '');
  base = base
    .replace(/_?需求文档$/u, '')
    .replace(/_?需求说明$/u, '')
    .replace(/_?需求$/u, '')
    .trim();
  // 标题里若已带用例类型 / 时间戳，先剥掉
  base = base.replace(/_\d{8}-\d{6}$/, '');
  for (const t of listCaseTypes()) {
    const known = `_${t.label}用例`;
    if (base.endsWith(known)) {
      base = base.slice(0, -known.length);
      break;
    }
  }
  if (/迭代版本$/u.test(base)) {
    return safeFileBase(base);
  }
  // `…v1.16.0版本` / `…V1.16版本` → `…v1.16.0迭代版本`
  if (/v?\d+(?:\.\d+)*版本$/iu.test(base)) {
    return safeFileBase(base.replace(/版本$/u, '迭代版本'));
  }
  // 仅有版本号：`政企通v1.16.0` → 补「迭代版本」
  if (/v\d+(?:\.\d+)+$/i.test(base)) {
    return safeFileBase(`${base}迭代版本`);
  }
  return safeFileBase(base);
}

/**
 * 对照匹配键：产品前缀 + 版本号，不含「版本 / 迭代版本」。
 * 例：`政企通v1.16.0版本_需求文档` / `政企通v1.16.0迭代版本_功能测试用例_…` → `政企通v1.16.0`
 * 后面文件名用「版本」还是「迭代版本」都不影响对上。
 */
export function caseReqMatchKey(titleOrFile: string): string {
  // 先走 stem，剥掉需求文档 / 用例类型 / 时间戳，再去掉末尾「（迭代）版本」
  let base = caseGenReqStem(titleOrFile)
    .replace(/迭代版本$/u, '')
    .replace(/版本$/u, '')
    .trim();
  // 兜底：无版本号时仍用 stem（可能只是产品名）
  base = base.replace(/[\s_\-—·()（）[\]【】]/g, '').toLowerCase();
  return base;
}

/**
 * 用例文件与需求分析标题是否同一需求：只比「前缀 + 版本号」。
 */
export function caseFileMatchesReqTitle(caseFileName: string, reqTitle: string): boolean {
  const a = caseReqMatchKey(caseFileName);
  const b = caseReqMatchKey(reqTitle);
  if (a.length < 4 || b.length < 4) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** 生成入库用时间戳：`YYYYMMDD-HHmmss`，便于同需求多次生成对比 */
export function caseGenStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * 入库文件名：`{需求+迭代版本}_{类型}用例_{时间戳}`。
 * 每次生成都是新文件，不覆盖旧稿，方便对比。
 * 例：`政企通v1.16.0迭代版本_功能测试用例_20261023-172405`
 */
export function caseGenFileBase(title: string, caseType: CaseType, now = new Date()): string {
  const label = caseTypeMeta(caseType).label;
  const typeSuffix = `_${label}用例`;
  const base = caseGenReqStem(title);
  return `${base || 'cases'}${typeSuffix}_${caseGenStamp(now)}`;
}

/** 从单元格里抽出 US-001 / TP-012 这类编号，便于按需求顺序排 */
function extractDocId(raw: string, prefix: 'US' | 'TP'): string {
  const m = String(raw || '').match(new RegExp(`${prefix}-\\d+`, 'i'));
  return m ? m[0]!.toUpperCase() : '';
}

function compareNaturalId(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.match(/^(.*?)(\d+)$/);
  const pb = b.match(/^(.*?)(\d+)$/);
  if (pa && pb && pa[1] === pb[1]) {
    return Number(pa[2]) - Number(pb[2]);
  }
  return a.localeCompare(b, 'zh');
}

/**
 * 按需求文档 / 用户故事顺序整理用例行：先故事顺序，再自然编号，最后用例编号。
 * 模型偶发乱序时，入库前兜底排一次。
 */
export function sortGeneratedCaseRows(
  cases: CaseRow[],
  headers: string[],
  opts?: { storyIds?: string[]; testPointIds?: string[] },
): CaseRow[] {
  if (cases.length <= 1) return cases;
  const map = caseFieldMap(headers);
  const reqCol = map.requirement || CASE_FIELD_NAME.requirement;
  const noCol = map.no || CASE_FIELD_NAME.no;
  const titleCol = map.title || CASE_FIELD_NAME.title;
  const storyRank = new Map((opts?.storyIds ?? []).map((id, i) => [id.toUpperCase(), i]));
  const tpRank = new Map((opts?.testPointIds ?? []).map((id, i) => [id.toUpperCase(), i]));
  return [...cases]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const usa =
        extractDocId(a.row[reqCol] ?? '', 'US') || extractDocId(a.row[titleCol] ?? '', 'US');
      const usb =
        extractDocId(b.row[reqCol] ?? '', 'US') || extractDocId(b.row[titleCol] ?? '', 'US');
      if (storyRank.size) {
        const sa = usa ? (storyRank.get(usa) ?? storyRank.size + 1) : storyRank.size + 2;
        const sb = usb ? (storyRank.get(usb) ?? storyRank.size + 1) : storyRank.size + 2;
        if (sa !== sb) return sa - sb;
      }
      const byUs = compareNaturalId(usa, usb);
      if (byUs) return byUs;
      const tpa =
        extractDocId(a.row[titleCol] ?? '', 'TP') || extractDocId(a.row[noCol] ?? '', 'TP');
      const tpb =
        extractDocId(b.row[titleCol] ?? '', 'TP') || extractDocId(b.row[noCol] ?? '', 'TP');
      if (tpRank.size && (tpa || tpb)) {
        const ta = tpa ? (tpRank.get(tpa) ?? tpRank.size + 1) : tpRank.size + 2;
        const tb = tpb ? (tpRank.get(tpb) ?? tpRank.size + 1) : tpRank.size + 2;
        if (ta !== tb) return ta - tb;
      }
      const byTp = compareNaturalId(tpa, tpb);
      if (byTp) return byTp;
      const byNo = compareNaturalId(String(a.row[noCol] ?? ''), String(b.row[noCol] ?? ''));
      if (byNo) return byNo;
      return a.index - b.index;
    })
    .map((x) => x.row);
}

function detectFieldGaps(cases: CaseRow[], headers: string[]): string[] {
  const tips: string[] = [];
  for (const h of headers) {
    const empty = cases.filter((c) => !String(c[h] ?? '').trim()).length;
    if (empty === cases.length) tips.push(`字段「${h}」全部为空`);
    else if (empty > Math.max(2, Math.floor(cases.length * 0.3))) {
      tips.push(`字段「${h}」有 ${empty}/${cases.length} 条为空`);
    }
  }
  return tips;
}

export function buildCaseGenSystemPrompt(cfg: CaseGenPluginConfig, docTitleHint = ''): string {
  const label = caseTypeMeta(cfg.caseType).label;
  const fields = cfg.templateHeaders.length > 0 ? cfg.templateHeaders : [...CASE_FIELDS];
  const formatHint =
    cfg.outputFormat === 'md'
      ? '最终结果将保存为 Markdown 表格文件'
      : cfg.outputFormat === 'csv'
        ? '最终结果将保存为 CSV 文件'
        : '最终结果将保存为 Excel 文件';
  const promptCore = cfg.promptBody.trim();
  if (!promptCore) {
    throw new Error('请先在生成测试用例插件中选择提示词');
  }
  const tplBlock = cfg.templateBody
    ? `\n\n### 用例模板：${cfg.templateTitle || cfg.templateId || ''}\n${cfg.templateBody}`
    : `\n\n### 模板字段：${fields.join('、')}`;
  const reqBlock = cfg.reqBlock ? `\n\n${cfg.reqBlock}` : '';
  const tpCount = cfg.testPointIds?.length ?? 0;
  const tpBlock = cfg.testPointBlock
    ? `\n\n### 测试点（逐条覆盖，别合并成一条用例；共 ${tpCount || '全部'} 条，下文为完整清单）\n${cfg.testPointBlock}`
    : '';
  const tpRule = cfg.testPointBlock
    ? `- 已选测试点共 ${tpCount || '全部'} 条，正文已完整注入，须逐条落到用例里；测试点的前置 / 步骤 / 预期分别对应用例的对应字段。不要声称「材料未提供后半段测试点」\n`
    : '';
  return `${promptCore}
${tplBlock}${reqBlock}${tpBlock}

【运行时约束 · 生成测试用例插件已启用】
- 本轮以「生成测试用例」插件所选提示词为准，不要再遵循工作台闲聊/系统提示词风格
- 用例类型：${label}
- ${formatHint}
${tpRule}- 需求名称默认可用「${docTitleHint || '未命名需求'}」
- 「用例」数组必须按上文材料出现的顺序输出（需求文档段落顺序 / 用户故事 US 顺序 / 测试点清单顺序），不要按模块名、优先级或维度重排
- 「用例」对象键必须与模板字段完全一致：${fields.join('、')}
- 仅输出一个 JSON 对象（可无代码围栏），结构为：
{"需求名称":"...","覆盖需求率":0-100,"未覆盖说明":["..."],"编写说明":"...","用例":[...]}
- 「未覆盖说明」只写需求/故事里确有、但测试点清单未给出的缺口；已注入的测试点不得再报「未提供」
- 不要输出 JSON 以外的解释性正文；界面只会展示执行摘要，用例由系统静默入库`;
}

/** @param elapsedSec 已用秒数（从请求开始计） */
export function formatCaseGenProgress(elapsedSec = 0): string {
  const sec = Math.max(0, Math.floor(elapsedSec));
  return (
    `正在编写用例…\n\n` + `已用 ${sec}s · 通常约 30–120 秒\n` + `完成后将给出覆盖率与入库结果。`
  );
}

export function formatCaseGenResultSummary(opts: {
  ok: boolean;
  title?: string;
  path?: string;
  count?: number;
  coverageRate?: number | null;
  uncovered?: string[];
  writeNote?: string;
  fieldGaps?: string[];
  error?: string;
}): string {
  if (!opts.ok) {
    return [
      '**执行失败**',
      '',
      opts.error || '未知错误',
      '',
      '可调整插件中的需求 / 模板 / 提示词后重试。',
    ].join('\n');
  }
  const lines = [
    '**执行成功**',
    '',
    `- 需求名称：${opts.title || '—'}`,
    `- 共编写：${opts.count ?? 0} 条用例`,
    `- 覆盖需求率：${opts.coverageRate != null ? `${opts.coverageRate}%` : '未给出（已按用例入库）'}`,
  ];
  if (opts.path) lines.push(`- 入库文件：用例管理/${opts.path}`);
  if (opts.writeNote) {
    lines.push('', `**编写说明**`, opts.writeNote);
  }
  const uncovered = opts.uncovered ?? [];
  lines.push('', '**未覆盖 / 未编写原因**');
  if (uncovered.length) {
    for (const u of uncovered) lines.push(`- ${u}`);
  } else {
    lines.push('- 无（模型未声明未覆盖项）');
  }
  const gaps = opts.fieldGaps ?? [];
  if (gaps.length) {
    lines.push('', '**字段完整性检测**');
    for (const g of gaps) lines.push(`- ${g}`);
  }
  return lines.join('\n');
}

export async function persistGeneratedCases(opts: {
  cases: CaseRow[];
  headers: string[];
  caseType: CaseType;
  outputFormat: CaseOutputFormat;
  title: string;
}): Promise<string> {
  if (!isPluginEnabled('cases')) {
    throw new Error(pluginDisabledMessage('cases'));
  }
  const meta = caseTypeMeta(opts.caseType);
  // 每次生成落新文件（带时间戳），不覆盖历史稿
  const base = caseGenFileBase(opts.title, opts.caseType);
  const ext = opts.outputFormat === 'md' ? '.md' : opts.outputFormat === 'csv' ? '.csv' : '.xlsx';
  const rel = `${base}${ext}`;
  const fields = opts.headers.length ? opts.headers : [...CASE_FIELDS];
  if (opts.outputFormat === 'md') {
    await writeDocsText('cases', rel, rowsToMarkdown(opts.cases, opts.title, fields));
  } else if (opts.outputFormat === 'csv') {
    await writeDocsText('cases', rel, rowsToCsv(opts.cases, fields));
  } else {
    await writeDocsBinary('cases', rel, await rowsToXlsxBase64(opts.cases, fields, meta.label));
  }
  return rel;
}

export async function tryFinishCaseGenFromAssistant(
  raw: string,
  cfg: CaseGenPluginConfig,
  docTitleHint: string,
): Promise<
  | {
      ok: true;
      path: string;
      count: number;
      title: string;
      coverageRate: number | null;
      uncovered: string[];
      writeNote: string;
      fieldGaps: string[];
      summary: string;
    }
  | { ok: false; error: string; summary: string }
> {
  const payload = extractCaseJsonPayload(raw);
  if (!payload) {
    const error = '未能解析出用例结果，未写入文件';
    return { ok: false, error, summary: formatCaseGenResultSummary({ ok: false, error }) };
  }
  const fields = cfg.templateHeaders.length > 0 ? cfg.templateHeaders : [...CASE_FIELDS];
  const source = caseGenReqSource(cfg);
  const storyIds = source?.kind === 'stories' ? source.storyIds : undefined;
  const cases = sortGeneratedCaseRows(normalizeCaseRows(payload.cases, fields), fields, {
    storyIds,
    testPointIds: cfg.testPointIds,
  });
  // 文件名 / 展示名按配置里的需求名称，不用模型自拟的「需求名称」顶掉
  const title =
    (docTitleHint || cfg.docTitle || '').trim() ||
    payload.docTitle ||
    caseTypeMeta(cfg.caseType).label;
  const fieldGaps = detectFieldGaps(cases, fields);
  try {
    const path = await persistGeneratedCases({
      cases,
      headers: fields,
      caseType: cfg.caseType,
      outputFormat: cfg.outputFormat,
      title,
    });
    const summary = formatCaseGenResultSummary({
      ok: true,
      title,
      path,
      count: cases.length,
      coverageRate: payload.coverageRate,
      uncovered: payload.uncovered,
      writeNote: payload.writeNote,
      fieldGaps,
    });
    return {
      ok: true,
      path,
      count: cases.length,
      title,
      coverageRate: payload.coverageRate,
      uncovered: payload.uncovered,
      writeNote: payload.writeNote,
      fieldGaps,
      summary,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error, summary: formatCaseGenResultSummary({ ok: false, error }) };
  }
}
