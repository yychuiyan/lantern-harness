import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { spaceLocalFile } from '../builtin/session/space-layout.mjs';

const VERSION = 1;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const KEEP_APPLIED_MS = 24 * 60 * 60 * 1000;

export function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

export function writeTextAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function pendingMessage(kind) {
  return `${kind}草稿已生成，尚未修改正式文件。请核对预览内容；确认后使用 draftId + revision 应用。`;
}

/**
 * Space-local draft store. Drafts are temporary review state, never a replacement
 * for the business file that the user asked Lantern to change.
 */
export function createReviewDraftStore({ root, relPath, kind, ttlMs = DEFAULT_TTL_MS }) {
  const file = spaceLocalFile(root, relPath);

  function read() {
    const raw = readJson(file);
    if (!raw || raw.version !== VERSION || !Array.isArray(raw.drafts)) {
      return { version: VERSION, drafts: [] };
    }
    return raw;
  }

  function prune(store, now = Date.now()) {
    store.drafts = store.drafts.filter((draft) => {
      if (!draft || typeof draft !== 'object') return false;
      if (draft.status === 'pending') return Date.parse(draft.expiresAt) > now;
      if (draft.status === 'applied') {
        return now - Date.parse(draft.appliedAt || draft.updatedAt || 0) < KEEP_APPLIED_MS;
      }
      return false;
    });
  }

  function create(payload) {
    const store = read();
    prune(store);
    const createdAt = nowIso();
    const revision = hashValue({
      kind,
      createdAt,
      payload,
      nonce: crypto.randomBytes(12).toString('hex'),
    });
    const draft = {
      id: `rd_${crypto.randomBytes(12).toString('hex')}`,
      kind,
      status: 'pending',
      revision,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      payload,
    };
    store.drafts.push(draft);
    writeJson(file, store);
    return {
      ...draft,
      message: pendingMessage(kind),
      requiresConfirmation: true,
    };
  }

  function get(id) {
    const store = read();
    prune(store);
    const draft = store.drafts.find((item) => item.id === id);
    if (!draft) {
      throw Object.assign(new Error(`${kind}草稿不存在或已过期，请重新预览`), {
        statusCode: 404,
      });
    }
    return draft;
  }

  function update(id, patch) {
    const store = read();
    prune(store);
    const index = store.drafts.findIndex((item) => item.id === id);
    if (index < 0) {
      throw Object.assign(new Error(`${kind}草稿不存在或已过期，请重新预览`), {
        statusCode: 404,
      });
    }
    const next = {
      ...store.drafts[index],
      ...patch,
      id,
      updatedAt: nowIso(),
    };
    store.drafts[index] = next;
    writeJson(file, store);
    return next;
  }

  function discard(id) {
    const store = read();
    prune(store);
    const before = store.drafts.length;
    store.drafts = store.drafts.filter((item) => item.id !== id);
    if (store.drafts.length === before) {
      throw Object.assign(new Error(`${kind}草稿不存在或已过期`), { statusCode: 404 });
    }
    writeJson(file, store);
    return { ok: true, discarded: id };
  }

  return { create, get, update, discard };
}
