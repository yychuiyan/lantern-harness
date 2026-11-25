import { bindCaseIdentities, recordManualVerification } from './assets.mjs';
import crypto from 'node:crypto';
import { validateDefectLinks, CASE_FIELD_ALIASES } from '../../builtin/case-workflow-contract.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { resolveContentRoot } from '../../builtin/session/space-layout.mjs';
import {
  CASE_BACKUP_DIR_NAME,
  backupDirectoryForCasePath,
} from '../../builtin/case-backup-contract.mjs';

const CASE_DIR_NAME = '用例管理';
const DEFECT_URL_HEADER = '缺陷信息';
const LEGACY_DEFECT_URL_HEADER = '缺陷地址';
const DEFECT_TITLE_HEADER = '缺陷标题';
const EXECUTION_STATUSES = ['待验证', '通过', '不通过', '阻塞', '跳过'];

const ALIASES = {
  ...CASE_FIELD_ALIASES,
  no: CASE_FIELD_ALIASES.no,
  title: CASE_FIELD_ALIASES.title,
  precondition: CASE_FIELD_ALIASES.precondition,
  steps: CASE_FIELD_ALIASES.steps,
  expected: CASE_FIELD_ALIASES.expected,
  priority: CASE_FIELD_ALIASES.priority,
  module: CASE_FIELD_ALIASES.module,
  submodule: CASE_FIELD_ALIASES.submodule,
  status: ['用例状态', '执行状态', '执行结果', '测试结果'],
  actual: ['实际结果', '实测结果', '执行实际结果'],
  executor: ['执行人', '测试人'],
  executedAt: ['执行时间', '测试时间'],
  evidence: ['执行证据', '截图日志', '证据'],
  defectNo: ['缺陷编号', '缺陷ID', 'BUG编号', 'bug编号'],
  defectTitle: ['缺陷标题', 'BUG标题', 'bug标题', '缺陷名称', '缺陷主题'],
  defectUrl: [
    '缺陷信息',
    LEGACY_DEFECT_URL_HEADER,
    '缺陷链接',
    '缺陷URL',
    'BUG地址',
    'bug地址',
    'bug链接',
  ],
};

const DEFECT_URL_ALIASES = new Set(ALIASES.defectUrl);
const DEFECT_TITLE_ALIASES = new Set(ALIASES.defectTitle);

function isDefectUrlFieldHeader(header) {
  return header === DEFECT_URL_HEADER || DEFECT_URL_ALIASES.has(header);
}

function isDefectTitleFieldHeader(header) {
  return header === DEFECT_TITLE_HEADER || DEFECT_TITLE_ALIASES.has(header);
}

function text(value, max = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeHeader(value) {
  return String(value || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s*＊・·:：]/g, '')
    .toLowerCase();
}

function fieldMap(headers) {
  const pairs = headers
    .map((header) => ({ raw: String(header || ''), norm: normalizeHeader(header) }))
    .filter((item) => item.raw && item.norm);
  const mapped = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases.map(normalizeHeader)) {
      const hit =
        pairs.find((item) => !used.has(item.raw) && item.norm === alias) ||
        pairs.find(
          (item) =>
            !used.has(item.raw) &&
            alias.length >= 2 &&
            item.norm.startsWith(alias) &&
            item.norm.length - alias.length <= 4,
        );
      if (!hit) continue;
      mapped[field] = hit.raw;
      used.add(hit.raw);
      break;
    }
  }
  return mapped;
}

function rowValue(row, map, field) {
  const header = map[field];
  return header ? String(row[header] ?? '') : '';
}

function caseRoot(root) {
  return resolveContentRoot(root, CASE_DIR_NAME).abs;
}

function safeCasePath(root, relativePath) {
  const base = path.resolve(caseRoot(root));
  const abs = path.resolve(base, text(relativePath, 1000));
  if (abs === base || !abs.startsWith(base + path.sep)) {
    throw Object.assign(new Error('用例文件路径越界'), { statusCode: 400 });
  }
  return abs;
}

function ignored(name) {
  return (
    name === '.DS_Store' ||
    name === '.gitkeep' ||
    name.startsWith('~$') ||
    name.startsWith('.~lock.') ||
    /\.bak(?:[-_.].*)?$/i.test(name) ||
    name.endsWith('~')
  );
}

function walkCaseFiles(root, dir = caseRoot(root), relative = '') {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored(item.name)) continue;
    const rel = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) {
      if (item.name === CASE_BACKUP_DIR_NAME) continue;
      files.push(...walkCaseFiles(root, path.join(dir, item.name), rel));
      continue;
    }
    if (!item.isFile() || !/\.(xlsx|xls|csv|md)$/i.test(item.name)) continue;
    const abs = path.join(dir, item.name);
    const stat = fs.statSync(abs);
    files.push({
      path: rel,
      name: item.name,
      ext: path.extname(item.name).toLowerCase(),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    });
  }
  return files.sort(
    (left, right) =>
      right.mtime.localeCompare(left.mtime) || left.path.localeCompare(right.path, 'zh'),
  );
}

function decodeCell(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function splitMarkdownRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(decodeCell);
}

function isMarkdownSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-+/.test(line);
}

function parseMarkdown(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let headerIndex = -1;
  let headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('|')) continue;
    const cells = splitMarkdownRow(lines[index]);
    if (!cells.some((cell) => /用例|测试/.test(cell)) || cells.length < 2) continue;
    headerIndex = index;
    headers = cells;
    break;
  }
  if (headerIndex < 0) {
    throw Object.assign(new Error('没有找到 Markdown 用例表头'), { statusCode: 422 });
  }
  const rows = [];
  let dataStart = headerIndex + (isMarkdownSeparator(lines[headerIndex + 1] || '') ? 2 : 1);
  for (let index = dataStart; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes('|')) break;
    if (isMarkdownSeparator(line)) continue;
    const cells = splitMarkdownRow(line);
    if (!cells.some(Boolean)) continue;
    const row = {};
    headers.forEach((header, column) => {
      if (header) row[header] = cells[column] ?? '';
    });
    rows.push({ row, lineIndex: index });
  }
  return { kind: 'md', lines, headers, rows, headerIndex };
}

function parseCsvRecords(raw) {
  const source = raw.replace(/^\uFEFF/, '');
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      record.push(field);
      field = '';
      if (record.some((cell) => cell.trim())) records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  record.push(field);
  if (record.some((cell) => cell.trim())) records.push(record);
  return records;
}

function parseCsv(raw) {
  const records = parseCsvRecords(raw);
  if (!records.length) throw Object.assign(new Error('CSV 没有表头'), { statusCode: 422 });
  const headers = records[0].map((cell) => String(cell || '').trim());
  const rows = records.slice(1).map((cells, index) => {
    const row = {};
    headers.forEach((header, column) => {
      if (header) row[header] = String(cells[column] ?? '').trim();
    });
    return { row, lineIndex: index + 1 };
  });
  return { kind: 'csv', headers, rows };
}

function headerScore(cells) {
  const headers = cells.map((cell) => String(cell || '').trim()).filter(Boolean);
  const map = fieldMap(headers);
  if (!map.title || !map.steps) return 0;
  return Object.keys(map).length * 10 + (map.expected ? 8 : 0) + (map.no ? 4 : 0);
}

async function parseXlsx(buffer) {
  const mod = await import('xlsx');
  const xlsx = mod.default ?? mod;
  const book = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  let best = null;
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    if (!sheet) continue;
    const range = sheet['!ref'] ? xlsx.utils.decode_range(sheet['!ref']) : { s: { r: 0 } };
    const table = xlsx.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: true,
    });
    const bonus = /用例|测试/.test(sheetName) ? 20 : 0;
    for (let index = 0; index < Math.min(30, table.length); index += 1) {
      const score = headerScore(table[index] || []) + bonus - index;
      if (score <= 0) continue;
      if (!best || score > best.score) {
        best = {
          score,
          sheetName,
          headerRowIndex: index,
          headers: (table[index] || []).map((cell) => String(cell ?? '').trim()),
          table,
          sheetStartRow: range.s.r,
        };
      }
    }
  }
  if (!best) throw Object.assign(new Error('没有找到 Excel 用例表头'), { statusCode: 422 });
  const rows = [];
  for (let index = best.headerRowIndex + 1; index < best.table.length; index += 1) {
    const cells = best.table[index] || [];
    if (!cells.some((cell) => String(cell ?? '').trim())) continue;
    const row = {};
    best.headers.forEach((header, column) => {
      if (header) row[header] = String(cells[column] ?? '').trim();
    });
    rows.push({
      row,
      dataIndex: index - best.headerRowIndex - 1,
      physicalRow: best.sheetStartRow + index + 1,
    });
  }
  return {
    kind: 'xlsx',
    headers: best.headers.filter(Boolean),
    rawHeaders: best.headers,
    rows,
    sheetName: best.sheetName,
    headerRowIndex: best.headerRowIndex,
    headerRowNumber: best.sheetStartRow + best.headerRowIndex + 1,
  };
}

function rowId(row, map, index) {
  const no = rowValue(row, map, 'no');
  const title = rowValue(row, map, 'title');
  return `${no || index + 1}\0${title}`;
}

function publicRow(parsed, item, index) {
  const map = fieldMap(parsed.headers);
  const row = item.row;
  const status = rowValue(row, map, 'status');
  const actual = rowValue(row, map, 'actual');
  return {
    rowIndex: index,
    id: crypto
      .createHash('sha1')
      .update(rowId(row, map, index))
      .digest('hex')
      .slice(0, 16),
    no: rowValue(row, map, 'no'),
    title: rowValue(row, map, 'title'),
    module: [rowValue(row, map, 'module'), rowValue(row, map, 'submodule')]
      .filter(Boolean)
      .join(' / '),
    priority: rowValue(row, map, 'priority'),
    precondition: rowValue(row, map, 'precondition'),
    steps: rowValue(row, map, 'steps'),
    expected: rowValue(row, map, 'expected'),
    status,
    actual,
    executor: rowValue(row, map, 'executor'),
    executedAt: rowValue(row, map, 'executedAt'),
    evidence: rowValue(row, map, 'evidence'),
    defectNo: rowValue(row, map, 'defectNo'),
    defectTitle: rowValue(row, map, 'defectTitle'),
    defectUrl: rowValue(row, map, 'defectUrl'),
    fields: parsed.headers
      .filter(Boolean)
      .map((header) => ({ name: String(header), value: String(row[header] ?? '') })),
  };
}

export async function loadCaseDocument(root, relativePath) {
  const abs = safeCasePath(root, relativePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw Object.assign(new Error('用例文件不存在'), { statusCode: 404 });
  }
  const buffer = fs.readFileSync(abs);
  const fileHash = hashBuffer(buffer);
  const ext = path.extname(abs).toLowerCase();
  let parsed;
  if (ext === '.xlsx' || ext === '.xls') parsed = await parseXlsx(buffer);
  else if (ext === '.csv') parsed = parseCsv(buffer.toString('utf8'));
  else if (ext === '.md') parsed = parseMarkdown(buffer.toString('utf8'));
  else throw Object.assign(new Error(`不支持 ${ext} 用例文件`), { statusCode: 415 });
  const map = fieldMap(parsed.headers);
  const cases = parsed.rows.map((item, index) => publicRow(parsed, item, index));
  const missingColumns = [!map.status ? '用例状态' : '', !map.actual ? '实际结果' : ''].filter(
    Boolean,
  );
  const executionIssue =
    ext === '.xls'
      ? '旧版 .xls 暂不支持安全写回，请先另存为 .xlsx'
      : missingColumns.length
        ? `缺少执行列：${missingColumns.join('、')}`
        : '';
  return bindCaseIdentities(root, {
    path: relativePath.replaceAll('\\', '/'),
    abs,
    ext,
    fileHash,
    headers: parsed.headers,
    rawHeaders: parsed.rawHeaders || parsed.headers,
    sheetName: parsed.sheetName || '',
    headerRowIndex: parsed.headerRowIndex ?? 0,
    cases,
    columns: {
      expected: map.expected || '',
      priority: map.priority || '',
      status: map.status || '',
      actual: map.actual || '',
      executor: map.executor || '',
      executedAt: map.executedAt || '',
      evidence: map.evidence || '',
      defectNo: map.defectNo || '',
      defectTitle: map.defectTitle || '',
      defectUrl: map.defectUrl || '',
    },
    executable: !executionIssue,
    missingColumns,
    executionIssue,
    statuses: EXECUTION_STATUSES,
    _parsed: parsed,
    _map: map,
  });
}

export async function listCaseDocuments(root) {
  const files = walkCaseFiles(root);
  const documents = [];
  for (const file of files) {
    try {
      const document = await loadCaseDocument(root, file.path);
      documents.push({
        ...file,
        caseCount: document.cases.length,
        executable: document.executable,
        missingColumns: document.missingColumns,
        executionIssue: document.executionIssue,
      });
    } catch (error) {
      documents.push({
        ...file,
        caseCount: 0,
        executable: false,
        missingColumns: [],
        executionIssue: '用例文件解析失败',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return documents;
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function backupCaseDocument(root, relativePath) {
  const abs = safeCasePath(root, relativePath);
  const backupDir = path.join(
    caseRoot(root),
    ...backupDirectoryForCasePath(relativePath).split('/'),
  );
  fs.mkdirSync(backupDir, { recursive: true });
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);
  let target = path.join(backupDir, `${base}_bak_${stamp()}${ext}`);
  let index = 2;
  while (fs.existsSync(target)) {
    target = path.join(backupDir, `${base}_bak_${stamp()}_${index}${ext}`);
    index += 1;
  }
  fs.copyFileSync(abs, target);
  return path.relative(caseRoot(root), target).replaceAll('\\', '/');
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase() || 'A';
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function columnName(index) {
  let value = index;
  let out = '';
  while (value > 0) {
    value -= 1;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
}

function replaceCell(rowXml, cellRef, value, styleHint = '') {
  const cellRe = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
  const cells = [...rowXml.matchAll(cellRe)].map((match) => match[0]);
  const wanted = columnIndex(cellRef);
  const existing = cells.find((cell) => {
    const ref = /\br="([A-Z]+\d+)"/i.exec(cell)?.[1] || '';
    return ref.toUpperCase() === cellRef.toUpperCase();
  });
  const style = existing ? /\bs="(\d+)"/.exec(existing)?.[1] : styleHint;
  const nextCell = `<c r="${cellRef}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  const without = cells.filter((cell) => cell !== existing);
  without.push(nextCell);
  without.sort((left, right) => {
    const leftRef = /\br="([A-Z]+\d+)"/i.exec(left)?.[1] || 'A1';
    const rightRef = /\br="([A-Z]+\d+)"/i.exec(right)?.[1] || 'A1';
    return columnIndex(leftRef) - columnIndex(rightRef);
  });
  const outer = rowXml.replace(cellRe, '').replace(/<\/row>$/i, '');
  return `${outer}${without.join('')}</row>`;
}

async function patchXlsx(abs, parsed, rowIndex, updates) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(abs));
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbook || !rels) throw new Error('Excel 工作簿结构不完整');
  const safeName = parsed.sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sheetTag = new RegExp(`<sheet\\b[^>]*name="${safeName}"[^>]*>`, 'i').exec(workbook)?.[0];
  const relationId = sheetTag ? /\br:id="([^"]+)"/i.exec(sheetTag)?.[1] : '';
  const relationTag = relationId
    ? new RegExp(`<Relationship\\b[^>]*Id="${relationId}"[^>]*>`, 'i').exec(rels)?.[0]
    : '';
  const target = relationTag ? /\bTarget="([^"]+)"/i.exec(relationTag)?.[1] || '' : '';
  if (!target) throw new Error(`找不到工作表 ${parsed.sheetName}`);
  const sheetPath = target.startsWith('/')
    ? target.slice(1)
    : path.posix.normalize(`xl/${target.replace(/^\.\//, '')}`);
  const file = zip.file(sheetPath);
  if (!file) throw new Error('找不到工作表 XML');
  let xml = await file.async('string');
  const physicalRow = parsed.rows[rowIndex]?.physicalRow;
  if (!Number.isInteger(physicalRow) || physicalRow < 1) {
    throw new Error('找不到要写回的 Excel 用例行');
  }
  const rowRe = new RegExp(`<row\\b[^>]*\\br="${physicalRow}"[^>]*>[\\s\\S]*?<\\/row>`, 'i');
  let rowXml = rowRe.exec(xml)?.[0] || '';
  if (!rowXml) throw new Error(`找不到第 ${physicalRow} 行`);
  for (const update of updates) {
    const rawHeaders = parsed.rawHeaders || parsed.headers;
    const column = rawHeaders.indexOf(update.header) + 1;
    if (column <= 0) continue;
    rowXml = replaceCell(rowXml, `${columnName(column)}${physicalRow}`, update.value);
  }
  xml = xml.replace(rowRe, rowXml);
  zip.file(sheetPath, xml);
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const temp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, output);
  fs.renameSync(temp, abs);
}

function markdownCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>');
}

function csvCell(value) {
  const raw = String(value ?? '');
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeTextAtomic(abs, value) {
  const temp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, value, 'utf8');
  fs.renameSync(temp, abs);
}

function patchText(abs, ext, parsed, rowIndex, updates) {
  const raw = fs.readFileSync(abs, 'utf8');
  if (ext === '.csv') {
    const records = parseCsvRecords(raw);
    const header = records[0] || [];
    const row = records[rowIndex + 1] || [];
    for (const update of updates) {
      const column = header.indexOf(update.header);
      if (column < 0) continue;
      while (row.length <= column) row.push('');
      row[column] = update.value;
    }
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const body = records.map((cells) => cells.map(csvCell).join(',')).join(eol);
    writeTextAtomic(abs, `${raw.startsWith('\uFEFF') ? '\uFEFF' : ''}${body}${eol}`);
    return;
  }
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const target = parsed.rows[rowIndex]?.lineIndex;
  if (!Number.isInteger(target) || target < 0 || target >= lines.length) {
    throw new Error('找不到要写回的 Markdown 用例行');
  }
  const cells = splitMarkdownRow(lines[target]);
  for (const update of updates) {
    const column = parsed.headers.indexOf(update.header);
    if (column < 0) continue;
    while (cells.length <= column) cells.push('');
    cells[column] = update.value;
  }
  lines[target] = `| ${cells.map(markdownCell).join(' | ')} |`;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  writeTextAtomic(abs, lines.join(eol));
}

async function appendXlsxHeader(abs, parsed, header) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(abs));
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbook || !rels) throw new Error('Excel 工作簿结构不完整');
  const safeName = parsed.sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sheetTag = new RegExp(`<sheet\\b[^>]*name="${safeName}"[^>]*>`, 'i').exec(workbook)?.[0];
  const relationId = sheetTag ? /\br:id="([^"]+)"/i.exec(sheetTag)?.[1] : '';
  const relationTag = relationId
    ? new RegExp(`<Relationship\\b[^>]*Id="${relationId}"[^>]*>`, 'i').exec(rels)?.[0]
    : '';
  const target = relationTag ? /\bTarget="([^"]+)"/i.exec(relationTag)?.[1] || '' : '';
  if (!target) throw new Error(`找不到工作表 ${parsed.sheetName}`);
  const sheetPath = target.startsWith('/')
    ? target.slice(1)
    : path.posix.normalize(`xl/${target.replace(/^\.\//, '')}`);
  const file = zip.file(sheetPath);
  if (!file) throw new Error('找不到工作表 XML');
  let xml = await file.async('string');
  const physicalRow = parsed.headerRowNumber;
  const rowRe = new RegExp(`<row\\b[^>]*\\br="${physicalRow}"[^>]*>[\\s\\S]*?<\\/row>`, 'i');
  let rowXml = rowRe.exec(xml)?.[0] || '';
  if (!rowXml) throw new Error(`找不到第 ${physicalRow} 行表头`);
  const cells = [...rowXml.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)].map(
    (match) => match[0],
  );
  const styleHint = cells
    .map((cell) => /\bs="(\d+)"/.exec(cell)?.[1] || '')
    .filter(Boolean)
    .at(-1);
  const column = parsed.rawHeaders.length + 1;
  rowXml = replaceCell(rowXml, `${columnName(column)}${physicalRow}`, header, styleHint || '');
  xml = xml.replace(rowRe, rowXml);
  xml = xml.replace(/<dimension\b[^>]*\bref="([^"]+)"[^>]*\/>/i, (tag, ref) => {
    const start = ref.split(':')[0] || 'A1';
    const endRow = /(\d+)$/.exec(ref)?.[1] || String(physicalRow);
    return tag.replace(ref, `${start}:${columnName(column)}${endRow}`);
  });
  zip.file(sheetPath, xml);
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const temp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, output);
  fs.renameSync(temp, abs);
  parsed.headers.push(header);
  parsed.rawHeaders.push(header);
}

function appendTextHeader(abs, ext, parsed, header) {
  const raw = fs.readFileSync(abs, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  if (ext === '.csv') {
    const records = parseCsvRecords(raw);
    if (!records.length) throw new Error('CSV 没有表头');
    records[0].push(header);
    for (const row of records.slice(1)) row.push('');
    const body = records.map((cells) => cells.map(csvCell).join(',')).join(eol);
    writeTextAtomic(abs, `${raw.startsWith('\uFEFF') ? '\uFEFF' : ''}${body}${eol}`);
  } else {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const headerIndex = parsed.headerIndex;
    if (!Number.isInteger(headerIndex) || headerIndex < 0) throw new Error('找不到 Markdown 表头');
    const appendToMarkdownLine = (lineIndex, value) => {
      const cells = splitMarkdownRow(lines[lineIndex]);
      cells.push(value);
      lines[lineIndex] = `| ${cells.map(markdownCell).join(' | ')} |`;
    };
    appendToMarkdownLine(headerIndex, header);
    if (isMarkdownSeparator(lines[headerIndex + 1] || '')) {
      appendToMarkdownLine(headerIndex + 1, '---');
    }
    for (const row of parsed.rows) appendToMarkdownLine(row.lineIndex, '');
    writeTextAtomic(abs, lines.join(eol));
  }
  parsed.headers.push(header);
}

async function appendCaseHeader(document, header) {
  if (document.ext === '.xlsx') {
    await appendXlsxHeader(document.abs, document._parsed, header);
  } else if (document.ext === '.csv' || document.ext === '.md') {
    appendTextHeader(document.abs, document.ext, document._parsed, header);
  } else {
    throw Object.assign(new Error('当前文件格式无法新增字段'), { statusCode: 415 });
  }
}

export async function applyCaseExecutionResult(
  root,
  {
    path: relativePath,
    expectedFileHash,
    rowIndex,
    status,
    actualResult,
    executor = '',
    executedAt = '',
    evidence = '',
    defectNo = '',
  },
) {
  let document = await loadCaseDocument(root, relativePath);
  if (document.ext === '.xls') {
    throw Object.assign(new Error(document.executionIssue), { statusCode: 415 });
  }
  if (!document.executable) {
    throw Object.assign(new Error(document.executionIssue), {
      statusCode: 422,
    });
  }
  if (expectedFileHash !== document.fileHash) {
    throw Object.assign(new Error('用例文件已被外部修改，请重新执行后再写回'), {
      statusCode: 409,
      currentHash: document.fileHash,
    });
  }
  const selectedStatus = text(status, 20);
  if (!EXECUTION_STATUSES.includes(selectedStatus)) {
    throw Object.assign(new Error('用例状态无效'), { statusCode: 400 });
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= document.cases.length) {
    throw Object.assign(new Error('用例行不存在'), { statusCode: 404 });
  }
  const map = document._map;
  const updates = [
    { header: map.status, value: selectedStatus },
    { header: map.actual, value: text(actualResult, 30000) },
    ...(map.executor ? [{ header: map.executor, value: text(executor, 200) }] : []),
    ...(map.executedAt ? [{ header: map.executedAt, value: text(executedAt, 80) }] : []),
    ...(map.evidence ? [{ header: map.evidence, value: text(evidence, 4000) }] : []),
    ...(map.defectNo ? [{ header: map.defectNo, value: text(defectNo, 200) }] : []),
  ].filter((item) => item.header);
  if (document.ext === '.xlsx') {
    await patchXlsx(document.abs, document._parsed, rowIndex, updates);
  } else if (document.ext === '.csv' || document.ext === '.md') {
    patchText(document.abs, document.ext, document._parsed, rowIndex, updates);
  } else {
    throw Object.assign(new Error('旧版 .xls 暂不支持写回，请先另存为 .xlsx'), {
      statusCode: 415,
    });
  }
  return {
    ok: true,
    path: relativePath,
    rowIndex,
    status: selectedStatus,
    // 执行结果写回不生成备份；只有重新生成用例时保留旧稿。
    backup: '',
    fileHash: hashBuffer(fs.readFileSync(document.abs)),
  };
}

export async function applyCaseFieldUpdates(
  root,
  { path: relativePath, expectedFileHash, rowIndex, updates },
) {
  let document = await loadCaseDocument(root, relativePath);
  if (document.ext === '.xls') {
    throw Object.assign(new Error(document.executionIssue), { statusCode: 415 });
  }
  if (expectedFileHash !== document.fileHash) {
    throw Object.assign(new Error('用例文件已被外部修改，请重新读取后再保存'), {
      statusCode: 409,
      currentHash: document.fileHash,
    });
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= document.cases.length) {
    throw Object.assign(new Error('用例行不存在'), { statusCode: 404 });
  }
  const normalized = (Array.isArray(updates) ? updates : [])
    .slice(0, 100)
    .map((update) => ({
      header: text(update?.header, 500),
      value: String(update?.value ?? '').slice(0, 30000),
    }))
    .filter((update) => update.header);
  if (!normalized.length) {
    throw Object.assign(new Error('没有需要保存的字段'), { statusCode: 400 });
  }
  for (const update of normalized) {
    if (isDefectUrlFieldHeader(update.header) && document.columns.defectUrl) {
      update.header = document.columns.defectUrl;
    }
    if (isDefectTitleFieldHeader(update.header) && document.columns.defectTitle) {
      update.header = document.columns.defectTitle;
    }
    if (update.header === document.columns.defectUrl || isDefectUrlFieldHeader(update.header)) {
      update.value = validateDefectLinks(update.value);
    }
  }
  let allowed = new Set(document.headers.map((header) => String(header)));
  const unknown = normalized.filter((update) => !allowed.has(update.header));
  const unsupported = unknown.filter(
    (update) => !isDefectUrlFieldHeader(update.header) && !isDefectTitleFieldHeader(update.header),
  );
  if (unsupported.length) {
    const first = unsupported[0];
    throw Object.assign(new Error(`用例文件不存在字段：${first?.header || ''}`), {
      statusCode: 400,
    });
  }
  if (unknown.length) {
    const missingHeaders = [
      unknown.some((update) => isDefectUrlFieldHeader(update.header)) ? DEFECT_URL_HEADER : '',
      unknown.some((update) => isDefectTitleFieldHeader(update.header)) ? DEFECT_TITLE_HEADER : '',
    ].filter(Boolean);
    for (const header of missingHeaders) {
      await appendCaseHeader(document, header);
      document = await loadCaseDocument(root, relativePath);
    }
    allowed = new Set(document.headers.map((header) => String(header)));
    for (const update of normalized) {
      if (allowed.has(update.header)) continue;
      if (isDefectUrlFieldHeader(update.header)) update.header = DEFECT_URL_HEADER;
      else if (isDefectTitleFieldHeader(update.header)) update.header = DEFECT_TITLE_HEADER;
    }
    if (missingHeaders.includes(DEFECT_URL_HEADER) && !allowed.has(DEFECT_URL_HEADER)) {
      throw new Error('缺陷信息字段追加失败');
    }
    if (missingHeaders.includes(DEFECT_TITLE_HEADER) && !allowed.has(DEFECT_TITLE_HEADER)) {
      throw new Error('缺陷标题字段追加失败');
    }
  }
  if (document.ext === '.xlsx') {
    await patchXlsx(document.abs, document._parsed, rowIndex, normalized);
  } else {
    patchText(document.abs, document.ext, document._parsed, rowIndex, normalized);
  }
  if (normalized.some((update) => update.header === document.columns.status)) {
    const refreshed = await loadCaseDocument(root, relativePath);
    recordManualVerification(root, refreshed, rowIndex);
  }
  return {
    ok: true,
    path: relativePath,
    rowIndex,
    // 普通字段自动保存不生成快照；只有重新生成用例时才保留旧稿。
    backup: '',
    fileHash: hashBuffer(fs.readFileSync(document.abs)),
  };
}

export { EXECUTION_STATUSES, fieldMap as caseExecutionFieldMap };

export async function prepareExecutionColumns(root, raw) {
  let document = await loadCaseDocument(root, raw.casePath);
  const preview = {
    path: document.path,
    fileHash: document.fileHash,
    missingColumns: document.missingColumns,
    executable: document.executable,
  };
  if (raw.mode !== 'apply') return { ok: true, preview };
  if (document.ext === '.xls')
    throw Object.assign(new Error(document.executionIssue), { statusCode: 422 });
  if (raw.expectedFileHash !== document.fileHash)
    throw Object.assign(new Error('文件已变化，请重新预览'), { statusCode: 409 });
  for (const header of document.missingColumns) {
    await appendCaseHeader(document, header);
    document = await loadCaseDocument(root, raw.casePath);
  }
  return {
    ok: true,
    preview,
    backup: '',
    fileHash: document.fileHash,
    executable: document.executable,
  };
}
