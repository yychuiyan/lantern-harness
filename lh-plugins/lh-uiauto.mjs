/**
 * 自动化测试（空间级）：挂载目标项目里已有的 Playwright，跑用例、看日志、看报告。
 *
 * 数据落在：
 * ```
 * <当前数据空间>/自动化测试/
 *   自动化测试.json          # { version, projects, runs }
 *   <项目名>/
 *     报告/<runId>/          # 运行结束后快照过来的 HTML 报告
 *     结果/<runId>.json|xml  # Playwright JSON / JUnit XML 原始结果
 *     日志/<runId>.log       # 原始 stdout / stderr
 * ```
 * 本机数据（应用图标缓存、生成会话与截图）不进内容目录，落在
 * `<当前数据空间>/.lantern/local/uiauto/{app-icons,sessions}/`。
 * 旧版本的 `UI自动化/` 目录在首次访问时自动改名迁移，不需要重开插件开关。
 *
 * 约束：
 * - 运行时不联网：跑用例只用项目自己的 `node_modules/.bin/playwright`，
 *   退而求其次 `npx --no-install playwright`；找不到就报「未安装」。
 * - 唯一的写操作是「一键安装」（用户点按钮才跑）：按项目锁文件选包管理器，
 *   串行执行 install 与 `playwright install chromium`，日志落在项目日志目录。
 * - 常规运行 / 浏览是只读的；只有 AI 生成（`/agent/*`）会在用户确认后写文件：
 *   试跑草稿写进测试目录并立刻删除，最终脚本由用户点「写入项目」才落盘。
 * - 同一项目同时只允许一个 run，全局最多 2 个。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { pickDirectoryResult } from '../builtin/session/lh-fs.mjs';
import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot, spaceLocalDir } from '../builtin/session/space-layout.mjs';
import {
  ensurePluginPrompt,
  migrateLegacyPluginPrompts,
  pluginPromptPath,
  readPluginPrompt,
} from './plugin-prompts.mjs';
import {
  parseUiAutoPrompt,
  PROJECT_PROMPT_TEMPLATE,
  UI_AUTO_PROJECT_PROMPT_FILE,
  UI_AUTO_PROMPT_FILE,
  UI_AUTO_PROMPT_TEMPLATE,
} from './uiauto-prompt.mjs';
import {
  ADAPTER_IDS,
  adapterOptions,
  buildProbe,
  detectCandidates,
  getAdapter,
  MIN_DETECT_SCORE,
} from './uiauto-adapters/index.mjs';
import { buildPlaywrightArgs, parsePlaywrightReport } from './uiauto-adapters/playwright.mjs';
import { emptySummary, intOr, text } from './uiauto-adapters/shared.mjs';
import {
  customToTasks,
  detectPythonCommand,
  discoverRunTasks,
  applyTaskOverrides,
  normalizeCustomTasks,
  normalizeHiddenTaskIds,
  normalizeTaskOverrides,
  taskCommandLine,
  taskView,
} from './uiauto-adapters/tasks.mjs';
import { hasFilesInside, hasReportEntry, snapshotReport } from './uiauto-report.mjs';
import { nodeInstallPlan, nodeStatus, withProjectNode, writeNvmrc } from './uiauto-node.mjs';
import { resolvePackageManager } from './uiauto-pm.mjs';
import {
  envExampleFile,
  envFileName,
  envFilePath,
  envTaskMismatch,
  hasEnvConvention,
  isExampleFileName,
  isSkeletonEnv,
  listAuthStateFiles,
  maskEnvEntries,
  migrateLegacyExampleFile,
  parseEnvText,
  patchEnvText,
  PLATFORM_ENV_KEYS,
  readEnvKeyMatrix,
  readEnvSchema,
  sanitizeEnvName,
  scanEnvFiles,
  validateEnvEntries,
} from './uiauto-env.mjs';
import {
  applySkeletonToStack,
  auditScaffold,
  ensureSkeletonSeed,
  findStack,
  listStacks,
  loadSkeleton,
  readLedger,
  renderScaffold,
  skeletonFile,
} from './uiauto-scaffold/index.mjs';
import {
  callExplorer,
  cleanupDraft,
  cleanupStaleDrafts,
  debugSession,
  detectBaseURL,
  detectEmitLayout,
  detectStorageState,
  draftSummary,
  gitStatusSummary,
  hasDebugSession,
  hasExplorer,
  listGeneratedSessions,
  onExplorerClosed,
  readGeneratedSession,
  runProjectFile,
  saveGeneratedSession,
  sessionChanges,
  sessionShotsDir,
  sessionsDir,
  SESSIONS_DIR_NAME,
  showTrace,
  startExplorer,
  stopAllDebugSessions,
  stopAllExplorers,
  stopDebugSession,
  stopExplorer,
  suggestedPath,
  verifySession,
  writeGeneratedFiles,
  findPlaywrightConfig,
  mergeActivityLog,
} from './uiauto-explorer/sessions.mjs';
import { emitCode } from './uiauto-explorer/emit.mjs';
import { emitFiles } from './uiauto-explorer/emit-files.mjs';
import { appIcon, defaultOpenApp, listOpenApps, openWith } from './uiauto-explorer/apps.mjs';
import { bindPlanStep, mergePlanWithModel } from './uiauto-explorer/plan.mjs';

const PREFIX = '/__tb_uiauto';
const VERSION = 2;

/** 预加载守卫：给 Playwright 的 `--project` 参数让路（见文件内注释） */
const ARGV_GUARD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'uiauto-argv-guard.cjs',
);

export { buildPlaywrightArgs, parsePlaywrightReport };

export const UIAUTO_DIR_NAME = '自动化测试';
/** 旧版单文件（项目 + 运行记录放一起），首次读取时拆到下面两个目录 */
export const UIAUTO_STORE_FILE = '自动化测试.json';
/** 自动化项目：只放挂载 / 生成的项目记录 */
export const UIAUTO_PROJECTS_DIR_NAME = '自动化项目';
export const UIAUTO_PROJECTS_FILE = '自动化项目.json';
/** 自动化执行：运行历史 + 每个项目的报告 / 结果 / 日志 */
export const UIAUTO_RUNS_DIR_NAME = '自动化执行';
export const UIAUTO_RUNS_FILE = '自动化执行.json';
/** 0.1.9 及之前的目录 / 文件名，读取时自动迁移 */
export const LEGACY_DIR_NAME = 'UI自动化';
export const LEGACY_STORE_FILE = 'UI自动化.json';
export const REPORT_DIR_NAME = '报告';
export const RESULT_DIR_NAME = '结果';
export const LOG_DIR_NAME = '日志';
/** 新建项目时的检查 / 建议 / 安装留档：只保留最近一次，跟着项目目录走 */
export const GENERATION_DIR_NAME = '生成记录';
export const GENERATION_FILE_NAME = '生成过程.json';
export const GENERATION_VERSION = 1;

export const MAX_CONCURRENT_RUNS = 2;
/** 安装依赖是重 I/O 的操作，全局最多同时两个 */
export const MAX_CONCURRENT_SETUPS = 2;
export const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_RAW_LOG_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const STOP_GRACE_MS = 5000;

/** 目录树里一律不展开的目录名（构建产物 / 依赖 / 测试输出） */
export const TREE_IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.lantern-ai',
  'test-results',
  'playwright-report',
  'blob-report',
  'dist',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.DS_Store',
]);

export const RUN_STATUSES = ['running', 'passed', 'failed', 'cancelled', 'error', 'interrupted'];

const MAX_ARG_TEXT = 500;

/** @type {Map<string, RunProcess>} */
const RUNNING = new Map();

/**
 * 一键安装（项目级，key = projectId）：依赖 + 浏览器内核串行跑，日志与运行任务同款。
 * @type {Map<string, SetupProcess>}
 */
const SETUPS = new Map();

/**
 * @typedef {object} RunProcess
 * @property {import('node:child_process').ChildProcess} child
 * @property {string} projectId
 * @property {string} runId
 * @property {string} logAbs
 * @property {fs.WriteStream | null} stream
 * @property {string} log
 * @property {number} logStart
 * @property {boolean} stopping
 * @property {NodeJS.Timeout | null} killTimer
 * @property {boolean} settled
 */

/**
 * @typedef {object} SetupProcess
 * @property {import('node:child_process').ChildProcess | null} child
 * @property {string} projectId
 * @property {string} logAbs
 * @property {fs.WriteStream | null} stream
 * @property {string} log
 * @property {number} logStart
 * @property {Array<{ id: string; label: string; command: string }>} plan
 * @property {number} index
 * @property {boolean} stopping
 * @property {NodeJS.Timeout | null} killTimer
 * @property {boolean} settled
 */

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBodyLimited(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 绝对路径是否在 base 内（base 自身也算内） */
export function isPathInside(base, target) {
  const root = path.resolve(base);
  const abs = path.resolve(target);
  return abs === root || abs.startsWith(`${root}${path.sep}`);
}

/**
 * 把相对路径解析到 base 内；`../`、绝对路径、盘符逃逸一律返回空串。
 * @param {string} base
 * @param {string} rel
 * @returns {string}
 */
export function resolveInside(base, rel) {
  const raw = String(rel ?? '').replace(/\\/g, '/');
  if (raw.includes('\0')) return '';
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) return '';
  const abs = path.resolve(base, raw);
  return isPathInside(base, abs) ? abs : '';
}

export function shouldIgnoreTreeName(name) {
  return TREE_IGNORED_NAMES.has(String(name));
}

/** 项目内相对路径（POSIX），用于前端展示 */
function toPosixRel(base, abs) {
  return path.relative(base, abs).split(path.sep).join('/');
}

/** 把旧目录里的内容搬到新目录（跨卷 / 目标已存在时逐个搬，不覆盖） */
function migrateLegacyDir(legacy, target) {
  if (!legacy || !target || legacy === target || !fs.existsSync(legacy)) return;
  if (!fs.existsSync(target)) {
    try {
      fs.renameSync(legacy, target);
      return;
    } catch {
      // 跨卷等情况：走逐个搬迁
    }
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
      const from = path.join(legacy, name);
      const to = path.join(target, name);
      if (fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
      } catch {
        // 单个条目失败不影响其它条目
      }
    }
    if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
  } catch {
    // 迁移失败就继续用旧目录，不阻塞使用
  }
}

function storeDir(root) {
  return legacyStoreDir(root);
}

/** 分组目录里可能再套一层同名数据目录（`<组>/自动化测试/自动化测试`），返回真正存数据的那层 */
function pickDataDir(dir) {
  const hasStore = (d) =>
    fs.existsSync(path.join(d, UIAUTO_STORE_FILE)) ||
    fs.existsSync(path.join(d, LEGACY_STORE_FILE));
  const nested = path.join(dir, UIAUTO_DIR_NAME);
  if (!hasStore(dir) && hasStore(nested)) return nested;
  return dir;
}

/** 旧版数据目录：`自动化测试/`（也是侧栏分组名），只用于迁移 */
function legacyStoreDir(root) {
  const target = resolveContentRoot(root, UIAUTO_DIR_NAME).abs;
  const legacy = resolveContentRoot(root, LEGACY_DIR_NAME).abs;
  if (legacy === target) return pickDataDir(target);
  if (!fs.existsSync(legacy)) return pickDataDir(target);
  if (fs.existsSync(target)) {
    migrateLegacyDir(legacy, target);
    return pickDataDir(target);
  }
  // 旧目录可能已经被分组（<组>/UI自动化）：在原位改名，别把它搬出分组
  const sibling = path.join(path.dirname(legacy), UIAUTO_DIR_NAME);
  migrateLegacyDir(legacy, sibling);
  if (fs.existsSync(sibling)) return pickDataDir(sibling);
  migrateLegacyDir(legacy, target);
  return pickDataDir(target);
}

/** 内容目录：被归进侧栏分组时就在分组里；不存在就建出来（打开插件即生成两个目录） */
function contentDir(root, name) {
  const dir = resolveContentRoot(root, name).abs;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 数据文件：优先新名字，旧文件存在时顺手改名（改不动就继续读写旧的） */
function storeFilePath(dir) {
  const next = path.join(dir, UIAUTO_STORE_FILE);
  const legacy = path.join(dir, LEGACY_STORE_FILE);
  if (!fs.existsSync(next) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, next);
    } catch {
      return legacy;
    }
  }
  return next;
}

/**
 * 0.1.9 之前的单文件存储拆成两份：
 * `自动化项目/自动化项目.json`（项目记录）+ `自动化执行/自动化执行.json`（运行记录）。
 * 项目自己的报告 / 结果 / 日志目录一并搬到「自动化执行」下，历史运行链接不失效。
 */
function migrateSplitStore(root, projectsDir, runsDir) {
  const projectsFile = path.join(projectsDir, UIAUTO_PROJECTS_FILE);
  const runsFile = path.join(runsDir, UIAUTO_RUNS_FILE);
  if (fs.existsSync(projectsFile) && fs.existsSync(runsFile)) return;

  const legacyDir = storeDir(root);
  if (!legacyDir || legacyDir === projectsDir || legacyDir === runsDir) return;
  const legacyFile = storeFilePath(legacyDir);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object') return;
  const store = normalizeStore(raw);
  try {
    if (!fs.existsSync(projectsFile)) {
      writeJsonAtomic(projectsFile, { version: VERSION, projects: store.projects });
    }
    if (!fs.existsSync(runsFile)) {
      writeJsonAtomic(runsFile, { version: VERSION, runs: store.runs });
    }
  } catch {
    // 写不进去就继续用旧文件，别让迁移卡住读取
    return;
  }
  for (const project of store.projects) {
    const folder = String(project?.folder ?? '');
    if (!folder || /[\\/]/.test(folder)) continue;
    migrateLegacyDir(path.join(legacyDir, folder), path.join(runsDir, folder));
  }
  try {
    if (path.basename(legacyFile) === UIAUTO_STORE_FILE && fs.existsSync(legacyFile)) {
      // 备份放本机缓存，别让旧目录里一直挂着一个「自动化测试.json.bak」
      const backupDir = path.join(spaceLocalDir(path.resolve(root)), UIAUTO_CACHE_DIR_NAME);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(legacyFile, path.join(backupDir, `${UIAUTO_DIR_NAME}.json.bak`));
    }
  } catch {
    // 留旧文件也不影响读取
  }
  // 旧目录只剩空壳就收掉，访达 / 侧栏里不再残留一个空的「自动化测试」
  try {
    if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
  } catch {
    // 还有其它文件（历史会话 / 图标缓存）时保持原样
  }
}

function writeJsonAtomic(fp, body) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

/**
 * 存储位置：
 * - dir / runsDir：`自动化执行/`（运行记录、报告、结果、日志的相对路径基准）
 * - projectsDir：`自动化项目/`
 * - store：项目记录文件（兼容旧调用方）
 */
export function uiautoStorePaths(root) {
  const projectsDir = contentDir(root, UIAUTO_PROJECTS_DIR_NAME);
  const runsDir = contentDir(root, UIAUTO_RUNS_DIR_NAME);
  migrateSplitStore(root, projectsDir, runsDir);
  return {
    dir: runsDir,
    runsDir,
    projectsDir,
    store: path.join(projectsDir, UIAUTO_PROJECTS_FILE),
    projectsFile: path.join(projectsDir, UIAUTO_PROJECTS_FILE),
    runsFile: path.join(runsDir, UIAUTO_RUNS_FILE),
  };
}

/** 本机缓存目录（不进空间内容池）：`<空间>/.lantern/local/uiauto` */
export const UIAUTO_CACHE_DIR_NAME = 'uiauto';

/**
 * 应用图标、生成会话这类只对本机有意义、体积还不小的数据放本机缓存目录，
 * 不混在 `自动化测试/` 的项目目录里。旧版本把这些放在内容目录，首次访问时搬过来。
 */
export function uiautoCachePaths(root) {
  const dir = path.join(spaceLocalDir(path.resolve(root)), UIAUTO_CACHE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const store = storeDir(root);
  for (const name of ['app-icons', SESSIONS_DIR_NAME]) {
    migrateLegacyDir(path.join(store, name), path.join(dir, name));
  }
  // 缓存搬完，旧内容目录空了就收掉（还有别人的文件就留着）
  try {
    if (fs.existsSync(store) && fs.readdirSync(store).length === 0) fs.rmdirSync(store);
  } catch {
    // 忽略
  }
  return {
    dir,
    appIcons: path.join(dir, 'app-icons'),
    sessions: path.join(dir, SESSIONS_DIR_NAME),
  };
}

/**
 * 只接受「提示词管理」根目录下的 .md 文件名（可带一层分组目录）。
 * 提示词下拉会把项目选中的文件名带回来，这里挡住 ../ 之类的越界读取。
 */
export function isPromptFileName(name) {
  const value = String(name ?? '')
    .trim()
    .replace(/\\/g, '/');
  if (!value || value.length > 200) return false;
  if (value.startsWith('/') || value.includes('..')) return false;
  if (!/\.md$/i.test(value)) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

/** 项目名 → 目录名（去掉路径分隔符等非法字符，保持可读） */ export function sanitizeFolderName(
  name,
) {
  const base = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60);
  return base || '项目';
}

/** 同名项目自动加 id 后缀，避免两个项目写进同一个目录 */
export function uniqueFolder(store, name, id) {
  const base = sanitizeFolderName(name);
  const used = new Set((store?.projects ?? []).map((project) => project.folder).filter(Boolean));
  if (!used.has(base)) return base;
  const suffix = String(id ?? '').slice(-6) || crypto.randomBytes(3).toString('hex');
  let candidate = `${base}-${suffix}`;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}-${index}`;
    index += 1;
  }
  return candidate;
}

/**
 * 脚手架：目标目录必须不存在，或者存在但是空目录。
 * 非空目录直接拒绝——生成只建自己那套文件，不覆盖用户已有内容。
 */
export function assertScaffoldTarget(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) throw new Error('目标路径已存在且不是目录，换个项目名或父目录');
  if (fs.readdirSync(dir).length) {
    throw new Error('目标目录不是空的，换个项目名或父目录（不会覆盖已有文件）');
  }
}

/**
 * 按清单写入骨架文件，返回本次新建的文件与目录（供回滚用）。
 * 文件用 `wx` 打开，已存在的文件一律不覆盖。
 */
export function writeScaffoldFiles(targetDir, files) {
  const createdFiles = [];
  const createdDirs = [];
  const ensureDir = (abs) => {
    if (fs.existsSync(abs)) return;
    ensureDir(path.dirname(abs));
    fs.mkdirSync(abs);
    createdDirs.push(abs);
  };
  try {
    for (const file of files) {
      const abs = path.join(targetDir, file.path);
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, file.content, { encoding: 'utf8', flag: 'wx' });
      createdFiles.push(abs);
    }
  } catch (error) {
    rollbackScaffold({ createdFiles, createdDirs });
    throw error;
  }
  return { createdFiles, createdDirs };
}

/**
 * 修改项目：把渲染结果和磁盘现状对一遍，给每个文件标状态。
 *
 * - `new`：目录里还没有这个文件，直接写；
 * - `same`：内容完全一致，跳过（避免无意义的改动时间戳）；
 * - `changed`：有同名文件但内容不同，覆盖前先备份。
 */
export function planScaffoldUpdate(dir, files) {
  const root = path.resolve(dir);
  return files.map((file) => {
    const rel = String(file.path ?? '');
    const content = String(file.content ?? '');
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(`${root}${path.sep}`)) throw new Error(`骨架文件越界：${rel}`);
    let status = 'new';
    try {
      const stat = fs.statSync(abs);
      status = !stat.isFile()
        ? 'changed'
        : fs.readFileSync(abs, 'utf8') === content
          ? 'same'
          : 'changed';
    } catch {
      status = 'new';
    }
    // `.env` 是本机真实配置（可能填了账号密码）：同步只负责「缺了就补」，已有的一律保留
    if (rel === '.env' && status !== 'new') status = 'keep';
    return { path: rel, content, status };
  });
}

/**
 * 修改项目：只写有变化的文件，覆盖前把原文件按相对路径备份到 `backupDir`。
 * 中途失败按备份还原，本次新建的文件删掉，不留半套。
 */
export function writeScaffoldUpdate(dir, files, backupDir) {
  const root = path.resolve(dir);
  const createdFiles = [];
  const backedUp = [];
  const ensureDir = (abs) => {
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  };
  try {
    for (const file of files) {
      if (file.status === 'same' || file.status === 'keep') continue;
      const abs = path.resolve(root, file.path);
      if (!abs.startsWith(`${root}${path.sep}`)) throw new Error(`骨架文件越界：${file.path}`);
      ensureDir(path.dirname(abs));
      if (file.status === 'changed') {
        const target = path.join(backupDir, file.path);
        ensureDir(path.dirname(target));
        fs.copyFileSync(abs, target);
        backedUp.push({ rel: file.path, backup: target });
      } else {
        createdFiles.push(abs);
      }
      fs.writeFileSync(abs, file.content, 'utf8');
    }
  } catch (error) {
    for (const item of backedUp) {
      try {
        fs.copyFileSync(item.backup, path.resolve(root, item.rel));
      } catch {
        // 还原失败也继续处理其它文件，避免一个坏文件挡住整批回滚
      }
    }
    for (const abs of createdFiles.reverse()) {
      try {
        fs.unlinkSync(abs);
      } catch {
        // 新建的还没写成功 / 已不存在
      }
    }
    throw error;
  }
  return {
    created: files.filter((file) => file.status === 'new').length,
    changed: files.filter((file) => file.status === 'changed').length,
    same: files.filter((file) => file.status === 'same').length,
    kept: files.filter((file) => file.status === 'keep').length,
    backedUp: backedUp.map((item) => item.rel),
  };
}

/** 修改项目时沿用现有 .env.example 里的 BASE_URL，避免把配好的地址冲掉 */
export function existingScaffoldBaseURL(dir) {
  try {
    const body = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    const matched = body.match(/^\s*BASE_URL\s*=\s*(.*)$/m);
    return matched ? matched[1].trim().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

/** 逆序删除本次新建的文件与目录；只删自己建的，不碰用户已有内容 */
function rollbackScaffold({ createdFiles = [], createdDirs = [] } = {}) {
  for (const abs of [...createdFiles].reverse()) {
    try {
      fs.unlinkSync(abs);
    } catch {
      // 已经被删掉 / 没权限：继续回滚剩下的
    }
  }
  for (const abs of [...createdDirs].reverse()) {
    try {
      fs.rmdirSync(abs);
    } catch {
      // 目录里还有别人的文件就留着
    }
  }
}

/** 生成后要跑的命令：作为「一键安装」的一步执行，也用作没装时的提示 */
function scaffoldNextCommands(dir) {
  // 刚生成的项目还没有锁文件：本机装了 pnpm 就用 pnpm，否则 npm
  const { commands } = resolvePackageManager({ dir });
  return [
    { label: '安装依赖', command: commands.install, cwd: dir },
    { label: '安装浏览器内核', command: commands.browserInstall, cwd: dir },
  ];
}

/** 浏览器内核下载失败后的镜像回退源（官方 cdn.playwright.dev 会 307 到 storage.googleapis.com） */
export const PLAYWRIGHT_MIRROR_HOST = 'https://cdn.npmmirror.com/binaries/playwright';

/**
 * 下载内核时常见的网络类错误：换镜像大概率能成。
 * 只认这些特征，避免把「平台不支持 / 磁盘满」这类问题也重试一遍。
 */
const BROWSER_NETWORK_ERROR =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket disconnected|TLS connection|Download failure|fetch failed|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout/i;

/** 日志尾部像不像「下载被网络掐断」（决定要不要自动切镜像） */
export function isBrowserDownloadNetworkError(log) {
  return BROWSER_NETWORK_ERROR.test(String(log ?? ''));
}

/**
 * 浏览器内核下载失败时该不该带镜像重试一次，返回要注入的环境变量（不用重试返回空对象）。
 *
 * - 只在「安装浏览器内核」这一步重试，依赖安装失败不套用；
 * - 每一步只重试一次，避免网络彻底不通时无限循环；
 * - 用户自己设过下载源（`PLAYWRIGHT_DOWNLOAD_HOST` / `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST`）
 *   时按用户的来，不覆盖。
 * @param {{ id?: string } | null | undefined} step
 * @param {boolean} retried 这一步是否已经用镜像试过
 * @param {Record<string, string | undefined>} [env]
 */
export function browserMirrorRetryEnv(step, retried, env = process.env) {
  if (!step || step.id !== 'browser' || retried) return {};
  if (env?.PLAYWRIGHT_DOWNLOAD_HOST || env?.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST) return {};
  return { PLAYWRIGHT_DOWNLOAD_HOST: PLAYWRIGHT_MIRROR_HOST };
}

/**
 * 一键安装的步骤（纯函数，便于单测）：依赖 + 浏览器内核。
 *
 * 包管理器按项目的锁文件 → package.json 的 packageManager → 「有 pnpm 用 pnpm，没有用 npm」判定；
 * 落在 pnpm 但本机没装时退回 npm，并在 `note` 里说明。
 * 只装 chromium（项目配置里的默认内核），不跑系统级 `install-deps`。
 * @param {{ framework?: string; dir?: string; packageManager?: string }} input
 * @param {{ hasPnpm?: () => boolean, hasYarn?: () => boolean }} deps 测试注入用
 * @returns {{ steps: Array<{ id: string; label: string; command: string; cwd: string }>; error: string; packageManager: string; note: string }}
 */
export function setupPlanFor(input = {}, deps = {}) {
  const framework = text(input.framework, 40) || 'playwright';
  const dir = text(input.dir, 4096);
  if (framework !== 'playwright') {
    return {
      steps: [],
      error: '该技术栈暂不支持一键安装，请在项目目录里手动安装依赖',
      packageManager: '',
      note: '',
    };
  }
  const resolved = resolvePackageManager({ dir, declared: input.packageManager }, deps);
  const { commands } = resolved;
  return {
    steps: [
      { id: 'deps', label: '安装依赖', command: commands.install, cwd: dir },
      { id: 'browser', label: '安装浏览器内核', command: commands.browserInstall, cwd: dir },
    ],
    error: '',
    packageManager: resolved.manager,
    note: resolved.note,
  };
}

/**
 * 技术栈 → 空间里的骨架（缺文件时按内置版本补种子）。
 * 新建项目只看骨架文件，跟「提示词管理」里的提示词无关：
 * 提示词是「自动化执行」里生成用例时的引导与规范，不参与搭项目。
 * 骨架写坏了回退内置并带回错误提示，不让一个坏文件把「新建项目」堵死。
 */
function resolveScaffoldSkeleton(root, stackId) {
  const stack = findStack(stackId);
  if (!stack?.skeleton) return { skeleton: null, source: '', error: '' };
  try {
    const loaded = loadSkeleton(root, stack.skeleton);
    return { skeleton: loaded.skeleton, source: loaded.source, error: loaded.error };
  } catch (error) {
    return {
      skeleton: null,
      source: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 本次生成用哪份骨架：
 * - 没传 → 空间里那份（缺文件按内置补种子）；
 * - 传了（AI 调过 / 用户手改过）→ 就用它；写坏了让 renderScaffold 抛错，不静默换一份。
 */
function pickScaffoldSkeleton(root, stackId, provided) {
  if (provided && (typeof provided === 'string' || typeof provided === 'object')) {
    return { skeleton: provided, source: 'custom', error: '' };
  }
  return resolveScaffoldSkeleton(root, stackId);
}

/**
 * 从磁盘反推「当时勾了哪些附带内容」：老项目没有存这份记录，但文件就是证据。
 * 只看有文件级 `when` 的选项；`allure` / `webServer` 只改内容，按特征再补两条。
 */
export function detectScaffoldOptions(dir, skeleton) {
  const options = Array.isArray(skeleton?.options) ? skeleton.options : [];
  const files = Array.isArray(skeleton?.files) ? skeleton.files : [];
  const picked = [];
  let pkg = null;
  const readPkg = () => {
    if (pkg !== null) return pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      pkg = {};
    }
    return pkg;
  };
  const readRel = (rel) => {
    try {
      return fs.readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      return '';
    }
  };
  for (const option of options) {
    const id = text(option?.id, 40);
    if (!id) continue;
    const gated = files.filter((file) => String(file?.when ?? '') === id);
    if (gated.length) {
      if (gated.some((file) => fs.existsSync(path.join(dir, file.path)))) picked.push(id);
      continue;
    }
    // 没有文件级开关的选项：看内容特征，避免再同步时把它们悄悄去掉
    if (id === 'allure') {
      const deps = { ...(readPkg()?.devDependencies ?? {}), ...(readPkg()?.dependencies ?? {}) };
      const config = readRel('playwright.config.ts');
      if ('allure-playwright' in deps || /allure/i.test(config)) picked.push(id);
    }
    if (id === 'webServer') {
      const config = readRel('playwright.config.ts');
      const env = readRel('.env.example');
      if (/WEB_SERVER_COMMAND/.test(config) || /WEB_SERVER_COMMAND/.test(env)) picked.push(id);
    }
  }
  return picked;
}

/** 空间骨架的当前状态：给前端拼 AI prompt、判断「有没有被改过」 */ function readSpaceSkeleton(
  root,
  stackId,
) {
  const resolved = resolveScaffoldSkeleton(root, stackId);
  if (!resolved.skeleton) return { ok: false, error: resolved.error || '没有可用的骨架' };
  const stack = findStack(stackId);
  const id = resolved.skeleton.id;
  let raw = '';
  try {
    raw = fs.readFileSync(skeletonFile(root, id), 'utf8');
  } catch {
    raw = '';
  }
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
  let modified = false;
  try {
    const ledger = readLedger(root);
    modified = Boolean(ledger[id] && raw && ledger[id] !== digest);
  } catch {
    modified = false;
  }
  return {
    ok: true,
    id,
    stack: stack?.id ?? stackId,
    source: resolved.source,
    modified,
    raw,
    layout: resolved.skeleton.layout,
    options: resolved.skeleton.options.map((option) => option.id),
    defaultOptions: resolved.skeleton.defaultOptions,
    files: resolved.skeleton.files.length,
    promptFile: resolved.skeleton.promptFile || stack?.promptFile || '',
  };
}

/** 向导里的技术栈：选项 / 提示词以空间骨架为准（用户可以改骨架扩选项） */
function scaffoldStackViews(root) {
  return listStacks().map((stack) => {
    if (!stack.skeleton) return stack;
    const loaded = resolveScaffoldSkeleton(root, stack.id);
    return applySkeletonToStack(stack, loaded.skeleton, loaded.source);
  });
}

/** 项目在空间里的存放目录：自动化执行/<项目名>/{报告,结果,日志} */
export function projectPaths(root, project) {
  const base = uiautoStorePaths(root);
  const raw = project?.folder ? String(project.folder) : '';
  const folder =
    raw && !/[\\/]/.test(raw) && raw !== '.' && raw !== '..'
      ? raw
      : sanitizeFolderName(project?.name || project?.id || '项目');
  const dir = path.join(base.dir, folder);
  return {
    dir,
    folder,
    reportDir: path.join(dir, REPORT_DIR_NAME),
    resultDir: path.join(dir, RESULT_DIR_NAME),
    logDir: path.join(dir, LOG_DIR_NAME),
    generationDir: path.join(dir, GENERATION_DIR_NAME),
    generationFile: path.join(dir, GENERATION_DIR_NAME, GENERATION_FILE_NAME),
  };
}

/**
 * 新建项目的生成过程留档：只保留最近一次（重新生成覆盖）。
 * 放在项目自己的目录里，跟报告 / 日志在一起，换机器后随空间一起走。
 */
export function generationRecordPath(root, project) {
  return projectPaths(root, project).generationFile;
}

export function readGenerationRecord(root, project) {
  try {
    const file = generationRecordPath(root, project);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeGenerationRecord(raw);
  } catch {
    return null;
  }
}

function writeGenerationRecord(root, project, record) {
  const normalized = normalizeGenerationRecord(record);
  if (!normalized) return false;
  try {
    writeJsonAtomic(generationRecordPath(root, project), normalized);
    return true;
  } catch {
    return false;
  }
}

const MAX_RECORD_LOG_ENTRIES = 2000;
const MAX_RECORD_LOG_TEXT = 4000;
const MAX_RECORD_LOG_DETAIL = 8000;
const MAX_RECORD_RAW_CHARS = 200 * 1024;
const MAX_RECORD_FINDINGS = 500;
const MAX_RECORD_PATCHES = 200;
const MAX_RECORD_FILES = 5000;

/**
 * 生成过程记录：前端把检查日志 / 建议 / 原始输出一起交上来，这里只做清洗与截断，
 * 避免一个超长模型输出把项目 JSON 撑爆（单条日志 4KB、raw 200KB、文件 5000 条）。
 */
export function normalizeGenerationRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const record = {
    version: GENERATION_VERSION,
    at: text(raw.at, 40) || new Date().toISOString(),
    stack: text(raw.stack, 40),
    name: text(raw.name, 200),
    dir: text(raw.dir, 4096),
    skeleton: text(raw.skeleton, 200),
    skeletonSource: ['space', 'builtin', 'custom'].includes(raw.skeletonSource)
      ? raw.skeletonSource
      : '',
    promptFile: text(raw.promptFile, 200),
    layout:
      raw.layout && typeof raw.layout === 'object'
        ? Object.fromEntries(
            Object.entries(raw.layout)
              .slice(0, 40)
              .map(([key, value]) => [text(key, 60), text(value, 300)]),
          )
        : {},
    files: Array.isArray(raw.files)
      ? raw.files
          .map((file) => {
            if (!file || typeof file !== 'object') return null;
            const filePath = text(file.path, 1024);
            if (!filePath) return null;
            return { path: filePath, bytes: intOr(file.bytes, 0, 0, Number.MAX_SAFE_INTEGER) };
          })
          .filter(Boolean)
          .slice(0, MAX_RECORD_FILES)
      : [],
    totalBytes: intOr(raw.totalBytes, 0, 0, Number.MAX_SAFE_INTEGER),
    logs: Array.isArray(raw.logs)
      ? raw.logs
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const message = text(entry.text, MAX_RECORD_LOG_TEXT);
            if (!message) return null;
            const detail = text(entry.detail, MAX_RECORD_LOG_DETAIL);
            return {
              seq: intOr(entry.seq, 0, 0, Number.MAX_SAFE_INTEGER),
              at: intOr(entry.at, 0, 0, Number.MAX_SAFE_INTEGER),
              stage: text(entry.stage, 40),
              level: ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
              text: message,
              ...(detail ? { detail } : {}),
            };
          })
          .filter(Boolean)
          .slice(-MAX_RECORD_LOG_ENTRIES)
      : [],
    findings: Array.isArray(raw.findings)
      ? raw.findings
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const title = text(item.title, 400);
            if (!title) return null;
            const patches = Array.isArray(item.patches)
              ? item.patches
                  .map((patch) => {
                    if (!patch || typeof patch !== 'object') return null;
                    const action = text(patch.action, 40);
                    if (!action) return null;
                    return {
                      action,
                      path: text(patch.path, 1024),
                      ...(['addFile', 'replaceFile'].includes(action)
                        ? { bytes: Buffer.byteLength(String(patch.content ?? ''), 'utf8') }
                        : {}),
                    };
                  })
                  .filter(Boolean)
                  .slice(0, MAX_RECORD_PATCHES)
              : [];
            return {
              id: text(item.id, 120),
              level: ['error', 'warn', 'info'].includes(item.level) ? item.level : 'info',
              title,
              detail: text(item.detail, MAX_RECORD_LOG_DETAIL),
              file: text(item.file, 1024),
              source: item.source === 'model' ? 'model' : 'platform',
              patches,
            };
          })
          .filter(Boolean)
          .slice(0, MAX_RECORD_FINDINGS)
      : [],
    applied: Array.isArray(raw.applied)
      ? raw.applied
          .map((id) => text(id, 120))
          .filter(Boolean)
          .slice(0, MAX_RECORD_FINDINGS)
      : [],
    promptReady: raw.promptReady === true,
    ok: raw.ok === true,
    error: text(raw.error, 2000),
    raw: text(raw.raw, MAX_RECORD_RAW_CHARS),
    stats:
      raw.stats && typeof raw.stats === 'object'
        ? {
            ms: intOr(raw.stats.ms, 0, 0, Number.MAX_SAFE_INTEGER),
            firstTokenMs: intOr(raw.stats.firstTokenMs, 0, 0, Number.MAX_SAFE_INTEGER),
            chars: intOr(raw.stats.chars, 0, 0, Number.MAX_SAFE_INTEGER),
            beats: intOr(raw.stats.beats, 0, 0, Number.MAX_SAFE_INTEGER),
            model: text(raw.stats.model, 200),
          }
        : null,
  };
  return record;
}

function emptyStore() {
  return { version: VERSION, projects: [], runs: [] };
}

function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const dir = text(raw.dir, 4096);
  if (!dir) return null;
  const name = text(raw.name, 200) || path.basename(dir);
  return {
    id: text(raw.id, 64) || `uia_${crypto.randomBytes(8).toString('hex')}`,
    name,
    // 存放目录在创建时定下，之后改项目名也不换目录（历史报告路径不失效）
    folder: text(raw.folder, 100) || sanitizeFolderName(name),
    dir,
    // 老数据没有 framework：一律按 Playwright 处理，不做批量迁移
    framework: ADAPTER_IDS.includes(raw.framework) ? raw.framework : 'playwright',
    createdAt: text(raw.createdAt, 40) || new Date().toISOString(),
    lastRunId: text(raw.lastRunId, 64),
    lastRunAt: text(raw.lastRunAt, 40),
    lastStatus: RUN_STATUSES.includes(raw.lastStatus) ? raw.lastStatus : '',
    // 用户自己添加的运行命令（存在项目记录里，跟着空间走）
    customTasks: normalizeCustomTasks(raw.customTasks),
    // 对自动发现任务的改动 / 删除：只存差异，扫描结果变了也不影响
    taskOverrides: normalizeTaskOverrides(raw.taskOverrides),
    hiddenTasks: normalizeHiddenTaskIds(raw.hiddenTasks),
    // 被测应用起始地址（含 /admin 这类路由后缀）：用户改过一次就按项目记住，
    // 下次进生成页自动带出来；留空时读项目自己的 playwright 配置 / .env
    baseURL: text(raw.baseURL, 500),
    // 该项目的登录态文件（相对项目根）：按项目记，换项目不会串味；
    // 留空时自动探测项目里的 auth*.json / .auth/ 等
    storageState: text(raw.storageState, 300),
    // 该项目用哪份提示词（提示词管理里的文件名）：不同框架可以挂不同提示词
    promptFile: text(raw.promptFile, 200),
    // 默认环境名（.env.<ENV>）：运行面板下拉的初始值，空串表示 `.env`（各环境共用）
    envName: sanitizeEnvName(raw.envName),
    // 项目来源：mount 挂载已有目录 / scaffold 由「新建项目」生成
    source: raw.source === 'scaffold' ? 'scaffold' : 'mount',
    scaffold: normalizeScaffoldInfo(raw.scaffold),
    // 一键安装依赖的最近一次结果（老数据没有 = idle）
    setup: normalizeSetup(raw.setup),
  };
}

/** 安装状态的合法值 */
export const SETUP_STATUSES = ['idle', 'running', 'done', 'failed', 'stopped', 'interrupted'];
const STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'];

export function emptySetup() {
  return {
    status: 'idle',
    startedAt: '',
    finishedAt: '',
    exitCode: null,
    logRel: '',
    error: '',
    steps: [],
  };
}

function normalizeSetup(raw) {
  const base = emptySetup();
  if (!raw || typeof raw !== 'object') return base;
  base.status = SETUP_STATUSES.includes(raw.status) ? raw.status : 'idle';
  base.startedAt = text(raw.startedAt, 40);
  base.finishedAt = text(raw.finishedAt, 40);
  base.exitCode = Number.isFinite(raw.exitCode) ? raw.exitCode : null;
  base.logRel = text(raw.logRel, 1024);
  base.error = text(raw.error, 2000);
  base.steps = Array.isArray(raw.steps)
    ? raw.steps
        .map((step) => {
          if (!step || typeof step !== 'object') return null;
          const id = text(step.id, 40);
          if (!id) return null;
          return {
            id,
            label: text(step.label, 100),
            command: text(step.command, 1000),
            status: STEP_STATUSES.includes(step.status) ? step.status : 'pending',
            startedAt: text(step.startedAt, 40),
            finishedAt: text(step.finishedAt, 40),
            exitCode: Number.isFinite(step.exitCode) ? step.exitCode : null,
          };
        })
        .filter(Boolean)
        .slice(0, 20)
    : [];
  return base;
}

function normalizeScaffoldInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stack = text(raw.stack, 40);
  if (!stack) return null;
  // 上次同步 / 生成时勾的附带内容：再进「骨架同步」时按它回显，不用猜
  const options = Array.isArray(raw.options)
    ? [...new Set(raw.options.map((item) => String(item ?? '').trim()).filter(Boolean))].slice(
        0,
        20,
      )
    : [];
  return { stack, at: text(raw.at, 40), options };
}

function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.id, 64);
  const projectId = text(raw.projectId, 64);
  if (!id || !projectId) return null;
  const status = RUN_STATUSES.includes(raw.status) ? raw.status : 'error';
  return {
    id,
    projectId,
    framework: ADAPTER_IDS.includes(raw.framework) ? raw.framework : 'playwright',
    startedAt: text(raw.startedAt, 40),
    finishedAt: text(raw.finishedAt, 40),
    status,
    exitCode: Number.isFinite(raw.exitCode) ? raw.exitCode : null,
    durationMs: intOr(raw.durationMs, 0, 0, Number.MAX_SAFE_INTEGER),
    total: intOr(raw.total, 0, 0, 1_000_000),
    passed: intOr(raw.passed, 0, 0, 1_000_000),
    failed: intOr(raw.failed, 0, 0, 1_000_000),
    skipped: intOr(raw.skipped, 0, 0, 1_000_000),
    flaky: intOr(raw.flaky, 0, 0, 1_000_000),
    args: normalizeRunArgs(raw.args),
    // 这一次实际执行的命令行（任务运行才有），历史里直接显示
    command: text(raw.command, 1000),
    taskId: text(raw.taskId, 64),
    taskLabel: text(raw.taskLabel, 200),
    projectNames: Array.isArray(raw.projectNames)
      ? raw.projectNames
          .map((name) => text(name, 100))
          .filter(Boolean)
          .slice(0, 50)
      : [],
    reportRel: text(raw.reportRel, 1024),
    // Allure 静态报告快照目录 + 「有原始结果、可以 generate」标记
    allureRel: text(raw.allureRel, 1024),
    allureResults: raw.allureResults === true,
    resultRel: text(raw.resultRel, 1024),
    logRel: text(raw.logRel, 1024),
    error: text(raw.error, 4000),
  };
}

function normalizeRunArgs(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    file: text(source.file, 1024),
    grep: text(source.grep, MAX_ARG_TEXT),
    // 老数据里叫 browser，读取时兼容；新写入统一用 project（Playwright config 里的项目名）
    project: text(source.project, 100) || text(source.browser, 100),
    headed: source.headed === true,
    workers: intOr(source.workers, 0, 0, 32),
    lastFailed: source.lastFailed === true,
    // 遇到第一个失败就停（Playwright --max-failures=1 / pytest -x）
    bail: source.bail === true,
    // pytest 专属：-m 标记表达式与 --maxfail
    marker: text(source.marker, 200),
    maxFail: intOr(source.maxFail, 0, 0, 10_000),
  };
}

function normalizeStore(raw) {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  base.projects = Array.isArray(raw.projects)
    ? raw.projects.map(normalizeProject).filter(Boolean)
    : [];
  base.runs = Array.isArray(raw.runs) ? raw.runs.map(normalizeRun).filter(Boolean) : [];
  return base;
}

function readStore(root) {
  const paths = uiautoStorePaths(root);
  const store = emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(paths.projectsFile, 'utf8'));
    store.projects = Array.isArray(raw?.projects)
      ? raw.projects.map(normalizeProject).filter(Boolean)
      : [];
  } catch {
    store.projects = [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(paths.runsFile, 'utf8'));
    store.runs = Array.isArray(raw?.runs) ? raw.runs.map(normalizeRun).filter(Boolean) : [];
  } catch {
    store.runs = [];
  }
  const result = reconcileStore(store, root);
  // 迁移 / 收敛会改记录：立刻写回，避免文件已搬走而记录还指向旧路径
  if (result.dirty) {
    try {
      writeStore(root, store);
    } catch {
      // 写失败不影响本次读取
    }
  }
  return result;
}

/**
 * 0.1.9 的运行产物平铺在 `报告/<runId>`、`结果/…`、`日志/…`；
 * 新版改成按项目分目录。读取时顺手搬过去，老记录的报告链接不会失效。
 * 来源是旧版数据目录（`自动化测试/`），目标在 `自动化执行/<项目名>/`。
 */
function migrateLegacyRunArtifacts(root, store) {
  const legacyDir = storeDir(root);
  const paths = uiautoStorePaths(root);
  if (!legacyDir || legacyDir === paths.runsDir || !fs.existsSync(legacyDir)) return false;
  const dirs = new Set([REPORT_DIR_NAME, RESULT_DIR_NAME, LOG_DIR_NAME]);
  let changed = false;
  const move = (fromAbs, toAbs) => {
    if (fs.existsSync(toAbs)) return true;
    try {
      fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      fs.renameSync(fromAbs, toAbs);
      return true;
    } catch {
      return false;
    }
  };

  for (const run of store.runs) {
    const project = findProject(store, run.projectId);
    if (!project) continue;
    const pp = projectPaths(root, project);
    for (const key of ['reportRel', 'resultRel', 'logRel']) {
      const rel = run[key];
      if (!rel) continue;
      const abs = path.join(legacyDir, rel);
      if (!isPathInside(legacyDir, abs)) continue;
      const parts = path.relative(legacyDir, abs).split(path.sep);
      if (parts[0] === pp.folder) continue; // 已经在项目目录里
      const nextAbs = path.join(pp.dir, ...parts);
      if (!fs.existsSync(abs)) {
        // 文件可能已经搬走但记录没来得及写回：按新位置修正记录
        if (fs.existsSync(nextAbs)) {
          run[key] = toPosixRel(paths.dir, nextAbs);
          changed = true;
        }
        continue;
      }
      if (!dirs.has(parts[0])) continue;
      if (!move(abs, nextAbs)) continue;
      run[key] = toPosixRel(paths.dir, nextAbs);
      changed = true;
      // surefire 结果目录跟着走，避免留下孤儿目录
      if (key === 'resultRel') {
        const oldSf = path.join(path.dirname(abs), `${run.id}-surefire`);
        if (fs.existsSync(oldSf)) {
          move(oldSf, path.join(path.dirname(nextAbs), `${run.id}-surefire`));
        }
      }
    }
  }
  // 平铺的旧目录不管有没有搬东西，空了就删掉（0.1.9 每次运行都会预建这三个目录）
  for (const name of dirs) {
    const abs = path.join(legacyDir, name);
    try {
      if (fs.statSync(abs).isDirectory() && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch {
      // ignore
    }
  }
  return changed;
}

/** 服务重启后内存里没有对应进程的 running，一定是上次异常退出留下的 */
function reconcileStore(store, root) {
  let dirty = false;
  if (root && migrateLegacyRunArtifacts(root, store)) dirty = true;
  for (const run of store.runs) {
    if (run.status !== 'running' || RUNNING.has(run.id)) continue;
    run.status = 'interrupted';
    run.finishedAt = run.finishedAt || new Date().toISOString();
    run.error = run.error || '服务已重启，本次运行被中断';
    dirty = true;
  }
  // 安装记录同理：内存里没有对应进程的 running 一定是重启前留下的
  for (const project of store.projects) {
    const setup = normalizeSetup(project.setup);
    if (setup.status !== 'running' || SETUPS.has(project.id)) continue;
    setup.status = 'interrupted';
    setup.finishedAt = setup.finishedAt || new Date().toISOString();
    setup.error = setup.error || '服务已重启，本次安装被中断';
    if (setup.steps.some((step) => step.status === 'running')) {
      setup.steps = setup.steps.map((step) =>
        step.status === 'running' ? { ...step, status: 'failed' } : step,
      );
    }
    project.setup = setup;
    dirty = true;
  }
  // 老项目没记 promptFile：空间里已经有默认提示词就补上，生成页不用每次手选
  if (root) {
    // 旧名（Playwright提示词.md）先就地改名，再按新名判断有没有提示词
    try {
      migrateLegacyPluginPrompts(root);
    } catch {
      // 改名失败就按现状判断，下次启动再试
    }
    const hasPrompt = fs.existsSync(pluginPromptPath(UI_AUTO_PROMPT_FILE, root));
    for (const project of store.projects) {
      const current = String(project.promptFile ?? '').trim();
      // 项目记录里还写着旧名 → 跟着改名，别让「挂载的提示词」凭空消失
      if (current === 'Playwright提示词.md') {
        project.promptFile = UI_AUTO_PROMPT_FILE;
        dirty = true;
        continue;
      }
      if (current || !hasPrompt) continue;
      project.promptFile = UI_AUTO_PROMPT_FILE;
      dirty = true;
    }
  }
  return { store, dirty };
}

function writeStore(root, store) {
  const paths = uiautoStorePaths(root);
  writeJsonAtomic(paths.projectsFile, {
    version: VERSION,
    projects: store.projects ?? [],
  });
  writeJsonAtomic(paths.runsFile, { version: VERSION, runs: store.runs ?? [] });
}

function readStoreForWrite(root) {
  const { store } = readStore(root);
  return store;
}

function findProject(store, projectId) {
  return store.projects.find((p) => p.id === projectId) ?? null;
}

function findRun(store, runId) {
  return store.runs.find((r) => r.id === runId) ?? null;
}

/**
 * 运行方式：同一批测试项目跑法不一样（Playwright CLI / pytest / Maven / Gradle / npm test），
 * 页面上直接展示这条，不用让人猜「运行」会执行什么。
 */
function runnerLabel(probe, picked) {
  if (!picked) return '';
  if (picked.id === 'playwright') return 'Playwright Test';
  // 用真实的解释器路径，和「运行任务」下拉里的命令保持一致
  if (picked.id === 'pytest') return detectPythonCommand(probe.dir);
  if (picked.id === 'selenium') {
    if (probe.hasPom) return 'Maven · mvn test';
    if (probe.hasGradle) return 'Gradle · gradle test';
    if (probe.pkg) return 'npm test';
  }
  return picked.label;
}

/** 目录状态：是否存在、识别成哪个框架、能不能跑 */
export function detectProject(dir, frameworkId = '') {
  const probe = buildProbe(dir);
  if (!probe.exists) {
    return {
      exists: false,
      framework: frameworkId,
      frameworkLabel: '',
      kind: '',
      runner: '',
      candidates: [],
      controls: [],
      specFiles: [],
      frameworkReady: false,
      readyHint: '',
      mountable: false,
      packageManager: '',
    };
  }
  const candidates = detectCandidates(probe);
  const forced = frameworkId && ADAPTER_IDS.includes(frameworkId) ? frameworkId : '';
  const forcedAdapter = forced ? getAdapter(forced) : null;
  const matched = forced ? candidates.find((item) => item.id === forced) : null;
  const picked = forced
    ? (matched ?? {
        id: forced,
        label: forcedAdapter?.label ?? forced,
        kind: forcedAdapter?.kind ?? '',
        score: 0,
        evidence: [],
        controls: forcedAdapter?.controls ?? [],
        ready: Boolean(forcedAdapter?.ready?.(probe)),
      })
    : candidates[0];
  const adapter = picked ? getAdapter(picked.id) : null;
  return {
    exists: true,
    framework: picked?.id ?? '',
    frameworkLabel: picked?.label ?? '',
    kind: picked?.kind ?? '',
    runner: runnerLabel(probe, picked),
    controls: picked?.controls ?? [],
    frameworkReady: picked ? picked.ready : false,
    readyHint: adapter ? text(adapter.readyHint?.(probe), 500) : '',
    candidates,
    packageManager: probe.packageManager,
    // 手动指定框架时以「能不能跑」为准，避免用户改选后立刻被识别结果顶回去
    mountable: forced
      ? Boolean(picked && (picked.score >= MIN_DETECT_SCORE || picked.ready))
      : Boolean(picked && picked.score >= MIN_DETECT_SCORE),
  };
}

/** 框架下拉的可选项（Playwright / pytest / Selenium） */
export function frameworkOptions() {
  return adapterOptions();
}

function decorateProject(project, root) {
  const health = detectProject(project.dir, project.framework);
  const running = [...RUNNING.values()].find((entry) => entry.projectId === project.id);
  const settingUp = SETUPS.get(project.id);
  const customTasks = normalizeCustomTasks(project.customTasks);
  const probe = health.exists ? buildProbe(project.dir) : null;
  const setup = normalizeSetup(project.setup);
  const plan = setupPlanFor({
    framework: project.framework,
    dir: project.dir,
    packageManager: probe?.packageManager ?? '',
  });
  // 装到一半进程还没起来 / 进程没了但记录还是 running：一律按「正在装」展示
  if (settingUp) setup.status = 'running';
  // 自动发现 → 套上用户在运行配置里改过的名称 / 命令。
  // 被忽略的命令只从「运行任务」下拉里消失，仍然随项目返回（`ignoredTasks`），
  // 运行配置里排在列表最后，点一下就能恢复。
  const allDetected = probe
    ? applyTaskOverrides(discoverRunTasks(probe, project.framework), project.taskOverrides, [])
    : [];
  const hiddenSet = new Set(project.hiddenTasks);
  const detected = allDetected.filter((task) => !hiddenSet.has(task.id));
  const ignoredTasks = allDetected.filter((task) => hiddenSet.has(task.id));
  // 「全量运行」固定排第一，后面是项目自带任务与用户自己加的命令
  const fullTask = {
    id: 'full',
    label: '全量运行',
    display: '全量运行',
    hint: health.runner || '',
    kind: 'full',
    // Selenium 的 mvn / gradle 没有稳定的「只跑失败」开关，只给全量
    failureFlags: project.framework !== 'selenium',
    custom: false,
    command: health.runner || '',
  };
  return {
    ...project,
    customTasks,
    ...health,
    // 生成页起始地址：项目上记的优先，其次读项目配置（playwright use.baseURL / .env）
    baseURL: project.baseURL || '',
    detectedBaseURL: health.exists ? safeDetectBaseURL(project.dir) : '',
    // 登录态同理：项目上记的优先，其次读项目里的登录态文件（换项目要重新识别）
    storageState: project.storageState || '',
    detectedStorageState: health.exists ? safeDetectStorageState(project.dir) : '',
    // 环境面板的入口条件：Playwright 且项目按 .env.<ENV> 约定做的
    envName: project.envName || '',
    hasEnvConvention:
      health.exists && project.framework === 'playwright'
        ? safeHasEnvConvention(project.dir)
        : false,
    // 项目里已有的环境文件（不含 .env.example）：运行面板的 ENV 下拉直接用
    envFiles:
      health.exists && project.framework === 'playwright'
        ? scanEnvFiles(project.dir).map((item) => item.env)
        : [],
    runTasks: [fullTask, ...detected.map(taskView), ...customToTasks(customTasks).map(taskView)],
    // 被忽略的自动发现命令：不进下拉，只在运行配置里排在最后给「恢复」
    ignoredTasks: ignoredTasks.map((task) => ({ ...taskView(task), ignored: true })),
    runningRunId: running ? running.runId : '',
    // 一键安装：支持的技术栈给步骤清单，前端没跑过也能先展示两行命令
    setupPlan: plan.steps,
    // 命中的包管理器（pnpm 优先，本机没装退回 npm 时 note 里会写明原因）
    setupPackageManager: plan.packageManager || '',
    setupNote: plan.note || '',
    setup,
    setupSupported: !plan.error,
    // 有没有生成过程留档（老项目 / 手动挂载的没有）
    hasGenerationRecord: health.exists ? fs.existsSync(generationRecordPath(root, project)) : false,
    // 骨架同步回显：上次勾的附带内容与写进 .env.example 的地址
    scaffoldOptions: health.exists
      ? project.scaffold?.options?.length
        ? project.scaffold.options
        : safeDetectScaffoldOptions(root, project)
      : (project.scaffold?.options ?? []),
    scaffoldBaseURL: health.exists ? safeExistingScaffoldBaseURL(project.dir) : '',
  };
}

/** 读不到骨架 / 目录时按「没有勾」处理，不挡项目列表 */
function safeDetectScaffoldOptions(root, project) {
  if (project.source !== 'scaffold') return [];
  try {
    const resolved = resolveScaffoldSkeleton(root, project.framework);
    if (!resolved.skeleton) return [];
    return detectScaffoldOptions(project.dir, resolved.skeleton);
  } catch {
    return [];
  }
}

function safeExistingScaffoldBaseURL(dir) {
  try {
    return existingScaffoldBaseURL(dir);
  } catch {
    return '';
  }
}

/** 探测地址失败不能把「项目列表」一起拖垮：读不到就返回空串 */
function safeDetectBaseURL(dir) {
  try {
    return detectBaseURL(dir);
  } catch {
    return '';
  }
}

/** 登录态探测同理：目录读不了就当没有 */
function safeDetectStorageState(dir) {
  try {
    return detectStorageState(dir);
  } catch {
    return '';
  }
}

/** 环境约定探测：读不到 package.json 就当没有 */
function safeHasEnvConvention(dir) {
  try {
    return hasEnvConvention(dir);
  } catch {
    return false;
  }
}

/** 该项目最近一次运行解析到的 Playwright 项目名（setup / chromium-login …） */
function latestProjectNames(store, projectId) {
  const runs = store.runs
    .filter((run) => run.projectId === projectId && run.projectNames.length)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return runs[0]?.projectNames ?? [];
}

/** 把相对文件路径清成项目内的 POSIX 路径；越界返回空串 */
export function normalizeRunFile(base, file) {
  const raw = text(file, 1024).replace(/\\/g, '/');
  if (!raw) return '';
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.split('/').includes('..')) return '';
  const abs = resolveInside(base, raw);
  if (!abs) return '';
  try {
    if (!fs.statSync(abs).isFile()) return '';
  } catch {
    return '';
  }
  return raw.replace(/^\.\//, '');
}

function appendLog(entry, chunk) {
  const value = String(chunk ?? '');
  if (!value) return;
  entry.log += value;
  if (entry.log.length > MAX_RAW_LOG_BYTES) {
    const drop = entry.log.length - MAX_RAW_LOG_BYTES;
    entry.log = entry.log.slice(drop);
    entry.logStart += drop;
  }
  if (entry.stream) {
    try {
      entry.stream.write(value);
    } catch {
      // 写盘失败不影响运行
    }
  }
}

function killRun(entry, signal) {
  // 一键安装在两步之间没有子进程：此时停止只需改状态，不用发信号
  const pid = entry.child?.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      if (signal === 'SIGKILL') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        entry.child?.kill();
      }
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      entry.child?.kill(signal);
    } catch {
      // 已经退出
    }
  }
}

/** 结果文件的后缀：JSON 交给适配器自己解析，pytest / selenium 用 XML */
function resultFileName(runId, adapter) {
  return `${runId}${adapter.id === 'playwright' ? '.json' : '.xml'}`;
}

function finishRun(root, entry, runId, exitCode, spawnError) {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.killTimer) clearTimeout(entry.killTimer);
  RUNNING.delete(runId);
  if (entry.stream) {
    try {
      entry.stream.end();
    } catch {
      // ignore
    }
    entry.stream = null;
  }

  const paths = uiautoStorePaths(root);
  const store = readStoreForWrite(root);
  const run = findRun(store, runId);
  if (!run) return;

  const project = findProject(store, run.projectId);
  const adapter = getAdapter(run.framework) ?? getAdapter('playwright');
  const probe = project ? buildProbe(project.dir) : null;
  const pp = project ? projectPaths(root, project) : null;
  const resultAbs = run.resultRel ? path.join(paths.dir, run.resultRel) : '';
  const reportAbs = pp
    ? path.join(pp.reportDir, runId)
    : run.reportRel
      ? path.join(paths.dir, run.reportRel)
      : '';
  const ctx = {
    dir: project?.dir ?? '',
    probe,
    runId,
    startedAt: run.startedAt,
    exitCode,
    log: entry.log,
    resultAbs,
    resultDirAbs: pp ? pp.resultDir : path.dirname(resultAbs),
    reportAbs,
  };

  let summary = emptySummary();
  try {
    summary = adapter.parse?.(ctx) ?? summary;
  } catch {
    summary = emptySummary();
  }

  // 报告快照：项目里的 HTML 报告复制一份到空间（按项目分目录），历史记录不会被下次运行覆盖
  let reportRel = '';
  if (ctx.reportAbs && !entry.stopping && project && probe) {
    try {
      const dirs = adapter.reportDirs?.(probe) ?? [];
      if (dirs.length) {
        snapshotReport({
          projectDir: project.dir,
          candidates: dirs,
          destAbs: ctx.reportAbs,
          // 本次运行开始前的旧报告不复制，避免「这次没生成报告却显示上次的」
          minMtime: (Date.parse(run.startedAt) || 0) - 1000,
        });
      }
    } catch {
      // 快照失败不影响结果
    }
  }
  if (ctx.reportAbs && hasReportEntry(ctx.reportAbs)) {
    reportRel = toPosixRel(paths.dir, ctx.reportAbs);
  }

  // Allure 报告：项目里生成过 `allure generate` 的静态页时，也留一份快照（放 <报告>/allure）。
  // 不按 mtime 过滤：Allure 通常是跑完再手动 generate，时间戳本来就可能晚于 / 早于这次运行。
  let allureRel = '';
  let allureResults = false;
  if (ctx.reportAbs && project && probe) {
    try {
      const dirs = adapter.allureDirs?.(probe) ?? { report: [], results: [] };
      const dest = path.join(ctx.reportAbs, 'allure');
      if (dirs.report.length) {
        snapshotReport({ projectDir: project.dir, candidates: dirs.report, destAbs: dest });
        if (hasReportEntry(dest)) allureRel = toPosixRel(paths.dir, dest);
      }
      // 只有原始结果、还没 generate：界面给一个「生成 Allure 报告」入口
      allureResults = dirs.results.some((rel) => hasFilesInside(path.resolve(project.dir, rel)));
      if (!reportRel && allureRel) reportRel = toPosixRel(paths.dir, ctx.reportAbs);
    } catch {
      // 快照失败不影响结果
    }
  }

  const finishedAt = new Date().toISOString();
  const started = Date.parse(run.startedAt);
  const durationMs = summary.durationMs || (Number.isFinite(started) ? Date.now() - started : 0);

  let status;
  if (entry.stopping) status = 'cancelled';
  else if (spawnError) status = 'error';
  else if (exitCode === 0) status = 'passed';
  else status = 'failed';

  let error = '';
  if (spawnError) error = text(spawnError, 4000);
  else if (summary.errors.length) error = summary.errors.join('\n').slice(0, 4000);
  else if (status === 'failed' && summary.total === 0) {
    const hint = text(adapter.hintFromLog?.(entry.log), 1000);
    const tail = entry.log.slice(-1200).trim();
    error = hint || tail;
  }

  run.status = status;
  run.exitCode = exitCode;
  run.finishedAt = finishedAt;
  run.durationMs = durationMs;
  run.total = summary.total;
  run.passed = summary.passed;
  run.failed = summary.failed;
  run.skipped = summary.skipped;
  run.flaky = summary.flaky;
  if (summary.projectNames.length) run.projectNames = summary.projectNames;
  run.reportRel = reportRel;
  run.allureRel = allureRel;
  run.allureResults = allureResults;
  run.error = error;

  if (project) {
    project.lastRunId = run.id;
    project.lastRunAt = run.startedAt;
    project.lastStatus = run.status;
  }
  writeStore(root, store);
}

function runView(run) {
  return {
    ...run,
    reportUrl: run.reportRel ? `${PREFIX}/report/${encodeURIComponent(run.id)}/` : '',
    // Allure 快照放在 Playwright 报告同级的 allure/ 下，走同一个静态路由
    allureUrl: run.allureRel ? `${PREFIX}/report/${encodeURIComponent(run.id)}/allure/` : '',
    logUrl: run.logRel ? `${PREFIX}/run?id=${encodeURIComponent(run.id)}` : '',
  };
}

function startRun(root, body) {
  const store = readStoreForWrite(root);
  const projectId = text(body?.projectId, 64);
  const project = findProject(store, projectId);
  if (!project) return { error: '项目不存在', status: 404 };

  const adapter = getAdapter(project.framework);
  if (!adapter) return { error: `不支持的框架：${project.framework}`, status: 400 };

  const probe = buildProbe(project.dir);
  if (!probe.exists) return { error: '项目目录不存在，请重新选择目录', status: 400 };
  const health = detectProject(project.dir, project.framework);
  if (!health.mountable) {
    return { error: '没有识别到该目录的测试框架，请重新识别或换个目录', status: 400 };
  }
  if (!health.frameworkReady) {
    return { error: health.readyHint || '运行环境未就绪', status: 400 };
  }

  for (const entry of RUNNING.values()) {
    if (entry.projectId === projectId) {
      return { error: '该项目已有运行中的任务，请等待结束或先停止', status: 409 };
    }
  }
  if (RUNNING.size >= MAX_CONCURRENT_RUNS) {
    return { error: `全局最多同时运行 ${MAX_CONCURRENT_RUNS} 个项目，请稍后再试`, status: 409 };
  }

  const args = normalizeRunArgs({
    ...body,
    project: project.framework === 'playwright' ? body?.project : '',
  });
  if (args.file) {
    const file = normalizeRunFile(project.dir, args.file);
    if (!file) return { error: '指定的测试文件不在项目目录内或不存在', status: 400 };
    args.file = file;
  }

  // 运行任务：`full` 走框架默认命令（沿用适配器），其余从项目任务 + 自定义命令里找
  const taskId = text(body?.taskId, 64) || 'full';
  const customTasks = normalizeCustomTasks(project.customTasks);
  const task =
    taskId === 'full'
      ? null
      : [
          ...applyTaskOverrides(
            discoverRunTasks(probe, project.framework),
            project.taskOverrides,
            project.hiddenTasks,
          ),
          ...customToTasks(customTasks),
        ].find((item) => item.id === taskId);
  if (taskId !== 'full' && !task) {
    return { error: '这条运行任务已不存在，请刷新后重新选择', status: 404 };
  }

  const runId = `uar_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const paths = uiautoStorePaths(root);
  // 环境：面板显式传的优先，其次项目记住的默认值；空串表示 `.env`（不传 ENV，由框架兜底）
  const runEnv = sanitizeEnvName(body?.env) || project.envName || '';
  // 按项目分目录：自动化测试/<项目名>/{报告,结果,日志}
  const pp = projectPaths(root, project);
  const reportAbs = path.join(pp.reportDir, runId);
  const resultAbs = path.join(pp.resultDir, resultFileName(runId, adapter));
  const resultRel = toPosixRel(paths.dir, resultAbs);
  const logAbs = path.join(pp.logDir, `${runId}.log`);
  const logRel = toPosixRel(paths.dir, logAbs);
  fs.mkdirSync(pp.reportDir, { recursive: true });
  fs.mkdirSync(pp.resultDir, { recursive: true });
  fs.mkdirSync(pp.logDir, { recursive: true });

  /**
   * 任务运行走 shell：项目自带脚本 / Makefile 目标 / 用户手写的命令都按原样执行，
   * 支持引号与 `&&`。报告路径靠环境变量注入，不改用户命令本身：
   * - pytest：`PYTEST_ADDOPTS` 追加 `--junitxml`（在配置的 addopts 之后生效）
   * - Playwright：`PLAYWRIGHT_JSON_OUTPUT_NAME` 指定 JSON 结果落点
   */
  let resolved;
  if (task) {
    const env = {};
    if (project.framework === 'pytest') {
      env.PYTEST_ADDOPTS = [process.env.PYTEST_ADDOPTS ?? '', `--junitxml=${resultAbs}`]
        .filter(Boolean)
        .join(' ');
    } else {
      env.PLAYWRIGHT_JSON_OUTPUT_NAME = resultAbs;
      env.PLAYWRIGHT_JSON_OUTPUT_DIR = path.dirname(resultAbs);
    }
    resolved = { shell: true, command: taskCommandLine(task, args), args: [], env };
  } else {
    resolved = adapter.resolve({
      dir: project.dir,
      probe,
      args,
      runId,
      resultAbs,
      resultDirAbs: pp.resultDir,
      reportAbs,
      guardPath: ARGV_GUARD_PATH,
    });
  }
  if (resolved?.error) return { error: resolved.error, status: 400 };
  if (!resolved?.command) return { error: '运行命令解析失败', status: 500 };

  const startedAt = new Date().toISOString();
  const env = withProjectNode(
    {
      ...process.env,
      // 面板选的 ENV：框架内部已经解析出 ENV 时以框架的为准（下面 resolved.env 覆盖它）
      ...(runEnv ? { ENV: runEnv } : {}),
      ...(resolved.env ?? {}),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    project.dir,
  );
  /** 任务命令自己写死了别的 ENV 时提示一句：shell 里后设的值会覆盖选择器 */
  let envWarning = '';

  // 记录真实执行的命令行：任务运行时是 shell 命令串，全量运行时是命令 + 参数
  const commandLine = resolved.shell
    ? resolved.command
    : [resolved.command, ...(resolved.args ?? [])].join(' ');
  envWarning = envTaskMismatch(commandLine, runEnv);

  const win = process.platform === 'win32';
  let child;
  try {
    child = resolved.shell
      ? spawn(
          win ? 'cmd.exe' : '/bin/sh',
          win ? ['/d', '/s', '/c', resolved.command] : ['-c', resolved.command],
          {
            cwd: project.dir,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: !win,
            windowsHide: true,
          },
        )
      : spawn(resolved.command, resolved.args, {
          cwd: project.dir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !win,
          windowsHide: true,
        });
  } catch (err) {
    return { error: `启动失败：${err instanceof Error ? err.message : String(err)}`, status: 500 };
  }

  const run = {
    id: runId,
    projectId,
    framework: adapter.id,
    startedAt,
    finishedAt: '',
    status: 'running',
    exitCode: null,
    durationMs: 0,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    args,
    // 这次跑在哪个环境：历史记录里能看出「prod 失败」而不是只有一份报告
    envName: runEnv,
    command: commandLine,
    taskId,
    taskLabel: task ? taskCommandLine(task) : '',
    projectNames: [],
    reportRel: '',
    resultRel,
    logRel,
    error: '',
  };
  store.runs.push(run);
  project.lastRunId = runId;
  project.lastRunAt = startedAt;
  project.lastStatus = 'running';
  writeStore(root, store);

  /** @type {RunProcess} */
  const entry = {
    child,
    projectId,
    runId,
    logAbs,
    stream: fs.createWriteStream(logAbs, { flags: 'a' }),
    log: '',
    logStart: 0,
    stopping: false,
    killTimer: null,
    settled: false,
  };
  RUNNING.set(runId, entry);
  appendLog(entry, `[lantern] $ ${commandLine}\n`);

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => appendLog(entry, chunk));
  child.stderr?.on('data', (chunk) => appendLog(entry, chunk));
  child.on('error', (err) => {
    appendLog(entry, `\n[lantern] 启动失败：${err.message}\n`);
    finishRun(root, entry, runId, null, err.message);
  });
  child.on('close', (code) => {
    appendLog(entry, `\n[lantern] 进程退出，exitCode=${code ?? 'null'}\n`);
    finishRun(root, entry, runId, code, '');
  });

  return { run: runView(run), command: commandLine, args: resolved.args, envWarning };
}

function stopRun(runId) {
  const entry = RUNNING.get(runId);
  if (!entry) return false;
  if (entry.stopping) return true;
  entry.stopping = true;
  appendLog(entry, '\n[lantern] 收到停止请求，正在结束进程…\n');
  killRun(entry, 'SIGTERM');
  entry.killTimer = setTimeout(() => {
    if (!RUNNING.has(runId)) return;
    appendLog(entry, '\n[lantern] 5s 内未退出，强制结束。\n');
    killRun(entry, 'SIGKILL');
  }, STOP_GRACE_MS);
  entry.killTimer.unref?.();
  return true;
}

/* ============================ Allure 报告 ============================ */

/** 读项目 package.json 里的 scripts（读不到就当没有） */
function readPkgScripts(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return raw && typeof raw.scripts === 'object' && raw.scripts ? raw.scripts : {};
  } catch {
    return {};
  }
}

/**
 * 生成 Allure 静态报告：优先用项目自己的 `report:allure` 脚本（口径由项目定），
 * 没有脚本时退回 `npx allure generate <results> -o <report> --clean`。
 * Allure CLI 依赖 Java，跑不起来时把输出原样回给界面，让人自己决定装不装。
 */
function allureGeneratePlan(project, probe, adapter, scripts) {
  const dirs = adapter.allureDirs?.(probe) ?? { report: [], results: [] };
  const resultsRel =
    dirs.results.find((rel) => hasFilesInside(path.resolve(project.dir, rel))) ?? '';
  const reportRel =
    dirs.report.find((rel) => fs.existsSync(path.resolve(project.dir, rel))) ??
    dirs.report[0] ??
    '';
  if (!resultsRel) return { error: '项目里没有 Allure 原始结果，先在项目里跑一次测试' };
  const { commands } = resolvePackageManager({ dir: project.dir });
  // 有 report:allure 脚本就按项目的口径生成（脚本里怎么配 results/output 都归项目管）；
  // 没有就退回官方 CLI，`-y` 让 npx 自己取（本机没装 Java 时日志里会直接报出来）
  const command =
    typeof scripts['report:allure'] === 'string'
      ? commands.run('report:allure')
      : `npx -y allure-commandline generate ${resultsRel} -o ${reportRel || 'allure-report'} --clean`;
  return { command, resultsRel, reportRel: reportRel || 'allure-report', dirs };
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (code, extra = '') => {
      if (done) return;
      done = true;
      resolve({ code, output: `${output}${extra}`.slice(-20_000) });
    };
    let child;
    try {
      child = spawn(command, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: '0' } });
    } catch (error) {
      finish(
        -1,
        `\n[lantern] 启动失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      return;
    }
    const push = (chunk) => {
      output += String(chunk);
      if (output.length > 40_000) output = output.slice(-20_000);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    const timer = setTimeout(() => {
      killChild(child);
      finish(-1, '\n[lantern] 生成超过 180 秒，已终止。\n');
    }, 180_000);
    timer.unref?.();
    child.on('error', (error) => {
      clearTimeout(timer);
      finish(-1, `\n[lantern] ${error instanceof Error ? error.message : String(error)}\n`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

function killChild(child) {
  try {
    child?.kill('SIGTERM');
  } catch {
    // 已经退出
  }
}

async function generateAllureReport(root, runId) {
  const paths = uiautoStorePaths(root);
  const store = readStoreForWrite(root);
  const run = findRun(store, runId);
  if (!run) return { error: '运行记录不存在', status: 404 };
  const project = findProject(store, run.projectId);
  if (!project) return { error: '项目记录不存在', status: 404 };
  const probe = buildProbe(project.dir);
  if (!probe.exists) return { error: '项目目录不存在，请重新选择目录', status: 400 };
  const adapter = getAdapter(run.framework) ?? getAdapter('playwright');
  const plan = allureGeneratePlan(project, probe, adapter, readPkgScripts(project.dir));
  if (plan.error) return { error: plan.error, status: 400 };

  const result = await runShell(plan.command, project.dir);

  const pp = projectPaths(root, project);
  const dest = path.join(pp.reportDir, run.id, 'allure');
  let snaps = { source: '' };
  try {
    snaps = snapshotReport({
      projectDir: project.dir,
      candidates: [plan.reportRel],
      destAbs: dest,
    });
  } catch {
    // 快照失败按没生成处理
  }
  const ready = Boolean(snaps.source) && hasReportEntry(dest);
  if (ready) {
    run.allureRel = toPosixRel(paths.dir, dest);
    if (!run.reportRel) run.reportRel = toPosixRel(paths.dir, path.join(pp.reportDir, run.id));
  }
  writeStore(root, store);
  return {
    ok: ready,
    code: result.code,
    command: plan.command,
    log: result.output,
    run: runView(run),
    error: ready
      ? ''
      : '没有生成出 index.html，看看下面的日志（常见原因：本机没装 Java / allure 命令）',
  };
}

/* ============================ 一键安装依赖 ============================ */
function setupLogFile(root, project) {
  const pp = projectPaths(root, project);
  fs.mkdirSync(pp.logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const abs = path.join(pp.logDir, `setup-${stamp}.log`);
  return { abs, rel: toPosixRel(uiautoStorePaths(root).dir, abs) };
}

/** 只改 setup 字段并立刻落盘：进程在跑时前端轮询要看到最新的步骤状态 */
function patchProjectSetup(root, projectId, updater) {
  const store = readStoreForWrite(root);
  const project = findProject(store, projectId);
  if (!project) return null;
  const next = normalizeSetup(updater(normalizeSetup(project.setup)));
  project.setup = next;
  writeStore(root, store);
  return next;
}

function patchSetupStep(root, projectId, stepId, patch) {
  return patchProjectSetup(root, projectId, (setup) => ({
    ...setup,
    steps: setup.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
  }));
}

function startProjectSetup(root, projectId) {
  const store = readStoreForWrite(root);
  const project = findProject(store, projectId);
  if (!project) return { error: '项目不存在', status: 404 };
  if (SETUPS.has(projectId)) {
    return { error: '该项目正在安装，请等它结束或先停止', status: 409 };
  }
  if (SETUPS.size >= MAX_CONCURRENT_SETUPS) {
    return { error: `全局最多同时安装 ${MAX_CONCURRENT_SETUPS} 个项目，请稍后再试`, status: 409 };
  }
  const probe = buildProbe(project.dir);
  if (!probe.exists) return { error: '项目目录不存在，请重新指定目录', status: 400 };
  const plan = setupPlanFor({
    framework: project.framework,
    dir: project.dir,
    packageManager: probe.packageManager,
  });
  if (plan.error) return { error: plan.error, status: 400 };

  const paths = uiautoStorePaths(root);
  const log = setupLogFile(root, project);
  const startedAt = new Date().toISOString();
  const steps = plan.steps.map((step) => ({
    id: step.id,
    label: step.label,
    command: step.command,
    status: 'pending',
    startedAt: '',
    finishedAt: '',
    exitCode: null,
  }));

  const setup = patchProjectSetup(root, projectId, (prev) => ({
    ...emptySetup(),
    status: 'running',
    startedAt,
    logRel: toPosixRel(paths.dir, log.abs),
    // 上一次装失败留下的提示不要带进来
    error: '',
    steps,
  }));

  /** @type {SetupProcess} */
  const entry = {
    child: null,
    projectId,
    logAbs: log.abs,
    stream: fs.createWriteStream(log.abs, { flags: 'a' }),
    log: '',
    logStart: 0,
    plan: plan.steps,
    index: 0,
    /** 浏览器内核是否已经用国内镜像重试过（只重试一次） */
    mirrorTried: false,
    stopping: false,
    killTimer: null,
    settled: false,
  };
  SETUPS.set(projectId, entry);
  appendLog(entry, `[lantern] 开始安装依赖：${project.name}\n[lantern] 目录：${project.dir}\n`);
  launchSetupStep(root, entry);
  return { setup, command: plan.steps.map((step) => step.command).join(' && ') };
}

/** 串行跑下一步：前一步非 0 退出就停下，剩下的标 skipped */
function launchSetupStep(root, entry) {
  if (entry.settled) return;
  const { projectId } = entry;
  if (entry.stopping) {
    finishSetup(root, entry, 'stopped', null, '');
    return;
  }
  const step = entry.plan[entry.index];
  if (!step) {
    finishSetup(root, entry, 'done', 0, '');
    return;
  }
  const startedAt = new Date().toISOString();
  patchSetupStep(root, projectId, step.id, { status: 'running', startedAt });
  // 第二次尝试「安装浏览器内核」时带国内镜像：官方源会 307 到 storage.googleapis.com
  const mirrorEnv = browserMirrorRetryEnv(step, entry.mirrorTried);
  if (mirrorEnv.PLAYWRIGHT_DOWNLOAD_HOST) {
    appendLog(entry, `\n[lantern] 改用国内镜像下载内核：${mirrorEnv.PLAYWRIGHT_DOWNLOAD_HOST}\n`);
  }
  appendLog(entry, `\n[lantern] ${step.label}：$ ${step.command}\n`);

  // 安装依赖也走项目声明的 Node：`.nvmrc` 指定 22 时别用面板进程那个版本装出别的原生模块
  const projectDir = findProject(readStore(root).store, projectId)?.dir ?? '';
  const win = process.platform === 'win32';
  let child;
  try {
    child = spawn(
      win ? 'cmd.exe' : '/bin/sh',
      win ? ['/d', '/s', '/c', step.command] : ['-c', step.command],
      {
        cwd: step.cwd || undefined,
        env: withProjectNode(
          {
            ...process.env,
            ...mirrorEnv,
            FORCE_COLOR: '0',
            NO_COLOR: '1',
            CI: '1',
          },
          projectDir,
        ),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !win,
        windowsHide: true,
      },
    );
  } catch (error) {
    appendLog(
      entry,
      `\n[lantern] 启动失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    patchSetupStep(root, projectId, step.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
    });
    finishSetup(root, entry, 'failed', null, '启动安装进程失败');
    return;
  }
  entry.child = child;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => appendLog(entry, chunk));
  child.stderr?.on('data', (chunk) => appendLog(entry, chunk));
  child.on('error', (error) => {
    appendLog(entry, `\n[lantern] 启动失败：${error.message}\n`);
    patchSetupStep(root, projectId, step.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      exitCode: null,
    });
    finishSetup(root, entry, 'failed', null, error.message);
  });
  child.on('close', (code) => {
    entry.child = null;
    const finishedAt = new Date().toISOString();
    appendLog(entry, `\n[lantern] ${step.label} 结束，exitCode=${code ?? 'null'}\n`);
    if (entry.stopping) {
      patchSetupStep(root, projectId, step.id, {
        status: code === 0 ? 'done' : 'failed',
        finishedAt,
        exitCode: code,
      });
      finishSetup(root, entry, 'stopped', code, '');
      return;
    }
    // 内核下载被网络掐断：自动换国内镜像重试一次（只对这一步、只重试一次）
    if (
      code !== 0 &&
      browserMirrorRetryEnv(step, entry.mirrorTried).PLAYWRIGHT_DOWNLOAD_HOST &&
      isBrowserDownloadNetworkError(entry.log.slice(-8000))
    ) {
      entry.mirrorTried = true;
      appendLog(entry, '\n[lantern] 内核下载失败（网络中断），自动切换国内镜像重试…\n');
      patchSetupStep(root, projectId, step.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: '',
        exitCode: null,
      });
      launchSetupStep(root, entry);
      return;
    }
    patchSetupStep(root, projectId, step.id, {
      status: code === 0 ? 'done' : 'failed',
      finishedAt,
      exitCode: code,
    });
    if (code !== 0) {
      // 后面还有步骤就标跳过，别让界面一直挂着「待安装」
      const store = readStoreForWrite(root);
      const project = findProject(store, projectId);
      if (project) {
        const skipped = entry.plan.slice(entry.index + 1).map((item) => item.id);
        if (skipped.length) {
          project.setup = normalizeSetup({
            ...normalizeSetup(project.setup),
            steps: normalizeSetup(project.setup).steps.map((item) =>
              skipped.includes(item.id) ? { ...item, status: 'skipped' } : item,
            ),
          });
          writeStore(root, store);
        }
      }
      finishSetup(root, entry, 'failed', code, `${step.label}失败（exitCode=${code ?? 'null'}）`);
      return;
    }
    entry.index += 1;
    launchSetupStep(root, entry);
  });
}

/** 收尾：写最终状态 + 复核环境是否真的就绪（装了但依赖不全也要标失败） */
function finishSetup(root, entry, status, exitCode, error) {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.killTimer) clearTimeout(entry.killTimer);

  // 先读 store 再摘进程：readStore 的 reconcile 会把「没有进程的 running」判成中断，
  // 提前摘掉会让这次收尾先被写一次 interrupted
  const store = readStoreForWrite(root);
  SETUPS.delete(entry.projectId);
  const project = findProject(store, entry.projectId);

  let finalStatus = status;
  let finalError = error;
  let finalExit = exitCode;
  if (status === 'done' && project) {
    const health = detectProject(project.dir, project.framework);
    if (!health.frameworkReady) {
      finalStatus = 'failed';
      finalError = health.readyHint || '安装已结束，但运行环境仍未就绪';
    }
    finalExit = 0;
  }
  if (status === 'stopped') finalError = '已停止安装';

  // 先写最后一行再关流，日志文件里也能看到收尾结论
  appendLog(
    entry,
    `\n[lantern] 安装${finalStatus === 'done' ? '完成' : finalStatus === 'stopped' ? '已停止' : '未完成'}${
      finalError ? `：${finalError}` : ''
    }\n`,
  );
  if (entry.stream) {
    try {
      entry.stream.end();
    } catch {
      // ignore
    }
    entry.stream = null;
  }
  if (!project) return;

  project.setup = normalizeSetup({
    ...normalizeSetup(project.setup),
    status: finalStatus,
    finishedAt: new Date().toISOString(),
    exitCode: Number.isFinite(finalExit) ? finalExit : null,
    error: finalError,
  });
  writeStore(root, store);
}

function stopProjectSetup(projectId) {
  const entry = SETUPS.get(projectId);
  if (!entry) return false;
  if (entry.stopping) return true;
  entry.stopping = true;
  appendLog(entry, '\n[lantern] 收到停止请求，正在结束安装进程…\n');
  killRun(entry, 'SIGTERM');
  entry.killTimer = setTimeout(() => {
    if (!SETUPS.has(projectId)) return;
    appendLog(entry, '\n[lantern] 5s 内未退出，强制结束。\n');
    killRun(entry, 'SIGKILL');
  }, STOP_GRACE_MS);
  entry.killTimer.unref?.();
  return true;
}

/** 安装日志读法：跑着的用内存缓冲，结束的从日志文件尾部取（与 /run 一致） */
function readSetupLog(root, project, offset) {
  const setup = normalizeSetup(project.setup);
  const entry = SETUPS.get(project.id);
  if (!entry) {
    let log = '';
    const rel = setup.logRel;
    if (rel) {
      const abs = resolveInside(uiautoStorePaths(root).dir, rel);
      if (abs) {
        try {
          const stat = fs.statSync(abs);
          const start = Math.max(0, stat.size - MAX_PREVIEW_BYTES);
          const buffer = Buffer.alloc(stat.size - start);
          const fd = fs.openSync(abs, 'r');
          try {
            fs.readSync(fd, buffer, 0, buffer.length, start);
          } finally {
            fs.closeSync(fd);
          }
          log = buffer.toString('utf8');
        } catch {
          log = '';
        }
      }
    }
    return {
      setup: { ...setup, status: setup.status },
      stopping: false,
      log,
      nextOffset: 0,
      reset: true,
    };
  }
  const reset = offset < entry.logStart;
  const from = Math.max(offset, entry.logStart);
  return {
    setup: { ...setup, status: 'running' },
    stopping: entry.stopping,
    log: entry.log.slice(from - entry.logStart),
    nextOffset: entry.logStart + entry.log.length,
    reset,
  };
}

/* ────────────────── 安装缺失的 Node 版本 ────────────────── */

/**
 * 正在跑的 Node 安装：按项目同时只允许一个。
 * 只存内存：日志本身落在项目日志目录，进程没了就是没在装，不需要跨重启恢复。
 */
const NODE_INSTALLS = new Map();

function nodeInstallLogFile(root, project) {
  const pp = projectPaths(root, project);
  fs.mkdirSync(pp.logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(pp.logDir, `node-install-${stamp}.log`);
}

function appendNodeLog(entry, chunk) {
  const textChunk = String(chunk ?? '');
  if (!textChunk) return;
  entry.log += textChunk;
  // 只留尾部，避免一个装很久的进程把内存吃满
  if (entry.log.length > MAX_PREVIEW_BYTES) {
    entry.log = entry.log.slice(-MAX_PREVIEW_BYTES);
  }
  try {
    entry.stream?.write(textChunk);
  } catch {
    // 日志写不进去不影响安装本身
  }
}

/** 开始装一个 Node 版本；返回错误字符串表示没起来 */
function startNodeInstall(root, projectId, version) {
  const store = readStore(root).store;
  const project = findProject(store, projectId);
  if (!project) return { error: '项目不存在', status: 404 };
  const running = NODE_INSTALLS.get(projectId);
  if (running && running.status === 'running') {
    return { error: '正在安装 Node，请等它结束', status: 409 };
  }
  const plan = nodeInstallPlan(version);
  if (plan.error) return { error: plan.error, status: 400 };

  const logAbs = nodeInstallLogFile(root, project);
  const now = new Date().toISOString();
  const entry = {
    projectId,
    version: String(version).trim().replace(/^v/i, ''),
    manager: plan.manager,
    command: plan.command,
    status: 'running',
    exitCode: null,
    startedAt: now,
    finishedAt: '',
    log: '',
    stream: null,
    child: null,
    stopping: false,
    killTimer: null,
  };
  try {
    entry.stream = fs.createWriteStream(logAbs, { flags: 'a' });
  } catch {
    entry.stream = null;
  }
  NODE_INSTALLS.set(projectId, entry);
  appendNodeLog(
    entry,
    `[lantern] 安装 Node ${entry.version}（${plan.manager}）\n[lantern] 命令：${plan.command}\n\n`,
  );

  let child;
  try {
    child = spawn(plan.file, plan.args, {
      cwd: project.dir,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (error) {
    entry.status = 'failed';
    entry.finishedAt = new Date().toISOString();
    appendNodeLog(entry, `\n[lantern] 启动失败：${error.message}\n`);
    entry.stream?.end();
    entry.stream = null;
    return { error: error.message, status: 500 };
  }
  entry.child = child;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => appendNodeLog(entry, chunk));
  child.stderr?.on('data', (chunk) => appendNodeLog(entry, chunk));
  child.on('error', (error) => {
    entry.child = null;
    entry.status = 'failed';
    entry.exitCode = null;
    entry.finishedAt = new Date().toISOString();
    appendNodeLog(entry, `\n[lantern] 启动失败：${error.message}\n`);
    entry.stream?.end();
    entry.stream = null;
  });
  child.on('close', (code) => {
    entry.child = null;
    if (entry.killTimer) clearTimeout(entry.killTimer);
    entry.exitCode = Number.isFinite(code) ? code : null;
    entry.finishedAt = new Date().toISOString();
    entry.status = entry.stopping ? 'stopped' : code === 0 ? 'done' : 'failed';
    appendNodeLog(
      entry,
      `\n[lantern] ${
        entry.status === 'done'
          ? `Node ${entry.version} 安装完成，下拉里已经能选到它`
          : entry.status === 'stopped'
            ? '已停止安装'
            : `安装失败（exitCode=${code ?? 'null'}）`
      }\n`,
    );
    entry.stream?.end();
    entry.stream = null;
  });
  return { entry };
}

function readNodeInstall(projectId) {
  const entry = NODE_INSTALLS.get(projectId);
  if (!entry) return { status: 'idle', version: '', command: '', log: '', exitCode: null };
  return {
    status: entry.status,
    version: entry.version,
    manager: entry.manager,
    command: entry.command,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    exitCode: entry.exitCode,
    stopping: entry.stopping,
    log: entry.log,
  };
}

function stopNodeInstall(projectId) {
  const entry = NODE_INSTALLS.get(projectId);
  if (!entry || !entry.child) return false;
  entry.stopping = true;
  appendNodeLog(entry, '\n[lantern] 收到停止请求…\n');
  killRun(entry, 'SIGTERM');
  entry.killTimer = setTimeout(() => {
    if (NODE_INSTALLS.get(projectId) !== entry) return;
    appendNodeLog(entry, '\n[lantern] 5s 内未退出，强制结束。\n');
    killRun(entry, 'SIGKILL');
  }, STOP_GRACE_MS);
  entry.killTimer.unref?.();
  return true;
}

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

function sendReportFile(root, res, runId, rawPath) {
  if (!/^[A-Za-z0-9_-]+$/.test(runId))
    return sendJson(res, 400, { ok: false, error: '运行 ID 不合法' });
  const paths = uiautoStorePaths(root);
  const run = findRun(readStore(root).store, runId);
  if (!run || !run.reportRel) return sendJson(res, 404, { ok: false, error: '报告不存在' });
  const dir = path.join(paths.dir, run.reportRel);
  if (!isPathInside(paths.dir, dir)) {
    return sendJson(res, 400, { ok: false, error: '报告路径不合法' });
  }
  let rel;
  try {
    rel = decodeURIComponent(rawPath || '');
  } catch {
    return sendJson(res, 400, { ok: false, error: '报告路径不合法' });
  }
  if (rel.includes('\0')) return sendJson(res, 400, { ok: false, error: '报告路径不合法' });
  const target = resolveInside(dir, rel || 'index.html');
  if (!target) return sendJson(res, 400, { ok: false, error: '报告路径不合法' });
  let file = target;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    return sendJson(res, 404, { ok: false, error: '报告文件不存在' });
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { ok: false, error: '报告文件不存在' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: '报告文件不存在' });

  const ext = path.extname(file).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'no-cache');
  // 报告里可能有 trace / 附件：未知类型按下载处理，避免浏览器误渲染
  if (!MIME_BY_EXT[ext]) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    );
  }
  fs.createReadStream(file).pipe(res);
}

/** 各框架的测试文件命名规则：只用于「指定文件」下拉，识别不依赖它 */
const SPEC_PATTERNS = {
  playwright: /\.(spec|test)\.(ts|js|mjs|cjs|tsx|jsx)$/,
  pytest: /^(test_.*|.*_test)\.py$/,
  selenium: /\.(java|kt|scala)$/,
};

/** 从目录树里筛出测试文件，供「指定文件」下拉使用 */
function listSpecFiles(project, framework = project.framework) {
  const pattern = SPEC_PATTERNS[framework] ?? SPEC_PATTERNS.playwright;
  const result = [];
  const walk = (abs, level) => {
    if (level > 6 || result.length >= 500) return;
    let items;
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (result.length >= 500) return;
      if (shouldIgnoreTreeName(item.name)) continue;
      const child = path.join(abs, item.name);
      if (item.isDirectory()) walk(child, level + 1);
      else if (pattern.test(item.name)) {
        result.push(toPosixRel(project.dir, child));
      }
    }
  };
  walk(project.dir, 0);
  return result.sort();
}

function removeRunArtifacts(root, run) {
  const paths = uiautoStorePaths(root);
  const inside = (abs) => abs && isPathInside(paths.dir, abs);
  // Selenium/Maven 的 surefire XML 落在该项目 结果/<runId>-surefire/
  if (run.resultRel) {
    const resultAbs = path.join(paths.dir, run.resultRel);
    const surefireDir = path.join(path.dirname(resultAbs), `${run.id}-surefire`);
    if (inside(surefireDir)) fs.rmSync(surefireDir, { recursive: true, force: true });
  }
  if (run.reportRel) {
    const abs = path.join(paths.dir, run.reportRel);
    if (inside(abs)) fs.rmSync(abs, { recursive: true, force: true });
  }
  if (run.resultRel) {
    const abs = path.join(paths.dir, run.resultRel);
    if (inside(abs)) fs.rmSync(abs, { force: true });
  }
  if (run.logRel) {
    const abs = path.join(paths.dir, run.logRel);
    if (inside(abs)) fs.rmSync(abs, { force: true });
  }
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhUiautoPlugin() {
  // 浏览器被用户手动关掉：把会话从「探索中」收回草稿，并在活动日志里留一条，
  // 前端再打开还能看出这一轮是被关窗结束的（模型那边也会收到 CLOSED_MESSAGE 而停手）。
  onExplorerClosed(({ sessionId }) => {
    try {
      const baseDir = uiautoCachePaths(getDataRoot()).dir;
      const record = readGeneratedSession(baseDir, sessionId);
      if (!record) return;
      const activity = Array.isArray(record.activity) ? record.activity.slice() : [];
      const last = activity[activity.length - 1];
      if (!(last && last.name === '浏览器已关闭')) {
        activity.push({
          kind: 'error',
          name: '浏览器已关闭',
          detail: '你关闭了浏览器窗口，这一轮探索已结束；重新点「开始探索」会新开一个浏览器',
          status: 'failed',
          at: new Date().toISOString(),
        });
      }
      saveGeneratedSession(baseDir, {
        id: sessionId,
        // 只有还在探索中的会话需要收回草稿；已写入 / 已试跑的别降级
        status: record.status === 'exploring' ? 'draft' : record.status,
        activity,
      });
    } catch {
      // 收尾失败不影响其它流程
    }
  });

  return {
    name: 'lh-uiauto',
    configureServer(server) {
      server.httpServer?.on('close', () => {
        stopAllExplorers();
        stopAllDebugSessions();
        // 服务退出时别把安装进程留成孤儿
        for (const entry of SETUPS.values()) {
          try {
            killRun(entry, 'SIGTERM');
          } catch {
            // ignore
          }
        }
      });
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        // 数据根惰性读取：切换数据空间后无需重启
        const root = getDataRoot();
        const method = req.method || 'GET';
        const tail = parsed.pathname.slice(PREFIX.length) || '/';

        try {
          // 任何一次插件请求都顺手把旧版放在内容目录里的本机数据搬到 .lantern/local/uiauto
          try {
            uiautoCachePaths(root);
          } catch {
            // 迁移失败不阻塞主流程
          }

          if (method === 'GET' && tail.startsWith('/report/')) {
            const rest = tail.slice('/report/'.length);
            const slash = rest.indexOf('/');
            const runId = slash === -1 ? rest : rest.slice(0, slash);
            const rel = slash === -1 ? '' : rest.slice(slash + 1);
            return sendReportFile(root, res, runId, rel);
          }

          /* ── 提示词：与「提示词管理/自动化执行提示词.md」联动 ── */

          if (method === 'GET' && tail === '/prompt') {
            // 允许按项目指定提示词文件（不同框架挂不同提示词）；只接受提示词目录里的文件名，
            // 传空 / 不存在时退回插件默认那份，避免把接口当任意文件读取
            const wanted = text(parsed.searchParams.get('file'), 200);
            const file = wanted && isPromptFileName(wanted) ? wanted : UI_AUTO_PROMPT_FILE;
            const content = readPluginPrompt(file, root);
            // 骨架段按项目框架取子段：同一个文件名要服务 Playwright / pytest / Selenium
            const framework = text(parsed.searchParams.get('framework'), 40);
            const sections = parseUiAutoPrompt(content, framework);
            return sendJson(res, 200, {
              ok: true,
              file,
              exists: Boolean(content.trim()),
              plan: sections.plan,
              agent: sections.agent,
              code: sections.code,
              skeleton: sections.skeleton,
            });
          }

          if (method === 'POST' && tail === '/prompt/sync') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const wanted = body.enabled === true;
            if (!wanted) {
              // 关闭只停用：文件保留，再打开仍引用同一份
              const exists = fs.existsSync(pluginPromptPath(UI_AUTO_PROMPT_FILE, root));
              return sendJson(res, 200, {
                ok: true,
                enabled: false,
                removed: false,
                exists,
                file: UI_AUTO_PROMPT_FILE,
              });
            }
            // 旧名先改名（Playwright提示词.md → 自动化执行提示词.md），内容一字不动
            const renamed = [];
            try {
              renamed.push(...migrateLegacyPluginPrompts(root));
            } catch {
              // 改名失败不影响补种子
            }
            const out = ensurePluginPrompt(UI_AUTO_PROMPT_FILE, UI_AUTO_PROMPT_TEMPLATE, root);
            const projectPrompt = ensurePluginPrompt(
              UI_AUTO_PROJECT_PROMPT_FILE,
              PROJECT_PROMPT_TEMPLATE,
              root,
            );
            // 顺带补骨架种子：新建项目时直接读空间里这份
            const seeded = [];
            for (const stack of listStacks()) {
              if (!stack.skeleton) continue;
              try {
                const result = ensureSkeletonSeed(root, stack.skeleton);
                seeded.push({
                  id: stack.skeleton,
                  created: result.created,
                  updated: result.updated,
                });
              } catch {
                // 补种子失败不影响提示词；新建项目时会再试一次
              }
            }
            return sendJson(res, 200, {
              ok: true,
              enabled: true,
              created: out.created,
              updated: out.updated,
              exists: out.exists,
              file: out.file,
              renamed,
              prompts: [
                { file: UI_AUTO_PROMPT_FILE, use: 'generate', ...out },
                { file: UI_AUTO_PROJECT_PROMPT_FILE, use: 'scaffold', ...projectPrompt },
              ],
              skeletons: seeded,
            });
          }

          if (method === 'GET' && parsed.searchParams.get('health') === '1') {
            const healthStore = readStore(root).store;
            return sendJson(res, 200, {
              ok: true,
              files: {
                ...uiautoStorePaths(root),
                projects: healthStore.projects.map((project) => ({
                  id: project.id,
                  name: project.name,
                  dir: projectPaths(root, project).dir,
                })),
              },
              running: [...RUNNING.keys()],
              frameworks: frameworkOptions(),
              version: VERSION,
            });
          }

          if (method === 'GET' && tail === '/projects') {
            const { store, dirty } = readStore(root);
            if (dirty) writeStore(root, store);
            const projects = store.projects.map((project) => ({
              ...decorateProject(project, root),
              specFiles: buildProbe(project.dir).exists
                ? listSpecFiles(project, project.framework)
                : [],
              // 上次运行拿到的 Playwright 项目名（setup / chromium-login 之类），给下拉做候选
              projectNames: latestProjectNames(store, project.id),
            }));
            return sendJson(res, 200, {
              ok: true,
              projects,
              frameworks: frameworkOptions(),
            });
          }

          if (method === 'POST' && tail === '/detect') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const rawDir = text(body.dir, 4096);
            if (!rawDir) return sendJson(res, 400, { ok: false, error: '缺少项目目录' });
            const dir = path.resolve(rawDir);
            const probe = buildProbe(dir);
            if (!probe.exists) return sendJson(res, 400, { ok: false, error: '目录不存在' });
            const candidates = detectCandidates(probe);
            const hints = {};
            for (const candidate of candidates) {
              const adapter = getAdapter(candidate.id);
              hints[candidate.id] = adapter?.readyHint?.(probe) ?? '';
            }
            return sendJson(res, 200, {
              ok: true,
              dir,
              candidates,
              hints,
              frameworks: frameworkOptions(),
            });
          }

          if (method === 'POST' && tail === '/pick-directory') {
            const picked = await pickDirectoryResult('选择测试项目目录');
            if (picked.error) {
              return sendJson(res, 200, { ok: false, error: picked.error, dir: '' });
            }
            if (picked.canceled) return sendJson(res, 200, { ok: true, canceled: true, dir: '' });
            return sendJson(res, 200, { ok: true, dir: picked.path ?? '' });
          }

          if (method === 'GET' && tail === '/scaffold/stacks') {
            return sendJson(res, 200, { ok: true, stacks: scaffoldStackViews(root) });
          }

          /* ── 骨架原文：新建项目的「检查」步骤拼 AI prompt、判「有没有被改过」 ── */

          if (method === 'GET' && tail === '/skeleton') {
            const stackId = text(parsed.searchParams.get('stack'), 40) || 'playwright';
            return sendJson(res, 200, readSpaceSkeleton(root, stackId));
          }

          /* ── 新建项目：用平台固定模板生成一套企业级基础框架 ── */

          if (method === 'POST' && tail === '/scaffold/check') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const stackId = text(body.stack, 40);
            const rawParent = text(body.parentDir, 4096);
            /** 修改项目：直接检查已有目录，不要求目录为空 */
            const rawDir = text(body.dir, 4096);
            const name = text(body.name, 200);
            const provided = body.skeleton ?? null;

            let rendered;
            let effective;
            try {
              const picked = pickScaffoldSkeleton(root, stackId, provided);
              rendered = renderScaffold({
                stack: stackId,
                name,
                baseURL:
                  text(body.baseURL, 500) ||
                  (rawDir ? existingScaffoldBaseURL(path.resolve(rawDir)) : ''),
                options: Array.isArray(body.options) ? body.options : [],
                skeleton: picked.skeleton,
                skeletonSource: picked.source,
              });
              effective = picked.skeleton;
            } catch (error) {
              return sendJson(res, 400, { ok: false, error: error.message });
            }

            // 目标目录：不抛错，把问题当检查项返回，让向导里能看到原因
            let parentProblem = '';
            let targetProblem = '';
            let dir = '';
            if (rawDir) {
              const resolved = path.resolve(rawDir);
              if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
                targetProblem = `项目目录不存在：${resolved}`;
              } else {
                dir = resolved;
              }
            } else if (!rawParent) {
              parentProblem = '请选择父目录';
            } else {
              const parentDir = path.resolve(rawParent);
              if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
                parentProblem = `父目录不存在：${parentDir}`;
              } else {
                dir = path.join(parentDir, sanitizeFolderName(name));
                try {
                  assertScaffoldTarget(dir);
                } catch (error) {
                  targetProblem = error instanceof Error ? error.message : String(error);
                }
              }
            }

            const audit = auditScaffold({
              skeleton: effective,
              files: rendered.files,
              options: rendered.options,
              targetDir: dir,
              targetProblem,
              parentProblem,
            });
            return sendJson(res, 200, {
              ok: audit.ok,
              dir,
              stack: rendered.stack,
              skeleton: rendered.skeleton,
              skeletonSource: rendered.skeletonSource,
              promptFile: rendered.promptFile,
              layout: rendered.layout,
              options: rendered.options,
              logs: audit.logs,
              checks: audit.checks,
              summary: audit.summary,
            });
          }

          if (method === 'POST' && tail === '/scaffold/preview') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const rawParent = text(body.parentDir, 4096);
            /** 修改项目：预览落在已有目录上，逐文件标 new / changed / same */
            const rawDir = text(body.dir, 4096);
            if (!rawDir && !rawParent)
              return sendJson(res, 400, { ok: false, error: '请选择父目录' });
            const parentDir = rawParent ? path.resolve(rawParent) : '';
            if (!rawDir && (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory())) {
              return sendJson(res, 400, { ok: false, error: '父目录不存在' });
            }
            const picked = pickScaffoldSkeleton(root, text(body.stack, 40), body.skeleton ?? null);
            let rendered;
            try {
              rendered = renderScaffold({
                stack: text(body.stack, 40),
                name: text(body.name, 200),
                baseURL:
                  text(body.baseURL, 500) ||
                  (rawDir ? existingScaffoldBaseURL(path.resolve(rawDir)) : ''),
                options: Array.isArray(body.options) ? body.options : [],
                skeleton: picked.skeleton,
                skeletonSource: picked.source,
              });
            } catch (error) {
              return sendJson(res, 400, { ok: false, error: error.message });
            }
            let dir;
            let planned = null;
            if (rawDir) {
              dir = path.resolve(rawDir);
              if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
                return sendJson(res, 409, { ok: false, error: '项目目录不存在，先重新指定目录' });
              }
              planned = planScaffoldUpdate(dir, rendered.files);
            } else {
              dir = path.join(parentDir, sanitizeFolderName(text(body.name, 200)));
              try {
                assertScaffoldTarget(dir);
              } catch (error) {
                return sendJson(res, 409, { ok: false, error: error.message });
              }
            }
            return sendJson(res, 200, {
              ok: true,
              dir,
              stack: rendered.stack,
              skeleton: rendered.skeleton,
              skeletonSource: rendered.skeletonSource,
              promptFile: rendered.promptFile,
              layout: rendered.layout,
              files: (planned ?? rendered.files).map((file) => ({
                path: file.path,
                bytes: Buffer.byteLength(file.content, 'utf8'),
                ...(planned ? { status: file.status } : {}),
              })),
              ...(planned
                ? {
                    changes: {
                      created: planned.filter((file) => file.status === 'new').length,
                      changed: planned.filter((file) => file.status === 'changed').length,
                      same: planned.filter((file) => file.status === 'same').length,
                    },
                  }
                : {}),
              totalBytes: rendered.files.reduce(
                (sum, file) => sum + Buffer.byteLength(file.content, 'utf8'),
                0,
              ),
              nextCommands: scaffoldNextCommands(dir),
            });
          }

          if (method === 'POST' && tail === '/scaffold') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const rawParent = text(body.parentDir, 4096);
            if (!rawParent) return sendJson(res, 400, { ok: false, error: '请选择父目录' });
            const parentDir = path.resolve(rawParent);
            if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '父目录不存在' });
            }
            let rendered;
            try {
              const picked = pickScaffoldSkeleton(
                root,
                text(body.stack, 40),
                body.skeleton ?? null,
              );
              rendered = renderScaffold({
                stack: text(body.stack, 40),
                name: text(body.name, 200),
                baseURL: text(body.baseURL, 500),
                options: Array.isArray(body.options) ? body.options : [],
                skeleton: picked.skeleton,
                skeletonSource: picked.source,
              });
            } catch (error) {
              return sendJson(res, 400, { ok: false, error: error.message });
            }
            const name = text(body.name, 200).replace(/\s+/g, ' ').trim();
            const dir = path.join(parentDir, sanitizeFolderName(name));
            try {
              assertScaffoldTarget(dir);
            } catch (error) {
              return sendJson(res, 409, { ok: false, error: error.message });
            }

            const store = readStoreForWrite(root);
            if (store.projects.some((project) => path.resolve(project.dir) === dir)) {
              return sendJson(res, 409, { ok: false, error: '该目录已经添加过了' });
            }

            let written;
            try {
              written = writeScaffoldFiles(dir, rendered.files);
            } catch (error) {
              return sendJson(res, 500, { ok: false, error: `写入失败：${error.message}` });
            }

            // 写完再按插件自己的识别口径复核一次：认不出来就整套回滚，不留半成品
            const health = detectProject(dir, rendered.stack);
            if (!health.mountable) {
              rollbackScaffold(written);
              return sendJson(res, 500, {
                ok: false,
                error: '骨架已回滚：生成结果没有被识别为可运行的测试项目',
              });
            }

            const id = `uia_${crypto.randomBytes(8).toString('hex')}`;
            const now = new Date().toISOString();
            // 骨架里的 promptFile 是用户可编辑的，按「提示词管理」的文件名规则再校验一次
            const promptFile = isPromptFileName(rendered.promptFile) ? rendered.promptFile : '';
            const project = {
              id,
              name,
              folder: uniqueFolder(store, name, id),
              dir,
              framework: rendered.stack,
              createdAt: now,
              lastRunId: '',
              lastRunAt: '',
              lastStatus: '',
              source: 'scaffold',
              scaffold: { stack: rendered.stack, at: now, options: rendered.options },
              // 建完就把提示词挂上：生成页不用再手选一份
              promptFile,
            };
            // 提示词文件还不存在时补种子（已存在且用户改过的一律不动）
            if (promptFile) {
              ensurePluginPrompt(promptFile, UI_AUTO_PROMPT_TEMPLATE, root);
            }
            store.projects.push(project);
            writeStore(root, store);
            // 生成过程留档：跟项目同一请求写入，关掉弹窗也还能回看
            let recordSaved = false;
            if (body.record) {
              recordSaved = writeGenerationRecord(root, project, {
                ...body.record,
                at: now,
                stack: rendered.stack,
                name,
                dir,
                skeleton: rendered.skeleton,
                skeletonSource: rendered.skeletonSource,
                promptFile,
                layout: rendered.layout,
              });
            }
            return sendJson(res, 200, {
              ok: true,
              dir,
              project: {
                ...decorateProject(project, root),
                specFiles: listSpecFiles(project, rendered.stack),
                projectNames: [],
              },
              nextCommands: scaffoldNextCommands(dir),
              recordSaved,
            });
          }

          /* ── 修改项目：把骨架重新渲染到已有目录，逐文件判断新增 / 更新 / 未变 ── */

          if (method === 'POST' && tail === '/scaffold/update') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const projectId = text(body.projectId, 64);
            if (!projectId) return sendJson(res, 400, { ok: false, error: '缺少项目 id' });
            const store = readStoreForWrite(root);
            const project = findProject(store, projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });

            const dir = path.resolve(project.dir);
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }

            const stackId = text(body.stack, 40) || project.framework;
            let rendered;
            try {
              const picked = pickScaffoldSkeleton(root, stackId, body.skeleton ?? null);
              rendered = renderScaffold({
                stack: stackId,
                name: text(body.name, 200) || project.name,
                // 留空就沿用现有 .env.example，避免把已经配好的地址冲掉
                baseURL: text(body.baseURL, 500) || existingScaffoldBaseURL(dir),
                options: Array.isArray(body.options) ? body.options : [],
                skeleton: picked.skeleton,
                skeletonSource: picked.source,
              });
            } catch (error) {
              return sendJson(res, 400, { ok: false, error: error.message });
            }

            let planned;
            try {
              planned = planScaffoldUpdate(dir, rendered.files);
            } catch (error) {
              return sendJson(res, 400, { ok: false, error: error.message });
            }

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupDir = path.join(
              root,
              '.lantern',
              'local',
              'uiauto-scaffold',
              'backup',
              sanitizeFolderName(project.folder || project.name),
              stamp,
            );
            let stats;
            try {
              stats = writeScaffoldUpdate(dir, planned, backupDir);
            } catch (error) {
              return sendJson(res, 500, { ok: false, error: `写入失败：${error.message}` });
            }

            const now = new Date().toISOString();
            project.framework = rendered.stack;
            project.scaffold = { stack: rendered.stack, at: now, options: rendered.options };
            if (!project.promptFile && isPromptFileName(rendered.promptFile)) {
              project.promptFile = rendered.promptFile;
            }
            if (project.promptFile) {
              ensurePluginPrompt(project.promptFile, UI_AUTO_PROMPT_TEMPLATE, root);
            }
            writeStore(root, store);

            let recordSaved = false;
            if (body.record) {
              recordSaved = writeGenerationRecord(root, project, {
                ...body.record,
                mode: 'update',
                at: now,
                stack: rendered.stack,
                name: project.name,
                dir,
                skeleton: rendered.skeleton,
                skeletonSource: rendered.skeletonSource,
                promptFile: project.promptFile || '',
                layout: rendered.layout,
              });
            }

            return sendJson(res, 200, {
              ok: true,
              dir,
              files: planned.map((file) => ({
                path: file.path,
                bytes: Buffer.byteLength(file.content, 'utf8'),
                status: file.status,
              })),
              created: stats.created,
              changed: stats.changed,
              same: stats.same,
              backedUp: stats.backedUp,
              backupDir: stats.backedUp.length ? backupDir : '',
              project: {
                ...decorateProject(project, root),
                specFiles: listSpecFiles(project, rendered.stack),
                projectNames: [],
              },
              nextCommands: scaffoldNextCommands(dir),
              recordSaved,
            });
          }

          /* ── 生成过程留档：项目卡片 / 工作台回看 ── */

          if (method === 'GET' && tail === '/scaffold/record') {
            const projectId = text(parsed.searchParams.get('projectId'), 64);
            const store = readStore(root).store;
            const project = findProject(store, projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const record = readGenerationRecord(root, project);
            if (!record) return sendJson(res, 404, { ok: false, error: '还没有生成过程记录' });
            return sendJson(res, 200, { ok: true, record });
          }

          /* ── 一键安装依赖（Playwright：依赖 + chromium 内核） ── */

          if (method === 'POST' && tail === '/project/setup') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const projectId = text(body.projectId, 64);
            if (!projectId) return sendJson(res, 400, { ok: false, error: '缺少项目 id' });
            const result = startProjectSetup(root, projectId);
            if (result.error) {
              return sendJson(res, result.status ?? 400, { ok: false, error: result.error });
            }
            return sendJson(res, 200, { ok: true, ...result });
          }

          if (method === 'POST' && tail === '/project/setup/stop') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const projectId = text(body.projectId, 64);
            if (!projectId) return sendJson(res, 400, { ok: false, error: '缺少项目 id' });
            if (!stopProjectSetup(projectId)) {
              return sendJson(res, 409, { ok: false, error: '该安装已结束或不在本进程中' });
            }
            return sendJson(res, 200, { ok: true });
          }

          if (method === 'GET' && tail === '/project/setup') {
            const projectId = text(parsed.searchParams.get('projectId'), 64);
            const offset = intOr(parsed.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
            const store = readStore(root).store;
            const project = findProject(store, projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            return sendJson(res, 200, { ok: true, ...readSetupLog(root, project, offset) });
          }

          if (method === 'POST' && tail === '/projects') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const rawDir = text(body.dir, 4096);
            if (!rawDir) return sendJson(res, 400, { ok: false, error: '缺少项目目录' });
            const dir = path.resolve(rawDir);
            const requested = text(body.framework, 40);
            if (requested && !ADAPTER_IDS.includes(requested)) {
              return sendJson(res, 400, { ok: false, error: `不支持的框架：${requested}` });
            }
            const health = detectProject(dir, requested);
            if (!health.exists) return sendJson(res, 400, { ok: false, error: '目录不存在' });
            if (!health.mountable) {
              return sendJson(res, 400, {
                ok: false,
                error:
                  '没有识别到受支持的框架（Playwright / pytest / Selenium），请确认目录里是测试项目',
              });
            }
            const framework = requested || health.framework;
            if (!ADAPTER_IDS.includes(framework)) {
              return sendJson(res, 400, { ok: false, error: '请选择要使用的框架' });
            }
            const store = readStoreForWrite(root);
            if (store.projects.some((p) => path.resolve(p.dir) === dir)) {
              return sendJson(res, 409, { ok: false, error: '该目录已经添加过了' });
            }
            const id = `uia_${crypto.randomBytes(8).toString('hex')}`;
            const name = text(body.name, 200) || path.basename(dir);
            const project = {
              id,
              name,
              folder: uniqueFolder(store, name, id),
              dir,
              framework,
              createdAt: new Date().toISOString(),
              lastRunId: '',
              lastRunAt: '',
              lastStatus: '',
            };
            store.projects.push(project);
            writeStore(root, store);
            return sendJson(res, 200, {
              ok: true,
              project: {
                ...decorateProject(project, root),
                specFiles: listSpecFiles(project, framework),
                projectNames: latestProjectNames(store, project.id),
              },
            });
          }

          if (method === 'PATCH' && tail === '/projects') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const store = readStoreForWrite(root);
            const project = findProject(store, text(body.id, 64));
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const name = text(body.name, 200);
            // 只改展示名：folder 在创建时定死，报告 / 日志目录与历史链接都不受影响
            if (name) project.name = name;
            if (typeof body.framework === 'string' && body.framework.trim()) {
              const next = text(body.framework, 40);
              if (!ADAPTER_IDS.includes(next)) {
                return sendJson(res, 400, { ok: false, error: `不支持的框架：${next}` });
              }
              project.framework = next;
            }
            if (typeof body.dir === 'string' && body.dir.trim()) {
              const dir = path.resolve(text(body.dir, 4096));
              const health = detectProject(dir, project.framework);
              if (!health.exists) return sendJson(res, 400, { ok: false, error: '目录不存在' });
              if (!health.mountable) {
                return sendJson(res, 400, {
                  ok: false,
                  error:
                    '没有识别到受支持的框架（Playwright / pytest / Selenium），请确认目录里是测试项目',
                });
              }
              project.dir = dir;
              if (!body.framework) project.framework = health.framework || project.framework;
            }
            // 运行配置面板整组提交：名称 + 命令，空数组等于清空自定义任务
            if (Array.isArray(body.customTasks)) {
              project.customTasks = normalizeCustomTasks(body.customTasks);
            }
            if (Array.isArray(body.taskOverrides)) {
              project.taskOverrides = normalizeTaskOverrides(body.taskOverrides);
            }
            if (Array.isArray(body.hiddenTasks)) {
              project.hiddenTasks = normalizeHiddenTaskIds(body.hiddenTasks);
            }
            // 生成页的起始地址 / 提示词：按项目保存，下次自动带出来
            if (typeof body.baseURL === 'string') {
              project.baseURL = text(body.baseURL, 500);
            }
            if (typeof body.promptFile === 'string') {
              project.promptFile = text(body.promptFile, 200);
            }
            // 登录态文件也按项目存：换项目重新识别，不会沿用上一个项目的 cookie 文件
            if (typeof body.storageState === 'string') {
              project.storageState = text(body.storageState, 300);
            }
            // 记住这个项目默认用哪套环境（运行面板下拉的初始值）
            if (typeof body.envName === 'string') {
              project.envName = sanitizeEnvName(body.envName);
            }
            writeStore(root, store);
            return sendJson(res, 200, {
              ok: true,
              project: {
                ...decorateProject(project, root),
                specFiles: listSpecFiles(project, project.framework),
                projectNames: latestProjectNames(store, project.id),
              },
            });
          }

          if (method === 'DELETE' && tail === '/projects') {
            const id = text(parsed.searchParams.get('id'), 64);
            const store = readStoreForWrite(root);
            const project = findProject(store, id);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if ([...RUNNING.values()].some((entry) => entry.projectId === id)) {
              return sendJson(res, 409, { ok: false, error: '项目正在运行，请先停止再移出列表' });
            }
            if (SETUPS.has(id)) {
              return sendJson(res, 409, {
                ok: false,
                error: '项目正在安装依赖，请先停止再移出列表',
              });
            }
            store.projects = store.projects.filter((p) => p.id !== id);
            writeStore(root, store);
            return sendJson(res, 200, { ok: true });
          }

          /* ── 项目 Node 版本：读 .nvmrc / engines，列出本机已装版本 ── */

          if (method === 'GET' && tail === '/project/node') {
            const projectId = text(parsed.searchParams.get('projectId'), 64);
            const project = findProject(readStore(root).store, projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }
            return sendJson(res, 200, { ok: true, ...nodeStatus(project.dir), error: '' });
          }

          // 改项目 Node：只写 `.nvmrc`（engines 是产出物，不在这里改）
          if (method === 'POST' && tail === '/project/node') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const store = readStoreForWrite(root);
            const project = findProject(store, text(body.projectId, 64));
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }
            try {
              writeNvmrc(project.dir, body.version);
            } catch (error) {
              return sendJson(res, 400, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return sendJson(res, 200, { ok: true, ...nodeStatus(project.dir), error: '' });
          }

          /* ── 装一个本机还没有的 Node 版本：后台跑 nvm / fnm / volta，日志轮询 ── */

          if (method === 'POST' && tail === '/project/node/install') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const projectId = text(body.projectId, 64);
            const version = text(body.version, 40);
            if (!projectId) return sendJson(res, 400, { ok: false, error: '缺少项目 id' });
            if (!version) return sendJson(res, 400, { ok: false, error: '缺少要安装的版本号' });
            const project = findProject(readStore(root).store, projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }
            const started = startNodeInstall(root, projectId, version);
            if (started.error) {
              return sendJson(res, started.status ?? 400, { ok: false, error: started.error });
            }
            return sendJson(res, 200, { ok: true, ...readNodeInstall(projectId), error: '' });
          }

          if (method === 'GET' && tail === '/project/node/install') {
            const projectId = text(parsed.searchParams.get('projectId'), 64);
            if (!projectId) return sendJson(res, 400, { ok: false, error: '缺少项目 id' });
            return sendJson(res, 200, { ok: true, ...readNodeInstall(projectId), error: '' });
          }

          if (method === 'POST' && tail === '/project/node/install/stop') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const projectId = text(body.projectId, 64);
            if (!projectId) return sendJson(res, 400, { ok: false, error: '缺少项目 id' });
            const stopped = stopNodeInstall(projectId);
            return sendJson(res, 200, {
              ok: true,
              stopped,
              ...readNodeInstall(projectId),
              error: '',
            });
          }

          /* ── 项目环境配置：读写项目里的 .env / .env.<ENV> ── */

          if (method === 'GET' && tail === '/project/env') {
            const projectId = text(parsed.searchParams.get('projectId'), 64);
            const store = readStore(root).store;
            const project = findProject(store, projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if (!fs.existsSync(project.dir)) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }
            const requested = text(parsed.searchParams.get('env'), 40);
            const scanned = scanEnvFiles(project.dir);
            // 显式传了 env（包括空串 = 共用 .env）就照办；没传才按「项目记住的 → 目录里第一个 → .env」。
            // 面板默认落在 `.env.example`，这里只负责给出一个可用环境，不再凭空造 test。
            const env = parsed.searchParams.has('env')
              ? sanitizeEnvName(requested)
              : project.envName || scanned[0]?.env || '';
            const file = envFilePath(project.dir, env);
            let content = '';
            try {
              if (file && fs.existsSync(file)) content = fs.readFileSync(file, 'utf8');
            } catch (error) {
              return sendJson(res, 500, {
                ok: false,
                error: `读取环境文件失败：${error instanceof Error ? error.message : String(error)}`,
              });
            }
            const parsedEnv = parseEnvText(content);
            // 老项目模板叫 `.env.dev.example` / `.env.uat.example`：读一次就归一到 `.env.example`
            migrateLegacyExampleFile(project.dir);
            const exampleFile = envExampleFile(project.dir);
            // 模板原文一起带回去：打开「还没创建的环境」时可以直接预填（保存即创建）
            let exampleText = '';
            if (exampleFile) {
              try {
                exampleText = fs.readFileSync(exampleFile, 'utf8').slice(0, 256 * 1024);
              } catch {
                exampleText = '';
              }
            }
            return sendJson(res, 200, {
              ok: true,
              env,
              file: envFileName(env),
              exists: Boolean(file && fs.existsSync(file)),
              entries: maskEnvEntries(parsedEnv.entries),
              // 原文：面板按文本编辑，注释与空行原样保留
              text: content.slice(0, 256 * 1024),
              // 平台只约定这 3 条；其余字段与分组由项目自己的 .env.example 决定
              platformKeys: PLATFORM_ENV_KEYS,
              schema: readEnvSchema(project.dir),
              example: {
                file: exampleFile ? path.basename(exampleFile) : '.env.example',
                exists: Boolean(exampleFile),
                text: exampleText,
              },
              crossEnv: readEnvKeyMatrix(project.dir, env),
              envs: scanned.map((item) => ({ env: item.env, file: item.file })),
              authFiles: listAuthStateFiles(project.dir),
              supported: project.framework === 'playwright',
              hasConvention: hasEnvConvention(project.dir),
              defaultEnv: project.envName,
              error: '',
            });
          }

          // 环境文件原文：面板按文本编辑（注释、分组、空行原样保留）
          if (method === 'GET' && tail === '/project/env/text') {
            const projectId = text(parsed.searchParams.get('projectId'), 64);
            const project = findProject(readStore(root).store, projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }
            const env = sanitizeEnvName(parsed.searchParams.get('env'));
            if (String(parsed.searchParams.get('env') ?? '').trim() && !env) {
              return sendJson(res, 400, { ok: false, error: '环境名不合法' });
            }
            const file = envFilePath(project.dir, env);
            if (!file || !isPathInside(project.dir, file)) {
              return sendJson(res, 400, { ok: false, error: '环境文件路径不合法' });
            }
            let content = '';
            let exists = false;
            if (fs.existsSync(file)) {
              try {
                content = fs.readFileSync(file, 'utf8');
                exists = true;
              } catch (error) {
                return sendJson(res, 500, {
                  ok: false,
                  error: `读取环境文件失败：${error instanceof Error ? error.message : String(error)}`,
                });
              }
            }
            return sendJson(res, 200, {
              ok: true,
              env,
              file: envFileName(env),
              exists,
              text: content.slice(0, 256 * 1024),
            });
          }

          // 环境文件按原文写回：改一处值不用重排其它行；ENV 强制跟文件名一致
          if (method === 'POST' && tail === '/project/env/text') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const store = readStoreForWrite(root);
            const project = findProject(store, text(body.projectId, 64));
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }
            const rawEnv = String(body.env ?? '').trim();
            const env = sanitizeEnvName(rawEnv);
            if (rawEnv && !env) {
              return sendJson(res, 400, {
                ok: false,
                error: '环境名只能用字母、数字、下划线与短横线，且以小写字母开头',
              });
            }
            if (String(body.text ?? '').length > 256 * 1024) {
              return sendJson(res, 400, { ok: false, error: '内容过长（上限 256KB）' });
            }
            const file = envFilePath(project.dir, env);
            if (!file || !isPathInside(project.dir, file)) {
              return sendJson(res, 400, { ok: false, error: '环境文件路径不合法' });
            }
            // 非空环境：文件里的 ENV 由文件名决定，写回时纠正掉手改的 ENV
            const nextText = env
              ? patchEnvText(String(body.text ?? ''), { ENV: env }, [])
              : String(body.text ?? '');
            const entriesMap = Object.fromEntries(
              parseEnvText(nextText).entries.map((entry) => [entry.key, entry.value]),
            );
            const validation = validateEnvEntries(entriesMap, env);
            if (validation.errors.length) {
              return sendJson(res, 400, {
                ok: false,
                error: validation.errors[0].message,
                validation,
              });
            }
            try {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
              fs.writeFileSync(tmp, nextText, { encoding: 'utf8', mode: 0o600 });
              fs.renameSync(tmp, file);
              try {
                fs.chmodSync(file, 0o600);
              } catch {
                // 某些文件系统不改权限，忽略
              }
            } catch (error) {
              return sendJson(res, 500, {
                ok: false,
                error: `写入环境文件失败：${error instanceof Error ? error.message : String(error)}`,
              });
            }
            let projectView;
            if (typeof body.makeDefault === 'boolean') {
              if (body.makeDefault && env) project.envName = env;
              else if (!body.makeDefault && project.envName === env) project.envName = '';
              writeStore(root, store);
              projectView = decorateProject(project, root);
            }
            return sendJson(res, 200, {
              ok: true,
              env,
              file: envFileName(env),
              exists: true,
              text: nextText,
              envs: scanEnvFiles(project.dir).map((item) => ({ env: item.env, file: item.file })),
              authFiles: listAuthStateFiles(project.dir),
              validation,
              project: projectView,
            });
          }

          // 模板文件（schema）原文：`.env.example` 这类文件在面板里按文本编辑
          if (method === 'GET' && tail === '/project/env/file') {
            const projectId = text(parsed.searchParams.get('projectId'), 64);
            const fileName = text(parsed.searchParams.get('file'), 64) || '.env.example';
            const project = findProject(readStore(root).store, projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if (!isExampleFileName(fileName)) {
              return sendJson(res, 400, { ok: false, error: '只能读写 .env*.example 模板文件' });
            }
            if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }
            const abs = path.join(project.dir, fileName);
            if (!isPathInside(project.dir, abs)) {
              return sendJson(res, 400, { ok: false, error: '路径不合法' });
            }
            let content = '';
            let exists = false;
            try {
              if (fs.existsSync(abs)) {
                exists = true;
                content = fs.readFileSync(abs, 'utf8');
              }
            } catch (error) {
              return sendJson(res, 500, {
                ok: false,
                error: `读取模板失败：${error instanceof Error ? error.message : String(error)}`,
              });
            }
            return sendJson(res, 200, {
              ok: true,
              file: fileName,
              exists,
              text: content.slice(0, 256 * 1024),
            });
          }

          if (method === 'POST' && tail === '/project/env/file') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const project = findProject(readStore(root).store, text(body.projectId, 64));
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const fileName = text(body.file, 64) || '.env.example';
            if (!isExampleFileName(fileName)) {
              return sendJson(res, 400, { ok: false, error: '只能读写 .env*.example 模板文件' });
            }
            if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }
            const nextText = String(body.text ?? '');
            if (nextText.length > 256 * 1024) {
              return sendJson(res, 400, { ok: false, error: '模板内容过长（上限 256KB）' });
            }
            const abs = path.join(project.dir, fileName);
            if (!isPathInside(project.dir, abs)) {
              return sendJson(res, 400, { ok: false, error: '路径不合法' });
            }
            try {
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
              fs.writeFileSync(tmp, nextText, { encoding: 'utf8', mode: 0o600 });
              fs.renameSync(tmp, abs);
              try {
                fs.chmodSync(abs, 0o600);
              } catch {
                // 某些文件系统不改权限，忽略
              }
            } catch (error) {
              return sendJson(res, 500, {
                ok: false,
                error: `写入模板失败：${error instanceof Error ? error.message : String(error)}`,
              });
            }
            return sendJson(res, 200, { ok: true, file: fileName, exists: true, text: nextText });
          }

          // 删除环境：只删 `.env.<ENV>`，`.env` 与模板不允许从界面删
          if (method === 'POST' && tail === '/project/env/delete') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const store = readStoreForWrite(root);
            const project = findProject(store, text(body.projectId, 64));
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在，先重新指定目录' });
            }
            const rawEnv = String(body.env ?? '').trim();
            if (!rawEnv) {
              return sendJson(res, 400, {
                ok: false,
                error: '不能删除共用的 .env（环境名不能为空）',
              });
            }
            const env = sanitizeEnvName(rawEnv);
            if (!env) return sendJson(res, 400, { ok: false, error: '环境名不合法' });
            // 骨架自带的 `.env`（上面已拦）与 `.env.prod` 不给删：只允许删用户新建的环境
            if (isSkeletonEnv(env)) {
              return sendJson(res, 400, {
                ok: false,
                error: `骨架自带的 ${envFileName(env)} 不能删除，只允许删除新建的环境`,
              });
            }
            const file = envFilePath(project.dir, env);
            if (!file || !isPathInside(project.dir, file)) {
              return sendJson(res, 400, { ok: false, error: '环境文件路径不合法' });
            }
            if (!fs.existsSync(file)) {
              return sendJson(res, 404, { ok: false, error: `${envFileName(env)} 不存在` });
            }
            try {
              fs.unlinkSync(file);
            } catch (error) {
              return sendJson(res, 500, {
                ok: false,
                error: `删除环境文件失败：${error instanceof Error ? error.message : String(error)}`,
              });
            }
            // 删的正好是项目默认环境：默认值一并清掉，避免运行条指着一个不存在的文件
            let projectView;
            if (project.envName === env) {
              project.envName = '';
              writeStore(root, store);
              projectView = decorateProject(project, root);
            }
            return sendJson(res, 200, {
              ok: true,
              removed: envFileName(env),
              envs: scanEnvFiles(project.dir).map((item) => ({ env: item.env, file: item.file })),
              project: projectView,
              error: '',
            });
          }

          if (method === 'POST' && tail === '/project/env/clear-auth') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const store = readStore(root).store;
            const project = findProject(store, text(body.projectId, 64));
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            if (!fs.existsSync(project.dir)) {
              return sendJson(res, 400, { ok: false, error: '项目目录已不存在' });
            }
            // 只删登录态文件本身，不动目录；换环境后 cookie 通常已经失效
            const removed = [];
            for (const rel of ['.auth/admin.json', '.auth/user.json']) {
              const abs = path.join(project.dir, rel);
              if (!isPathInside(project.dir, abs) || !fs.existsSync(abs)) continue;
              try {
                fs.unlinkSync(abs);
                removed.push(rel);
              } catch {
                // 删不掉就跳过，界面上会显示还没清掉
              }
            }
            return sendJson(res, 200, {
              ok: true,
              removed,
              authFiles: listAuthStateFiles(project.dir),
            });
          }

          if (method === 'POST' && tail === '/run') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const result = startRun(root, body);
            if (result.error)
              return sendJson(res, result.status, { ok: false, error: result.error });
            return sendJson(res, 200, { ok: true, ...result });
          }

          if (method === 'POST' && tail === '/stop') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const runId = text(body.runId, 64);
            if (!runId) return sendJson(res, 400, { ok: false, error: '缺少 runId' });
            if (!stopRun(runId)) {
              return sendJson(res, 409, { ok: false, error: '该运行已结束或不在本进程中' });
            }
            return sendJson(res, 200, { ok: true });
          }

          if (method === 'POST' && tail === '/run/allure') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const runId = text(body.runId, 64);
            if (!runId) return sendJson(res, 400, { ok: false, error: '缺少 runId' });
            const result = await generateAllureReport(root, runId);
            if (result.status)
              return sendJson(res, result.status, { ok: false, error: result.error });
            return sendJson(res, 200, result);
          }

          if (method === 'GET' && tail === '/run') {
            const id = text(parsed.searchParams.get('id'), 64);
            const offset = intOr(parsed.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
            const store = readStore(root).store;
            const run = findRun(store, id);
            if (!run) return sendJson(res, 404, { ok: false, error: '运行记录不存在' });
            const entry = RUNNING.get(id);
            if (!entry) {
              // 已结束：从日志文件尾部补一段，刷新页面后仍能看到上次输出
              let log = '';
              let reset = false;
              if (run.logRel) {
                const abs = path.join(uiautoStorePaths(root).dir, run.logRel);
                if (isPathInside(uiautoStorePaths(root).dir, abs)) {
                  try {
                    const stat = fs.statSync(abs);
                    const start = Math.max(0, stat.size - MAX_PREVIEW_BYTES);
                    const buffer = Buffer.alloc(stat.size - start);
                    const fd = fs.openSync(abs, 'r');
                    try {
                      fs.readSync(fd, buffer, 0, buffer.length, start);
                    } finally {
                      fs.closeSync(fd);
                    }
                    log = buffer.toString('utf8');
                    reset = true;
                  } catch {
                    log = '';
                  }
                }
              }
              return sendJson(res, 200, {
                ok: true,
                run: runView(run),
                stopping: false,
                log,
                nextOffset: 0,
                reset,
              });
            }
            const reset = offset < entry.logStart;
            const from = Math.max(offset, entry.logStart);
            return sendJson(res, 200, {
              ok: true,
              run: runView(run),
              stopping: entry.stopping,
              log: entry.log.slice(from - entry.logStart),
              nextOffset: entry.logStart + entry.log.length,
              reset,
            });
          }

          if (method === 'GET' && tail === '/runs') {
            const projectId = text(parsed.searchParams.get('projectId'), 64);
            const store = readStore(root).store;
            const runs = store.runs
              .filter((run) => !projectId || run.projectId === projectId)
              .slice()
              .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
              .map(runView);
            return sendJson(res, 200, { ok: true, runs });
          }

          if (method === 'DELETE' && tail === '/run') {
            const id = text(parsed.searchParams.get('id'), 64);
            if (RUNNING.has(id)) {
              return sendJson(res, 409, { ok: false, error: '运行中，不能删除' });
            }
            const store = readStoreForWrite(root);
            const run = findRun(store, id);
            if (!run) return sendJson(res, 404, { ok: false, error: '运行记录不存在' });
            removeRunArtifacts(root, run);
            store.runs = store.runs.filter((r) => r.id !== id);
            const project = findProject(store, run.projectId);
            if (project && project.lastRunId === id) {
              const latest = store.runs
                .filter((r) => r.projectId === project.id)
                .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
              project.lastRunId = latest?.id ?? '';
              project.lastRunAt = latest?.startedAt ?? '';
              project.lastStatus = latest?.status ?? '';
            }
            writeStore(root, store);
            return sendJson(res, 200, { ok: true });
          }

          /* ==================== AI 生成：浏览器探索 ==================== */

          /** 生成会话与应用图标属于本机数据，放 `.lantern/local/uiauto`，不落进项目目录 */
          const agentBaseDir = uiautoCachePaths(root).dir;

          /** 应用图标缓存目录：抽一次存下来，下次直接读 */
          const appIconDir = path.join(agentBaseDir, 'app-icons');

          /** 项目的 playwright 配置里有没有 baseURL（没有时只给 config 补丁建议） */
          const projectHasBaseURL = (dir) => {
            const name = findPlaywrightConfig(dir);
            if (!name) return false;
            try {
              return /baseURL\s*:/.test(fs.readFileSync(path.join(dir, name), 'utf8'));
            } catch {
              return false;
            }
          };

          const agentProject = (projectId) => {
            const store = readStore(root).store;
            return findProject(store, projectId);
          };

          const requireExplorer = async (sessionId) => {
            const record = readGeneratedSession(agentBaseDir, sessionId);
            if (!record) throw new Error('生成会话不存在');
            const project = agentProject(record.projectId);
            if (!project) throw new Error('项目不存在或已移出挂载列表');
            if (!hasExplorer(sessionId)) {
              await startExplorer({
                baseDir: agentBaseDir,
                project,
                sessionId,
                baseURL: record.baseURL || '',
                headed: record.headed !== false,
                storageState: record.storageState || '',
              });
              // 浏览器起得来才算真的在探索；失败时不改状态，前端能看出会话还停在草稿
              if (record.status !== 'exploring') {
                saveGeneratedSession(agentBaseDir, { id: sessionId, status: 'exploring' });
              }
            }
            return { record, project };
          };

          if (method === 'GET' && tail.startsWith('/agent/shot/')) {
            const rest = tail.slice('/agent/shot/'.length);
            const slash = rest.indexOf('/');
            const sessionId = slash === -1 ? '' : rest.slice(0, slash);
            const file = slash === -1 ? '' : decodeURIComponent(rest.slice(slash + 1));
            if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^[\w.-]+\.png$/.test(file)) {
              return sendJson(res, 400, { ok: false, error: '截图路径不合法' });
            }
            const dir = sessionShotsDir(agentBaseDir, sessionId);
            const abs = path.join(dir, file);
            if (!isPathInside(dir, abs) || !fs.existsSync(abs)) {
              return sendJson(res, 404, { ok: false, error: '截图不存在' });
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'no-store');
            fs.createReadStream(abs).pipe(res);
            return;
          }

          /** 建 / 复用生成会话（不启动浏览器）：规划步骤、改计划都先落在会话上 */
          const createAgentSession = (body) => {
            const existingId = text(body.sessionId, 64);
            const existing = existingId ? readGeneratedSession(agentBaseDir, existingId) : null;
            const project = agentProject(text(body.projectId, 64) || existing?.projectId || '');
            if (!project) return { error: '项目不存在' };
            const requestedStorage = text(body.storageState, 300);
            // 项目上记的登录态可能是 `-`（用户明确不要登录态），别把它当路径传下去
            const projectStorage = text(project.storageState, 300);
            const rememberStorage = projectStorage === '-' ? '' : projectStorage;
            // 优先级：面板这次提交的值 → 项目上记的 → 上次会话用的 → 自动探测
            // （项目配置优先，避免刚在面板改完又被旧会话里的文件顶回去）
            const storageState =
              requestedStorage === '-'
                ? ''
                : requestedStorage ||
                  rememberStorage ||
                  (existing?.projectId === project.id ? existing.storageState : '') ||
                  safeDetectStorageState(project.dir);
            const target = text(body.target, 16);
            // 起始地址：请求里带了就以请求为准（用户可能刚改），否则用项目记的 / 项目配置里探测到的
            const baseURL =
              text(body.baseURL, 500) || project.baseURL || safeDetectBaseURL(project.dir) || '';
            // 重新规划 / 重新探索：上一轮的步骤与试跑结果作废，否则旧 IR 会被当成这次的产出
            // （代码页与试跑都显示上一轮内容）。活动日志不跟着清：它按时间累积，
            // 用户想看上一轮跑到哪一步；要清由「清除活动日志」显式传 clearActivity。
            const reset = body.reset === true;
            const clearActivity = body.clearActivity === true;
            if (existing && existing.projectId === project.id) {
              const session = saveGeneratedSession(agentBaseDir, {
                id: existing.id,
                title: text(body.title, 200) || existing.title,
                target: target === 'python' ? 'python' : target === 'ts' ? 'ts' : undefined,
                baseURL: baseURL || existing.baseURL,
                storageState,
                source: text(body.source, 4000) || existing.source,
                headed: typeof body.headed === 'boolean' ? body.headed : existing.headed,
                plan: Array.isArray(body.plan) ? body.plan : undefined,
                ...(reset
                  ? { ir: null, lastVerify: null, savedPath: '', status: 'draft' }
                  : {
                      // 已写入 / 已试跑通过的会话不要被打回草稿
                      status:
                        existing.status === 'written' || existing.status === 'verified'
                          ? existing.status
                          : existing.status === 'exploring'
                            ? 'exploring'
                            : 'draft',
                    }),
                ...(clearActivity ? { activity: [] } : {}),
              });
              return { project, session };
            }
            const session = saveGeneratedSession(agentBaseDir, {
              projectId: project.id,
              title: text(body.title, 200) || '未命名流程',
              target: target === 'python' ? 'python' : 'ts',
              baseURL,
              storageState,
              source: text(body.source, 4000),
              headed: body.headed !== false,
              plan: Array.isArray(body.plan) ? body.plan : undefined,
              status: 'draft',
            });
            return { project, session };
          };

          if (method === 'POST' && tail === '/agent/prepare') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const created = createAgentSession(body);
            if (created.error) return sendJson(res, 404, { ok: false, error: created.error });
            cleanupStaleDrafts(created.project.dir);
            return sendJson(res, 200, {
              ok: true,
              session: created.session,
              suggestedPath: suggestedPath({ project: created.project, session: created.session }),
              draft: draftSummary({ project: created.project, session: created.session }),
            });
          }

          if (method === 'POST' && tail === '/agent/start') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const created = createAgentSession(body);
            if (created.error) return sendJson(res, 404, { ok: false, error: created.error });
            const { project, session } = created;
            const started = saveGeneratedSession(agentBaseDir, {
              id: session.id,
              status: 'exploring',
            });
            await startExplorer({
              baseDir: agentBaseDir,
              project,
              sessionId: started.id,
              baseURL: started.baseURL,
              headed: started.headed,
              storageState: started.storageState,
            });
            return sendJson(res, 200, {
              ok: true,
              session: started,
              suggestedPath: suggestedPath({ project, session: started }),
            });
          }

          if (method === 'POST' && tail === '/agent/open') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            await requireExplorer(sessionId);
            const result = await callExplorer(sessionId, 'open', { url: text(body.url, 2000) });
            return sendJson(res, 200, { ok: true, ...result });
          }

          if (method === 'POST' && tail === '/agent/snapshot') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            await requireExplorer(sessionId);
            const result = await callExplorer(sessionId, 'snapshot', {
              depth: intOr(body.depth, 6, 1, 20),
              targetRef: text(body.targetRef, 32),
            });
            return sendJson(res, 200, { ok: true, ...result });
          }

          if (method === 'POST' && tail === '/agent/action') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            await requireExplorer(sessionId);
            const result = await callExplorer(
              sessionId,
              'action',
              {
                action: text(body.action, 32),
                ref: text(body.ref, 32),
                text: typeof body.text === 'string' ? body.text.slice(0, 4000) : '',
                value: typeof body.value === 'string' ? body.value.slice(0, 4000) : '',
                key: text(body.key, 40),
                note: text(body.note, 200),
                snapshot: body.snapshot !== false,
                settle: intOr(body.settle, 300, 0, 10000),
              },
              90000,
            );
            return sendJson(res, 200, { ok: true, ...result });
          }

          if (method === 'POST' && tail === '/agent/probe') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            await requireExplorer(sessionId);
            const result = await callExplorer(sessionId, 'probe', { ref: text(body.ref, 32) });
            // 带 stepId 时顺手把定位器回填到左侧计划，省得模型再写一遍
            const stepId = text(body.stepId, 40);
            let plan = null;
            let planStep = null;
            if (stepId) {
              const record = readGeneratedSession(agentBaseDir, sessionId);
              if (record) {
                plan = bindPlanStep(record.plan || [], stepId, result);
                const saved = saveGeneratedSession(agentBaseDir, { id: sessionId, plan });
                plan = saved.plan;
                planStep = plan.find((step) => step.id === stepId) ?? null;
              }
            }
            return sendJson(res, 200, {
              ok: true,
              ...result,
              warning: result.warning ?? '',
              plan,
              planStep,
            });
          }

          if (method === 'POST' && (tail === '/agent/console' || tail === '/agent/network')) {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            // 控制台 / 网络是「读」操作：没有在跑的浏览器就直接回空表。
            // 这里以前走 requireExplorer，导致前端一切到这个 Tab（含 HMR 重载后恢复）
            // 就凭空拉起一个有头浏览器窗口（baseURL 不可达时停在 about:blank）。
            if (!hasExplorer(sessionId)) {
              return sendJson(res, 200, {
                ok: true,
                messages: [],
                requests: [],
                running: false,
              });
            }
            const cmd = tail === '/agent/console' ? 'console' : 'network';
            const result = await callExplorer(sessionId, cmd, {});
            return sendJson(res, 200, { ok: true, ...result });
          }

          if (method === 'POST' && tail === '/agent/wait') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            await requireExplorer(sessionId);
            const result = await callExplorer(
              sessionId,
              'waitFor',
              {
                text: text(body.text, 200),
                ms: intOr(body.ms, 500, 0, 15000),
                timeout: intOr(body.timeout, 15000, 1000, 60000),
              },
              90000,
            );
            return sendJson(res, 200, { ok: true, ...result });
          }

          if (method === 'POST' && tail === '/agent/screenshot') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            await requireExplorer(sessionId);
            const result = await callExplorer(sessionId, 'screenshot', {
              label: text(body.label, 60),
              fullPage: Boolean(body.fullPage),
            });
            return sendJson(res, 200, {
              ok: true,
              ...result,
              url: `${PREFIX}/agent/shot/${sessionId}/${encodeURIComponent(result.file)}`,
            });
          }

          if (method === 'POST' && tail === '/agent/close') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            const stopped = stopExplorer(sessionId);
            const record = readGeneratedSession(agentBaseDir, sessionId);
            if (record && record.status === 'exploring') {
              saveGeneratedSession(agentBaseDir, { id: sessionId, status: 'draft' });
            }
            return sendJson(res, 200, { ok: true, stopped });
          }

          if (method === 'POST' && tail === '/agent/save') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            if (!sessionId) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' });
            const existing = readGeneratedSession(agentBaseDir, sessionId);
            if (!existing) return sendJson(res, 404, { ok: false, error: '生成会话不存在' });
            const project = agentProject(existing.projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            // 模型提交的计划只合并、不覆盖：用户手改的步骤不能被模型重写掉。
            // 空计划默认不落盘（前端丢状态时最怕把整份计划冲掉），
            // 用户在计划里删到空要显式带 allowEmptyPlan。
            const planPatch = Array.isArray(body.plan) ? body.plan : undefined;
            const nextPlan =
              planPatch === undefined
                ? undefined
                : body.mergePlan === true
                  ? mergePlanWithModel(existing.plan, planPatch)
                  : planPatch.length || body.allowEmptyPlan === true
                    ? planPatch
                    : existing.plan || [];
            const saved = saveGeneratedSession(agentBaseDir, {
              id: sessionId,
              title: text(body.title, 200) || existing.title,
              target: body.target === 'python' ? 'python' : body.target === 'ts' ? 'ts' : undefined,
              baseURL:
                typeof body.baseURL === 'string' ? text(body.baseURL, 500) : existing.baseURL,
              source: typeof body.source === 'string' ? text(body.source, 4000) : existing.source,
              ir: body.ir ? body.ir : existing.ir,
              plan: nextPlan,
              activity: Array.isArray(body.activity)
                ? body.replaceActivity === true
                  ? body.activity
                  : mergeActivityLog(existing.activity, body.activity)
                : undefined,
              status: text(body.status, 40) || existing.status,
            });
            const emitted = emitCode(saved.ir || {}, saved.target);
            return sendJson(res, 200, {
              ok: true,
              session: saved,
              code: emitted.code,
              filename: emitted.filename,
              suggestedPath: suggestedPath({ project, session: saved }),
            });
          }

          if (method === 'POST' && tail === '/agent/emit') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const emitted = emitCode(body.ir || {}, body.target);
            // 多文件：同一份 IR 拆成 spec + page object（+ fixture），旧字段保留给单文件调用点
            const project = body.projectId ? agentProject(text(body.projectId, 64)) : null;
            // 布局按项目实际目录判定：企业级骨架在根级 pages/，老项目在 tests/pages/
            const layout = project
              ? detectEmitLayout(project.dir, text(body.testDir, 200))
              : {
                  testDir: text(body.testDir, 200) || 'tests',
                  pagesDir: '',
                  fixturesDir: '',
                };
            const multi = emitFiles(body.ir || {}, body.target, {
              testDir: layout.testDir,
              pagesDir: layout.pagesDir || undefined,
              fixturesDir: layout.fixturesDir || undefined,
              tag: text(body.tag, 40),
              hasBaseURL: Boolean(body.hasBaseURL),
            });
            return sendJson(res, 200, {
              ok: true,
              code: emitted.code,
              filename: emitted.filename,
              language: emitted.language,
              files: multi.files,
              configPatch: multi.configPatch,
            });
          }

          if (method === 'POST' && tail === '/agent/verify') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            let record = readGeneratedSession(agentBaseDir, sessionId);
            if (!record) return sendJson(res, 404, { ok: false, error: '生成会话不存在' });
            if (body.ir) {
              record = saveGeneratedSession(agentBaseDir, {
                id: sessionId,
                ir: body.ir,
                target:
                  body.target === 'python' ? 'python' : body.target === 'ts' ? 'ts' : undefined,
              });
            }
            const project = agentProject(record.projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const result = await verifySession({
              project,
              session: record,
              timeoutMs: intOr(body.timeoutMs, 180000, 10000, 600000),
            });
            saveGeneratedSession(agentBaseDir, {
              id: sessionId,
              status: result.passed ? 'verified' : 'failed',
              ir: record.ir,
              lastVerify: {
                at: new Date().toISOString(),
                passed: Boolean(result.passed),
                exitCode: result.exitCode ?? null,
                durationMs: result.durationMs ?? 0,
                log: String(result.log ?? '').slice(-4000),
              },
            });
            return sendJson(res, 200, {
              ...result,
              suggestedPath: suggestedPath({ project, session: record }),
            });
          }

          if (method === 'POST' && tail === '/agent/write') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            let record = readGeneratedSession(agentBaseDir, sessionId);
            if (!record) return sendJson(res, 404, { ok: false, error: '生成会话不存在' });
            const project = agentProject(record.projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });

            // 前端没给文件时按会话实时出码（含 page object），保证写的就是当前步骤
            let files = Array.isArray(body.files) ? body.files : [];
            if (!files.length) {
              if (!record.ir?.steps?.length) {
                return sendJson(res, 409, { ok: false, error: '还没有生成步骤，先探索或试跑一次' });
              }
              const emitted = emitFiles(record.ir || {}, record.target, {
                ...detectEmitLayout(project.dir),
                hasBaseURL: projectHasBaseURL(project.dir),
              });
              files = emitted.files;
            }

            const result = writeGeneratedFiles({
              project,
              session: record,
              files: files.map((item) => ({
                path: text(item.path, 500),
                content: String(item.content ?? ''),
                force: Boolean(item.force),
                role: text(item.role, 20),
              })),
              force: Boolean(body.force),
            });
            if (result.ok) {
              const savedPaths = result.paths.slice();
              // 主用例（spec）优先，试跑 / 验收 / 打开草稿都从它出发
              const spec = files.find((item) => item.role === 'spec')?.path || savedPaths[0] || '';
              record = saveGeneratedSession(agentBaseDir, {
                id: sessionId,
                status: 'written',
                savedPath: spec,
                savedPaths,
                changes: result.changes,
              });
            }
            return sendJson(res, result.ok ? 200 : 409, {
              ...result,
              savedPaths: result.ok ? result.paths : undefined,
              suggestedPath: suggestedPath({ project, session: record }),
            });
          }

          if (method === 'POST' && tail === '/agent/debug') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            const record = readGeneratedSession(agentBaseDir, sessionId);
            if (!record) return sendJson(res, 404, { ok: false, error: '生成会话不存在' });
            const project = agentProject(record.projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const result = await debugSession({
              project,
              session: record,
              mode: body.mode === 'ui' ? 'ui' : 'headed',
            });
            return sendJson(res, 200, result);
          }

          if (method === 'POST' && tail === '/agent/debug/stop') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            return sendJson(res, 200, { ok: true, stopped: stopDebugSession(sessionId) });
          }

          if (method === 'GET' && tail === '/agent/changes') {
            const sessionId = text(parsed.searchParams.get('sessionId'), 64);
            const record = readGeneratedSession(agentBaseDir, sessionId);
            if (!record) return sendJson(res, 404, { ok: false, error: '生成会话不存在' });
            const project = agentProject(record.projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const git = await gitStatusSummary(project.dir);
            return sendJson(res, 200, {
              ok: true,
              changes: sessionChanges(record),
              git,
              draft: draftSummary({ project, session: record }),
            });
          }

          if (method === 'GET' && tail === '/agent/apps') {
            const apps = await listOpenApps();
            return sendJson(res, 200, {
              ok: true,
              apps: apps.map((app) => ({
                ...app,
                iconUrl: app.appPath
                  ? `${PREFIX}/agent/app-icon?id=${encodeURIComponent(app.id)}`
                  : '',
              })),
              defaultId: defaultOpenApp(apps),
            });
          }

          if (method === 'GET' && tail === '/agent/app-icon') {
            const id = text(parsed.searchParams.get('id'), 40);
            const apps = await listOpenApps();
            const app = apps.find((item) => item.id === id);
            if (!app) return sendJson(res, 404, { ok: false, error: '应用不存在' });
            const file = await appIcon(app, appIconDir);
            if (!file) return sendJson(res, 404, { ok: false, error: '没有可用图标' });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=604800');
            fs.createReadStream(file).pipe(res);
            return;
          }

          if (method === 'POST' && tail === '/agent/reveal') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            const record = sessionId ? readGeneratedSession(agentBaseDir, sessionId) : null;
            const project = agentProject(text(body.projectId, 64) || record?.projectId || '');
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const rel = text(body.path, 500);
            const abs = rel ? resolveInside(project.dir, rel) : project.dir;
            if (!abs) return sendJson(res, 400, { ok: false, error: '路径不合法' });
            if (!fs.existsSync(abs)) {
              return sendJson(res, 404, { ok: false, error: '文件还不存在，先试跑或写入项目' });
            }
            // trace 要用项目自带的 show-trace 打开，不能丢给解压软件
            if (/trace\.zip$/i.test(rel)) {
              const shown = showTrace({ project, relPath: rel });
              return sendJson(res, shown.ok ? 200 : 500, shown);
            }
            const apps = await listOpenApps();
            const wanted = text(body.app, 40);
            const app =
              apps.find((item) => item.id === wanted) ??
              apps.find((item) => item.id === defaultOpenApp(apps));
            try {
              await openWith({
                abs,
                dir: project.dir,
                app,
                line: Number(body.line) > 0 ? Number(body.line) : 0,
              });
              return sendJson(res, 200, { ok: true, path: rel || '.', app: app?.id ?? '' });
            } catch (e) {
              return sendJson(res, 500, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          if (method === 'POST' && tail === '/agent/run-file') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            const record = readGeneratedSession(agentBaseDir, sessionId);
            if (!record) return sendJson(res, 404, { ok: false, error: '生成会话不存在' });
            const project = agentProject(record.projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const result = await runProjectFile({
              project,
              session: record,
              relPath: text(body.path, 500) || record.savedPath || '',
              timeoutMs: intOr(body.timeoutMs, 180000, 10000, 600000),
            });
            return sendJson(res, 200, result);
          }

          if (method === 'POST' && tail === '/agent/draft/clean') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const sessionId = text(body.sessionId, 64);
            const record = readGeneratedSession(agentBaseDir, sessionId);
            if (!record) return sendJson(res, 404, { ok: false, error: '生成会话不存在' });
            const project = agentProject(record.projectId);
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            stopDebugSession(sessionId);
            cleanupDraft(project.dir, sessionId);
            return sendJson(res, 200, {
              ok: true,
              draft: draftSummary({ project, session: record }),
            });
          }

          if (method === 'GET' && tail === '/agent/sessions') {
            const projectId = text(parsed.searchParams.get('projectId'), 64);
            return sendJson(res, 200, {
              ok: true,
              sessions: listGeneratedSessions(agentBaseDir, projectId),
            });
          }

          if (method === 'GET' && tail === '/agent/session') {
            const id = text(parsed.searchParams.get('id'), 64);
            const record = readGeneratedSession(agentBaseDir, id);
            if (!record) return sendJson(res, 404, { ok: false, error: '生成会话不存在' });
            const project = agentProject(record.projectId);
            const emitted = emitCode(record.ir || {}, record.target);
            return sendJson(res, 200, {
              ok: true,
              session: record,
              code: emitted.code,
              filename: emitted.filename,
              suggestedPath: project ? suggestedPath({ project, session: record }) : '',
              exploring: hasExplorer(id),
              debugging: hasDebugSession(id),
              changes: sessionChanges(record),
              draft: project ? draftSummary({ project, session: record }) : null,
            });
          }

          if (method === 'DELETE' && tail === '/agent/session') {
            const id = text(parsed.searchParams.get('id'), 64);
            if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' });
            stopExplorer(id);
            stopDebugSession(id);
            const record = readGeneratedSession(agentBaseDir, id);
            const project = record ? agentProject(record.projectId) : null;
            if (project) cleanupDraft(project.dir, id);
            const dir = sessionsDir(agentBaseDir);
            const file = path.join(dir, `${id}.json`);
            if (!isPathInside(dir, file)) {
              return sendJson(res, 400, { ok: false, error: '路径不合法' });
            }
            fs.rmSync(file, { force: true });
            fs.rmSync(path.join(dir, id), { recursive: true, force: true });
            return sendJson(res, 200, { ok: true });
          }

          return next();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return sendJson(res, 500, { ok: false, error: message });
        }
      });
    },
  };
}
