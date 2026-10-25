/**
 * MCP 工具客户端面：拉取 `/__tb_mcp/tools`，调用 `/__tb_mcp/call`。
 */
import type { ToolDef } from './llm';

const API = '/__tb_mcp';

export const MCP_SYSTEM_HINT =
  '你可以使用 MCP 工具（名称形如 mcp__服务器__工具名）。它们来自当前数据空间 `.lantern/local/mcp.json` 配置的外部 MCP 服务。';

export type McpRemoteTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  server: string;
  remoteName: string;
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
