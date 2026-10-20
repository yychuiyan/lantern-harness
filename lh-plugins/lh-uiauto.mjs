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
 * - 不自动安装依赖、不联网：只用项目自己的 `node_modules/.bin/playwright`，
 *   退而求其次 `npx --no-install playwright`；找不到就报「未安装」。
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
import { ensurePluginPrompt, pluginPromptPath, readPluginPrompt } from './plugin-prompts.mjs';
import {
  parseUiAutoPrompt,
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
import { hasReportEntry, snapshotReport } from './uiauto-report.mjs';
import {
  callExplorer,
  cleanupDraft,
  cleanupStaleDrafts,
  debugSession,
  detectBaseURL,
  detectStorageState,
  detectPlaywrightTestDir,
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
export const UIAUTO_STORE_FILE = '自动化测试.json';
/** 0.1.9 及之前的目录 / 文件名，读取时自动迁移 */
export const LEGACY_DIR_NAME = 'UI自动化';
export const LEGACY_STORE_FILE = 'UI自动化.json';
export const REPORT_DIR_NAME = '报告';
export const RESULT_DIR_NAME = '结果';
export const LOG_DIR_NAME = '日志';

export const MAX_CONCURRENT_RUNS = 2;
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
  const target = resolveContentRoot(root, UIAUTO_DIR_NAME).abs;
  const legacy = resolveContentRoot(root, LEGACY_DIR_NAME).abs;
  if (legacy === target) return target;
  if (!fs.existsSync(legacy)) return target;
  if (fs.existsSync(target)) {
    migrateLegacyDir(legacy, target);
    return target;
  }
  // 旧目录可能已经被分组（<组>/UI自动化）：在原位改名，别把它搬出分组
  const sibling = path.join(path.dirname(legacy), UIAUTO_DIR_NAME);
  migrateLegacyDir(legacy, sibling);
  if (fs.existsSync(sibling)) return sibling;
  migrateLegacyDir(legacy, target);
  return target;
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

export function uiautoStorePaths(root) {
  const dir = storeDir(root);
  return { dir, store: storeFilePath(dir) };
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

/** 项目在空间里的存放目录：自动化测试/<项目名>/{报告,结果,日志} */
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
  };
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
  };
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
  const fp = uiautoStorePaths(root).store;
  let store;
  try {
    store = normalizeStore(JSON.parse(fs.readFileSync(fp, 'utf8')));
  } catch {
    store = emptyStore();
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
 */
function migrateLegacyRunArtifacts(root, store) {
  const paths = uiautoStorePaths(root);
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
      const abs = path.join(paths.dir, rel);
      if (!isPathInside(paths.dir, abs)) continue;
      const parts = path.relative(paths.dir, abs).split(path.sep);
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
    const abs = path.join(paths.dir, name);
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
  return { store, dirty };
}

function writeStore(root, store) {
  const fp = uiautoStorePaths(root).store;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
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

function decorateProject(project) {
  const health = detectProject(project.dir, project.framework);
  const running = [...RUNNING.values()].find((entry) => entry.projectId === project.id);
  const customTasks = normalizeCustomTasks(project.customTasks);
  const probe = health.exists ? buildProbe(project.dir) : null;
  // 自动发现 → 套上用户在运行配置里改过的名称 / 命令，删掉的不再出现
  const detected = probe
    ? applyTaskOverrides(
        discoverRunTasks(probe, project.framework),
        project.taskOverrides,
        project.hiddenTasks,
      )
    : [];
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
    runTasks: [fullTask, ...detected.map(taskView), ...customToTasks(customTasks).map(taskView)],
    runningRunId: running ? running.runId : '',
  };
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
  const pid = entry.child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      if (signal === 'SIGKILL') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        entry.child.kill();
      }
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      entry.child.kill(signal);
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
  const env = {
    ...process.env,
    ...(resolved.env ?? {}),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };

  // 记录真实执行的命令行：任务运行时是 shell 命令串，全量运行时是命令 + 参数
  const commandLine = resolved.shell
    ? resolved.command
    : [resolved.command, ...(resolved.args ?? [])].join(' ');

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

  return { run: runView(run), command: commandLine, args: resolved.args };
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

          /* ── 提示词：与「提示词管理/Playwright提示词.md」联动 ── */

          if (method === 'GET' && tail === '/prompt') {
            // 允许按项目指定提示词文件（不同框架挂不同提示词）；只接受提示词目录里的文件名，
            // 传空 / 不存在时退回插件默认那份，避免把接口当任意文件读取
            const wanted = text(parsed.searchParams.get('file'), 200);
            const file = wanted && isPromptFileName(wanted) ? wanted : UI_AUTO_PROMPT_FILE;
            const content = readPluginPrompt(file, root);
            const sections = parseUiAutoPrompt(content);
            return sendJson(res, 200, {
              ok: true,
              file,
              exists: Boolean(content.trim()),
              plan: sections.plan,
              agent: sections.agent,
              code: sections.code,
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
            const out = ensurePluginPrompt(UI_AUTO_PROMPT_FILE, UI_AUTO_PROMPT_TEMPLATE, root);
            return sendJson(res, 200, {
              ok: true,
              enabled: true,
              created: out.created,
              updated: out.updated,
              exists: out.exists,
              file: out.file,
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
              ...decorateProject(project),
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
                ...decorateProject(project),
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
            writeStore(root, store);
            return sendJson(res, 200, {
              ok: true,
              project: {
                ...decorateProject(project),
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
            store.projects = store.projects.filter((p) => p.id !== id);
            writeStore(root, store);
            return sendJson(res, 200, { ok: true });
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
            const testDir = text(body.testDir, 200) || 'tests';
            const multi = emitFiles(body.ir || {}, body.target, {
              testDir,
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
                testDir: detectPlaywrightTestDir(project.dir),
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
