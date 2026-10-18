/**
 * 任务管理存储（空间级，独立插件）。
 *
 * 数据落在 `<当前数据空间>/任务管理/任务.json`：跟空间走、不跟 git 走。
 * 旧版本的 `.lantern/local/tasks.json` 会在首次读写时自动搬过来。
 * 待办通过 `taskId` 关联到这里；任务周期 / 待办数量 / 完成进度都是派生值，不落库。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { prepareStorePath, workStorePath } from './lh-work-store.mjs';

const PREFIX = '/__tb_tasks';
const VERSION = 1;

export const TASK_STATUSES = ['pool', 'in_progress', 'done', 'closed'];
export const TASK_PRIORITIES = ['urgent_important', 'important', 'urgent', 'normal'];

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
  return prepareStorePath(root, 'tasks');
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
  return `tk_${crypto.randomBytes(8).toString('hex')}`;
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

/** 读回来的旧数据也走一遍归一化，避免手工改坏的文件把页面拖垮 */
function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const status = oneOf(raw.status, TASK_STATUSES, 'pool');
  const now = new Date().toISOString();
  return {
    id: text(raw.id, 64) || newId(),
    title,
    status,
    priority: oneOf(raw.priority, TASK_PRIORITIES, ''),
    startDate: dateOrEmpty(raw.startDate),
    dueDate: dateOrEmpty(raw.dueDate),
    note: text(raw.note),
    source: raw.source === 'ai' ? 'ai' : 'manual',
    sessionId: text(raw.sessionId, 120),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
    doneAt: text(raw.doneAt, 40) || null,
  };
}

/** 入参归一化：只认白名单字段，缺省值由调用方（新建/更新）决定 */
function normalizePatch(raw, base) {
  const patch = {};
  if (!raw || typeof raw !== 'object') return patch;
  if ('title' in raw) patch.title = text(raw.title, 200);
  if ('status' in raw) patch.status = oneOf(raw.status, TASK_STATUSES, base.status);
  if ('priority' in raw) patch.priority = oneOf(raw.priority, TASK_PRIORITIES, '');
  if ('startDate' in raw) patch.startDate = dateOrEmpty(raw.startDate);
  if ('dueDate' in raw) patch.dueDate = dateOrEmpty(raw.dueDate);
  if ('note' in raw) patch.note = text(raw.note);
  return patch;
}

/**
 * @param {{ mode?: 'manual' | 'ai', sessionId?: string }} [meta]
 */
function buildItem(raw, meta = {}) {
  const now = new Date().toISOString();
  const status = oneOf(raw?.status, TASK_STATUSES, 'pool');
  return {
    id: newId(),
    title: text(raw?.title, 200),
    status,
    priority: oneOf(raw?.priority, TASK_PRIORITIES, ''),
    startDate: dateOrEmpty(raw?.startDate),
    dueDate: dateOrEmpty(raw?.dueDate),
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
export function lhTasksPlugin() {
  return {
    name: 'lh-tasks',
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
            // 探测不算读写：只算路径，不建目录、不迁移
            return sendJson(res, 200, { ok: true, file: workStorePath(root, 'tasks') });
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
                return sendJson(res, 400, { ok: false, error: '任务名称不能为空' });
              }
              created.push(item);
            }
            store.items.push(...created);
            writeStore(root, store);
            return sendJson(res, 200, { ok: true, items: created, total: store.items.length });
          }

          if (method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const id = text(body.id ?? itemId, 64);
            if (!id) return sendJson(res, 400, { ok: false, error: '缺少任务 id' });
            const store = readStore(root);
            const idx = store.items.findIndex((x) => x.id === id);
            if (idx < 0) return sendJson(res, 404, { ok: false, error: '任务不存在' });

            const base = store.items[idx];
            const patch = normalizePatch(body, base);
            if ('title' in patch && !patch.title) {
              return sendJson(res, 400, { ok: false, error: '任务名称不能为空' });
            }
            const next = { ...base, ...patch, updatedAt: new Date().toISOString() };
            if (next.status === 'done' && base.status !== 'done') next.doneAt = next.updatedAt;
            if (next.status !== 'done') next.doneAt = null;
            store.items[idx] = next;
            writeStore(root, store);
            return sendJson(res, 200, { ok: true, item: next });
          }

          if (method === 'DELETE') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const ids = (Array.isArray(body.ids) ? body.ids : [body.id ?? itemId])
              .map((x) => text(x, 64))
              .filter(Boolean);
            if (!ids.length) return sendJson(res, 400, { ok: false, error: '缺少任务 id' });
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
