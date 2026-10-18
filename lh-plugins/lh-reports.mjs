/**
 * 工作汇报插件：开关联动「提示词 + 汇报文件夹」。
 *
 * - 打开：补齐 `提示词管理/工作汇报提示词.md`（已存在不覆盖，保留用户改过的内容），
 *   同时在当前空间铺出 `工作汇报/日报`、`工作汇报/周报`、`工作汇报/月报` 三个目录
 * - 关闭：只把插件停用，**提示词文件保留**（下次打开还是原来那份，改过的内容不会丢）；
 *   汇报文件夹与里面已有的汇报同样保留
 *
 * 用哪份提示词可以换：状态存在 `.lantern/local/reports.json`，页面上的下拉框直接改；
 * 选中的文件被改名或删掉时，自动回退到默认名 / 名字里带「工作汇报」的提示词。
 *
 * 汇报列表直接读上面三个目录里的文本文件（.md / .txt / .html），文件就是数据，
 * 页面上按「生成日期 + 文件名」展示，点文件名用系统默认程序在本地打开（`/__tb_reports/open`）；
 * `/__tb_reports/file` 仍保留，供其它客户端直接取正文。
 */
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot, spaceLocalFile } from '../builtin/session/space-layout.mjs';
import { DOC_ROOT_DIRS, openLocalPath } from './lh-project-docs.mjs';

const PREFIX = '/__tb_reports';

/** 提示词管理里的默认文件名（前端读同一个名字） */
export const REPORT_PROMPT_FILE = '工作汇报提示词.md';

/** 汇报根目录与三类子目录：日报 / 周报 / 月报 */
export const REPORT_ROOT_DIR = '工作汇报';
export const REPORT_KINDS = {
  day: '日报',
  week: '周报',
  month: '月报',
};

/** 提示词下拉里不参与选择的文件：空间默认提示词不属于任何插件 */
const RESERVED_PROMPT_FILES = new Set(['默认提示词.md']);

const PROMPT_EXTS = new Set(['.md', '.markdown', '.txt']);

/** 打开插件时生成的提示词正文：先给一份最小可用的，用户之后自己补充 */
export const REPORT_PROMPT_TEMPLATE = `你是「工作汇报」助手，帮用户写日报 / 周报 / 月报。

- 用户没说明类型时按周报写；材料不足就按已知信息先写，末尾用「待补充」列出缺口，不要编造数据。
- 结构：一句话结论 / 已完成（做了什么 → 结果） / 进行中与风险 / 下一步计划。
- 条目动词开头，能写数字就写数字；默认输出 Markdown，不写入文件，除非用户明确要求。
- 用户要求存盘时，按类型放进「工作汇报」下对应的「日报 / 周报 / 月报」子目录，文件名用日期：日报与周报用 YYYY-MM-DD.md，月报用 YYYY-MM.md。
`;

/** 列表里认的文本文件：其它格式（docx / pdf）交给系统程序打开，不在页面渲染 */
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.html', '.htm']);

const CONTENT_TYPES = {
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
};

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

/** 当前空间的提示词目录（可能被归进分组文件夹，统一走 resolveContentRoot） */
function promptsDir(spaceDir) {
  return resolveContentRoot(spaceDir, DOC_ROOT_DIRS.prompts.dirName).abs;
}

function reportsRoot(spaceDir) {
  // 跟着菜单分组走：被拖进分组文件夹时，汇报目录也在分组里
  return resolveContentRoot(spaceDir, REPORT_ROOT_DIR).abs;
}

/** 相对空间的目录（分组后是「分组名/工作汇报/日报」），页面顶部展示用 */
function reportKindRel(spaceDir, kind) {
  const dir = kindDir(spaceDir, kind);
  if (!dir) return '';
  return path.relative(path.resolve(spaceDir), dir).split(path.sep).join('/');
}

/** 某一类的目录（kind 非法时返回 null） */
function kindDir(spaceDir, kind) {
  const name = REPORT_KINDS[kind];
  return name ? path.join(reportsRoot(spaceDir), name) : null;
}

/** 铺出 工作汇报/日报|周报|月报，已存在就跳过 */
function ensureReportDirs(spaceDir) {
  const root = reportsRoot(spaceDir);
  fs.mkdirSync(root, { recursive: true });
  for (const name of Object.values(REPORT_KINDS)) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
  return root;
}

/* ── 插件状态：开关 + 选中的提示词文件名 ── */

function statePath(spaceDir) {
  return spaceLocalFile(spaceDir, 'reports.json');
}

function readState(spaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(spaceDir), 'utf8'));
    return {
      enabled: raw?.enabled === true,
      promptFile: typeof raw?.promptFile === 'string' ? raw.promptFile.trim() : '',
    };
  } catch {
    return { enabled: false, promptFile: '' };
  }
}

function writeState(spaceDir, state) {
  const fp = statePath(spaceDir);
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify(
        { enabled: state.enabled === true, promptFile: state.promptFile || '' },
        null,
        2,
      )}\n`,
      'utf8',
    );
    fs.renameSync(tmp, fp);
  } catch {
    // 状态只是锦上添花：写不进去也不影响提示词本身
  }
}

/** 提示词目录里的候选文件（排除空间默认提示词与隐藏文件） */
function listPromptFiles(spaceDir) {
  const dir = promptsDir(spaceDir);
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((ent) => ent.isFile() && !ent.name.startsWith('.'))
      .map((ent) => ent.name)
      .filter((name) => PROMPT_EXTS.has(path.extname(name).toLowerCase()))
      .filter((name) => !RESERVED_PROMPT_FILES.has(name));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const abs = path.join(dir, name);
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        // ignore
      }
      return { name, size: stat?.size ?? 0, mtime: stat?.mtimeMs ?? 0 };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 解析当前生效的提示词文件名。
 * 选中的文件被改名 / 删除时，依次回退：默认名 → 名字里带「工作汇报」→ 无。
 * @returns {string} 文件名；没有可用文件时为空串
 */
function resolvePromptName(spaceDir, state) {
  const files = listPromptFiles(spaceDir);
  const names = new Set(files.map((f) => f.name));
  if (state.promptFile && names.has(state.promptFile)) return state.promptFile;
  if (names.has(REPORT_PROMPT_FILE)) return REPORT_PROMPT_FILE;
  const guess = files.find((f) => f.name.includes('工作汇报'));
  return guess ? guess.name : '';
}

/** 打开插件：缺提示词就补一份；已有内容不覆盖（用户的修改优先） */
function ensurePrompt(spaceDir, state) {
  // 只认现在还在的文件；选中的文件被改名 / 删掉时回退到默认名，不复活旧名字
  const name = resolvePromptName(spaceDir, state) || REPORT_PROMPT_FILE;
  const dir = promptsDir(spaceDir);
  const dest = path.join(dir, name);
  if (fs.existsSync(dest)) return { created: false, name };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, REPORT_PROMPT_TEMPLATE, 'utf8');
  return { created: true, name };
}

/** 文件读取地址：页面已不再展示，供其它客户端直接取正文 */
function fileUrl(kind, name) {
  const qs = new URLSearchParams({ kind, name });
  return `${PREFIX}/file?${qs.toString()}`;
}

/** 列表项：只认文本文件，按修改时间从新到旧 */
function listReports(spaceDir, kind) {
  const dir = kindDir(spaceDir, kind);
  if (!dir) return null;
  ensureReportDirs(spaceDir);
  const items = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || ent.name.startsWith('.')) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    const abs = path.join(dir, ent.name);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    items.push({
      name: ent.name,
      kind,
      size: stat.size,
      generatedAt: stat.mtimeMs,
      url: fileUrl(kind, ent.name),
    });
  }
  items.sort((a, b) => b.generatedAt - a.generatedAt);
  return items;
}

/** 解析文件请求：kind + 文件名，禁止跳出该类目录 */
function resolveReportFile(spaceDir, kind, name, options = {}) {
  const dir = kindDir(spaceDir, kind);
  if (!dir || !name) return null;
  const base = path.basename(name);
  if (!base || base.startsWith('.')) return null;
  const ext = path.extname(base).toLowerCase();
  // 页面渲染只认文本；「在本地打开」交给系统默认程序，任何文件都能开
  if (!options.anyExt && !TEXT_EXTS.has(ext)) return null;
  const abs = path.join(dir, base);
  if (!abs.startsWith(dir + path.sep)) return null;
  if (!fs.existsSync(abs)) return null;
  return { abs, base, ext };
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhReportsPlugin() {
  return {
    name: 'lh-reports',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(PREFIX)) return next();

        try {
          // 数据根惰性读取：切换空间后自动作用到新空间
          const spaceDir = getDataRoot();
          const query = new URLSearchParams(req.url?.split('?')[1] ?? '');
          const state = readState(spaceDir);
          const promptName = resolvePromptName(spaceDir, state);

          if (url === `${PREFIX}/health` && req.method === 'GET') {
            return sendJson(res, 200, {
              ok: true,
              exists: Boolean(promptName),
              file: promptName || REPORT_PROMPT_FILE,
              root: REPORT_ROOT_DIR,
            });
          }

          /** 当前状态：开关 + 生效的提示词 */
          if (url === `${PREFIX}/state` && req.method === 'GET') {
            return sendJson(res, 200, {
              ok: true,
              enabled: state.enabled,
              promptFile: promptName,
              exists: Boolean(promptName),
              root: REPORT_ROOT_DIR,
            });
          }

          /** 提示词下拉的候选列表 */
          if (url === `${PREFIX}/prompts` && req.method === 'GET') {
            const files = listPromptFiles(spaceDir);
            return sendJson(res, 200, {
              ok: true,
              promptFile: promptName,
              items: files.map((f) => ({
                ...f,
                selected: f.name === promptName,
              })),
            });
          }

          /** 切换生效的提示词：只改「用哪份」，不动文件内容 */
          if (url === `${PREFIX}/select` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const file = path.basename(String(body.file ?? '').trim());
            const names = new Set(listPromptFiles(spaceDir).map((f) => f.name));
            if (!file || !names.has(file)) {
              return sendJson(res, 404, { ok: false, error: '提示词不存在' });
            }
            writeState(spaceDir, { enabled: state.enabled, promptFile: file });
            return sendJson(res, 200, { ok: true, promptFile: file });
          }

          if (url === `${PREFIX}/prompt` && req.method === 'GET') {
            if (!promptName) {
              return sendJson(res, 200, { ok: true, exists: false, content: '' });
            }
            const dest = path.join(promptsDir(spaceDir), promptName);
            return sendJson(res, 200, {
              ok: true,
              exists: true,
              file: promptName,
              content: fs.readFileSync(dest, 'utf8'),
            });
          }

          if (url === `${PREFIX}/sync` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            if (body.enabled === true) {
              const out = ensurePrompt(spaceDir, state);
              ensureReportDirs(spaceDir);
              writeState(spaceDir, { enabled: true, promptFile: out.name });
              return sendJson(res, 200, {
                ok: true,
                enabled: true,
                file: out.name,
                created: out.created,
                root: REPORT_ROOT_DIR,
              });
            }
            // 关闭只停用，不删文件：重新打开仍是原来那份（改过的内容也还在）
            writeState(spaceDir, { enabled: false, promptFile: promptName });
            return sendJson(res, 200, {
              ok: true,
              enabled: false,
              file: promptName || REPORT_PROMPT_FILE,
              removed: false,
              root: REPORT_ROOT_DIR,
            });
          }

          if (url === `${PREFIX}/list` && req.method === 'GET') {
            const kind = query.get('kind') ?? 'day';
            const items = listReports(spaceDir, kind);
            if (!items) return sendJson(res, 400, { error: `未知的汇报类型：${kind}` });
            return sendJson(res, 200, {
              ok: true,
              kind,
              label: REPORT_KINDS[kind],
              dir: reportKindRel(spaceDir, kind),
              items,
            });
          }

          if (url === `${PREFIX}/file` && req.method === 'GET') {
            const found = resolveReportFile(
              spaceDir,
              query.get('kind') ?? 'day',
              query.get('name') ?? '',
            );
            if (!found) return sendJson(res, 404, { error: '文件不存在' });
            const buf = fs.readFileSync(found.abs);
            res.statusCode = 200;
            res.setHeader('Content-Type', CONTENT_TYPES[found.ext] ?? 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            // 文件名可能含中文：按 RFC 5987 给一份 UTF-8 名，避免乱码
            res.setHeader(
              'Content-Disposition',
              `inline; filename*=UTF-8''${encodeURIComponent(found.base)}`,
            );
            res.end(buf);
            return;
          }

          /** 在本地打开：交给系统默认程序（macOS 的访达/编辑器、Windows 的关联程序） */
          if (url === `${PREFIX}/open` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const found = resolveReportFile(
              spaceDir,
              typeof body.kind === 'string' ? body.kind : 'day',
              typeof body.name === 'string' ? body.name : '',
              { anyExt: true },
            );
            if (!found) return sendJson(res, 404, { ok: false, error: '文件不存在' });
            try {
              await openLocalPath(found.abs);
              return sendJson(res, 200, { ok: true, name: found.base });
            } catch (e) {
              return sendJson(res, 500, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          return sendJson(res, 404, { error: 'not found' });
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
