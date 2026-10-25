/**
 * headless-runner：无浏览器补全；可选本机工具循环（fs 只读子集）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { publicSpacePath } from '../builtin/session/space-context.mjs';
import {
  spaceConfigFile,
  spaceLocalFile,
  META_DIR,
  META_DIR_LEGACY,
} from '../builtin/session/space-layout.mjs';
import { prepareSpacesRoot } from './server.mjs';
import { getGlobalModelsPath } from './user-config.mjs';
import { readSpaceAccess, resolveAgentPolicy } from './agent-policy.mjs';

function readJson(fp, fallback) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadDotEnv(root) {
  const out = {};
  try {
    const fp = path.join(root, '.env');
    if (!fs.existsSync(fp)) return out;
    for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * @param {string} dataRoot 池根（公共空间位于其下）
 * @returns {{ baseURL: string, apiKey: string, model: string, dataRoot: string, access: string }}
 */
export function loadHeadlessSettings(dataRoot) {
  const root = publicSpacePath(prepareSpacesRoot(dataRoot));
  const defaults = readJson(spaceConfigFile(root, 'app.defaults.json'), {});
  const local = readJson(spaceLocalFile(root, 'app.config.json'), {});
  const global = readJson(getGlobalModelsPath(), {});
  const model = { ...(defaults.model || {}), ...(local.model || {}), ...(global || {}) };
  const providers = Array.isArray(global?.providers)
    ? global.providers
    : Array.isArray(local.model?.providers)
      ? local.model.providers
      : Array.isArray(defaults.model?.providers)
        ? defaults.model.providers
        : [];
  const activeId = global?.activeId || local.model?.activeId || defaults.model?.activeId || '';
  const active = providers.find((p) => p && p.id === activeId) || providers[0] || null;
  const env = loadDotEnv(root);
  const apiKey = String(
    env.TW_API_KEY || process.env.TW_API_KEY || active?.apiKey || model.apiKey || '',
  ).trim();
  const baseURL = String(active?.baseURL || model.baseURL || '').trim();
  const modelId = String(active?.model || model.model || '').trim();
  if (!baseURL || !modelId) {
    throw new Error(
      '未配置模型：请在设置页填写提供商，或写入 ~/.config/lantern-harness/models.json',
    );
  }
  if (!apiKey) {
    throw new Error('未配置 API Key：请设置 TW_API_KEY 或写入提供商 apiKey');
  }
  const access = resolveAgentPolicy({
    configAccess: readSpaceAccess(local, defaults),
    defaultAccess: 'readonly',
    defaultToolProfile: 'none',
  }).access;
  return { baseURL, apiKey, model: modelId, dataRoot: root, access };
}

const HEADLESS_FS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fs_list',
      description: 'List files in a directory under the workspace (relative path).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory (default ".")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_read',
      description: 'Read a UTF-8 text file under the workspace (max 200KB).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_glob',
      description: 'Find files by glob-like suffix filter under workspace (e.g. **/*.ts).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
];

function resolveUnderRoot(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(rel || '.').replace(/^\//, ''));
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return abs;
}

function walkFiles(dir, acc, limit) {
  if (acc.length >= limit) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (acc.length >= limit) return;
    if (
      ent.name === 'node_modules' ||
      ent.name === '.git' ||
      ent.name === META_DIR ||
      ent.name === META_DIR_LEGACY ||
      ent.name === '.local'
    ) {
      continue;
    }
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(abs, acc, limit);
    else if (ent.isFile()) acc.push(abs);
  }
}

/**
 * @param {string} workspaceRoot
 * @param {string} name
 * @param {string} argsJson
 */
export async function runHeadlessTool(workspaceRoot, name, argsJson) {
  let args = {};
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    return JSON.stringify({ ok: false, error: 'invalid JSON arguments' });
  }
  try {
    if (name === 'fs_list') {
      const abs = resolveUnderRoot(workspaceRoot, args.path || '.');
      const names = fs.readdirSync(abs).slice(0, 200);
      return JSON.stringify({ ok: true, path: args.path || '.', entries: names });
    }
    if (name === 'fs_read') {
      const rel = String(args.path ?? '').trim();
      if (!rel) return JSON.stringify({ ok: false, error: 'path is required' });
      const abs = resolveUnderRoot(workspaceRoot, rel);
      const st = fs.statSync(abs);
      if (!st.isFile()) return JSON.stringify({ ok: false, error: 'not a file' });
      if (st.size > 200 * 1024)
        return JSON.stringify({ ok: false, error: 'file too large (>200KB)' });
      const text = fs.readFileSync(abs, 'utf8');
      return JSON.stringify({ ok: true, path: rel, content: text });
    }
    if (name === 'fs_glob') {
      const pattern = String(args.pattern ?? '').trim();
      if (!pattern) return JSON.stringify({ ok: false, error: 'pattern is required' });
      const suffix = pattern.includes('*')
        ? pattern.replace(/^\*\*\//, '').replace(/^\*/, '')
        : pattern;
      const files = [];
      walkFiles(workspaceRoot, files, 400);
      const hits = files
        .filter((f) =>
          suffix.startsWith('.') ? f.endsWith(suffix) : f.includes(suffix.replace(/^\*\./, '.')),
        )
        .slice(0, 80)
        .map((f) => path.relative(workspaceRoot, f));
      return JSON.stringify({ ok: true, pattern, count: hits.length, files: hits });
    }
    return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

async function completeOnce(settings, messages, tools) {
  const url = `${settings.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: settings.model,
    messages,
    stream: false,
    temperature: 0.3,
    thinking: { type: 'disabled' },
  };
  if (tools?.length) body.tools = tools;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err =
      typeof data === 'object' && data && 'error' in data
        ? JSON.stringify(data.error)
        : `HTTP ${res.status}`;
    throw new Error(err);
  }
  return data?.choices?.[0]?.message ?? {};
}

/**
 * @param {{ baseURL: string, apiKey: string, model: string, dataRoot?: string, access?: string }} settings
 * @param {string} prompt
 * @param {{
 *   system?: string,
 *   tools?: boolean,
 *   toolProfile?: string,
 *   access?: string,
 *   workspace?: string,
 *   maxToolRounds?: number,
 *   onTool?: (ev: { name: string, args: string, result?: string, status: string }) => void,
 *   messages?: Array<{ role: string, content?: string, tool_calls?: unknown, tool_call_id?: string }>,
 * }} [opts]
 */
export async function headlessAsk(settings, prompt, opts = {}) {
  const text = String(prompt ?? '').trim();
  if (!text && !opts.messages?.length) throw new Error('prompt 不能为空');

  const policy = resolveAgentPolicy({
    configAccess: settings.access,
    cliAccess: opts.access,
    cliToolProfile:
      opts.toolProfile !== undefined
        ? opts.toolProfile
        : opts.tools === true
          ? 'fs-readonly'
          : opts.tools === false
            ? 'none'
            : undefined,
    workspace: opts.workspace || settings.dataRoot || process.cwd(),
    defaultAccess: 'readonly',
    defaultToolProfile: 'none',
  });

  const useTools = policy.toolProfile !== 'none';
  if (!useTools) {
    const messages = [];
    if (opts.system) messages.push({ role: 'system', content: String(opts.system) });
    if (opts.messages?.length) {
      messages.push(...opts.messages);
    } else {
      messages.push({ role: 'user', content: text });
    }
    const msg = await completeOnce(settings, messages, null);
    const content = msg?.content;
    return typeof content === 'string' ? content : content == null ? '' : String(content);
  }

  const workspace = path.resolve(policy.workspace || settings.dataRoot || process.cwd());
  const tools = HEADLESS_FS_TOOLS;
  const system =
    (opts.system ? `${opts.system}\n\n` : '') +
    `你在 headless 模式，工作区：${workspace}（access=${policy.access}）。可用工具 fs_list / fs_read / fs_glob（只读）。完成后直接给结论。`;
  /** @type {Array<Record<string, unknown>>} */
  const messages = [{ role: 'system', content: system }];
  if (opts.messages?.length) {
    messages.push(...opts.messages.filter((m) => m.role !== 'system'));
  }
  if (text) messages.push({ role: 'user', content: text });

  const maxRounds = Math.min(Math.max(Number(opts.maxToolRounds) || 5, 1), 12);
  for (let round = 0; round < maxRounds; round++) {
    const msg = await completeOnce(settings, messages, tools);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length) {
      messages.push({
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : '',
        tool_calls: calls,
      });
      for (const call of calls) {
        const name = String(call?.function?.name || '');
        const args = String(call?.function?.arguments ?? '{}');
        opts.onTool?.({ name, args, status: 'running' });
        const out = await runHeadlessTool(workspace, name, args);
        opts.onTool?.({ name, args, result: out, status: 'done' });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: out.length > 12_000 ? `${out.slice(0, 12_000)}…` : out,
        });
      }
      continue;
    }
    const content = msg?.content;
    return typeof content === 'string' ? content : content == null ? '' : String(content);
  }
  return '（工具轮次耗尽，未得到最终回答）';
}

export { HEADLESS_FS_TOOLS };
