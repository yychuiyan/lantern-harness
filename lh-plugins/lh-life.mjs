/**
 * 人生管理（空间级）：六张关联表，一个插件开关。
 *
 * 六张表落在 `<空间>/<实体目录>/<实体目录>.json`（可进侧栏分组）；目录只在首次写入时创建。
 * 计划类型 / 年度周期 / 人生周期是共用目录配置，落在 `<空间>/.lantern/config/life/`，不单独建内容文件夹。
 * 进度 / 待办数量 / 周期天数等派生值不落库，由前端根据关联计算。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot, spaceConfigFile } from '../builtin/session/space-layout.mjs';

const PREFIX = '/__tb_life';
const VERSION = 1;

/** 目录配置在空间配置下的子目录 */
const LIFE_CONFIG_DIR = 'life';

export const LIFE_ENTITY_META = {
  krTodos: { dir: 'KR待办', file: 'KR待办.json', idPrefix: 'kt' },
  krTasks: { dir: 'KR任务', file: 'KR任务.json', idPrefix: 'kr' },
  objectives: { dir: 'Objective目标', file: 'Objective目标.json', idPrefix: 'ob' },
  reviews: { dir: 'OKR复盘', file: 'OKR复盘.json', idPrefix: 'rv' },
  yearPlans: { dir: '年度计划', file: '年度计划.json', idPrefix: 'yp' },
  lifeStages: { dir: '人生阶段', file: '人生阶段.json', idPrefix: 'ls' },
  planTypes: {
    storage: 'config',
    file: '计划类型.json',
    idPrefix: 'pt',
    legacyDir: '计划类型',
  },
  yearCycles: {
    storage: 'config',
    file: '年度周期.json',
    idPrefix: 'yc',
    legacyDir: '年度周期',
  },
  lifeCycles: {
    storage: 'config',
    file: '人生周期.json',
    idPrefix: 'lc',
  },
};

/** 侧栏 / 内容根目录名（不含 config 目录实体）；含旧版内容目录名以便跳过当分组 */
export const LIFE_DIR_NAMES = [
  ...Object.values(LIFE_ENTITY_META)
    .filter((m) => m.storage !== 'config')
    .map((m) => m.dir),
  ...Object.values(LIFE_ENTITY_META)
    .filter((m) => m.storage === 'config' && m.legacyDir)
    .map((m) => m.legacyDir),
];
export const LIFE_ENTITIES = Object.keys(LIFE_ENTITY_META);

/** KR 待办状态 */
export const KR_TODO_STATUSES = ['pending', 'in_progress', 'overdue', 'stalled', 'done', 'closed'];
/** KR 任务状态 */
export const KR_TASK_STATUSES = ['pool', 'in_progress', 'incomplete', 'done', 'closed'];
/** 年度计划状态 */
export const YEAR_PLAN_STATUSES = ['in_progress', 'incomplete', 'done'];
/** 重要紧急程度（与待办/任务同文案键） */
export const LIFE_PRIORITIES = ['urgent_important', 'urgent', 'important', 'normal', ''];
/** 旧版固定枚举 → 种子 id（读盘迁移） */
export const LEGACY_PLAN_TYPE_IDS = {
  learning: 'pt_learning',
  work: 'pt_work',
  family: 'pt_family',
  side: 'pt_side',
};
/** @deprecated 仅兼容旧数据；新数据以 planTypes 目录为准 */
export const PLAN_TYPES = ['learning', 'work', 'family', 'side', ''];
/** 季度 */
export const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4', ''];

const DEFAULT_PLAN_TYPES = [
  { id: 'pt_learning', name: '学习成长' },
  { id: 'pt_work', name: '工作管理' },
  { id: 'pt_family', name: '家庭生活' },
  { id: 'pt_side', name: '副业赚钱' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function lifeEntityPath(spaceDir, entity) {
  const meta = LIFE_ENTITY_META[entity];
  if (!meta) throw badRequest(`未知实体：${entity}`);
  if (meta.storage === 'config') {
    return spaceConfigFile(spaceDir, LIFE_CONFIG_DIR, meta.file);
  }
  const dir = resolveContentRoot(spaceDir, meta.dir).abs;
  return path.join(dir, meta.file);
}

/** 旧版内容目录路径（空间根或侧栏分组内）：`<…>/计划类型/计划类型.json` */
export function lifeLegacyEntityPath(spaceDir, entity) {
  const meta = LIFE_ENTITY_META[entity];
  if (!meta?.legacyDir) return null;
  const dir = resolveContentRoot(spaceDir, meta.legacyDir).abs;
  return path.join(dir, meta.file);
}

export function lifeStorePaths(spaceDir) {
  const out = {};
  for (const entity of LIFE_ENTITIES) out[entity] = lifeEntityPath(spaceDir, entity);
  return out;
}

function parseEntityPayload(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
  return items;
}

/** 删掉旧版内容文件；目录空了（或只剩 .DS_Store）一并收掉 */
function removeLegacyEntityFile(fp) {
  if (!fp || !fs.existsSync(fp)) return;
  try {
    fs.unlinkSync(fp);
  } catch {
    return;
  }
  const dir = path.dirname(fp);
  try {
    const left = fs.readdirSync(dir).filter((n) => n !== '.DS_Store');
    if (left.length === 0) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }
  } catch {
    // 忽略
  }
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

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function clampProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function idList(raw, known) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const id = text(x, 64);
    if (!id || seen.has(id)) continue;
    if (known && !known.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function emptyStore() {
  return {
    version: VERSION,
    krTodos: [],
    krTasks: [],
    objectives: [],
    reviews: [],
    yearPlans: [],
    lifeStages: [],
    planTypes: [],
    yearCycles: [],
    lifeCycles: [],
  };
}

function normalizePlanType(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 40);
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id: text(raw.id, 64) || newId('pt'),
    name,
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeYearCycle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 40);
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id: text(raw.id, 64) || newId('yc'),
    name,
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeLifeCycle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 60);
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id: text(raw.id, 64) || newId('lc'),
    name,
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

/** 把旧枚举键或已有 id 归一成目录 id */
function resolvePlanTypeId(raw, planTypeIds) {
  const s = text(raw, 64);
  if (!s) return '';
  if (planTypeIds.has(s)) return s;
  const mapped = LEGACY_PLAN_TYPE_IDS[s];
  if (mapped && planTypeIds.has(mapped)) return mapped;
  return '';
}

/** 已有 id / 同名旧文案 → 年度周期目录 id */
function resolveYearCycleId(raw, yearCycles) {
  const s = text(raw, 40);
  if (!s) return '';
  if (yearCycles.some((x) => x.id === s)) return s;
  const byName = yearCycles.find((x) => x.name === s);
  return byName ? byName.id : '';
}

/** 已有 id / 同名旧文案（含旧 ageRange）→ 人生周期目录 id */
function resolveLifeCycleId(raw, lifeCycles) {
  const s = text(raw, 60);
  if (!s) return '';
  if (lifeCycles.some((x) => x.id === s)) return s;
  const byName = lifeCycles.find((x) => x.name === s);
  return byName ? byName.id : '';
}

function normalizeKrTodo(raw, krTaskIds) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  const krTaskId = text(raw.krTaskId, 64);
  return {
    id: text(raw.id, 64) || newId('kt'),
    title,
    status: oneOf(raw.status, KR_TODO_STATUSES, 'pending'),
    krTaskId: krTaskIds.has(krTaskId) ? krTaskId : '',
    startDate: dateOrEmpty(raw.startDate),
    dueDate: dateOrEmpty(raw.dueDate),
    note: text(raw.note),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeKrTask(raw, objectiveIds, planTypeIds) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  const objectiveId = text(raw.objectiveId, 64);
  return {
    id: text(raw.id, 64) || newId('kr'),
    title,
    status: oneOf(raw.status, KR_TASK_STATUSES, 'pool'),
    priority: oneOf(raw.priority, LIFE_PRIORITIES, ''),
    planType: resolvePlanTypeId(raw.planType, planTypeIds),
    objectiveId: objectiveIds.has(objectiveId) ? objectiveId : '',
    aiComment: text(raw.aiComment),
    note: text(raw.note),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeObjective(raw, yearCycles, yearPlanIds) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  const yearPlanId = text(raw.yearPlanId, 64);
  return {
    id: text(raw.id, 64) || newId('ob'),
    title,
    yearCycle: resolveYearCycleId(raw.yearCycle, yearCycles),
    quarter: oneOf(raw.quarter, QUARTERS, ''),
    yearPlanId: yearPlanIds && yearPlanIds.has(yearPlanId) ? yearPlanId : '',
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

/**
 * Objective.yearPlanId ↔ YearPlan.objectiveIds 双向对齐。
 * 读取时：旧数据仅有 objectiveIds 的，回填 yearPlanId；再按 yearPlanId 重建列表。
 */
function syncObjectiveYearPlanLinks(objectives, yearPlans) {
  const planById = new Map(yearPlans.map((p) => [p.id, p]));
  for (const plan of yearPlans) {
    for (const oid of Array.isArray(plan.objectiveIds) ? plan.objectiveIds : []) {
      const o = objectives.find((x) => x.id === oid);
      if (o && !o.yearPlanId) o.yearPlanId = plan.id;
    }
  }
  for (const o of objectives) {
    if (o.yearPlanId && !planById.has(o.yearPlanId)) o.yearPlanId = '';
  }
  for (const plan of yearPlans) {
    plan.objectiveIds = objectives.filter((o) => o.yearPlanId === plan.id).map((o) => o.id);
  }
}

/** 把目标挂到某年度计划（空则解绑）；同步各计划的 objectiveIds，可选对齐年度周期 */
function assignObjectiveYearPlan(store, objectiveId, yearPlanId) {
  const planIds = new Set(store.yearPlans.map((p) => p.id));
  const nextPlanId = yearPlanId && planIds.has(yearPlanId) ? yearPlanId : '';
  const obj = store.objectives.find((x) => x.id === objectiveId);
  if (!obj) return false;
  obj.yearPlanId = nextPlanId;
  if (nextPlanId) {
    const plan = store.yearPlans.find((p) => p.id === nextPlanId);
    if (plan?.yearCycle) obj.yearCycle = plan.yearCycle;
  }
  syncObjectiveYearPlanLinks(store.objectives, store.yearPlans);
  return true;
}

/** 年度计划改 objectiveIds 时，回写各 Objective.yearPlanId */
function assignYearPlanObjectives(store, planId, objectiveIds) {
  const allowed = new Set(store.objectives.map((o) => o.id));
  const next = (Array.isArray(objectiveIds) ? objectiveIds : [])
    .map((id) => text(id, 64))
    .filter((id) => allowed.has(id));
  const nextSet = new Set(next);
  for (const o of store.objectives) {
    if (o.yearPlanId === planId && !nextSet.has(o.id)) o.yearPlanId = '';
    else if (nextSet.has(o.id)) o.yearPlanId = planId;
  }
  const plan = store.yearPlans.find((p) => p.id === planId);
  if (plan?.yearCycle) {
    for (const o of store.objectives) {
      if (nextSet.has(o.id) && !o.yearCycle) o.yearCycle = plan.yearCycle;
    }
  }
  syncObjectiveYearPlanLinks(store.objectives, store.yearPlans);
}

function normalizeReview(raw, objectiveIds) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  const objectiveId = text(raw.objectiveId, 64);
  const scoreRaw = Number(raw.score);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, scoreRaw)) : 0;
  return {
    id: text(raw.id, 64) || newId('rv'),
    title,
    objectiveId: objectiveIds.has(objectiveId) ? objectiveId : '',
    score,
    experience: text(raw.experience, 8000),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeYearPlan(raw, objectiveIds, planTypeIds, yearCycles) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  return {
    id: text(raw.id, 64) || newId('yp'),
    title,
    yearCycle: resolveYearCycleId(raw.yearCycle, yearCycles),
    planType: resolvePlanTypeId(raw.planType, planTypeIds),
    status: oneOf(raw.status, YEAR_PLAN_STATUSES, 'in_progress'),
    objectiveIds: idList(raw.objectiveIds, objectiveIds),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeLifeStage(raw, planTypeIds, lifeCycles) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const now = new Date().toISOString();
  // 旧版 ageRange 自由文本并入人生周期目录
  const cycleRaw = raw.lifeCycle || raw.ageRange;
  return {
    id: text(raw.id, 64) || newId('ls'),
    title,
    lifeCycle: resolveLifeCycleId(cycleRaw, lifeCycles),
    planType: resolvePlanTypeId(raw.planType, planTypeIds),
    progress: clampProgress(raw.progress),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function seedPlanTypes(rawList) {
  const list = [];
  const seen = new Set();
  for (const item of Array.isArray(rawList) ? rawList : []) {
    const n = normalizePlanType(item);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    list.push(n);
  }
  if (list.length > 0) return list;
  const now = new Date().toISOString();
  return DEFAULT_PLAN_TYPES.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * 年度周期目录：保留已有条目；把年度计划 / Objective 上的旧文案吸收进来；
 * 全空时种子「当前年」。
 */
function seedYearCycles(rawList, legacyNames) {
  const list = [];
  const seenIds = new Set();
  const seenNames = new Set();
  const now = new Date().toISOString();

  for (const item of Array.isArray(rawList) ? rawList : []) {
    const n = normalizeYearCycle(item);
    if (!n || seenIds.has(n.id)) continue;
    seenIds.add(n.id);
    seenNames.add(n.name);
    list.push(n);
  }

  for (const rawName of legacyNames) {
    const name = text(rawName, 40);
    // 已是目录 id / 已有同名 → 不重复建
    if (!name || seenNames.has(name) || seenIds.has(name)) continue;
    const id = newId('yc');
    list.push({ id, name, createdAt: now, updatedAt: now });
    seenIds.add(id);
    seenNames.add(name);
  }

  if (list.length > 0) return list;
  const y = new Date().getFullYear();
  return [{ id: `yc_${y}`, name: `${y}年`, createdAt: now, updatedAt: now }];
}

function collectLegacyYearCycleNames(raw) {
  const names = [];
  for (const list of [raw?.yearPlans, raw?.objectives]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const s = text(item?.yearCycle, 40);
      if (s) names.push(s);
    }
  }
  return names;
}

/**
 * 人生周期目录：保留已有；把人生阶段上的旧 ageRange / 文案吸收进来；可为空。
 */
function seedLifeCycles(rawList, legacyNames) {
  const list = [];
  const seenIds = new Set();
  const seenNames = new Set();
  const now = new Date().toISOString();

  for (const item of Array.isArray(rawList) ? rawList : []) {
    const n = normalizeLifeCycle(item);
    if (!n || seenIds.has(n.id)) continue;
    seenIds.add(n.id);
    seenNames.add(n.name);
    list.push(n);
  }

  for (const rawName of legacyNames) {
    const name = text(rawName, 60);
    if (!name || seenNames.has(name) || seenIds.has(name)) continue;
    const id = newId('lc');
    list.push({ id, name, createdAt: now, updatedAt: now });
    seenIds.add(id);
    seenNames.add(name);
  }

  return list;
}

function collectLegacyLifeCycleNames(raw) {
  const names = [];
  const existingIds = new Set(
    (Array.isArray(raw?.lifeCycles) ? raw.lifeCycles : [])
      .map((x) => text(x?.id, 64))
      .filter(Boolean),
  );
  if (!Array.isArray(raw?.lifeStages)) return names;
  for (const item of raw.lifeStages) {
    const fromAge = text(item?.ageRange, 60);
    if (fromAge) names.push(fromAge);
    const fromCycle = text(item?.lifeCycle, 60);
    // 已是目录 id 的不要当名称种子；自由文本则吸收
    if (fromCycle && !existingIds.has(fromCycle)) names.push(fromCycle);
  }
  return names;
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object') return store;

  const planTypes = seedPlanTypes(raw.planTypes);
  const planTypeIds = new Set(planTypes.map((x) => x.id));

  const yearCycles = seedYearCycles(raw.yearCycles, collectLegacyYearCycleNames(raw));
  const lifeCycles = seedLifeCycles(raw.lifeCycles, collectLegacyLifeCycleNames(raw));

  // 先收年度计划 id，再规范 Objective.yearPlanId
  const yearPlanIdHints = new Set();
  for (const item of Array.isArray(raw.yearPlans) ? raw.yearPlans : []) {
    const id = text(item?.id, 64);
    if (id) yearPlanIdHints.add(id);
  }

  const objectives = [];
  for (const item of Array.isArray(raw.objectives) ? raw.objectives : []) {
    const n = normalizeObjective(item, yearCycles, yearPlanIdHints);
    if (n) objectives.push(n);
  }
  const objectiveIds = new Set(objectives.map((x) => x.id));

  const krTasks = [];
  for (const item of Array.isArray(raw.krTasks) ? raw.krTasks : []) {
    const n = normalizeKrTask(item, objectiveIds, planTypeIds);
    if (n) krTasks.push(n);
  }
  const krTaskIds = new Set(krTasks.map((x) => x.id));

  const krTodos = [];
  for (const item of Array.isArray(raw.krTodos) ? raw.krTodos : []) {
    const n = normalizeKrTodo(item, krTaskIds);
    if (n) krTodos.push(n);
  }

  const reviews = [];
  for (const item of Array.isArray(raw.reviews) ? raw.reviews : []) {
    const n = normalizeReview(item, objectiveIds);
    if (n) reviews.push(n);
  }

  const yearPlans = [];
  for (const item of Array.isArray(raw.yearPlans) ? raw.yearPlans : []) {
    const n = normalizeYearPlan(item, objectiveIds, planTypeIds, yearCycles);
    if (n) yearPlans.push(n);
  }

  // 旧 objectiveIds / 新 yearPlanId 对齐
  syncObjectiveYearPlanLinks(objectives, yearPlans);

  const lifeStages = [];
  for (const item of Array.isArray(raw.lifeStages) ? raw.lifeStages : []) {
    const n = normalizeLifeStage(item, planTypeIds, lifeCycles);
    if (n) lifeStages.push(n);
  }

  store.planTypes = planTypes;
  store.yearCycles = yearCycles;
  store.lifeCycles = lifeCycles;
  store.objectives = objectives;
  store.krTasks = krTasks;
  store.krTodos = krTodos;
  store.reviews = reviews;
  store.yearPlans = yearPlans;
  store.lifeStages = lifeStages;
  return store;
}

function readEntityFile(root, entity) {
  const fp = lifeEntityPath(root, entity);
  const legacyFp = lifeLegacyEntityPath(root, entity);

  if (fs.existsSync(fp)) {
    // 新路径已有时顺手清掉残留的旧内容目录
    if (legacyFp) removeLegacyEntityFile(legacyFp);
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      return { exists: true, items: parseEntityPayload(raw) };
    } catch {
      return { exists: true, items: [] };
    }
  }

  // 旧版内容目录 → `.lantern/config/life/`（只迁一次）
  if (legacyFp && fs.existsSync(legacyFp)) {
    let items = [];
    try {
      items = parseEntityPayload(JSON.parse(fs.readFileSync(legacyFp, 'utf8')));
    } catch {
      items = [];
    }
    writeEntityFile(root, entity, items);
    removeLegacyEntityFile(legacyFp);
    return { exists: true, items };
  }

  return { exists: false, items: [] };
}

function writeEntityFile(root, entity, items) {
  const fp = lifeEntityPath(root, entity);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const payload = { version: VERSION, items };
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

function readStore(root) {
  const raw = {};
  const existed = {};
  for (const entity of LIFE_ENTITIES) {
    const file = readEntityFile(root, entity);
    raw[entity] = file.items;
    existed[entity] = file.exists;
  }
  const store = normalizeStore(raw);
  // 首次无「计划类型」文件时落盘种子，避免每次 GET 都像新建
  if (!existed.planTypes && store.planTypes.length > 0) {
    writeEntityFile(root, 'planTypes', store.planTypes);
  }
  // 首次无「年度周期」：落盘种子 / 从旧文案吸收的目录；顺手把已映射成 id 的记录写回
  if (!existed.yearCycles && store.yearCycles.length > 0) {
    writeEntityFile(root, 'yearCycles', store.yearCycles);
    if (store.yearPlans.length) writeEntityFile(root, 'yearPlans', store.yearPlans);
    if (store.objectives.length) writeEntityFile(root, 'objectives', store.objectives);
  }
  // 首次无「人生周期」：吸收旧 ageRange 文案；写回已映射的人生阶段
  if (!existed.lifeCycles && store.lifeCycles.length > 0) {
    writeEntityFile(root, 'lifeCycles', store.lifeCycles);
    if (store.lifeStages.length) writeEntityFile(root, 'lifeStages', store.lifeStages);
  }
  return store;
}

function writeStoreEntities(root, store, entities) {
  for (const entity of entities) {
    if (!LIFE_ENTITY_META[entity]) continue;
    const exists = fs.existsSync(lifeEntityPath(root, entity));
    const items = store[entity] ?? [];
    if (!exists && items.length === 0) continue;
    writeEntityFile(root, entity, items);
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function validateTitle(entity, patch) {
  if (entity === 'planTypes' || entity === 'yearCycles' || entity === 'lifeCycles') {
    const max = entity === 'lifeCycles' ? 60 : 40;
    if ('name' in patch && !text(patch.name, max)) {
      throw badRequest(
        entity === 'yearCycles'
          ? '年度周期不能为空'
          : entity === 'lifeCycles'
            ? '人生周期不能为空'
            : '类型名称不能为空',
      );
    }
    return;
  }
  if ('title' in patch && !text(patch.title, 200)) {
    throw badRequest('标题不能为空');
  }
}

function buildItem(store, entity, raw) {
  const objectiveIds = new Set(store.objectives.map((x) => x.id));
  const krTaskIds = new Set(store.krTasks.map((x) => x.id));
  const planTypeIds = new Set(store.planTypes.map((x) => x.id));
  const today = todayIso();

  if (entity === 'planTypes') {
    const name = text(raw?.name, 40);
    if (!name) throw badRequest('类型名称不能为空');
    const dup = store.planTypes.some((x) => x.name === name);
    if (dup) throw badRequest('已有同名计划类型');
    const item = normalizePlanType({ ...raw, name });
    if (!item) throw badRequest('类型名称不能为空');
    return item;
  }

  if (entity === 'yearCycles') {
    const name = text(raw?.name, 40);
    if (!name) throw badRequest('年度周期不能为空');
    const dup = store.yearCycles.some((x) => x.name === name);
    if (dup) throw badRequest('已有同名年度周期');
    const item = normalizeYearCycle({ ...raw, name });
    if (!item) throw badRequest('年度周期不能为空');
    return item;
  }

  if (entity === 'lifeCycles') {
    const name = text(raw?.name, 60);
    if (!name) throw badRequest('人生周期不能为空');
    const dup = store.lifeCycles.some((x) => x.name === name);
    if (dup) throw badRequest('已有同名人生周期');
    const item = normalizeLifeCycle({ ...raw, name });
    if (!item) throw badRequest('人生周期不能为空');
    return item;
  }

  if (entity === 'krTodos') {
    const item = normalizeKrTodo(
      {
        ...raw,
        startDate: raw?.startDate ?? today,
        dueDate: raw?.dueDate ?? today,
        status: raw?.status ?? 'pending',
      },
      krTaskIds,
    );
    if (!item) throw badRequest('待办描述不能为空');
    return item;
  }
  if (entity === 'krTasks') {
    const item = normalizeKrTask(raw, objectiveIds, planTypeIds);
    if (!item) throw badRequest('任务描述不能为空');
    return item;
  }
  if (entity === 'objectives') {
    const yearPlanIds = new Set(store.yearPlans.map((x) => x.id));
    const item = normalizeObjective(raw, store.yearCycles, yearPlanIds);
    if (!item) throw badRequest('目标描述不能为空');
    if (item.yearPlanId) {
      const plan = store.yearPlans.find((p) => p.id === item.yearPlanId);
      if (plan?.yearCycle && !item.yearCycle) item.yearCycle = plan.yearCycle;
    }
    return item;
  }
  if (entity === 'reviews') {
    const item = normalizeReview(
      {
        ...raw,
        experience: (() => {
          const exp = typeof raw?.experience === 'string' ? raw.experience.trim() : '';
          return exp
            ? raw.experience
            : '1) 有什么是做得好的\n2) 有什么是做得不够好的\n3) 总结如何下次做得更好';
        })(),
      },
      objectiveIds,
    );
    if (!item) throw badRequest('目标复盘摘要不能为空');
    return item;
  }
  if (entity === 'yearPlans') {
    const item = normalizeYearPlan(raw, objectiveIds, planTypeIds, store.yearCycles);
    if (!item) throw badRequest('年度计划标题不能为空');
    return item;
  }
  if (entity === 'lifeStages') {
    const item = normalizeLifeStage(raw, planTypeIds, store.lifeCycles);
    if (!item) throw badRequest('人生阶段标题不能为空');
    return item;
  }
  throw badRequest(`未知实体：${entity}`);
}

function normalizePatch(store, entity, body, base) {
  const objectiveIds = new Set(store.objectives.map((x) => x.id));
  const krTaskIds = new Set(store.krTasks.map((x) => x.id));
  const patch = {};

  if ('title' in body) patch.title = text(body.title, 200);
  if ('lifeCycle' in body) {
    patch.lifeCycle = resolveLifeCycleId(body.lifeCycle, store.lifeCycles);
  }
  if ('note' in body) patch.note = text(body.note);
  if ('aiComment' in body) patch.aiComment = text(body.aiComment);
  if ('experience' in body) patch.experience = text(body.experience, 8000);
  if ('yearCycle' in body) {
    patch.yearCycle = resolveYearCycleId(body.yearCycle, store.yearCycles);
  }
  if ('startDate' in body) patch.startDate = dateOrEmpty(body.startDate);
  if ('dueDate' in body) patch.dueDate = dateOrEmpty(body.dueDate);

  if ('status' in body) {
    if (entity === 'krTodos') patch.status = oneOf(body.status, KR_TODO_STATUSES, base.status);
    else if (entity === 'krTasks') patch.status = oneOf(body.status, KR_TASK_STATUSES, base.status);
    else if (entity === 'yearPlans')
      patch.status = oneOf(body.status, YEAR_PLAN_STATUSES, base.status);
  }
  if ('priority' in body)
    patch.priority = oneOf(body.priority, LIFE_PRIORITIES, base.priority ?? '');
  if ('planType' in body) {
    const planTypeIds = new Set(store.planTypes.map((x) => x.id));
    patch.planType = resolvePlanTypeId(body.planType, planTypeIds);
  }
  if ('name' in body && entity === 'planTypes') {
    const name = text(body.name, 40);
    if (!name) throw badRequest('类型名称不能为空');
    const dup = store.planTypes.some((x) => x.name === name && x.id !== base.id);
    if (dup) throw badRequest('已有同名计划类型');
    patch.name = name;
  }
  if ('name' in body && entity === 'yearCycles') {
    const name = text(body.name, 40);
    if (!name) throw badRequest('年度周期不能为空');
    const dup = store.yearCycles.some((x) => x.name === name && x.id !== base.id);
    if (dup) throw badRequest('已有同名年度周期');
    patch.name = name;
  }
  if ('name' in body && entity === 'lifeCycles') {
    const name = text(body.name, 60);
    if (!name) throw badRequest('人生周期不能为空');
    const dup = store.lifeCycles.some((x) => x.name === name && x.id !== base.id);
    if (dup) throw badRequest('已有同名人生周期');
    patch.name = name;
  }
  if ('quarter' in body) patch.quarter = oneOf(body.quarter, QUARTERS, base.quarter ?? '');
  if ('progress' in body) patch.progress = clampProgress(body.progress);
  if ('score' in body) {
    const n = Number(body.score);
    patch.score = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : (base.score ?? 0);
  }
  if ('krTaskId' in body) {
    const id = text(body.krTaskId, 64);
    patch.krTaskId = !id || krTaskIds.has(id) ? id : base.krTaskId;
  }
  if ('objectiveId' in body) {
    const id = text(body.objectiveId, 64);
    patch.objectiveId = !id || objectiveIds.has(id) ? id : base.objectiveId;
  }
  if ('objectiveIds' in body) {
    patch.objectiveIds = idList(body.objectiveIds, objectiveIds);
  }
  if ('yearPlanId' in body) {
    const planIds = new Set(store.yearPlans.map((x) => x.id));
    const id = text(body.yearPlanId, 64);
    patch.yearPlanId = !id || planIds.has(id) ? id : base.yearPlanId || '';
  }
  return patch;
}

/**
 * 删除时清引用 / 级联：
 * - 删 Objective → 清 KR 任务 / 复盘 / 年度计划上的 objective 引用
 * - 删 KR 任务 → 清下属待办的 krTaskId（待办保留）
 */
function applyDelete(store, entity, ids, dirty) {
  const idSet = new Set(ids);
  const before = store[entity].length;
  store[entity] = store[entity].filter((x) => !idSet.has(x.id));
  const removed = before - store[entity].length;

  if (entity === 'objectives') {
    let touchedTasks = false;
    for (const item of store.krTasks) {
      if (idSet.has(item.objectiveId)) {
        item.objectiveId = '';
        touchedTasks = true;
      }
    }
    if (touchedTasks) dirty.add('krTasks');

    let touchedReviews = false;
    for (const item of store.reviews) {
      if (idSet.has(item.objectiveId)) {
        item.objectiveId = '';
        touchedReviews = true;
      }
    }
    if (touchedReviews) dirty.add('reviews');

    let touchedPlans = false;
    for (const item of store.yearPlans) {
      const next = item.objectiveIds.filter((id) => !idSet.has(id));
      if (next.length !== item.objectiveIds.length) {
        item.objectiveIds = next;
        touchedPlans = true;
      }
    }
    if (touchedPlans) dirty.add('yearPlans');
  }

  if (entity === 'krTasks') {
    let touched = false;
    for (const item of store.krTodos) {
      if (idSet.has(item.krTaskId)) {
        item.krTaskId = '';
        touched = true;
      }
    }
    if (touched) dirty.add('krTodos');
  }

  if (entity === 'planTypes') {
    const clear = (list) => {
      let touched = false;
      for (const item of list) {
        if (idSet.has(item.planType)) {
          item.planType = '';
          touched = true;
        }
      }
      return touched;
    };
    if (clear(store.lifeStages)) dirty.add('lifeStages');
    if (clear(store.yearPlans)) dirty.add('yearPlans');
    if (clear(store.krTasks)) dirty.add('krTasks');
  }

  if (entity === 'yearCycles') {
    const clear = (list) => {
      let touched = false;
      for (const item of list) {
        if (idSet.has(item.yearCycle)) {
          item.yearCycle = '';
          touched = true;
        }
      }
      return touched;
    };
    if (clear(store.yearPlans)) dirty.add('yearPlans');
    if (clear(store.objectives)) dirty.add('objectives');
  }

  if (entity === 'lifeCycles') {
    let touched = false;
    for (const item of store.lifeStages) {
      if (idSet.has(item.lifeCycle)) {
        item.lifeCycle = '';
        touched = true;
      }
    }
    if (touched) dirty.add('lifeStages');
  }

  if (entity === 'yearPlans') {
    let touched = false;
    for (const item of store.objectives) {
      if (idSet.has(item.yearPlanId)) {
        item.yearPlanId = '';
        touched = true;
      }
    }
    if (touched) dirty.add('objectives');
  }

  return { removed, total: store[entity].length };
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhLifePlugin() {
  return {
    name: 'lh-life',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        const root = getDataRoot();

        try {
          const method = req.method || 'GET';

          if (method === 'GET' && parsed.searchParams.get('health') === '1') {
            return sendJson(res, 200, { ok: true, files: lifeStorePaths(root) });
          }

          if (method === 'GET') {
            return sendJson(res, 200, { ok: true, ...readStore(root) });
          }

          if (method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const entity = text(body.entity, 40);
            if (!LIFE_ENTITIES.includes(entity)) {
              return sendJson(res, 400, { ok: false, error: `未知实体：${entity || '(空)'}` });
            }
            const rawItems = Array.isArray(body.items) ? body.items : [body.item ?? body];
            const store = readStore(root);
            const created = [];
            const dirty = new Set([entity]);
            for (const raw of rawItems) {
              created.push(buildItem(store, entity, raw));
            }
            store[entity].push(...created);
            if (entity === 'objectives') {
              for (const item of created) {
                if (item.yearPlanId) assignObjectiveYearPlan(store, item.id, item.yearPlanId);
              }
              dirty.add('yearPlans');
            }
            if (entity === 'yearPlans') {
              for (const item of created) {
                if (item.objectiveIds?.length) {
                  assignYearPlanObjectives(store, item.id, item.objectiveIds);
                }
              }
              dirty.add('objectives');
            }
            writeStoreEntities(root, store, dirty);
            return sendJson(res, 200, {
              ok: true,
              items: created,
              total: store[entity].length,
            });
          }

          if (method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const entity = text(body.entity, 40);
            if (!LIFE_ENTITIES.includes(entity)) {
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
            store[entity][idx] = next;
            const dirty = new Set([entity]);
            if (entity === 'objectives' && 'yearPlanId' in patch) {
              assignObjectiveYearPlan(store, id, next.yearPlanId || '');
              dirty.add('yearPlans');
            } else if (entity === 'objectives' && 'yearCycle' in patch && next.yearPlanId) {
              // 只改年度周期时：若已绑年度计划的年度不一致，清空关联
              const plan = store.yearPlans.find((p) => p.id === next.yearPlanId);
              if (plan?.yearCycle && plan.yearCycle !== next.yearCycle) {
                next.yearPlanId = '';
                store[entity][idx] = next;
                assignObjectiveYearPlan(store, id, '');
                dirty.add('yearPlans');
              }
            }
            if (entity === 'yearPlans' && 'objectiveIds' in patch) {
              assignYearPlanObjectives(store, id, next.objectiveIds || []);
              dirty.add('objectives');
            }
            writeStoreEntities(root, store, dirty);
            return sendJson(res, 200, { ok: true, item: store[entity][idx] });
          }

          if (method === 'DELETE') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const entity = text(body.entity, 40);
            if (!LIFE_ENTITIES.includes(entity)) {
              return sendJson(res, 400, { ok: false, error: `未知实体：${entity || '(空)'}` });
            }
            const ids = (Array.isArray(body.ids) ? body.ids : [body.id])
              .map((x) => text(x, 64))
              .filter(Boolean);
            if (!ids.length) return sendJson(res, 400, { ok: false, error: '缺少记录 id' });
            const store = readStore(root);
            const dirty = new Set([entity]);
            const result = applyDelete(store, entity, ids, dirty);
            writeStoreEntities(root, store, dirty);
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
