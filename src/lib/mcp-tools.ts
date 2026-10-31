/**
 * MCP 工具客户端面：拉取 `/__tb_mcp/tools`，调用 `/__tb_mcp/call`；
 * 管理面读写 `/__tb_mcp/servers`（当前空间 mcp.json）。
 */
import type { ToolDef } from './llm';

const API = '/__tb_mcp';

export const MCP_SYSTEM_HINT =
  '你可以使用 MCP 工具（名称形如 mcp__服务器__工具名）。它们来自当前数据空间 `.lantern/local/mcp.json` 配置的外部 MCP 服务。';

/** 腾讯文档官方远程 MCP（一键模板用） */
export const TENCENT_DOCS_MCP = {
  name: 'tencent-docs',
  transport: 'http' as const,
  url: 'https://docs.qq.com/openapi/mcp',
};

export type McpRemoteTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  server: string;
  remoteName: string;
};

export type McpServerTransport = 'http' | 'stdio';

export type McpServerConfig = {
  name: string;
  transport: McpServerTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  hasSecrets?: boolean;
  connected?: boolean;
  toolCount?: number;
};

/** 表单字段 → Trae / Claude Desktop 风格 mcpServers JSON（编辑器用） */
export function serverToMcpServersJson(server: {
  name: string;
  transport: McpServerTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}): string {
  const name = server.name.trim() || 'mcp';
  const body =
    server.transport === 'stdio'
      ? {
          command: server.command || '',
          args: server.args || [],
          ...(server.env && Object.keys(server.env).length ? { env: server.env } : { env: {} }),
        }
      : {
          url: server.url || '',
          ...(server.headers && Object.keys(server.headers).length
            ? { headers: server.headers }
            : {}),
        };
  return `${JSON.stringify({ mcpServers: { [name]: body } }, null, 2)}\n`;
}

/**
 * 解析粘贴的 JSON：支持 mcpServers / servers[] / 单条对象。
 * 返回规范化后的服务器列表（可能多条）。
 */
export function parseMcpServersJson(text: string):
  | {
      ok: true;
      servers: Array<{
        name: string;
        transport: McpServerTransport;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      }>;
    }
  | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 无法解析' };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'JSON 必须是对象' };

  const obj = raw as Record<string, unknown>;
  /** @type {Array<Record<string, unknown>>} */
  let items: Array<Record<string, unknown>> = [];

  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    for (const [name, conf] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
      if (!conf || typeof conf !== 'object') continue;
      items.push({ name, ...(conf as object) });
    }
  } else if (Array.isArray(obj.servers)) {
    items = obj.servers.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>;
  } else if (Array.isArray(raw)) {
    items = raw.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>;
  } else if ('command' in obj || 'url' in obj || 'transport' in obj) {
    items = [obj];
  } else {
    return { ok: false, error: '未识别的格式，请使用 mcpServers 或 servers[]' };
  }

  const servers = [];
  for (const item of items) {
    const name = String(item.name || '').trim();
    if (!name) return { ok: false, error: '缺少 name' };
    const transport = String(item.transport || (item.url ? 'http' : 'stdio'))
      .trim()
      .toLowerCase();
    if (transport === 'stdio' || (!item.url && item.command)) {
      const command = String(item.command || '').trim();
      if (!command) return { ok: false, error: `「${name}」缺少 command` };
      servers.push({
        name,
        transport: 'stdio' as const,
        command,
        args: Array.isArray(item.args) ? item.args.map((a) => String(a)) : [],
        env:
          item.env && typeof item.env === 'object'
            ? Object.fromEntries(
                Object.entries(item.env as Record<string, unknown>).filter(
                  ([, v]) => typeof v === 'string',
                ) as [string, string][],
              )
            : undefined,
      });
    } else if (transport === 'http' || transport === 'streamable-http' || transport === 'sse') {
      const url = String(item.url || '').trim();
      if (!url) return { ok: false, error: `「${name}」缺少 url` };
      servers.push({
        name,
        transport: 'http' as const,
        url,
        headers:
          item.headers && typeof item.headers === 'object'
            ? Object.fromEntries(
                Object.entries(item.headers as Record<string, unknown>).filter(
                  ([, v]) => typeof v === 'string',
                ) as [string, string][],
              )
            : undefined,
      });
    } else {
      return { ok: false, error: `「${name}」不支持的 transport` };
    }
  }
  if (!servers.length) return { ok: false, error: '没有有效的服务器配置' };
  return { ok: true, servers };
}

export type McpServersResponse = {
  ok: boolean;
  path?: string;
  servers: McpServerConfig[];
  connected?: string[];
  errors?: string[];
  error?: string;
};

export async function fetchMcpHealth(): Promise<{
  ok: boolean;
  serversConfigured?: number;
} | null> {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as { ok: boolean; serversConfigured?: number };
  } catch {
    return null;
  }
}

export async function fetchMcpServers(): Promise<McpServersResponse> {
  try {
    const res = await fetch(`${API}/servers`, { signal: AbortSignal.timeout(20_000) });
    const data = (await res.json()) as McpServersResponse;
    if (!res.ok) {
      return {
        ok: false,
        servers: [],
        error: data.error || `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      path: data.path,
      servers: Array.isArray(data.servers) ? data.servers : [],
      connected: data.connected,
      errors: data.errors,
    };
  } catch (e) {
    return {
      ok: false,
      servers: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function upsertMcpServerConfig(
  server: {
    name: string;
    transport: McpServerTransport;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  },
  previousName?: string,
): Promise<McpServersResponse> {
  try {
    const res = await fetch(`${API}/servers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, previousName }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json()) as McpServersResponse;
    if (!res.ok) {
      return {
        ok: false,
        servers: [],
        error: data.error || `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      path: data.path,
      servers: Array.isArray(data.servers) ? data.servers : [],
    };
  } catch (e) {
    return {
      ok: false,
      servers: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function deleteMcpServerConfig(name: string): Promise<McpServersResponse> {
  try {
    const res = await fetch(`${API}/servers`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json()) as McpServersResponse;
    if (!res.ok) {
      return {
        ok: false,
        servers: [],
        error: data.error || `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      path: data.path,
      servers: Array.isArray(data.servers) ? data.servers : [],
    };
  } catch (e) {
    return {
      ok: false,
      servers: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function reloadMcpClients(name?: string): Promise<{
  ok: boolean;
  connected?: string[];
  errors?: string[];
  error?: string;
}> {
  try {
    const res = await fetch(`${API}/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(name ? { name } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      connected?: string[];
      errors?: string[];
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, connected: data.connected, errors: data.errors };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchMcpTools(): Promise<McpRemoteTool[]> {
  try {
    const res = await fetch(`${API}/tools`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { tools?: McpRemoteTool[] };
    return Array.isArray(data.tools) ? data.tools : [];
  } catch {
    return [];
  }
}

export function mcpToolsToDefs(tools: McpRemoteTool[]): ToolDef[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters:
        t.inputSchema && typeof t.inputSchema === 'object'
          ? t.inputSchema
          : { type: 'object', properties: {} },
    },
  }));
}

export async function runMcpTool(name: string, argsJson: string): Promise<string> {
  let args: unknown = {};
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }
  try {
    const res = await fetch(`${API}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json()) as { ok?: boolean; text?: string; error?: string };
    if (data.error && !data.text) return JSON.stringify({ error: data.error });
    return data.text ?? JSON.stringify(data, null, 2);
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}
