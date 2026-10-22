/**
 * 用例文件 ↔ 行数据：md 表格 / csv / xlsx。
 *
 * 只负责「读出来」与「拼成待写回的行」；写回文件由服务端
 * `lh-plugins/lh-case-review.mjs` 的 `/append` 完成（它负责备份与保格式）。
 */
import * as XLSX from 'xlsx';
import { readDocsRaw, readDocsText } from './project-docs';
import { canonicalizeRows } from './case-fields';
import { CASE_FIELDS } from './export';

export type CaseRow = Record<string, string>;

export interface CaseFileData {
  /** 磁盘扩展名（小写，带点） */
  ext: string;
  headers: string[];
  rows: CaseRow[];
  /** 原始文本（md / csv 才有） */
  text?: string;
}

const TEXT_EXTS = ['.md', '.markdown', '.txt', '.csv'];
const SHEET_EXTS = ['.xlsx', '.xls'];

function decodeCell(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(decodeCell);
}

function isSepRow(line: string): boolean {
  return /^\s*\|?[\s-:|]+\|?\s*$/.test(line) && /-+/.test(line);
}

/** 从 Markdown 里找第一张含「用例」表头的表；找不到退回标准字段 + 空行集 */
export function parseMarkdownCaseRows(md: string): { headers: string[]; rows: CaseRow[] } {
  const lines = String(md ?? '').split(/\r?\n/);
  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('|')) continue;
    const cols = splitRow(lines[i]);
    if (cols.some((c) => c.includes('用例')) && cols.length >= 2) {
      headerIdx = i;
      headers = cols;
      break;
    }
  }
  if (headerIdx < 0 || !headers.length) return { headers: [...CASE_FIELDS], rows: [] };

  const start = isSepRow(lines[headerIdx + 1] ?? '') ? headerIdx + 2 : headerIdx + 1;
  const rows: CaseRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|') || isSepRow(line)) {
      if (rows.length > 0 && !line.includes('|')) break;
      continue;
    }
    const cols = splitRow(line);
    if (cols.every((c) => !c)) continue;
    const row: CaseRow = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    if (!Object.values(row).some((v) => v.trim())) continue;
    rows.push(row);
  }
  return { headers, rows };
}

/** CSV：支持 BOM、双引号包裹、字段内逗号 / 换行 / 转义引号 */
export function parseCsvCaseRows(raw: string): { headers: string[]; rows: CaseRow[] } {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      field = '';
      if (record.some((c) => c.trim())) records.push(record);
      record = [];
      continue;
    }
    field += ch;
  }
  record.push(field);
  if (record.some((c) => c.trim())) records.push(record);

  const [head, ...body] = records;
  const columns = (head ?? []).map((h) => String(h ?? '').trim());
  const headers = columns.filter(Boolean);
  if (!headers.length) return { headers: [...CASE_FIELDS], rows: [] };
  // 按原始列号取值：中间有空表头时不能把后面的列往前挤
  const rows = body.map((cells) => {
    const row: CaseRow = {};
    columns.forEach((name, idx) => {
      if (!name) return;
      row[name] = String(cells[idx] ?? '').trim();
    });
    return row;
  });
  return { headers, rows };
}

/** xlsx：读首个工作表，第一行当表头 */
export function parseXlsxCaseRows(contentBase64: string): { headers: string[]; rows: CaseRow[] } {
  const book = XLSX.read(contentBase64, { type: 'base64', cellDates: true });
  const name = book.SheetNames[0];
  const sheet = name ? book.Sheets[name] : undefined;
  if (!sheet) return { headers: [...CASE_FIELDS], rows: [] };
  const table = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false,
  }) as unknown as unknown[][];
  const headers = ((table[0] ?? []) as unknown[]).map((h) => String(h ?? '').trim());
  const used = headers.filter(Boolean);
  if (!used.length) return { headers: [...CASE_FIELDS], rows: [] };
  const rows: CaseRow[] = [];
  for (const cells of table.slice(1)) {
    const row: CaseRow = {};
    // 按原始列号取值：中间有空表头时不能把后面的列往前挤
    headers.forEach((h, idx) => {
      if (!h) return;
      row[h] = String((cells as unknown[])[idx] ?? '').trim();
    });
    if (!Object.values(row).some((v) => v.trim())) continue;
    rows.push(row);
  }
  return { headers: used, rows };
}

/** 读用例文件：按扩展名分派；行上补好标准字段（表头别名见 case-fields） */
export async function readCaseFile(filePath: string): Promise<CaseFileData> {
  const ext = `.${(filePath.split('.').pop() ?? '').toLowerCase()}`;
  if (SHEET_EXTS.includes(ext)) {
    const raw = await readDocsRaw('cases', filePath);
    if (raw.encoding !== 'base64' || !raw.contentBase64) throw new Error('无法读取该用例文件');
    const parsed = parseXlsxCaseRows(raw.contentBase64);
    return { ext, ...parsed, rows: canonicalizeRows(parsed.rows) };
  }
  if (!TEXT_EXTS.includes(ext)) {
    throw new Error(`暂不支持评审 ${ext} 文件，请用 md / csv / xlsx`);
  }
  const { content } = await readDocsText('cases', filePath);
  const parsed = ext === '.csv' ? parseCsvCaseRows(content) : parseMarkdownCaseRows(content);
  return { ext, ...parsed, rows: canonicalizeRows(parsed.rows), text: content };
}

/** 字段集合：文件表头优先，缺的用标准字段补在后面 */
export function mergeHeaders(headers: string[]): string[] {
  const out: string[] = [];
  for (const h of [...headers, ...CASE_FIELDS]) {
    const name = String(h ?? '').trim();
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}
