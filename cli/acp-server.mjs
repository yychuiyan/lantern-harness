/**
 * acp 子集：stdio JSON-RPC，供外部编排驱动无 UI Agent（非完整 Harness ACP）。
 *
 * 方法：
 * - initialize
 * - ping
 * - session/new
 * - session/prompt
 * - session/cancel
 * - shutdown
 *
 * 通知（tools 开启时）：
 * - session/update  { sessionId, toolCall: { name, status, args?, result? } }
 */
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseToolProfile } from './agent-policy.mjs';
import { headlessAsk, loadHeadlessSettings } from './headless.mjs';

const PROTOCOL_VERSION = 1;

/** @param {unknown} raw @param {string} fallback */
function resolveToolsParam(raw, fallback = 'none') {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw ? 'fs-readonly' : 'none';
  return parseToolProfile(raw, fallback);
}

/** 与 package.json 保持同源，避免发版时漏改 */
const SERVER_VERSION = (() => {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function uid() {
  return `acp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {{ dataRoot: string, tools?: boolean | string, workspace?: string, access?: string }} opts
 */
export async function runAcpServer(opts) {
  const settings = loadHeadlessSettings(opts.dataRoot);
  const toolsDefault = resolveToolsParam(opts.tools, 'none');
  const workspaceDefault = opts.workspace || settings.dataRoot;
  const accessDefault = opts.access || settings.access;
  /** @type {Map<string, { id: string, messages: Array<{ role: string, content: string }>, createdAt: number, toolProfile: string }>} */
  const sessions = new Map();
  let shuttingDown = false;

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stderr.write(
    `Lantern Harness ACP ready (protocol=${PROTOCOL_VERSION} model=${settings.model} tools=${toolsDefault} data=${settings.dataRoot})\n`,
  );

  for await (const line of rl) {
    if (shuttingDown) break;
    const raw = String(line || '').trim();
    if (!raw) continue;
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      fail(null, -32700, 'parse error');
      continue;
    }
    const id = req.id;
    const method = String(req.method ?? '');
    const params = req.params && typeof req.params === 'object' ? req.params : {};

    try {
      if (method === 'initialize') {
        ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: {
            name: 'lantern-harness-acp',
            version: SERVER_VERSION,
          },
          capabilities: {
            sessions: true,
            tools: true,
            streaming: false,
            toolNotifications: true,
          },
          model: settings.model,
          toolsDefault,
        });
        continue;
      }

      if (method === 'ping' || method === '$/ping') {
        ok(id, { ok: true });
        continue;
      }

      if (method === 'session/new' || method === 'newSession') {
        const sid = uid();
        const system =
          typeof params.system === 'string' && params.system.trim()
            ? params.system.trim()
            : '你是 Lantern Harness headless 助手，简洁回答。';
        const toolProfile = resolveToolsParam(params.tools, toolsDefault);
        sessions.set(sid, {
          id: sid,
          messages: [{ role: 'system', content: system }],
          createdAt: Date.now(),
          toolProfile,
        });
        ok(id, { sessionId: sid, tools: toolProfile });
        continue;
      }

      if (method === 'session/prompt' || method === 'prompt') {
        const sessionId = String(params.sessionId ?? params.id ?? '').trim();
        const prompt = String(params.prompt ?? params.text ?? '').trim();
        if (!sessionId || !sessions.has(sessionId)) {
          fail(id, -32001, `unknown session: ${sessionId || '(empty)'}`);
          continue;
        }
        if (!prompt) {
          fail(id, -32602, 'prompt is required');
          continue;
        }
        const sess = sessions.get(sessionId);
        const toolProfile = resolveToolsParam(params.tools, sess.toolProfile);
        sess.messages.push({ role: 'user', content: prompt });

        const history = sess.messages
          .filter((m) => m.role !== 'system')
          .slice(0, -1)
          .slice(-6)
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n');
        const sys = sess.messages.find((m) => m.role === 'system')?.content || '';
        const system = history ? `${sys}\n\n【近期对话】\n${history}` : sys;

        const toolEvents = [];
        const text = await headlessAsk(settings, prompt, {
          system,
          toolProfile,
          access: typeof params.access === 'string' ? params.access : accessDefault,
          workspace: workspaceDefault,
          onTool: (ev) => {
            toolEvents.push(ev);
            notify('session/update', {
              sessionId,
              toolCall: {
                name: ev.name,
                status: ev.status,
                args: ev.args,
                result:
                  ev.result && ev.result.length > 400 ? `${ev.result.slice(0, 400)}…` : ev.result,
              },
            });
          },
        });
        sess.messages.push({ role: 'assistant', content: text });
        ok(id, {
          sessionId,
          stopReason: 'end_turn',
          text,
          model: settings.model,
          tools: toolProfile,
          toolCalls: toolEvents.filter((e) => e.status === 'done').map((e) => e.name),
        });
        continue;
      }

      if (method === 'session/cancel' || method === 'cancel') {
        ok(id, { ok: true, cancelled: false, note: 'no in-flight request to cancel' });
        continue;
      }

      if (method === 'shutdown') {
        ok(id, { ok: true });
        shuttingDown = true;
        rl.close();
        break;
      }

      fail(id, -32601, `method not found: ${method}`);
    } catch (e) {
      fail(id, -32000, e instanceof Error ? e.message : String(e));
    }
  }
}
