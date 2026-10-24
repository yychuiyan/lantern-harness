/**
 * 服务端会话回合：进程内跑 LLM+工具，刷新/切页可 SSE 重连。
 * API：
 *   POST   /__tb_sessions/runs
 *   GET    /__tb_sessions/runs
 *   GET    /__tb_sessions/runs/:sessionId/events
 *   POST   /__tb_sessions/runs/:sessionId/stop
 *   POST   /__tb_sessions/runs/:sessionId/answer
 */
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from './space-context.mjs';
import { LOCAL_REL } from './space-layout.mjs';

const PREFIX = '/__tb_sessions/runs';

/**
 * 工具轮默认上限，与浏览器侧 `src/lib/llm.ts` 的 DEFAULT_MAX_TOOL_ROUNDS 对齐。
 * 以前是 5：调研类任务常需 6~10 个工具步骤，会在中途被收口，看起来像「自动终止」。
 */
const DEFAULT_TOOL_ROUNDS = 100;

/** @type {Map<string, import('./session-runs.mjs').SessionRun>} */
const runs = new Map();

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

function sessionsPath(root) {
  return path.join(root, LOCAL_REL, 'sessions.json');
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
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

function originFromReq(req) {
  const raw = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:4321';
  // Host: localhost → 回环统一到 127.0.0.1，与地址栏/绑定一致
  const host = String(raw).replace(/^localhost(?=:\d+$|$)/i, '127.0.0.1');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

/**
 * 从 http.Server address 得到可供 Node fetch 回环调用的 origin。
 * 与地址栏一致优先 127.0.0.1；IPv6 字面量必须带方括号。
 */
function loopbackOriginFromAddress(addr) {
  if (!addr || typeof addr !== 'object' || !addr.port) return '';
  const port = addr.port;
  const a = String(addr.address || '');
  if (!a || a === '::' || a === '0.0.0.0' || a === '::1' || a === '127.0.0.1') {
    return `http://127.0.0.1:${port}`;
  }
  if (a.includes(':')) return `http://[${a}]:${port}`;
  return `http://${a}:${port}`;
}

// ── DSML scrub（与 src/lib/llm.ts 对齐；含空格变体 `< | | DSML | |`）──
const DSML_PIPE = '[\\uFF5C|]';
const DSML_PIPES = `(?:${DSML_PIPE}\\s*){1,3}`;
const DSML_OPEN = `<\\s*${DSML_PIPES}DSML\\s*${DSML_PIPES}`;
const DSML_CLOSE = `<\\/\\s*${DSML_PIPES}DSML\\s*${DSML_PIPES}`;

function looksLikeDsml(text) {
  return typeof text === 'string' && /DSML/i.test(text);
}

function scrubDsmlArtifacts(text) {
  if (!text || !/DSML/i.test(text)) return text;
  const detectors = [
    new RegExp(DSML_OPEN, 'i'),
    /<\s*\/?\s*[\s\uFF5C|]*DSML/i,
    /[\uFF5C|](?:\s*[\uFF5C|])*\s*DSML/i,
    /DSML\s*(?:[\uFF5C|]\s*){0,3}(?:tool_)?calls/i,
    /DSML\s*(?:[\uFF5C|]\s*){0,3}invoke/i,
    /DSML\s*(?:[\uFF5C|]\s*){0,3}parameter/i,
  ];
  let cut = -1;
  for (const re of detectors) {
    const m = re.exec(text);
    if (m && m.index != null && (cut < 0 || m.index < cut)) cut = m.index;
  }
  if (cut > 0) {
    const lt = text.lastIndexOf('<', cut);
    if (lt >= 0 && cut - lt < 24) cut = lt;
  }
  if (cut >= 0) return text.slice(0, cut).trimEnd();
  return text
    .split('\n')
    .filter((line) => !/DSML/i.test(line))
    .join('\n')
    .trim();
}

function sanitizeText(text) {
  if (!text) return '';
  if (!looksLikeDsml(text)) return text;
  const { cleaned } = parseDsmlToolCalls(text);
  return scrubDsmlArtifacts(cleaned);
}

function parseDsmlToolCalls(content) {
  if (!content || !/DSML/i.test(content)) return { calls: [], cleaned: content || '' };
  const invokeRe = new RegExp(
    `${DSML_OPEN}\\s*invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)${DSML_CLOSE}\\s*invoke\\s*>`,
    'gi',
  );
  const paramRe = new RegExp(
    `${DSML_OPEN}\\s*parameter\\s+name="([^"]+)"\\s+string="(true|false)"\\s*>([\\s\\S]*?)${DSML_CLOSE}\\s*parameter\\s*>`,
    'gi',
  );
  const calls = [];
  let m;
  while ((m = invokeRe.exec(content)) !== null) {
    const name = (m[1] || '').trim();
    if (!name) continue;
    const args = {};
    let pm;
    paramRe.lastIndex = 0;
    const body = m[2] || '';
    while ((pm = paramRe.exec(body)) !== null) {
      const key = pm[1];
      if (!key) continue;
      const raw = pm[3] ?? '';
      if (pm[2] === 'true') args[key] = raw;
      else {
        try {
          args[key] = JSON.parse(raw);
        } catch {
          args[key] = raw;
        }
      }
    }
    calls.push({
      id: `dsml_${Date.now().toString(36)}_${calls.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return { calls, cleaned: scrubDsmlArtifacts(content) };
}

function resolveToolCalls(result) {
  const structured = (result.tool_calls || []).filter((c) => c?.function?.name);
  const raw = result.content;
  if (structured.length) {
    return {
      calls: structured,
      content: typeof raw === 'string' ? sanitizeText(raw) || null : raw,
    };
  }
  if (typeof raw === 'string' && raw) {
    const { calls, cleaned } = parseDsmlToolCalls(raw);
    if (calls.length) return { calls, content: sanitizeText(cleaned) || null };
    return { calls: [], content: sanitizeText(raw) || null };
  }
  return { calls: [], content: raw ?? null };
}

function pruneToolResult(text) {
  const s = String(text ?? '');
  if (s.length <= 12_000) return s;
  return `${s.slice(0, 12_000)}\n…[truncated ${s.length - 12_000} chars]`;
}

function isRetryableHttpStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isRetryableLlmError(err) {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';
  if (msg.includes('网络请求失败')) return true;
  if (msg.includes('限流') || msg.includes('繁忙')) return true;
  if (/service_unavailable/i.test(msg) || /too busy/i.test(msg)) return true;
  if (/\(HTTP (429|502|503|504)\)/.test(msg)) return true;
  if (/请求失败（HTTP (429|502|503|504)）/.test(msg)) return true;
  return false;
}

function retryDelayMs(attempt, baseDelayMs = 500) {
  const n = Math.max(0, attempt);
  const jitter = Math.floor(Math.random() * 160);
  return Math.min(8_000, baseDelayMs * 2 ** n + jitter);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function withLlmRetry(fn, signal, maxAttempts = 4) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (!isRetryableLlmError(e) || attempt >= maxAttempts - 1) throw e;
      await sleep(retryDelayMs(attempt), signal);
    }
  }
  throw lastErr;
}

function friendlyLlmError(status, bodyText) {
  let code = '';
  let message = '';
  try {
    const json = JSON.parse(bodyText || '{}');
    const err = json?.error;
    if (typeof err === 'object' && err) {
      code = String(err.code || err.type || '');
      message = String(err.message || '');
    } else if (typeof err === 'string') {
      message = err;
    }
  } catch {
    // ignore
  }
  if (status === 401) return new Error('API Key 无效或已过期（401），请检查模型设置');
  if (status === 403) return new Error('访问被拒绝（403），请检查 Key 权限或账户状态');
  if (status === 429) return new Error('请求被限流（429），请稍后重试或检查账户额度');
  if (
    status === 503 ||
    code === 'service_unavailable_error' ||
    /too busy|service.?unavailable/i.test(message) ||
    /too busy|service.?unavailable/i.test(bodyText || '')
  ) {
    return new Error('模型服务瞬时繁忙，请稍后重试（已自动重试仍失败）');
  }
  if (status === 404) {
    return new Error('接口地址不存在（404），请检查 Base URL 是否以 /v1 结尾、模型名是否正确');
  }
  const snippet = (message || bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return new Error(`请求失败（HTTP ${status}）${snippet ? `：${snippet}` : ''}`);
}

async function completeOnce(settings, messages, signal, tools, thinking) {
  const url = `${String(settings.baseURL || '').replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: settings.model,
    messages,
    stream: false,
    temperature: 0.3,
  };
  if (thinking === false) body.thinking = { type: 'disabled' };
  else if (settings.reasoningEffort) body.reasoning_effort = settings.reasoningEffort;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const res = await withLlmRetry(
    async () => {
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        throw new Error('网络请求失败，请检查 Base URL 是否可达');
      }
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        const err = friendlyLlmError(r.status, text);
        if (isRetryableHttpStatus(r.status) || isRetryableLlmError(err)) throw err;
        throw err;
      }
      return r;
    },
    signal,
    4,
  );
  const json = await res.json().catch(() => ({}));
  const msg = json?.choices?.[0]?.message ?? {};
  const usageRaw = json?.usage;
  return {
    content: msg.content ?? null,
    reasoning_content:
      typeof msg.reasoning_content === 'string' && msg.reasoning_content
        ? msg.reasoning_content
        : undefined,
    tool_calls: msg.tool_calls,
    usage:
      usageRaw && typeof usageRaw.prompt_tokens === 'number'
        ? {
            promptTokens: usageRaw.prompt_tokens,
            completionTokens: usageRaw.completion_tokens ?? 0,
            totalTokens: usageRaw.total_tokens ?? usageRaw.prompt_tokens,
          }
        : undefined,
  };
}

async function* streamChat(settings, messages, signal, thinking) {
  const url = `${String(settings.baseURL || '').replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: settings.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.3,
  };
  if (thinking === false) body.thinking = { type: 'disabled' };
  else if (settings.reasoningEffort) body.reasoning_effort = settings.reasoningEffort;
  const res = await withLlmRetry(
    async () => {
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        throw new Error('网络请求失败，请检查 Base URL 是否可达');
      }
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        const err = friendlyLlmError(r.status, text);
        if (isRetryableHttpStatus(r.status) || isRetryableLlmError(err)) throw err;
        throw err;
      }
      return r;
    },
    signal,
    4,
  );
  if (!res.body) throw new Error('响应无内容流');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = json?.choices?.[0]?.delta ?? {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        yield { type: 'reasoning', delta: delta.reasoning_content };
      }
      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'content', delta: delta.content };
      }
      const u = json?.usage;
      if (u && typeof u.prompt_tokens === 'number') {
        yield {
          type: 'usage',
          usage: {
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens ?? 0,
            totalTokens: u.total_tokens ?? u.prompt_tokens,
          },
        };
      }
    }
  }
}

async function* streamScrubbing(settings, messages, signal, thinking, out) {
  let contentBuf = '';
  let dsmlHold = false;
  let visibleEmitted = '';
  let reasoningBuf = '';
  let reasoningHold = false;
  let reasoningEmitted = '';
  for await (const chunk of streamChat(settings, messages, signal, thinking)) {
    if (chunk.type === 'reasoning') {
      reasoningBuf += chunk.delta;
      if (!reasoningHold) {
        if (looksLikeDsml(reasoningBuf)) {
          reasoningHold = true;
          const safe = sanitizeText(reasoningBuf);
          const delta = safe.slice(reasoningEmitted.length);
          if (delta) {
            reasoningEmitted = safe;
            yield { type: 'reasoning', delta };
          }
          continue;
        }
        const hold = 24;
        if (reasoningBuf.length > hold) {
          const safe = reasoningBuf.slice(0, reasoningBuf.length - hold);
          const delta = safe.slice(reasoningEmitted.length);
          if (delta) {
            reasoningEmitted = safe;
            yield { type: 'reasoning', delta };
          }
        }
      }
      continue;
    }
    if (chunk.type !== 'content') {
      yield chunk;
      continue;
    }
    contentBuf += chunk.delta;
    if (!dsmlHold) {
      if (looksLikeDsml(contentBuf)) {
        dsmlHold = true;
        const safe = scrubDsmlArtifacts(contentBuf);
        const delta = safe.slice(visibleEmitted.length);
        if (delta && !looksLikeDsml(delta)) {
          visibleEmitted = safe;
          yield { type: 'content', delta };
        } else {
          visibleEmitted = scrubDsmlArtifacts(visibleEmitted);
        }
        continue;
      }
      const startRe = new RegExp(DSML_OPEN, 'i');
      const m = startRe.exec(contentBuf);
      if (m && m.index != null) {
        dsmlHold = true;
        const safe = contentBuf.slice(0, m.index);
        const delta = safe.slice(visibleEmitted.length);
        if (delta) {
          visibleEmitted = safe;
          yield { type: 'content', delta };
        }
        continue;
      }
      const hold = 48;
      if (contentBuf.length > hold) {
        const safe = contentBuf.slice(0, contentBuf.length - hold);
        const delta = safe.slice(visibleEmitted.length);
        if (delta) {
          visibleEmitted = safe;
          yield { type: 'content', delta };
        }
      }
    }
  }
  if (reasoningBuf) {
    if (out) out.reasoningRaw = reasoningBuf;
    const finalR = sanitizeText(reasoningBuf);
    const restR = finalR.slice(reasoningEmitted.length);
    if (restR) yield { type: 'reasoning', delta: restR };
  }
  const parsed = parseDsmlToolCalls(contentBuf);
  if (parsed.calls.length && out) out.dsmlCalls = parsed.calls;
  const finalC = sanitizeText(contentBuf);
  if (!looksLikeDsml(finalC) && finalC.length >= visibleEmitted.length) {
    const restC = finalC.slice(visibleEmitted.length);
    if (restC) yield { type: 'content', delta: restC };
  }
}

async function loopbackPost(origin, pathName, body, signal) {
  try {
    const res = await fetch(`${origin}${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text || `HTTP ${res.status}` };
    }
  } catch (e) {
    if (
      (e instanceof DOMException && e.name === 'AbortError') ||
      String(e?.name || '') === 'AbortError' ||
      signal?.aborted
    ) {
      throw e;
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function runToolLoopback(origin, name, argsJson, ctx) {
  let args = {};
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }
  const access = ctx.access || 'default';
  const signal = ctx.signal;

  if (name === 'web_search') {
    const query = Array.isArray(args.query)
      ? args.query[0]
      : String(args.query ?? args.q ?? '').trim();
    const maxResults = Math.min(12, Math.max(1, Number(args.maxResults) || 8));
    const data = await loopbackPost(origin, '/__tb_web/search', { query, maxResults }, signal);
    if (data.error && !data.results?.length) return `Web search failed: ${data.error}`;
    const lines = (data.results || []).map(
      (r, i) => `${i + 1}. ${r.title || ''}\n   ${r.url || ''}\n   ${r.snippet || ''}`,
    );
    return lines.length ? `Web search results:\n${lines.join('\n')}` : 'Web search: no results';
  }
  if (name === 'web_fetch') {
    const data = await loopbackPost(
      origin,
      '/__tb_web/fetch',
      { url: String(args.url ?? '') },
      signal,
    );
    if (data.error && !data.text) return `Web fetch failed: ${data.error}`;
    return `URL: ${data.url || args.url}\nTitle: ${data.title || ''}\n\n${data.text || ''}`;
  }
  if (name.startsWith('fs_')) {
    const map = {
      fs_list: '/__tb_fs/list',
      fs_read: '/__tb_fs/read',
      fs_write: '/__tb_fs/write',
      fs_mkdir: '/__tb_fs/mkdir',
      fs_glob: '/__tb_fs/glob',
      fs_grep: '/__tb_fs/grep',
    };
    const p = map[name];
    if (!p) return JSON.stringify({ error: `unknown tool: ${name}` });
    const data = await loopbackPost(origin, p, { ...args, access }, signal);
    return JSON.stringify(data);
  }
  if (name.startsWith('skill_')) {
    const data = await loopbackPost(
      origin,
      name === 'skill_list' ? '/__tb_fs/skill/list' : '/__tb_fs/skill/read',
      { ...args, access },
      signal,
    );
    return JSON.stringify(data);
  }
  if (name === 'bash' || name === 'pwsh') {
    const api = name === 'pwsh' ? '/__tb_pwsh/exec' : '/__tb_bash/exec';
    const data = await loopbackPost(
      origin,
      api,
      {
        command: args.command,
        workdir: args.workdir,
        background: args.background,
        access,
      },
      signal,
    );
    return JSON.stringify(data);
  }
  if (name.startsWith('job_')) {
    if (name === 'job_list') {
      const res = await fetch(`${origin}/__tb_bash/jobs`, { signal });
      return await res.text();
    }
    if (name === 'job_output') {
      const data = await loopbackPost(
        origin,
        '/__tb_bash/job_output',
        { id: args.id || args.jobId },
        signal,
      );
      return JSON.stringify(data);
    }
    if (name === 'job_kill') {
      const data = await loopbackPost(
        origin,
        '/__tb_bash/job_kill',
        { id: args.id || args.jobId },
        signal,
      );
      return JSON.stringify(data);
    }
  }
  if (name.startsWith('bash_session_') || name.startsWith('pwsh_session_')) {
    const isPwsh = name.startsWith('pwsh_session_');
    const base = isPwsh ? '/__tb_pwsh/session' : '/__tb_bash/session';
    const action = name.replace(/^(bash|pwsh)_session_/, '');
    const map = {
      list: `${base}/list`,
      open: `${base}/open`,
      exec: `${base}/exec`,
      read: `${base}/read`,
      close: `${base}/close`,
    };
    const p = map[action];
    if (!p) return JSON.stringify({ error: `unknown tool: ${name}` });
    if (action === 'list') {
      const res = await fetch(`${origin}${p}`, { signal });
      return await res.text();
    }
    const data = await loopbackPost(origin, p, { ...args, access }, signal);
    return JSON.stringify(data);
  }
  if (name.startsWith('memory_')) {
    const action = name.replace(/^memory_/, '');
    const pathMap = {
      search: '/__tb_memory/search',
      read: '/__tb_memory/snapshot',
      suggest: '/__tb_memory/suggest',
      append: '/__tb_memory/append',
    };
    const p = pathMap[action] || `/__tb_memory/${action}`;
    const data = await loopbackPost(origin, p, { ...args, cwd: ctx.workspace || args.cwd }, signal);
    return JSON.stringify(data);
  }
  if (name === 'office_to_pdf') {
    const data = await loopbackPost(origin, '/__tb_fs/office-to-pdf', { ...args, access }, signal);
    return JSON.stringify(data);
  }
  if (name === 'load_workspace_dependencies') {
    const data = await loopbackPost(origin, '/__tb_fs/workspace-dependencies', { access }, signal);
    return JSON.stringify(data);
  }
  if (name.startsWith('working_directory_')) {
    const action = name.replace('working_directory_', '');
    const data = await loopbackPost(
      origin,
      `/__tb_fs/working-directory/${action}`,
      { ...args, access },
      signal,
    );
    return JSON.stringify(data);
  }
  if (name === 'todo_write') {
    const todos = Array.isArray(args.todos) ? args.todos : [];
    patchSessionMeta(ctx.root, ctx.sessionId, { todos });
    return JSON.stringify({ ok: true, count: todos.length, todos });
  }
  if (name.startsWith('goal_')) {
    const store = readJson(sessionsPath(ctx.root), null);
    const sess = store?.sessions?.find((s) => s.id === ctx.sessionId);
    if (name === 'goal_get') {
      return JSON.stringify({ ok: true, goal: sess?.goal ?? null });
    }
    if (name === 'goal_set') {
      const text = String(args.text || '')
        .trim()
        .slice(0, 500);
      if (!text) return JSON.stringify({ error: 'text is required' });
      const goal = { text, status: 'active', updatedAt: Date.now() };
      patchSessionMeta(ctx.root, ctx.sessionId, { goal });
      return JSON.stringify({ ok: true, goal });
    }
    if (name === 'goal_done') {
      const cur = sess?.goal;
      if (!cur?.text) return JSON.stringify({ ok: false, error: 'no goal to complete' });
      const goal = { ...cur, status: 'done', updatedAt: Date.now() };
      patchSessionMeta(ctx.root, ctx.sessionId, { goal });
      return JSON.stringify({ ok: true, goal });
    }
    if (name === 'goal_clear') {
      patchSessionMeta(ctx.root, ctx.sessionId, { goal: undefined });
      return JSON.stringify({ ok: true, goal: null });
    }
  }
  if (name.startsWith('schedule_')) {
    return JSON.stringify({
      error: 'schedule tools are not available in server-side runs yet',
    });
  }
  if (name === 'present') {
    return JSON.stringify({
      ok: true,
      files: Array.isArray(args.files) ? args.files : [],
      note: 'present recorded for UI',
    });
  }
  if (name === 'ask_user_question') {
    return JSON.stringify({
      error: 'ask_user_question requires interactive UI; use browser fallback for this tool',
    });
  }
  if (
    name === 'spawn_subagent' ||
    name === 'fork_subagent' ||
    name === 'list_agents' ||
    name.startsWith('subagent_') ||
    name === 'workflow'
  ) {
    return JSON.stringify({
      error: `${name} is not available in server-side runs yet`,
    });
  }
  return JSON.stringify({ error: `unknown tool: ${name}` });
}

function patchSessionMeta(root, sessionId, patch) {
  const store = readJson(sessionsPath(root), null);
  if (!store?.sessions) return;
  store.sessions = store.sessions.map((s) =>
    s.id === sessionId ? { ...s, ...patch, updatedAt: Date.now() } : s,
  );
  writeJson(sessionsPath(root), store);
}

function patchSessionAssistant(root, sessionId, assistantPatch) {
  const store = readJson(sessionsPath(root), null);
  if (!store?.sessions) return;
  store.sessions = store.sessions.map((s) => {
    if (s.id !== sessionId) return s;
    const messages = Array.isArray(s.messages) ? [...s.messages] : [];
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') {
      messages[messages.length - 1] = { ...last, ...assistantPatch };
    } else {
      messages.push({ role: 'assistant', content: '', ...assistantPatch });
    }
    return { ...s, messages: messages.slice(-80), updatedAt: Date.now() };
  });
  writeJson(sessionsPath(root), store);
}

function activityKind(name) {
  if (name === 'web_search') return 'web_search';
  if (name === 'web_fetch') return 'web_fetch';
  if (name.startsWith('fs_') || name.startsWith('skill_')) return 'fs';
  if (name.startsWith('memory_')) return 'memory';
  return 'tool';
}

function toolTitle(name) {
  if (name === 'web_search') return '网页搜索';
  if (name === 'web_fetch') return '网页获取';
  if (name.startsWith('fs_')) return '文件';
  if (name.startsWith('memory_')) return '记忆';
  if (name === 'bash' || name.startsWith('bash_')) return 'Bash';
  if (name === 'pwsh' || name.startsWith('pwsh_')) return 'PowerShell';
  return name;
}

function emit(run, ev) {
  run.seq += 1;
  const event = { ...ev, seq: run.seq, ts: Date.now() };
  run.events.push(event);
  if (run.events.length > 2000) run.events.splice(0, run.events.length - 1500);
  for (const client of run.clients) {
    try {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // ignore broken pipe
    }
  }
}

function noteFirstToken(run) {
  if (!run.timing) return;
  if (run.timing.firstTokenAt == null) run.timing.firstTokenAt = Date.now();
}

function freezeTiming(run) {
  if (!run.timing) return;
  const now = Date.now();
  const start = run.timing.startAt || run.startedAt || now;
  const first = run.timing.firstTokenAt;
  const llmMs = Math.max(0, now - start);
  const ttftMs = first != null ? Math.max(0, first - start) : undefined;
  const usage = run.assistant.usage;
  let completion = Number(usage?.completionTokens) || 0;
  if (
    completion <= 0 &&
    usage &&
    typeof usage.totalTokens === 'number' &&
    typeof usage.promptTokens === 'number'
  ) {
    completion = Math.max(0, usage.totalTokens - usage.promptTokens);
  }
  const decodeMs = ttftMs != null ? Math.max(0, llmMs - ttftMs) : 0;
  const tps = decodeMs > 200 && completion > 0 ? completion / (decodeMs / 1000) : undefined;
  run.assistant.llmMs = llmMs;
  run.assistant.ttftMs = ttftMs;
  run.assistant.toolMs = run.timing.toolMs || 0;
  if (tps != null) run.assistant.tps = tps;
}

function snapshotAssistant(run) {
  return {
    role: 'assistant',
    content: run.assistant.content || '',
    reasoning: run.assistant.reasoning || undefined,
    reasoningApi: run.assistant.reasoningApi || undefined,
    activitySteps: run.assistant.activitySteps || [],
    turnStatus: run.status === 'running' || run.status === 'waiting_user' ? 'running' : run.status,
    usage: run.assistant.usage,
    model: run.settings?.model,
    time: Date.now(),
    llmMs: run.assistant.llmMs,
    ttftMs: run.assistant.ttftMs,
    toolMs: run.assistant.toolMs,
    tps: run.assistant.tps,
  };
}

function persistAssistant(run) {
  try {
    patchSessionAssistant(run.root, run.sessionId, snapshotAssistant(run));
  } catch {
    // ignore
  }
}

/** 执行一批工具调用并写入 apiMessages / 时间线 */
async function execToolCalls(run, calls, content, reasoning, apiMessages, origin, ctx, signal) {
  if (reasoning) {
    run.assistant.reasoningApi = reasoning;
    const forUi = sanitizeText(reasoning);
    if (forUi) applyChunk(run, { type: 'reasoning', delta: forUi });
  }
  const assistantMsg = {
    role: 'assistant',
    content: content ?? null,
    tool_calls: calls,
  };
  if (reasoning) assistantMsg.reasoning_content = reasoning;
  apiMessages.push(assistantMsg);
  for (const call of calls) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const name = call.function.name;
    const args = call.function.arguments ?? '{}';
    applyChunk(run, { type: 'tool', name, status: 'running', args });
    let out;
    try {
      out = await runToolLoopback(origin, name, args, ctx);
    } catch (toolErr) {
      const aborted =
        (toolErr instanceof DOMException && toolErr.name === 'AbortError') ||
        signal.aborted ||
        String(toolErr?.name || '') === 'AbortError';
      if (aborted) throw toolErr;
      out = JSON.stringify({
        error: toolErr instanceof Error ? toolErr.message : String(toolErr),
      });
    }
    const pruned = pruneToolResult(out);
    applyChunk(run, {
      type: 'tool',
      name,
      status: 'done',
      args,
      result: pruned.length > 800 ? `${pruned.slice(0, 800)}…` : pruned,
    });
    apiMessages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: pruned,
    });
  }
  // 终轮若误把 DSML 当正文吐过，清掉脏 content
  if (looksLikeDsml(run.assistant.content || '')) {
    run.assistant.content = scrubDsmlArtifacts(run.assistant.content || '');
  }
  persistAssistant(run);
}

/**
 * 终轮流式。
 * @returns {Promise<{ calls: object[], reasoning?: string }>}
 * 若终轮正文其实是 DSML 工具调用，返回待执行的 calls，并带上本轮原始 reasoning_content
 *（DeepSeek 思考模式后续请求必须原样回传，不可丢）。
 */
async function streamFinalAnswer(run, settings, apiMessages, signal, thinking) {
  const out = {};
  for await (const chunk of streamScrubbing(settings, apiMessages, signal, thinking, out)) {
    applyChunk(run, chunk);
  }
  if (out.reasoningRaw) run.assistant.reasoningApi = out.reasoningRaw;
  if (out.dsmlCalls?.length) {
    run.assistant.content = scrubDsmlArtifacts(run.assistant.content || '');
    persistAssistant(run);
    return { calls: out.dsmlCalls, reasoning: out.reasoningRaw };
  }
  if ((run.assistant.content || '').trim() || signal?.aborted) {
    return { calls: [] };
  }
  const result = await completeOnce(settings, apiMessages, signal, undefined, thinking);
  const { calls, content } = resolveToolCalls(result);
  if (calls.length) {
    return { calls, reasoning: result.reasoning_content };
  }
  if (result.reasoning_content) {
    run.assistant.reasoningApi = result.reasoning_content;
    const forUi = sanitizeText(result.reasoning_content);
    const prev = run.assistant.reasoning || '';
    if (forUi && !prev.includes(forUi.slice(0, 40))) {
      applyChunk(run, { type: 'reasoning', delta: forUi });
    }
  }
  const text = typeof content === 'string' ? sanitizeText(content) : '';
  if (text.trim()) {
    applyChunk(run, { type: 'content', delta: text });
    return { calls: [] };
  }
  // 思考模式常见「只想不写」：关思考再要一次正文（对齐 src/lib/llm.ts）
  if (signal?.aborted) return { calls: [] };
  apiMessages.push({
    role: 'user',
    content:
      '（系统提示）本轮尚未写出面向用户的正文。不要再调用工具，也不要输出工具调用标签；请基于以上已获得的信息直接给出最终答复正文，缺信息就说明还缺什么。',
  });
  const forced = {};
  for await (const chunk of streamScrubbing(settings, apiMessages, signal, false, forced)) {
    applyChunk(run, chunk);
  }
  if (forced.reasoningRaw) run.assistant.reasoningApi = forced.reasoningRaw;
  if (forced.dsmlCalls?.length) {
    run.assistant.content = scrubDsmlArtifacts(run.assistant.content || '');
    persistAssistant(run);
    return { calls: forced.dsmlCalls, reasoning: forced.reasoningRaw };
  }
  return { calls: [] };
}

async function executeRun(run) {
  const { settings, messages, tools, origin, signal } = run;
  const thinking = run.thinking;
  const apiMessages = messages.map((m) => {
    const msg = { role: m.role, content: m.content };
    if (m.role === 'assistant' && m.reasoning_content) {
      msg.reasoning_content = m.reasoning_content;
    }
    return msg;
  });
  const maxRounds = run.maxToolRounds || DEFAULT_TOOL_ROUNDS;
  const ctx = {
    root: run.root,
    sessionId: run.sessionId,
    workspace: run.workspace,
    access: run.access || 'default',
    signal,
  };

  try {
    emit(run, { type: 'status', status: 'running' });
    run.assistant.turnStatus = 'running';
    persistAssistant(run);

    const finishWithStream = async () => {
      // 终轮若吐出 DSML 工具调用：执行后再流式，最多追 3 次，避免标签进 UI
      for (let extra = 0; extra < 3; extra++) {
        if (signal.aborted) return;
        const pending = await streamFinalAnswer(run, settings, apiMessages, signal, thinking);
        if (!pending.calls?.length) return;
        // 必须带回本轮 reasoning_content，否则下一跳会 HTTP 400
        await execToolCalls(
          run,
          pending.calls,
          null,
          pending.reasoning,
          apiMessages,
          origin,
          ctx,
          signal,
        );
      }
      // 仍有残留 DSML 则强行清掉
      if (looksLikeDsml(run.assistant.content || '')) {
        run.assistant.content = scrubDsmlArtifacts(run.assistant.content || '');
      }
    };

    if (!tools?.length) {
      await finishWithStream();
    } else {
      let streamedFinal = false;
      for (let round = 0; round < maxRounds; round++) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const result = await completeOnce(settings, apiMessages, signal, tools, thinking);
        const { calls, content } = resolveToolCalls(result);
        if (calls.length) {
          await execToolCalls(
            run,
            calls,
            content,
            result.reasoning_content,
            apiMessages,
            origin,
            ctx,
            signal,
          );
          continue;
        }
        // 探测轮已有正文：直接落盘，避免再开思考流写成空
        if (result.reasoning_content) {
          run.assistant.reasoningApi = result.reasoning_content;
          const forUi = sanitizeText(result.reasoning_content);
          if (forUi) applyChunk(run, { type: 'reasoning', delta: forUi });
        }
        const probe = typeof content === 'string' ? sanitizeText(content).trim() : '';
        if (probe) {
          applyChunk(run, { type: 'content', delta: probe });
          streamedFinal = true;
          break;
        }
        await finishWithStream();
        streamedFinal = true;
        break;
      }
      // 工具轮耗尽仍未终轮：对齐 llm.ts，再流式出正文
      if (!streamedFinal && !signal.aborted) {
        await finishWithStream();
      }
    }

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    run.status = 'completed';
    run.assistant.turnStatus = 'completed';
    settleSteps(run);
    freezeTiming(run);
    persistAssistant(run);
    emit(run, { type: 'status', status: 'completed', assistant: snapshotAssistant(run) });
  } catch (e) {
    const aborted =
      (e instanceof DOMException && e.name === 'AbortError') ||
      signal.aborted ||
      String(e?.name || '') === 'AbortError';
    if (aborted) {
      run.status = 'stopped';
      run.assistant.turnStatus = 'stopped';
      settleSteps(run);
      freezeTiming(run);
      persistAssistant(run);
      emit(run, { type: 'status', status: 'stopped', assistant: snapshotAssistant(run) });
    } else {
      run.status = 'error';
      run.assistant.turnStatus = 'error';
      settleSteps(run);
      freezeTiming(run);
      persistAssistant(run);
      emit(run, {
        type: 'status',
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
        assistant: snapshotAssistant(run),
      });
    }
  } finally {
    run.finishedAt = Date.now();
    // 保留一段时间供重连读历史事件
    setTimeout(() => {
      if (runs.get(run.sessionId) === run && run.status !== 'running') {
        runs.delete(run.sessionId);
      }
    }, 5 * 60_000);
  }
}

function settleSteps(run) {
  run.assistant.activitySteps = (run.assistant.activitySteps || []).map((s) =>
    s.status === 'running' ? { ...s, status: 'done' } : s,
  );
}

function applyChunk(run, chunk) {
  if (chunk.type === 'reasoning') {
    noteFirstToken(run);
    run.assistant.reasoning = (run.assistant.reasoning || '') + chunk.delta;
    const steps = [...(run.assistant.activitySteps || [])];
    const idx = steps.findIndex((s) => s.kind === 'thinking');
    const detail = String(run.assistant.reasoning)
      .split(/\n+/)
      .filter(Boolean)
      .pop()
      ?.replaceAll('**', '')
      .slice(0, 80);
    const step = {
      id: 'thinking',
      kind: 'thinking',
      title: '思考',
      detail: detail || undefined,
      status: 'running',
    };
    if (idx >= 0) steps[idx] = { ...steps[idx], ...step };
    else steps.unshift(step);
    run.assistant.activitySteps = steps;
    emit(run, { type: 'reasoning', delta: chunk.delta });
    if (run.seq % 8 === 0) persistAssistant(run);
    return;
  }
  if (chunk.type === 'content') {
    noteFirstToken(run);
    const steps = (run.assistant.activitySteps || []).map((s) =>
      s.kind === 'thinking' && s.status === 'running' ? { ...s, status: 'done' } : s,
    );
    run.assistant.activitySteps = steps;
    const prev = run.assistant.content || '';
    const next = sanitizeText(prev + chunk.delta);
    run.assistant.content = next;
    // 若闸门吃掉了 DSML，只把相对 prev 的安全增量推给 SSE（避免客户端拼出标签）
    if (next.startsWith(prev)) {
      const delta = next.slice(prev.length);
      if (delta) emit(run, { type: 'content', delta });
    } else if (next && next !== prev) {
      // 内容被整体回退清洗：发替换增量（客户端会整段 sanitize）
      emit(run, { type: 'content', delta: chunk.delta });
    }
    if (run.seq % 6 === 0) persistAssistant(run);
    return;
  }
  if (chunk.type === 'usage') {
    run.assistant.usage = chunk.usage;
    emit(run, { type: 'usage', usage: chunk.usage });
    return;
  }
  if (chunk.type === 'tool') {
    const steps = [...(run.assistant.activitySteps || [])];
    const stepId = `tool_${chunk.name}_${String(chunk.args || '').slice(0, 24)}`;
    const idx = steps.findIndex(
      (s) => s.id === stepId || (s.title === toolTitle(chunk.name) && s.status === 'running'),
    );
    let detail = '';
    try {
      const a = JSON.parse(chunk.args || '{}');
      detail = String(a.query || a.url || a.path || a.command || '').slice(0, 80);
    } catch {
      detail = '';
    }
    if (!run.timing) {
      run.timing = { startAt: run.startedAt || Date.now(), toolMs: 0, toolT0: new Map() };
    }
    if (chunk.status === 'running') {
      run.timing.toolT0.set(stepId, Date.now());
    } else {
      const t0 = run.timing.toolT0.get(stepId);
      run.timing.toolT0.delete(stepId);
      if (t0 != null) {
        run.timing.toolMs = (run.timing.toolMs || 0) + Math.max(0, Date.now() - t0);
        run.assistant.toolMs = run.timing.toolMs;
      }
    }
    const next = {
      id: stepId,
      kind: activityKind(chunk.name),
      title: toolTitle(chunk.name),
      detail: detail || undefined,
      status: chunk.status === 'running' ? 'running' : 'done',
    };
    if (idx >= 0) steps[idx] = { ...steps[idx], ...next };
    else steps.push(next);
    run.assistant.activitySteps = steps;
    emit(run, {
      type: 'tool',
      name: chunk.name,
      status: chunk.status,
      args: chunk.args,
      result: chunk.result,
    });
    persistAssistant(run);
  }
}

/**
 * @returns {import('vite').Plugin}
 */
function resolveServerOrigin(server, req) {
  const fromAddr = loopbackOriginFromAddress(server.httpServer?.address?.());
  if (fromAddr) return fromAddr;
  return originFromReq(req);
}

export function tbSessionRunsPlugin() {
  return {
    name: 'tb-session-runs',
    configureServer(server) {
      // 供 loopback 使用：优先从 listen 地址推断
      let listenOrigin = '';
      const captureListen = () => {
        listenOrigin = loopbackOriginFromAddress(server.httpServer?.address()) || '';
      };
      if (server.httpServer?.listening) captureListen();
      else server.httpServer?.once('listening', captureListen);

      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(PREFIX)) return next();
        // 数据根惰性读取：切换数据空间后无需重启即可生效
        const root = getDataRoot();

        try {
          if (url === PREFIX && req.method === 'GET') {
            const list = [...runs.values()]
              .filter((r) => r.status === 'running' || r.status === 'waiting_user')
              .map((r) => ({
                sessionId: r.sessionId,
                status: r.status,
                startedAt: r.startedAt,
                seq: r.seq,
              }));
            return sendJson(res, 200, { ok: true, runs: list });
          }

          if (url === PREFIX && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const sessionId = String(body.sessionId || '').trim();
            if (!sessionId) return sendJson(res, 400, { error: 'sessionId is required' });
            if (runs.has(sessionId) && runs.get(sessionId).status === 'running') {
              return sendJson(res, 409, { error: 'session already running', sessionId });
            }
            const settings = body.settings || {};
            if (!settings.baseURL || !settings.apiKey || !settings.model) {
              return sendJson(res, 400, { error: 'settings.baseURL/apiKey/model required' });
            }
            const messages = Array.isArray(body.messages) ? body.messages : [];
            if (!messages.length) return sendJson(res, 400, { error: 'messages required' });

            const abort = new AbortController();
            const origin = listenOrigin || resolveServerOrigin(server, req);
            /** @type {any} */
            const run = {
              sessionId,
              root,
              origin,
              settings,
              messages,
              tools: Array.isArray(body.tools) ? body.tools : [],
              thinking: body.thinking,
              workspace: body.workspace || '',
              access: body.access || 'default',
              maxToolRounds: Number(body.maxToolRounds) || DEFAULT_TOOL_ROUNDS,
              status: 'running',
              startedAt: Date.now(),
              finishedAt: null,
              seq: 0,
              events: [],
              clients: new Set(),
              abort,
              signal: abort.signal,
              assistant: {
                content: '',
                reasoning: '',
                activitySteps: [],
                turnStatus: 'running',
                toolMs: 0,
              },
              timing: {
                startAt: Date.now(),
                firstTokenAt: null,
                toolMs: 0,
                toolT0: new Map(),
              },
            };
            runs.set(sessionId, run);
            void executeRun(run);
            return sendJson(res, 200, { ok: true, sessionId, status: 'running' });
          }

          const stopMatch = url.match(/^\/__tb_sessions\/runs\/([^/]+)\/stop$/);
          if (stopMatch && req.method === 'POST') {
            const sessionId = decodeURIComponent(stopMatch[1]);
            const run = runs.get(sessionId);
            if (!run) return sendJson(res, 404, { error: 'run not found' });
            run.abort.abort();
            return sendJson(res, 200, { ok: true, status: 'stopping' });
          }

          const eventsMatch = url.match(/^\/__tb_sessions\/runs\/([^/]+)\/events$/);
          if (eventsMatch && req.method === 'GET') {
            const sessionId = decodeURIComponent(eventsMatch[1]);
            const run = runs.get(sessionId);
            if (!run) return sendJson(res, 404, { error: 'run not found' });
            const u = new URL(req.url || '', 'http://local');
            const after = Number(u.searchParams.get('after') || 0);

            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();

            const client = {
              write: (s) => res.write(s),
            };
            run.clients.add(client);
            // replay
            for (const ev of run.events) {
              if (ev.seq > after) res.write(`data: ${JSON.stringify(ev)}\n\n`);
            }
            // 若已结束，补发终态
            if (run.status !== 'running' && run.status !== 'waiting_user') {
              res.write(
                `data: ${JSON.stringify({
                  type: 'status',
                  status: run.status,
                  seq: run.seq + 1,
                  assistant: snapshotAssistant(run),
                })}\n\n`,
              );
            }
            req.on('close', () => {
              run.clients.delete(client);
            });
            return;
          }

          const snapMatch = url.match(/^\/__tb_sessions\/runs\/([^/]+)$/);
          if (snapMatch && req.method === 'GET') {
            const sessionId = decodeURIComponent(snapMatch[1]);
            const run = runs.get(sessionId);
            if (!run) return sendJson(res, 404, { error: 'run not found' });
            return sendJson(res, 200, {
              ok: true,
              sessionId,
              status: run.status,
              seq: run.seq,
              assistant: snapshotAssistant(run),
            });
          }

          return sendJson(res, 404, { error: 'not found' });
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}

export { runs as __sessionRunsForTest };

/**
 * 是否有会话仍在执行。数据空间切换前必须为空，否则在途请求会跨空间读到错误文件。
 * @returns {boolean}
 */
export function hasRunningSessions() {
  for (const r of runs.values()) {
    if (r.status === 'running' || r.status === 'waiting_user') return true;
  }
  return false;
}
