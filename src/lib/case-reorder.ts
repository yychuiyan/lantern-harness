/**
 * 用例文件重排：按「需求条目（RO）→ 测试点（TP）→ 生成序」整理已有用例，
 * 重编号后写回原文件（服务端先备份到「用例管理/备份列表/」）。
 *
 * 与生成入库共用同一套排序函数（`sortGeneratedCaseRows`），
 * 所以「重排」后与「重新生成」得到的顺序一致。
 */
import { readCaseFile, type CaseRow } from './case-file';
import { caseFieldMap } from './case-fields';
import { createCaseReviewBackup, rewriteCaseRows } from './case-review';
import { sortGeneratedCaseRows } from './case-gen-run';
import { readDocsRaw, readDocsText } from './project-docs';
import {
  extractReqSectionOrder,
  listReqDocs,
  outlineDocOrderIndex,
  type ReqAnalysisDoc,
} from './req-analysis';

export interface CaseReorderSource {
  /** 需求条目（RO id）文档序 */
  outlineOrder?: string[];
  /** 测试点清单序 */
  testPointIds?: string[];
  /** Ideal 小模块 / 章节序：只在没有 RO 引用时兜底 */
  idealOrder?: string[];
  /** US-001 → 来源条目 */
  storySourceRefs?: Map<string, string[]>;
}

export interface CaseReorderPreviewRow {
  no: string;
  title: string;
  cite: string;
}

export interface CaseReorderPlan {
  casePath: string;
  headers: string[];
  rows: CaseRow[];
  /** 位置发生变化的行数（0 = 本来就有序） */
  moved: number;
  total: number;
  preview: CaseReorderPreviewRow[];
}

/** 从需求分析记录取排序依据；读不到来源文档时只用条目 / 测试点序 */
export async function reorderSourceFromDoc(doc: ReqAnalysisDoc): Promise<CaseReorderSource> {
  const outlineOrder = [...outlineDocOrderIndex(doc.outline ?? []).entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
  const storySourceRefs = new Map<string, string[]>(
    (doc.stories ?? []).map((s) => [s.id.toUpperCase(), s.sourceRefs ?? []] as const),
  );
  let idealOrder: string[] = [];
  if (doc.sourcePath) {
    try {
      const text = await readRequirementTextForOrder(doc.sourcePath);
      idealOrder = extractReqSectionOrder(text);
    } catch {
      idealOrder = [];
    }
  }
  return {
    outlineOrder,
    testPointIds: doc.testPoints?.points?.map((p) => p.id) ?? undefined,
    idealOrder,
    storySourceRefs,
  };
}

/** 走生成入库相同口径：mxd / csv / xlsx 读成文本，docx 抽纯文本 */
async function readRequirementTextForOrder(reqPath: string): Promise<string> {
  const lower = reqPath.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const raw = await readDocsRaw('requirements', reqPath);
    if (raw.encoding !== 'base64' || !raw.contentBase64) throw new Error('无法读取 Excel');
    const XLSX = await import('xlsx');
    const book = XLSX.read(raw.contentBase64, { type: 'base64', cellDates: true });
    const parts: string[] = [];
    for (const name of book.SheetNames) {
      const sheet = book.Sheets[name];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
      if (csv) parts.push(`## 工作表：${name}\n${csv}`);
    }
    return parts.join('\n\n').trim();
  }
  if (lower.endsWith('.docx')) {
    const raw = await readDocsRaw('requirements', reqPath);
    if (raw.encoding !== 'base64' || !raw.contentBase64) throw new Error('无法读取 docx');
    const bin = atob(raw.contentBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
    return (result.value ?? '').trim();
  }
  const r = await readDocsText('requirements', reqPath);
  return r.content;
}

/** 需求分析记录列表（重排对话框的选择项） */
export async function listReorderSources(): Promise<ReqAnalysisDoc[]> {
  try {
    return await listReqDocs();
  } catch {
    return [];
  }
}

function renumberRows(rows: CaseRow[], headers: string[]): CaseRow[] {
  const noCol = caseFieldMap(headers).no;
  if (!noCol) return rows;
  return rows.map((row, i) => ({ ...row, [noCol]: String(i + 1) }));
}

/**
 * 预演：读文件 + 排序 + 重编号，不落盘。
 * `source` 为空时只按「引用需求点」里的 RO / TP 编号自然序兜底。
 */
export async function planCaseReorder(
  casePath: string,
  source: CaseReorderSource = {},
): Promise<CaseReorderPlan> {
  const file = await readCaseFile(casePath);
  const sortedRaw = sortGeneratedCaseRows(file.rows, file.headers, {
    outlineOrder: source.outlineOrder,
    testPointIds: source.testPointIds,
    idealOrder: source.idealOrder,
    storySourceRefs: source.storySourceRefs,
  });
  // 位置变了的行数：比较对象引用即可（sortGeneratedCaseRows 不改行对象）
  const moved = sortedRaw.filter((row, i) => row !== file.rows[i]).length;
  const sorted = renumberRows(sortedRaw, file.headers);
  const map = caseFieldMap(file.headers);
  const noCol = map.no;
  const titleCol = map.title;
  const citeCol = map.reqCite;
  const preview: CaseReorderPreviewRow[] = sorted.slice(0, 5).map((row) => ({
    no: noCol ? String(row[noCol] ?? '') : '',
    title: titleCol ? String(row[titleCol] ?? '') : '',
    cite: citeCol ? String(row[citeCol] ?? '') : '',
  }));
  return {
    casePath,
    headers: file.headers,
    rows: sorted,
    moved,
    total: sorted.length,
    preview,
  };
}

/**
 * 落盘：先备份到「用例管理/备份列表/」，再整表覆盖。
 * @returns 备份文件相对路径（备份失败会抛错，不会写文件）
 */
export async function applyCaseReorder(plan: CaseReorderPlan): Promise<{ backup: string }> {
  const backup = await createCaseReviewBackup(plan.casePath);
  const res = await rewriteCaseRows(plan.casePath, plan.headers, plan.rows);
  return { backup: res.backup || backup.backup };
}
