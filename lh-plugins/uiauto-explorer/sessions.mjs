/**
 * 生成会话：浏览器子进程管理 + 会话落盘 + 试跑 / 写盘。
 *
 * 会话数据放在本机缓存目录 `<空间>/.lantern/local/uiauto/sessions/<id>.json`，
 * 截图在旁边 `<id>/shots/`。
 * 试跑草稿写进项目的 `.lantern-ai/<会话>/`（目录自带 .gitignore），失败保留现场，
 * 可打开 / 重跑 / 看 trace；最终落盘由用户点击确认，写入后还能按项目配置验收。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { diffText, summarizeDiff } from './diff.mjs';
import { emitCode } from './emit.mjs';
import { normalizeIr, slugify } from './ir.mjs';
import { mergeGeneratedFile } from './merge.mjs';
import { normalizePlan } from './plan.mjs';

const RUNNER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.mjs');
const MAX_VERIFY_LOG = 64 * 1024;
const DEFAULT_VERIFY_TIMEOUT = 180000;
/** 草稿保留天数：超过就没人再看了，留着只是占目录 */
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LEDGER_FILE_BYTES = 400 * 1024;

/** Playwright 的 line reporter 会写光标控制符，日志里留着很难看 */
function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** sessionId → { child, pending, shotsDir, sessionId } */
const RUNNING = new Map();

/** 浏览器被用户关掉时对外统一用这句，前端据此判断「这轮结束了，别重试」 */
export const CLOSED_MESSAGE = '浏览器已被关闭，探索已结束';

/** 订阅「浏览器被用户关掉」：lh-uiauto 用它把会话状态收回草稿 */
const closedHandlers = new Set();

export function onExplorerClosed(handler) {
  closedHandlers.add(handler);
  return () => closedHandlers.delete(handler);
}

export const SESSIONS_DIR_NAME = 'sessions';

export function sessionsDir(baseDir) {
  return path.join(baseDir, SESSIONS_DIR_NAME);
}

export function sessionFilePath(baseDir, id) {
  return path.join(sessionsDir(baseDir), `${id}.json`);
}

export function sessionShotsDir(baseDir, id) {
  return path.join(sessionsDir(baseDir), id, 'shots');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** 探索活动最多留这么多条：只是给人回看的日志，别把会话文件撑大 */
const MAX_ACTIVITY = 200;

const ACTIVITY_KINDS = new Set(['info', 'tool', 'error', 'shot']);
const ACTIVITY_STATUSES = new Set(['running', 'done', 'failed']);

/** 活动日志归一化：只留展示需要的字段，超长截断 */
export function normalizeActivity(raw) {
  const list = Array.isArray(raw) ? raw.slice(-MAX_ACTIVITY) : [];
  const items = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? '').slice(0, 120);
    if (!name) continue;
    items.push({
      kind: ACTIVITY_KINDS.has(item.kind) ? item.kind : 'info',
      name,
      detail: String(item.detail ?? '').slice(0, 2000),
      status: ACTIVITY_STATUSES.has(item.status) ? item.status : 'done',
      at: String(item.at ?? '').slice(0, 40) || undefined,
    });
  }
  return items;
}

/**
 * 活动日志按「只增不删」合并。
 *
 * 前端每次存的是整份列表，页面重载 / 状态没捞回来时可能只带着最后两三条，
 * 直接覆盖会把上一轮的记录抹掉（用户要的就是能回看）。这里按
 * at + name 去重，老记录顺序不动，新记录追加在后面；真要清空走 replaceActivity。
 */
export function mergeActivityLog(existing, incoming) {
  const old = normalizeActivity(existing);
  const next = normalizeActivity(incoming);
  if (!old.length) return next;
  if (!next.length) return old;
  const seen = new Set(old.map((item) => `${item.at ?? ''}|${item.name}`));
  const appended = next.filter((item) => {
    const key = `${item.at ?? ''}|${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return normalizeActivity([...old, ...appended]);
}

/** 新建 / 更新会话；不带 id 时新建 */
export function saveGeneratedSession(baseDir, rawPatch = {}) {
  // 前端没传的字段不能把已有值覆盖成 undefined（JSON 里会直接消失）
  const patch = {};
  for (const [key, value] of Object.entries(rawPatch)) {
    if (value !== undefined) patch[key] = value;
  }
  const id = String(patch.id || '').trim() || `gen_${crypto.randomBytes(8).toString('hex')}`;
  const file = sessionFilePath(baseDir, id);
  const existing = readJson(file) || {};
  const now = new Date().toISOString();
  // 显式传 ir: null 表示「清掉上一轮的步骤」，不能当成没传而把旧脚本留下来
  const hasIr = Object.prototype.hasOwnProperty.call(patch, 'ir');
  const ir = !hasIr
    ? existing.ir || null
    : patch.ir
      ? normalizeIr(patch.ir, {
          title: existing.title,
          baseURL: existing.baseURL,
          storageState: existing.storageState,
          source: existing.source,
          target: existing.target,
        })
      : null;
  const record = {
    ...existing,
    ...patch,
    id,
    ir,
    plan: patch.plan !== undefined ? normalizePlan(patch.plan) : existing.plan || [],
    activity:
      patch.activity !== undefined ? normalizeActivity(patch.activity) : existing.activity || [],
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  delete record.shots;
  writeJsonAtomic(file, record);
  return record;
}

export function readGeneratedSession(baseDir, id) {
  if (!id) return null;
  const record = readJson(sessionFilePath(baseDir, id));
  if (!record) return null;
  // 同 listGeneratedSessions：进程已经没了，「探索中」按未完成的草稿展示
  if (record.status === 'exploring' && !RUNNING.has(record.id)) record.status = 'draft';
  return record;
}

export function listGeneratedSessions(baseDir, projectId = '') {
  const dir = sessionsDir(baseDir);
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const record = readJson(path.join(dir, name));
    if (!record || !record.id) continue;
    if (projectId && record.projectId !== projectId) continue;
    // 服务重启后浏览器进程一定没了：还在「探索中」的会话其实是上次没收尾的，
    // 不收敛的话页面会一直显示探索中、按钮也点不动。
    // 只在内存里改状态，不回写文件也不动 updatedAt —— 否则这条「空会话」会
    // 因为时间戳变新被当成最近一次会话恢复出来，把用户真正的计划顶掉
    if (record.status === 'exploring' && !RUNNING.has(record.id)) {
      record.status = 'draft';
    }
    items.push({
      id: record.id,
      projectId: record.projectId || '',
      title: record.title || '未命名流程',
      target: record.target === 'python' ? 'python' : 'ts',
      status: record.status || 'draft',
      stepCount: Array.isArray(record.ir?.steps) ? record.ir.steps.length : 0,
      createdAt: record.createdAt || '',
      updatedAt: record.updatedAt || '',
    });
  }
  return items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 50);
}

export function deleteGeneratedSession(baseDir, id) {
  if (!id) return false;
  const file = sessionFilePath(baseDir, id);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  fs.rmSync(path.join(sessionsDir(baseDir), id), { recursive: true, force: true });
  return true;
}

function respondError(entry, id, message) {
  const pending = entry.pending.get(id);
  if (!pending) return;
  entry.pending.delete(id);
  clearTimeout(pending.timer);
  pending.reject(new Error(message));
}

/** 拉起浏览器子进程，等到 ready 再返回 */
export function startExplorer({ baseDir, project, sessionId, baseURL, headed, storageState }) {
  const existing = RUNNING.get(sessionId);
  if (existing) return Promise.resolve(existing);

  const shots = sessionShotsDir(baseDir, sessionId);
  fs.mkdirSync(shots, { recursive: true });

  const payload = {
    projectDir: project.dir,
    shotDir: shots,
    baseURL: baseURL || '',
    headed: Boolean(headed),
    storageState: storageState || '',
  };

  const child = spawn(process.execPath, [RUNNER_PATH, JSON.stringify(payload)], {
    cwd: project.dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  const entry = {
    id: sessionId,
    child,
    pending: new Map(),
    seq: 0,
    stderr: '',
    shotsDir: shots,
  };
  RUNNING.set(sessionId, entry);

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    entry.stderr = `${entry.stderr}${chunk}`.slice(-8000);
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('浏览器启动超时（45s）'));
    }, 45000);
    entry.readyTimer = timer;
    entry.resolveReady = resolve;
    entry.rejectReady = reject;
  });

  child.on('error', (err) => {
    entry.rejectReady?.(err);
    for (const [id] of entry.pending) respondError(entry, id, String(err));
    RUNNING.delete(sessionId);
  });
  child.on('exit', (code) => {
    clearTimeout(entry.readyTimer);
    // 浏览器被用户关掉时子进程会紧跟着退出：这时已经按「用户关闭」处理过，
    // 别再拿进程退出码覆盖掉更准确的原因
    if (entry.closedByUser) {
      RUNNING.delete(sessionId);
      return;
    }
    entry.rejectReady?.(new Error(`浏览器进程退出（code=${code ?? 'null'}）`));
    for (const [id] of entry.pending) {
      respondError(entry, id, `浏览器进程已退出（code=${code ?? 'null'}）`);
    }
    RUNNING.delete(sessionId);
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.type === 'ready') {
      clearTimeout(entry.readyTimer);
      entry.resolveReady?.({ playwright: message.playwright });
      return;
    }
    if (message.type === 'fatal') {
      clearTimeout(entry.readyTimer);
      entry.rejectReady?.(new Error(message.error || '浏览器启动失败'));
      return;
    }
    if (message.type === 'closed') {
      // 用户手动关掉了浏览器窗口：把这一轮的待办全部失败掉，
      // 并通知上层（lh-uiauto）结束探索状态，别让会话一直挂着「探索中」。
      entry.closedByUser = true;
      clearTimeout(entry.readyTimer);
      for (const [id] of entry.pending) {
        respondError(entry, id, CLOSED_MESSAGE);
      }
      RUNNING.delete(sessionId);
      for (const handler of closedHandlers) {
        try {
          handler({ sessionId, reason: message.reason || 'browser-closed' });
        } catch {
          // 通知失败不影响清理
        }
      }
      return;
    }
    const pending = entry.pending.get(message.id);
    if (!pending) return;
    entry.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || '浏览器操作失败'));
  });

  return ready.then(() => entry);
}

export function hasExplorer(sessionId) {
  return RUNNING.has(sessionId);
}

export function explorerStderr(sessionId) {
  return RUNNING.get(sessionId)?.stderr ?? '';
}

/** 调一条浏览器命令 */
export function callExplorer(sessionId, cmd, args = {}, timeoutMs = 60000) {
  const entry = RUNNING.get(sessionId);
  // 浏览器已经被关掉（或这轮本来就没起）：用统一文案让上层直接结束，而不是让模型重试
  if (!entry) return Promise.reject(new Error(CLOSED_MESSAGE));
  entry.seq += 1;
  const id = entry.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error(`浏览器操作超时：${cmd}`));
    }, timeoutMs);
    entry.pending.set(id, { resolve, reject, timer });
    entry.child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
  });
}

export function stopExplorer(sessionId) {
  const entry = RUNNING.get(sessionId);
  if (!entry) return false;
  RUNNING.delete(sessionId);
  try {
    entry.child.stdin.write(`${JSON.stringify({ id: -1, cmd: 'close', args: {} })}\n`);
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      entry.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }, 1200).unref?.();
  for (const [id] of entry.pending) respondError(entry, id, '会话已关闭');
  return true;
}

export function stopAllExplorers() {
  for (const id of [...RUNNING.keys()]) stopExplorer(id);
}

/* ------------------------- 草稿工作区 ------------------------- */

const toPosix = (value) => String(value).split(path.sep).join('/');

export function aiRootDir(projectDir) {
  return path.join(projectDir, '.lantern-ai');
}

/** 一个生成会话的草稿目录：配置 / 草稿 / 失败产物都在一起 */
export function draftPaths(projectDir, sessionId) {
  const root = path.join(aiRootDir(projectDir), sessionId);
  const draftDir = path.join(root, 'draft');
  const resultsDir = path.join(root, 'results');
  return {
    root,
    draftDir,
    resultsDir,
    configFile: path.join(root, 'playwright.config.ts'),
    relRoot: toPosix(path.relative(projectDir, root)),
    relDraftDir: toPosix(path.relative(projectDir, draftDir)),
    relResultsDir: toPosix(path.relative(projectDir, resultsDir)),
  };
}

/**
 * 草稿目录自带 `.gitignore`，不污染项目仓库。
 * 只写一次：用户如果自己改过就不要覆盖。
 */
function ensureAiRoot(projectDir) {
  const root = aiRootDir(projectDir);
  fs.mkdirSync(root, { recursive: true });
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, '# Lantern AI 生成的草稿与试跑产物，整个目录忽略\n*\n');
  }
  return root;
}

/** 删掉某个会话的草稿；清空后把 `.lantern-ai` 一起收掉 */
export function cleanupDraft(projectDir, sessionId) {
  const paths = draftPaths(projectDir, sessionId);
  fs.rmSync(paths.root, { recursive: true, force: true });
  const root = aiRootDir(projectDir);
  try {
    const rest = fs.readdirSync(root).filter((name) => name !== '.gitignore');
    if (!rest.length) fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // 目录不在就算了
  }
}

/** 启动时顺手清理过期草稿：AI 中间产物留一周足够 */
export function cleanupStaleDrafts(projectDir) {
  const root = aiRootDir(projectDir);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const item of names) {
    if (!item.isDirectory()) continue;
    const abs = path.join(root, item.name);
    try {
      if (now - fs.statSync(abs).mtimeMs > DRAFT_TTL_MS) {
        fs.rmSync(abs, { recursive: true, force: true });
      }
    } catch {
      // 并发删除 / 权限问题直接跳过
    }
  }
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 从项目里推断被测应用的起始地址。
 *
 * 之前只用一个写死的 `http://localhost:5173`，项目 `.env` / playwright 配置里
 * 明明写着 `BASE_URL=http://localhost:5173/admin` 也读不到，探索一开始就撞 404。
 * 这里按优先级读：
 *   1. playwright 配置里 `use.baseURL`（`process.env.X || '字面量'` 取字面量兜底值）
 *   2. 项目根 `.env` / `.env.local` 的 `BASE_URL=`（被注释掉的行不算）
 *   3. 项目内 `utils/config.ts` 之类文件里的同名兜底（只在没有 playwright 配置时兜一下）
 * 路径后缀（如 /admin）属于项目自己的路由，能读到就是读到的那个；读不到由用户
 * 在生成页改一次，之后按项目记住（见项目记录的 baseURL 字段）。
 */
export function detectBaseURL(projectDir) {
  const read = (name) => readTextFile(path.join(projectDir, name));

  // 1) playwright 配置：use.baseURL
  const configName = findPlaywrightConfig(projectDir);
  if (configName) {
    const content = read(configName);
    const fromConfig = pickBaseURLLiteral(content);
    if (fromConfig) return fromConfig;
  }

  // 2) 项目根的环境变量文件（只认 BASE_URL，忽略注释行）
  for (const name of ['.env', '.env.local', '.env.development']) {
    const content = read(name);
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = /^BASE_URL\s*=\s*(.+)$/.exec(trimmed);
      if (!match) continue;
      const value = match[1].trim().replace(/^['"]|['"]$/g, '');
      if (/^https?:\/\//i.test(value)) return value;
    }
  }

  // 3) 最后兜一下 utils/config.* 之类的常量
  for (const name of ['utils/config.ts', 'src/utils/config.ts', 'config/base.ts']) {
    const content = read(name);
    if (!content) continue;
    const fromConfig = pickBaseURLLiteral(content);
    if (fromConfig) return fromConfig;
  }
  return '';
}

/** `baseURL: process.env.BASE_URL || 'http://x'` → `http://x`；直接写字面量也认 */
function pickBaseURLLiteral(content) {
  const key = /baseURL\s*:/i.exec(content);
  if (!key) return '';
  const tail = content.slice(key.index, key.index + 400);
  const urls = tail.match(/https?:\/\/[^\s'"`,)]+/g);
  if (!urls || !urls.length) return '';
  // `process.env.BASE_URL || 'http://localhost:5173'`：取第一个真实地址
  return urls[0].replace(/\/+$/, '') || '';
}

/** 登录态文件的常见命名，按目录顺序找第一个存在的 */
const STORAGE_STATE_NAMES = [
  'auth-admin.json',
  'auth-user.json',
  'auth.json',
  'storage-state.json',
  'state.json',
];

const STORAGE_STATE_DIRS = [
  '',
  '.auth',
  'auth',
  'tests',
  'tests/.auth',
  'tests/fixtures',
  'fixtures',
  'e2e',
  'e2e/.auth',
];

const toPosixRel = (value) => value.split(path.sep).join('/');

/**
 * 项目里已有的登录态（相对项目根的 POSIX 路径，找不到返回空串）。
 *
 * 只做「看一眼」，不代表一定能用：cookie 可能已过期，真正加载前 runner 还会再校验文件存在。
 * 探测顺序：playwright 配置里写死的 storageState → 常见命名 → `.auth/` 下的任意 json。
 */
export function detectStorageState(projectDir) {
  const abs = (rel) => path.join(projectDir, rel);
  const existsFile = (rel) => {
    try {
      return fs.statSync(abs(rel)).isFile();
    } catch {
      return false;
    }
  };

  // 1) playwright 配置：use.storageState / 项目级 storageState
  const configName = findPlaywrightConfig(projectDir);
  if (configName) {
    const fromConfig = pickStorageStateLiteral(readTextFile(path.join(projectDir, configName)));
    // 配置里常写成相对配置文件 / 项目根的路径，两种都试一下；
    // 越界（../）或绝对路径只做存在性判断没意义，直接忽略
    for (const candidate of [fromConfig, fromConfig.replace(/^\.\//, '')]) {
      if (!candidate || path.isAbsolute(candidate) || candidate.includes('..')) continue;
      if (existsFile(candidate)) return toPosixRel(candidate);
    }
  }

  // 2) 约定命名：项目根 / .auth / tests / fixtures
  for (const dir of STORAGE_STATE_DIRS) {
    for (const name of STORAGE_STATE_NAMES) {
      const rel = dir ? path.join(dir, name) : name;
      if (existsFile(rel)) return toPosixRel(rel);
    }
  }

  // 3) `.auth/` 里项目自己命名的 json（`auth.setup.ts` 存出来的那种）
  for (const dir of ['.auth', 'auth']) {
    try {
      const files = fs
        .readdirSync(abs(dir))
        .filter((name) => /\.json$/i.test(name))
        .sort();
      if (files.length) return toPosixRel(path.join(dir, files[0]));
    } catch {
      // 没有这个目录就算了
    }
  }
  return '';
}

/** `storageState: './auth.json'` → `./auth.json`；模板字符串 / 变量一律不认 */
function pickStorageStateLiteral(content) {
  const match = /storageState\s*:\s*(['"])([^'"]+)\1/.exec(String(content || ''));
  return match ? match[2].trim() : '';
}

/** 从 playwright 配置里读 testDir，读不到就用默认值 */
export function detectPlaywrightTestDir(projectDir) {
  for (const name of [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.mts',
    'playwright.config.cts',
  ]) {
    const file = path.join(projectDir, name);
    if (!fs.existsSync(file)) continue;
    const content = readTextFile(file);
    const match = /testDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(content);
    if (match) return match[1].replace(/^\.\//, '');
    return 'tests';
  }
  return 'tests';
}

export function findPlaywrightConfig(projectDir) {
  for (const name of [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.mts',
    'playwright.config.cts',
  ]) {
    if (fs.existsSync(path.join(projectDir, name))) return name;
  }
  return '';
}

/**
 * 草稿放在项目的 `projects[].testMatch` 之外时，Playwright 会直接「No tests found」。
 * 所以试跑 / 调试用一份独立配置：继承用户配置（webServer / expect / retries 等），
 * 只把 testDir 指向草稿目录、reporter 收成 line、projects 换成一个不设 testMatch 的项目。
 */
function writeDraftConfig({ projectDir, sessionId, baseConfig, storageState, baseURL }) {
  const paths = draftPaths(projectDir, sessionId);
  ensureAiRoot(projectDir);
  fs.mkdirSync(paths.draftDir, { recursive: true });
  fs.mkdirSync(paths.resultsDir, { recursive: true });
  const rootRel = toPosix(path.relative(path.dirname(paths.configFile), projectDir));
  const importer = baseConfig
    ? `import base from '${rootRel}/${baseConfig.replace(/\.(ts|js|mjs|mts|cts)$/, '')}';\n\n`
    : '';
  const useLines = ['    ...(config.use ?? {}),'];
  if (baseURL) useLines.push(`    baseURL: ${JSON.stringify(baseURL)},`);
  if (storageState) useLines.push(`    storageState: ${JSON.stringify(storageState)},`);
  // 失败时留下 trace：用户可以在面板里直接打开回放
  useLines.push("    trace: 'retain-on-failure',");
  const source =
    `${importer}` +
    '// 自动生成：AI 草稿的试跑 / 调试配置，不属于用户用例\n' +
    `${baseConfig ? 'const config = base as any;\n' : 'const config = {} as any;\n'}\n` +
    'export default {\n' +
    '  ...config,\n' +
    "  testDir: './draft',\n" +
    "  outputDir: './results',\n" +
    "  reporter: [['line']],\n" +
    '  use: {\n' +
    `${useLines.join('\n')}\n` +
    '  },\n' +
    "  projects: [{ name: 'lantern-ai' }],\n" +
    '};\n';
  fs.writeFileSync(paths.configFile, source);
  return paths;
}

function findPlaywrightBin(projectDir) {
  const names =
    process.platform === 'win32'
      ? ['playwright.cmd', 'playwright']
      : ['playwright', 'playwright.sh'];
  for (const name of names) {
    const bin = path.join(projectDir, 'node_modules', '.bin', name);
    if (fs.existsSync(bin)) return bin;
  }
  return '';
}

/** 项目自己的 playwright 可执行文件；没有就退回 `npx --no-install` */
function playwrightRunner(projectDir) {
  const bin = findPlaywrightBin(projectDir);
  if (bin) return { command: bin, prefix: [] };
  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    prefix: ['--no-install', 'playwright'],
  };
}

function detectPython(projectDir) {
  const candidates =
    process.platform === 'win32'
      ? [path.join(projectDir, '.venv', 'Scripts', 'python.exe'), 'python', 'py']
      : [path.join(projectDir, '.venv', 'bin', 'python'), 'python3', 'python'];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  return 'python3';
}

function runProcess({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let output = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(env || {}), FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: -1,
        output: `启动失败：${err instanceof Error ? err.message : String(err)}`,
        durationMs: 0,
        timedOut: false,
      });
      return;
    }
    const append = (chunk) => {
      output += chunk;
      if (output.length > MAX_VERIFY_LOG) output = output.slice(-MAX_VERIFY_LOG);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => append(`\n[lantern] ${err.message}`));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        output,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

/** 递归找最新一个 trace.zip，失败现场就在里面 */
function findTrace(resultsDir) {
  let newest = null;
  const walk = (dir, level) => {
    if (level > 4) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) walk(abs, level + 1);
      else if (item.name === 'trace.zip') {
        try {
          const mtime = fs.statSync(abs).mtimeMs;
          if (!newest || mtime > newest.mtime) newest = { abs, mtime };
        } catch {
          // ignore
        }
      }
    }
  };
  walk(resultsDir, 0);
  return newest ? newest.abs : '';
}

/** 把 IR 渲染成草稿文件（不执行），试跑 / 调试 / 打开草稿都走这里 */
function prepareDraft({ project, session }) {
  const ir = normalizeIr(session.ir || {}, {
    target: session.target,
    title: session.title,
    baseURL: session.baseURL,
    storageState: session.storageState,
    source: session.source,
  });
  if (!ir.steps.length) return { error: '还没有生成步骤，无法试跑' };
  const emitted = emitCode(ir, session.target);
  const isPython = emitted.language === 'python';
  const paths = draftPaths(project.dir, session.id);
  ensureAiRoot(project.dir);
  fs.mkdirSync(paths.draftDir, { recursive: true });
  const draftFile = path.join(paths.draftDir, emitted.filename);
  fs.writeFileSync(draftFile, emitted.code);
  const relDraft = toPosix(path.relative(project.dir, draftFile));

  let configRel = '';
  if (!isPython) {
    const storageStateAbs = session.storageState
      ? path.resolve(project.dir, session.storageState)
      : '';
    writeDraftConfig({
      projectDir: project.dir,
      sessionId: session.id,
      baseConfig: findPlaywrightConfig(project.dir),
      storageState: storageStateAbs && fs.existsSync(storageStateAbs) ? storageStateAbs : '',
      baseURL: ir.baseURL,
    });
    configRel = toPosix(path.relative(project.dir, paths.configFile));
  }

  return {
    ir,
    emitted,
    isPython,
    paths,
    draftFile,
    relDraft,
    configRel,
    draftInfo: {
      draftPath: relDraft,
      configPath: configRel,
      artifactDir: paths.relResultsDir,
      draftRoot: paths.relRoot,
    },
  };
}

/** 面板需要的「草稿现状」：没跑过也要能显示路径与按钮可用性 */
export function draftSummary({ project, session }) {
  const paths = draftPaths(project.dir, session.id);
  const hasSteps = Array.isArray(session.ir?.steps) && session.ir.steps.length > 0;
  const traceAbs = fs.existsSync(paths.resultsDir) ? findTrace(paths.resultsDir) : '';
  return {
    draftRoot: paths.relRoot,
    draftDir: paths.relDraftDir,
    artifactDir: paths.relResultsDir,
    configPath: toPosix(path.relative(project.dir, paths.configFile)),
    exists: fs.existsSync(paths.root),
    hasSteps,
    tracePath: traceAbs ? toPosix(path.relative(project.dir, traceAbs)) : '',
  };
}

function tailLog(output, lines = 120) {
  const clean = stripAnsi(output);
  return clean
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-lines)
    .join('\n')
    .slice(-12000);
}

/**
 * 试跑：草稿写到 `.lantern-ai/<会话>/draft/`，**跑完不删**。
 * 失败现场要能打开看、能重跑、能回放 trace；正式文件只在用户确认后写。
 */
export async function verifySession({ project, session, timeoutMs = DEFAULT_VERIFY_TIMEOUT }) {
  const prepared = prepareDraft({ project, session });
  if (prepared.error) return { ok: false, passed: false, error: prepared.error };
  const { isPython, paths, relDraft, configRel, draftInfo, emitted } = prepared;

  let command;
  let args;
  if (isPython) {
    command = detectPython(project.dir);
    args = ['-m', 'pytest', relDraft, '-q'];
  } else {
    const runner = playwrightRunner(project.dir);
    command = runner.command;
    args = [
      ...runner.prefix,
      'test',
      '--config',
      configRel,
      '--reporter=line',
      '--workers=1',
      '--timeout=30000',
    ];
  }

  const result = await runProcess({
    command,
    args,
    cwd: project.dir,
    timeoutMs,
    env: { PLAYWRIGHT_HTML_OPEN: 'never', LANTERN_AI_DRAFT: '1' },
  });

  const traceAbs = isPython ? '' : findTrace(paths.resultsDir);
  return {
    ok: true,
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    command: [command, ...args].join(' '),
    code: emitted.code,
    log: tailLog(result.output),
    ...draftInfo,
    tracePath: traceAbs ? toPosix(path.relative(project.dir, traceAbs)) : '',
  };
}

/* ---------------------------- 调试 ---------------------------- */

/** sessionId → { child, port }；Playwright UI 是长驻进程，必须能停 */
const DEBUG_RUNNING = new Map();

function findFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(0));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.setTimeout(800);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) resolve(false);
        else setTimeout(tryOnce, 300).unref?.();
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    tryOnce();
  });
}

/**
 * 调试：`headed` 跑一遍并保留 trace；`ui` 拉起 Playwright UI（长驻，可停止）。
 */
export async function debugSession({ project, session, mode = 'headed' }) {
  if (session.target === 'python') {
    return {
      ok: false,
      error: 'Python 草稿没有 Playwright UI，可用「调试运行」在终端看输出，或直接打开草稿文件',
    };
  }
  const prepared = prepareDraft({ project, session });
  if (prepared.error) return { ok: false, error: prepared.error };
  stopDebugSession(session.id);
  const runner = playwrightRunner(project.dir);
  const baseArgs = [
    ...runner.prefix,
    'test',
    '--config',
    prepared.configRel,
    '--workers=1',
    '--timeout=30000',
  ];

  if (mode === 'ui') {
    const port = (await findFreePort()) || 0;
    let child;
    try {
      child = spawn(runner.command, [...baseArgs, '--ui', `--ui-port=${port}`], {
        cwd: project.dir,
        env: { ...process.env, FORCE_COLOR: '0', PLAYWRIGHT_HTML_OPEN: 'never' },
        stdio: 'ignore',
        detached: false,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    child.on('exit', () => DEBUG_RUNNING.delete(session.id));
    DEBUG_RUNNING.set(session.id, { child, port });
    const ready = port ? await waitForPort(port) : false;
    return {
      ok: true,
      mode: 'ui',
      url: `http://127.0.0.1:${port}`,
      ready,
      ...prepared.draftInfo,
      note: ready ? 'Playwright UI 已启动' : 'UI 启动较慢，稍后再点一次「打开 Playwright UI」',
    };
  }

  const result = await runProcess({
    command: runner.command,
    args: [...baseArgs, '--headed', '--trace=on', '--reporter=line'],
    cwd: project.dir,
    timeoutMs: DEFAULT_VERIFY_TIMEOUT,
    env: { PLAYWRIGHT_HTML_OPEN: 'never', LANTERN_AI_DRAFT: '1' },
  });
  const traceAbs = findTrace(prepared.paths.resultsDir);
  return {
    ok: true,
    mode: 'headed',
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    command: [runner.command, ...baseArgs, '--headed', '--trace=on'].join(' '),
    log: tailLog(result.output),
    ...prepared.draftInfo,
    tracePath: traceAbs ? toPosix(path.relative(project.dir, traceAbs)) : '',
  };
}

export function stopDebugSession(sessionId) {
  const entry = DEBUG_RUNNING.get(sessionId);
  if (!entry) return false;
  DEBUG_RUNNING.delete(sessionId);
  try {
    entry.child.kill('SIGTERM');
  } catch {
    // ignore
  }
  return true;
}

export function hasDebugSession(sessionId) {
  return DEBUG_RUNNING.has(sessionId);
}

export function stopAllDebugSessions() {
  for (const id of [...DEBUG_RUNNING.keys()]) stopDebugSession(id);
}

/**
 * 用项目自带的 `playwright show-trace` 打开 trace。
 * 直接 open 一个 zip 只会进解压软件，看不到回放。
 */
export function showTrace({ project, relPath }) {
  const target = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .trim();
  if (!target || target.includes('..') || path.isAbsolute(target)) {
    return { ok: false, error: 'trace 路径不合法' };
  }
  const abs = path.join(project.dir, target);
  const root = project.dir.endsWith(path.sep) ? project.dir : `${project.dir}${path.sep}`;
  if (!abs.startsWith(root) || !fs.existsSync(abs)) {
    return { ok: false, error: 'trace 还不存在，先试跑或调试运行一次' };
  }
  const runner = playwrightRunner(project.dir);
  try {
    const child = spawn(runner.command, [...runner.prefix, 'show-trace', abs], {
      cwd: project.dir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    child.unref();
    return { ok: true, path: target, kind: 'trace' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------- 写入与验收 ------------------------- */

/** 归一化写入路径：去掉前导 ./ 与多余斜杠，拒绝跳出项目目录 */
function normalizeRelPath(raw) {
  return String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

/** 单个路径的安全校验：非法时返回错误文案 */
function checkRelPath(project, target) {
  if (!target || target.includes('..') || path.isAbsolute(target)) return '文件路径不合法';
  const abs = path.join(project.dir, target);
  const root = project.dir.endsWith(path.sep) ? project.dir : `${project.dir}${path.sep}`;
  if (!abs.startsWith(root)) return '只能写到项目目录内';
  return '';
}

/**
 * 一次写多个文件（一条用例可能同时动 spec / page object / fixture）。
 *
 * 先全量预检再写盘：只要有一个冲突就整批不写，避免「写了一半」的半成品。
 * 写盘中途异常时用账本里的 before 回滚已经写过的文件。
 */
export function writeGeneratedFiles(params) {
  const { project, files, session = null, force = false } = params;
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return { ok: false, error: '没有要写入的文件' };

  const prepared = [];
  const conflicts = [];
  const seen = new Set();
  for (const item of list) {
    const target = normalizeRelPath(item.path);
    const bad = checkRelPath(project, target);
    if (bad) return { ok: false, error: `${bad}：${item.path ?? ''}` };
    if (seen.has(target)) continue;
    seen.add(target);
    const abs = path.join(project.dir, target);
    const existed = fs.existsSync(abs);
    const role = item.role ? String(item.role) : '';
    let content = String(item.content ?? '');
    let mergeMode = '';
    if (existed && !force && !item.force) {
      // 默认合并：已有文件保留，只把这次生成的用例 / 方法补进去。
      // 合并不了（类名对不上等）才退回冲突，让用户显式勾选覆盖。
      const merged = mergeGeneratedFile(fs.readFileSync(abs, 'utf8'), content, {
        role,
        path: target,
      });
      if (!merged) {
        conflicts.push({ path: target, exists: true });
        continue;
      }
      content = merged.content;
      mergeMode = merged.unchanged ? 'unchanged' : 'merge';
    }
    prepared.push({
      path: target,
      content,
      existed,
      role,
      mergeMode,
    });
  }
  if (conflicts.length) {
    return {
      ok: false,
      error: '目标文件已存在且无法合并，勾选覆盖后再写入',
      conflicts,
      files: [],
      changes: Array.isArray(session?.changes) ? session.changes : [],
    };
  }

  const written = [];
  const changes = Array.isArray(session?.changes) ? session.changes.slice() : [];
  try {
    for (const item of prepared) {
      const abs = path.join(project.dir, item.path);
      const before = item.existed ? readTextFile(abs) : '';
      // 内容和原文件一样（用例已经写过了）就别碰文件，也不进账本
      if (item.mergeMode === 'unchanged' || (item.existed && before === item.content)) {
        written.push({ path: item.path, kind: 'unchanged', role: item.role || '' });
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, item.content);
      const change = {
        path: item.path,
        kind: item.existed ? (item.mergeMode === 'merge' ? 'merge' : 'update') : 'create',
        role: item.role || undefined,
        at: new Date().toISOString(),
        before: before.slice(0, MAX_LEDGER_FILE_BYTES),
        after: item.content.slice(0, MAX_LEDGER_FILE_BYTES),
        ...summarizeDiff(before, item.content),
      };
      const index = changes.findIndex((entry) => entry.path === item.path);
      if (index >= 0) changes[index] = change;
      else changes.push(change);
      written.push({ path: item.path, kind: change.kind, role: item.role || '' });
    }
  } catch (err) {
    // 回滚：只回滚已经写过的，新建的删掉、改过的写回原内容
    for (const item of written) {
      const abs = path.join(project.dir, item.path);
      try {
        if (item.kind === 'create') fs.rmSync(abs, { force: true });
        else {
          const ledger = changes.find((entry) => entry.path === item.path);
          fs.writeFileSync(abs, String(ledger?.before ?? ''));
        }
      } catch {
        /* 回滚失败也继续，最后把原始错误抛给用户 */
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const summary = written.reduce(
    (acc, item) => {
      if (item.kind === 'create') acc.created += 1;
      else if (item.kind === 'merge') acc.merged += 1;
      else if (item.kind === 'unchanged') acc.unchanged += 1;
      else acc.updated += 1;
      return acc;
    },
    { created: 0, merged: 0, updated: 0, unchanged: 0 },
  );

  return {
    ok: true,
    files: written,
    paths: written.map((item) => item.path),
    summary,
    changes,
  };
}

/** 写进项目（用户确认后才调用）；返回 before/after 供「变更」面板出 diff */
export function writeGeneratedFile({ project, session, relPath, force = false }) {
  const ir = normalizeIr(session.ir || {}, { target: session.target, title: session.title });
  if (!ir.steps.length) return { ok: false, error: '还没有生成步骤' };
  const emitted = emitCode(ir, session.target);
  const testDir = detectPlaywrightTestDir(project.dir);
  const fallback = `${testDir}/${emitted.filename}`;
  const result = writeGeneratedFiles({
    project,
    session,
    force,
    files: [{ path: relPath || fallback, content: emitted.code, role: 'spec' }],
  });
  if (!result.ok) return result;
  const change = result.changes.find((item) => item.path === result.paths[0]);
  return {
    ok: true,
    path: result.paths[0],
    code: emitted.code,
    filename: emitted.filename,
    change,
    changes: result.changes,
  };
}

/** 会话里的变更账本 → 带 hunk 的 diff，前端直接渲染 */
export function sessionChanges(session) {
  const ledger = Array.isArray(session.changes) ? session.changes : [];
  return ledger.map((item) => {
    const before = String(item.before ?? '');
    const after = String(item.after ?? '');
    // 只回传 diff，不回传整份文件内容（账本里的 before/after 只用于重算）
    const { before: _before, after: _after, ...rest } = item;
    return { ...rest, ...diffText(before, after) };
  });
}

/**
 * 写入后用项目真实配置再跑一遍：这才是「这条用例在项目里真的能跑」。
 * 若文件被项目 testMatch 排除，Playwright 会报 No tests found，这里单独标出来。
 */
export async function runProjectFile({
  project,
  session,
  relPath,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT,
}) {
  const target = String(relPath || session.savedPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .trim();
  if (!target || target.includes('..') || path.isAbsolute(target)) {
    return { ok: false, error: '文件路径不合法' };
  }
  const abs = path.join(project.dir, target);
  const root = project.dir.endsWith(path.sep) ? project.dir : `${project.dir}${path.sep}`;
  if (!abs.startsWith(root) || !fs.existsSync(abs)) {
    return { ok: false, error: '文件还没写入项目，先点「写入项目」' };
  }
  const isPython = /\.py$/i.test(target);
  let command;
  let args;
  if (isPython) {
    command = detectPython(project.dir);
    args = ['-m', 'pytest', target, '-q'];
  } else {
    const runner = playwrightRunner(project.dir);
    command = runner.command;
    args = [...runner.prefix, 'test', target, '--reporter=line', '--workers=1'];
  }
  const result = await runProcess({
    command,
    args,
    cwd: project.dir,
    timeoutMs,
    env: { PLAYWRIGHT_HTML_OPEN: 'never' },
  });
  const log = tailLog(result.output);
  const excluded = /No tests found/i.test(log);
  return {
    ok: true,
    checked: true,
    passed: result.exitCode === 0 && !excluded,
    excluded,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    command: [command, ...args].join(' '),
    path: target,
    log,
    note: excluded
      ? '项目配置的 testMatch 不包含这个文件，Playwright 没把它当成用例；换个路径或者在项目配置里放开'
      : '',
  };
}

/* --------------------------- git 摘要 --------------------------- */

const GIT_IGNORE_HINTS = [
  '.lantern-ai/',
  'node_modules/',
  'test-results/',
  'playwright-report/',
  'reports/',
  'dist/',
  '.next/',
  '__pycache__/',
  '.venv/',
];

function git(args, cwd, timeout = 2000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) resolve('');
      else resolve(String(stdout ?? ''));
    });
  });
}

/**
 * 只读的 git 工作区摘要：展示「除了本次 AI 写入，项目里还有哪些改动」。
 * 拿不到 git 就返回空，不让它影响主流程。
 */
export async function gitStatusSummary(projectDir) {
  const inside = (await git(['rev-parse', '--is-inside-work-tree'], projectDir)).trim();
  if (inside !== 'true') return { ok: false, entries: [], truncated: false };
  const raw = await git(['status', '--porcelain=v1', '--untracked-files=normal'], projectDir);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const entries = [];
  let filtered = 0;
  for (const line of lines) {
    const code = line.slice(0, 2).trim() || '??';
    const file = line.slice(3).replace(/^"|"$/g, '');
    if (GIT_IGNORE_HINTS.some((hint) => file.includes(hint))) {
      filtered += 1;
      continue;
    }
    entries.push({ code, path: file });
    if (entries.length >= 40) break;
  }
  return {
    ok: true,
    entries,
    truncated: lines.length > entries.length + filtered,
    filtered,
  };
}

export function suggestedPath({ project, session }) {
  const ir = normalizeIr(session.ir || {}, { target: session.target, title: session.title });
  const emitted = emitCode(ir, session.target);
  return `${detectPlaywrightTestDir(project.dir)}/${emitted.filename}`;
}

export { slugify };
