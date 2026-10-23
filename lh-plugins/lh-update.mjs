/**
 * 版本检测与一键更新接口（`/__tb_update`）。
 *
 * - `GET  /__tb_update[?refresh=1]`：当前版本、npm 最新版本、安装方式、上次更新状态
 * - `POST /__tb_update`：停服 → 全局安装 → 自动重启（body 必须带 `confirm: true`，可带 `version`）
 *
 * 只允许「本进程就是在跑的那个服务」触发更新：
 * 同一台机器可能有多个 lantern 实例（不同端口 / 不同数据目录），
 * 更新会停掉 run.json 里记录的那个 pid，误触会打断别人的会话。
 * 另需显式确认标记：旧版本页面、脚本或任何顺手发出的 POST 都不能把服务停掉升级。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isPidAlive, loadRunState } from '../cli/user-config.mjs';
import {
  detachedCwd,
  detectInstallMode,
  fetchLatestVersion,
  hasUpdate,
  readUpdateStatus,
  resolvePackageManager,
  updateLogHint,
  writeUpdateStatus,
} from '../builtin/session/update-check.mjs';

const PREFIX = '/__tb_update';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(PKG_ROOT, 'cli', 'lantern.mjs');

/** 本进程读到的版本：更新替换的是另一个目录，这里始终是旧版本 */
const CURRENT_VERSION = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    return typeof raw.version === 'string' ? raw.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 当前进程是否就是 run.json 里记录的服务进程 */
function runsThisProcess() {
  const run = loadRunState();
  if (!run?.pid) return false;
  const pid = Number(run.pid);
  if (!Number.isFinite(pid) || pid !== process.pid) return false;
  return isPidAlive(pid);
}

/**
 * 分离进程执行 `lantern update`：
 * 子进程会先停掉当前服务（也就是本进程），所以必须 detached + unref。
 * cwd 用临时目录：Windows 上从包目录启动会锁住要被替换的目录。
 */
function spawnUpdate(version) {
  const args = [CLI_PATH, 'update'];
  if (version) args.push(version);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    cwd: detachedCwd(),
    env: { ...process.env, LANTERN_UPDATE_FROM_UI: '1' },
  });
  child.unref();
  return child.pid ?? 0;
}

export function lhUpdatePlugin() {
  return {
    name: 'lh-update',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (url !== PREFIX) return next();

        const method = req.method ?? 'GET';

        if (method === 'GET') {
          const q = new URLSearchParams(req.url.split('?')[1] ?? '');
          const force = q.get('refresh') === '1';
          const pm = resolvePackageManager();
          const mode = detectInstallMode(PKG_ROOT, pm);
          const latest = await fetchLatestVersion({ force });
          return sendJson(res, 200, {
            ok: true,
            current: CURRENT_VERSION,
            latest: latest.latest,
            hasUpdate: hasUpdate(latest.latest, CURRENT_VERSION),
            mode,
            pm,
            registry: latest.registry,
            checkedAt: latest.checkedAt ? new Date(latest.checkedAt).toISOString() : '',
            error: latest.error,
            status: readUpdateStatus(),
            logPath: updateLogHint(),
          });
        }

        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (body.confirm !== true) {
            return sendJson(res, 400, {
              ok: false,
              error:
                '更新需要显式确认（confirm: true）：请用页面上的「更新并重启」，或用 lantern update',
            });
          }

          const pm = resolvePackageManager();
          const mode = detectInstallMode(PKG_ROOT, pm);
          if (mode === 'dev') {
            return sendJson(res, 409, {
              ok: false,
              error: '当前是源码 / 开发模式，请在仓库里 git pull 后重新构建（pnpm build）',
            });
          }
          if (!runsThisProcess()) {
            return sendJson(res, 409, {
              ok: false,
              error:
                '当前页面连接的不是 lantern 启动的服务，无法在这里更新；请在 lantern 打开的页面操作，或用 lantern update',
            });
          }

          // 连点两次不要起两个安装进程（第二个会去停掉第一个正在重启的服务）
          const existing = readUpdateStatus();
          if (existing?.phase === 'installing' || existing?.phase === 'restarting') {
            return sendJson(res, 409, { ok: false, error: '已有更新正在进行中，请稍候' });
          }

          const version = typeof body.version === 'string' ? body.version.trim() : '';

          writeUpdateStatus({ phase: 'installing', from: CURRENT_VERSION, to: version });
          // 先返回成功：子进程会停掉当前服务，响应必须在 SIGTERM 之前刷出去
          sendJson(res, 202, { ok: true, from: CURRENT_VERSION, to: version });
          // 留一点时间让响应与页面轮询都落定，再让子进程停服
          const timer = setTimeout(() => {
            try {
              spawnUpdate(version);
            } catch (e) {
              writeUpdateStatus({
                phase: 'failed',
                from: CURRENT_VERSION,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }, 600);
          timer.unref?.();
          return;
        }

        res.statusCode = 405;
        res.end('Method Not Allowed');
      });
    },
  };
}
