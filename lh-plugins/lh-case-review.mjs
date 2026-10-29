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
 * - `/__tb_caseblindspot?health=1`、`/__tb_caseblindspot/prompt`、`POST /__tb_caseblindspot/prompt/sync`
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot, spaceLocalFile } from '../builtin/session/space-layout.mjs';
import { ensurePluginPrompt, isPluginOnInSpace, readPluginPrompt } from './plugin-prompts.mjs';
import {
  BLINDSPOT_PROMPT_FILE,
  BLINDSPOT_PROMPT_TEMPLATE,
  CASE_REVIEW_PROMPT_FILE,
  CASE_REVIEW_PROMPT_TEMPLATE,
  parseBlindspotPromptSections,
  parseCaseReviewPromptSections,
} from './case-review-prompt.mjs';

const REVIEW_PREFIX = '/__tb_casereview';
const BLINDSPOT_PREFIX = '/__tb_caseblindspot';
const VERSION = 1;

/** 固定数据目录：与导航分组同名时靠改名避免冲突，需登记到 lh-nav-groups 的 SKIP_DIR_NAMES */
export const CASE_REVIEW_DIR_NAME = '用例评审';
export const CASE_REVIEW_STORE_FILE = '用例评审.json';

/** 用例文件根目录（与 lh-project-docs 的 DOC_ROOT_DIRS.cases.dirName 一致） */
const CASES_DIR_NAME = '用例管理';
/** 用例管理下的备份文件夹（与前端 CASE_BACKUP_DIR_NAME 一致；首次备份才创建） */
const CASE_BACKUP_DIR_NAME = '备份列表';

const VERDICTS = ['usable', 'revise', 'invalid'];
const DIMENSION_KEYS = ['coverage', 'steps', 'expected', 'data', 'convention'];
const BLINDSPOT_CATEGORIES = ['nonfunctional', 'security', 'compatibility', 'business'];
const SEVERITIES = ['high', 'medium', 'low'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const MAX_CASES = 800;
const MAX_BLINDSPOTS = 300;

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

/** 用例管理/备份列表（相对 cases 根） */
function casesBackupDirAbs(root) {
  return path.join(resolveContentRoot(root, CASES_DIR_NAME).abs, CASE_BACKUP_DIR_NAME);
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
  const dir = casesBackupDirAbs(root);
  fs.mkdirSync(dir, { recursive: true });
  const dest = resolveBackupDest(dir, preferredName || path.basename(abs));
  fs.copyFileSync(abs, dest);
  return dest;
}

/** 列出备份：用例管理/备份列表 + 历史 .lantern/case-review/backup */
function listReviewBackups(root) {
  const items = [];
  const folderDir = casesBackupDirAbs(root);
  if (fs.existsSync(folderDir)) {
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
      const casesPath = `${CASE_BACKUP_DIR_NAME}/${name}`.replace(/\\/g, '/');
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

/** xlsx / xls：读出首个工作表尾部行号，追加后整本写回（样式会被 SheetJS 重写，已提前备份） */
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

/** xlsx / xls 整表写回：保留首个工作表与表头，只覆盖数据行（已提前备份） */
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
    if (norm === CASE_BACKUP_DIR_NAME || norm.startsWith(`${CASE_BACKUP_DIR_NAME}/`)) {
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

  // 勾选的补全用例追加到原文件；写前备份，写后把条目标成已补全
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

    const backup = backupCaseFile(root, abs);
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

    const backupRel = path
      .relative(resolveContentRoot(root, CASES_DIR_NAME).abs, backup)
      .split(path.sep)
      .join('/');
    return sendJson(res, 200, {
      ok: true,
      path: rel,
      appended: rows.length,
      backup: backupRel,
    });
  }

  if (await rewriteRoute(req, res, root, tail)) return;

  return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
}

/** 整表重排：按客户端排好序的行覆盖原文件，写前备份 */
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
  const backup = backupCaseFile(root, abs);
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

  const backupRel = path
    .relative(resolveContentRoot(root, CASES_DIR_NAME).abs, backup)
    .split(path.sep)
    .join('/');
  sendJson(res, 200, { ok: true, path: rel, rows: rows.length, backup: backupRel });
  return true;
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
