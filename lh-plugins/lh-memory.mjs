/**
 * 本地长期记忆（Hermes / dsh-memory-evolve 五轨子集）：
 * 仅 `astro dev` 可用，读写 `.local/memories/`（已 gitignore）。
 * 轨：user / memory / key(注入) · project / daily(按需) · SUGGESTIONS · scratch · archive
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { LOCAL_REL } from '../builtin/session/space-layout.mjs';

const PREFIX = '/__tb_memory';
const SEP = '\n§\n';
const TRACKS = ['user', 'memory', 'key', 'project', 'daily'];
const CURATED = new Set(['user', 'memory', 'key']);

const DEFAULT_CONFIG = {
  injectMemory: true,
  reviewEnabled: false,
  reviewInterval: 5,
  reviewMode: 'suggest',
  perTurnProjectWrites: true,
  perTurnDailyWrites: true,
  perTurnKeyWrites: true,
  entryDatePrefix: true,
};

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

function memRoot(root) {
  return path.join(root, LOCAL_REL, 'memories');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function projectId(cwd) {
  const raw = String(cwd || '').trim() || '_default';
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

function trackPaths(root, cwd) {
  const base = memRoot(root);
  const pid = projectId(cwd);
  const proj = path.join(base, 'projects', pid);
  return {
    base,
    pid,
    proj,
    user: path.join(base, 'USER.md'),
    memory: path.join(base, 'MEMORY.md'),
    key: path.join(proj, 'KEY.md'),
    project: path.join(proj, 'MEMORY.md'),
    daily: path.join(base, 'daily', `${todayStr()}.md`),
    archiveUser: path.join(base, 'USER-archive.md'),
    archiveMemory: path.join(base, 'MEMORY-archive.md'),
    archiveKey: path.join(proj, 'KEY-archive.md'),
    suggestions: path.join(base, 'SUGGESTIONS.jsonl'),
    scratch: path.join(base, 'scratch.md'),
    state: path.join(base, 'plugin-state.json'),
    legacyGraph: path.join(root, LOCAL_REL, 'memory', 'graph.json'),
  };
}

function readText(fp) {
  if (!fs.existsSync(fp)) return '';
  try {
    return fs.readFileSync(fp, 'utf8');
  } catch {
    return '';
  }
}

function writeText(fp, content) {
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, content, 'utf8');
}

function splitEntries(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return text
    .split(/\n§\n|\n§\r\n|^§\n|§\n/)
    .map((s) =>
      s
        .replace(/^§\s*/, '')
        .replace(/\s*§\s*$/, '')
        .trim(),
    )
    .filter(Boolean);
}

function joinEntries(entries) {
  if (!entries.length) return '';
  return `${entries.join(SEP)}\n`;
}

function stampEntry(content, withTime = false) {
  const body = String(content || '').trim();
  if (!body) return '';
  if (/^\[\d{4}-\d{2}-\d{2}/.test(body)) return body;
  const d = new Date();
  const date = todayStr();
  if (!withTime) return `[${date}] ${body}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `[${date} ${hh}:${mm}] ${body}`;
}

function readConfig(paths) {
  const raw = readText(paths.state);
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  return { ...DEFAULT_CONFIG, ...parsed };
}

function writeConfig(paths, cfg) {
  writeText(paths.state, JSON.stringify({ ...DEFAULT_CONFIG, ...cfg }, null, 2));
}

function readSuggestions(paths) {
  const raw = readText(paths.suggestions);
  if (!raw.trim()) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip bad line
    }
  }
  return out;
}

function writeSuggestions(paths, list) {
  const lines = list.map((x) => JSON.stringify(x));
  writeText(paths.suggestions, lines.length ? `${lines.join('\n')}\n` : '');
}

function fileForTarget(paths, target) {
  if (target === 'user') return paths.user;
  if (target === 'memory') return paths.memory;
  if (target === 'key') return paths.key;
  if (target === 'project') return paths.project;
  if (target === 'daily') return paths.daily;
  return null;
}

function archiveFileFor(paths, target) {
  if (target === 'user') return paths.archiveUser;
  if (target === 'memory') return paths.archiveMemory;
  if (target === 'key') return paths.archiveKey;
  return null;
}

function appendEntry(paths, target, content, opts = {}) {
  const fp = fileForTarget(paths, target);
  if (!fp) throw Object.assign(new Error(`unknown target: ${target}`), { status: 400 });
  const withTime = target === 'project' || target === 'daily';
  const stamped = opts.noStamp ? String(content).trim() : stampEntry(content, withTime);
  if (!stamped) throw Object.assign(new Error('empty content'), { status: 400 });
  const entries = splitEntries(readText(fp));
  entries.push(stamped);
  writeText(fp, joinEntries(entries));
  return { target, entry: stamped, count: entries.length };
}

function listTrack(paths, target) {
  const fp = fileForTarget(paths, target);
  if (!fp) return { target, entries: [], path: null };
  const entries = splitEntries(readText(fp));
  return {
    target,
    path: fp,
    exists: fs.existsSync(fp),
    entries: entries.map((text, index) => ({ index, text })),
  };
}

function renderSnapshot(paths, config) {
  if (!config.injectMemory) {
    return { text: '', sections: {} };
  }
  const user = splitEntries(readText(paths.user));
  const memory = splitEntries(readText(paths.memory));
  const key = splitEntries(readText(paths.key));
  const parts = [
    '<memory_snapshot>',
    '以下为跨会话长期记忆（用户档案 / 全局事实 / 项目关键），请优先参考：',
  ];
  if (user.length) {
    parts.push('', '## 用户档案');
    for (const e of user) parts.push(`- ${e}`);
  }
  if (memory.length) {
    parts.push('', '## 全局事实');
    for (const e of memory) parts.push(`- ${e}`);
  }
  if (key.length) {
    parts.push('', '## 项目关键记忆');
    for (const e of key) parts.push(`- ${e}`);
  }
  if (!user.length && !memory.length && !key.length) {
    parts.push('', '（暂无已确认记忆）');
  }
  const duties = [];
  if (config.perTurnDailyWrites) duties.push('daily');
  if (config.perTurnProjectWrites) duties.push('project');
  if (config.perTurnKeyWrites) duties.push('key(重要事实先 memory_suggest)');
  if (duties.length) {
    parts.push(
      '',
      `【收尾】本回合若有可复用进展，用 memory_append 写入 ${duties.filter((d) => d !== 'key(重要事实先 memory_suggest)').join('/')}；` +
        `用户偏好/全局事实/项目关键约定请用 memory_suggest，待用户确认后再生效。`,
    );
  }
  parts.push('</memory_snapshot>');
  return {
    text: parts.join('\n'),
    sections: { user: user.length, memory: memory.length, key: key.length },
  };
}

function searchTracks(paths, query, limit = 20) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return [];
  const tokens = [
    ...new Set(
      q
        .split(/[\s,，、;；|]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 1),
    ),
  ];
  const scored = [];
  for (const target of TRACKS) {
    const { entries } = listTrack(paths, target);
    for (const e of entries) {
      const hay = e.text.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (hay.includes(t)) score += t.length >= 2 ? 2 : 1;
      }
      if (score > 0) scored.push({ target, index: e.index, text: e.text, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function migrateGraphIfNeeded(root, paths) {
  if (fs.existsSync(paths.memory) || fs.existsSync(paths.user)) return;
  if (!fs.existsSync(paths.legacyGraph)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(paths.legacyGraph, 'utf8'));
    const entities = Array.isArray(raw.entities) ? raw.entities : [];
    const memEntries = [];
    const userEntries = [];
    for (const e of entities) {
      const name = String(e.name || '').trim();
      const type = String(e.entityType || 'fact').trim();
      const obs = Array.isArray(e.observations) ? e.observations : [];
      const block = obs.length ? `${name}（${type}）：${obs.join('；')}` : `${name}（${type}）`;
      if (type === 'preference' || name.includes('偏好') || name.includes('用户')) {
        userEntries.push(stampEntry(block, false));
      } else {
        memEntries.push(stampEntry(block, false));
      }
    }
    if (userEntries.length) writeText(paths.user, joinEntries(userEntries));
    if (memEntries.length) writeText(paths.memory, joinEntries(memEntries));
  } catch {
    // ignore migration errors
  }
}

function countAll(paths) {
  let entries = 0;
  for (const t of TRACKS) entries += listTrack(paths, t).entries.length;
  return {
    entryCount: entries,
    suggestionCount: readSuggestions(paths).length,
    user: listTrack(paths, 'user').entries.length,
    memory: listTrack(paths, 'memory').entries.length,
    key: listTrack(paths, 'key').entries.length,
    project: listTrack(paths, 'project').entries.length,
    daily: listTrack(paths, 'daily').entries.length,
  };
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhMemoryPlugin() {
  return {
    name: 'lh-memory',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(PREFIX)) return next();
        // 数据根惰性读取：切换数据空间后无需重启即可生效
        const root = getDataRoot();

        try {
          const method = req.method || 'GET';
          let body = {};
          if (method === 'POST' || method === 'PUT') {
            body = JSON.parse((await readBody(req)) || '{}');
          }
          const cwd = String(body.cwd ?? body.workspacePath ?? '').trim();
          const paths = trackPaths(root, cwd);
          // 不在读接口里预建目录：只有真正写入记忆时才由 writeText 铺出文件夹
          migrateGraphIfNeeded(root, paths);
          const config = readConfig(paths);

          if (url === `${PREFIX}/health` && method === 'GET') {
            const counts = countAll(trackPaths(root, ''));
            return sendJson(res, 200, {
              ok: true,
              mode: 'tracks',
              path: paths.base,
              entryCount: counts.entryCount,
              suggestionCount: counts.suggestionCount,
              entityCount: counts.entryCount,
              relationCount: 0,
              tracks: counts,
            });
          }

          if (url === `${PREFIX}/config` && method === 'GET') {
            return sendJson(res, 200, { ok: true, config });
          }

          if (url === `${PREFIX}/config` && method === 'POST') {
            const next = { ...config };
            for (const key of Object.keys(DEFAULT_CONFIG)) {
              if (key in body) next[key] = body[key];
            }
            if (typeof next.reviewInterval === 'number') {
              next.reviewInterval = Math.max(1, Math.min(100, Math.round(next.reviewInterval)));
            }
            if (next.reviewMode !== 'suggest' && next.reviewMode !== 'auto') {
              next.reviewMode = 'suggest';
            }
            for (const k of [
              'injectMemory',
              'reviewEnabled',
              'perTurnProjectWrites',
              'perTurnDailyWrites',
              'perTurnKeyWrites',
              'entryDatePrefix',
            ]) {
              if (typeof next[k] !== 'boolean') next[k] = DEFAULT_CONFIG[k];
            }
            writeConfig(paths, next);
            return sendJson(res, 200, { ok: true, config: next });
          }

          if (url === `${PREFIX}/snapshot` && method === 'POST') {
            const snap = renderSnapshot(paths, config);
            return sendJson(res, 200, {
              ok: true,
              ...snap,
              cwd: cwd || null,
              projectId: paths.pid,
            });
          }

          if (url === `${PREFIX}/tracks` && method === 'POST') {
            const target = String(body.target || '').trim();
            if (target === 'all') {
              const tracks = {};
              for (const t of TRACKS) tracks[t] = listTrack(paths, t);
              return sendJson(res, 200, { ok: true, tracks, projectId: paths.pid });
            }
            if (!TRACKS.includes(target)) {
              return sendJson(res, 400, { error: `invalid target: ${target}` });
            }
            return sendJson(res, 200, {
              ok: true,
              ...listTrack(paths, target),
              projectId: paths.pid,
            });
          }

          if (url === `${PREFIX}/append` && method === 'POST') {
            const target = String(body.target || '').trim();
            const content = String(body.content ?? '').trim();
            if (!TRACKS.includes(target)) return sendJson(res, 400, { error: 'invalid target' });
            if (CURATED.has(target) && body.force !== true) {
              return sendJson(res, 400, {
                error: 'user/memory/key 请走 /suggest 待确认，或 force=true 直写',
              });
            }
            const result = appendEntry(paths, target, content);
            return sendJson(res, 200, { ok: true, ...result });
          }

          if (url === `${PREFIX}/suggest` && method === 'POST') {
            const target = String(body.target || 'memory').trim();
            const content = String(body.content ?? '').trim();
            const reason = String(body.reason ?? '').trim();
            if (!CURATED.has(target) && !target.startsWith('todo-')) {
              return sendJson(res, 400, { error: 'suggest 仅支持 user / memory / key' });
            }
            if (target.startsWith('todo-')) {
              return sendJson(res, 400, { error: '本工作台未启用待办轨' });
            }
            if (!content) return sendJson(res, 400, { error: 'empty content' });
            const list = readSuggestions(paths);
            const dup = list.find(
              (s) => s.target === target && String(s.content).trim() === content,
            );
            if (dup) {
              dup.hits = (dup.hits || 1) + 1;
              dup.lastSeen = new Date().toISOString();
              writeSuggestions(paths, list);
              return sendJson(res, 200, { ok: true, suggestion: dup, deduped: true });
            }
            const item = {
              id: `sg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              time: new Date().toISOString(),
              cwd: cwd || null,
              target,
              content,
              reason,
              hits: 1,
              lastSeen: new Date().toISOString(),
            };
            list.push(item);
            writeSuggestions(paths, list);
            return sendJson(res, 200, { ok: true, suggestion: item });
          }

          if (url === `${PREFIX}/suggestions` && method === 'GET') {
            return sendJson(res, 200, { ok: true, suggestions: readSuggestions(paths) });
          }

          if (url === `${PREFIX}/suggestions/approve` && method === 'POST') {
            const id = String(body.id || '').trim();
            const list = readSuggestions(paths);
            const idx = list.findIndex((s) => s.id === id);
            if (idx < 0) return sendJson(res, 404, { error: 'not found' });
            const [item] = list.splice(idx, 1);
            writeSuggestions(paths, list);
            const itemPaths = trackPaths(root, item.cwd || cwd);
            ensureDir(itemPaths.proj);
            const result = appendEntry(itemPaths, item.target, item.content);
            return sendJson(res, 200, { ok: true, wrote: result, suggestion: item });
          }

          if (url === `${PREFIX}/suggestions/reject` && method === 'POST') {
            const id = String(body.id || '').trim();
            const list = readSuggestions(paths);
            const next = list.filter((s) => s.id !== id);
            if (next.length === list.length) return sendJson(res, 404, { error: 'not found' });
            writeSuggestions(paths, next);
            return sendJson(res, 200, { ok: true });
          }

          if (url === `${PREFIX}/archive` && method === 'POST') {
            const target = String(body.target || '').trim();
            const index = Number(body.index);
            if (!CURATED.has(target))
              return sendJson(res, 400, { error: '仅 user/memory/key 可归档' });
            const track = listTrack(paths, target);
            if (!Number.isInteger(index) || index < 0 || index >= track.entries.length) {
              return sendJson(res, 400, { error: 'invalid index' });
            }
            const [removed] = track.entries.splice(index, 1);
            writeText(fileForTarget(paths, target), joinEntries(track.entries.map((e) => e.text)));
            const af = archiveFileFor(paths, target);
            const archived = splitEntries(readText(af));
            archived.push(removed.text);
            writeText(af, joinEntries(archived));
            return sendJson(res, 200, { ok: true, archived: removed.text });
          }

          /** 硬删除（不进归档）；支持五轨 */
          if (url === `${PREFIX}/delete` && method === 'POST') {
            const target = String(body.target || '').trim();
            const index = Number(body.index);
            if (!TRACKS.includes(target)) return sendJson(res, 400, { error: 'invalid target' });
            const track = listTrack(paths, target);
            if (!Number.isInteger(index) || index < 0 || index >= track.entries.length) {
              return sendJson(res, 400, { error: 'invalid index' });
            }
            const [removed] = track.entries.splice(index, 1);
            writeText(fileForTarget(paths, target), joinEntries(track.entries.map((e) => e.text)));
            return sendJson(res, 200, { ok: true, deleted: removed.text });
          }

          /** 删除归档条目 */
          if (url === `${PREFIX}/archives/delete` && method === 'POST') {
            const target = String(body.target || '').trim();
            const index = Number(body.index);
            const af = archiveFileFor(paths, target);
            if (!af || !CURATED.has(target)) return sendJson(res, 400, { error: 'invalid target' });
            const archived = splitEntries(readText(af));
            if (!Number.isInteger(index) || index < 0 || index >= archived.length) {
              return sendJson(res, 400, { error: 'invalid index' });
            }
            const [item] = archived.splice(index, 1);
            writeText(af, joinEntries(archived));
            return sendJson(res, 200, { ok: true, deleted: item });
          }

          if (url === `${PREFIX}/archives` && method === 'POST') {
            const target = String(body.target || 'memory').trim();
            const af = archiveFileFor(paths, target);
            if (!af) return sendJson(res, 400, { error: 'invalid target' });
            const entries = splitEntries(readText(af)).map((text, index) => ({ index, text }));
            return sendJson(res, 200, { ok: true, target, entries });
          }

          if (url === `${PREFIX}/promote` && method === 'POST') {
            const target = String(body.target || '').trim();
            const index = Number(body.index);
            const af = archiveFileFor(paths, target);
            if (!af || !CURATED.has(target)) return sendJson(res, 400, { error: 'invalid target' });
            const archived = splitEntries(readText(af));
            if (!Number.isInteger(index) || index < 0 || index >= archived.length) {
              return sendJson(res, 400, { error: 'invalid index' });
            }
            const [item] = archived.splice(index, 1);
            writeText(af, joinEntries(archived));
            appendEntry(paths, target, item, { noStamp: true });
            return sendJson(res, 200, { ok: true, promoted: item });
          }

          if (url === `${PREFIX}/scratch` && method === 'GET') {
            return sendJson(res, 200, { ok: true, content: readText(paths.scratch) });
          }

          if (url === `${PREFIX}/scratch` && method === 'POST') {
            writeText(paths.scratch, String(body.content ?? ''));
            return sendJson(res, 200, { ok: true });
          }

          if (url === `${PREFIX}/search` && method === 'POST') {
            const limit = Math.min(50, Math.max(1, Number(body.limit) || 20));
            return sendJson(res, 200, {
              ok: true,
              results: searchTracks(paths, body.query, limit),
              query: body.query,
            });
          }

          if (url === `${PREFIX}/manual-add` && method === 'POST') {
            const target = String(body.target || 'memory').trim();
            const content = String(body.content ?? '').trim();
            if (!CURATED.has(target)) return sendJson(res, 400, { error: '仅 user/memory/key' });
            const result = appendEntry(paths, target, content);
            return sendJson(res, 200, { ok: true, ...result });
          }

          // 兼容旧图谱 health UI：空图
          if (url === `${PREFIX}/graph` && method === 'GET') {
            return sendJson(res, 200, {
              graph: {
                entities: [],
                relations: [],
                updatedAt: Date.now(),
                version: 3,
                mode: 'tracks',
              },
            });
          }

          return sendJson(res, 404, { error: 'not found' });
        } catch (e) {
          const status = e && typeof e === 'object' && 'status' in e ? Number(e.status) : 500;
          return sendJson(res, status || 500, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });
    },
  };
}
