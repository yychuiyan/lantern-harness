/**
 * 用例生成插件：构建系统提示、解析 JSON、写入 cases/、生成用户可见摘要
 */
import { caseTypeMeta, type CaseOutputFormat, type CaseType } from './case-sessions';
import {
  normalizeCaseRows,
  rowsToCsv,
  rowsToMarkdown,
  rowsToXlsxBase64,
  type CaseRow,
} from './case-template';
import { CASE_FIELDS } from './export';
import type { CaseGenPluginConfig } from './case-gen-config';
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
      .slice(0, 48) || 'cases'
  );
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
    ? `\n\n### 用例模板：${cfg.templateTitle || cfg.templateId || ''}\n${cfg.templateBody.slice(0, 8000)}`
    : `\n\n### 模板字段：${fields.join('、')}`;
  const reqBlock = cfg.reqBlock ? `\n\n${cfg.reqBlock.slice(0, 24000)}` : '';
  const tpBlock = cfg.testPointBlock
    ? `\n\n### 测试点（逐条覆盖，别合并成一条用例）\n${cfg.testPointBlock.slice(0, 12000)}`
    : '';
  return `${promptCore}
${tplBlock}${reqBlock}${tpBlock}

【运行时约束 · 生成测试用例插件已启用】
- 本轮以「生成测试用例」插件所选提示词为准，不要再遵循工作台闲聊/系统提示词风格
- 用例类型：${label}
- ${formatHint}
${cfg.testPointBlock ? '- 已选测试点要逐条落到用例里，测试点的前置 / 步骤 / 预期分别对应用例的对应字段\n' : ''}- 需求名称默认可用「${docTitleHint || '未命名需求'}」
- 「用例」对象键必须与模板字段完全一致：${fields.join('、')}
- 仅输出一个 JSON 对象（可无代码围栏），结构为：
{"需求名称":"...","覆盖需求率":0-100,"未覆盖说明":["..."],"编写说明":"...","用例":[...]}
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
  linkedPath?: string;
}): Promise<string> {
  if (!isPluginEnabled('cases')) {
    throw new Error(pluginDisabledMessage('cases'));
  }
  const meta = caseTypeMeta(opts.caseType);
  // 平铺写入 用例管理/ 根目录（不再按类型分子文件夹）
  const base = safeFileBase(opts.title);
  const ext = opts.outputFormat === 'md' ? '.md' : opts.outputFormat === 'csv' ? '.csv' : '.xlsx';
  let rel = opts.linkedPath || `${base}${ext}`;
  if (rel.includes('/') && !opts.linkedPath) {
    rel = `${base}${ext}`;
  }
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
  const cases = normalizeCaseRows(payload.cases, fields);
  const title = payload.docTitle || docTitleHint || caseTypeMeta(cfg.caseType).label;
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
