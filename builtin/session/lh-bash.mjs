/**
 * 会话 shell 执行（对齐 dsh tool-bash / tool-pwsh + tool-jobs 子集）：
 * - `/__tb_bash` · `/__tb_pwsh`；共用内存 job 注册表
 * - 同步：超时 / 输出截断；后台：job_list / job_output / job_kill
 * - 软沙箱策略 + 持久 bash/pwsh 会话（node-pty 优先，管道回退）
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertCommandAllowed, buildChildEnv, resolveSandboxPolicy } from './sandbox-policy.mjs';
import { getDataRoot } from './space-context.mjs';
import { LOCAL_REL } from './space-layout.mjs';
import {
  closeBashSession,
  detectPtyBackend,
  execBashSession,
  listBashSessions,
  openBashSession,
  readBashSession,
  sessionStats,
  signalBashSession,
  writeBashSession,
} from './bash-session.mjs';
import {
  closePwshSession,
  execPwshSession,
  listPwshSessions,
  openPwshSession,
  pwshSessionStats,
  readPwshSession,
  signalPwshSession,
  writePwshSession,
} from './pwsh-session.mjs';

const execFileAsync = promisify(execFile);

const PREFIX_BASH = '/__tb_bash';
const PREFIX_PWSH = '/__tb_pwsh';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUT = 32 * 1024;
const MAX_COMMAND = 8_000;
const MAX_JOBS = 32;
const JOB_BUF = 256 * 1024;

/** @type {Map<string, object>} */
const jobs = new Map();

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

function normalizeAccess(raw) {
  const a = String(raw || '').trim();
  if (a === 'full' || a === 'readwrite' || a === 'readonly') return a;
  return 'readonly';
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function workspaceFile(projectRoot) {
  return path.join(projectRoot, LOCAL_REL, 'workspaces.json');
}

function legacyWorkspaceFile(projectRoot) {
  return path.join(projectRoot, LOCAL_REL, 'workspace.json');
}

function folderName(abs) {
  const parts = abs.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || abs;
}

function isAncestorPath(maybeAncestor, dir) {
  const a = path.resolve(maybeAncestor);
  const d = path.resolve(dir);
  return d !== a && d.startsWith(a + path.sep);
}

/**
 * harness 包根（`pnpm dev` 时即仓库根）。
 *
 * 插件开发会把工作区切到这里；它是空间目录的上级，默认会被下面的过滤剔除，
 * 进而让 bash 的 cwd 回落到空间目录。与 `lh-fs.mjs` 保持一致，单独放行包根。
 */
const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function isHarnessRoot(abs) {
  const a = path.resolve(String(abs ?? ''));
  if (a !== HARNESS_ROOT) return false;
  return fs.existsSync(path.join(a, 'package.json'));
}

function ensureWorkspaceRegistry(projectRoot) {
  const rootAbs = path.resolve(projectRoot);
  const fp = workspaceFile(projectRoot);
  let items = [];
  let active = rootAbs;
  /** 与 lh-fs 一致：插件开发期间临时借用包根，不写进 items */
  let activeHarness = false;

  try {
    if (fs.existsSync(fp)) {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (Array.isArray(raw.items)) {
        items = raw.items
          .map((it) => ({
            id: String(it.id || ''),
            path: path.resolve(String(it.path || '')),
            name: String(it.name || folderName(String(it.path || ''))),
            addedAt: Number(it.addedAt) || Date.now(),
          }))
          .filter(
            (it) =>
              it.id && it.path && fs.existsSync(it.path) && fs.statSync(it.path).isDirectory(),
          );
      }
      if (raw.activeHarness === true) activeHarness = true;
      if (raw.active) active = path.resolve(String(raw.active));
    } else if (fs.existsSync(legacyWorkspaceFile(projectRoot))) {
      const legacy = JSON.parse(fs.readFileSync(legacyWorkspaceFile(projectRoot), 'utf8'));
      const p = String(legacy.path || '').trim();
      if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        active = path.resolve(p);
        items = [
          {
            id: `ws_${Date.now().toString(36)}`,
            path: active,
            name: folderName(active),
            addedAt: Date.now(),
          },
        ];
      }
    }
  } catch {
    // ignore
  }

  // 包根只临时当工作区，不进列表；其它上级目录继续剔除
  items = items.filter(
    (it) => it.path === rootAbs || (!isHarnessRoot(it.path) && !isAncestorPath(it.path, rootAbs)),
  );
  for (const it of items) {
    if (it.path === rootAbs) it.id = 'ws_project';
    else if (it.id === 'ws_project') {
      it.id = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    }
  }
  if (!items.some((it) => it.path === rootAbs)) {
    items.unshift({
      id: 'ws_project',
      path: rootAbs,
      name: folderName(rootAbs),
      addedAt: 0,
    });
  }
  if (activeHarness && isHarnessRoot(HARNESS_ROOT)) {
    active = HARNESS_ROOT;
  } else if (!items.some((it) => it.path === active)) {
    active = rootAbs;
  }
  return { active, items, projectRoot: rootAbs, activeHarness };
}

function readWorkspace(projectRoot) {
  return ensureWorkspaceRegistry(projectRoot).active;
}

function isSystemSensitive(abs) {
  const n = abs.replace(/\\/g, '/').toLowerCase();
  const home = os.homedir().replace(/\\/g, '/').toLowerCase();
  const prefixes = [
    '/system',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/private/etc',
    '/library/extensions',
    '/dev',
    '/proc',
    '/windows',
    '/program files',
  ];
  if (prefixes.some((p) => n === p || n.startsWith(`${p}/`))) return true;
  if (n.startsWith(`${home}/`) || n === home) return false;
  return false;
}

/**
 * @returns {{ abs: string, display: string, inWorkspace: boolean }}
 */
function resolveWorkdir(workspaceRoot, input, access) {
  let raw = String(input ?? '').trim() || '.';
  if (raw.includes('\0')) throw new Error('invalid path');
  raw = expandHome(raw);
  const ws = path.resolve(workspaceRoot);

  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    if (isSystemSensitive(abs)) throw new Error('禁止访问系统敏感目录');
    if (abs === ws || abs.startsWith(ws + path.sep)) {
      const display = path.relative(ws, abs).split(path.sep).join('/') || '.';
      return { abs, display, inWorkspace: true };
    }
    if (access !== 'full') {
      throw new Error('该路径不在当前工作区内。请先设置工作区，或切换到「完全权限」使用绝对路径。');
    }
    return { abs, display: abs, inWorkspace: false };
  }

  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(ws, cleaned);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    throw new Error('路径超出当前工作区');
  }
  const display = path.relative(ws, abs).split(path.sep).join('/') || '.';
  return { abs, display, inWorkspace: true };
}

function truncateText(s, max = MAX_OUT) {
  const t = String(s ?? '');
  if (t.length <= max) return { text: t, truncated: false };
  return { text: `${t.slice(0, max)}\n…[truncated ${t.length - max} chars]`, truncated: true };
}

function bashBinary() {
  return process.platform === 'win32' ? 'bash' : '/bin/bash';
}

function whichBinary(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    return (
      String(out || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean) || null
    );
  } catch {
    return null;
  }
}

/** 解析 PowerShell：优先 pwsh，Windows 回退 powershell.exe */
function resolvePwshBinary() {
  const order =
    process.platform === 'win32' ? ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'] : ['pwsh'];
  for (const name of order) {
    const hit = whichBinary(name);
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {'bash' | 'pwsh'} shell
 * @returns {{ bin: string, args: string[] } | { error: string }}
 */
function shellInvocation(shell, command) {
  if (shell === 'bash') {
    const bin = bashBinary();
    return { bin, args: ['-lc', command] };
  }
  const bin = resolvePwshBinary();
  if (!bin) {
    return {
      error:
        'PowerShell not found. Install PowerShell 7+ (pwsh), or on Windows use Windows PowerShell.',
    };
  }
  return {
    bin,
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
  };
}

/**
 * @param {'bash' | 'pwsh'} shell
 * @param {Record<string, string>} [env]
 */
async function runShell(shell, command, cwd, timeoutMs, env) {
  const inv = shellInvocation(shell, command);
  if ('error' in inv) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: inv.error,
      cwd,
      durationMs: 0,
    };
  }
  const childEnv = env || buildChildEnv({ scrubEnv: true });
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(inv.bin, inv.args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUT * 4,
      env: childEnv,
      windowsHide: true,
    });
    const out = truncateText(stdout);
    const err = truncateText(stderr);
    return {
      ok: true,
      exitCode: 0,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      cwd,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    const err = e && typeof e === 'object' ? e : {};
    const code = 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: `${shell} not found (${inv.bin}).`,
        cwd,
        durationMs: Date.now() - started,
      };
    }
    const killed = Boolean('killed' in err && err.killed);
    const signal = 'signal' in err ? err.signal : undefined;
    const timedOut = killed || signal === 'SIGTERM';
    const out = truncateText('stdout' in err ? err.stdout : '');
    const stderrRaw =
      'stderr' in err && err.stderr
        ? err.stderr
        : timedOut
          ? ''
          : e instanceof Error
            ? e.message
            : String(e);
    const errOut = truncateText(stderrRaw);
    const exitCode = typeof code === 'number' ? code : timedOut ? null : 1;
    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      stdout: out.text,
      stderr: errOut.text,
      truncated: out.truncated || errOut.truncated,
      timedOut,
      error: timedOut ? `command timed out after ${timeoutMs}ms` : undefined,
      cwd,
      durationMs: Date.now() - started,
    };
  }
}

function appendJobBuf(job, stream, chunk) {
  const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  job[stream] += s;
  if (job[stream].length > JOB_BUF) {
    job[stream] = `…[truncated]\n${job[stream].slice(-JOB_BUF)}`;
    job.truncated = true;
  }
}

function pruneJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  while (jobs.size > MAX_JOBS && finished.length) {
    const old = finished.shift();
    if (old) jobs.delete(old.id);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    shell: job.shell || 'bash',
    command: job.command,
    workdir: job.workdir,
    status: job.status,
    exitCode: job.exitCode,
    pid: job.pid,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    truncated: job.truncated,
    stdoutBytes: Buffer.byteLength(job.stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(job.stderr, 'utf8'),
  };
}

/**
 * @param {'bash' | 'pwsh'} shell
 * @param {Record<string, string>} [env]
 */
function startBackgroundJob(shell, command, cwd, workdirDisplay, env) {
  const inv = shellInvocation(shell, command);
  if ('error' in inv) {
    throw new Error(inv.error);
  }
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  let child;
  try {
    child = spawn(inv.bin, inv.args, {
      cwd,
      env: env || buildChildEnv({ scrubEnv: true }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const job = {
    id,
    shell,
    command,
    workdir: workdirDisplay,
    cwd,
    status: 'running',
    exitCode: null,
    stdout: '',
    stderr: '',
    truncated: false,
    startedAt: Date.now(),
    endedAt: null,
    pid: child.pid ?? null,
    child,
  };

  child.stdout?.on('data', (c) => appendJobBuf(job, 'stdout', c));
  child.stderr?.on('data', (c) => appendJobBuf(job, 'stderr', c));
  child.on('error', (e) => {
    if (job.status === 'running') {
      job.status = 'exited';
      job.exitCode = 1;
      job.endedAt = Date.now();
    }
    appendJobBuf(job, 'stderr', e?.message || String(e));
    job.child = null;
  });
  child.on('close', (code, signal) => {
    if (job.status === 'running') {
      job.status = signal ? 'killed' : 'exited';
    }
    job.exitCode = typeof code === 'number' ? code : null;
    job.endedAt = Date.now();
    job.child = null;
  });

  jobs.set(id, job);
  pruneJobs();
  return publicJob(job);
}

function killJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.status !== 'running' || !job.child) {
    return { ok: true, alreadyDone: true, job: publicJob(job) };
  }
  try {
    job.child.kill('SIGTERM');
    job.status = 'killed';
    job.endedAt = Date.now();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), job: publicJob(job) };
  }
  return { ok: true, job: publicJob(job) };
}

/**
 * @param {'bash' | 'pwsh'} shell
 * @param {string} prefix
 */
async function handleShellExec(shell, req, res, projectRoot) {
  const workspace = readWorkspace(projectRoot);
  const body = JSON.parse((await readBody(req)) || '{}');
  const access = normalizeAccess(body.access);
  if (access === 'readonly') {
    return sendJson(res, 403, {
      error: `${shell} 需要「工作区内修改」或「完全权限」`,
    });
  }
  const command = String(body.command ?? '').trim();
  if (!command) return sendJson(res, 400, { error: 'command is required' });
  if (command.length > MAX_COMMAND) {
    return sendJson(res, 400, { error: `command too long (max ${MAX_COMMAND})` });
  }
  const policy = resolveSandboxPolicy({ access, workspace });
  const denied = assertCommandAllowed(command, policy);
  if (!denied.ok) return sendJson(res, 400, { error: denied.error });

  const timeoutMs = Math.min(
    Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000),
    120_000,
  );
  let workdirInput = body.workdir || '.';
  if (policy.enforceWorkspaceCwd && path.isAbsolute(String(workdirInput))) {
    // still allow absolute only if inside workspace via resolveWorkdir
  }
  const { abs, display } = resolveWorkdir(workspace, workdirInput, access);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return sendJson(res, 400, { error: 'workdir is not a directory', path: display });
  }
  const env = buildChildEnv(policy);
  const background = Boolean(body.background);
  if (background) {
    const job = startBackgroundJob(shell, command, abs, display, env);
    return sendJson(res, 200, {
      ok: true,
      background: true,
      jobId: job.id,
      job,
      command,
      workdir: display,
      shell,
      sandbox: policy.mode,
    });
  }
  const result = await runShell(shell, command, abs, timeoutMs, env);
  return sendJson(res, 200, {
    ...result,
    workdir: display,
    command,
    shell,
    sandbox: policy.mode,
  });
}

/**
 * @param {'bash' | 'pwsh'} shell
 */
async function handleSessionRoutes(shell, req, res, projectRoot, url) {
  const workspace = readWorkspace(projectRoot);
  const prefix = shell === 'pwsh' ? PREFIX_PWSH : PREFIX_BASH;
  const label = shell === 'pwsh' ? 'pwsh session' : 'bash session';

  if (url === `${prefix}/session/list` && req.method === 'GET') {
    const list = shell === 'pwsh' ? listPwshSessions() : listBashSessions();
    const stats = shell === 'pwsh' ? pwshSessionStats() : sessionStats();
    return sendJson(res, 200, {
      ok: true,
      shell,
      sessions: list,
      ...stats,
    });
  }

  if (url === `${prefix}/session/open` && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const access = normalizeAccess(body.access);
    if (access === 'readonly') {
      return sendJson(res, 403, {
        error: `${label} 需要「工作区内修改」或「完全权限」`,
      });
    }
    const policy = resolveSandboxPolicy({ access, workspace });
    const { abs, display } = resolveWorkdir(workspace, body.workdir || '.', access);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return sendJson(res, 400, { error: 'workdir is not a directory', path: display });
    }
    const env = buildChildEnv(policy);
    const result =
      shell === 'pwsh'
        ? await openPwshSession({ cwdAbs: abs, cwdDisplay: display, env })
        : await openBashSession({ cwdAbs: abs, cwdDisplay: display, env });
    return sendJson(res, result.ok ? 200 : 400, { ...result, sandbox: policy.mode });
  }

  if (url === `${prefix}/session/exec` && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const access = normalizeAccess(body.access);
    if (access === 'readonly') {
      return sendJson(res, 403, {
        error: `${label} 需要「工作区内修改」或「完全权限」`,
      });
    }
    const command = String(body.command ?? '');
    if (!command.trim()) return sendJson(res, 400, { error: 'command is required' });
    if (command.length > MAX_COMMAND) {
      return sendJson(res, 400, { error: `command too long (max ${MAX_COMMAND})` });
    }
    const result =
      shell === 'pwsh'
        ? await execPwshSession({
            sessionId: body.sessionId || body.id,
            command,
            timeoutMs: body.timeoutMs,
          })
        : await execBashSession({
            sessionId: body.sessionId || body.id,
            command,
            timeoutMs: body.timeoutMs,
          });
    return sendJson(res, result.ok || result.timedOut ? 200 : 400, result);
  }

  if (url === `${prefix}/session/read` && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const result =
      shell === 'pwsh'
        ? readPwshSession(body.sessionId || body.id, body.offset)
        : readBashSession(body.sessionId || body.id, body.offset);
    return sendJson(res, result.ok ? 200 : 404, result);
  }

  if (url === `${prefix}/session/write` && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const access = normalizeAccess(body.access);
    if (access === 'readonly') {
      return sendJson(res, 403, {
        error: `${label} 需要「工作区内修改」或「完全权限」`,
      });
    }
    const result =
      shell === 'pwsh'
        ? writePwshSession({
            sessionId: body.sessionId || body.id,
            data: body.data ?? body.text,
            submit: body.submit,
          })
        : writeBashSession({
            sessionId: body.sessionId || body.id,
            data: body.data ?? body.text,
            submit: body.submit,
          });
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url === `${prefix}/session/signal` && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const access = normalizeAccess(body.access);
    if (access === 'readonly') {
      return sendJson(res, 403, {
        error: `${label} 需要「工作区内修改」或「完全权限」`,
      });
    }
    const result =
      shell === 'pwsh'
        ? signalPwshSession({
            sessionId: body.sessionId || body.id,
            signal: body.signal,
          })
        : signalBashSession({
            sessionId: body.sessionId || body.id,
            signal: body.signal,
          });
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url === `${prefix}/session/close` && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const access = normalizeAccess(body.access);
    if (access === 'readonly') {
      return sendJson(res, 403, {
        error: `${label} 需要「工作区内修改」或「完全权限」`,
      });
    }
    const result =
      shell === 'pwsh'
        ? closePwshSession(body.sessionId || body.id)
        : closeBashSession(body.sessionId || body.id);
    return sendJson(res, result.ok ? 200 : 404, result);
  }

  return null;
}

/**
 * Vite / connect 中间件插件（bash + pwsh + jobs）
 */
export function lhBashPlugin() {
  return {
    name: 'lh-bash',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const isBash = url.startsWith(PREFIX_BASH);
        const isPwsh = url.startsWith(PREFIX_PWSH);
        if (!isBash && !isPwsh) return next();
        // 数据根惰性读取：切换数据空间后无需重启即可生效
        const projectRoot = getDataRoot();

        const prefix = isPwsh ? PREFIX_PWSH : PREFIX_BASH;
        const shell = isPwsh ? 'pwsh' : 'bash';

        try {
          const workspace = readWorkspace(projectRoot);

          if (url === `${prefix}/health` && req.method === 'GET') {
            const running = [...jobs.values()].filter((j) => j.status === 'running').length;
            const ptyInfo = await detectPtyBackend();
            const sess = sessionStats();
            if (shell === 'pwsh') {
              const bin = resolvePwshBinary();
              const psess = pwshSessionStats();
              return sendJson(res, 200, {
                ok: true,
                mode: 'pwsh',
                available: Boolean(bin),
                pwsh: bin,
                projectRoot: path.resolve(projectRoot),
                workspace,
                timeoutMs: DEFAULT_TIMEOUT_MS,
                maxOut: MAX_OUT,
                jobs: true,
                jobCount: jobs.size,
                runningJobs: running,
                sandboxPolicy: true,
                pty: ptyInfo.available,
                persistentSessions: true,
                sessionCount: psess.count,
                sessionMax: psess.max,
              });
            }
            return sendJson(res, 200, {
              ok: true,
              mode: 'bash',
              available: true,
              projectRoot: path.resolve(projectRoot),
              workspace,
              bash: bashBinary(),
              timeoutMs: DEFAULT_TIMEOUT_MS,
              maxOut: MAX_OUT,
              jobs: true,
              jobCount: jobs.size,
              runningJobs: running,
              sandboxPolicy: true,
              pty: ptyInfo.available,
              persistentSessions: true,
              sessionCount: sess.count,
              sessionMax: sess.max,
            });
          }

          if (isBash && url.startsWith(`${PREFIX_BASH}/session/`)) {
            const handled = await handleSessionRoutes('bash', req, res, projectRoot, url);
            if (handled !== null) return handled;
          }

          if (isPwsh && url.startsWith(`${PREFIX_PWSH}/session/`)) {
            const handled = await handleSessionRoutes('pwsh', req, res, projectRoot, url);
            if (handled !== null) return handled;
          }

          // jobs 仅挂在 bash 前缀（pwsh 后台任务也写入同一注册表）
          if (isBash && url === `${PREFIX_BASH}/jobs` && req.method === 'GET') {
            const list = [...jobs.values()]
              .sort((a, b) => b.startedAt - a.startedAt)
              .map(publicJob);
            return sendJson(res, 200, { ok: true, jobs: list });
          }

          if (isBash && url === `${PREFIX_BASH}/job_output` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const jobId = String(body.jobId ?? body.id ?? '').trim();
            if (!jobId) return sendJson(res, 400, { error: 'jobId is required' });
            const job = jobs.get(jobId);
            if (!job) return sendJson(res, 404, { error: 'job not found', jobId });
            const combined = `${job.stdout}${job.stderr ? (job.stdout ? '\n' : '') + job.stderr : ''}`;
            // tail：取末尾 N 字符（与 offset 二选一，优先 tail）
            const tailRaw = Number(body.tail);
            if (Number.isFinite(tailRaw) && tailRaw > 0) {
              const n = Math.min(256_000, Math.floor(tailRaw));
              const start = Math.max(0, combined.length - n);
              const slice = combined.slice(start);
              return sendJson(res, 200, {
                ok: true,
                job: publicJob(job),
                stdout: job.stdout,
                stderr: job.stderr,
                output: slice,
                offset: start,
                nextOffset: combined.length,
                tail: n,
                truncated: job.truncated || start > 0,
              });
            }
            const offset = Math.max(0, Number(body.offset) || 0);
            const slice = combined.slice(offset);
            return sendJson(res, 200, {
              ok: true,
              job: publicJob(job),
              stdout: job.stdout,
              stderr: job.stderr,
              output: slice,
              offset,
              nextOffset: offset + slice.length,
              truncated: job.truncated,
            });
          }

          if (isBash && url === `${PREFIX_BASH}/job_kill` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const access = normalizeAccess(body.access);
            if (access === 'readonly') {
              return sendJson(res, 403, {
                error: 'job_kill 需要「工作区内修改」或「完全权限」',
              });
            }
            const jobId = String(body.jobId ?? body.id ?? '').trim();
            if (!jobId) return sendJson(res, 400, { error: 'jobId is required' });
            const result = killJob(jobId);
            return sendJson(res, result.ok ? 200 : 404, result);
          }

          if (url === `${prefix}/exec` && req.method === 'POST') {
            return await handleShellExec(shell, req, res, projectRoot);
          }

          return sendJson(res, 404, { error: 'not found' });
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
