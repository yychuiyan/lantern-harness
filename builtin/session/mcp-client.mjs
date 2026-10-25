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
 */
export async function ensureMcpClients(root = getDataRoot()) {
  if (poolRoot && poolRoot !== root) {
    await closeAllMcpClients();
  }
  poolRoot = root;
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
    if (pool.has(key)) continue;
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
