/**
 * 自动化测试（空间级）：挂载目标项目里已有的 Playwright，跑用例、看日志、看报告。
 *
 * 数据落在：
 * ```
 * <当前数据空间>/UI自动化/
 *   UI自动化.json        # { version, projects, runs }
 *   报告/<runId>/        # Playwright HTML report 直接写到这里
 *   结果/<runId>.json    # Playwright JSON reporter 原始结果
 *   日志/<runId>.log     # 原始 stdout / stderr
 * ```
 *
 * 约束：
 * - 不自动安装依赖、不联网：只用项目自己的 `node_modules/.bin/playwright`，
 *   退而求其次 `npx --no-install playwright`；找不到就报「未安装」。
 * - 项目目录只读：目录树 / 文件预览都限制在项目目录内，不做写操作。
 * - 同一项目同时只允许一个 run，全局最多 2 个。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { nativePickDirectory } from '../builtin/session/lh-fs.mjs';
import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot } from '../builtin/session/space-layout.mjs';

const PREFIX = '/__tb_uiauto';
const VERSION = 1;

/** 预加载守卫：给 Playwright 的 `--project` 参数让路（见文件内注释） */
const ARGV_GUARD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'uiauto-argv-guard.cjs',
);

export const UIAUTO_DIR_NAME = 'UI自动化';
export const UIAUTO_STORE_FILE = 'UI自动化.json';
export const REPORT_DIR_NAME = '报告';
export const RESULT_DIR_NAME = '结果';
export const LOG_DIR_NAME = '日志';

export const MAX_CONCURRENT_RUNS = 2;
export const MAX_TREE_ITEMS = 2000;
export const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_RAW_LOG_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const STOP_GRACE_MS = 5000;

export const PLAYWRIGHT_CONFIG_FILES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

/** 目录树里一律不展开的目录名（构建产物 / 依赖 / 测试输出） */
export const TREE_IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
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

function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function intOr(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
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

function storeDir(root) {
  return resolveContentRoot(root, UIAUTO_DIR_NAME).abs;
}

export function uiautoStorePaths(root) {
  const dir = storeDir(root);
  return {
    dir,
    store: path.join(dir, UIAUTO_STORE_FILE),
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
  return {
    id: text(raw.id, 64) || `uia_${crypto.randomBytes(8).toString('hex')}`,
    name: text(raw.name, 200) || path.basename(dir),
    dir,
    createdAt: text(raw.createdAt, 40) || new Date().toISOString(),
    lastRunId: text(raw.lastRunId, 64),
    lastRunAt: text(raw.lastRunAt, 40),
    lastStatus: RUN_STATUSES.includes(raw.lastStatus) ? raw.lastStatus : '',
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
  return reconcileStore(store);
}

/** 服务重启后内存里没有对应进程的 running，一定是上次异常退出留下的 */
function reconcileStore(store) {
  let dirty = false;
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

/** 目录状态：是否存在、有没有配置文件、依赖装没装 */
export function detectProject(dir) {
  let exists = false;
  try {
    exists = fs.statSync(dir).isDirectory();
  } catch {
    exists = false;
  }
  const configFile = exists
    ? (PLAYWRIGHT_CONFIG_FILES.find((name) => fs.existsSync(path.join(dir, name))) ?? '')
    : '';
  const binName = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  const localBin = exists ? path.join(dir, 'node_modules', '.bin', binName) : '';
  const localPkg = exists ? path.join(dir, 'node_modules', '@playwright', 'test') : '';
  let packageManager = '';
  let hasDependency = false;
  if (exists) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps = {
        ...(pkg?.dependencies ?? {}),
        ...(pkg?.devDependencies ?? {}),
      };
      hasDependency = Object.keys(deps).includes('@playwright/test');
      if (typeof pkg?.packageManager === 'string' && pkg.packageManager) {
        packageManager = pkg.packageManager.split('@')[0] || '';
      }
    } catch {
      // 没有 / 坏掉的 package.json：以配置文件为准
    }
    if (!packageManager && fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (!packageManager && fs.existsSync(path.join(dir, 'yarn.lock'))) packageManager = 'yarn';
    else if (!packageManager && fs.existsSync(path.join(dir, 'package-lock.json'))) {
      packageManager = 'npm';
    }
  }
  const playwrightInstalled = Boolean(
    exists && (fs.existsSync(localBin) || fs.existsSync(localPkg)),
  );
  return {
    exists,
    configFile,
    playwrightInstalled,
    hasDependency,
    packageManager,
    /** 添加项目时的最低要求：有配置文件，或 package.json 声明了 @playwright/test */
    mountable: Boolean(exists && (configFile || hasDependency)),
  };
}

function decorateProject(project) {
  const health = detectProject(project.dir);
  const running = [...RUNNING.values()].find((entry) => entry.projectId === project.id);
  return {
    ...project,
    ...health,
    runningRunId: running ? running.runId : '',
  };
}

/** 该项目最近一次运行解析到的 Playwright 项目名（setup / chromium-login …） */
function latestProjectNames(store, projectId) {
  const runs = store.runs
    .filter((run) => run.projectId === projectId && run.projectNames.length)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return runs[0]?.projectNames ?? [];
}

/**
 * 拼 Playwright 运行参数（纯函数，便于单测）。
 * @param {{ file?: string, grep?: string, project?: string, headed?: boolean, workers?: number, lastFailed?: boolean }} options
 */
export function buildPlaywrightArgs(options = {}) {
  const args = ['test', '--reporter=list,json,html'];
  const file = text(options.file, 1024);
  if (file) args.push(file.replace(/\\/g, '/'));
  const grep = text(options.grep, MAX_ARG_TEXT);
  if (grep) args.push('--grep', grep);
  const project = text(options.project, 100);
  if (project) args.push(`--project=${project}`);
  if (options.headed === true) args.push('--headed');
  const workers = intOr(options.workers, 0, 0, 32);
  if (workers > 0) args.push(`--workers=${workers}`);
  if (options.lastFailed === true) args.push('--last-failed');
  return args;
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

/**
 * 解析 Playwright JSON reporter 的结果（纯函数）。
 * @param {any} raw
 */
export function parsePlaywrightReport(raw) {
  const empty = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs: 0,
    errors: [],
    failedTests: [],
    projectNames: [],
  };
  if (!raw || typeof raw !== 'object') return empty;
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  const projectNames = Array.isArray(raw.config?.projects)
    ? raw.config.projects
        .map((item) => text(item?.name, 100))
        .filter(Boolean)
        .slice(0, 50)
    : [];
  const expected = intOr(stats.expected, 0, 0, 1_000_000);
  const unexpected = intOr(stats.unexpected, 0, 0, 1_000_000);
  const skipped = intOr(stats.skipped, 0, 0, 1_000_000);
  const flaky = intOr(stats.flaky, 0, 0, 1_000_000);
  const errors = Array.isArray(raw.errors)
    ? raw.errors
        .map((item) => text(typeof item === 'string' ? item : item?.message, 2000))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const failedTests = [];
  const walk = (suite, trail) => {
    if (!suite || typeof suite !== 'object') return;
    const file = text(suite.file, 1024);
    const own = text(suite.title, 500);
    const nextTrail = own ? [...trail, own] : trail;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      const tests = Array.isArray(spec?.tests) ? spec.tests : [];
      const bad = tests.some(
        (t) =>
          t?.status === 'unexpected' ||
          t?.status === 'timedOut' ||
          (Array.isArray(t?.results) &&
            t.results.some((r) => r?.status === 'unexpected' || r?.status === 'timedOut')),
      );
      if (!bad) continue;
      failedTests.push({
        title: [...nextTrail, text(spec?.title, 500)].filter(Boolean).join(' › '),
        file,
      });
      if (failedTests.length >= 50) return;
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child, nextTrail);
  };
  for (const suite of Array.isArray(raw.suites) ? raw.suites : []) walk(suite, []);
  return {
    total: expected + unexpected + skipped + flaky,
    passed: expected,
    failed: unexpected,
    skipped,
    flaky,
    durationMs: intOr(stats.duration, 0, 0, Number.MAX_SAFE_INTEGER),
    errors,
    failedTests,
    projectNames,
  };
}

/** 读取 JSON 结果文件（超过上限当没有，避免把进程内存打满） */
function readReportResult(abs) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function resolvePlaywrightCommand(dir) {
  const bin = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  const local = path.join(dir, 'node_modules', '.bin', bin);
  if (fs.existsSync(local)) {
    return { command: local, prefix: [], local: true };
  }
  const pkg = path.join(dir, 'node_modules', '@playwright', 'test');
  if (fs.existsSync(pkg)) {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      prefix: ['--no-install', 'playwright'],
      local: false,
    };
  }
  return null;
}

function installHint(dir, packageManager) {
  const runner =
    packageManager === 'pnpm' ? 'pnpm install' : packageManager === 'yarn' ? 'yarn' : 'npm install';
  return `未找到 Playwright：请先在 ${dir} 运行「${runner}」，如首次使用再运行「${runner === 'yarn' ? 'yarn playwright install' : runner === 'pnpm' ? 'pnpm exec playwright install' : 'npx playwright install'}」。`;
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

  const summary = parsePlaywrightReport(
    readReportResult(path.join(paths.resultDir, `${runId}.json`)),
  );
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
    const tail = entry.log.slice(-1200).trim();
    if (tail) error = tail;
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
  run.error = error;

  const project = findProject(store, run.projectId);
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

  const health = detectProject(project.dir);
  if (!health.exists) return { error: '项目目录不存在，请重新选择目录', status: 400 };
  if (!health.mountable) {
    return {
      error: '该目录下没有 playwright.config 或 @playwright/test 依赖，无法运行',
      status: 400,
    };
  }
  const command = resolvePlaywrightCommand(project.dir);
  if (!command) {
    return { error: installHint(project.dir, health.packageManager), status: 400 };
  }

  for (const entry of RUNNING.values()) {
    if (entry.projectId === projectId) {
      return { error: '该项目已有运行中的任务，请等待结束或先停止', status: 409 };
    }
  }
  if (RUNNING.size >= MAX_CONCURRENT_RUNS) {
    return { error: `全局最多同时运行 ${MAX_CONCURRENT_RUNS} 个项目，请稍后再试`, status: 409 };
  }

  const args = normalizeRunArgs(body);
  if (args.file) {
    const file = normalizeRunFile(project.dir, args.file);
    if (!file) return { error: '指定的测试文件不在项目目录内或不存在', status: 400 };
    args.file = file;
  }

  const runId = `uar_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const paths = uiautoStorePaths(root);
  const reportAbs = path.join(paths.reportDir, runId);
  const resultAbs = path.join(paths.resultDir, `${runId}.json`);
  const logAbs = path.join(paths.logDir, `${runId}.log`);
  fs.mkdirSync(reportAbs, { recursive: true });
  fs.mkdirSync(paths.resultDir, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const cliArgs = [...command.prefix, ...buildPlaywrightArgs(args)];
  const env = {
    ...process.env,
    PLAYWRIGHT_HTML_REPORT: reportAbs,
    PLAYWRIGHT_HTML_OPEN: 'never',
    PLAYWRIGHT_JSON_OUTPUT_NAME: resultAbs,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  // 有些项目的 config 会 import tsconfig-paths/register，它把 `--project` 当成 tsconfig 路径；
  // 预加载守卫只在加载它的瞬间摘掉这两个参数，避免 ENOENT（详见 uiauto-argv-guard.cjs）
  const guard = ARGV_GUARD_PATH;
  if (args.project && fs.existsSync(guard)) {
    const requireFlag = `--require ${JSON.stringify(guard)}`;
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${requireFlag}` : requireFlag;
  }

  let child;
  try {
    child = spawn(command.command, cliArgs, {
      cwd: project.dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (err) {
    return { error: `启动失败：${err instanceof Error ? err.message : String(err)}`, status: 500 };
  }

  const run = {
    id: runId,
    projectId,
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
    projectNames: [],
    reportRel: `${REPORT_DIR_NAME}/${runId}`,
    resultRel: `${RESULT_DIR_NAME}/${runId}.json`,
    logRel: `${LOG_DIR_NAME}/${runId}.log`,
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

  return { run: runView(run), command: command.command, args: cliArgs };
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
  const dir = path.join(paths.reportDir, runId);
  if (!isPathInside(paths.reportDir, dir)) {
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

function listTree(project, rel, depth) {
  const base = project.dir;
  const startAbs = resolveInside(base, rel);
  if (!startAbs) return { error: '目录路径不合法', status: 400 };
  let stat;
  try {
    stat = fs.statSync(startAbs);
  } catch {
    return { error: '目录不存在', status: 404 };
  }
  if (!stat.isDirectory()) return { error: '不是目录', status: 400 };

  const entries = [];
  let truncated = false;
  const walk = (abs, level) => {
    if (level > depth || truncated) return;
    let names;
    try {
      names = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of names) {
      if (entries.length >= MAX_TREE_ITEMS) {
        truncated = true;
        return;
      }
      if (shouldIgnoreTreeName(item.name)) continue;
      const childAbs = path.join(abs, item.name);
      const childRel = toPosixRel(base, childAbs);
      if (item.isDirectory()) {
        entries.push({ name: item.name, path: childRel, type: 'dir' });
        walk(childAbs, level + 1);
      } else if (item.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(childAbs).size;
        } catch {
          size = 0;
        }
        entries.push({ name: item.name, path: childRel, type: 'file', size });
      }
    }
  };
  walk(startAbs, 0);
  return {
    ok: true,
    path: toPosixRel(base, startAbs),
    entries,
    truncated,
  };
}

/** 从目录树里筛出测试文件，供「指定文件」下拉使用 */
function listSpecFiles(project) {
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
      else if (/\.(spec|test)\.(ts|js|mjs|cjs|tsx|jsx)$/.test(item.name)) {
        result.push(toPosixRel(project.dir, child));
      }
    }
  };
  walk(project.dir, 0);
  return result.sort();
}

function previewFile(project, rel) {
  const abs = resolveInside(project.dir, rel);
  if (!abs) return { error: '文件路径不合法', status: 400 };
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { error: '文件不存在', status: 404 };
  }
  if (!stat.isFile()) return { error: '不是文件', status: 400 };
  const size = stat.size;
  const readSize = Math.min(size, MAX_PREVIEW_BYTES);
  const buffer = Buffer.alloc(readSize);
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buffer, 0, readSize, 0);
  } catch {
    return { error: '文件读取失败', status: 500 };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  const binary = buffer.includes(0);
  return {
    ok: true,
    path: toPosixRel(project.dir, abs),
    size,
    truncated: size > MAX_PREVIEW_BYTES,
    binary,
    content: binary ? '' : buffer.toString('utf8'),
  };
}

function removeRunArtifacts(root, run) {
  const paths = uiautoStorePaths(root);
  if (run.reportRel) {
    const abs = path.join(paths.dir, run.reportRel);
    if (isPathInside(paths.reportDir, abs)) fs.rmSync(abs, { recursive: true, force: true });
  }
  if (run.resultRel) {
    const abs = path.join(paths.dir, run.resultRel);
    if (isPathInside(paths.resultDir, abs)) fs.rmSync(abs, { force: true });
  }
  if (run.logRel) {
    const abs = path.join(paths.dir, run.logRel);
    if (isPathInside(paths.logDir, abs)) fs.rmSync(abs, { force: true });
  }
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhUiautoPlugin() {
  return {
    name: 'lh-uiauto',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        // 数据根惰性读取：切换数据空间后无需重启
        const root = getDataRoot();
        const method = req.method || 'GET';
        const tail = parsed.pathname.slice(PREFIX.length) || '/';

        try {
          if (method === 'GET' && tail.startsWith('/report/')) {
            const rest = tail.slice('/report/'.length);
            const slash = rest.indexOf('/');
            const runId = slash === -1 ? rest : rest.slice(0, slash);
            const rel = slash === -1 ? '' : rest.slice(slash + 1);
            return sendReportFile(root, res, runId, rel);
          }

          if (method === 'GET' && parsed.searchParams.get('health') === '1') {
            return sendJson(res, 200, {
              ok: true,
              files: uiautoStorePaths(root),
              running: [...RUNNING.keys()],
              version: VERSION,
            });
          }

          if (method === 'GET' && tail === '/projects') {
            const { store, dirty } = readStore(root);
            if (dirty) writeStore(root, store);
            const projects = store.projects.map((project) => ({
              ...decorateProject(project),
              specFiles: detectProject(project.dir).exists ? listSpecFiles(project) : [],
              // 上次运行拿到的 Playwright 项目名（setup / chromium-login 之类），给下拉做候选
              projectNames: latestProjectNames(store, project.id),
            }));
            return sendJson(res, 200, { ok: true, projects });
          }

          if (method === 'POST' && tail === '/pick-directory') {
            const picked = await nativePickDirectory();
            return sendJson(res, 200, { ok: true, dir: picked || '' });
          }

          if (method === 'POST' && tail === '/projects') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            const rawDir = text(body.dir, 4096);
            if (!rawDir) return sendJson(res, 400, { ok: false, error: '缺少项目目录' });
            const dir = path.resolve(rawDir);
            const health = detectProject(dir);
            if (!health.exists) return sendJson(res, 400, { ok: false, error: '目录不存在' });
            if (!health.mountable) {
              return sendJson(res, 400, {
                ok: false,
                error:
                  '目录下没有 playwright.config 或 @playwright/test 依赖，不像是 Playwright 项目',
              });
            }
            const store = readStoreForWrite(root);
            if (store.projects.some((p) => path.resolve(p.dir) === dir)) {
              return sendJson(res, 409, { ok: false, error: '该目录已经添加过了' });
            }
            const project = {
              id: `uia_${crypto.randomBytes(8).toString('hex')}`,
              name: text(body.name, 200) || path.basename(dir),
              dir,
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
                specFiles: listSpecFiles(project),
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
            if (typeof body.dir === 'string' && body.dir.trim()) {
              const dir = path.resolve(text(body.dir, 4096));
              const health = detectProject(dir);
              if (!health.exists) return sendJson(res, 400, { ok: false, error: '目录不存在' });
              if (!health.mountable) {
                return sendJson(res, 400, {
                  ok: false,
                  error:
                    '目录下没有 playwright.config 或 @playwright/test 依赖，不像是 Playwright 项目',
                });
              }
              project.dir = dir;
            }
            writeStore(root, store);
            return sendJson(res, 200, {
              ok: true,
              project: {
                ...decorateProject(project),
                specFiles: listSpecFiles(project),
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

          if (method === 'GET' && tail === '/tree') {
            const store = readStore(root).store;
            const project = findProject(store, text(parsed.searchParams.get('projectId'), 64));
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const depth = intOr(parsed.searchParams.get('depth'), 2, 0, 6);
            const rel = text(parsed.searchParams.get('path'), 2048);
            const result = listTree(project, rel, depth);
            if (result.error)
              return sendJson(res, result.status, { ok: false, error: result.error });
            return sendJson(res, 200, result);
          }

          if (method === 'GET' && tail === '/file') {
            const store = readStore(root).store;
            const project = findProject(store, text(parsed.searchParams.get('projectId'), 64));
            if (!project) return sendJson(res, 404, { ok: false, error: '项目不存在' });
            const result = previewFile(project, text(parsed.searchParams.get('path'), 2048));
            if (result.error)
              return sendJson(res, result.status, { ok: false, error: result.error });
            return sendJson(res, 200, result);
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
                if (isPathInside(uiautoStorePaths(root).logDir, abs)) {
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

          return next();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return sendJson(res, 500, { ok: false, error: message });
        }
      });
    },
  };
}
