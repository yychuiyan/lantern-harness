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
import { extractReqSectionOrder } from './req-analysis';
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
 * 需求章节行序：文本对到哪一节。
 * 先精确，再取「文本包含章节键」的最长命中。
 * 不用 key.includes(raw)——否则短名「登录」会被「登录与权限」等更长键误吞。
 */
export function idealOrderRank(text: string, order: readonly string[]): number {
  const raw = String(text ?? '').trim();
  if (!raw || !order.length) return order.length + 2;
  for (let i = 0; i < order.length; i++) {
    if (raw === order[i]) return i;
  }
  let best = -1;
  let bestLen = -1;
  for (let i = 0; i < order.length; i++) {
    const key = order[i]!;
    if (!key) continue;
    if (raw.includes(key) && key.length > bestLen) {
      bestLen = key.length;
      best = i;
    }
  }
  return best >= 0 ? best : order.length + 1;
}

/**
 * 从需求正文 / 提示词缓存抽出章节顺序（Ideal 小模块 / 【短名】/ Markdown 标题等）。
 */
export function idealOrderFromReqBlock(reqBlock: string | undefined): string[] {
  return extractReqSectionOrder(reqBlock ?? '');
}

export type CaseReqOrderCols = {
  submodule?: string;
  module?: string;
  title?: string;
};

/**
 * 一条用例对齐到需求章节：在模板映射到的「子模块 / 模块 / 标题」里取最长章节键命中。
 * - 兼容不同用例模板表头（子模块 / 小模块 / 所属模块 / 测试分项目…）
 * - 子模块误填成大模块短名、但标题含更长章节名时，跟标题走到正确节
 * - 大模块列若整表同名，因键更短，不会压过小模块 / 标题里的更长命中
 */
export function caseIdealRank(
  row: CaseRow,
  idealOrder: readonly string[],
  cols: CaseReqOrderCols,
): number {
  if (!idealOrder.length) return 0;
  let best = idealOrder.length + 1;
  let bestLen = -1;
  let hit = false;
  const texts = [
    cols.submodule && row[cols.submodule],
    cols.module && row[cols.module],
    cols.title && row[cols.title],
  ];
  for (const text of texts) {
    const raw = String(text ?? '').trim();
    if (!raw) continue;
    for (let i = 0; i < idealOrder.length; i++) {
      const key = idealOrder[i]!;
      if (!key) continue;
      if (raw === key || raw.includes(key)) {
        if (key.length > bestLen) {
          bestLen = key.length;
          best = i;
          hit = true;
        }
      }
    }
  }
  return hit ? best : idealOrder.length + 1;
}

/**
 * 按需求文档章节顺序整理用例行（适配不同需求格式与用例模板）。
 * 有章节序时：先按章节对齐，同节内保持生成相对序（不让 US 编号打乱）；
 * 无章节序时：再按用户故事 / 测试点 / 用例编号。
 */
export function sortGeneratedCaseRows(
  cases: CaseRow[],
  headers: string[],
  opts?: { storyIds?: string[]; testPointIds?: string[]; idealOrder?: string[] },
): CaseRow[] {
  if (cases.length <= 1) return cases;
  const map = caseFieldMap(headers);
  const reqCol = map.requirement || CASE_FIELD_NAME.requirement;
  const noCol = map.no || CASE_FIELD_NAME.no;
  const titleCol = map.title || CASE_FIELD_NAME.title;
  const idealOrder = opts?.idealOrder ?? [];
  const idealCols: CaseReqOrderCols = {
    submodule: map.submodule,
    module: map.module,
    title: titleCol,
  };
  const storyRank = new Map((opts?.storyIds ?? []).map((id, i) => [id.toUpperCase(), i]));
  const tpRank = new Map((opts?.testPointIds ?? []).map((id, i) => [id.toUpperCase(), i]));
  return [...cases]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (idealOrder.length) {
        const ra = caseIdealRank(a.row, idealOrder, idealCols);
        const rb = caseIdealRank(b.row, idealOrder, idealCols);
        if (ra !== rb) return ra - rb;
        // 已对齐到同一需求节：保持生成相对序，避免 US-018 被 US-001 挤到节内末尾
        if (ra < idealOrder.length) return a.index - b.index;
      }
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
  const fieldList = fields.includes('备注') ? fields : [...fields, '备注'];
  const fieldMap = caseFieldMap(fields);
  const moduleCol = fieldMap.module;
  const submoduleCol = fieldMap.submodule;
  const orderHintParts: string[] = [];
  if (moduleCol) {
    orderHintParts.push(
      `「${moduleCol}」对齐需求大模块 / 章节（Ideal 表填大模块原文；普通文档填对应章节名）`,
    );
  }
  if (submoduleCol) {
    orderHintParts.push(`「${submoduleCol}」对齐需求小模块 / 小节原文，不要自造更细的名称`);
  }
  const orderHint =
    orderHintParts.length > 0
      ? `- 字段对齐：${orderHintParts.join('；')}；用例数组严格按需求文档章节 / Ideal 小模块出现顺序输出\n`
      : `- 用例数组严格按需求文档章节 / 段落 / Ideal 小模块出现顺序输出（系统入库还会按此序重排）\n`;
  return `${promptCore}
${tplBlock}${reqBlock}${tpBlock}

【运行时约束 · 生成测试用例插件已启用】
- 本轮以「生成测试用例」插件所选提示词为准，不要再遵循工作台闲聊/系统提示词风格
- 用例类型：${label}
- ${formatHint}
${tpRule}- 需求名称默认可用「${docTitleHint || '未命名需求'}」
- 「用例」数组必须按上文材料的需求顺序输出（Ideal 小模块行序 / 需求章节 / 文档段落 / 用户故事 / 测试点清单），不要按自造模块名、优先级或维度重排
${orderHint}- 「用例」对象键必须与当前模板字段完全一致（另可多写「备注」列）：${fieldList.join('、')}
- 仅输出一个 JSON 对象（可无代码围栏），结构为：
{"需求名称":"...","覆盖需求率":0-100,"未覆盖说明":["..."],"编写说明":"...","用例":[...]}
- 「待业务确认 / 待确认」类不确定项也要写成用例，不要只丢进「未覆盖说明」：步骤写可执行操作，预期写「记录实际行为，规则待业务确认后回填判定口径」，并在「备注」写「待业务确认：…」（把不确定点写清楚）
- 「未覆盖说明」只写确实没写成用例的缺口（例如材料完全缺失、与测试无关）；已注入的测试点不得再报「未提供」；已用备注标过待业务确认的不要再重复列进「未覆盖说明」
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
    lines.push('- 无（模型未声明未覆盖项；待业务确认项已写入用例「备注」）');
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

/** 模板没有「备注」时也补上这一列，方便落「待业务确认」标注 */
export function ensureCaseRemarkHeader(headers: string[]): string[] {
  if (headers.some((h) => /备注/.test(h))) return headers;
  return [...headers, '备注'];
}

const PENDING_CONFIRM_RE = /待业务确|待确认|业务确认/;

function remarkFieldOf(headers: string[]): string {
  return headers.find((h) => /备注/.test(h)) ?? '备注';
}

function titleFieldOf(headers: string[]): string {
  return (
    headers.find((h) => /用例标题|测试分项目|用例名称|标题/.test(h)) ??
    headers.find((h) => h.includes('标题')) ??
    '用例标题'
  );
}

function pickRawRemark(obj: Record<string, unknown>): string {
  for (const key of ['备注', '备注说明', '说明', 'remark', 'note']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 模型若仍把「待业务确认」只写进未覆盖说明：补成用例，备注标「待业务确认：…」，并从未覆盖列表剔除。
 */
export function promotePendingConfirmCases(
  rawCases: unknown[],
  uncovered: string[],
  headers: string[],
): { cases: unknown[]; uncovered: string[] } {
  const remarkKey = remarkFieldOf(headers);
  const titleKey = titleFieldOf(headers);
  const keptUncovered: string[] = [];
  const extra: Record<string, string>[] = [];
  for (const item of uncovered) {
    const text = String(item ?? '').trim();
    if (!text || !PENDING_CONFIRM_RE.test(text)) {
      if (text) keptUncovered.push(text);
      continue;
    }
    const short =
      text
        .replace(/^[-*·\s]+/, '')
        .split(/[。；;\n]/)[0]
        ?.trim() || text;
    const title = (short.length > 48 ? `${short.slice(0, 48)}…` : short).replace(
      /^待业务确认[：:]\s*/u,
      '',
    );
    const row: Record<string, string> = {};
    for (const h of headers) row[h] = '';
    row[titleKey] = title || '待业务确认项';
    if (headers.includes('优先级')) row['优先级'] = 'P2';
    if (headers.includes('用例类型')) row['用例类型'] = '功能测试';
    const stepsKey = headers.find((h) => /步骤/.test(h));
    const expectKey = headers.find((h) => /预期|期望|结果标准/.test(h));
    if (stepsKey) row[stepsKey] = '1、按需求描述完成相关操作\n2、记录系统实际行为与提示文案';
    if (expectKey) {
      row[expectKey] = '记录实际行为；业务规则确认前不做通过/失败判定，确认后回填判定口径';
    }
    row[remarkKey] = text.startsWith('待业务确认') ? text : `待业务确认：${text}`;
    extra.push(row);
  }
  return { cases: [...rawCases, ...extra], uncovered: keptUncovered };
}

/** 把模型写在别名里的备注收进「备注」列 */
function mergeRawRemarks(rawCases: unknown[], headers: string[]): unknown[] {
  const remarkKey = remarkFieldOf(headers);
  return rawCases.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const obj = { ...(item as Record<string, unknown>) };
    if (!String(obj[remarkKey] ?? '').trim()) {
      const picked = pickRawRemark(obj);
      if (picked) obj[remarkKey] = picked;
    }
    return obj;
  });
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
  const baseFields = cfg.templateHeaders.length > 0 ? cfg.templateHeaders : [...CASE_FIELDS];
  const fields = ensureCaseRemarkHeader(baseFields);
  const promoted = promotePendingConfirmCases(payload.cases, payload.uncovered, fields);
  const merged = mergeRawRemarks(promoted.cases, fields);
  const source = caseGenReqSource(cfg);
  const storyIds = source?.kind === 'stories' ? source.storyIds : undefined;
  const idealOrder = idealOrderFromReqBlock(cfg.reqBlock);
  const cases = sortGeneratedCaseRows(normalizeCaseRows(merged, fields), fields, {
    storyIds,
    testPointIds: cfg.testPointIds,
    idealOrder,
  });
  // Ideal 重排后把用例编号收成 1…N，避免菜单权限排到前面却仍挂着 159 这类尾号
  if (idealOrder.length) {
    const noCol = caseFieldMap(fields).no || CASE_FIELD_NAME.no;
    if (fields.includes(noCol)) {
      cases.forEach((row, i) => {
        row[noCol] = String(i + 1);
      });
    }
  }
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
      uncovered: promoted.uncovered,
      writeNote: payload.writeNote,
      fieldGaps,
    });
    return {
      ok: true,
      path,
      count: cases.length,
      title,
      coverageRate: payload.coverageRate,
      uncovered: promoted.uncovered,
      writeNote: payload.writeNote,
      fieldGaps,
      summary,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error, summary: formatCaseGenResultSummary({ ok: false, error }) };
  }
}
