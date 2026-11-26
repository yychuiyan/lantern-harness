/**
 * 用例质量评审 / 场景遗漏补全（空间级）。
 *
 * 两个插件共用一份数据：`<当前数据空间>/用例评审/用例评审.json`，按用例文件路径分条，
 * 一条里装 `review`（质量评审）与 `blindspot`（场景补全）两份报告。
 * 目录跟着导航分组走：读写统一走 resolveContentRoot。
 *
 * 路由：
 * - `/__tb_casereview?health=1`、`/__tb_casereview/prompt`、`/__tb_casereview/prompt/sync`
 * - `GET /__tb_casereview/summaries`、`GET|PUT /__tb_casereview/report`、`POST /__tb_casereview/append`
 * - `GET /__tb_casereview/backups`、`POST /__tb_casereview/backups/create`、`POST /__tb_casereview/backups/delete`
 * - `/__tb_caseblindspot?health=1`、`/prompt`、`POST /draft`、`POST /apply`
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot, spaceLocalFile } from '../builtin/session/space-layout.mjs';
import {
  CASE_BACKUP_DIR_NAME,
  backupDirectoryForCasePath,
  isCaseBackupPath,
} from '../builtin/case-backup-contract.mjs';
import { ensurePluginPrompt, isPluginOnInSpace, readPluginPrompt } from './plugin-prompts.mjs';
import {
  BLINDSPOT_PROMPT_FILE,
  BLINDSPOT_PROMPT_TEMPLATE,
  CASE_REVIEW_PROMPT_FILE,
  CASE_REVIEW_PROMPT_TEMPLATE,
  parseBlindspotPromptSections,
  parseCaseReviewPromptSections,
} from './case-review-prompt.mjs';
import { caseExecutionFieldMap, loadCaseDocument } from './case-execution/files.mjs';
import { createReviewDraftStore, hashValue } from './review-drafts.mjs';

const REVIEW_PREFIX = '/__tb_casereview';
const BLINDSPOT_PREFIX = '/__tb_caseblindspot';
const VERSION = 1;

/** 固定数据目录：与导航分组同名时靠改名避免冲突，需登记到 lh-nav-groups 的 SKIP_DIR_NAMES */
export const CASE_REVIEW_DIR_NAME = '用例评审';
export const CASE_REVIEW_STORE_FILE = '用例评审.json';

/** 用例文件根目录（与 lh-project-docs 的 DOC_ROOT_DIRS.cases.dirName 一致） */
const CASES_DIR_NAME = '用例管理';
const VERDICTS = ['usable', 'revise', 'invalid'];
const DIMENSION_KEYS = ['coverage', 'steps', 'expected', 'data', 'convention'];
const BLINDSPOT_CATEGORIES = ['nonfunctional', 'security', 'compatibility', 'business'];
const SEVERITIES = ['high', 'medium', 'low'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const MAX_CASES = 800;
const MAX_BLINDSPOTS = 300;
const BLINDSPOT_DRAFTS_REL = 'case-review/blindspot-drafts.json';

/** 数据文件路径：只算路径，不建目录。分组即物理归档，目录可能被搬进分组文件夹 */
export function caseReviewStorePath(spaceDir) {
  const dir = resolveContentRoot(spaceDir, CASE_REVIEW_DIR_NAME).abs;
  return path.join(dir, CASE_REVIEW_STORE_FILE);
}

/** 用例文件绝对路径（越界直接抛 403） */
function caseFileAbs(root, rel) {
  const raw = String(rel ?? '')
    .replace(/\\/g, '/')
    .trim();
  if (!raw || raw.includes('\0') || raw.split('/').includes('..')) {
    throw Object.assign(new Error('非法的用例文件路径'), { statusCode: 400 });
  }
  const base = resolveContentRoot(root, CASES_DIR_NAME).abs;
  const abs = path.resolve(base, raw);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw Object.assign(new Error('用例文件越界'), { statusCode: 403 });
  }
  return abs;
}

function hashOfFile(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 32);
  } catch {
    return '';
  }
}

function fullFileHash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/* ------------------------------ 归一化 ------------------------------ */

function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function oneOf(value, allowed, fallback) {
  const s = text(value, 40);
  return allowed.includes(s) ? s : fallback;
}

function int(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function strList(value, max = 20, itemMax = 1000) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => text(x, itemMax))
    .filter(Boolean)
    .slice(0, max);
}

function normalizeDeduction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reason = text(raw.reason, 1000);
  if (!reason) return null;
  return {
    dimension: oneOf(raw.dimension, DIMENSION_KEYS, 'expected'),
    points: int(raw.points, 0, 100, 0),
    reason,
    suggestion: text(raw.suggestion, 1000),
  };
}

function normalizeCaseVerdict(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const no = text(raw.no, 80);
  const title = text(raw.title, 300);
  if (!no && !title) return null;
  const dims = raw.dimensions && typeof raw.dimensions === 'object' ? raw.dimensions : {};
  const dimensions = {};
  for (const key of DIMENSION_KEYS) dimensions[key] = int(dims[key], 0, 100, 0);
  const out = {
    no,
    title,
    verdict: oneOf(raw.verdict, VERDICTS, 'revise'),
    score: int(raw.score, 0, 100, 0),
    dimensions,
    deductions: (Array.isArray(raw.deductions) ? raw.deductions : [])
      .map(normalizeDeduction)
      .filter(Boolean)
      .slice(0, 20),
  };
  if (raw.fixed === true) out.fixed = true;
  if (raw.ignored === true) out.ignored = true;
  const contentFp = text(raw.contentFp, 2000);
  if (contentFp) out.contentFp = contentFp;
  const hard = text(raw.hard, 1000);
  if (hard) out.hard = hard;
  return out;
}

function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cases = (Array.isArray(raw.cases) ? raw.cases : [])
    .map(normalizeCaseVerdict)
    .filter(Boolean)
    .slice(0, MAX_CASES);
  const counts = { usable: 0, revise: 0, invalid: 0 };
  for (const c of cases) {
    if (c.ignored) continue;
    counts[c.verdict] += 1;
  }
  return {
    at: text(raw.at, 40) || new Date().toISOString(),
    score: int(raw.score, 0, 100, 0),
    counts,
    dimensions: Array.isArray(raw.dimensions)
      ? raw.dimensions.slice(0, 8).map((d) => ({
          key: oneOf(d?.key, DIMENSION_KEYS, 'coverage'),
          label: text(d?.label, 40),
          score: int(d?.score, 0, 100, 0),
          weight: int(d?.weight, 0, 100, 0),
        }))
      : [],
    metrics: Array.isArray(raw.metrics)
      ? raw.metrics.slice(0, 12).map((m) => ({
          key: text(m?.key, 40),
          label: text(m?.label, 40),
          value: Number.isFinite(Number(m?.value)) ? Number(m.value) : 0,
          text: text(m?.text, 40),
        }))
      : [],
    cases,
    summary: text(raw.summary, 2000),
    /** 模型给过语义结论吗；false 表示只有规则结果 */
    modeled: raw.modeled === true,
  };
}

function normalizeBlindspotItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 300);
  if (!title) return null;
  return {
    id: /^bs_[A-Za-z0-9_-]{4,40}$/.test(String(raw.id ?? '')) ? String(raw.id) : newId('bs'),
    category: oneOf(raw.category, BLINDSPOT_CATEGORIES, 'business'),
    severity: oneOf(raw.severity, SEVERITIES, 'medium'),
    title,
    why: text(raw.why, 1000),
    precondition: text(raw.precondition, 1000),
    steps: strList(raw.steps, 20, 1000),
    expected: text(raw.expected, 1000),
    priority: oneOf(raw.priority, PRIORITIES, 'P1'),
    /** 写回时插到哪一组：已有需求编号，或没有编号时补的自定义编号 */
    reqAnchor: text(raw.reqAnchor ?? raw.requirement ?? raw.reqRef, 200),
    added: raw.added === true,
    caseNo: text(raw.caseNo, 80),
  };
}

function normalizeBlindspot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map(normalizeBlindspotItem)
    .filter(Boolean)
    .slice(0, MAX_BLINDSPOTS);
  const ctx = raw.context && typeof raw.context === 'object' ? raw.context : {};
  return {
    at: text(raw.at, 40) || new Date().toISOString(),
    context: {
      reqRef: text(ctx.reqRef, 400),
      reqTitle: text(ctx.reqTitle, 200),
    },
    items,
    summary: text(raw.summary, 2000),
  };
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function emptyStore() {
  return { version: VERSION, files: [] };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rel = text(raw.path, 400);
  if (!rel) return null;
  return {
    path: rel,
    hash: text(raw.hash, 64),
    updatedAt: text(raw.updatedAt, 40) || new Date().toISOString(),
    review: normalizeReview(raw.review),
    blindspot: normalizeBlindspot(raw.blindspot),
  };
}

function normalizeStore(raw) {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  base.files = (Array.isArray(raw.files) ? raw.files : []).map(normalizeEntry).filter(Boolean);
  return base;
}

function readStore(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(caseReviewStorePath(root), 'utf8'));
    return normalizeStore(raw);
  } catch {
    return emptyStore();
  }
}

/** 先写临时文件再 rename：中途失败也不会留下半份 JSON */
function writeStore(root, store) {
  const fp = caseReviewStorePath(root);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

/* ------------------------------ 追加写回 ------------------------------ */

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function mdCell(v) {
  return String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, '<br>');
}

/** 历史路径：空间本地 case-review/backup（只读兼容，新备份不再写入） */
function legacyReviewBackupDir(root) {
  return spaceLocalFile(root, 'case-review/backup');
}

/** 按用例所属类型返回备份目录；根目录历史文件仍写根备份列表。 */
function casesBackupDirAbs(root, backupRelDir = CASE_BACKUP_DIR_NAME) {
  return path.join(resolveContentRoot(root, CASES_DIR_NAME).abs, ...backupRelDir.split('/'));
}

/** 备份文件名：默认用原名（用例名里通常已有时间戳），重名则 stem(2).ext */
function resolveBackupDest(dir, preferredName) {
  const raw = path.basename(String(preferredName || 'backup').trim()) || 'backup';
  const name = raw.replace(/[\\/]/g, '_');
  const dest0 = path.join(dir, name);
  if (!fs.existsSync(dest0)) return dest0;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${stem}(${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function backupCaseFile(root, abs, preferredName) {
  const casesRoot = resolveContentRoot(root, CASES_DIR_NAME).abs;
  const sourceRel = path.relative(casesRoot, abs).split(path.sep).join('/');
  const dir = casesBackupDirAbs(root, backupDirectoryForCasePath(sourceRel));
  fs.mkdirSync(dir, { recursive: true });
  const dest = resolveBackupDest(dir, preferredName || path.basename(abs));
  fs.copyFileSync(abs, dest);
  return dest;
}

/** 列出备份：用例管理/备份列表 + 历史 .lantern/case-review/backup */
function listReviewBackups(root) {
  const items = [];
  const casesRoot = resolveContentRoot(root, CASES_DIR_NAME).abs;
  const typeDirs = fs.existsSync(casesRoot)
    ? fs
        .readdirSync(casesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== CASE_BACKUP_DIR_NAME)
        .map((entry) => path.join(casesRoot, entry.name, CASE_BACKUP_DIR_NAME))
        .filter((dir) => fs.existsSync(dir))
    : [];
  const folderDirs = [casesBackupDirAbs(root), ...typeDirs].filter((dir) => fs.existsSync(dir));
  for (const folderDir of folderDirs) {
    for (const name of fs.readdirSync(folderDir)) {
      if (!name || name.startsWith('.') || name.includes('/') || name.includes('..')) continue;
      const abs = path.join(folderDir, name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const casesPath = path.relative(casesRoot, abs).split(path.sep).join('/');
      items.push({
        name,
        path: casesPath,
        casesPath,
        size: st.size,
        mtime: st.mtimeMs,
        kind: 'folder',
      });
    }
  }
  const legacyDir = legacyReviewBackupDir(root);
  if (fs.existsSync(legacyDir)) {
    for (const name of fs.readdirSync(legacyDir)) {
      if (!name || name.startsWith('.') || name.includes('/') || name.includes('..')) continue;
      const abs = path.join(legacyDir, name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      items.push({
        name,
        path: path.relative(root, abs).split(path.sep).join('/'),
        size: st.size,
        mtime: st.mtimeMs,
        kind: 'legacy',
      });
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

/** 只删历史 review backup 目录下的 basename（新备份走 cases deleteDocs） */
function deleteReviewBackups(root, names) {
  const dir = path.resolve(legacyReviewBackupDir(root));
  const deleted = [];
  const list = Array.isArray(names) ? names : [];
  for (const raw of list.slice(0, 200)) {
    const name = path.basename(String(raw ?? '').trim());
    if (!name || name === '.' || name === '..') continue;
    const abs = path.resolve(dir, name);
    if (!abs.startsWith(dir + path.sep)) continue;
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      fs.unlinkSync(abs);
      deleted.push(name);
    } catch {
      // 单文件跳过
    }
  }
  return deleted;
}

/** md / csv 纯文本追加：原文件一个字节都不改，只在用例表末尾补行（导出仅为便于自测） */
export function appendTextRows(abs, ext, rows, headers) {
  const raw = fs.readFileSync(abs, 'utf8');
  const sep = raw.includes('\r\n') ? '\r\n' : '\n';
  const body = rows
    .map((r) =>
      ext === '.md'
        ? `| ${headers.map((h) => mdCell(r[h])).join(' | ')} |`
        : headers.map((h) => csvCell(r[h])).join(','),
    )
    .join(sep);

  if (ext !== '.md') {
    const trimmed = raw.replace(/[\r\n]+$/, '');
    // 空文件（或只有 BOM）先补表头，否则追加的行没有列名
    if (!trimmed.trim() || trimmed === '\uFEFF') {
      fs.writeFileSync(abs, `${headers.map(csvCell).join(',')}${sep}${body}${sep}`, 'utf8');
      return;
    }
    fs.writeFileSync(abs, `${trimmed}${sep}${body}${sep}`, 'utf8');
    return;
  }

  // md 可能还有「## 备注」这类段落：找到用例表，插在表格最后一行之后，别把行加到文档末尾
  const lines = raw.split(/\r?\n/);
  let insertAt = -1;
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inTable && line.includes('|') && line.includes('用例')) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (line.trim().startsWith('|')) insertAt = i + 1;
      else break;
    }
  }
  if (insertAt < 0) {
    // 没有用例表：补一张表头 + 对齐行，再把新用例接上
    const head = `| ${headers.map(mdCell).join(' | ')} |`;
    const align = `| ${headers.map(() => '---').join(' | ')} |`;
    const trimmed = raw.replace(/[\r\n]+$/, '');
    const prefix = trimmed.trim() ? `${trimmed}${sep}${sep}` : '';
    fs.writeFileSync(abs, `${prefix}${head}${sep}${align}${sep}${body}${sep}`, 'utf8');
    return;
  }
  const next = [...lines.slice(0, insertAt), ...body.split(sep), ...lines.slice(insertAt)];
  fs.writeFileSync(abs, next.join(sep), 'utf8');
}

/** xlsx / xls：读出首个工作表尾部行号，追加后整本写回（样式会被 SheetJS 重写） */
export async function appendSheetRows(abs, rows, headers) {
  const mod = await import('xlsx');
  const xlsx = mod.default ?? mod;
  const book = xlsx.read(fs.readFileSync(abs), { type: 'buffer', cellDates: true });
  const sheetName = book.SheetNames[0];
  if (!sheetName) throw Object.assign(new Error('用例文件里没有工作表'), { statusCode: 422 });
  const sheet = book.Sheets[sheetName];
  const range = xlsx.utils.decode_range(sheet['!ref'] ?? 'A1:A1');
  let row = range.e.r + 1;
  for (const r of rows) {
    headers.forEach((h, c) => {
      const addr = xlsx.utils.encode_cell({ r: row, c });
      sheet[addr] = { t: 's', v: String(r[h] ?? '') };
    });
    row += 1;
  }
  sheet['!ref'] = xlsx.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: rows.length ? row - 1 : range.e.r, c: Math.max(range.e.c, headers.length - 1) },
  });
  const out = xlsx.write(book, { bookType: 'xlsx', type: 'buffer' });
  fs.writeFileSync(abs, out);
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\u0000/g, '');
}

function columnName(index) {
  let value = index + 1;
  let out = '';
  while (value > 0) {
    value -= 1;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
}

function rowNumber(ref) {
  return Number(/(\d+)$/.exec(String(ref ?? ''))?.[1] || 0);
}

function shiftMergeRef(ref, insertedAfter, count) {
  const [start = '', end = ''] = String(ref).split(':');
  const from = rowNumber(start);
  const to = rowNumber(end || start);
  if (!from || !to) return ref;
  if (from <= insertedAfter && insertedAfter < to) {
    throw Object.assign(
      new Error(`Excel 第 ${from}-${to} 行含跨插入点的合并单元格，暂不能安全分组插入`),
      { statusCode: 422 },
    );
  }
  if (from <= insertedAfter) return ref;
  const shiftRef = (value) => value.replace(/(\d+)$/, (n) => String(Number(n) + count));
  return end ? `${shiftRef(start)}:${shiftRef(end)}` : shiftRef(start);
}

function cellStylesFromRow(rowXml) {
  const styles = [];
  const re = /<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g;
  for (const match of rowXml.matchAll(re)) {
    const ref = /\br="([A-Z]+)\d+"/i.exec(match[1])?.[1] || '';
    const style = /\bs="(\d+)"/i.exec(match[1])?.[1] || '';
    if (ref) styles[columnNameToIndex(ref)] = style;
  }
  return styles;
}

function columnNameToIndex(letters) {
  let value = 0;
  for (const char of String(letters).toUpperCase()) {
    value = value * 26 + char.charCodeAt(0) - 64;
  }
  return Math.max(0, value - 1);
}

function renumberSheetRow(rowXml, nextRow) {
  return rowXml
    .replace(/(<row\b[^>]*\br=")(\d+)(")/i, `$1${nextRow}$3`)
    .replace(/(<c\b[^>]*\br="[A-Z]+)(\d+)(")/gi, `$1${nextRow}$3`);
}

function buildSheetRow(insert, nextRow, styles) {
  const cells = (insert.sheetHeaders || insert.headers)
    .map((header, column) => {
      const value = String(insert.row[header] ?? '');
      if (!value) return '';
      const style = styles[column] ? ` s="${styles[column]}"` : '';
      return `<c r="${columnName(column)}${nextRow}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    })
    .join('');
  return `<row r="${nextRow}">${cells}</row>`;
}

async function findXlsxSheetPath(zip, sheetName) {
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbook || !rels) throw new Error('Excel 工作簿结构不完整');
  const safeName = String(sheetName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sheetTag = new RegExp(`<sheet\\b[^>]*name="${safeName}"[^>]*>`, 'i').exec(workbook)?.[0];
  const relationId = sheetTag ? /\br:id="([^"]+)"/i.exec(sheetTag)?.[1] : '';
  const relationTag = relationId
    ? new RegExp(`<Relationship\\b[^>]*Id="${relationId}"[^>]*>`, 'i').exec(rels)?.[0]
    : '';
  const target = relationTag ? /\bTarget="([^"]+)"/i.exec(relationTag)?.[1] || '' : '';
  if (!target) throw new Error(`找不到工作表 ${sheetName}`);
  return target.startsWith('/')
    ? target.slice(1)
    : path.posix.normalize(`xl/${target.replace(/^\.\//, '')}`);
}

async function insertSheetRows(abs, document, inserts) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(abs));
  const sheetPath = await findXlsxSheetPath(zip, document._parsed.sheetName);
  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) throw new Error('找不到工作表 XML');
  let xml = await sheetFile.async('string');
  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/gi;
  const rows = [...xml.matchAll(rowRe)].map((match) => ({
    number: Number(match[1]),
    xml: match[0],
  }));
  if (!rows.length) throw new Error('工作表里没有可写的行');
  const byAfter = new Map();
  for (const insert of inserts) {
    const key = insert.afterPhysicalRow || rows.at(-1).number;
    const list = byAfter.get(key);
    if (list) list.push(insert);
    else byAfter.set(key, [insert]);
  }
  const output = [];
  let nextRow = rows[0].number;
  for (const row of rows) {
    output.push(renumberSheetRow(row.xml, nextRow));
    nextRow += 1;
    for (const insert of byAfter.get(row.number) || []) {
      const styles = cellStylesFromRow(row.xml);
      output.push(buildSheetRow(insert, nextRow, styles));
      nextRow += 1;
    }
  }
  const totalInserted = inserts.length;
  let merged = xml.match(/<mergeCells\b[\s\S]*?<\/mergeCells>/i)?.[0] || '';
  if (merged) {
    for (const [after, list] of byAfter) {
      merged = merged.replace(/\bref="([^"]+)"/g, (whole, ref) => {
        const next = shiftMergeRef(ref, after, list.length);
        return `ref="${next}"`;
      });
    }
  }
  const mergeAt = xml.search(/<mergeCells\b[\s\S]*?<\/mergeCells>/i);
  if (mergeAt >= 0) xml = xml.replace(/<mergeCells\b[\s\S]*?<\/mergeCells>/i, merged);
  const firstRow = rows[0].number;
  const lastOriginal = rows.at(-1).number;
  xml = xml.replace(rowRe, '');
  xml = xml.replace(
    /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/i,
    (_whole, _inner) => `<sheetData>${output.join('')}</sheetData>`,
  );
  xml = xml.replace(/<dimension\b[^>]*\bref="([^"]+)"[^>]*\/>/i, (tag, ref) => {
    const startCol = /^[A-Z]+/i.exec(ref)?.[0] || 'A';
    const endCol = /:([A-Z]+)/i.exec(ref)?.[1] || startCol;
    return tag.replace(ref, `${startCol}${firstRow}:${endCol}${lastOriginal + totalInserted}`);
  });
  zip.file(sheetPath, xml);
  const temp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  fs.renameSync(temp, abs);
}

/* --------------------------- 整表重排写回 --------------------------- */

/** md 用例表定位：表头行 + 分隔行 + 表体末行；找不到返回 null */
function findMarkdownCaseTable(lines) {
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    if (!isSepLine(lines[i + 1])) continue;
    let end = i + 1;
    while (end + 1 < lines.length && lines[end + 1].trim().startsWith('|')) end += 1;
    return { header: i, sep: i + 1, end };
  }
  // 没有分隔行的手写表格：退回「表头含用例字样」的第一行
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('|') || !lines[i].includes('用例')) continue;
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].trim().startsWith('|')) end += 1;
    return { header: i, sep: i, end };
  }
  return null;
}

function isSepLine(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-+/.test(line);
}

/**
 * md / csv 整表写回：只替换用例表体。
 * - md 保留表头、对齐行、表格前后的说明 / 备注段落
 * - csv 保留表头行与 BOM
 */
export function rewriteTextRows(abs, ext, rows, headers) {
  const raw = fs.readFileSync(abs, 'utf8');
  const sep = raw.includes('\r\n') ? '\r\n' : '\n';
  const body = rows.map((r) =>
    ext === '.md'
      ? `| ${headers.map((h) => mdCell(r[h])).join(' | ')} |`
      : headers.map((h) => csvCell(r[h])).join(','),
  );

  if (ext !== '.md') {
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
    const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
    const headerIdx = lines.findIndex((l) => l.trim());
    if (headerIdx < 0) {
      fs.writeFileSync(
        abs,
        `${bom}${headers.map(csvCell).join(',')}${sep}${body.join(sep)}${sep}`,
        'utf8',
      );
      return;
    }
    const head = lines[headerIdx];
    fs.writeFileSync(abs, `${bom}${head}${sep}${body.join(sep)}${sep}`, 'utf8');
    return;
  }

  const lines = raw.split(/\r?\n/);
  const table = findMarkdownCaseTable(lines);
  if (!table) {
    const head = `| ${headers.map(mdCell).join(' | ')} |`;
    const align = `| ${headers.map(() => '---').join(' | ')} |`;
    const trimmed = raw.replace(/[\r\n]+$/, '');
    const prefix = trimmed.trim() ? `${trimmed}${sep}${sep}` : '';
    fs.writeFileSync(abs, `${prefix}${head}${sep}${align}${sep}${body.join(sep)}${sep}`, 'utf8');
    return;
  }
  const next = [...lines.slice(0, table.sep + 1), ...body, ...lines.slice(table.end + 1)];
  fs.writeFileSync(abs, next.join(sep), 'utf8');
}

/** xlsx / xls 整表写回：保留首个工作表与表头，只覆盖数据行 */
export async function rewriteSheetRows(abs, rows, headers) {
  const mod = await import('xlsx');
  const xlsx = mod.default ?? mod;
  const book = xlsx.read(fs.readFileSync(abs), { type: 'buffer', cellDates: true });
  const sheetName = book.SheetNames[0];
  if (!sheetName) throw Object.assign(new Error('用例文件里没有工作表'), { statusCode: 422 });
  const sheet = book.Sheets[sheetName];
  const range = xlsx.utils.decode_range(sheet['!ref'] ?? 'A1:A1');
  // 先清掉旧数据行，避免新行数变少时残留尾巴
  for (let r = 1; r <= range.e.r; r += 1) {
    for (let c = 0; c <= range.e.c; c += 1) {
      delete sheet[xlsx.utils.encode_cell({ r, c })];
    }
  }
  rows.forEach((row, i) => {
    headers.forEach((h, c) => {
      const v = String(row[h] ?? '');
      if (!v) return;
      sheet[xlsx.utils.encode_cell({ r: i + 1, c })] = { t: 's', v };
    });
  });
  sheet['!ref'] = xlsx.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(0, rows.length), c: Math.max(range.e.c, headers.length - 1) },
  });
  fs.writeFileSync(abs, xlsx.write(book, { bookType: 'xlsx', type: 'buffer' }));
}

/* ------------------------------ HTTP ------------------------------ */

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(Object.assign(new Error('提交内容太大（上限 8MB）'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 提示词读取 + 播放种子；返回 { file, exists, ...sections } */
function promptPayload(root, pluginId, file, template, parse) {
  if (isPluginOnInSpace(pluginId, root)) ensurePluginPrompt(file, template, root);
  const content = readPluginPrompt(file, root);
  return { file, exists: Boolean(content.trim()), ...parse(content) };
}

function promptSyncPayload(root, enabled, file, template) {
  if (enabled !== true) {
    return {
      ok: true,
      enabled: false,
      removed: false,
      exists: Boolean(readPluginPrompt(file, root).trim()),
      file,
    };
  }
  return { ok: true, enabled: true, ...ensurePluginPrompt(file, template, root) };
}

async function reviewRoutes(req, res, root, tail, query) {
  const method = req.method || 'GET';

  if (method === 'GET' && query.get('health') === '1') {
    return sendJson(res, 200, {
      ok: true,
      files: { store: caseReviewStorePath(root) },
      version: VERSION,
    });
  }

  if (method === 'GET' && tail === '/prompt') {
    return sendJson(res, 200, {
      ok: true,
      ...promptPayload(
        root,
        'caseReview',
        CASE_REVIEW_PROMPT_FILE,
        CASE_REVIEW_PROMPT_TEMPLATE,
        parseCaseReviewPromptSections,
      ),
    });
  }

  if (method === 'POST' && tail === '/prompt/sync') {
    const body = JSON.parse((await readBody(req)) || '{}');
    return sendJson(
      res,
      200,
      promptSyncPayload(
        root,
        body.enabled === true,
        CASE_REVIEW_PROMPT_FILE,
        CASE_REVIEW_PROMPT_TEMPLATE,
      ),
    );
  }

  // 列表页一次拿全部摘要：判定 / 分数 / 补全条数 / 是否已过期
  if (method === 'GET' && tail === '/summaries') {
    const store = readStore(root);
    const files = store.files.map((entry) => {
      const abs = caseFileAbs(root, entry.path);
      const hash = hashOfFile(abs);
      return {
        path: entry.path,
        exists: Boolean(hash),
        stale: Boolean(entry.hash && hash && entry.hash !== hash),
        at: entry.review?.at ?? '',
        score: entry.review?.score ?? null,
        counts: entry.review?.counts ?? null,
        modeled: entry.review?.modeled === true,
        blindspotCount: entry.blindspot?.items.length ?? 0,
        addedCount: entry.blindspot?.items.filter((x) => x.added).length ?? 0,
      };
    });
    return sendJson(res, 200, { ok: true, files });
  }

  if (method === 'GET' && tail === '/report') {
    const rel = text(query.get('path'), 400);
    if (!rel) return sendJson(res, 400, { ok: false, error: '缺少用例文件路径' });
    const store = readStore(root);
    const entry = store.files.find((x) => x.path === rel) ?? null;
    const hash = hashOfFile(caseFileAbs(root, rel));
    return sendJson(res, 200, {
      ok: true,
      entry,
      hash,
      stale: Boolean(entry?.hash && hash && entry.hash !== hash),
    });
  }

  if (method === 'PUT' && (tail === '/report' || tail === '')) {
    const body = JSON.parse((await readBody(req)) || '{}');
    const rel = text(body.path, 400);
    if (!rel) return sendJson(res, 400, { ok: false, error: '缺少用例文件路径' });
    const abs = caseFileAbs(root, rel);
    if (
      body.expectedHash &&
      body.expectedHash !== hashOfFile(abs) &&
      body.expectedHash !== crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
    )
      return sendJson(res, 409, { ok: false, error: '用例文件已变化，请重新审查' });
    const store = readStore(root);
    const idx = store.files.findIndex((x) => x.path === rel);
    const base =
      idx >= 0
        ? store.files[idx]
        : { path: rel, hash: '', updatedAt: '', review: null, blindspot: null };
    const next = {
      ...base,
      path: rel,
      hash: hashOfFile(abs) || base.hash,
      updatedAt: new Date().toISOString(),
    };
    // review / blindspot 传 null 表示清掉这一份结果，字段缺省表示不动
    if ('review' in body) next.review = normalizeReview(body.review);
    if ('blindspot' in body) next.blindspot = normalizeBlindspot(body.blindspot);
    if (idx >= 0) store.files[idx] = next;
    else store.files.push(next);
    writeStore(root, store);
    return sendJson(res, 200, { ok: true, entry: next });
  }

  // 备份列表（用例管理「备份列表」抽屉）
  if (method === 'GET' && tail === '/backups') {
    return sendJson(res, 200, { ok: true, items: listReviewBackups(root) });
  }

  // 手动备份：把正式用例拷进 用例管理/备份列表/（目录不存在则创建）
  if (method === 'POST' && tail === '/backups/create') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const rel = text(body.path, 400);
    if (!rel) return sendJson(res, 400, { ok: false, error: '缺少用例文件路径' });
    let abs;
    try {
      abs = caseFileAbs(root, rel);
    } catch (e) {
      return sendJson(res, e.statusCode || 400, { ok: false, error: e.message || '路径非法' });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return sendJson(res, 404, { ok: false, error: `用例文件不存在：${rel}` });
    }
    // 禁止把「备份列表」里的文件再备份进自己
    const norm = rel.replace(/\\/g, '/');
    if (isCaseBackupPath(norm)) {
      return sendJson(res, 400, { ok: false, error: '不能备份「备份列表」内的文件' });
    }
    const preferred = text(body.name, 200) || path.basename(abs);
    const dest = backupCaseFile(root, abs, preferred);
    const casesPath = path
      .relative(resolveContentRoot(root, CASES_DIR_NAME).abs, dest)
      .split(path.sep)
      .join('/');
    return sendJson(res, 200, {
      ok: true,
      backup: casesPath,
      name: path.basename(dest),
    });
  }

  if (method === 'POST' && tail === '/backups/delete') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const names = Array.isArray(body.names) ? body.names : [];
    const deleted = deleteReviewBackups(root, names);
    return sendJson(res, 200, { ok: true, deleted, count: deleted.length });
  }

  // 勾选的补全用例追加到原文件；不生成备份，写后把条目标成已补全
  if (method === 'POST' && tail === '/append') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const rel = text(body.path, 400);
    if (!rel) return sendJson(res, 400, { ok: false, error: '缺少用例文件路径' });
    const headers = strList(body.headers, 40, 60);
    if (!headers.length) return sendJson(res, 400, { ok: false, error: '缺少用例字段' });
    const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 200).map((r) => {
      const out = {};
      for (const h of headers) out[h] = typeof r?.[h] === 'string' ? r[h] : String(r?.[h] ?? '');
      return out;
    });
    if (!rows.length) return sendJson(res, 400, { ok: false, error: '没有要写入的用例' });

    const abs = caseFileAbs(root, rel);
    if (!fs.existsSync(abs))
      return sendJson(res, 404, { ok: false, error: `用例文件不存在：${rel}` });
    const ext = path.extname(abs).toLowerCase();
    if (!['.md', '.markdown', '.csv', '.xlsx', '.xls'].includes(ext)) {
      return sendJson(res, 415, { ok: false, error: `暂不支持写回 ${ext || '（无扩展名）'} 文件` });
    }

    if (ext === '.xlsx' || ext === '.xls') await appendSheetRows(abs, rows, headers);
    else appendTextRows(abs, ext === '.csv' ? '.csv' : '.md', rows, headers);

    // 标记已补全：按 id 回写 caseNo，界面上就不会再重复勾选
    const store = readStore(root);
    const idx = store.files.findIndex((x) => x.path === rel);
    if (idx >= 0 && store.files[idx].blindspot) {
      const marks = body.marks && typeof body.marks === 'object' ? body.marks : {};
      store.files[idx].blindspot.items = store.files[idx].blindspot.items.map((item) => {
        const no = typeof marks[item.id] === 'string' ? marks[item.id] : '';
        return no ? { ...item, added: true, caseNo: no } : item;
      });
      store.files[idx].hash = hashOfFile(abs) || store.files[idx].hash;
      store.files[idx].updatedAt = new Date().toISOString();
      writeStore(root, store);
    }

    return sendJson(res, 200, {
      ok: true,
      path: rel,
      appended: rows.length,
      backup: '',
    });
  }

  if (await rewriteRoute(req, res, root, tail)) return;

  return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
}

/** 整表重排：按客户端排好序的行覆盖原文件，不生成备份 */
async function rewriteRoute(req, res, root, tail) {
  if (tail !== '/rewrite') return false;
  if ((req.method || 'GET') !== 'POST') return false;
  const body = JSON.parse((await readBody(req)) || '{}');
  const rel = text(body.path, 400);
  if (!rel) {
    sendJson(res, 400, { ok: false, error: '缺少用例文件路径' });
    return true;
  }
  const headers = strList(body.headers, 40, 60);
  if (!headers.length) {
    sendJson(res, 400, { ok: false, error: '缺少用例字段' });
    return true;
  }
  const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 5000).map((r) => {
    const out = {};
    for (const h of headers) out[h] = typeof r?.[h] === 'string' ? r[h] : String(r?.[h] ?? '');
    return out;
  });
  if (!rows.length) {
    sendJson(res, 400, { ok: false, error: '没有要写入的用例' });
    return true;
  }
  const abs = caseFileAbs(root, rel);
  if (!fs.existsSync(abs)) {
    sendJson(res, 404, { ok: false, error: `用例文件不存在：${rel}` });
    return true;
  }
  const ext = path.extname(abs).toLowerCase();
  if (!['.md', '.markdown', '.csv', '.xlsx', '.xls'].includes(ext)) {
    sendJson(res, 415, { ok: false, error: `暂不支持写回 ${ext || '（无扩展名）'} 文件` });
    return true;
  }
  if (ext === '.xlsx' || ext === '.xls') await rewriteSheetRows(abs, rows, headers);
  else rewriteTextRows(abs, ext === '.csv' ? '.csv' : '.md', rows, headers);

  // 重排后用例编号变了，旧评审结论里的编号对不上：清掉这一份的评审 / 补全结果
  const store = readStore(root);
  const idx = store.files.findIndex((x) => x.path === rel);
  if (idx >= 0) {
    store.files[idx].review = null;
    store.files[idx].blindspot = null;
    store.files[idx].hash = hashOfFile(abs) || store.files[idx].hash;
    store.files[idx].updatedAt = new Date().toISOString();
    writeStore(root, store);
  }

  sendJson(res, 200, { ok: true, path: rel, rows: rows.length, backup: '' });
  return true;
}

function normalizedMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function findAnchorRow(document, anchor) {
  const needle = normalizedMatch(anchor);
  if (!needle) return null;
  let hit = null;
  for (const item of document._parsed.rows) {
    const values = Object.values(item.row || {}).map(normalizedMatch);
    if (values.some((value) => value && (value.includes(needle) || needle.includes(value)))) {
      hit = item;
    }
  }
  return hit;
}

function nextCaseNumbers(existing, count) {
  const used = new Set(existing.map((value) => String(value ?? '').trim()).filter(Boolean));
  const out = [];
  let n = 1;
  while (out.length < count) {
    const value = `TC-BL-${String(n).padStart(3, '0')}`;
    n += 1;
    if (used.has(value)) continue;
    out.push(value);
    used.add(value);
  }
  return out;
}

function rowsForBlindspots(document, items) {
  const headers = document.headers.filter(Boolean);
  const sheetHeaders = document._parsed.rawHeaders || headers;
  const map = caseExecutionFieldMap(headers);
  const caseNumbers = nextCaseNumbers(
    document.cases.map((item) => item.no),
    items.length,
  );
  const inserts = items.map((item, index) => {
    const row = {};
    for (const header of headers) row[header] = '';
    const set = (field, value) => {
      const header = map[field];
      if (header && value) row[header] = value;
    };
    const setNamed = (name, value) => {
      if (headers.includes(name) && value) row[name] = value;
    };
    const categoryLabel =
      {
        nonfunctional: '非功能',
        security: '安全',
        compatibility: '兼容',
        business: '业务',
      }[item.category] || item.category;
    set('no', caseNumbers[index]);
    set('title', `[补全·${categoryLabel}] ${item.title}`);
    set('precondition', item.precondition);
    set('steps', item.steps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`).join('\n'));
    set('expected', item.expected);
    set('priority', item.priority || 'P2');
    setNamed('用例类型', `场景补全·${categoryLabel}`);
    const anchor = item.reqAnchor.trim();
    if (anchor) {
      setNamed('需求编号', anchor);
      setNamed('所属模块', anchor);
      setNamed('引用需求点', anchor);
      const remark = headers.find((header) => /备注/.test(header));
      if (remark) {
        row[remark] = row[remark] ? `${row[remark]}；补充：场景补全` : '补充：场景补全';
      }
    }
    const anchorRow = findAnchorRow(document, anchor);
    return {
      itemId: item.id,
      title: item.title,
      reqAnchor: anchor,
      caseNo: caseNumbers[index],
      afterPhysicalRow: anchorRow?.physicalRow ?? null,
      insertIndex: anchorRow
        ? document._parsed.rows.findIndex((row) => row === anchorRow) + 1
        : document._parsed.rows.length,
      headers,
      sheetHeaders,
      row,
    };
  });
  return { inserts, headers };
}

function normalizeSelectedIds(value) {
  return Array.isArray(value)
    ? value
        .map((item) => text(item, 80))
        .filter((item, index, list) => item && list.indexOf(item) === index)
        .slice(0, 100)
    : [];
}

async function createBlindspotDraft(root, body) {
  const rel = text(body.path, 400);
  if (!rel) throw Object.assign(new Error('缺少用例文件路径'), { statusCode: 400 });
  const selectedIds = normalizeSelectedIds(body.selectedIds);
  if (!selectedIds.length)
    throw Object.assign(new Error('请先选择要补全的场景'), { statusCode: 400 });
  const document = await loadCaseDocument(root, rel);
  if (document.ext === '.xls')
    throw Object.assign(new Error('旧版 .xls 暂不支持安全写回，请先另存为 .xlsx'), {
      statusCode: 422,
    });
  if (!document.executable && !document.headers.length)
    throw Object.assign(new Error(document.executionIssue || '用例文件没有可用表头'), {
      statusCode: 422,
    });
  const store = readStore(root);
  const entry = store.files.find((item) => item.path === rel);
  if (!entry?.blindspot)
    throw Object.assign(new Error('该文件还没有场景补全结果，请先探测'), { statusCode: 404 });
  const byId = new Map(entry.blindspot.items.map((item) => [item.id, item]));
  const selectedItems = selectedIds.map((id) => byId.get(id)).filter(Boolean);
  if (selectedItems.length !== selectedIds.length)
    throw Object.assign(new Error('部分场景已不存在，请重新探测后选择'), { statusCode: 409 });
  if (selectedItems.some((item) => item.added))
    throw Object.assign(new Error('部分场景已经补全，请刷新后重新选择'), { statusCode: 409 });
  const { inserts, headers } = rowsForBlindspots(document, selectedItems);
  const warnings = [];
  if (document.ext === '.xlsx') {
    try {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(fs.readFileSync(document.abs));
      const sheetPath = await findXlsxSheetPath(zip, document._parsed.sheetName);
      const xml = (await zip.file(sheetPath)?.async('string')) || '';
      if (/<f\b/i.test(xml))
        warnings.push('工作簿含公式；插入后公式引用不会自动改行，请保存前核对。');
    } catch {
      warnings.push('未能检查 Excel 公式引用，请保存前核对。');
    }
  }
  const payload = {
    path: rel,
    fileHash: document.fileHash,
    entryHash: hashValue(entry.blindspot),
    headers,
    items: selectedItems,
    inserts: inserts.map(({ itemId, title, reqAnchor, caseNo, row }) => ({
      itemId,
      title,
      reqAnchor,
      caseNo,
      row,
    })),
    warnings,
  };
  const drafts = createReviewDraftStore({
    root,
    relPath: BLINDSPOT_DRAFTS_REL,
    kind: '场景补全',
  });
  const draft = drafts.create(payload);
  return {
    ok: true,
    action: 'draft',
    draftId: draft.id,
    revision: draft.revision,
    expiresAt: draft.expiresAt,
    requiresConfirmation: true,
    path: rel,
    fileHash: document.fileHash,
    selected: inserts.length,
    headers,
    preview: inserts.map((item) => ({
      itemId: item.itemId,
      title: item.title,
      reqAnchor: item.reqAnchor,
      caseNo: item.caseNo,
      row: item.row,
      placement: item.reqAnchor ? `归属需求「${item.reqAnchor}」后` : '文件末尾',
    })),
    warnings,
    message: draft.message,
  };
}

async function applyBlindspotDraft(root, body) {
  const draftId = text(body.draftId, 100);
  const expectedRevision = text(body.expectedRevision, 100);
  if (!draftId) throw Object.assign(new Error('缺少 draftId'), { statusCode: 400 });
  if (!expectedRevision) throw Object.assign(new Error('缺少草稿 revision'), { statusCode: 400 });
  const drafts = createReviewDraftStore({
    root,
    relPath: BLINDSPOT_DRAFTS_REL,
    kind: '场景补全',
  });
  const draft = drafts.get(draftId);
  if (draft.revision !== expectedRevision)
    throw Object.assign(new Error('草稿已变化，请重新预览后再应用'), { statusCode: 409 });
  if (draft.status !== 'pending')
    throw Object.assign(new Error('草稿已处理，不能重复应用'), { statusCode: 409 });
  const payload = draft.payload;
  const document = await loadCaseDocument(root, payload.path);
  if (document.fileHash !== payload.fileHash)
    throw Object.assign(new Error('用例文件已被修改，请重新生成补全草稿'), {
      statusCode: 409,
      currentHash: document.fileHash,
    });
  const store = readStore(root);
  const entryIndex = store.files.findIndex((item) => item.path === payload.path);
  const entry = entryIndex >= 0 ? store.files[entryIndex] : null;
  if (!entry?.blindspot || hashValue(entry.blindspot) !== payload.entryHash)
    throw Object.assign(new Error('场景补全结果已变化，请重新预览'), { statusCode: 409 });
  const currentById = new Map(entry.blindspot.items.map((item) => [item.id, item]));
  for (const item of payload.items) {
    const current = currentById.get(item.id);
    if (!current || current.added)
      throw Object.assign(new Error(`场景「${item.title}」已变化或已补全，请重新选择`), {
        statusCode: 409,
      });
  }
  const { inserts } = rowsForBlindspots(document, payload.items);
  if (document.ext === '.xlsx') {
    await insertSheetRows(document.abs, document, inserts);
  } else if (document.ext === '.csv' || document.ext === '.md') {
    const rows = document._parsed.rows.map((item) => item.row);
    for (const insert of [...inserts].sort((a, b) => b.insertIndex - a.insertIndex)) {
      rows.splice(insert.insertIndex, 0, insert.row);
    }
    rewriteTextRows(document.abs, document.ext, rows, document._parsed.headers);
  } else {
    throw Object.assign(new Error(`暂不支持写回 ${document.ext} 文件`), { statusCode: 415 });
  }
  const nextHash = fullFileHash(document.abs);
  const appliedAt = new Date().toISOString();
  store.files[entryIndex] = {
    ...entry,
    hash: nextHash.slice(0, 32),
    updatedAt: appliedAt,
    blindspot: {
      ...entry.blindspot,
      items: entry.blindspot.items.map((item) => {
        const hit = payload.items.find((picked) => picked.id === item.id);
        return hit ? { ...item, added: true, caseNo: hit.caseNo } : item;
      }),
    },
  };
  writeStore(root, store);
  drafts.update(draftId, {
    status: 'applied',
    appliedAt,
    result: {
      fileHash: nextHash,
      applied: payload.items.map((item) => ({ id: item.id, caseNo: item.caseNo })),
    },
  });
  return {
    ok: true,
    action: 'apply',
    receipt: `已把 ${payload.items.length} 条场景补全写入《${payload.path}》`,
    draftId,
    revision: draft.revision,
    appliedAt,
    path: payload.path,
    fileHash: nextHash,
    applied: payload.items.map((item) => ({
      id: item.id,
      title: item.title,
      caseNo: item.caseNo,
    })),
  };
}

async function blindspotRoutes(req, res, root, tail, query) {
  const method = req.method || 'GET';

  if (method === 'GET' && query.get('health') === '1') {
    return sendJson(res, 200, {
      ok: true,
      files: { store: caseReviewStorePath(root) },
      version: VERSION,
    });
  }

  if (method === 'GET' && tail === '/prompt') {
    return sendJson(res, 200, {
      ok: true,
      ...promptPayload(
        root,
        'caseBlindspot',
        BLINDSPOT_PROMPT_FILE,
        BLINDSPOT_PROMPT_TEMPLATE,
        parseBlindspotPromptSections,
      ),
    });
  }

  if (method === 'POST' && tail === '/prompt/sync') {
    const body = JSON.parse((await readBody(req)) || '{}');
    return sendJson(
      res,
      200,
      promptSyncPayload(
        root,
        body.enabled === true,
        BLINDSPOT_PROMPT_FILE,
        BLINDSPOT_PROMPT_TEMPLATE,
      ),
    );
  }

  if (method === 'POST' && tail === '/draft') {
    const body = JSON.parse((await readBody(req)) || '{}');
    return sendJson(res, 200, await createBlindspotDraft(root, body));
  }

  const draftMatch = tail.match(/^\/draft\/(rd_[a-f0-9]{24})$/);
  if (draftMatch && method === 'GET') {
    const drafts = createReviewDraftStore({
      root,
      relPath: BLINDSPOT_DRAFTS_REL,
      kind: '场景补全',
    });
    const draft = drafts.get(draftMatch[1]);
    return sendJson(res, 200, { ok: true, ...draft });
  }

  if (method === 'POST' && tail === '/apply') {
    const body = JSON.parse((await readBody(req)) || '{}');
    return sendJson(res, 200, await applyBlindspotDraft(root, body));
  }

  if (draftMatch && method === 'DELETE') {
    const drafts = createReviewDraftStore({
      root,
      relPath: BLINDSPOT_DRAFTS_REL,
      kind: '场景补全',
    });
    return sendJson(res, 200, drafts.discard(draftMatch[1]));
  }

  return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
}

function middleware(prefix, handler) {
  return (server) => {
    server.middlewares.use(async (req, res, next) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!parsed.pathname.startsWith(prefix)) return next();
      // 数据根惰性读取：切换数据空间后无需重启
      const root = getDataRoot();
      const tail = parsed.pathname.slice(prefix.length) || '/';
      try {
        return await handler(req, res, root, tail, parsed.searchParams);
      } catch (err) {
        const status = Number(err?.statusCode) || 500;
        return sendJson(res, status, { ok: false, error: String(err?.message ?? err) });
      }
    });
  };
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhCaseReviewPlugin() {
  return {
    name: 'lh-case-review',
    configureServer: middleware(REVIEW_PREFIX, reviewRoutes),
  };
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhCaseBlindspotPlugin() {
  return {
    name: 'lh-case-blindspot',
    configureServer: middleware(BLINDSPOT_PREFIX, blindspotRoutes),
  };
}
