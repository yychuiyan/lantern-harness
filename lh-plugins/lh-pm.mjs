/**
 * 项目管理存储（空间级）：四个插件各自的目录与数据文件。
 *
 * 数据落在 `<当前数据空间>/<插件目录>/<插件目录>.json`：跟空间走、不跟 git 走。
 * 目录只在真的有数据时创建（首次写入），跟其它插件的「按开关懒建、空目录不铺」一致；
 * 删项目这类跨实体级联会依次写回受影响的文件。
 *
 * 编号（REQ-001 / BUG-001）由服务端按 seq 递增分配，删除后不回收。
 * 所有枚举与校验都在这里做一次，前端与 AI 工具只提交白名单字段。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot } from '../builtin/session/space-layout.mjs';

const PREFIX = '/__tb_pm';
const VERSION = 1;

/** 四类实体各自的空间目录 / 数据文件 / id 前缀 */
export const PM_ENTITY_META = {
  projects: { dir: '项目列表', file: '项目列表.json', idPrefix: 'pj', hasSeq: false },
  iterations: { dir: '迭代管理', file: '迭代管理.json', idPrefix: 'it', hasSeq: false },
  requirements: { dir: '需求管理', file: '需求管理.json', idPrefix: 'rq', hasSeq: true },
  bugs: { dir: '缺陷管理', file: '缺陷管理.json', idPrefix: 'bg', hasSeq: true },
};

/** 四个固定数据目录：与导航分组同名时会被改名，避免冲突 */
export const PM_DIR_NAMES = Object.values(PM_ENTITY_META).map((m) => m.dir);

/** 旧版把四类数据放在同一个文件里，首次读取时按实体拆开 */
export const LEGACY_PM_DIR_NAME = '项目管理';
export const LEGACY_PM_STORE_FILE = '项目管理.json';

export const PROJECT_STATUSES = ['planning', 'in_progress', 'archived'];
export const ITERATION_STATUSES = ['planning', 'in_progress', 'done'];
export const REQUIREMENT_PRIORITIES = ['urgent', 'high', 'medium', 'low'];
export const REQUIREMENT_STATUSES = [
  'pending',
  'todo',
  'in_progress',
  'testing',
  'done',
  'cancelled',
];
export const BUG_SEVERITIES = ['critical', 'major', 'minor', 'trivial'];
/**
 * 缺陷状态：待确认 → 待修复 → 修复完成 → 待验证 → 验证通过 / 已取消。
 * 旧数据里的 `in_progress`（修复中）与 `closed`（已关闭）在读入时迁移，
 * 见 `normalizeBugStatus`：修复中 → 修复完成，已关闭 → 验证通过。
 */
export const BUG_STATUSES = ['pending', 'todo', 'fixed', 'verifying', 'passed', 'cancelled'];
const LEGACY_BUG_STATUS = { in_progress: 'fixed', closed: 'passed' };

/** 旧状态值转成新状态；识别不了返回空串 */
export function normalizeBugStatus(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (BUG_STATUSES.includes(v)) return v;
  return LEGACY_BUG_STATUS[v] ?? '';
}

/** 四类实体：接口里的 entity 参数 */
export const PM_ENTITIES = ['projects', 'iterations', 'requirements', 'bugs'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 某个实体的数据文件路径：只算路径，不建目录。分组即物理归档，目录可能被搬进分组文件夹 */
export function pmEntityPath(spaceDir, entity) {
  const meta = PM_ENTITY_META[entity];
  if (!meta) throw badRequest(`未知实体：${entity}`);
  const dir = resolveContentRoot(spaceDir, meta.dir).abs;
  return path.join(dir, meta.file);
}

/** 四个数据文件路径（health 探测用，不建目录） */
export function pmStorePaths(spaceDir) {
  const out = {};
  for (const entity of PM_ENTITIES) out[entity] = pmEntityPath(spaceDir, entity);
  return out;
}

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

/** 附件上传单独限流：超出上限直接断掉，不把整个请求读进内存 */
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

function readBodyLimited(req, limit = UPLOAD_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let stopped = false;
    req.on('data', (c) => {
      if (stopped) return;
      size += c.length;
      if (size > limit) {
        stopped = true;
        const err = new Error(`附件太大（上限 ${Math.round(limit / 1024 / 1024)}MB）`);
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!stopped) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function dateOrEmpty(value) {
  const s = text(value, 10);
  return DATE_RE.test(s) ? s : '';
}

function oneOf(value, allowed, fallback) {
  const s = text(value, 40);
  return allowed.includes(s) ? s : fallback;
}

function acceptanceCriteria(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const label = text(item.text, 500);
    if (!label) continue;
    out.push({ text: label, done: item.done === true });
  }
  return out;
}

function emptyStore() {
  return {
    version: VERSION,
    seq: { requirements: 0, bugs: 0 },
    projects: [],
    iterations: [],
    requirements: [],
    bugs: [],
  };
}

/** 读回来的旧数据也走一遍归一化，避免手工改坏的文件把页面拖垮 */
function normalizeStoredProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 200);
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id: text(raw.id, 64) || newId('pj'),
    name,
    description: text(raw.description),
    status: oneOf(raw.status, PROJECT_STATUSES, 'planning'),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeStoredIteration(raw, projectIds) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 200);
  if (!name) return null;
  const now = new Date().toISOString();
  const projectId = text(raw.projectId, 64);
  return {
    id: text(raw.id, 64) || newId('it'),
    projectId: projectIds.has(projectId) ? projectId : '',
    name,
    startDate: dateOrEmpty(raw.startDate),
    endDate: dateOrEmpty(raw.endDate),
    status: oneOf(raw.status, ITERATION_STATUSES, 'planning'),
    remark: text(raw.remark),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeStoredRequirement(raw, projectIds, iterationIds) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  const projectId = text(raw.projectId, 64);
  const iterationId = text(raw.iterationId, 64);
  return {
    id: text(raw.id, 64) || newId('rq'),
    autoId: text(raw.autoId, 20),
    projectId: projectIds.has(projectId) ? projectId : '',
    iterationId: iterationIds.has(iterationId) ? iterationId : '',
    title,
    priority: oneOf(raw.priority, REQUIREMENT_PRIORITIES, 'medium'),
    status: oneOf(raw.status, REQUIREMENT_STATUSES, 'pending'),
    description: text(raw.description),
    acceptanceCriteria: acceptanceCriteria(raw.acceptanceCriteria),
    githubIssue: text(raw.githubIssue, 50),
    attachment: text(raw.attachment),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeStoredBug(raw, projectIds, iterationIds, requirementIds) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  const projectId = text(raw.projectId, 64);
  const iterationId = text(raw.iterationId, 64);
  const requirementId = text(raw.requirementId, 64);
  return {
    id: text(raw.id, 64) || newId('bg'),
    autoId: text(raw.autoId, 20),
    projectId: projectIds.has(projectId) ? projectId : '',
    iterationId: iterationIds.has(iterationId) ? iterationId : '',
    requirementId: requirementIds.has(requirementId) ? requirementId : '',
    title,
    severity: oneOf(raw.severity, BUG_SEVERITIES, 'minor'),
    status: normalizeBugStatus(raw.status) || 'pending',
    reproduceSteps: text(raw.reproduceSteps),
    expectedResult: text(raw.expectedResult),
    actualResult: text(raw.actualResult),
    environment: text(raw.environment, 500),
    githubIssue: text(raw.githubIssue, 50),
    attachment: text(raw.attachment),
    remark: text(raw.remark),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

/** 最大编号 +1：删掉最后一条也不会把编号发回去 */
function maxSeq(items, prefix) {
  let max = 0;
  for (const item of items) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(item?.autoId ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function nextAutoId(store, entity) {
  const prefix = entity === 'requirements' ? 'REQ' : 'BUG';
  const key = entity;
  const fromItems = maxSeq(store[key], prefix);
  const seq = Math.max(Number(store.seq?.[key]) || 0, fromItems) + 1;
  store.seq[key] = seq;
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

function normalizeStore(raw) {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  base.projects = (Array.isArray(raw.projects) ? raw.projects : [])
    .map(normalizeStoredProject)
    .filter(Boolean);
  const projectIds = new Set(base.projects.map((x) => x.id));
  base.iterations = (Array.isArray(raw.iterations) ? raw.iterations : [])
    .map((x) => normalizeStoredIteration(x, projectIds))
    .filter(Boolean);
  const iterationIds = new Set(base.iterations.map((x) => x.id));
  base.requirements = (Array.isArray(raw.requirements) ? raw.requirements : [])
    .map((x) => normalizeStoredRequirement(x, projectIds, iterationIds))
    .filter(Boolean);
  const requirementIds = new Set(base.requirements.map((x) => x.id));
  base.bugs = (Array.isArray(raw.bugs) ? raw.bugs : [])
    .map((x) => normalizeStoredBug(x, projectIds, iterationIds, requirementIds))
    .filter(Boolean);
  // 编号可能来自旧文件：补一遍，避免出现 AutoId 为空的需求 / 缺陷。
  // seq 只增不减：即使最大编号的记录被删掉，也不能把编号发回去。
  const storedSeq = (raw && typeof raw === 'object' ? raw.seq : null) ?? {};
  base.seq.requirements = Math.max(
    maxSeq(base.requirements, 'REQ'),
    Number(storedSeq.requirements) || 0,
  );
  base.seq.bugs = Math.max(maxSeq(base.bugs, 'BUG'), Number(storedSeq.bugs) || 0);
  for (const item of base.requirements) {
    if (!item.autoId) item.autoId = nextAutoId(base, 'requirements');
  }
  for (const item of base.bugs) {
    if (!item.autoId) item.autoId = nextAutoId(base, 'bugs');
  }
  return base;
}

function readEntityFile(root, entity) {
  const fp = pmEntityPath(root, entity);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    // 兼容手写成裸数组的文件
    if (Array.isArray(raw)) return { items: raw, seq: 0, exists: true };
    if (!raw || typeof raw !== 'object') return { items: [], seq: 0, exists: true };
    return {
      items: Array.isArray(raw.items) ? raw.items : [],
      seq: Number(raw.seq) || 0,
      exists: true,
    };
  } catch {
    return { items: [], seq: 0, exists: false };
  }
}

/** 先写临时文件再 rename：中途失败也不会留下半份 JSON */
function writeEntityFile(root, entity, items, seq = 0) {
  const meta = PM_ENTITY_META[entity];
  if (!meta) throw badRequest(`未知实体：${entity}`);
  const fp = pmEntityPath(root, entity);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const payload = meta.hasSeq
    ? { version: VERSION, seq: Number(seq) || 0, items }
    : { version: VERSION, items };
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

/** 旧版单文件：`<空间>/项目管理/项目管理.json` */
function legacyStorePath(root) {
  return path.join(path.resolve(root), LEGACY_PM_DIR_NAME, LEGACY_PM_STORE_FILE);
}

/**
 * 旧版四类数据共用一个文件：第一次读到时按实体拆到各自目录，再删掉旧文件。
 * 只给「确实有数据」的实体建目录；新文件已存在的，按 id 合并而不是覆盖。
 */
function migrateLegacyStore(root) {
  const legacyPath = legacyStorePath(root);
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  } catch {
    return false;
  }
  if (!legacy || typeof legacy !== 'object') return false;

  let moved = 0;
  for (const entity of PM_ENTITIES) {
    const incoming = Array.isArray(legacy[entity]) ? legacy[entity] : [];
    const current = readEntityFile(root, entity);
    if (!incoming.length && !current.exists) continue;
    const legacySeq = Number(legacy.seq?.[entity]) || 0;
    const seen = new Set(current.items.map((x) => (x && typeof x === 'object' ? x.id : null)));
    const merged = [...current.items];
    for (const item of incoming) {
      const id = item && typeof item === 'object' ? item.id : null;
      if (id && seen.has(id)) continue;
      merged.push(item);
    }
    // 没有新记录、seq 也没变化时不用重写
    if (merged.length === current.items.length && legacySeq <= current.seq) continue;
    writeEntityFile(root, entity, merged, Math.max(current.seq, legacySeq));
    moved += merged.length - current.items.length;
  }

  // 拆完就清理旧文件；只剩空目录时一并收掉
  try {
    fs.rmSync(legacyPath, { force: true });
    fs.rmdirSync(path.dirname(legacyPath));
  } catch {
    // 目录里还有别的文件就留着
  }
  return moved > 0;
}

function readStore(root) {
  migrateLegacyStore(root);
  const raw = { seq: {}, projects: [], iterations: [], requirements: [], bugs: [] };
  for (const entity of PM_ENTITIES) {
    const file = readEntityFile(root, entity);
    raw[entity] = file.items;
    if (PM_ENTITY_META[entity].hasSeq) raw.seq[entity] = file.seq;
  }
  return normalizeStore(raw);
}

/**
 * 只写「这次真的变了」的实体。
 * 没有数据、文件也不存在的实体不铺空目录；已经存在的文件即使被清空也保留。
 */
function writeStore(root, store, entities) {
  for (const entity of entities) {
    if (!PM_ENTITY_META[entity]) continue;
    const exists = fs.existsSync(pmEntityPath(root, entity));
    const items = store[entity] ?? [];
    if (!exists && items.length === 0) continue;
    writeEntityFile(root, entity, items, store.seq?.[entity] ?? 0);
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/* ------------------------------ 缺陷附件 ------------------------------ */

const ATTACHMENT_DIR = '缺陷管理';
const ATTACHMENT_SUBDIR = '附件';
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** 附件根目录（缺陷管理）在磁盘上的实际位置：被归进分组文件夹时就在分组里 */
function attachmentBase(root) {
  return resolveContentRoot(root, ATTACHMENT_DIR).abs;
}

function attachmentDir(root) {
  return path.join(attachmentBase(root), ATTACHMENT_SUBDIR);
}

/** 只留安全字符；空名兜底为 attachment */
function safeFileName(name) {
  const base = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return base || 'attachment';
}

function saveUpload(root, raw) {
  if (!raw || typeof raw !== 'object') throw badRequest('附件格式不正确');
  const original = safeFileName(raw.name);
  const data = typeof raw.data === 'string' ? raw.data.replace(/^data:[^,]*,/, '') : '';
  if (!data) throw badRequest('附件内容为空');
  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch {
    throw badRequest('附件内容无法解码');
  }
  if (!buffer.length) throw badRequest('附件内容为空');
  if (buffer.length > UPLOAD_MAX_BYTES) {
    throw badRequest(`附件太大（上限 ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB）`);
  }
  const storeName = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${original}`;
  const dir = attachmentDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, storeName), buffer);
  const rel = path.posix.join(ATTACHMENT_DIR, ATTACHMENT_SUBDIR, storeName);
  return {
    name: original,
    size: buffer.length,
    type: typeof raw.type === 'string' ? raw.type.slice(0, 100) : '',
    url: `${PREFIX}/file?p=${encodeURIComponent(rel)}`,
  };
}

/**
 * 把地址解析回空间内的附件路径；越界或不在附件目录里返回空。
 *
 * 记录里存的是稳定相对路径（`缺陷管理/附件/xxx`），而缺陷管理目录可能被归进分组
 * （分组 = 物理归档），所以先把第一层目录名摘掉，再拼到解析出来的实际目录上。
 *
 * 注意：摘掉 `缺陷管理/` 后剩下的是 `附件/xxx`，必须拼到「缺陷管理」根上，
 * 不能再拼到「缺陷管理/附件」上，否则会变成 `附件/附件/xxx` → 404 裂图。
 */
function attachmentPath(root, url) {
  let rel = '';
  try {
    rel = new URL(String(url), 'http://127.0.0.1').searchParams.get('p') ?? '';
  } catch {
    return '';
  }
  if (!rel) return '';
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^\/+/, '');
  const prefix = `${ATTACHMENT_DIR}/`;
  const sub = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  const base = attachmentBase(root);
  const allowed = path.resolve(base, ATTACHMENT_SUBDIR);
  const target = path.resolve(base, sub);
  if (target !== allowed && !target.startsWith(`${allowed}${path.sep}`)) return '';
  return target;
}

/** 删掉不再被引用的附件文件：只动「缺陷管理/附件」下的内容 */
function pruneAttachments(root, urls) {
  for (const url of urls) {
    const target = attachmentPath(root, url);
    if (!target) continue;
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // 文件已不在或没权限：忽略，不影响主流程
    }
  }
}

function removedAttachments(before, after) {
  const keep = new Set(
    String(after ?? '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean),
  );
  return String(before ?? '')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !keep.has(x));
}

/** 当前所有需求 / 缺陷还在引用的附件地址：清理时只删没被引用的文件（excludeId 用来忽略正在编辑的那条） */
function referencedAttachments(store, excludeId = '') {
  const keep = new Set();
  for (const entity of ['requirements', 'bugs']) {
    for (const item of store[entity] ?? []) {
      if (excludeId && item.id === excludeId) continue;
      for (const url of String(item.attachment ?? '').split('\n')) {
        const s = url.trim();
        if (s) keep.add(s);
      }
    }
  }
  return keep;
}

/** GET 附件：只允许读附件目录内的文件 */
function sendAttachment(root, res, rel) {
  const target = attachmentPath(root, `${PREFIX}/file?p=${encodeURIComponent(rel)}`);
  if (!target) return sendJson(res, 400, { ok: false, error: '附件路径不合法' });
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return sendJson(res, 404, { ok: false, error: '附件不存在' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: '附件不存在' });
  const ext = path.extname(target).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'private, max-age=300');
  // 未知类型一律当下载，避免把用户上传的 html / svg 当页面渲染
  const inline = MIME_BY_EXT[ext] && ext !== '.svg';
  if (!inline) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
    );
  }
  fs.createReadStream(target).pipe(res);
}

/** 校验 projectId 存在 */
function requireProject(store, raw) {
  const projectId = text(raw?.projectId, 64);
  if (!projectId) throw badRequest('缺少所属项目');
  if (!store.projects.some((p) => p.id === projectId)) throw badRequest('所属项目不存在');
  return projectId;
}

/** 校验迭代属于该项目；空串表示不关联 */
function pickIterationId(store, projectId, raw) {
  const iterationId = text(raw?.iterationId, 64);
  if (!iterationId) return '';
  const it = store.iterations.find((x) => x.id === iterationId);
  if (!it) throw badRequest('所属迭代不存在');
  if (it.projectId !== projectId) throw badRequest('所属迭代不属于该项目');
  return iterationId;
}

function pickRequirementId(store, projectId, raw) {
  const requirementId = text(raw?.requirementId, 64);
  if (!requirementId) return '';
  const rq = store.requirements.find((x) => x.id === requirementId);
  if (!rq) throw badRequest('关联需求不存在');
  if (rq.projectId !== projectId) throw badRequest('关联需求不属于该项目');
  return requirementId;
}

function checkIterationDates(startDate, endDate) {
  if (startDate && endDate && endDate < startDate) {
    throw badRequest('迭代结束日期不能早于开始日期');
  }
}

function buildItem(store, entity, raw) {
  const now = new Date().toISOString();
  if (entity === 'projects') {
    const name = text(raw?.name, 200);
    if (!name) throw badRequest('项目名称不能为空');
    return {
      id: newId('pj'),
      name,
      description: text(raw?.description),
      status: oneOf(raw?.status, PROJECT_STATUSES, 'planning'),
      createdAt: now,
      updatedAt: now,
    };
  }
  if (entity === 'iterations') {
    const name = text(raw?.name, 200);
    if (!name) throw badRequest('迭代名称不能为空');
    const projectId = requireProject(store, raw);
    const startDate = dateOrEmpty(raw?.startDate);
    const endDate = dateOrEmpty(raw?.endDate);
    checkIterationDates(startDate, endDate);
    return {
      id: newId('it'),
      projectId,
      name,
      startDate,
      endDate,
      status: oneOf(raw?.status, ITERATION_STATUSES, 'planning'),
      remark: text(raw?.remark),
      createdAt: now,
      updatedAt: now,
    };
  }
  if (entity === 'requirements') {
    // 「需求描述」是多行文本，留足 2000 字；列表里仍会截断显示
    const title = text(raw?.title, 2000);
    if (!title) throw badRequest('需求描述不能为空');
    const projectId = requireProject(store, raw);
    return {
      id: newId('rq'),
      autoId: nextAutoId(store, 'requirements'),
      projectId,
      iterationId: pickIterationId(store, projectId, raw),
      title,
      priority: oneOf(raw?.priority, REQUIREMENT_PRIORITIES, 'medium'),
      status: oneOf(raw?.status, REQUIREMENT_STATUSES, 'pending'),
      description: text(raw?.description),
      acceptanceCriteria: acceptanceCriteria(raw?.acceptanceCriteria),
      githubIssue: text(raw?.githubIssue, 50),
      attachment: text(raw?.attachment),
      createdAt: now,
      updatedAt: now,
    };
  }
  if (entity === 'bugs') {
    const title = text(raw?.title, 200);
    if (!title) throw badRequest('缺陷标题不能为空');
    const projectId = requireProject(store, raw);
    return {
      id: newId('bg'),
      autoId: nextAutoId(store, 'bugs'),
      projectId,
      iterationId: pickIterationId(store, projectId, raw),
      requirementId: pickRequirementId(store, projectId, raw),
      title,
      severity: oneOf(raw?.severity, BUG_SEVERITIES, 'minor'),
      status: normalizeBugStatus(raw?.status) || 'pending',
      reproduceSteps: text(raw?.reproduceSteps),
      expectedResult: text(raw?.expectedResult),
      actualResult: text(raw?.actualResult),
      environment: text(raw?.environment, 500),
      githubIssue: text(raw?.githubIssue, 50),
      attachment: text(raw?.attachment),
      remark: text(raw?.remark),
      createdAt: now,
      updatedAt: now,
    };
  }
  throw badRequest(`未知实体：${entity}`);
}

function validateTitle(entity, patch) {
  const required = entity === 'projects' || entity === 'iterations' ? 'name' : 'title';
  if (required in patch && !patch[required]) {
    throw badRequest(
      entity === 'projects'
        ? '项目名称不能为空'
        : entity === 'iterations'
          ? '迭代名称不能为空'
          : entity === 'requirements'
            ? '需求描述不能为空'
            : '缺陷标题不能为空',
    );
  }
}

function normalizePatch(store, entity, raw, base) {
  const patch = {};
  if (!raw || typeof raw !== 'object') return patch;
  if (entity === 'projects') {
    if ('name' in raw) patch.name = text(raw.name, 200);
    if ('description' in raw) patch.description = text(raw.description);
    if ('status' in raw) patch.status = oneOf(raw.status, PROJECT_STATUSES, base.status);
    return patch;
  }
  if (entity === 'iterations') {
    if ('name' in raw) patch.name = text(raw.name, 200);
    if ('projectId' in raw) patch.projectId = requireProject(store, raw);
    if ('startDate' in raw) patch.startDate = dateOrEmpty(raw.startDate);
    if ('endDate' in raw) patch.endDate = dateOrEmpty(raw.endDate);
    if ('status' in raw) patch.status = oneOf(raw.status, ITERATION_STATUSES, base.status);
    if ('remark' in raw) patch.remark = text(raw.remark);
    checkIterationDates(patch.startDate ?? base.startDate, patch.endDate ?? base.endDate);
    return patch;
  }
  if (entity === 'requirements') {
    if ('title' in raw) patch.title = text(raw.title, 2000);
    const nextProject = 'projectId' in raw ? requireProject(store, raw) : base.projectId;
    if ('projectId' in raw) patch.projectId = nextProject;
    if ('iterationId' in raw) {
      patch.iterationId = pickIterationId(store, nextProject, raw);
    } else if (patch.projectId && patch.projectId !== base.projectId) {
      patch.iterationId = ''; // 换项目后旧迭代不再属于它
    }
    if ('priority' in raw) {
      patch.priority = oneOf(raw.priority, REQUIREMENT_PRIORITIES, base.priority);
    }
    if ('status' in raw) patch.status = oneOf(raw.status, REQUIREMENT_STATUSES, base.status);
    if ('description' in raw) patch.description = text(raw.description);
    if ('acceptanceCriteria' in raw) {
      patch.acceptanceCriteria = acceptanceCriteria(raw.acceptanceCriteria);
    }
    if ('githubIssue' in raw) patch.githubIssue = text(raw.githubIssue, 50);
    if ('attachment' in raw) patch.attachment = text(raw.attachment);
    return patch;
  }
  if (entity === 'bugs') {
    if ('title' in raw) patch.title = text(raw.title, 200);
    const nextProject = 'projectId' in raw ? requireProject(store, raw) : base.projectId;
    if ('projectId' in raw) patch.projectId = nextProject;
    if ('iterationId' in raw) patch.iterationId = pickIterationId(store, nextProject, raw);
    else if (patch.projectId && patch.projectId !== base.projectId) patch.iterationId = '';
    if ('requirementId' in raw) {
      patch.requirementId = pickRequirementId(store, nextProject, raw);
    } else if (patch.projectId && patch.projectId !== base.projectId) {
      patch.requirementId = '';
    }
    if ('severity' in raw) patch.severity = oneOf(raw.severity, BUG_SEVERITIES, base.severity);
    if ('status' in raw) patch.status = normalizeBugStatus(raw.status) || base.status;
    if ('reproduceSteps' in raw) patch.reproduceSteps = text(raw.reproduceSteps);
    if ('expectedResult' in raw) patch.expectedResult = text(raw.expectedResult);
    if ('actualResult' in raw) patch.actualResult = text(raw.actualResult);
    if ('environment' in raw) patch.environment = text(raw.environment, 500);
    if ('githubIssue' in raw) patch.githubIssue = text(raw.githubIssue, 50);
    if ('attachment' in raw) patch.attachment = text(raw.attachment);
    if ('remark' in raw) patch.remark = text(raw.remark);
    return patch;
  }
  throw badRequest(`未知实体：${entity}`);
}

/** 删除后的级联：删项目连带删子项，删迭代 / 需求只清空引用 */
function applyDelete(store, entity, ids, dirty) {
  const drop = new Set(ids);
  const before = store[entity].length;
  store[entity] = store[entity].filter((x) => !drop.has(x.id));
  let cascaded = 0;
  if (entity === 'projects') {
    for (const key of ['iterations', 'requirements', 'bugs']) {
      const n = store[key].length;
      store[key] = store[key].filter((x) => !drop.has(x.projectId));
      const removed = n - store[key].length;
      cascaded += removed;
      if (removed) dirty.add(key);
    }
  } else if (entity === 'iterations') {
    for (const key of ['requirements', 'bugs']) {
      let touched = false;
      for (const item of store[key]) {
        if (drop.has(item.iterationId)) {
          item.iterationId = '';
          touched = true;
        }
      }
      if (touched) dirty.add(key);
    }
  } else if (entity === 'requirements') {
    let touched = false;
    for (const item of store.bugs) {
      if (drop.has(item.requirementId)) {
        item.requirementId = '';
        touched = true;
      }
    }
    if (touched) dirty.add('bugs');
  }
  return { removed: before - store[entity].length, cascaded };
}

/**
 * 改挂项目后的引用清理：迭代换了项目，原项目下挂它的需求 / 缺陷解除关联；
 * 需求换了项目，原项目下关联它的缺陷解除关联。这样「子项必须与父项同项目」始终成立。
 */
function applyProjectMove(store, entity, id, before, after, dirty) {
  if (before.projectId === after.projectId) return 0;
  let cleared = 0;
  if (entity === 'iterations') {
    for (const key of ['requirements', 'bugs']) {
      let touched = false;
      for (const item of store[key]) {
        if (item.iterationId === id) {
          item.iterationId = '';
          touched = true;
          cleared += 1;
        }
      }
      if (touched) dirty.add(key);
    }
  } else if (entity === 'requirements') {
    let touched = false;
    for (const item of store.bugs) {
      if (item.requirementId === id) {
        item.requirementId = '';
        touched = true;
        cleared += 1;
      }
    }
    if (touched) dirty.add('bugs');
  }
  return cleared;
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhPmPlugin() {
  return {
    name: 'lh-pm',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        // 数据根惰性读取：切换数据空间后无需重启
        const root = getDataRoot();

        try {
          const method = req.method || 'GET';

          if (method === 'GET' && parsed.pathname === `${PREFIX}/file`) {
            return sendAttachment(root, res, parsed.searchParams.get('p') ?? '');
          }

          if (method === 'GET' && parsed.searchParams.get('health') === '1') {
            // 探测不算读写：只算路径，不建目录
            return sendJson(res, 200, { ok: true, files: pmStorePaths(root) });
          }

          if (method === 'GET') {
            return sendJson(res, 200, { ok: true, ...readStore(root) });
          }

          if (method === 'POST') {
            const body = JSON.parse((await readBodyLimited(req)) || '{}');
            if (Array.isArray(body.upload)) {
              const saved = body.upload.slice(0, 10).map((file) => saveUpload(root, file));
              return sendJson(res, 200, { ok: true, files: saved });
            }
            // 抽屉没保存就关掉、或点了附件上的 X：把没人引用的文件删掉
            if (Array.isArray(body.cleanup)) {
              const store = readStore(root);
              const keep = referencedAttachments(store, text(body.bugId, 64));
              const urls = body.cleanup.map((x) => text(x, 2000)).filter((x) => x && !keep.has(x));
              pruneAttachments(root, urls);
              return sendJson(res, 200, { ok: true, removed: urls.length });
            }
            const entity = text(body.entity, 40);
            if (!PM_ENTITIES.includes(entity)) {
              return sendJson(res, 400, { ok: false, error: `未知实体：${entity || '(空)'}` });
            }
            const rawItems = Array.isArray(body.items) ? body.items : [body.item ?? body];
            const store = readStore(root);
            const created = [];
            for (const raw of rawItems) {
              created.push(buildItem(store, entity, raw));
            }
            store[entity].push(...created);
            writeStore(root, store, [entity]);
            return sendJson(res, 200, {
              ok: true,
              items: created,
              total: store[entity].length,
            });
          }

          if (method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const entity = text(body.entity, 40);
            if (!PM_ENTITIES.includes(entity)) {
              return sendJson(res, 400, { ok: false, error: `未知实体：${entity || '(空)'}` });
            }
            const id = text(body.id, 64);
            if (!id) return sendJson(res, 400, { ok: false, error: '缺少记录 id' });
            const store = readStore(root);
            const idx = store[entity].findIndex((x) => x.id === id);
            if (idx < 0) return sendJson(res, 404, { ok: false, error: '记录不存在' });

            const base = store[entity][idx];
            const patch = normalizePatch(store, entity, body, base);
            validateTitle(entity, patch);
            const next = { ...base, ...patch, updatedAt: new Date().toISOString() };
            const dirty = new Set([entity]);
            applyProjectMove(store, entity, id, base, next, dirty);
            store[entity][idx] = next;
            writeStore(root, store, dirty);
            // 附件被换掉 / 移除：把不再引用的文件从磁盘清掉
            if ((entity === 'bugs' || entity === 'requirements') && 'attachment' in body) {
              pruneAttachments(root, removedAttachments(base.attachment, next.attachment));
            }
            return sendJson(res, 200, { ok: true, item: next });
          }

          if (method === 'DELETE') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const entity = text(body.entity, 40);
            if (!PM_ENTITIES.includes(entity)) {
              return sendJson(res, 400, { ok: false, error: `未知实体：${entity || '(空)'}` });
            }
            const ids = (Array.isArray(body.ids) ? body.ids : [body.id])
              .map((x) => text(x, 64))
              .filter(Boolean);
            if (!ids.length) return sendJson(res, 400, { ok: false, error: '缺少记录 id' });
            const store = readStore(root);
            const dirty = new Set([entity]);
            const attachUrls = (list) =>
              list
                .flatMap((x) => String(x.attachment ?? '').split('\n'))
                .map((x) => x.trim())
                .filter(Boolean);
            const removedFiles =
              entity === 'bugs' || entity === 'requirements'
                ? attachUrls(store[entity].filter((x) => ids.includes(x.id)))
                : entity === 'projects'
                  ? // 删项目会连带删掉它的需求与缺陷，附件也要一起收掉
                    attachUrls([
                      ...store.requirements.filter((x) => ids.includes(x.projectId)),
                      ...store.bugs.filter((x) => ids.includes(x.projectId)),
                    ])
                  : [];
            const result = applyDelete(store, entity, ids, dirty);
            writeStore(root, store, dirty);
            pruneAttachments(root, removedFiles);
            return sendJson(res, 200, { ok: true, ...result });
          }

          return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        } catch (err) {
          const status = Number(err?.statusCode) || 500;
          return sendJson(res, status, { ok: false, error: String(err?.message ?? err) });
        }
      });
    },
  };
}
