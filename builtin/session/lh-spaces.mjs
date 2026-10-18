/**
 * 数据空间管理接口（`/__tb_spaces`）。
 *
 * 一个数据空间 = 磁盘上一份完整独立的数据目录（内容目录 + .local 全部状态 + 配置）。
 * 切换在这里热生效：不重启进程，只把 space-context 的 activeRoot 指过去。
 *
 * 安全边界（本机服务同样按不可信输入处理）：
 * - 空间名统一走 sanitizeSpaceName（拒绝路径分隔符 / 点开头 / 保留名）
 * - 导入 zip 做 zip-slip 校验（条目必须落在目标目录内）
 * - 删除磁盘数据前校验目标确为数据空间目录
 * - 有会话在跑时拒绝切换（否则在途请求会跨空间读到错误文件）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureSpaceSystemPrompt,
  prepareExternalSpaceDir,
  prepareSpaceDir,
  readSpaceBrief,
  readSpaceSystemPrompt,
  writeSpaceBrief,
  writeSpaceSystemPrompt,
} from '../../cli/data-root.mjs';
import {
  EXPORT_SCOPE_CONTENT,
  PUBLIC_SPACE_ID,
  PUBLIC_SPACE_NAME,
  assertLooksLikeSpace,
  copySpace,
  createSpace,
  discoverSpaces,
  exportSpaceToZip,
  getActiveSpaceId,
  importSpaceFromZip,
  listSpaces,
  normalizeExportScope,
  removeSpace,
  renameSpace,
  resolveSpace,
  sanitizeSpaceName,
  setActiveSpace,
  setRegistryRoot,
  spaceSize,
} from '../../cli/spaces.mjs';
import { loadRunState, saveRunState } from '../../cli/user-config.mjs';
import { closeAllBashSessions } from './bash-session.mjs';
import { closeAllPwshSessions } from './pwsh-session.mjs';
import { hasRunningSessions } from './session-runs.mjs';
import {
  ensureSpaceContext,
  getBaseRoot,
  getDataRoot,
  getPublicSpaceRoot,
  resetActiveRoot,
  setActiveRoot,
} from './space-context.mjs';

const PREFIX = '/__tb_spaces';
/** 导入 zip 的体积上限：本地服务也不接受无上限请求体 */
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req, limit = MAX_IMPORT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = (await readBody(req)).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 });
  }
  return parsed;
}

/**
 * 打包列表响应。
 * @param {boolean} withStats 是否统计体积。遍历目录较慢（空间目录里可能含 node_modules
 *   等大体量目录），因此仅在管理面板显式请求时才做。
 */
function describeSpaces(withStats = false) {
  const listed = listSpaces(getBaseRoot());
  return {
    ok: true,
    baseRoot: getBaseRoot(),
    dataRoot: getDataRoot(),
    activeId: listed.activeId,
    managedParent: listed.managedParent,
    publicName: PUBLIC_SPACE_NAME,
    spaces: listed.spaces.map((s) => ({
      id: s.id,
      name: s.name,
      path: s.path,
      createdAt: s.createdAt,
      isPublic: s.isPublic,
      isActive: s.isActive,
      exists: s.exists,
      removable: !s.isPublic,
      bytes: withStats && s.exists ? spaceSize(s.path) : null,
    })),
  };
}

/** 把当前空间回写到 run.json，让 `lantern status` 显示的路径不落后于界面 */
function syncRunState(dataRoot) {
  const state = loadRunState();
  // 只在本进程就是被 lantern 托管的那份服务时回写，避免 astro dev 误改 CLI 状态
  if (!state || state.pid !== process.pid) return;
  saveRunState({ ...state, dataRoot });
}

/**
 * 切换到指定空间：校验 → 引导目录 → 指过去 → 关闭常驻会话 → 持久化。
 * @param {string} id
 */
function switchSpace(id) {
  const resolved = resolveSpace(id, getBaseRoot());
  if (!resolved.ok) return { ok: false, status: 404, error: resolved.error };

  // 会话正在跑时切换会让在途工具调用跨空间读文件，先挡住
  if (hasRunningSessions()) {
    return { ok: false, status: 409, error: '仍有会话在运行，请先停止后再切换空间' };
  }

  let root;
  try {
    // 公共空间的 path 已是 `<池根>/公共空间`，这里只补该空间自己的骨架。
    // 手工纳入的外部文件夹只补运行时配置，不铺目录 / 不播种子。
    root = resolved.space.external
      ? prepareExternalSpaceDir(resolved.space.path)
      : prepareSpaceDir(resolved.space.path);
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }

  setActiveRoot(root);
  // 常驻 shell 的 cwd / env 绑在旧空间上，必须关掉
  closeAllBashSessions();
  closeAllPwshSessions();

  setActiveSpace(resolved.space.id);
  syncRunState(root);

  return { ok: true, space: { ...resolved.space, path: root } };
}

/**
 * 让进程内的 activeRoot 与注册表里的 activeId 对齐。
 *
 * 注册表是持久的，但进程内的 activeRoot 每次启动都会回到公共空间；
 * 不对齐的话，界面显示「任务空间」，而菜单分组落盘 / 配置写入 / 文档根全落到公共空间。
 * 除了启动，GET /__tb_spaces（界面每次加载都会调）也会顺带自愈一次。
 */
function syncActiveRoot() {
  let activeId = '';
  try {
    activeId = getActiveSpaceId();
  } catch {
    return { ok: false, changed: false };
  }
  if (!activeId || activeId === PUBLIC_SPACE_ID) {
    return { ok: true, id: activeId, changed: false };
  }

  const resolved = resolveSpace(activeId, getBaseRoot());
  if (!resolved.ok || !resolved.space.exists) {
    // 注册表指向的空间已被删掉：退回公共空间，别让服务卡在错误目录
    setActiveSpace(PUBLIC_SPACE_ID);
    resetActiveRoot();
    return { ok: false, id: activeId, changed: true, error: resolved.error };
  }

  const changed = path.resolve(resolved.space.path) !== path.resolve(getDataRoot());
  if (!changed) return { ok: true, id: activeId, changed: false };

  let root;
  try {
    root = resolved.space.external
      ? prepareExternalSpaceDir(resolved.space.path)
      : prepareSpaceDir(resolved.space.path);
  } catch (e) {
    return { ok: false, id: activeId, changed: false, error: String(e?.message ?? e) };
  }
  setActiveRoot(root);
  // 常驻 shell 的 cwd / env 绑在旧空间上，跟着切
  closeAllBashSessions();
  closeAllPwshSessions();
  syncRunState(root);
  return { ok: true, id: activeId, changed: true };
}

/** 重命名的是当前空间时，把服务的数据根指到新目录（否则后续读写仍指向旧路径） */
function retargetActiveRoot(space) {
  if (!space || getActiveSpaceId() !== space.id) return;
  try {
    const nextRoot = prepareSpaceDir(space.path);
    if (path.resolve(nextRoot) === path.resolve(getDataRoot())) return;
    setActiveRoot(nextRoot);
    closeAllBashSessions();
    closeAllPwshSessions();
    syncRunState(nextRoot);
  } catch {
    // 名称已改；路径对齐失败时下次切换空间会自愈
  }
}

export function lhSpacesPlugin() {
  return {
    name: 'lh-spaces',
    configureServer(server) {
      // 首次进入确定基准根；已切换过的空间不会被覆盖
      ensureSpaceContext(server.config.root);
      // 注册表按池根分区：先告诉它当前是哪个数据目录，才能只认自己的空间与激活项
      setRegistryRoot(getBaseRoot());
      // 新进程里 activeRoot 默认是公共空间：按注册表回到用户上次选的空间
      syncActiveRoot();

      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(PREFIX)) return next();

        try {
          if (url === PREFIX && req.method === 'GET') {
            const q = new URLSearchParams(req.url.split('?')[1] ?? '');
            // 自愈：注册表里的空间与进程内的数据根不一致时（如开发服务热重启）先对齐
            syncActiveRoot();
            // 体积统计需要遍历目录，改为按需（管理面板传 stats=1）
            return sendJson(res, 200, describeSpaces(q.get('stats') === '1'));
          }

          if (url === `${PREFIX}/switch` && req.method === 'POST') {
            const body = await readJson(req);
            const out = switchSpace(body.id);
            if (!out.ok) return sendJson(res, out.status ?? 500, { ok: false, error: out.error });
            return sendJson(res, 200, {
              ok: true,
              space: out.space,
              dataRoot: getDataRoot(),
            });
          }

          if (url === `${PREFIX}/create` && req.method === 'POST') {
            const body = await readJson(req);
            const promptText = typeof body.systemPrompt === 'string' ? body.systemPrompt : '';
            if (promptText.length > 80_000) {
              return sendJson(res, 400, { ok: false, error: '默认提示词过长' });
            }
            const created = createSpace({
              name: body.name,
              managedParent: body.managedParent,
              baseRoot: getBaseRoot(),
            });
            if (!created.ok) return sendJson(res, 400, { ok: false, error: created.error });
            try {
              prepareSpaceDir(created.space.path);
              if (promptText.trim()) writeSpaceSystemPrompt(created.space.path, promptText);
              const brief = typeof body.promptBrief === 'string' ? body.promptBrief.trim() : '';
              if (brief) writeSpaceBrief(created.space.path, brief);
            } catch (e) {
              return sendJson(res, 500, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
                space: created.space,
              });
            }
            if (body.switch === true) {
              const out = switchSpace(created.space.id);
              return sendJson(res, 200, {
                ok: true,
                space: out.ok ? out.space : created.space,
                switched: out.ok === true,
                warning: out.ok ? undefined : out.error,
              });
            }
            return sendJson(res, 200, { ok: true, space: created.space, switched: false });
          }

          if (url === `${PREFIX}/rename` && req.method === 'POST') {
            const body = await readJson(req);
            const out = renameSpace(body.id, body.name, getBaseRoot());
            if (!out.ok) return sendJson(res, 400, { ok: false, error: out.error });
            retargetActiveRoot(out.space);
            return sendJson(res, 200, { ok: true, space: out.space });
          }

          // 空间详情：名称 / 提示词要求 / 默认提示词，供管理面板编辑
          if (url === `${PREFIX}/detail` && req.method === 'GET') {
            const q = new URLSearchParams(req.url.split('?')[1] ?? '');
            const resolved = resolveSpace(q.get('id') ?? '', getBaseRoot());
            if (!resolved.ok) return sendJson(res, 404, { ok: false, error: resolved.error });
            const space = resolved.space;
            // 外部纳入的空间不铺骨架；托管空间补齐默认提示词文件
            if (!space.external) {
              try {
                prepareSpaceDir(space.path);
              } catch {
                // 目录暂时不可写时仍然返回已有内容
              }
            }
            return sendJson(res, 200, {
              ok: true,
              space,
              brief: readSpaceBrief(space.path),
              systemPrompt: readSpaceSystemPrompt(space.path),
            });
          }

          // 保存空间名称 / 提示词要求 / 默认提示词
          if (url === `${PREFIX}/update` && req.method === 'POST') {
            const body = await readJson(req);
            const resolved = resolveSpace(body.id, getBaseRoot());
            if (!resolved.ok) return sendJson(res, 404, { ok: false, error: resolved.error });
            let space = resolved.space;

            const nextName = typeof body.name === 'string' ? body.name.trim() : '';
            if (nextName && nextName !== space.name) {
              if (space.isPublic) {
                return sendJson(res, 400, {
                  ok: false,
                  error: `${PUBLIC_SPACE_NAME}不支持重命名`,
                });
              }
              const renamed = renameSpace(space.id, nextName, getBaseRoot());
              if (!renamed.ok) return sendJson(res, 400, { ok: false, error: renamed.error });
              space = renamed.space;
              retargetActiveRoot(space);
            }

            if (typeof body.brief === 'string') {
              if (body.brief.length > 20_000) {
                return sendJson(res, 400, { ok: false, error: '提示词要求过长' });
              }
              writeSpaceBrief(space.path, body.brief);
            }

            if (typeof body.systemPrompt === 'string' && body.systemPrompt.trim()) {
              if (body.systemPrompt.length > 80_000) {
                return sendJson(res, 400, { ok: false, error: '默认提示词过长' });
              }
              try {
                if (!space.external) ensureSpaceSystemPrompt(space.path);
                writeSpaceSystemPrompt(space.path, body.systemPrompt);
              } catch (e) {
                return sendJson(res, 500, {
                  ok: false,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }

            return sendJson(res, 200, {
              ok: true,
              space,
              brief: readSpaceBrief(space.path),
              systemPrompt: readSpaceSystemPrompt(space.path),
            });
          }

          if (url === `${PREFIX}/copy` && req.method === 'POST') {
            const body = await readJson(req);
            // 复制是逐文件拷贝：会话在跑时源空间仍在写，拷出来可能半份
            if (hasRunningSessions()) {
              return sendJson(res, 409, {
                ok: false,
                error: '仍有会话在运行，请先停止后再复制空间',
              });
            }
            const out = copySpace(body.id, body.name, getBaseRoot());
            if (!out.ok) return sendJson(res, 400, { ok: false, error: out.error });
            return sendJson(res, 200, { ok: true, space: out.space });
          }

          if (url === `${PREFIX}/delete` && req.method === 'POST') {
            const body = await readJson(req);
            const purge = body.purge === true;
            // 物理删除是不可逆操作：必须由前端显式确认过才允许
            if (purge && body.confirm !== true) {
              return sendJson(res, 400, {
                ok: false,
                error: '删除磁盘数据需要显式确认（confirm: true）',
              });
            }
            const out = removeSpace({ id: body.id, purge, baseRoot: getBaseRoot() });
            if (!out.ok) return sendJson(res, 400, { ok: false, error: out.error });
            // 被移除的可能正是当前空间（无论是否删数据）：重新按注册表定位，
            // 避免服务继续停留在已不该访问的目录上。
            const activeId = getActiveSpaceId();
            const next = resolveSpace(activeId, getBaseRoot());
            // 兜底回公共空间（父目录本身不是数据根，不能直接指过去）
            const nextRoot = prepareSpaceDir(next.ok ? next.space.path : getPublicSpaceRoot());
            if (path.resolve(nextRoot) !== path.resolve(getDataRoot())) {
              setActiveRoot(nextRoot);
              closeAllBashSessions();
              closeAllPwshSessions();
              syncRunState(nextRoot);
            }
            return sendJson(res, 200, {
              ok: true,
              purged: out.purged === true,
              warning: out.warning,
              dataRoot: getDataRoot(),
            });
          }

          if (url === `${PREFIX}/export` && req.method === 'GET') {
            const q = new URLSearchParams(req.url.split('?')[1] ?? '');
            const id = q.get('id') ?? '';
            // 未指定或非法值都退回完整备份，避免「以为在导内容库、实际导了密钥」
            const scope = normalizeExportScope(q.get('scope'));
            const resolved = resolveSpace(id, getBaseRoot());
            if (!resolved.ok) return sendJson(res, 404, { ok: false, error: resolved.error });
            const tmpFile = path.join(os.tmpdir(), `lantern-space-${Date.now().toString(36)}.zip`);
            const out = await exportSpaceToZip({
              id: resolved.space.id,
              outFile: tmpFile,
              baseRoot: getBaseRoot(),
              scope,
            });
            if (!out.ok) return sendJson(res, 500, { ok: false, error: out.error });
            const buf = fs.readFileSync(out.file);
            fs.rmSync(out.file, { force: true });
            const suffix = scope === EXPORT_SCOPE_CONTENT ? '-content' : '';
            const fileName = `${resolved.space.name}${suffix}.zip`;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="space.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            );
            res.setHeader('Content-Length', String(buf.length));
            res.end(buf);
            return;
          }

          if (url === `${PREFIX}/import` && req.method === 'POST') {
            const body = await readJson(req);
            const base64 = String(body.zipBase64 || '');
            if (!base64) return sendJson(res, 400, { ok: false, error: '缺少 zipBase64' });
            let buf;
            try {
              buf = Buffer.from(base64, 'base64');
            } catch {
              return sendJson(res, 400, { ok: false, error: '内容不是合法 base64' });
            }
            if (!buf.length) return sendJson(res, 400, { ok: false, error: '内容为空' });
            const tmpFile = path.join(os.tmpdir(), `lantern-import-${Date.now().toString(36)}.zip`);
            fs.writeFileSync(tmpFile, buf);
            try {
              const out = await importSpaceFromZip({
                zipFile: tmpFile,
                name: body.name,
                managedParent: body.managedParent,
                baseRoot: getBaseRoot(),
              });
              if (!out.ok) return sendJson(res, 400, { ok: false, error: out.error });
              prepareSpaceDir(out.space.path);
              return sendJson(res, 200, { ok: true, space: out.space });
            } finally {
              fs.rmSync(tmpFile, { force: true });
            }
          }

          if (url === `${PREFIX}/discover` && req.method === 'POST') {
            // 扫描托管目录：把「带 .lantern/space.json 清单的空间文件夹」纳入列表（整体拷贝进来的文件夹靠这里被识别）。
            // 其它文件夹作为 candidates 返回，由界面确认后带 adopt 再次提交（只登记，不写元数据）。
            const body = await readJson(req);
            const out = discoverSpaces({
              managedParent: body.managedParent ? String(body.managedParent) : undefined,
              baseRoot: getBaseRoot(),
              adopt: Array.isArray(body.adopt) ? body.adopt.map((x) => String(x)) : undefined,
            });
            return sendJson(res, 200, {
              ok: true,
              managedParent: out.managedParent,
              added: out.added.map((s) => ({
                id: s.id,
                name: s.name,
                path: s.path,
                ...(s.external ? { external: true } : {}),
              })),
              backfilled: out.backfilled,
              skipped: out.skipped,
              candidates: out.candidates,
            });
          }

          if (url === `${PREFIX}/validate-name` && req.method === 'POST') {
            const body = await readJson(req);
            return sendJson(res, 200, { ok: true, ...sanitizeSpaceName(body.name) });
          }

          return sendJson(res, 404, { ok: false, error: 'not found' });
        } catch (e) {
          const status =
            e && typeof e === 'object' && 'status' in e ? Number(e.status) || 500 : 500;
          return sendJson(res, status, {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });
    },
  };
}

export { PUBLIC_SPACE_ID, PUBLIC_SPACE_NAME, assertLooksLikeSpace };
