/**
 * 本机用户配置与运行状态（数据空间、pid、日志）。
 * 配置目录：~/.config/lantern-harness/（Windows: %APPDATA%/lantern-harness）
 * 旧安装的 ~/.config/ai-testbench/ 会在首次访问时整目录复制过来，原目录保留作备份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 配置目录名，与 GitHub 仓库 lantern-harness 保持一致 */
export const USER_CONFIG_DIR_NAME = 'lantern-harness';

/** 历史目录名：只读兼容，首次访问时复制到新目录，不删除 */
const LEGACY_APP_DIR_NAMES = ['ai-testbench'];

let legacyMigrated = false;

function baseConfigDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return base;
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function migrateLegacyConfigDir(dir) {
  if (legacyMigrated) return;
  legacyMigrated = true;
  try {
    if (fs.existsSync(dir)) return;
    const base = path.dirname(dir);
    for (const legacy of LEGACY_APP_DIR_NAMES) {
      const old = path.join(base, legacy);
      if (!fs.existsSync(old)) continue;
      fs.mkdirSync(base, { recursive: true });
      // 复制而非移动：迁移失败也不会丢原有 spaces.json / models.json
      fs.cpSync(old, dir, { recursive: true, errorOnExist: false, force: false });
      break;
    }
  } catch {
    // 迁移失败不阻塞启动：后续按新目录正常读写即可
  }
}

export function getUserConfigDir() {
  const dir = path.join(baseConfigDir(), USER_CONFIG_DIR_NAME);
  migrateLegacyConfigDir(dir);
  return dir;
}

export function getConfigPath() {
  return path.join(getUserConfigDir(), 'config.json');
}

/** 全局模型提供商（不跟数据空间走） */
export function getGlobalModelsPath() {
  return path.join(getUserConfigDir(), 'models.json');
}

export function getRunStatePath() {
  return path.join(getUserConfigDir(), 'run.json');
}

export function getLogPath() {
  return path.join(getUserConfigDir(), 'logs', 'server.log');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * @returns {{ dataRoot?: string, devDataRoot?: string, host?: string, port?: number }}
 */
export function loadUserConfig() {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * @param {{ dataRoot?: string, devDataRoot?: string, host?: string, port?: number }} patch
 */
export function saveUserConfig(patch) {
  const dir = getUserConfigDir();
  ensureDir(dir);
  const cur = loadUserConfig();
  const next = { ...cur, ...patch };
  if (next.dataRoot) next.dataRoot = path.resolve(next.dataRoot);
  if (next.devDataRoot) next.devDataRoot = path.resolve(next.devDataRoot);
  if (next.port != null) next.port = Number(next.port) || 4321;
  if (next.host != null) next.host = String(next.host || '127.0.0.1');
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** init 作用域：产品 web / 本地开发 / 两者 */
export const DATA_ROOT_SCOPES = /** @type {const} */ (['both', 'web', 'dev']);

/**
 * @param {string} raw
 * @returns {'both'|'web'|'dev'|null}
 */
export function normalizeDataRootScope(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === 'both' || s === 'all' || s === '两者' || s === '3') return 'both';
  if (s === 'web' || s === 'product' || s === '产品' || s === '1') return 'web';
  if (s === 'dev' || s === 'develop' || s === '开发' || s === '2') return 'dev';
  return null;
}

/**
 * 按作用域写入池根。
 * @param {string} spacesRoot
 * @param {'both'|'web'|'dev'} scope
 * @param {{ host?: string, port?: number }} [extra]
 */
export function saveDataRootForScope(spacesRoot, scope, extra = {}) {
  const abs = path.resolve(spacesRoot);
  /** @type {{ dataRoot?: string, devDataRoot?: string, host?: string, port?: number }} */
  const patch = { ...extra };
  if (scope === 'web' || scope === 'both') patch.dataRoot = abs;
  if (scope === 'dev' || scope === 'both') patch.devDataRoot = abs;
  return saveUserConfig(patch);
}

export function clearDataRootFromConfig() {
  const cur = loadUserConfig();
  delete cur.dataRoot;
  ensureDir(getUserConfigDir());
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(cur, null, 2)}\n`, 'utf8');
}

/** 清除开发池根配置 */
export function clearDevDataRootFromConfig() {
  const cur = loadUserConfig();
  delete cur.devDataRoot;
  ensureDir(getUserConfigDir());
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(cur, null, 2)}\n`, 'utf8');
}

/**
 * @returns {{ pid?: number, url?: string, host?: string, port?: number, dataRoot?: string, startedAt?: string } | null}
 */
export function loadRunState() {
  const p = getRunStatePath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ pid: number, url: string, host: string, port: number, dataRoot: string }} state
 */
export function saveRunState(state) {
  ensureDir(getUserConfigDir());
  const next = {
    ...state,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(getRunStatePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function clearRunState() {
  const p = getRunStatePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function ensureLogFile() {
  const logPath = getLogPath();
  ensureDir(path.dirname(logPath));
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf8');
  return logPath;
}

/** 进程是否仍在运行 */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验已配置的产品池根是否可用。
 * @returns {{ ok: true, dataRoot: string, source?: string } | { ok: false, reason: 'missing_config' | 'missing_path', dataRoot?: string }}
 */
export function resolveConfiguredDataRoot() {
  return resolveRuntimeSpacesRoot({ role: 'web' });
}

/**
 * 解析运行时池根。
 * 优先级：`--dir` > 对应配置字段（dev 缺省回退 dataRoot）> fallback（仅开发入口）。
 *
 * @param {{
 *   role?: 'web'|'dev',
 *   dir?: string|null,
 *   fallback?: string|null,
 *   mkdir?: boolean,
 * }} [opts]
 * @returns {{
 *   ok: true, dataRoot: string, source: 'dir'|'dataRoot'|'devDataRoot'|'fallback'
 * } | {
 *   ok: false, reason: 'missing_config'|'missing_path', dataRoot?: string
 * }}
 */
export function resolveRuntimeSpacesRoot(opts = {}) {
  const role = opts.role === 'dev' ? 'dev' : 'web';

  if (opts.dir) {
    const dataRoot = path.resolve(opts.dir);
    if (opts.mkdir && !fs.existsSync(dataRoot)) {
      fs.mkdirSync(dataRoot, { recursive: true });
    }
    if (!fs.existsSync(dataRoot) || !fs.statSync(dataRoot).isDirectory()) {
      return { ok: false, reason: 'missing_path', dataRoot };
    }
    return { ok: true, dataRoot, source: 'dir' };
  }

  const cfg = loadUserConfig();
  /** @type {{ path: string, source: 'dataRoot'|'devDataRoot' }[]} */
  const candidates = [];
  if (role === 'dev') {
    if (cfg.devDataRoot) {
      candidates.push({ path: path.resolve(cfg.devDataRoot), source: 'devDataRoot' });
    }
    if (cfg.dataRoot) {
      candidates.push({ path: path.resolve(cfg.dataRoot), source: 'dataRoot' });
    }
  } else if (cfg.dataRoot) {
    candidates.push({ path: path.resolve(cfg.dataRoot), source: 'dataRoot' });
  }

  let lastMissing = '';
  for (const c of candidates) {
    if (fs.existsSync(c.path) && fs.statSync(c.path).isDirectory()) {
      return { ok: true, dataRoot: c.path, source: c.source };
    }
    lastMissing = c.path;
  }

  if (lastMissing) {
    if (role === 'dev' && opts.fallback) {
      return { ok: true, dataRoot: path.resolve(opts.fallback), source: 'fallback' };
    }
    return { ok: false, reason: 'missing_path', dataRoot: lastMissing };
  }

  if (role === 'dev' && opts.fallback) {
    return { ok: true, dataRoot: path.resolve(opts.fallback), source: 'fallback' };
  }
  return { ok: false, reason: 'missing_config' };
}

export function printDataRootUnavailable(result) {
  if (result.reason === 'missing_config') {
    console.error('尚未初始化数据空间。');
    console.error('请使用 lantern init 初始化或选择已有数据空间。');
    return;
  }
  console.error('数据空间不存在或已被移动/重命名/删除：');
  console.error(`  ${result.dataRoot}`);
  console.error('请重新 lantern init：使用 lantern init 初始化或选择已有数据空间。');
}
