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
 * 「已执行用例」按「用例总数 − 待执行用例」自动算（老记录里 executed 为 0 也照样补齐），
 * 「当前剩余用例」「执行比例」是派生值，都不依赖落库里的旧值：
 *   已执行用例   = 用例总数 − 待执行用例
 *   当前剩余用例 = 用例总数 − 已执行用例
 *   执行比例     = 1 − 当前剩余用例 ÷ 项目基线
 * 项目基线 = 该项目最早一条记录（日期最早、同日按创建时间）的用例总数：
 * 同一项目每天新增一行时，新行的总数就是上一轮的剩余量，只有最早那条代表原始规模。
 * 测试统计的维度 / 用例执行统计的项目名称都是可选项列表，
 * 新建时用户可以直接输入新值（“查找或创建选项”），服务端顺手并入列表；
 * 下拉里还能重命名（引用它的记录一起改名）与删除（仅限没被记录引用的），
 * 列表顺序按创建时间倒序（时间存在 `dimensionCreatedAt` / `projectCreatedAt`）。
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

/**
 * 选项 -> 创建时间（用例执行统计的项目名称用 `projectCreatedAt`，
 * 测试统计的维度用 `dimensionCreatedAt`）。
 * 落库时顺带记一份，这样即使某个选项的记录被删光，它的创建时间也还在、
 * 排序不会跳；老文件没有这份映射时用最早那条记录的 `createdAt` 兜底，
 * 读一次就补全并写回。
 */
function createdAtKey(kind) {
  return kind === 'testStats' ? 'dimensionCreatedAt' : 'projectCreatedAt';
}

function normalizeCreatedAt(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [name, at] of Object.entries(raw)) {
    const key = text(name, 120);
    const value = text(at, 40);
    if (key && value) out[key] = value;
  }
  return out;
}

/**
 * 按创建时间倒序：最新创建的在最上面（与表格「日期最新在最上面」同一习惯）；
 * 没有创建时间的（历史脏数据）排在最后，彼此之间保持原有顺序（用原下标做稳定兜底）。
 */
function sortByCreatedAt(names, createdAt) {
  return names
    .map((name, index) => ({ name, index, at: createdAt[name] ?? '' }))
    .sort((a, b) => {
      // 没有创建时间的排最后，避免它们插到新选项前面
      if (a.at !== b.at && (!a.at || !b.at)) return a.at ? -1 : 1;
      if (a.at !== b.at) return a.at < b.at ? 1 : -1;
      return a.index - b.index;
    })
    .map((x) => x.name);
}

/** 一条记录用了哪些选项（项目名称是单选字段，维度是单选数组） */
function optionValuesOf(kind, item) {
  if (kind === 'testStats') return item.dimensions;
  return item.project ? [item.project] : [];
}

/**
 * 整理选项列表：补齐记录里用到但列表缺的选项、补全创建时间，
 * 最后按创建时间倒序（最新的在最上面）。返回排好序的列表与对应的时间映射。
 */
function arrangeOptions(kind, rawOptions, rawCreatedAt, items) {
  const maxLen = kind === 'testStats' ? 40 : 120;
  const names = uniqueTexts(rawOptions, 200, maxLen);
  const createdAt = normalizeCreatedAt(rawCreatedAt);
  // 记录按创建时间升序：先出现的就是先创建的
  const ordered = [...items].sort((a, b) =>
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
  );
  for (const item of ordered) {
    for (const value of optionValuesOf(kind, item)) {
      if (!value) continue;
      if (!names.includes(value)) names.push(value);
      const known = createdAt[value];
      // 只在缺失或发现更早的记录时更新，避免记录被改动后把创建时间往后推
      if (!known || String(item.createdAt) < known) createdAt[value] = item.createdAt;
    }
  }
  const sorted = sortByCreatedAt(names, createdAt);
  // 只保留仍在列表里的选项，避免删掉的名字一直挂在文件里
  const keep = {};
  for (const name of sorted) {
    if (createdAt[name]) keep[name] = createdAt[name];
  }
  return { options: sorted, createdAt: keep };
}

/** 新加进列表的选项记下创建时间（已存在的不覆盖） */
function rememberOptionCreatedAt(kind, store, values) {
  const key = createdAtKey(kind);
  if (!store[key]) store[key] = {};
  const now = new Date().toISOString();
  for (const value of values) {
    if (value && !store[key][value]) store[key][value] = now;
  }
}

/**
 * 写入前重新排一遍选项：新增 / 改名 / 删除之后调用，
 * 保证落盘的内容和接口返回的顺序都是「创建时间倒序」，而不是靠下次读取才纠正。
 */
function refreshOptionOrder(kind, store) {
  const key = createdAtKey(kind);
  const arranged = arrangeOptions(kind, optionsOf(kind, store), store[key], store.items);
  setOptions(kind, store, arranged.options);
  store[key] = arranged.createdAt;
}

/** 选项列表（测试统计维度 / 用例执行统计项目名称） */
function optionsOf(kind, store) {
  return kind === 'testStats' ? store.dimensions : store.projects;
}

function setOptions(kind, store, next) {
  if (kind === 'testStats') store.dimensions = next;
  else store.projects = next;
}

/** 某选项被多少条记录引用（删除前用来拦截） */
function optionUsage(kind, store, name) {
  if (kind === 'testStats') {
    return store.items.filter((item) => item.dimensions.includes(name)).length;
  }
  return store.items.filter((item) => item.project === name).length;
}

/**
 * 重命名选项：原位替换（保持创建时间位置），与已有同名时合并去重；
 * 同时把引用它的记录一起改名，避免记录指向一个不存在的选项。返回改动的记录数。
 */
function renameOption(kind, store, from, to) {
  setOptions(
    kind,
    store,
    mergeOptions(
      [],
      optionsOf(kind, store).map((x) => (x === from ? to : x)),
    ),
  );
  if (kind === 'caseExec') {
    const createdAt = store.projectCreatedAt ?? {};
    // 时间跟着改名走；若目标名称已存在，保留更早的那个创建时间
    const moved = createdAt[from];
    delete createdAt[from];
    if (moved && (!createdAt[to] || moved < createdAt[to])) createdAt[to] = moved;
    store.projectCreatedAt = createdAt;
  }
  // 维度的创建时间同样跟着改名走
  if (kind === 'testStats') {
    const createdAt = store.dimensionCreatedAt ?? {};
    const moved = createdAt[from];
    delete createdAt[from];
    if (moved && (!createdAt[to] || moved < createdAt[to])) createdAt[to] = moved;
    store.dimensionCreatedAt = createdAt;
  }
  const now = new Date().toISOString();
  let replaced = 0;
  store.items = store.items.map((item) => {
    if (kind === 'testStats') {
      if (!item.dimensions.includes(from)) return item;
      replaced += 1;
      return {
        ...item,
        dimensions: item.dimensions.map((d) => (d === from ? to : d)),
        updatedAt: now,
      };
    }
    if (item.project !== from) return item;
    replaced += 1;
    return { ...item, project: to, draft: false, updatedAt: now };
  });
  return replaced;
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
  return {
    version: VERSION,
    dimensions: [...DEFAULT_TEST_DIMENSIONS],
    /** 维度名称 -> 创建时间（下拉按创建时间倒序，最新创建的在最上面） */
    dimensionCreatedAt: {},
    items: [],
  };
}

function caseExecDefaults() {
  return { version: VERSION, projects: [], projectCreatedAt: {}, items: [] };
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
    // 维度名称按创建时间倒序：最新创建的在最上面，老数据缺的按记录创建时间补进来
    const arranged = arrangeOptions(
      kind,
      mergeOptions(DEFAULT_TEST_DIMENSIONS, [...uniqueTexts(raw.dimensions), ...used]),
      raw.dimensionCreatedAt,
      items,
    );
    base.dimensions = arranged.options;
    base.dimensionCreatedAt = arranged.createdAt;
    base.items = items;
  } else {
    // 项目名称按创建时间倒序：最新创建的在最上面，老数据缺的名称按记录创建时间补进来
    const arranged = arrangeOptions(kind, raw.projects, raw.projectCreatedAt, items);
    base.projects = arranged.options;
    base.projectCreatedAt = arranged.createdAt;
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

          // 选项级操作（项目名称 / 测试统计维度）：重命名 / 删除整条选项。
          // 必须放在记录的 PUT / DELETE 之前，否则 'options' 会被当成记录 id。
          if (itemId === 'options' && method !== 'GET') {
            const isDim = kind === 'testStats';
            const label = isDim ? '维度名称' : '项目名称';
            const maxLen = isDim ? 40 : 120;
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = readStore(root, kind);
            const options = optionsOf(kind, store);

            if (method === 'PUT') {
              const from = text(body.from, maxLen);
              const to = text(body.to, maxLen);
              if (!from || !to) {
                return sendJson(res, 400, { ok: false, error: `缺少原${label}或新${label}` });
              }
              if (!options.includes(from)) {
                return sendJson(res, 404, { ok: false, error: `${label}不存在` });
              }
              const replaced = from === to ? 0 : renameOption(kind, store, from, to);
              if (from !== to) {
                refreshOptionOrder(kind, store);
                writeStore(root, kind, store);
              }
              return sendJson(res, 200, {
                ok: true,
                replaced,
                items: store.items,
                ...optionsPayload(kind, store),
              });
            }

            if (method === 'DELETE') {
              const name = text(body.name, maxLen);
              if (!name) return sendJson(res, 400, { ok: false, error: `缺少${label}` });
              if (!options.includes(name)) {
                return sendJson(res, 404, { ok: false, error: `${label}不存在` });
              }
              // 还被记录引用时不允许删，避免记录指向一个不存在的选项
              const inUse = optionUsage(kind, store, name);
              if (inUse > 0) {
                return sendJson(res, 409, {
                  ok: false,
                  inUse,
                  error: `还有 ${inUse} 条记录在用这个${label}，先改掉再删除`,
                });
              }
              setOptions(
                kind,
                store,
                options.filter((x) => x !== name),
              );
              const key = createdAtKey(kind);
              if (store[key]) delete store[key][name];
              refreshOptionOrder(kind, store);
              writeStore(root, kind, store);
              return sendJson(res, 200, {
                ok: true,
                removed: 1,
                items: store.items,
                ...optionsPayload(kind, store),
              });
            }

            return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
          }

          // 整组改周期：一个项目只有一个开始 / 结束日期，父行改一次写穿该项目的全部
          // 统计记录（逐条 PUT 会互相覆盖）。
          if (kind === 'caseExec' && itemId === 'project-cycle' && method !== 'GET') {
            if (method !== 'PUT')
              return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
            const body = JSON.parse((await readBody(req)) || '{}');
            const name = text(body.name, 120);
            if (!name) return sendJson(res, 400, { ok: false, error: '缺少项目名称' });
            const store = readStore(root, kind);
            const targets = store.items.filter((x) => x.project === name);
            if (!targets.length) {
              return sendJson(res, 404, { ok: false, error: '项目名称不存在或还没有统计记录' });
            }
            const startDate = dateOr(body.startDate, targets[0].startDate);
            const endDate = dateOr(body.endDate, targets[0].endDate);
            if (startDate && endDate && endDate < startDate) {
              return sendJson(res, 400, { ok: false, error: '结束日期不能早于开始日期' });
            }
            const now = new Date().toISOString();
            let updated = 0;
            store.items = store.items.map((item) => {
              if (item.project !== name) return item;
              if (item.startDate === startDate && item.endDate === endDate) return item;
              updated += 1;
              return { ...item, startDate, endDate, updatedAt: now };
            });
            if (updated > 0) writeStore(root, kind, store);
            return sendJson(res, 200, {
              ok: true,
              updated,
              items: store.items,
              ...optionsPayload(kind, store),
            });
          }
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
              const values = created.flatMap((x) => x.dimensions);
              store.dimensions = mergeOptions(store.dimensions, values);
              rememberOptionCreatedAt(kind, store, values);
              // 新建的维度创建时间最新，排到最上面
              refreshOptionOrder(kind, store);
            } else {
              store.projects = mergeOptions(
                store.projects,
                created.map((x) => x.project),
              );
              rememberOptionCreatedAt(
                kind,
                store,
                created.map((x) => x.project),
              );
              // 新建的项目创建时间最新，排到最上面
              refreshOptionOrder(kind, store);
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
              rememberOptionCreatedAt(kind, store, next.dimensions);
              refreshOptionOrder(kind, store);
            } else {
              store.projects = mergeOptions(store.projects, [next.project]);
              rememberOptionCreatedAt(kind, store, [next.project]);
              refreshOptionOrder(kind, store);
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
