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

/** 章节键的分段（层级小模块用逗号 / 顿号 / 斜杠串起来：`调查问卷管理,问卷回收列表`） */
const IDEAL_KEY_SEP = /[,，、/／|｜>]+/;

/** 一次命中的强弱：先比命中长度，再比是否整键相等（`移动端` 不该被 `我的问卷,移动端` 抢走） */
type IdealHit = { len: number; exact: boolean; index: number };

function betterIdealHit(next: IdealHit, cur: IdealHit | null): boolean {
  if (!cur) return true;
  if (next.len !== cur.len) return next.len > cur.len;
  if (next.exact !== cur.exact) return next.exact;
  return next.index < cur.index;
}

/**
 * 章节键 → 命中信息：整键与各分段都算候选。
 * 同一分段出现在多个键里时取最早下标，保证排出来的顺序稳定。
 */
function idealOrderTokens(order: readonly string[]): Map<string, number> {
  const tokens = new Map<string, number>();
  order.forEach((key, index) => {
    const add = (token: string) => {
      const t = token.trim();
      if (!t) return;
      if (!tokens.has(t)) tokens.set(t, index);
    };
    add(key);
    for (const seg of key.split(IDEAL_KEY_SEP)) add(seg);
  });
  return tokens;
}

/**
 * 一条用例对齐到需求章节：在模板映射到的「子模块 / 模块 / 标题」里取最强命中。
 * - 兼容不同用例模板表头（子模块 / 小模块 / 所属模块 / 测试分项目…）
 * - 子模块写叶子名（`问卷回收列表`）、需求表写层级路径（`调查问卷管理,问卷回收列表`）时也能对上
 * - 子模块误填成大模块短名、但标题含更长章节名时，跟标题走到正确节
 * - 大模块列若整表同名，因键更短，不会压过小模块 / 标题里的更长命中
 */
export function caseIdealRank(
  row: CaseRow,
  idealOrder: readonly string[],
  cols: CaseReqOrderCols,
  tokens: Map<string, number> = idealOrderTokens(idealOrder),
): number {
  if (!idealOrder.length) return 0;
  let best: IdealHit | null = null;
  const texts = [
    cols.submodule && row[cols.submodule],
    cols.module && row[cols.module],
    cols.title && row[cols.title],
  ];
  for (const text of texts) {
    const raw = String(text ?? '').trim();
    if (!raw) continue;
    // 整键相等（先于分段）：键本身就是叶子名时走这条
    for (let i = 0; i < idealOrder.length; i += 1) {
      const key = idealOrder[i];
      if (!key) continue;
      if (raw === key) {
        const hit = { len: key.length, exact: true, index: i };
        if (betterIdealHit(hit, best)) best = hit;
      }
    }
    // 分段 / 整键被 raw 包含：raw 里写的是更长标题时也能归位
    for (const [token, index] of tokens) {
      if (!raw.includes(token)) continue;
      const hit = { len: token.length, exact: false, index };
      if (betterIdealHit(hit, best)) best = hit;
    }
  }
  return best ? best.index : idealOrder.length + 1;
}

/**
 * 按需求文档章节顺序整理用例行（适配不同需求格式与用例模板）。
 * 有章节序时：先按章节对齐，同节内保持生成相对序（不让 US 编号打乱）；
 * 无章节序时：再按用户故事 / 测试点 / 用例编号。
 */
export type CaseGenSortOpts = {
  storyIds?: string[];
  testPointIds?: string[];
  idealOrder?: string[];
  /** 需求条目（RO）的文档序：有它时以条目序为第一口径 */
  outlineOrder?: string[];
  /** US-001 → 其 sourceRefs（RO id 列表）；没有「引用需求点」时用故事反查条目 */
  storySourceRefs?: ReadonlyMap<string, string[]>;
};

/** 一组编号在顺序表里的最早下标；一个都没有命中时返回 null */
function firstRankIn(ids: readonly string[], rank: ReadonlyMap<string, number>): number | null {
  let best: number | null = null;
  for (const id of ids) {
    const r = rank.get(id.toUpperCase());
    if (r == null) continue;
    if (best == null || r < best) best = r;
  }
  return best;
}

/**
 * 按需求顺序整理用例行。主口径：**需求条目 → 条目内测试点 → 生成序**。
 *
 * 1. 「引用需求点」里的 RO → `outlineOrder`（需求条目文档序）
 * 2. 同一条目内，「引用需求点」里的 TP → `testPointIds`（测试点清单序），没有 TP 的落到条目末尾
 * 3. 没有 RO 时用「需求编号」US → 故事 sourceRefs → 最小 RO 下标
 * 4. 仍对不上（老文件 / 纯文档来源）→ Ideal 小模块文本匹配
 * 5. 再退故事 / 测试点 / 用例编号；全同档时保持生成序
 */
export function sortGeneratedCaseRows(
  cases: CaseRow[],
  headers: string[],
  opts?: CaseGenSortOpts,
): CaseRow[] {
  if (cases.length <= 1) return cases;
  const map = caseFieldMap(headers);
  const reqCol = map.requirement || CASE_FIELD_NAME.requirement;
  const noCol = map.no || CASE_FIELD_NAME.no;
  const titleCol = map.title || CASE_FIELD_NAME.title;
  const citeCol = map.reqCite;
  const idealOrder = opts?.idealOrder ?? [];
  const idealCols: CaseReqOrderCols = {
    submodule: map.submodule,
    module: map.module,
    title: titleCol,
  };
  const outlineRank = new Map(
    (opts?.outlineOrder ?? []).map((id, i) => [id.toUpperCase(), i] as const),
  );
  const storyRank = new Map((opts?.storyIds ?? []).map((id, i) => [id.toUpperCase(), i]));
  const tpRank = new Map((opts?.testPointIds ?? []).map((id, i) => [id.toUpperCase(), i]));
  const storyRefs = opts?.storySourceRefs;
  const tokens = idealOrderTokens(idealOrder);
  const useOutline = outlineRank.size > 0;

  const decorated = cases.map((row, index) => {
    const cite = citeCol ? String(row[citeCol] ?? '') : '';
    const { roIds, tpIds } = parseCiteIds(cite);
    const us = extractDocId(row[reqCol] ?? '', 'US') || extractDocId(row[titleCol] ?? '', 'US');
    let roRank = useOutline ? firstRankIn(roIds, outlineRank) : null;
    if (roRank == null && useOutline && us && storyRefs) {
      const refs = storyRefs.get(us) ?? storyRefs.get(us.toUpperCase()) ?? [];
      roRank = firstRankIn(refs, outlineRank);
    }
    const tpIdx = firstRankIn(tpIds, tpRank);
    // 没有可比顺序时用编号自然序兜底：同一需求条目 / 测试点的多条挨在一起
    const tpId = [...tpIds].sort(compareNaturalId)[0] ?? '';
    const roId = [...roIds].sort(compareNaturalId)[0] ?? '';
    return {
      row,
      index,
      roRank,
      roId,
      tpIdx,
      tpId,
      idealRank: idealOrder.length ? caseIdealRank(row, idealOrder, idealCols, tokens) : 0,
      us,
      usRank: us ? (storyRank.get(us) ?? storyRank.size + 1) : storyRank.size + 2,
    };
  });

  const UNORDERED = Number.MAX_SAFE_INTEGER;

  return decorated
    .sort((a, b) => {
      // 1) 需求条目序（拿不到条目的行排在后面）
      if (useOutline) {
        const ra = a.roRank ?? UNORDERED;
        const rb = b.roRank ?? UNORDERED;
        if (ra !== rb) return ra - rb;
        if (a.roRank != null && b.roRank != null) {
          // 2) 同一条目内按测试点序；没有 TP 的落到条目末尾
          const ta = a.tpIdx ?? (a.tpId ? UNORDERED - 1 : UNORDERED);
          const tb = b.tpIdx ?? (b.tpId ? UNORDERED - 1 : UNORDERED);
          if (ta !== tb) return ta - tb;
          if (ta === UNORDERED - 1 && a.tpId !== b.tpId) return compareNaturalId(a.tpId, b.tpId);
          // 同一条目、同一测试点：保持生成序
          return a.index - b.index;
        }
      }
      // 3) Ideal 小模块文本序（仅在没有条目序时才是主依据）
      if (idealOrder.length) {
        const ra = a.idealRank;
        const rb = b.idealRank;
        if (ra !== rb) return ra - rb;
        // 已对齐到同一需求节：保持生成相对序，避免 US-018 被 US-001 挤到节内末尾
        if (ra < idealOrder.length) return a.index - b.index;
      }
      if (storyRank.size) {
        const sa = a.us ? a.usRank : storyRank.size + 2;
        const sb = b.us ? b.usRank : storyRank.size + 2;
        if (sa !== sb) return sa - sb;
      }
      const byUs = compareNaturalId(a.us, b.us);
      if (byUs) return byUs;
      // 4) 测试点编号（标题 / 用例编号里的 TP-…）
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
      // 5) 「引用需求点」里的 RO / TP 编号自然序（没有条目清单时的最后兜底）
      if (a.roId || b.roId) {
        const byRo = compareNaturalId(a.roId, b.roId);
        if (byRo) return byRo;
      }
      if (a.tpId || b.tpId) {
        const byCiteTp = compareNaturalId(a.tpId, b.tpId);
        if (byCiteTp) return byCiteTp;
      }
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

export type CaseGenPromptBatchHint = {
  index: number;
  total: number;
  pointCount: number;
};

export function buildCaseGenSystemPrompt(
  cfg: CaseGenPluginConfig,
  docTitleHint = '',
  batch?: CaseGenPromptBatchHint,
): string {
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
  const multi = Boolean(batch && batch.total > 1);
  const tpBlock = cfg.testPointBlock
    ? `\n\n### 测试点（逐条覆盖，别合并成一条用例；${
        multi
          ? `本批 ${tpCount || batch!.pointCount} 条，第 ${batch!.index}/${batch!.total} 批`
          : `共 ${tpCount || '全部'} 条，下文为完整清单`
      }）\n${cfg.testPointBlock}`
    : '';
  const tpRule = cfg.testPointBlock
    ? multi
      ? `- 本批是第 ${batch!.index}/${batch!.total} 批，下文仅列出本批 ${tpCount || batch!.pointCount} 条测试点：须逐条落到用例里；不要编写未列出的测试点；测试点的前置 / 步骤 / 预期分别对应用例的对应字段\n- 「覆盖需求率」「编写说明」只概括本批；系统会合并各批后再入库\n- 「未覆盖说明」只列本批清单里确实没写成用例的真实缺口（如缺规则、材料不足）；本批已全部落成时必须输出空数组 \`[]\`；禁止写「本批仅覆盖 / 由其他批次负责 / 均已落成 / 不计入本批缺口」等分批说明（那不是缺口）\n`
      : `- 已选测试点共 ${tpCount || '全部'} 条，正文已完整注入，须逐条落到用例里；测试点的前置 / 步骤 / 预期分别对应用例的对应字段。不要声称「材料未提供后半段测试点」\n`
    : '';
  const fieldList = ensureCaseCiteHeader(fields.includes('备注') ? fields : [...fields, '备注']);
  const fieldMap = caseFieldMap(fieldList);
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
      ? `- 字段对齐：${orderHintParts.join('；')}；用例数组严格按需求条目 / 测试点清单顺序输出\n`
      : `- 用例数组严格按需求条目 / 测试点清单 / 文档段落顺序输出（系统入库还会按此序重排）\n`;
  return `${promptCore}
${tplBlock}${reqBlock}${tpBlock}

【运行时约束 · 生成测试用例插件已启用】
- 本轮以「生成测试用例」插件所选提示词为准，不要再遵循工作台闲聊/系统提示词风格
- 用例类型：${label}
- ${formatHint}
${tpRule}- 需求名称默认可用「${docTitleHint || '未命名需求'}」
- 「用例」数组必须按上文材料的需求顺序输出（需求条目 RO 序 → 条目内测试点 TP 序 → 文档段落 / 用户故事顺序），不要按自造模块名、优先级或维度重排
${orderHint}- 「用例」对象键必须与当前模板字段完全一致（另可多写「备注」「引用需求点」列）：${fieldList.join('、')}
- 仅输出一个 JSON 对象（可无代码围栏），结构为：
{"需求名称":"...","覆盖需求率":0-100,"未覆盖说明":["..."],"编写说明":"...","用例":[...]}
- 「引用需求点」必填，格式为「需求条目 + 测试点」两段：\`RO-id 标题或原文摘录；TP-xxx\`（RO 在前并带一句标题 / 摘录，TP 在后）；RO id 必须来自材料「需求条目」里真实存在的 \`RO-…\`；TP id 取本条用例所覆盖测试点的编号（材料中有测试点清单时必填）；不要填 \`US-…\`、不要写 \`全局测试点：…\` 这类分组前缀；只有用户故事时 RO 填该故事的「来源条目」，仍不要只写 US id
- 补充扩展场景：同一「引用需求点」，并在「备注」写「补充：…」；同点内正式用例在前、补充在后
- 「待业务确认 / 待确认」类不确定项也要写成用例，不要只丢进「未覆盖说明」：步骤写可执行操作，预期写「记录实际行为，规则待业务确认后回填判定口径」，并在「备注」写「待业务确认：…」（可与「补充：」并存）
- 「未覆盖说明」只写确实没写成用例的缺口；已用备注标过待业务确认的不要再重复列进「未覆盖说明」；某个需求点一条引用都没有时须在未覆盖说明点名
- 不要输出 JSON 以外的解释性正文；界面只会展示执行摘要，用例由系统静默入库`;
}

/** 时间渐近软进度，上限 95（留给入库收尾） */
export function softCaseGenPercent(elapsedSec: number, tau = 100): number {
  const t = Math.max(0, elapsedSec);
  return Math.min(95, Math.max(1, Math.round(95 * (1 - Math.exp(-t / tau)))));
}

/** @param elapsedSec 已用秒数（从请求开始计） */
export function formatCaseGenProgress(
  elapsedSec = 0,
  batch?: { index: number; total: number; label?: string },
): string {
  const sec = Math.max(0, Math.floor(elapsedSec));
  const multi = Boolean(batch && batch.total > 1);
  let pct: number;
  if (multi && batch) {
    const within = softCaseGenPercent(sec, 80) / 100;
    pct = Math.min(95, Math.max(1, Math.round(((batch.index - 1 + within) / batch.total) * 95)));
  } else {
    pct = softCaseGenPercent(sec);
  }
  const batchLine = multi
    ? `第 ${batch!.index}/${batch!.total} 批${batch!.label ? ` · ${batch!.label}` : ''}\n`
    : '';
  const footer = multi
    ? '系统自动分批生成，全部完成后合并入库并给出覆盖率。'
    : '大文档可能需要数分钟；完成后将给出覆盖率与入库结果。';
  return `正在编写用例…\n\n${batchLine}进度约 ${pct}% · 已用 ${sec}s\n${footer}`;
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

/** 模板没有「引用需求点」时补上，与「需求编号」分开 */
export function ensureCaseCiteHeader(headers: string[]): string[] {
  if (headers.some((h) => /引用需求点|需求点/.test(h) && !/需求编号/.test(h))) return headers;
  return [...headers, '引用需求点'];
}

const RO_ID_RE = /\bRO-[A-Za-z0-9_-]+\b/gi;
const US_ID_RE = /\bUS-\d+\b/gi;
const TP_ID_RE = /\bTP-\d+\b/gi;

/** 拆「引用需求点」里的两级编号：需求条目 RO + 测试点 TP */
export function parseCiteIds(cell: string): { roIds: string[]; tpIds: string[] } {
  const text = String(cell ?? '');
  return {
    roIds: collectIds(text, RO_ID_RE),
    tpIds: collectIds(text, TP_ID_RE).map((id) => id.toUpperCase()),
  };
}

export type ReqCiteOutlineInfo = { title: string; quote?: string };

/** `RO-1-4 标题`：编号在前；标题已含编号则不再重复 */
export function formatReqCiteCell(id: string, titleOrQuote = ''): string {
  const rid = String(id ?? '').trim();
  const text = String(titleOrQuote ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rid) return text;
  if (!text) return rid;
  if (text === rid || text.toUpperCase().startsWith(rid.toUpperCase() + ' ')) return text;
  if (new RegExp(`^${rid}\\b`, 'i').test(text)) return text;
  return `${rid} ${text}`;
}

function collectIds(raw: string, re: RegExp): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(raw ?? '').matchAll(re)) {
    const norm = /^US-/i.test(m[0]!) ? m[0]!.toUpperCase() : m[0]!.replace(/^ro-/i, 'RO-');
    const key = norm.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

/**
 * 规范化「引用需求点」：RO 段补标题、去掉 US / 测试点分组前缀；TP 段保留并排到 RO 之后。
 * 格式：`RO-E-1-3 标题或摘录；TP-012`
 */
export function normalizeReqCiteValue(
  raw: string,
  opts?: {
    outlineById?: ReadonlyMap<string, ReqCiteOutlineInfo>;
    /** US-001 → 其 sourceRefs（RO id 列表） */
    storySourceRefs?: ReadonlyMap<string, string[]>;
  },
): string {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  text = text
    .replace(/全局测试点\s*[：:]\s*/g, '')
    .replace(/来源故事\s*[：:]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const roIds = collectIds(text, RO_ID_RE);
  const usIds = collectIds(text, US_ID_RE);
  const tpIds = collectIds(text, TP_ID_RE).map((id) => id.toUpperCase());
  const outlineById = opts?.outlineById;
  const storySourceRefs = opts?.storySourceRefs;

  /** 把 TP 编号补在 RO 之后；已经写过的序列不重复 */
  const appendTp = (value: string): string => {
    const base = String(value ?? '')
      .trim()
      .replace(/\btp-\d+\b/gi, (m) => m.toUpperCase());
    if (!tpIds.length) return base;
    const existing = new Set(parseCiteIds(base).tpIds);
    const missing = tpIds.filter((id) => !existing.has(id));
    if (!missing.length) return base;
    return base ? `${base}；${missing.join('、')}` : missing.join('、');
  };

  const labelForRo = (id: string): string => {
    const info = outlineById?.get(id) ?? outlineById?.get(id.toUpperCase());
    // try case-insensitive key scan
    let hit = info;
    if (!hit && outlineById) {
      for (const [k, v] of outlineById) {
        if (k.toUpperCase() === id.toUpperCase()) {
          hit = v;
          break;
        }
      }
    }
    const tail = (hit?.quote || hit?.title || '').replace(/\s+/g, ' ').trim();
    return formatReqCiteCell(id, tail);
  };

  if (roIds.length) {
    return appendTp(roIds.map(labelForRo).join('；'));
  }

  if (usIds.length && storySourceRefs) {
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const us of usIds) {
      const refs = storySourceRefs.get(us) ?? storySourceRefs.get(us.toUpperCase()) ?? [];
      for (const ref of refs) {
        const key = ref.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push(labelForRo(ref));
      }
    }
    if (resolved.length) return appendTp(resolved.join('；'));
  }

  // 仅 US 且无法解析：去掉 US 编号外壳，保留剩余标题；仍含 US 则原样（避免误删）
  if (usIds.length && !roIds.length) {
    let rest = text;
    for (const us of usIds) {
      rest = rest.replace(new RegExp(us, 'ig'), ' ');
    }
    rest = rest
      .replace(/[/|｜,，;；]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return appendTp(rest || text);
  }

  return appendTp(text);
}

/** 从用例材料 Markdown 抽 RO → 标题（及可选摘录） */
export function parseOutlineLookupFromReqBlock(reqBlock: string): Map<string, ReqCiteOutlineInfo> {
  const map = new Map<string, ReqCiteOutlineInfo>();
  const lines = String(reqBlock ?? '').split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m =
      line.match(/\*\*(RO-[A-Za-z0-9_-]+)\*\*\s*(.+)?$/) ||
      line.match(/\b(RO-[A-Za-z0-9_-]+)\b\s+(.+)$/);
    if (!m) continue;
    const id = m[1]!;
    let title = (m[2] ?? '').replace(/\*\*/g, '').trim();
    let quote = '';
    const next = lines[i + 1] ?? '';
    const qm = next.match(/^\s*>\s*(.+)$/);
    if (qm) quote = qm[1]!.trim();
    if (!title && quote) title = quote.slice(0, 80);
    if (!map.has(id)) map.set(id, { title, quote: quote || undefined });
  }
  return map;
}

/** 从故事 Markdown 抽 US → 来源 RO 列表 */
export function parseStorySourceRefsFromReqBlock(reqBlock: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const text = String(reqBlock ?? '');
  const blocks = text.split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const hm = block.match(/^(US-\d+)\b/);
    if (!hm) continue;
    const us = hm[1]!;
    const src = block.match(/\*\*来源条目\*\*[：:]\s*(.+)/);
    if (!src) continue;
    const refs = collectIds(src[1]!, RO_ID_RE);
    if (refs.length) map.set(us, refs);
  }
  return map;
}

/** 对用例行的「引用需求点」列做入库规范化 */
export function normalizeCaseReqCiteRows(
  cases: CaseRow[],
  headers: string[],
  opts?: {
    outlineById?: ReadonlyMap<string, ReqCiteOutlineInfo>;
    storySourceRefs?: ReadonlyMap<string, string[]>;
  },
): CaseRow[] {
  const citeCol =
    caseFieldMap(headers).reqCite ||
    headers.find((h) => /引用需求点|需求点/.test(h) && !/需求编号/.test(h));
  if (!citeCol) return cases;
  return cases.map((row) => {
    const raw = row[citeCol];
    if (raw == null || !String(raw).trim()) return row;
    const next = normalizeReqCiteValue(String(raw), opts);
    if (next === String(raw).trim()) return row;
    return { ...row, [citeCol]: next };
  });
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

export type CaseGenFinishOk = {
  ok: true;
  path: string;
  count: number;
  title: string;
  coverageRate: number | null;
  uncovered: string[];
  writeNote: string;
  fieldGaps: string[];
  summary: string;
};
export type CaseGenFinishErr = { ok: false; error: string; summary: string };
export type CaseGenFinishResult = CaseGenFinishOk | CaseGenFinishErr;

/**
 * 分批时模型常把「本批范围说明」误写入未覆盖说明；合并展示前滤掉。
 * 真实缺口（如某 RO 缺规则）应保留。
 */
export function isCaseGenBatchMetaUncovered(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return true;
  return (
    /本批仅覆盖|本批只覆盖|本批只负责|本批仅负责/.test(s) ||
    /由其他批次|其他批次负责|其余批次|后续批次/.test(s) ||
    /不计入本批缺口|不算本批缺口|非本批缺口/.test(s) ||
    /均已落成用例|均已写成用例|本批.*全部落成|本批测试点.*均已/.test(s) ||
    /指定的\s*\d+\s*条测试点/.test(s)
  );
}

/** 合并多批解析结果（用例拼接；未覆盖去重并去掉分批说明噪音；覆盖率按批加权） */
export function mergeCaseGenPayloads(parts: CaseGenMetaPayload[]): CaseGenMetaPayload | null {
  if (!parts.length) return null;
  const cases: unknown[] = [];
  const uncovered: string[] = [];
  const seenUnc = new Set<string>();
  const notes: string[] = [];
  let covSum = 0;
  let covWeight = 0;
  let docTitle = '';
  for (const p of parts) {
    if (!docTitle && p.docTitle) docTitle = p.docTitle;
    if (Array.isArray(p.cases)) cases.push(...p.cases);
    for (const u of p.uncovered) {
      const key = u.trim();
      if (!key || seenUnc.has(key) || isCaseGenBatchMetaUncovered(key)) continue;
      seenUnc.add(key);
      uncovered.push(key);
    }
    if (p.writeNote.trim()) notes.push(p.writeNote.trim());
    if (p.coverageRate != null && Number.isFinite(p.coverageRate)) {
      const w = Math.max(1, p.cases.length || 1);
      covSum += p.coverageRate * w;
      covWeight += w;
    }
  }
  if (!cases.length) return null;
  return {
    docTitle,
    cases,
    coverageRate: covWeight > 0 ? Math.round(covSum / covWeight) : null,
    uncovered,
    writeNote: notes.length
      ? notes.length === 1
        ? notes[0]!
        : notes.map((n, i) => `（第 ${i + 1} 批）${n}`).join('\n')
      : '',
  };
}

export async function persistCaseGenPayload(
  payload: CaseGenMetaPayload,
  cfg: CaseGenPluginConfig,
  docTitleHint: string,
  opts?: { renumber?: boolean },
): Promise<CaseGenFinishResult> {
  const baseFields = cfg.templateHeaders.length > 0 ? cfg.templateHeaders : [...CASE_FIELDS];
  const fields = ensureCaseCiteHeader(ensureCaseRemarkHeader(baseFields));
  const promoted = promotePendingConfirmCases(payload.cases, payload.uncovered, fields);
  const merged = mergeRawRemarks(promoted.cases, fields);
  const source = caseGenReqSource(cfg);
  const storyIds = source?.kind === 'stories' ? source.storyIds : undefined;
  const idealOrder = idealOrderFromReqBlock(cfg.reqBlock);
  const outlineById = parseOutlineLookupFromReqBlock(cfg.reqBlock ?? '');
  const storySourceRefs = parseStorySourceRefsFromReqBlock(cfg.reqBlock ?? '');
  const normalized = normalizeCaseReqCiteRows(normalizeCaseRows(merged, fields), fields, {
    outlineById,
    storySourceRefs,
  });
  const cases = sortGeneratedCaseRows(normalized, fields, {
    storyIds,
    testPointIds: cfg.testPointIds,
    idealOrder,
    outlineOrder: cfg.outlineOrder,
    storySourceRefs,
  });
  // 按需求 / 测试点重排或分批合并后把用例编号收成 1…N
  if (opts?.renumber || idealOrder.length || (cfg.outlineOrder?.length ?? 0) > 0) {
    const noCol = caseFieldMap(fields).no || CASE_FIELD_NAME.no;
    if (fields.includes(noCol)) {
      cases.forEach((row, i) => {
        row[noCol] = String(i + 1);
      });
    }
  }
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

export async function tryFinishCaseGenFromAssistant(
  raw: string,
  cfg: CaseGenPluginConfig,
  docTitleHint: string,
): Promise<CaseGenFinishResult> {
  const payload = extractCaseJsonPayload(raw);
  if (!payload) {
    const error = '未能解析出用例结果，未写入文件';
    return { ok: false, error, summary: formatCaseGenResultSummary({ ok: false, error }) };
  }
  return persistCaseGenPayload(payload, cfg, docTitleHint);
}

/** 多批 raw 合并入库；任一批解析失败则整单失败并点名批次 */
export async function tryFinishCaseGenFromBatches(
  batchRaws: { index: number; total: number; raw: string }[],
  cfg: CaseGenPluginConfig,
  docTitleHint: string,
): Promise<CaseGenFinishResult> {
  const parts: CaseGenMetaPayload[] = [];
  for (const b of batchRaws) {
    const payload = extractCaseJsonPayload(b.raw);
    if (!payload) {
      const error = `第 ${b.index}/${b.total} 批未能解析出用例结果，未写入文件`;
      return { ok: false, error, summary: formatCaseGenResultSummary({ ok: false, error }) };
    }
    parts.push(payload);
  }
  const merged = mergeCaseGenPayloads(parts);
  if (!merged) {
    const error = '各批均未解析出用例，未写入文件';
    return { ok: false, error, summary: formatCaseGenResultSummary({ ok: false, error }) };
  }
  return persistCaseGenPayload(merged, cfg, docTitleHint, { renumber: true });
}
