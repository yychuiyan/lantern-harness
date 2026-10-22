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
  return {
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
}

function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cases = (Array.isArray(raw.cases) ? raw.cases : [])
    .map(normalizeCaseVerdict)
    .filter(Boolean)
    .slice(0, MAX_CASES);
  const counts = { usable: 0, revise: 0, invalid: 0 };
  for (const c of cases) counts[c.verdict] += 1;
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

function backupCaseFile(root, abs) {
  const dir = spaceLocalFile(root, 'case-review/backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = path.basename(abs);
  const dest = path.join(dir, `${stamp}-${name}`);
  fs.copyFileSync(abs, dest);
  return dest;
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

    return sendJson(res, 200, {
      ok: true,
      path: rel,
      appended: rows.length,
      backup: path.relative(root, backup).split(path.sep).join('/'),
    });
  }

  return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
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
