/**
 * MCP 真客户端（stdio / Streamable HTTP）：读空间 mcp.json，暴露 tools/list · tools/call。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getDataRoot } from './space-context.mjs';
import { LOCAL_REL } from './space-layout.mjs';

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeMcpSegment(raw) {
  return (
    String(raw || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'x'
  );
}

/**
 * @param {string} server
 * @param {string} tool
 */
export function mcpToolName(server, tool) {
  return `mcp__${sanitizeMcpSegment(server)}__${sanitizeMcpSegment(tool)}`;
}

/**
 * @param {string} name
 * @returns {{ server: string, tool: string } | null}
 */
export function parseMcpToolName(name) {
  const m = String(name || '').match(/^mcp__([a-zA-Z0-9_-]+)__(.+)$/);
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}

/**
 * @param {string} root
 */
export function mcpConfigPath(root) {
  return path.join(root, LOCAL_REL, 'mcp.json');
}

/**
 * @param {unknown} raw
 * @returns {{ name: string, transport: string, command?: string, args?: string[], env?: Record<string,string>, url?: string, headers?: Record<string,string> }[]}
 */
export function normalizeMcpServers(raw) {
  const list = Array.isArray(raw?.servers) ? raw.servers : Array.isArray(raw) ? raw : [];
  /** @type {typeof list} */
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = sanitizeMcpSegment(item.name);
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    const transport = String(item.transport || (item.url ? 'http' : 'stdio'))
      .trim()
      .toLowerCase();
    if (transport === 'stdio') {
      const command = String(item.command || '').trim();
      if (!command) continue;
      seen.add(name);
      out.push({
        name,
        transport: 'stdio',
        command,
        args: Array.isArray(item.args) ? item.args.map((a) => String(a)) : [],
        env:
          item.env && typeof item.env === 'object'
            ? Object.fromEntries(Object.entries(item.env).filter(([, v]) => typeof v === 'string'))
            : undefined,
      });
    } else if (transport === 'http' || transport === 'streamable-http' || transport === 'sse') {
      const url = String(item.url || '').trim();
      if (!url) continue;
      seen.add(name);
      out.push({
        name,
        transport: 'http',
        url,
        headers:
          item.headers && typeof item.headers === 'object'
            ? Object.fromEntries(
                Object.entries(item.headers).filter(([, v]) => typeof v === 'string'),
              )
            : undefined,
      });
    }
  }
  return out;
}

export function loadMcpConfig(root = getDataRoot()) {
  const p = mcpConfigPath(root);
  if (!fs.existsSync(p)) return { path: p, servers: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { path: p, servers: normalizeMcpServers(raw) };
  } catch (e) {
    return {
      path: p,
      servers: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

const SENSITIVE_HEADER_RE = /^(authorization|x-api-key|api-key|token)$/i;
/** 列表脱敏占位前缀；客户端回写时以此识别「未改密钥」 */
export const MCP_HEADER_MASK_PREFIX = '••••';

/**
 * @param {string} key
 */
export function isSensitiveMcpHeader(key) {
  return SENSITIVE_HEADER_RE.test(String(key || ''));
}

/**
 * @param {string} value
 */
export function maskSecretValue(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 4) return `${MCP_HEADER_MASK_PREFIX}${v}`;
  return `${MCP_HEADER_MASK_PREFIX}${v.slice(-4)}`;
}

/**
 * @param {Record<string, string> | undefined} headers
 * @returns {Record<string, string> | undefined}
 */
export function redactMcpHeaders(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') continue;
    out[k] = isSensitiveMcpHeader(k) ? maskSecretValue(v) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 合并 headers：新值若为空或仍是脱敏串，则保留旧值。
 * @param {Record<string, string> | undefined} prev
 * @param {Record<string, string> | undefined} next
 */
export function mergeMcpHeaders(prev, next) {
  if (!next || typeof next !== 'object') return prev;
  /** @type {Record<string, string>} */
  const out = { ...(prev && typeof prev === 'object' ? prev : {}) };
  for (const [k, v] of Object.entries(next)) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) {
      delete out[k];
      continue;
    }
    if (isSensitiveMcpHeader(k) && trimmed.startsWith(MCP_HEADER_MASK_PREFIX)) {
      if (prev && typeof prev[k] === 'string' && prev[k]) out[k] = prev[k];
      continue;
    }
    out[k] = trimmed;
  }
  return Object.keys(out).length ? out : undefined;
}

const SENSITIVE_ENV_RE = /(api[_-]?key|token|secret|password|authorization)/i;

/**
 * @param {string} key
 */
export function isSensitiveMcpEnvKey(key) {
  return SENSITIVE_ENV_RE.test(String(key || ''));
}

/**
 * @param {Record<string, string> | undefined} env
 * @returns {Record<string, string> | undefined}
 */
export function redactMcpEnv(env) {
  if (!env || typeof env !== 'object') return undefined;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    out[k] = isSensitiveMcpEnvKey(k) ? maskSecretValue(v) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * @param {Record<string, string> | undefined} prev
 * @param {Record<string, string> | undefined} next
 */
export function mergeMcpEnv(prev, next) {
  if (!next || typeof next !== 'object') return prev;
  /** @type {Record<string, string>} */
  const out = { ...(prev && typeof prev === 'object' ? prev : {}) };
  for (const [k, v] of Object.entries(next)) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) {
      delete out[k];
      continue;
    }
    if (isSensitiveMcpEnvKey(k) && trimmed.startsWith(MCP_HEADER_MASK_PREFIX)) {
      if (prev && typeof prev[k] === 'string' && prev[k]) out[k] = prev[k];
      continue;
    }
    out[k] = trimmed;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 把 Claude Desktop / Trae 的 mcpServers、灵光 servers[]、单条对象统一成内部列表。
 * @param {unknown} raw
 */
export function coerceMcpServersInput(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    const list = [];
    for (const [name, conf] of Object.entries(
      /** @type {Record<string, unknown>} */ (obj.mcpServers),
    )) {
      if (!conf || typeof conf !== 'object') continue;
      list.push({ name, .../** @type {object} */ (conf) });
    }
    return normalizeMcpServers({ servers: list });
  }
  if (Array.isArray(obj.servers) || Array.isArray(raw)) {
    return normalizeMcpServers(raw);
  }
  if ('command' in obj || 'url' in obj || 'transport' in obj) {
    return normalizeMcpServers({
      servers: [{ name: obj.name || 'mcp', ...obj }],
    });
  }
  return [];
}

/**
 * @param {string} root
 * @param {ReturnType<typeof normalizeMcpServers>} servers
 */
export function saveMcpServers(root, servers) {
  const p = mcpConfigPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const normalized = normalizeMcpServers({ servers });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ servers: normalized }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
  return { path: p, servers: normalized };
}

/**
 * @param {string} root
 * @param {object} raw
 * @param {{ previousName?: string }} [opts]
 */
export function upsertMcpServer(root, raw, opts = {}) {
  const { servers, path: cfgPath, error } = loadMcpConfig(root);
  if (error) throw new Error(error);
  const previousName = opts.previousName ? sanitizeMcpSegment(opts.previousName) : '';
  const existing =
    (previousName && servers.find((s) => s.name === previousName)) ||
    (raw?.name ? servers.find((s) => s.name === sanitizeMcpSegment(raw.name)) : undefined);

  const transport = String(raw?.transport || (raw?.url ? 'http' : 'stdio'))
    .trim()
    .toLowerCase();
  const name = sanitizeMcpSegment(raw?.name || existing?.name || '');
  if (!NAME_RE.test(name)) throw new Error('invalid server name');

  /** @type {object} */
  let next;
  if (transport === 'stdio') {
    const command = String(raw?.command || existing?.command || '').trim();
    if (!command) throw new Error('command is required for stdio');
    next = {
      name,
      transport: 'stdio',
      command,
      args: Array.isArray(raw?.args)
        ? raw.args.map((a) => String(a))
        : Array.isArray(existing?.args)
          ? existing.args
          : [],
      env:
        raw?.env !== undefined
          ? mergeMcpEnv(
              existing?.env,
              raw.env && typeof raw.env === 'object'
                ? Object.fromEntries(
                    Object.entries(raw.env).filter(([, v]) => typeof v === 'string'),
                  )
                : undefined,
            )
          : existing?.env,
    };
  } else if (transport === 'http' || transport === 'streamable-http' || transport === 'sse') {
    const url = String(raw?.url || existing?.url || '').trim();
    if (!url) throw new Error('url is required for http');
    next = {
      name,
      transport: 'http',
      url,
      headers: mergeMcpHeaders(existing?.headers, raw?.headers),
    };
  } else {
    throw new Error(`unsupported transport: ${transport}`);
  }

  const replaceNames = new Set([previousName, existing?.name].filter(Boolean));
  if (servers.some((s) => s.name === name && !replaceNames.has(s.name))) {
    throw new Error(`server already exists: ${name}`);
  }
  const list = servers.filter((s) => !replaceNames.has(s.name));
  list.push(next);
  return saveMcpServers(root, list);
}

/**
 * @param {string} root
 * @param {string} name
 */
export function removeMcpServer(root, name) {
  const target = sanitizeMcpSegment(name);
  const { servers, error } = loadMcpConfig(root);
  if (error) throw new Error(error);
  if (!servers.some((s) => s.name === target)) throw new Error(`server not found: ${target}`);
  return saveMcpServers(
    root,
    servers.filter((s) => s.name !== target),
  );
}

/**
 * 供 UI 列表：配置脱敏 + 连接状态字段由调用方补。
 * @param {string} [root]
 */
export function listMcpServersForUi(root = getDataRoot()) {
  const cfg = loadMcpConfig(root);
  return {
    path: cfg.path,
    error: cfg.error,
    servers: cfg.servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args,
      env: redactMcpEnv(s.env),
      url: s.url,
      headers: redactMcpHeaders(s.headers),
      hasSecrets: Boolean(
        (s.headers &&
          Object.keys(s.headers).some((k) => isSensitiveMcpHeader(k) && s.headers[k])) ||
        (s.env && Object.keys(s.env).some((k) => isSensitiveMcpEnvKey(k) && s.env[k])),
      ),
    })),
  };
}

/** @type {Map<string, { client: import('@modelcontextprotocol/sdk/client/index.js').Client, conf: object, root: string }>} */
const pool = new Map();
/** @type {Map<string, { server: string, remoteName: string }>} */
const toolIndex = new Map();
let poolRoot = '';

function poolKey(root, name) {
  return `${root}::${name}`;
}

export async function closeAllMcpClients() {
  for (const [k, entry] of pool) {
    try {
      await entry.client.close();
    } catch {
      // ignore
    }
    pool.delete(k);
  }
  toolIndex.clear();
}

/**
 * @param {object} conf
 * @param {string} root
 */
async function connectServer(conf, root) {
  const client = new Client({ name: 'lantern-harness', version: '0.1' });
  if (conf.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: conf.command,
      args: conf.args || [],
      env: conf.env,
      stderr: 'pipe',
      cwd: root,
    });
    await client.connect(transport);
  } else {
    const headers = conf.headers || {};
    const transport = new StreamableHTTPClientTransport(new URL(conf.url), {
      requestInit: { headers },
    });
    await client.connect(transport);
  }
  return client;
}

/**
 * @param {string} [root]
 * @param {{ forceNames?: string[] }} [opts] 指定名称强制断开重连（配置未变也重连）
 */
export async function ensureMcpClients(root = getDataRoot(), opts = {}) {
  if (poolRoot && poolRoot !== root) {
    await closeAllMcpClients();
  }
  poolRoot = root;
  const force = new Set((opts.forceNames || []).map((n) => sanitizeMcpSegment(n)));
  const { servers, error } = loadMcpConfig(root);
  const wanted = new Set(servers.map((s) => s.name));
  for (const key of [...pool.keys()]) {
    const name = key.slice(root.length + 2);
    if (!wanted.has(name)) {
      try {
        await pool.get(key)?.client.close();
      } catch {
        // ignore
      }
      pool.delete(key);
    }
  }
  const errors = [];
  if (error) errors.push(error);
  for (const conf of servers) {
    const key = poolKey(root, conf.name);
    const prev = pool.get(key);
    const sameConf = prev && JSON.stringify(prev.conf) === JSON.stringify(conf);
    if (sameConf && !force.has(conf.name)) continue;
    if (prev) {
      try {
        await prev.client.close();
      } catch {
        // ignore
      }
      pool.delete(key);
    }
    try {
      const client = await connectServer(conf, root);
      pool.set(key, { client, conf, root });
    } catch (e) {
      errors.push(`${conf.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { servers, connected: [...pool.keys()].map((k) => k.slice(root.length + 2)), errors };
}

/**
 * 强制重连一台（或全部）MCP 服务器。
 * @param {string} [root]
 * @param {string} [name] 缺省则强制重连配置里全部
 */
export async function reconnectMcpServer(root = getDataRoot(), name) {
  const target = name ? sanitizeMcpSegment(name) : '';
  if (target) {
    const { servers } = loadMcpConfig(root);
    if (!servers.some((s) => s.name === target)) {
      throw new Error(`server not found: ${target}`);
    }
    return ensureMcpClients(root, { forceNames: [target] });
  }
  const { servers } = loadMcpConfig(root);
  return ensureMcpClients(root, { forceNames: servers.map((s) => s.name) });
}

/**
 * @param {string} [root]
 */
export async function listMcpTools(root = getDataRoot()) {
  await ensureMcpClients(root);
  /** @type {Array<{ name: string, description?: string, inputSchema?: object, server: string, remoteName: string }>} */
  const tools = [];
  const errors = [];
  for (const key of [...toolIndex.keys()]) {
    if (key.startsWith('mcp__')) toolIndex.delete(key);
  }
  for (const [key, entry] of pool) {
    if (entry.root !== root) continue;
    try {
      const listed = await entry.client.listTools();
      for (const t of listed.tools || []) {
        const remoteName = String(t.name || '').trim();
        if (!remoteName) continue;
        const name = mcpToolName(entry.conf.name, remoteName);
        toolIndex.set(name, { server: entry.conf.name, remoteName });
        tools.push({
          name,
          description: t.description || `MCP ${entry.conf.name}/${remoteName}`,
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          server: entry.conf.name,
          remoteName,
        });
      }
    } catch (e) {
      errors.push(`${entry.conf.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    ok: true,
    tools,
    errors,
    connected: [...pool.keys()]
      .filter((k) => k.startsWith(`${root}::`))
      .map((k) => k.slice(root.length + 2)),
  };
}

/**
 * @param {string} toolName mcp__server__tool
 * @param {unknown} args
 * @param {string} [root]
 */
export async function callMcpTool(toolName, args, root = getDataRoot()) {
  const name = String(toolName || '');
  await ensureMcpClients(root);
  if (!toolIndex.has(name)) {
    await listMcpTools(root);
  }
  let resolved = toolIndex.get(name);
  if (!resolved) {
    const parsed = parseMcpToolName(name);
    if (!parsed) return { ok: false, error: 'not an mcp tool name' };
    resolved = { server: parsed.server, remoteName: parsed.tool };
  }
  const key = poolKey(root, resolved.server);
  const entry = pool.get(key);
  if (!entry) return { ok: false, error: `mcp server not connected: ${resolved.server}` };
  try {
    const result = await entry.client.callTool({
      name: resolved.remoteName,
      arguments: args && typeof args === 'object' ? args : {},
    });
    const texts = [];
    const content = Array.isArray(result?.content) ? result.content : [];
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
      else if (c) texts.push(JSON.stringify(c));
    }
    const text = texts.join('\n') || JSON.stringify(result ?? {}, null, 2);
    return {
      ok: result?.isError ? false : true,
      text: text.slice(0, 80_000),
      isError: Boolean(result?.isError),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 测试用 */
export function resetMcpPoolForTests() {
  pool.clear();
  toolIndex.clear();
  poolRoot = '';
}
