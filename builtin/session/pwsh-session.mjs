/**
 * 持久 PowerShell 会话：优先 node-pty，失败则管道 + marker 回退。
 */
import { execFileSync, spawn } from 'node:child_process';
import { assertCommandAllowed, buildChildEnv } from './sandbox-policy.mjs';
import { detectPtyBackend, markPtyUnavailable } from './bash-session.mjs';

const MAX_SESSIONS = 4;
const SCROLL_MAX = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MARKER_PREFIX = '__TB_PWSH_';

/** @type {Map<string, object>} */
const sessions = new Map();

function uid() {
  return `psh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
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

export function resolvePwshBinary() {
  const order =
    process.platform === 'win32' ? ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'] : ['pwsh'];
  for (const name of order) {
    const hit = whichBinary(name);
    if (hit) return hit;
  }
  return null;
}

function appendScroll(session, chunk) {
  const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  session.scroll += s;
  if (session.scroll.length > SCROLL_MAX) {
    session.scroll = `…[truncated]\n${session.scroll.slice(-SCROLL_MAX)}`;
    session.truncated = true;
  }
  session.aliveBuf += s;
  if (session.aliveBuf.length > SCROLL_MAX) {
    session.aliveBuf = session.aliveBuf.slice(-SCROLL_MAX);
  }
}

function publicSession(session) {
  return {
    id: session.id,
    shell: 'pwsh',
    backend: session.backend,
    cwd: session.cwdDisplay,
    status: session.status,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    truncated: session.truncated,
    scrollBytes: Buffer.byteLength(session.scroll, 'utf8'),
  };
}

function pruneSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const idle = [...sessions.values()]
    .filter((s) => s.status !== 'running')
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  while (sessions.size > MAX_SESSIONS && idle.length) {
    const old = idle.shift();
    if (old) closeSessionInternal(old.id);
  }
}

function closeSessionInternal(id) {
  const session = sessions.get(id);
  if (!session) return { ok: false, error: 'session not found' };
  try {
    if (session.backend === 'pty' && session.pty) {
      session.pty.kill();
    } else if (session.child) {
      session.child.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
  session.status = 'closed';
  session.pty = null;
  session.child = null;
  sessions.delete(id);
  return { ok: true, session: publicSession(session) };
}

function waitForMarker(session, marker, timeoutMs) {
  const startedLen = session.aliveBuf.length;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (timedOut, exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      const slice = session.aliveBuf.slice(startedLen);
      const idx = slice.lastIndexOf(marker);
      const output = idx >= 0 ? slice.slice(0, idx) : slice;
      resolve({ output, timedOut, exited });
    };
    const poll = setInterval(() => {
      if (session.status !== 'running') {
        finish(false, true);
        return;
      }
      if (session.aliveBuf.includes(marker, startedLen)) {
        finish(false, false);
      }
    }, 40);
    const timer = setTimeout(() => finish(true, false), timeoutMs);
  });
}

function escapePsSingle(s) {
  return String(s).replace(/'/g, "''");
}

function pipeDriverScript(marker) {
  const m = escapePsSingle(marker);
  return [
    `$ErrorActionPreference = 'Continue'`,
    `$__tb_m = '${m}'`,
    `[Console]::Out.Write($__tb_m)`,
    `while ($null -ne ($__tb_line = [Console]::In.ReadLine())) {`,
    `  try { Invoke-Expression $__tb_line | Out-String -Stream | ForEach-Object { [Console]::Out.WriteLine($_) } }`,
    `  catch { [Console]::Error.WriteLine($_.Exception.Message) }`,
    `  [Console]::Out.Write($__tb_m)`,
    `}`,
  ].join('; ');
}

async function openPtySession(bin, cwdAbs, cwdDisplay, env, marker) {
  const { available, pty } = await detectPtyBackend();
  if (!available || !pty) return null;
  let term;
  try {
    term = pty.spawn(bin, ['-NoLogo', '-NoProfile'], {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: cwdAbs,
      env: {
        ...env,
        TERM: 'xterm-256color',
      },
    });
  } catch {
    // 能 import 但无法 spawn（spawn-helper 不可执行等）→ 降级管道会话
    markPtyUnavailable();
    return null;
  }
  const id = uid();
  const session = {
    id,
    backend: 'pty',
    cwdAbs,
    cwdDisplay,
    status: 'running',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    scroll: '',
    aliveBuf: '',
    truncated: false,
    marker,
    pty: term,
    child: null,
  };
  term.onData((data) => appendScroll(session, data));
  term.onExit(() => {
    session.status = 'exited';
    session.pty = null;
  });
  sessions.set(id, session);
  pruneSessions();
  // Install prompt + print marker
  const setup = `function global:prompt { '${escapePsSingle(marker)}' }; [Console]::Out.Write((prompt))\n`;
  term.write(setup);
  await waitForMarker(session, marker, 8_000);
  session.aliveBuf = '';
  return session;
}

async function openPipeSession(bin, cwdAbs, cwdDisplay, env, marker) {
  const child = spawn(bin, ['-NoLogo', '-NoProfile', '-Command', pipeDriverScript(marker)], {
    cwd: cwdAbs,
    env: { ...env, TERM: 'dumb' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const id = uid();
  const session = {
    id,
    backend: 'pipe',
    cwdAbs,
    cwdDisplay,
    status: 'running',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    scroll: '',
    aliveBuf: '',
    truncated: false,
    marker,
    pty: null,
    child,
  };
  child.stdout?.on('data', (c) => appendScroll(session, c));
  child.stderr?.on('data', (c) => appendScroll(session, c));
  child.on('close', () => {
    session.status = 'exited';
    session.child = null;
  });
  child.on('error', () => {
    session.status = 'exited';
    session.child = null;
  });
  sessions.set(id, session);
  pruneSessions();
  await waitForMarker(session, marker, 8_000);
  session.aliveBuf = '';
  return session;
}

/**
 * @param {{ cwdAbs: string, cwdDisplay: string, env: Record<string, string> }} opts
 */
export async function openPwshSession(opts) {
  const bin = resolvePwshBinary();
  if (!bin) {
    return {
      ok: false,
      error:
        'PowerShell not found. Install PowerShell 7+ (pwsh), or on Windows use Windows PowerShell.',
    };
  }
  if (sessions.size >= MAX_SESSIONS) {
    return { ok: false, error: `too many persistent pwsh sessions (max ${MAX_SESSIONS})` };
  }
  const marker = `${MARKER_PREFIX}${Math.random().toString(36).slice(2, 10)}__ `;
  let session = await openPtySession(bin, opts.cwdAbs, opts.cwdDisplay, opts.env, marker);
  if (!session) {
    session = await openPipeSession(bin, opts.cwdAbs, opts.cwdDisplay, opts.env, marker);
  }
  return {
    ok: true,
    sessionId: session.id,
    backend: session.backend,
    pwsh: bin,
    session: publicSession(session),
  };
}

/**
 * @param {{ sessionId: string, command: string, timeoutMs?: number }} opts
 */
export async function execPwshSession(opts) {
  const id = String(opts.sessionId || '').trim();
  const command = String(opts.command || '');
  const allowed = assertCommandAllowed(command);
  if (!allowed.ok) return { ok: false, error: allowed.error };

  const session = sessions.get(id);
  if (!session) return { ok: false, error: 'session not found' };
  if (session.status !== 'running') {
    return {
      ok: false,
      error: `session not running (${session.status})`,
      session: publicSession(session),
    };
  }

  const timeoutMs = Math.min(
    Math.max(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000),
    120_000,
  );

  // Flatten newlines for pipe driver (single ReadLine)
  const payload = session.backend === 'pipe' ? command.replace(/\r?\n/g, '; ') : command;

  session.lastActiveAt = Date.now();
  session.aliveBuf = '';

  try {
    if (session.backend === 'pty' && session.pty) {
      session.pty.write(`${payload}\n`);
    } else if (session.child?.stdin) {
      session.child.stdin.write(`${payload}\n`);
    } else {
      return { ok: false, error: 'session has no writable stdin' };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const { output, timedOut, exited } = await waitForMarker(session, session.marker, timeoutMs);
  session.lastActiveAt = Date.now();

  let text = output;
  const echoIdx = text.indexOf(payload);
  if (echoIdx >= 0 && echoIdx < 8) {
    text = text.slice(echoIdx + payload.length).replace(/^\r?\n/, '');
  }

  return {
    ok: !timedOut && !exited,
    sessionId: session.id,
    backend: session.backend,
    output: text,
    timedOut,
    exited,
    session: publicSession(session),
  };
}

export function readPwshSession(sessionId, offset = 0) {
  const session = sessions.get(String(sessionId || '').trim());
  if (!session) return { ok: false, error: 'session not found' };
  const off = Math.max(0, Number(offset) || 0);
  const slice = session.scroll.slice(off);
  return {
    ok: true,
    session: publicSession(session),
    output: slice,
    offset: off,
    nextOffset: off + slice.length,
    truncated: session.truncated,
  };
}

const ALLOWED_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGTSTP', 'SIGHUP']);

/**
 * @param {{ sessionId: string, data?: string, text?: string, submit?: boolean }} opts
 */
export function writePwshSession(opts) {
  const id = String(opts.sessionId || '').trim();
  const session = sessions.get(id);
  if (!session) return { ok: false, error: 'session not found' };
  if (session.status !== 'running') {
    return {
      ok: false,
      error: `session not running (${session.status})`,
      session: publicSession(session),
    };
  }
  let payload = String(opts.data ?? opts.text ?? '');
  if (opts.submit !== false && !payload.endsWith('\n')) payload += '\n';
  if (!payload) return { ok: false, error: 'data is required' };
  try {
    if (session.backend === 'pty' && session.pty) {
      session.pty.write(payload);
    } else if (session.child?.stdin) {
      session.child.stdin.write(payload);
    } else {
      return { ok: false, error: 'session has no writable stdin' };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  session.lastActiveAt = Date.now();
  return {
    ok: true,
    sessionId: session.id,
    backend: session.backend,
    bytes: Buffer.byteLength(payload, 'utf8'),
    session: publicSession(session),
  };
}

/**
 * @param {{ sessionId: string, signal?: string }} opts
 */
export function signalPwshSession(opts) {
  const id = String(opts.sessionId || '').trim();
  const signal = String(opts.signal || 'SIGINT')
    .trim()
    .toUpperCase();
  if (!ALLOWED_SIGNALS.has(signal)) {
    return {
      ok: false,
      error: `unsupported signal (allowed: ${[...ALLOWED_SIGNALS].join(', ')})`,
    };
  }
  const session = sessions.get(id);
  if (!session) return { ok: false, error: 'session not found' };
  if (session.status !== 'running') {
    return {
      ok: false,
      error: `session not running (${session.status})`,
      session: publicSession(session),
    };
  }
  try {
    if (session.backend === 'pty' && session.pty) {
      if (typeof session.pty.kill === 'function') {
        session.pty.kill(signal);
      } else if (session.pty.pid) {
        process.kill(session.pty.pid, signal);
      } else {
        return { ok: false, error: 'pty has no kill' };
      }
    } else if (session.child) {
      session.child.kill(signal);
    } else {
      return { ok: false, error: 'session has no process' };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  session.lastActiveAt = Date.now();
  return {
    ok: true,
    sessionId: session.id,
    signal,
    backend: session.backend,
    session: publicSession(session),
  };
}

export function closePwshSession(sessionId) {
  return closeSessionInternal(String(sessionId || '').trim());
}

export function listPwshSessions() {
  return [...sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).map(publicSession);
}

export function pwshSessionStats() {
  return {
    count: sessions.size,
    max: MAX_SESSIONS,
  };
}

/**
 * 关闭所有常驻会话。数据空间切换时必须调用：会话的 cwd / env 绑在旧空间上，
 * 继续复用会读到上一个空间的文件。
 */
export function closeAllPwshSessions() {
  for (const id of [...sessions.keys()]) closeSessionInternal(id);
}

export function resetPwshSessionsForTests() {
  closeAllPwshSessions();
}

export { buildChildEnv };
