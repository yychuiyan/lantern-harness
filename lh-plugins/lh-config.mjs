/**
 * 本地应用配置 + 会话历史：
 * - 默认：包内 `config/app.defaults.json`，落到空间 `.lantern/config/app.defaults.json`（绝不含 apiKey）
 * - 本地：`.lantern/local/app.config.json`（gitignore；不含模型密钥）
 * - 模型：`~/.config/lantern-harness/models.json`（全局，不跟空间走；可含 apiKey）
 * - Key 优先级：`.env` 的 TW_API_KEY > 当前激活提供商 providers[].apiKey > 旧 model.apiKey
 * - 会话：`.lantern/local/sessions.json`
 * - 用例套件：`.lantern/local/case-suites.json`
 * `astro dev` 与 `lantern` CLI 本地服务均可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { appendDeepseekSessionLog } from './session-log-deepseek.mjs';
import {
  appendSessionsJsonl,
  listCheckpoints,
  maybeWriteCheckpoint,
  readLatestCheckpoint,
} from './session-persist.mjs';
import { querySessionIndex, syncSessionQueryIndex } from './session-query-sqlite.mjs';
import { getDataRoot, getPublicSpaceRoot } from '../builtin/session/space-context.mjs';
import { spaceConfigFile, spaceLocalFile } from '../builtin/session/space-layout.mjs';
import {
  autoEnableDetectedPlugins,
  markPluginsDisabled,
  markPluginsEnabled,
} from '../builtin/session/lh-nav-groups.mjs';
import { getGlobalModelsPath } from '../cli/user-config.mjs';
import { ensureContentDirs } from '../cli/data-root.mjs';
import { listStorageDomains } from './storage-domain.mjs';

const PREFIX = '/__tb_config';
const SESS_PREFIX = '/__tb_sessions';
const CASES_PREFIX = '/__tb_case_suites';
const CASE_SESS_PREFIX = '/__tb_case_sessions';

/** 轻量读取数据目录下 `.env`（不依赖 vite，供 CLI 本地服务使用） */
function loadDotEnv(root) {
  const out = {};
  try {
    const fp = path.join(root, '.env');
    if (!fs.existsSync(fp)) return out;
    for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch {
    // ignore
  }
  return out;
}

function defaultsPath(root) {
  return spaceConfigFile(root, 'app.defaults.json');
}

function localConfigPath(root) {
  return spaceLocalFile(root, 'app.config.json');
}

function emptyModelBlock() {
  return { activeId: '', reasoningEffort: 'high', providers: [] };
}

function modelHasProviders(model) {
  return Boolean(model && Array.isArray(model.providers) && model.providers.length);
}

function readGlobalModel() {
  const raw = readJson(getGlobalModelsPath(), null);
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

function writeGlobalModel(model) {
  const next = {
    activeId: typeof model?.activeId === 'string' ? model.activeId : '',
    reasoningEffort: model?.reasoningEffort || 'high',
    providers: Array.isArray(model?.providers) ? model.providers : [],
  };
  writeJson(getGlobalModelsPath(), next);
}

function findLegacySpaceModel(currentRoot) {
  const candidates = [currentRoot];
  try {
    const pub = getPublicSpaceRoot();
    if (pub && path.resolve(pub) !== path.resolve(currentRoot)) candidates.push(pub);
  } catch {
    // ignore
  }
  for (const root of candidates) {
    const local = readJson(localConfigPath(root), null);
    const model = local?.model;
    if (modelHasProviders(model)) return model;
    if (model && (model.apiKey || model.baseURL || model.model)) return model;
  }
  return null;
}

function resolveGlobalModel(currentRoot) {
  const existing = readGlobalModel();
  if (modelHasProviders(existing)) return { ...emptyModelBlock(), ...existing };
  const legacy = findLegacySpaceModel(currentRoot);
  if (legacy) {
    const next = { ...emptyModelBlock(), ...legacy };
    writeGlobalModel(next);
    return next;
  }
  return existing ? { ...emptyModelBlock(), ...existing } : emptyModelBlock();
}

function stripModel(config) {
  if (!config || typeof config !== 'object') return config;
  const { model: _m, ...rest } = config;
  return rest;
}

function sessionsPath(root) {
  return spaceLocalFile(root, 'sessions.json');
}

function caseSuitesPath(root) {
  return spaceLocalFile(root, 'case-suites.json');
}

function caseSessionsPath(root) {
  return spaceLocalFile(root, 'case-sessions.json');
}

function readJson(fp, fallback) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      base?.[k] &&
      typeof base[k] === 'object'
    ) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** 合并 defaults：本地缺省字段用 defaults 补齐；providers 整表以本地为准（含 apiKey） */
function mergeWithDefaults(defaults, local) {
  const safeDefaults = structuredClone(defaults);
  if (safeDefaults.model && typeof safeDefaults.model === 'object') {
    delete safeDefaults.model.apiKey;
    if (Array.isArray(safeDefaults.model.providers)) {
      safeDefaults.model.providers = safeDefaults.model.providers.map((p) => {
        if (!p || typeof p !== 'object') return p;
        const { apiKey: _k, ...rest } = p;
        return rest;
      });
    }
  }
  const localModel = local?.model && typeof local.model === 'object' ? local.model : null;
  const merged = deepMerge(safeDefaults, local && typeof local === 'object' ? local : {});
  const dPlugins =
    safeDefaults.plugins && typeof safeDefaults.plugins === 'object' ? safeDefaults.plugins : {};
  const lPlugins = merged.plugins && typeof merged.plugins === 'object' ? merged.plugins : {};
  merged.plugins = { ...dPlugins, ...lPlugins };
  for (const [id, enabled] of Object.entries(dPlugins)) {
    if (typeof lPlugins[id] !== 'boolean') merged.plugins[id] = enabled;
  }
  if (!merged.model || typeof merged.model !== 'object')
    merged.model = { providers: [], activeId: '' };
  // providers 数组不要被 deepMerge 搞乱：有本地则整段替换
  if (localModel && Array.isArray(localModel.providers)) {
    merged.model.providers = localModel.providers;
    if (typeof localModel.activeId === 'string') merged.model.activeId = localModel.activeId;
  } else if (!Array.isArray(merged.model.providers)) {
    merged.model.providers = [];
  }
  merged.version = safeDefaults.version ?? 1;
  return merged;
}

function ensureLocalConfig(root) {
  const defaults = readJson(defaultsPath(root), null);
  if (!defaults) {
    throw new Error('缺少空间配置 .lantern/config/app.defaults.json');
  }
  const fp = localConfigPath(root);
  let local = readJson(fp, null);
  if (!local) {
    local = stripModel(structuredClone(defaults));
    writeJson(fp, local);
  } else {
    const merged = stripModel(mergeWithDefaults(defaults, local));
    // 补字段或清掉已迁走的 model
    if (local.model || JSON.stringify(merged) !== JSON.stringify(stripModel(local))) {
      writeJson(fp, merged);
      local = merged;
    }
  }
  return mergeWithDefaults(defaults, local);
}

function readApiKey(root, localConfig) {
  const env = loadDotEnv(root);
  const fromEnv = String(env.TW_API_KEY ?? process.env.TW_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  const providers = localConfig?.model?.providers;
  const activeId = localConfig?.model?.activeId;
  if (Array.isArray(providers) && providers.length) {
    const active = providers.find((p) => p && p.id === activeId) ?? providers[0];
    if (active && typeof active.apiKey === 'string' && active.apiKey.trim()) {
      return active.apiKey.trim();
    }
  }
  if (localConfig?.model && typeof localConfig.model.apiKey === 'string') {
    return localConfig.model.apiKey.trim();
  }
  return '';
}

function sanitizeForLocalWrite(config) {
  return structuredClone(config);
}

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

/**
 * @returns {import('vite').Plugin}
 */
export function lhConfigPlugin() {
  return {
    name: 'lh-config',
    configureServer(server) {
      // 数据根惰性读取：切换数据空间后无需重启即可生效
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const root = getDataRoot();

        try {
          if (url === `${PREFIX}/health` && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, mode: 'file' });
          }

          if (url === `${PREFIX}/storage-domains` && req.method === 'GET') {
            return sendJson(res, 200, {
              ok: true,
              root,
              domains: listStorageDomains(root),
            });
          }

          if (url === PREFIX && req.method === 'GET') {
            const model = resolveGlobalModel(root);
            const spaceCfg = ensureLocalConfig(root);
            // 从别的机器拷进来的空间：有内容的内容目录 / 已被分组引用的目录就是插件开关的依据
            const auto = autoEnableDetectedPlugins(
              root,
              spaceCfg.plugins ?? {},
              spaceCfg.navGroups ?? [],
            );
            if (auto.changed) {
              spaceCfg.plugins = auto.plugins;
              writeJson(localConfigPath(root), stripModel(spaceCfg));
            }
            const config = { ...spaceCfg, model };
            return sendJson(res, 200, {
              ok: true,
              config,
              configTarget: root,
              apiKey: readApiKey(root, config),
              paths: {
                defaults: defaultsPath(root),
                local: localConfigPath(root),
                models: getGlobalModelsPath(),
              },
            });
          }

          if (url === PREFIX && req.method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const configTarget =
              typeof body.configTarget === 'string' ? path.resolve(body.configTarget) : '';
            if (!configTarget || configTarget !== path.resolve(root)) {
              return sendJson(res, 409, {
                ok: false,
                error: '数据空间已切换，已拒绝旧空间的配置写入，请刷新页面后重试',
              });
            }
            const defaults = readJson(defaultsPath(root), {});
            const incoming = body.config ?? body;
            const merged = sanitizeForLocalWrite(mergeWithDefaults(defaults, incoming));
            // 手动关掉 / 打开的插件记进识别账本：自动识别不再把它打开
            const beforePlugins = ensureLocalConfig(root).plugins ?? {};
            const afterPlugins = merged.plugins ?? {};
            const turnedOff = Object.keys(afterPlugins).filter(
              (id) => beforePlugins[id] === true && afterPlugins[id] === false,
            );
            const turnedOn = Object.keys(afterPlugins).filter(
              (id) => afterPlugins[id] === true && beforePlugins[id] !== true,
            );
            if (turnedOff.length) markPluginsDisabled(root, turnedOff);
            if (turnedOn.length) markPluginsEnabled(root, turnedOn);
            // 打开内容库插件时才铺对应目录（新装空间默认是干净目录）
            if (turnedOn.length) ensureContentDirs(root, turnedOn);
            if (incoming?.model) writeGlobalModel(incoming.model);
            writeJson(localConfigPath(root), stripModel(merged));
            const config = { ...merged, model: resolveGlobalModel(root) };
            return sendJson(res, 200, {
              ok: true,
              config,
              apiKey: readApiKey(root, config),
            });
          }

          if (url === SESS_PREFIX && req.method === 'GET') {
            const store = readJson(sessionsPath(root), null);
            return sendJson(res, 200, { ok: true, store });
          }

          if (url === SESS_PREFIX && req.method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = body.store ?? body;
            if (!store || !Array.isArray(store.sessions)) {
              return sendJson(res, 400, { error: 'invalid store' });
            }
            const next = {
              sessions: store.sessions,
              activeId: store.activeId ?? store.sessions[0]?.id ?? '',
            };
            writeJson(sessionsPath(root), next);
            try {
              appendSessionsJsonl(root, next);
            } catch {
              // ignore jsonl errors
            }
            try {
              maybeWriteCheckpoint(root, next);
            } catch {
              // ignore checkpoint errors
            }
            try {
              await syncSessionQueryIndex(root, next);
            } catch {
              // ignore sqlite index errors
            }
            return sendJson(res, 200, { ok: true });
          }

          if (url === `${SESS_PREFIX}/query` && req.method === 'GET') {
            const u = new URL(req.url || '', 'http://local');
            const q = String(u.searchParams.get('q') || '').trim();
            const includeArchived = u.searchParams.get('archived') === '1';
            const limit = Number(u.searchParams.get('limit') || 20);
            if (!q) return sendJson(res, 200, { ok: true, backend: 'sqlite', hits: [] });
            let result = await querySessionIndex(root, q, { limit, includeArchived });
            if (!result.ok && result.error === 'index missing; sync first') {
              const store = readJson(sessionsPath(root), null);
              if (store) await syncSessionQueryIndex(root, store);
              result = await querySessionIndex(root, q, { limit, includeArchived });
            }
            return sendJson(res, result.ok ? 200 : 200, result);
          }

          if (url === `${SESS_PREFIX}/checkpoints` && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, checkpoints: listCheckpoints(root) });
          }

          if (url.startsWith(`${SESS_PREFIX}/checkpoints/`) && req.method === 'GET') {
            const sessionId = decodeURIComponent(url.slice(`${SESS_PREFIX}/checkpoints/`.length));
            const cp = readLatestCheckpoint(root, sessionId);
            if (!cp) return sendJson(res, 404, { ok: false, error: 'checkpoint not found' });
            return sendJson(res, 200, { ok: true, checkpoint: cp });
          }

          if (url === `${SESS_PREFIX}/log` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const sessionId = String(body.sessionId ?? '').trim();
            if (!sessionId) {
              return sendJson(res, 400, { error: 'sessionId is required' });
            }
            const messages = Array.isArray(body.messages) ? body.messages : [];
            if (!messages.length) {
              return sendJson(res, 400, { error: 'messages is required' });
            }
            try {
              const result = appendDeepseekSessionLog(root, {
                sessionId,
                model: typeof body.model === 'string' ? body.model : '',
                messages,
              });
              return sendJson(res, 200, { ok: true, ...result });
            } catch (e) {
              return sendJson(res, 500, {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          if (url === CASES_PREFIX && req.method === 'GET') {
            const store = readJson(caseSuitesPath(root), { suites: [] });
            return sendJson(res, 200, { ok: true, store });
          }

          if (url === CASES_PREFIX && req.method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = body.store ?? body;
            if (!store || !Array.isArray(store.suites)) {
              return sendJson(res, 400, { error: 'invalid store' });
            }
            writeJson(caseSuitesPath(root), { suites: store.suites });
            return sendJson(res, 200, { ok: true });
          }

          if (url === CASE_SESS_PREFIX && req.method === 'GET') {
            const store = readJson(caseSessionsPath(root), { sessions: [], activeId: '' });
            return sendJson(res, 200, { ok: true, store });
          }

          if (url === CASE_SESS_PREFIX && req.method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = body.store ?? body;
            if (!store || !Array.isArray(store.sessions)) {
              return sendJson(res, 400, { error: 'invalid store' });
            }
            writeJson(caseSessionsPath(root), {
              sessions: store.sessions,
              activeId: store.activeId ?? store.sessions[0]?.id ?? '',
            });
            return sendJson(res, 200, { ok: true });
          }

          // 会话回合 API 由 session-runs 插件处理
          if (url.startsWith(`${SESS_PREFIX}/runs`)) {
            return next();
          }
          if (
            url.startsWith(PREFIX) ||
            url.startsWith(SESS_PREFIX) ||
            url.startsWith(CASES_PREFIX) ||
            url.startsWith(CASE_SESS_PREFIX)
          ) {
            return sendJson(res, 404, { error: 'not found' });
          }
          return next();
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
