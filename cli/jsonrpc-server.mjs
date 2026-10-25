/**
 * sdk-jsonrpc-server 子集：stdio JSON-RPC 2.0（ping / ask）。
 */
import readline from 'node:readline';
import { headlessAsk, loadHeadlessSettings } from './headless.mjs';

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/**
 * @param {{ dataRoot: string, access?: string, tools?: string }} opts
 */
export async function runJsonRpcServer(opts) {
  const settings = loadHeadlessSettings(opts.dataRoot);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stderr.write(
    `Lantern Harness JSON-RPC ready (data=${settings.dataRoot} model=${settings.model} access=${settings.access})\n`,
  );

  for await (const line of rl) {
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
      if (method === 'ping') {
        ok(id, { ok: true, model: settings.model, access: settings.access });
        continue;
      }
      if (method === 'ask') {
        const prompt = String(params.prompt ?? params.text ?? '').trim();
        const text = await headlessAsk(settings, prompt, {
          system: typeof params.system === 'string' ? params.system : undefined,
          access: typeof params.access === 'string' ? params.access : opts.access,
          toolProfile:
            typeof params.tools === 'string' || typeof params.tools === 'boolean'
              ? params.tools
              : opts.tools,
          workspace: opts.dataRoot,
        });
        ok(id, { text, model: settings.model });
        continue;
      }
      fail(id, -32601, `method not found: ${method}`);
    } catch (e) {
      fail(id, -32000, e instanceof Error ? e.message : String(e));
    }
  }
}
