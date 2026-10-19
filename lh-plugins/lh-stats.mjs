/**
 * 测试统计 / 用例执行统计（空间级）。
 *
 * 数据落在：
 * ```
 * <当前数据空间>/测试统计/测试统计.json
 * <当前数据空间>/用例执行统计/用例执行统计.json
 * ```
 * 跟空间走、不跟 git 走；被拖进导航分组时目录也会跟着进分组文件夹。
 *
 * 「当前剩余用例」「执行比例」是派生值，不落库：
 *   当前剩余用例 = 用例总数 − 已执行用例
 *   执行比例     = 已执行用例 ÷ 用例总数
 * 测试统计的维度 / 用例执行统计的项目名称都是可选项列表，
 * 新建时用户可以直接输入新值（“查找或创建选项”），服务端顺手并入列表。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot } from '../builtin/session/space-layout.mjs';

const VERSION = 1;
const TEST_PREFIX = '/__tb_test_stats';
const CASE_PREFIX = '/__tb_case_exec';

export const TEST_STATS_DIR_NAME = '测试统计';
export const TEST_STATS_STORE_FILE = '测试统计.json';
export const CASE_EXEC_DIR_NAME = '用例执行统计';
export const CASE_EXEC_STORE_FILE = '用例执行统计.json';

/** 首次使用时给出的维度，用户可在下拉里继续创建新维度 */
export const DEFAULT_TEST_DIMENSIONS = [
  '功能测试用例',
  '自动化测试用例',
  '接口测试用例',
  '测试报告',
  '缺陷统计',
  '自动化缺陷统计',
  '测试计划',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COUNT = 9_999_999;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function todayLocal() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function text(value, max = 80) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function dateOr(value, fallback = '') {
  const s = text(value, 10);
  return DATE_RE.test(s) ? s : fallback;
}

function countOf(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_COUNT, Math.round(n));
}

function uniqueTexts(value, max = 20, maxLen = 40) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const s = text(raw, maxLen);
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** 合并选项列表：保持既有顺序，新值追加到末尾 */
function mergeOptions(existing, incoming) {
  const out = [...existing];
  for (const value of incoming) {
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function storeFile(root, kind) {
  const dir = kind === 'testStats' ? TEST_STATS_DIR_NAME : CASE_EXEC_DIR_NAME;
  const file = kind === 'testStats' ? TEST_STATS_STORE_FILE : CASE_EXEC_STORE_FILE;
  return path.join(resolveContentRoot(root, dir).abs, file);
}

function newId(kind) {
  return `${kind === 'testStats' ? 'ts' : 'ce'}_${crypto.randomBytes(8).toString('hex')}`;
}

function testStatsDefaults() {
  return { version: VERSION, dimensions: [...DEFAULT_TEST_DIMENSIONS], items: [] };
}

function caseExecDefaults() {
  return { version: VERSION, projects: [], items: [] };
}

/**
 * 记录归一化。
 *
 * `draft` 表示「刚点添加记录、还没填内容」的占位行：它也会落库（刷新后仍在），
 * 但缺必填字段的**历史脏数据**（没有 draft 标记）仍然丢弃，避免把坏数据摊到表格里。
 */
function normalizeTestItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // 维度单选：历史数据里若存了多个，只保留第一个
  const dimensions = uniqueTexts(raw.dimensions).slice(0, 1);
  const draft = !dimensions.length;
  if (draft && raw.draft !== true) return null;
  const now = new Date().toISOString();
  return {
    id: text(raw.id, 64) || newId('testStats'),
    date: dateOr(raw.date, todayLocal()),
    dimensions,
    count: countOf(raw.count),
    draft,
    source: raw.source === 'ai' ? 'ai' : 'manual',
    sessionId: text(raw.sessionId, 120),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeCaseItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const project = text(raw.project, 120);
  const draft = !project;
  if (draft && raw.draft !== true) return null;
  const now = new Date().toISOString();
  return {
    id: text(raw.id, 64) || newId('caseExec'),
    date: dateOr(raw.date, todayLocal()),
    project,
    startDate: dateOr(raw.startDate),
    endDate: dateOr(raw.endDate),
    total: countOf(raw.total),
    pending: countOf(raw.pending),
    executed: countOf(raw.executed),
    draft,
    source: raw.source === 'ai' ? 'ai' : 'manual',
    sessionId: text(raw.sessionId, 120),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeStore(kind, raw) {
  const base = kind === 'testStats' ? testStatsDefaults() : caseExecDefaults();
  if (!raw || typeof raw !== 'object') return base;
  const items = Array.isArray(raw.items)
    ? raw.items
        .map((x) => (kind === 'testStats' ? normalizeTestItem(x) : normalizeCaseItem(x)))
        .filter(Boolean)
    : [];
  if (kind === 'testStats') {
    const used = items.flatMap((x) => x.dimensions);
    base.dimensions = mergeOptions(DEFAULT_TEST_DIMENSIONS, [
      ...uniqueTexts(raw.dimensions),
      ...used,
    ]);
    base.items = items;
  } else {
    const used = items.map((x) => x.project);
    base.projects = mergeOptions(uniqueTexts(raw.projects, 200, 120), used);
    base.items = items;
  }
  return base;
}

function readStore(root, kind) {
  const fp = storeFile(root, kind);
  try {
    return normalizeStore(kind, JSON.parse(fs.readFileSync(fp, 'utf8')));
  } catch {
    return kind === 'testStats' ? testStatsDefaults() : caseExecDefaults();
  }
}

/** 先写临时文件再 rename：中途失败也不会留下半份 JSON */
function writeStore(root, kind, store) {
  const fp = storeFile(root, kind);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

function buildTestItem(raw, meta) {
  const now = new Date().toISOString();
  const dimensions = uniqueTexts(raw?.dimensions).slice(0, 1);
  return {
    id: newId('testStats'),
    date: dateOr(raw?.date, todayLocal()),
    dimensions,
    count: countOf(raw?.count),
    draft: !dimensions.length,
    source: meta.mode === 'ai' ? 'ai' : 'manual',
    sessionId: text(meta.sessionId, 120),
    createdAt: now,
    updatedAt: now,
  };
}

function buildCaseItem(raw, meta) {
  const now = new Date().toISOString();
  const project = text(raw?.project, 120);
  return {
    id: newId('caseExec'),
    date: dateOr(raw?.date, todayLocal()),
    project,
    startDate: dateOr(raw?.startDate),
    endDate: dateOr(raw?.endDate),
    total: countOf(raw?.total),
    pending: countOf(raw?.pending),
    executed: countOf(raw?.executed),
    draft: !project,
    source: meta.mode === 'ai' ? 'ai' : 'manual',
    sessionId: text(meta.sessionId, 120),
    createdAt: now,
    updatedAt: now,
  };
}

function patchTestItem(body, base) {
  const next = { ...base };
  if ('date' in body) next.date = dateOr(body.date, base.date);
  if ('dimensions' in body) next.dimensions = uniqueTexts(body.dimensions).slice(0, 1);
  if ('count' in body) next.count = countOf(body.count);
  next.draft = !next.dimensions.length;
  next.updatedAt = new Date().toISOString();
  return next;
}

function patchCaseItem(body, base) {
  const next = { ...base };
  if ('date' in body) next.date = dateOr(body.date, base.date);
  if ('project' in body) next.project = text(body.project, 120);
  if ('startDate' in body) next.startDate = dateOr(body.startDate);
  if ('endDate' in body) next.endDate = dateOr(body.endDate);
  if ('total' in body) next.total = countOf(body.total);
  if ('pending' in body) next.pending = countOf(body.pending);
  if ('executed' in body) next.executed = countOf(body.executed);
  next.draft = !next.project;
  next.updatedAt = new Date().toISOString();
  return next;
}

function optionsPayload(kind, store) {
  return kind === 'testStats' ? { dimensions: store.dimensions } : { projects: store.projects };
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhStatsPlugin() {
  return {
    name: 'lh-stats',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        const kind = parsed.pathname.startsWith(TEST_PREFIX)
          ? 'testStats'
          : parsed.pathname.startsWith(CASE_PREFIX)
            ? 'caseExec'
            : null;
        if (!kind) return next();

        // 数据根惰性读取：切换数据空间后无需重启
        const root = getDataRoot();
        const method = req.method || 'GET';
        const prefix = kind === 'testStats' ? TEST_PREFIX : CASE_PREFIX;
        const itemId = parsed.pathname.slice(prefix.length).replace(/^\//, '');

        try {
          if (method === 'GET' && parsed.searchParams.get('health') === '1') {
            return sendJson(res, 200, { ok: true, file: storeFile(root, kind) });
          }

          if (method === 'GET' && !itemId) {
            const store = readStore(root, kind);
            return sendJson(res, 200, { ok: true, ...store });
          }

          // 「+ 添加记录」的空占位行也要落库，否则刷新就没了。
          // 打开插件 / 进入页面时也会调一次 sync：没有数据就什么都不写，
          // 避免只是开个开关就在数据空间里铺出空目录和空文件。
          if (method === 'POST' && itemId === 'sync') {
            const store = readStore(root, kind);
            if (store.items.length > 0 || fs.existsSync(storeFile(root, kind))) {
              writeStore(root, kind, store);
            }
            return sendJson(res, 200, {
              ok: true,
              file: storeFile(root, kind),
              ...optionsPayload(kind, store),
            });
          }

          if (method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const rawItems = Array.isArray(body.items) ? body.items : [body];
            const meta = {
              mode: body.mode === 'ai' ? 'ai' : 'manual',
              sessionId: body.sessionId,
            };
            const store = readStore(root, kind);
            const created = [];
            for (const raw of rawItems) {
              const item =
                kind === 'testStats' ? buildTestItem(raw, meta) : buildCaseItem(raw, meta);
              created.push(item);
            }
            if (!created.length) {
              return sendJson(res, 400, { ok: false, error: '没有可保存的记录' });
            }
            store.items.push(...created);
            if (kind === 'testStats') {
              store.dimensions = mergeOptions(
                store.dimensions,
                created.flatMap((x) => x.dimensions),
              );
            } else {
              store.projects = mergeOptions(
                store.projects,
                created.map((x) => x.project),
              );
            }
            writeStore(root, kind, store);
            return sendJson(res, 200, {
              ok: true,
              items: created,
              total: store.items.length,
              ...optionsPayload(kind, store),
            });
          }

          if (method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const id = text(body.id ?? itemId, 64);
            if (!id) return sendJson(res, 400, { ok: false, error: '缺少记录 id' });
            const store = readStore(root, kind);
            const idx = store.items.findIndex((x) => x.id === id);
            if (idx < 0) return sendJson(res, 404, { ok: false, error: '记录不存在' });

            const base = store.items[idx];
            const next =
              kind === 'testStats' ? patchTestItem(body, base) : patchCaseItem(body, base);
            if (next.startDate && next.endDate && next.endDate < next.startDate) {
              return sendJson(res, 400, { ok: false, error: '结束日期不能早于开始日期' });
            }
            store.items[idx] = next;
            if (kind === 'testStats') {
              store.dimensions = mergeOptions(store.dimensions, next.dimensions);
            } else {
              store.projects = mergeOptions(store.projects, [next.project]);
            }
            writeStore(root, kind, store);
            return sendJson(res, 200, {
              ok: true,
              item: next,
              ...optionsPayload(kind, store),
            });
          }

          if (method === 'DELETE') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const ids = (Array.isArray(body.ids) ? body.ids : [body.id ?? itemId])
              .map((x) => text(x, 64))
              .filter(Boolean);
            if (!ids.length) return sendJson(res, 400, { ok: false, error: '缺少记录 id' });
            const store = readStore(root, kind);
            const drop = new Set(ids);
            const before = store.items.length;
            store.items = store.items.filter((x) => !drop.has(x.id));
            writeStore(root, kind, store);
            return sendJson(res, 200, { ok: true, removed: before - store.items.length });
          }

          return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      });
    },
  };
}
