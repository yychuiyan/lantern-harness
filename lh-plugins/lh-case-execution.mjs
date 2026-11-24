import {
  createExecutionPlan,
  listExecutionPlans,
  getExecutionPlan,
  startExecutionPlan,
  stopExecutionPlan,
  verifyExecutionPlanItem,
} from './case-execution/plans.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import {
  CASE_EXECUTION_PROMPT_FILE,
  CASE_EXECUTION_PROMPT_TEMPLATE,
} from './case-execution-prompt.mjs';
import {
  applyManualResult,
  cancelManualLogin,
  completeManualLogin,
  confirmRun,
  getRun,
  listExecutionRuns,
  savedAuthFor,
  shotPath,
  startManualLogin,
  startRun,
  stopRun,
  subscribeRun,
} from './case-execution/service.mjs';
import {
  applyCaseFieldUpdates,
  prepareExecutionColumns,
  listCaseDocuments,
  loadCaseDocument,
} from './case-execution/files.mjs';
import { ensurePluginPrompt, isPluginOnInSpace } from './plugin-prompts.mjs';
import { automationSummaryForCase } from './case-automation/store.mjs';
import { refreshAutomationLinks } from './case-automation/service.mjs';

const PREFIX = '/__tb_case_run';

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

async function statsRequest(host, route = '', init = {}) {
  const response = await fetch(`http://${host}/__tb_case_exec${route}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `用例执行统计 HTTP ${response.status}`), {
      statusCode: response.status,
    });
  }
  return data;
}

async function syncStats(root, host, raw) {
  const casePath = String(raw.casePath || '').trim();
  const project = String(raw.project || '').trim();
  const date = String(raw.date || '').trim();
  const mode = raw.mode === 'overwrite' ? 'overwrite' : raw.mode === 'skip' ? 'skip' : 'preview';
  if (!casePath) throw Object.assign(new Error('缺少用例文件路径'), { statusCode: 400 });
  if (!project) throw Object.assign(new Error('请选择统计项目'), { statusCode: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('统计日期格式无效'), { statusCode: 400 });
  }
  const document = await loadCaseDocument(root, casePath);
  const completedStatuses = new Set(['通过', '不通过', '阻塞', '跳过']);
  const executed = document.cases.filter((item) => {
    const status = String(item.status || '').trim();
    return (
      completedStatuses.has(status) ||
      /^(p|pass|passed|ok|成功|true|1|f|fail|failed|失败|false|0)$/i.test(status) ||
      /block|skip|n\/?a/i.test(status)
    );
  }).length;
  const total = document.cases.length;
  const pending = Math.max(0, total - executed);
  const current = await statsRequest(host);
  const existing = (current.items || []).find(
    (item) => item.project === project && item.date === date,
  );
  const preview = {
    casePath,
    project,
    date,
    total,
    executed,
    pending,
    existing: existing || null,
  };
  if (mode === 'preview') return { ok: true, preview };
  if (existing && mode === 'skip') {
    return { ok: true, preview, skipped: true, item: existing };
  }
  if (existing) {
    const data = await statsRequest(host, '', {
      method: 'PUT',
      body: JSON.stringify({
        id: existing.id,
        total,
        pending,
        executed,
      }),
    });
    return { ok: true, preview, overwritten: true, item: data.item };
  }
  const data = await statsRequest(host, '', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'manual',
      items: [
        {
          date,
          project,
          startDate: date,
          endDate: date,
          total,
          pending,
          executed,
        },
      ],
    }),
  });
  return {
    ok: true,
    preview,
    item: (data.items || []).find((item) => item.project === project && item.date === date) || null,
  };
}

export function lhCaseExecutionPlugin() {
  return {
    name: 'lh-case-execution',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url || '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        const tail = parsed.pathname.slice(PREFIX.length) || '/';
        const method = req.method || 'GET';
        try {
          const root = getDataRoot();
          const enabled = isPluginOnInSpace('caseExecution', root);
          if (enabled) {
            ensurePluginPrompt(CASE_EXECUTION_PROMPT_FILE, CASE_EXECUTION_PROMPT_TEMPLATE, root);
          }
          if (parsed.pathname === `${PREFIX}/health` && parsed.searchParams.get('health') === '1') {
            return sendJson(res, 200, { ok: true, enabled });
          }
          if (!enabled) {
            return sendJson(res, 403, {
              ok: false,
              error: '请先在插件仓库开启「用例执行」',
            });
          }
          if (!sameOrigin(req) && method !== 'GET') {
            return sendJson(res, 403, {
              ok: false,
              error: '用例执行请求必须来自当前 Lantern 页面',
            });
          }

          if (method === 'GET' && tail === '/plans')
            return sendJson(res, 200, {
              ok: true,
              plans: listExecutionPlans(root, parsed.searchParams.get('path') || ''),
            });
          if (method === 'POST' && tail === '/plans')
            return sendJson(res, 200, {
              ok: true,
              plan: await createExecutionPlan(root, JSON.parse((await readBody(req)) || '{}')),
            });
          if (tail.startsWith('/plans/')) {
            const id = tail.split('/')[2];
            if (method === 'POST' && tail.endsWith('/result'))
              return sendJson(
                res,
                200,
                await verifyExecutionPlanItem(root, id, JSON.parse((await readBody(req)) || '{}')),
              );
            if (method === 'GET')
              return sendJson(res, 200, { ok: true, plan: getExecutionPlan(root, id) });
            if (method === 'POST' && tail.endsWith('/start'))
              return sendJson(res, 200, { ok: true, plan: startExecutionPlan(root, id) });
            if (method === 'POST' && tail.endsWith('/stop'))
              return sendJson(res, 200, { ok: true, plan: stopExecutionPlan(root, id) });
          }
          if (method === 'GET' && tail === '/files') {
            return sendJson(res, 200, {
              ok: true,
              files: await listCaseDocuments(root),
            });
          }
          if (method === 'GET' && tail === '/cases') {
            const document = await loadCaseDocument(
              root,
              String(parsed.searchParams.get('path') || ''),
            );
            refreshAutomationLinks(root, document);
            const { _parsed, _map, abs, ...publicDocument } = document;
            return sendJson(res, 200, {
              ok: true,
              document: {
                ...publicDocument,
                cases: publicDocument.cases.map((item) => ({
                  ...item,
                  automation: automationSummaryForCase(root, publicDocument.path, item.id),
                })),
              },
            });
          }
          if (method === 'GET' && tail === '/runs') {
            return sendJson(res, 200, {
              ok: true,
              runs: listExecutionRuns(root, parsed.searchParams.get('path') || ''),
            });
          }
          if (method === 'GET' && tail.startsWith('/runs/') && tail.endsWith('/events')) {
            const runId = tail.split('/')[2];
            return subscribeRun(root, runId, Number(parsed.searchParams.get('after') || 0), res);
          }
          if (method === 'GET' && tail.startsWith('/runs/') && tail.includes('/shots/')) {
            const parts = tail.split('/');
            const file = decodeURIComponent(parts[4] || '');
            const abs = shotPath(root, parts[2], file);
            if (!fs.existsSync(abs)) return sendJson(res, 404, { ok: false, error: '截图不存在' });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'no-store');
            return fs.createReadStream(abs).pipe(res);
          }
          if (method === 'GET' && tail.startsWith('/runs/')) {
            return sendJson(res, 200, {
              ok: true,
              run: getRun(root, tail.split('/')[2] || ''),
            });
          }
          if (method === 'GET' && tail === '/auth/status') {
            return sendJson(res, 200, {
              ok: true,
              ...savedAuthFor(root, { url: parsed.searchParams.get('url') || '' }),
            });
          }
          if (method === 'POST' && tail === '/auth/start') {
            return sendJson(
              res,
              200,
              await startManualLogin(root, JSON.parse((await readBody(req)) || '{}')),
            );
          }
          if (method === 'POST' && tail === '/auth/complete') {
            return sendJson(res, 200, await completeManualLogin(root));
          }
          if (method === 'POST' && tail === '/auth/cancel') {
            return sendJson(res, 200, await cancelManualLogin(root));
          }
          if (method === 'POST' && tail === '/runs') {
            const body = JSON.parse((await readBody(req)) || '{}');
            return sendJson(res, 202, { ok: true, run: await startRun(root, body) });
          }
          if (method === 'POST' && tail.startsWith('/runs/') && tail.endsWith('/stop')) {
            return sendJson(res, 200, {
              ok: true,
              run: stopRun(root, tail.split('/')[2] || ''),
            });
          }
          if (method === 'POST' && tail.startsWith('/runs/') && tail.endsWith('/apply')) {
            const body = JSON.parse((await readBody(req)) || '{}');
            return sendJson(res, 200, {
              ok: true,
              ...(await confirmRun(root, tail.split('/')[2] || '', body)),
            });
          }
          if (method === 'POST' && tail === '/manual') {
            const body = JSON.parse((await readBody(req)) || '{}');
            return sendJson(res, 200, {
              ok: true,
              applied: await applyManualResult(root, body),
            });
          }
          if (method === 'POST' && tail === '/prepare-columns')
            return sendJson(
              res,
              200,
              await prepareExecutionColumns(root, JSON.parse((await readBody(req)) || '{}')),
            );
          if (method === 'POST' && tail === '/fields') {
            const body = JSON.parse((await readBody(req)) || '{}');
            return sendJson(res, 200, {
              ok: true,
              applied: await applyCaseFieldUpdates(root, {
                path: body.casePath,
                expectedFileHash: body.expectedFileHash,
                rowIndex: body.rowIndex,
                updates: body.updates,
              }),
            });
          }
          if (method === 'POST' && tail === '/stats/sync') {
            const body = JSON.parse((await readBody(req)) || '{}');
            return sendJson(
              res,
              200,
              await syncStats(root, req.headers.host || '127.0.0.1:4321', body),
            );
          }
          return sendJson(res, 404, { ok: false, error: '接口不存在' });
        } catch (error) {
          return sendJson(res, Number(error?.statusCode) || 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...(error?.currentHash ? { currentHash: error.currentHash } : {}),
          });
        }
      });
    },
  };
}
