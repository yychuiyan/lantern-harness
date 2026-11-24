import { getDataRoot } from '../builtin/session/space-context.mjs';
import {
  CASE_AUTOMATION_PROMPT_FILE,
  CASE_AUTOMATION_PROMPT_TEMPLATE,
} from './case-automation-prompt.mjs';
import {
  assessCases,
  applyAssessment,
  getBatch,
  listIterations,
  projectSelection,
  refreshAutomationFile,
  startBatch,
  sourceDocument,
  statuses,
  stopBatch,
} from './case-automation/service.mjs';
import { ensurePluginPrompt, isPluginOnInSpace } from './plugin-prompts.mjs';
import { automationSummaryForFile } from './case-automation/store.mjs';

const PREFIX = '/__tb_case_automation';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(Object.assign(new Error('请求内容过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function lhCaseAutomationPlugin() {
  return {
    name: 'lh-case-automation',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url || '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        const tail = parsed.pathname.slice(PREFIX.length) || '/';
        const method = req.method || 'GET';
        try {
          const root = getDataRoot();
          const enabled = isPluginOnInSpace('cases', root) && isPluginOnInSpace('uiAuto', root);
          if (parsed.pathname === `${PREFIX}/health`)
            return sendJson(res, 200, {
              ok: true,
              enabled,
              cases: isPluginOnInSpace('cases', root),
              uiAuto: isPluginOnInSpace('uiAuto', root),
            });
          if (!enabled) {
            return sendJson(res, 403, {
              ok: false,
              error: '功能用例转 UI 自动化需要开启「用例管理」和「自动化测试」',
            });
          }
          if (method !== 'GET' && !sameOrigin(req)) {
            return sendJson(res, 403, {
              ok: false,
              error: '请求必须来自当前 Lantern 页面',
            });
          }
          ensurePluginPrompt(CASE_AUTOMATION_PROMPT_FILE, CASE_AUTOMATION_PROMPT_TEMPLATE, root);
          if (method === 'GET' && tail === '/iterations') {
            return sendJson(
              res,
              200,
              listIterations(
                root,
                parsed.searchParams.get('projectId') || '',
                parsed.searchParams.get('casePath') || '',
              ),
            );
          }
          if (method === 'GET' && tail === '/cases') {
            return sendJson(res, 200, {
              ok: true,
              document: await sourceDocument(root, parsed.searchParams.get('path') || ''),
            });
          }
          if (method === 'GET' && tail === '/selection') {
            return sendJson(res, 200, {
              ok: true,
              selection: projectSelection(root, parsed.searchParams.get('casePath') || ''),
            });
          }
          if (method === 'GET' && tail === '/status') {
            return sendJson(res, 200, {
              ok: true,
              statuses: await statuses(root, parsed.searchParams.get('casePath') || ''),
            });
          }
          if (method === 'GET' && tail.startsWith('/runs/')) {
            const id = tail.split('/')[2] || '';
            return sendJson(res, 200, { ok: true, batch: getBatch(root, id) });
          }
          if (method === 'POST' && tail === '/assess') {
            return sendJson(
              res,
              200,
              await assessCases(root, JSON.parse((await readBody(req)) || '{}')),
            );
          }
          if (method === 'POST' && tail === '/summaries') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
            await Promise.all(paths.map((casePath) => refreshAutomationFile(root, casePath)));
            return sendJson(res, 200, {
              ok: true,
              summaries: Object.fromEntries(
                paths.map((casePath) => [casePath, automationSummaryForFile(root, casePath)]),
              ),
            });
          }
          if (method === 'POST' && tail === '/apply') {
            return sendJson(
              res,
              200,
              await applyAssessment(root, JSON.parse((await readBody(req)) || '{}')),
            );
          }
          if (method === 'POST' && tail === '/runs') {
            return sendJson(res, 200, {
              ok: true,
              batch: startBatch(root, JSON.parse((await readBody(req)) || '{}')),
            });
          }
          if (method === 'POST' && tail.endsWith('/stop') && tail.startsWith('/runs/')) {
            return sendJson(res, 200, {
              ok: true,
              batch: stopBatch(root, tail.split('/')[2] || ''),
            });
          }
          return sendJson(res, 404, { ok: false, error: '接口不存在' });
        } catch (error) {
          return sendJson(res, error.statusCode || 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
