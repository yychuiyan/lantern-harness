/**
 * MCP 客户端 HTTP 面：`/__tb_mcp/health` · `/tools` · `/call` · `/reload`
 */
import { getDataRoot } from '../builtin/session/space-context.mjs';
import {
  callMcpTool,
  ensureMcpClients,
  listMcpTools,
  loadMcpConfig,
} from '../builtin/session/mcp-client.mjs';

const PREFIX = '/__tb_mcp';

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

/**
 * @returns {import('vite').Plugin}
 */
export function lhMcpPlugin() {
  return {
    name: 'lh-mcp',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(PREFIX)) return next();
        const root = getDataRoot();
        try {
          if (url === `${PREFIX}/health` && req.method === 'GET') {
            const cfg = loadMcpConfig(root);
            return sendJson(res, 200, {
              ok: true,
              serversConfigured: cfg.servers.length,
              path: cfg.path,
            });
          }
          if (url === `${PREFIX}/reload` && req.method === 'POST') {
            const r = await ensureMcpClients(root);
            return sendJson(res, 200, { ok: true, ...r });
          }
          if (url === `${PREFIX}/tools` && req.method === 'GET') {
            const data = await listMcpTools(root);
            return sendJson(res, 200, data);
          }
          if (url === `${PREFIX}/call` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const name = String(body.name || body.tool || '').trim();
            if (!name) return sendJson(res, 400, { ok: false, error: 'name is required' });
            let args = body.arguments ?? body.args ?? {};
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args || '{}');
              } catch {
                return sendJson(res, 400, { ok: false, error: 'invalid arguments JSON' });
              }
            }
            const result = await callMcpTool(name, args, root);
            return sendJson(res, result.ok ? 200 : 400, result);
          }
          return sendJson(res, 404, { error: 'not found' });
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
