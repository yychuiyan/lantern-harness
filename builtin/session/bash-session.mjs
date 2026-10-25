/**
 * 持久 bash 会话：优先 node-pty，失败则管道 + marker 回退。
 */
import { spawn } from 'node:child_process';
import { assertCommandAllowed, buildChildEnv } from './sandbox-policy.mjs';

const MAX_SESSIONS = 4;
const SCROLL_MAX = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MARKER_PREFIX = '__TB_PS1_';

/** @type {Map<string, object>} */
const sessions = new Map();

/** @type {boolean | null} */
let ptyAvailableCache = null;
/** @type {any} */
let ptyModule = null;

export async function detectPtyBackend() {
  if (ptyAvailableCache != null) {
    return { available: ptyAvailableCache, pty: ptyModule };
  }
  try {
    ptyModule = await import('node-pty');
    ptyAvailableCache = true;
  } catch {
    ptyModule = null;
    ptyAvailableCache = false;
  }
  return { available: ptyAvailableCache, pty: ptyModule };
}

export function ptyAvailableSync() {
  return ptyAvailableCache === true;
}

/**
 * 标记 pty 后端不可用：`import('node-pty')` 可能成功，但真正 spawn 时失败
 * （例如 macOS 上 prebuilds 的 spawn-helper 解包后没有可执行位）。
 * 一旦失败就永久降级为管道会话，避免每个会话都重复踩坑。
 */
export function markPtyUnavailable() {
  ptyAvailableCache = false;
  ptyModule = null;
}

function uid() {
  return `sh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function bashBinary() {
  return process.platform === 'win32' ? 'bash' : '/bin/bash';
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

/**
 * Wait until marker appears in aliveBuf (or timeout / exit).
 * @returns {Promise<{ output: string, timedOut: boolean, exited: boolean }>}
 */
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

async function openPtySession(cwdAbs, cwdDisplay, env, marker) {
  const { available, pty } = await detectPtyBackend();
  if (!available || !pty) return null;
  const bin = bashBinary();
  let term;
  try {
    term = pty.spawn(bin, ['--noprofile', '--norc'], {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: cwdAbs,
      env: {
        ...env,
        TERM: 'xterm-256color',
        PS1: `${marker}`,
        PROMPT_COMMAND: '',
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
  // drain initial prompt
  await waitForMarker(session, marker, 5_000);
  session.aliveBuf = '';
  return session;
}

async function openPipeSession(cwdAbs, cwdDisplay, env, marker) {
  const bin = bashBinary();
  // Interactive-ish: read commands from stdin line by line via a tiny driver loop
  const driver = [
    `export PS1='${marker}'`,
    `export PROMPT_COMMAND=''`,
    `printf '%s' "$PS1"`,
    `while IFS= read -r __tb_line || [ -n "$__tb_line" ]; do`,
    `  eval "$__tb_line"`,
    `  printf '%s' "$PS1"`,
    `done`,
  ].join('\n');

  const child = spawn(bin, ['--noprofile', '--norc', '-c', driver], {
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
  await waitForMarker(session, marker, 5_000);
  session.aliveBuf = '';
  return session;
}

/**
 * @param {{ cwdAbs: string, cwdDisplay: string, env: Record<string, string> }} opts
 */
export async function openBashSession(opts) {
  if (sessions.size >= MAX_SESSIONS) {
    return { ok: false, error: `too many persistent sessions (max ${MAX_SESSIONS})` };
  }
  const marker = `${MARKER_PREFIX}${Math.random().toString(36).slice(2, 10)}__ `;
  let session = await openPtySession(opts.cwdAbs, opts.cwdDisplay, opts.env, marker);
  if (!session) {
    session = await openPipeSession(opts.cwdAbs, opts.cwdDisplay, opts.env, marker);
  }
  return {
    ok: true,
    sessionId: session.id,
    backend: session.backend,
    session: publicSession(session),
  };
}

/**
 * @param {{ sessionId: string, command: string, timeoutMs?: number }} opts
 */
export async function execBashSession(opts) {
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

  // Normalize to single-line for pipe driver; keep newlines as ; for pty
  const payload = session.backend === 'pipe' ? command.replace(/\r?\n/g, ' ; ') : command;

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

  // Strip echoed command line if present at start
  let text = output;
  const echoIdx = text.indexOf(payload);
  if (echoIdx >= 0 && echoIdx < 8) {
    const after = text.slice(echoIdx + payload.length).replace(/^\r?\n/, '');
    text = after;
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

export function readBashSession(sessionId, offset = 0) {
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
 * 向持久会话 stdin 写入原始文本（不等待 PS1）。
 * @param {{ sessionId: string, data?: string, text?: string, submit?: boolean }} opts
 */
export function writeBashSession(opts) {
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
export function signalBashSession(opts) {
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

export function closeBashSession(sessionId) {
  return closeSessionInternal(String(sessionId || '').trim());
}

export function listBashSessions() {
  return [...sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).map(publicSession);
}

export function sessionStats() {
  return {
    count: sessions.size,
    max: MAX_SESSIONS,
    pty: ptyAvailableCache === true,
    ptyProbed: ptyAvailableCache != null,
  };
}

/**
 * 关闭所有常驻会话。数据空间切换时必须调用：会话的 cwd / env 绑在旧空间上，
 * 继续复用会读到上一个空间的文件。
 */
export function closeAllBashSessions() {
  for (const id of [...sessions.keys()]) closeSessionInternal(id);
}

/** 测试用 */
export function resetBashSessionsForTests() {
  closeAllBashSessions();
  ptyAvailableCache = false;
  ptyModule = null;
}

export { buildChildEnv };
