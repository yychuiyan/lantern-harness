/**
 * 解析用例模板文件（xlsx / csv / md 表头），供生成会话对齐字段结构。
 */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { CASE_FIELDS, looksLikeStepField, normalizeMultilineCell } from './export';

export interface ParsedCaseTemplate {
  headers: string[];
  /** 供 Prompt 引用的说明文本（含样例） */
  body: string;
}

function nonEmptyRow(row: unknown[]): boolean {
  return row.some((c) => String(c ?? '').trim().length > 0);
}

export function parseXlsxTemplateBase64(contentBase64: string): ParsedCaseTemplate {
  const wb = XLSX.read(contentBase64, { type: 'base64' });
  const sheetName = wb.SheetNames[0] ?? 'Sheet1';
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    return { headers: [...CASE_FIELDS], body: '' };
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: false,
  }) as unknown[][];
  const headerRow = (rows.find(nonEmptyRow) ?? []) as unknown[];
  const headers = headerRow.map((h) => String(h ?? '').trim()).filter(Boolean);
  if (!headers.length) {
    return { headers: [...CASE_FIELDS], body: `（模板工作表「${sheetName}」无表头）` };
  }

  const dataRows = rows.filter(nonEmptyRow).slice(1, 4);
  const lines = [
    `工作表：${sheetName}`,
    `字段（必须原样作为 JSON 对象键，顺序一致）：${headers.join('、')}`,
    '',
    '样例行（风格与粒度请对齐，勿照抄业务内容）：',
  ];
  for (const row of dataRows) {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = String((row as unknown[])[i] ?? '').trim();
    });
    lines.push(JSON.stringify(obj, null, 2));
  }
  return { headers, body: lines.join('\n') };
}

export function parseCsvTemplate(content: string): ParsedCaseTemplate {
  const first = content.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const headers = first
    .split(',')
    .map((h) => h.replace(/^"|"$/g, '').trim())
    .filter(Boolean);
  if (!headers.length) return { headers: [...CASE_FIELDS], body: content };
  return {
    headers,
    body: `字段（必须原样作为 JSON 对象键）：${headers.join('、')}\n\n${content}`,
  };
}

export function parseMdTemplate(content: string): ParsedCaseTemplate {
  const table = content.match(/^\|(.+)\|\s*$/m);
  if (table?.[1]) {
    const headers = table[1]
      .split('|')
      .map((h) => h.trim())
      .filter((h) => h && !/^[-:]+$/.test(h));
    if (headers.length) {
      return {
        headers,
        body: `字段（必须原样作为 JSON 对象键）：${headers.join('、')}\n\n${content}`,
      };
    }
  }
  return { headers: [...CASE_FIELDS], body: content };
}

export type CaseRow = Record<string, string>;

export function normalizeCaseRows(arr: unknown[], headers: string[]): CaseRow[] {
  const fields = headers.length ? headers : [...CASE_FIELDS];
  return arr.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    const row: CaseRow = {};
    for (const f of fields) {
      const v = obj[f];
      const raw = typeof v === 'string' ? v : v == null ? '' : String(v);
      row[f] = looksLikeStepField(f) ? normalizeMultilineCell(raw) : raw;
    }
    return row;
  });
}

/** 与理想功能模板一致的列下拉（有对应表头才注入） */
const CASE_SHEET_DROPDOWNS: Record<string, string[]> = {
  实际结果: ['P', 'F'],
  优先级: ['P0', 'P1', 'P2', 'P3'],
  用例状态: ['待验证', '通过', '不通过', '阻塞', '跳过'],
};

function colLetter(index: number): string {
  let n = index;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function buildDataValidationsXml(headers: string[]): string {
  const items: string[] = [];
  headers.forEach((h, i) => {
    const options = CASE_SHEET_DROPDOWNS[h];
    if (!options?.length) return;
    const col = colLetter(i);
    const list = options.join(',');
    items.push(
      `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${col}2:${col}1048576"><formula1>"${list}"</formula1></dataValidation>`,
    );
  });
  if (!items.length) return '';
  return `<dataValidations count="${items.length}">${items.join('')}</dataValidations>`;
}

/**
 * SheetJS 写出后的抛光：换行、表头黑底白字、以及模板同款下拉。
 */
async function polishCaseXlsxBase64(b64: string, headers: string[]): Promise<string> {
  const zip = await JSZip.loadAsync(b64, { base64: true });
  const stylesPath = 'xl/styles.xml';
  const stylesFile = zip.file(stylesPath);
  let wrapXf = 1;
  let headerXf = 1;
  if (stylesFile) {
    let styles = await stylesFile.async('string');
    // 补黑底白字表头 + wrapText 数据样式（认 fill/字体特征，不再写 XML 注释）
    const alreadyPolished =
      styles.includes('fgColor rgb="FF000000"') && styles.includes('Microsoft YaHei');
    if (!alreadyPolished) {
      if (!styles.includes('<fills ')) {
        styles = styles.replace(
          '</fonts>',
          '</fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
        );
      }
      styles = styles
        .replace(/<fonts([^>]*)count="(\d+)"/, (_, a, n) => `<fonts${a}count="${Number(n) + 1}"`)
        .replace(
          '</fonts>',
          '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font></fonts>',
        )
        .replace(/<fills([^>]*)count="(\d+)"/, (_, a, n) => `<fills${a}count="${Number(n) + 1}"`)
        .replace(
          '</fills>',
          '<fill><patternFill patternType="solid"><fgColor rgb="FF000000"/><bgColor indexed="64"/></patternFill></fill></fills>',
        );

      const fontCount = Number(styles.match(/<fonts[^>]*count="(\d+)"/)?.[1] ?? 2);
      const fillCount = Number(styles.match(/<fills[^>]*count="(\d+)"/)?.[1] ?? 3);
      const headerFontId = fontCount - 1;
      const headerFillId = fillCount - 1;

      if (/<cellXfs[^>]*count="1"[^>]*>\s*<xf[^/]*\/>\s*<\/cellXfs>/.test(styles)) {
        styles = styles.replace(
          /<cellXfs([^>]*)count="1"([^>]*)>\s*<xf([^/]*)\/>\s*<\/cellXfs>/,
          `<cellXfs$1count="3"$2><xf$3/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="${headerFontId}" fillId="${headerFillId}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs>`,
        );
        wrapXf = 1;
        headerXf = 2;
      } else if (styles.includes('</cellXfs>')) {
        const prev = Number(styles.match(/<cellXfs[^>]*count="(\d+)"/)?.[1] ?? 1);
        wrapXf = prev;
        headerXf = prev + 1;
        styles = styles
          .replace(/<cellXfs([^>]*)count="(\d+)"/, (_, a) => `<cellXfs${a}count="${prev + 2}"`)
          .replace(
            '</cellXfs>',
            `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="${headerFontId}" fillId="${headerFillId}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs>`,
          );
      }
      zip.file(stylesPath, styles);
    } else if (!styles.includes('wrapText')) {
      if (styles.includes('</cellXfs>')) {
        styles = styles
          .replace(/<cellXfs([^>]*)count="(\d+)"/, (_, a, n) => {
            return `<cellXfs${a}count="${Number(n) + 1}"`;
          })
          .replace(
            '</cellXfs>',
            '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>',
          );
        zip.file(stylesPath, styles);
      }
    }
  }

  const sheetNames = Object.keys(zip.files).filter((n) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  const dvXml = buildDataValidationsXml(headers);
  for (const sheetPath of sheetNames) {
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) continue;
    let sheet = await sheetFile.async('string');
    // 表头行套用黑底白字；数据字符串单元格套用 wrap
    sheet = sheet.replace(/<c\b([^>]*)>/g, (full, attrs: string) => {
      const rowMatch = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      const row = rowMatch ? Number(rowMatch[2]) : 0;
      if (row === 1) {
        if (/\bs="\d+"/.test(attrs)) {
          return `<c${attrs.replace(/\bs="\d+"/, `s="${headerXf}"`)}>`;
        }
        return `<c s="${headerXf}"${attrs.startsWith(' ') ? attrs : ` ${attrs}`}>`;
      }
      if (!/\bt="str"/.test(attrs)) return full;
      if (/\bs="\d+"/.test(attrs)) return full;
      return `<c s="${wrapXf}"${attrs.startsWith(' ') ? attrs : ` ${attrs}`}>`;
    });
    sheet = sheet.replace(/<row r="(\d+)"([^>]*)>/g, (_full, r: string, rest: string) => {
      if (Number(r) === 1) {
        if (/\bht=/.test(rest)) return `<row r="${r}"${rest}>`;
        return `<row r="${r}" ht="22" customHeight="1"${rest}>`;
      }
      if (/\bht=/.test(rest)) return `<row r="${r}"${rest}>`;
      return `<row r="${r}" ht="60" customHeight="1"${rest}>`;
    });
    // OOXML 规定 dataValidations 必须在 ignoredErrors 之前；
    // 插到文件末尾会被 Excel 判「部分内容有问题」并弹恢复框。
    if (dvXml && !sheet.includes('<dataValidations')) {
      if (sheet.includes('<ignoredErrors')) {
        sheet = sheet.replace('<ignoredErrors', `${dvXml}<ignoredErrors`);
      } else if (sheet.includes('</sheetData>')) {
        sheet = sheet.replace('</sheetData>', `</sheetData>${dvXml}`);
      } else if (sheet.includes('</worksheet>')) {
        sheet = sheet.replace('</worksheet>', `${dvXml}</worksheet>`);
      }
    }
    zip.file(sheetPath, sheet);
  }

  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function mdCell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
}

export function rowsToMarkdown(cases: CaseRow[], title: string, headers: string[]): string {
  const fields = headers.length ? headers : [...CASE_FIELDS];
  const lines = [
    `# ${title}`,
    '',
    `| ${fields.join(' | ')} |`,
    `|${fields.map(() => '---').join('|')}|`,
  ];
  for (const c of cases) {
    lines.push(`| ${fields.map((f) => mdCell(c[f] ?? '')).join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}

export function rowsToCsv(cases: CaseRow[], headers: string[]): string {
  const fields = headers.length ? headers : [...CASE_FIELDS];
  const header = fields.join(',');
  const rows = cases.map((c) => fields.map((f) => csvCell(c[f] ?? '')).join(','));
  return '\uFEFF' + [header, ...rows].join('\n');
}

export async function rowsToXlsxBase64(
  cases: CaseRow[],
  headers: string[],
  sheetName = '测试用例',
): Promise<string> {
  const fields = headers.length ? headers : [...CASE_FIELDS];
  const normalized = cases.map((c) => {
    const row: CaseRow = {};
    for (const f of fields) {
      let raw = c[f] ?? '';
      if (f === '用例状态' && !String(raw).trim()) raw = '待验证';
      if (f === '实际结果') raw = '';
      row[f] = looksLikeStepField(f) && f !== '实际结果' ? normalizeMultilineCell(raw) : raw;
    }
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(normalized, { header: [...fields] });
  // 步骤/期望列加宽；写入前把单元格值再走一遍（含已有 \n）
  const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
  if (range) {
    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = ws[addr];
        if (!cell || typeof cell.v !== 'string') continue;
        if (R === 0) continue;
        const header = String(ws[XLSX.utils.encode_cell({ r: 0, c: C })]?.v ?? '');
        if (looksLikeStepField(header) && header !== '实际结果') {
          cell.v = normalizeMultilineCell(cell.v);
          if (cell.w != null) cell.w = cell.v;
        }
      }
    }
  }
  ws['!cols'] = fields.map((f) => ({
    wch:
      f === '实际结果' || f === '优先级' || f === '用例状态'
        ? 12
        : looksLikeStepField(f)
          ? 48
          : Math.min(28, Math.max(12, f.length + 4)),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const raw = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }) as string;
  try {
    return await polishCaseXlsxBase64(raw, fields);
  } catch {
    return raw;
  }
}
