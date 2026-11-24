import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function mdCell(value) {
  return String(value ?? '')
    .replaceAll('|', '&#124;')
    .replace(/\r?\n/g, '<br>');
}

function parseMarkdown(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const headerIndex = lines.findIndex((line) => /^\s*\|/.test(line));
  if (headerIndex < 0) return { headers: [], rows: [] };
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.replace(/<br\s*\/?>/gi, '\n').trim());
  const headers = cells(lines[headerIndex]);
  const rows = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (!/^\s*\|/.test(lines[index])) break;
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index])) continue;
    const values = cells(lines[index]);
    const row = {};
    headers.forEach((header, column) => {
      if (header) row[header] = values[column] ?? '';
    });
    if (Object.values(row).some((value) => String(value).trim())) rows.push(row);
  }
  return { headers, rows };
}

export async function readTable(file, ext) {
  if (!fs.existsSync(file)) return { headers: [], rows: [] };
  if (ext === '.md') return parseMarkdown(fs.readFileSync(file, 'utf8'));
  const XLSX = await import('xlsx');
  const mod = XLSX.default ?? XLSX;
  const raw = ext === '.csv' ? fs.readFileSync(file, 'utf8') : fs.readFileSync(file);
  const book =
    ext === '.csv'
      ? mod.read(String(raw).replace(/^\uFEFF/, ''), { type: 'string' })
      : mod.read(raw, { type: 'buffer' });
  const sheet = book.Sheets[book.SheetNames[0] || ''];
  if (!sheet) return { headers: [], rows: [] };
  const table = mod.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  const headers = (table[0] || []).map((value) => String(value ?? '').trim());
  const rows = table.slice(1).flatMap((values) => {
    const row = {};
    headers.forEach((header, index) => {
      if (header) row[header] = String(values[index] ?? '').trim();
    });
    return Object.values(row).some((value) => value) ? [row] : [];
  });
  return { headers, rows };
}

export async function writeTableAtomic(file, ext, headers, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  if (ext === '.xlsx') {
    const XLSX = await import('xlsx');
    const mod = XLSX.default ?? XLSX;
    const sheet = mod.utils.json_to_sheet(rows, { header: headers });
    const book = mod.utils.book_new();
    mod.utils.book_append_sheet(book, sheet, '自动化用例');
    fs.writeFileSync(temp, mod.write(book, { type: 'buffer', bookType: 'xlsx' }));
  } else if (ext === '.csv') {
    const lines = [
      headers.map(csvCell).join(','),
      ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
    ];
    fs.writeFileSync(temp, `\uFEFF${lines.join('\n')}`, 'utf8');
  } else if (ext === '.md') {
    const lines = [
      `| ${headers.map(mdCell).join(' | ')} |`,
      `|${headers.map(() => '---').join('|')}|`,
      ...rows.map((row) => `| ${headers.map((header) => mdCell(row[header])).join(' | ')} |`),
    ];
    fs.writeFileSync(temp, `${lines.join('\n')}\n`, 'utf8');
  } else {
    throw new Error(`不支持的自动化用例格式：${ext}`);
  }
  fs.renameSync(temp, file);
  return { file, fileHash: hash(fs.readFileSync(file)) };
}

export function fileHash(file) {
  return fs.existsSync(file) ? hash(fs.readFileSync(file)) : '';
}

export function backupFile(file) {
  if (!fs.existsSync(file)) return '';
  const ext = path.extname(file);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const dir = path.join(path.dirname(file), '备份列表');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${path.basename(file, ext)}_bak_${stamp}${ext}`);
  fs.copyFileSync(file, target);
  return target;
}
