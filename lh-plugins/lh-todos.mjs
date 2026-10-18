/**
 * 待办事项存储（空间级）。
 *
 * 数据落在 `<当前数据空间>/.lantern/local/todos.json`：跟空间走、不跟 git 走。
 * 页面与工作台 AI 工具共用同一份文件，所以这里只做最小校验，
 * 派生字段（待办周期 / 剩余天数 / 是否延期）一律由前端计算，不落库。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { spaceLocalFile } from '../builtin/session/space-layout.mjs';

const PREFIX = '/__tb_todos';
const FILE_NAME = 'todos.json';
const VERSION = 1;

export const TODO_STATUSES = ['pending', 'in_progress', 'done', 'cancelled'];
export const TODO_PRIORITIES = ['urgent_important', 'important', 'urgent', 'normal'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function storeFile(root) {
  return spaceLocalFile(root, FILE_NAME);
}

function readStore(root) {
  const fp = storeFile(root);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const items = Array.isArray(raw?.items) ? raw.items.map(normalizeStored).filter(Boolean) : [];
    return { version: VERSION, items };
  } catch {
    return { version: VERSION, items: [] };
  }
}

/** 先写临时文件再 rename：中途失败也不会留下半份 JSON */
function writeStore(root, store) {
  const fp = storeFile(root);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

function newId() {
  return `td_${crypto.randomBytes(8).toString('hex')}`;
}

function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function dateOrEmpty(value) {
  const s = text(value, 10);
  return DATE_RE.test(s) ? s : '';
}

function oneOf(value, allowed, fallback) {
  const s = text(value, 40);
  return allowed.includes(s) ? s : fallback;
}

/** 结束待办的状态：这两个状态才算「结束了」，结束日期随之落库 */
const CLOSED_STATUSES = new Set(['done', 'cancelled']);

/** 本机当天日期（不用 UTC，避免晚上 8 点后被算成第二天） */
function todayLocal() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 结束日期是派生值（页面与工具都不再手填）：
 * - 已完成 / 已取消：沿用已有结束日期，没有就记为当天；
 * - 待开始 / 进行中：清空，界面上显示「进行中」。
 * @param {string} status
 * @param {string} [existing] 库里已存的结束日期
 */
function endDateFor(status, existing) {
  if (!CLOSED_STATUSES.has(status)) return '';
  return existing || todayLocal();
}

/** 任务管理的存储文件名（与 lh-tasks.mjs 保持一致） */
const TASKS_FILE_NAME = 'tasks.json';

/**
 * 待办关联任务后，把任务从「任务池 / 已完成」拉回「进行中」：
 * 关联上就说明这件事已经在做了。已关闭的任务不动（也不在选择范围内）。
 * 读取失败 / 任务不存在时静默跳过——任务管理插件可能没启用。
 */
function promoteLinkedTask(root, taskId) {
  if (!taskId) return;
  const fp = spaceLocalFile(root, TASKS_FILE_NAME);
  let store;
  try {
    store = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return;
  }
  const items = Array.isArray(store?.items) ? store.items : [];
  const task = items.find((x) => x && x.id === taskId);
  if (!task) return;
  if (task.status !== 'pool' && task.status !== 'done') return;
  task.status = 'in_progress';
  task.doneAt = null;
  task.updatedAt = new Date().toISOString();
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

/** 读回来的旧数据也走一遍归一化，避免手工改坏的文件把页面拖垮 */
function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const status = oneOf(raw.status, TODO_STATUSES, 'pending');
  const now = new Date().toISOString();
  // 旧数据可能没有结束日期：已完成的退回 doneAt 的日期，再没有才用当天
  const doneAt = text(raw.doneAt, 40) || null;
  const storedEnd = dateOrEmpty(raw.taskEndDate) || dateOrEmpty(doneAt);
  return {
    id: text(raw.id, 64) || newId(),
    title,
    status,
    priority: oneOf(raw.priority, TODO_PRIORITIES, ''),
    linkedTask: text(raw.linkedTask, 200),
    taskId: text(raw.taskId, 64),
    startDate: dateOrEmpty(raw.startDate),
    dueDate: dateOrEmpty(raw.dueDate),
    taskEndDate: endDateFor(status, storedEnd),
    note: text(raw.note),
    source: raw.source === 'ai' ? 'ai' : 'manual',
    sessionId: text(raw.sessionId, 120),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
    doneAt,
  };
}

/** 入参归一化：只认白名单字段，缺省值由调用方（新建/更新）决定 */
function normalizePatch(raw, base) {
  const patch = {};
  if (!raw || typeof raw !== 'object') return patch;
  if ('title' in raw) patch.title = text(raw.title, 200);
  if ('status' in raw) patch.status = oneOf(raw.status, TODO_STATUSES, base.status);
  if ('priority' in raw) patch.priority = oneOf(raw.priority, TODO_PRIORITIES, '');
  if ('linkedTask' in raw) patch.linkedTask = text(raw.linkedTask, 200);
  if ('taskId' in raw) patch.taskId = text(raw.taskId, 64);
  if ('startDate' in raw) patch.startDate = dateOrEmpty(raw.startDate);
  if ('dueDate' in raw) patch.dueDate = dateOrEmpty(raw.dueDate);
  // taskEndDate 不接收手填：由状态派生，见 endDateFor()
  if ('note' in raw) patch.note = text(raw.note);
  return patch;
}

/**
 * @param {{ mode?: 'manual' | 'ai', sessionId?: string }} [meta]
 */
function buildItem(raw, meta = {}) {
  const now = new Date().toISOString();
  const status = oneOf(raw?.status, TODO_STATUSES, 'pending');
  return {
    id: newId(),
    title: text(raw?.title, 200),
    status,
    priority: oneOf(raw?.priority, TODO_PRIORITIES, ''),
    linkedTask: text(raw?.linkedTask, 200),
    taskId: text(raw?.taskId, 64),
    startDate: dateOrEmpty(raw?.startDate),
    dueDate: dateOrEmpty(raw?.dueDate),
    taskEndDate: endDateFor(status, ''),
    note: text(raw?.note),
    source: meta.mode === 'ai' ? 'ai' : 'manual',
    sessionId: text(meta.sessionId, 120),
    createdAt: now,
    updatedAt: now,
    doneAt: status === 'done' ? now : null,
  };
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhTodosPlugin() {
  return {
    name: 'lh-todos',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        // 数据根惰性读取：切换数据空间后无需重启
        const root = getDataRoot();

        try {
          const method = req.method || 'GET';
          const itemId = parsed.pathname.slice(PREFIX.length).replace(/^\//, '');

          if (method === 'GET' && parsed.searchParams.get('health') === '1') {
            return sendJson(res, 200, { ok: true, file: storeFile(root) });
          }

          if (method === 'GET' && !itemId) {
            return sendJson(res, 200, { ok: true, ...readStore(root) });
          }

          if (method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const rawItems = Array.isArray(body.items) ? body.items : [body];
            const meta = { mode: body.mode === 'ai' ? 'ai' : 'manual', sessionId: body.sessionId };
            const store = readStore(root);
            const created = [];
            for (const raw of rawItems) {
              const item = buildItem(raw, meta);
              if (!item.title) {
                return sendJson(res, 400, { ok: false, error: '待办名称不能为空' });
              }
              created.push(item);
            }
            store.items.push(...created);
            writeStore(root, store);
            // 新建时就带了关联任务：任务池 / 已完成 → 进行中
            for (const item of created) promoteLinkedTask(root, item.taskId);
            return sendJson(res, 200, { ok: true, items: created, total: store.items.length });
          }

          if (method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const id = text(body.id ?? itemId, 64);
            if (!id) return sendJson(res, 400, { ok: false, error: '缺少待办 id' });
            const store = readStore(root);
            const idx = store.items.findIndex((x) => x.id === id);
            if (idx < 0) return sendJson(res, 404, { ok: false, error: '待办不存在' });

            const base = store.items[idx];
            const patch = normalizePatch(body, base);
            if ('title' in patch && !patch.title) {
              return sendJson(res, 400, { ok: false, error: '待办名称不能为空' });
            }
            const next = { ...base, ...patch, updatedAt: new Date().toISOString() };
            if (next.status === 'done' && base.status !== 'done') next.doneAt = next.updatedAt;
            if (next.status !== 'done') next.doneAt = null;
            // 结束日期跟着状态走：完成 / 取消记为当天，回到待开始 / 进行中则清空。
            // 已经是结束态时沿用原值，改别的字段不会把结束日期刷新成今天。
            const wasClosed = CLOSED_STATUSES.has(base.status);
            next.taskEndDate = endDateFor(next.status, wasClosed ? base.taskEndDate : '');
            store.items[idx] = next;
            writeStore(root, store);
            // 只有「这次新关联了任务」才把任务拉回进行中，改别的字段不碰任务状态
            if (next.taskId && next.taskId !== base.taskId) promoteLinkedTask(root, next.taskId);
            return sendJson(res, 200, { ok: true, item: next });
          }

          if (method === 'DELETE') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const ids = (Array.isArray(body.ids) ? body.ids : [body.id ?? itemId])
              .map((x) => text(x, 64))
              .filter(Boolean);
            if (!ids.length) return sendJson(res, 400, { ok: false, error: '缺少待办 id' });
            const store = readStore(root);
            const drop = new Set(ids);
            const before = store.items.length;
            store.items = store.items.filter((x) => !drop.has(x.id));
            writeStore(root, store);
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
