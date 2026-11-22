/**
 * 业务地图（空间级）
 *
 * 数据：`<当前数据空间>/业务地图/业务地图.json`
 * 提示词：`<当前数据空间>/提示词管理/业务地图识别提示词.md`
 *
 * 地图由多个业务系统组成。一个系统内保存功能、流程和待审核的 AI 提案；
 * 低风险新增可自动进入待发布草稿，其他提案由用户确认；人工写请求携带 revision，
 * 用于避免旧页面覆盖新地图。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createAnalysisService } from './business-map/jobs.mjs';
import { documentCatalog, hash } from './business-map/sources.mjs';
import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot } from '../builtin/session/space-layout.mjs';
import { ensurePluginPrompt, isPluginOnInSpace, readPluginPrompt } from './plugin-prompts.mjs';

const PREFIX = '/__tb_business_map';
const VERSION = 1;
const DIR_NAME = '业务地图';
const FILE_NAME = '业务地图.json';

export const BUSINESS_MAP_PROMPT_FILE = '业务地图识别提示词.md';
export const BUSINESS_MAP_PROMPT_TEMPLATE = `# 业务地图识别提示词

你是业务系统分析助手。你的任务是读取真实系统页面、需求文档与源码，整理一份可审核的业务地图草案。

## 分析顺序

1. 读取需求文档和知识条目，先建立业务目标、角色、规则与术语。
2. 只读访问系统菜单与选定页面，识别页面、按钮、表单、校验、状态变化和可执行动作。
3. 在配置的源码目录内只读查询接口、路由和业务规则，补全实现位置与落库对象。
4. 将页面动作归并为“业务功能”，将跨角色、跨系统动作串成“业务流程”。
5. 每条结论附上证据来源和置信度；不确定内容标记为待确认。

## 流程表达

- 流程按实际执行顺序纵向排列，每一步标明执行角色、参与系统、承载功能和输入输出。
- 工单系统、承办单位工作台、知识库系统、系统设置等作为参与系统或依赖系统出现。
- 知识读取、字典读取、外部系统回写等跨系统动作，挂到对应的流程步骤下。
- 异常分支必须说明触发条件、目标步骤和未连接原因。

## 安全边界

- 不执行提交、审批、删除、发送、支付等写操作。
- 不读取配置源码目录以外的文件。
- 不把页面上的内容直接视为业务事实，冲突内容必须列成待确认项。

## 输出要求

- 新增、更新、删除分别生成提案，不直接修改正式地图。
- 人工已确认字段只产生变更建议，不静默覆盖。
- 每个提案包含标题、来源、证据、影响范围和风险等级。
`;

const FUNCTION_STATUSES = ['在用', '停用', '草稿'];
const PROPOSAL_STATUSES = ['pending', 'applied', 'ignored'];
const PROPOSAL_RISKS = ['低', '中', '高'];

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求内容过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function text(value, max = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function oneOf(value, allowed, fallback) {
  const v = text(value, 40);
  return allowed.includes(v) ? v : fallback;
}

function stringList(value, maxItems = 80, maxLength = 500) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value.slice(0, maxItems)) {
    const v = text(item, maxLength);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function businessMapFilePath(spaceDir) {
  const root = resolveContentRoot(spaceDir, DIR_NAME).abs;
  return path.join(root, FILE_NAME);
}

function readStore(spaceDir) {
  const file = businessMapFilePath(spaceDir);
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return emptyStore();
  }
}

function writeStore(spaceDir, store) {
  const file = businessMapFilePath(spaceDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = {
    ...normalizeStore(store),
    revision: Math.max(1, Number(store?.revision) || 0) + 1,
    updatedAt: nowIso(),
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

function emptyStore() {
  return {
    version: VERSION,
    revision: 0,
    systems: [],
    createdAt: '',
    updatedAt: '',
  };
}

function normalizeEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title ?? raw.label, 300);
  const ref = text(raw.ref ?? raw.path ?? raw.url, 1200);
  if (!title && !ref) return null;
  return {
    id: text(raw.id, 64) || newId('ev'),
    type: oneOf(raw.type, ['page', 'doc', 'code', 'manual'], 'manual'),
    title: title || ref,
    ref,
    note: text(raw.note, 1000),
    confidence: oneOf(raw.confidence, ['high', 'medium', 'low'], 'medium'),
  };
}

function normalizeFunction(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 200);
  if (!name) return null;
  const now = nowIso();
  return {
    id: text(raw.id, 64) || newId('fn'),
    code: text(raw.code, 32) || `F-${String(index + 1).padStart(3, '0')}`,
    name,
    domain: text(raw.domain, 100) || '未归类',
    module: text(raw.module, 100) || '未归类',
    status: oneOf(raw.status, FUNCTION_STATUSES, '在用'),
    purpose: text(raw.purpose, 2000),
    roles: stringList(raw.roles ?? (raw.rolesText ? [raw.rolesText] : [])),
    entry: text(raw.entry, 1000),
    inputs: stringList(raw.inputs),
    outputs: stringList(raw.outputs),
    rules: stringList(raw.rules),
    writes: stringList(raw.writes),
    exceptions: stringList(raw.exceptions),
    implementation: stringList(raw.implementation),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map(normalizeEvidence)
      .filter(Boolean)
      .slice(0, 80),
    confidence: oneOf(raw.confidence, ['high', 'medium', 'low'], 'medium'),
    source: oneOf(raw.source, ['ai', 'manual', 'mixed'], 'manual'),
    confirmed: raw.confirmed === true,
    lockedFields: stringList(raw.lockedFields, 40, 80),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeDependency(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = text(raw.label, 500);
  const system = text(raw.system, 200);
  if (!label && !system) return null;
  return { system: system || '外部系统', label };
}

function normalizeStep(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 500);
  if (!title) return null;
  return {
    id: text(raw.id, 64) || newId('st'),
    n: Number.isFinite(Number(raw.n)) ? Math.max(1, Math.round(Number(raw.n))) : index + 1,
    title,
    role: text(raw.role, 200),
    system: text(raw.system, 200) || '工单系统',
    functionId: text(raw.functionId, 64),
    input: text(raw.input ?? raw.io, 1200),
    output: text(raw.output, 1200),
    next: text(raw.next, 100),
    branch: text(raw.branch, 1000),
    branchBroken: raw.branchBroken === true || raw.broken === true,
    manual: raw.manual === true,
    dependencies: (Array.isArray(raw.dependencies) ? raw.dependencies : [])
      .map(normalizeDependency)
      .filter(Boolean)
      .slice(0, 30),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map(normalizeEvidence)
      .filter(Boolean)
      .slice(0, 30),
  };
}

function normalizeFlow(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 300);
  if (!name) return null;
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map(normalizeStep)
    .filter(Boolean)
    .slice(0, 200)
    .map((step, i) => ({ ...step, n: i + 1 }));
  const now = nowIso();
  return {
    id: text(raw.id, 64) || newId('flow'),
    code: text(raw.code, 32) || `P${index + 1}`,
    name,
    result: text(raw.result, 1000),
    status: oneOf(
      raw.status,
      ['健康', '待补全', '草稿'],
      steps.some((s) => s.branchBroken) ? '待补全' : '健康',
    ),
    steps,
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map(normalizeEvidence)
      .filter(Boolean)
      .slice(0, 80),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

function normalizeProposal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 500);
  if (!title) return null;
  return {
    id: text(raw.id, 64) || newId('prop'),
    action: oneOf(raw.action, ['add', 'update', 'delete'], 'add'),
    targetType: oneOf(raw.targetType, ['function', 'flow'], 'function'),
    targetId: text(raw.targetId, 64),
    title,
    detail: text(raw.detail, 3000),
    source: text(raw.source, 1000),
    risk: oneOf(raw.risk, PROPOSAL_RISKS, '低'),
    confidence: oneOf(raw.confidence, ['high', 'medium', 'low'], 'medium'),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map(normalizeEvidence)
      .filter(Boolean)
      .slice(0, 30),
    payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
    status: oneOf(raw.status, PROPOSAL_STATUSES, 'pending'),
    createdAt: text(raw.createdAt, 40) || nowIso(),
    appliedAt: text(raw.appliedAt, 40),
    analysisId: text(raw.analysisId, 64),
    fingerprint: text(raw.fingerprint, 64),
  };
}

function normalizeSystem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 200);
  if (!name) return null;
  const now = nowIso();
  const functions = (Array.isArray(raw.functions) ? raw.functions : [])
    .map(normalizeFunction)
    .filter(Boolean);
  const ids = new Set(functions.map((item) => item.id));
  const flows = (Array.isArray(raw.flows) ? raw.flows : [])
    .map(normalizeFlow)
    .filter(Boolean)
    .map((flow) => ({
      ...flow,
      steps: flow.steps.map((step) => ({
        ...step,
        functionId: ids.has(step.functionId) ? step.functionId : '',
      })),
    }));
  return {
    id: text(raw.id, 64) || newId('sys'),
    name,
    description: text(raw.description, 2000),
    entryUrl: text(raw.entryUrl, 2000),
    sourceDir: text(raw.sourceDir, 2000),
    loginState: text(raw.loginState, 2000),
    docs: {
      requirements: raw.docs?.requirements !== false,
      knowledge: raw.docs?.knowledge !== false,
      scope: text(raw.docs?.scope, 500) || '当前系统关联文档',
    },
    analysisScope: text(raw.analysisScope, 1000) || '全部菜单',
    status: oneOf(raw.status, ['draft', 'published'], 'draft'),
    publishedRevision: Math.max(0, Number(raw.publishedRevision) || 0),
    lastAnalysis:
      raw.lastAnalysis && typeof raw.lastAnalysis === 'object'
        ? {
            at: text(raw.lastAnalysis.at, 40),
            status: text(raw.lastAnalysis.status, 40),
            pageCount: Math.max(0, Number(raw.lastAnalysis.pageCount) || 0),
            docCount: Math.max(0, Number(raw.lastAnalysis.docCount) || 0),
            codeFileCount: Math.max(0, Number(raw.lastAnalysis.codeFileCount) || 0),
            summary: text(raw.lastAnalysis.summary, 2000),
          }
        : null,
    functions,
    flows,
    proposals: (Array.isArray(raw.proposals) ? raw.proposals : [])
      .map(normalizeProposal)
      .filter(Boolean),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

export function normalizeBusinessMapStore(raw) {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: VERSION,
    revision: Math.max(0, Number(raw.revision) || 0),
    systems: (Array.isArray(raw.systems) ? raw.systems : []).map(normalizeSystem).filter(Boolean),
    createdAt: text(raw.createdAt, 40),
    updatedAt: text(raw.updatedAt, 40),
  };
}

function normalizeStore(raw) {
  return normalizeBusinessMapStore(raw);
}

function requireRevision(store, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null) return;
  if (Number(expectedRevision) !== store.revision) {
    const error = new Error('业务地图已被其他页面修改，请刷新后再试');
    error.statusCode = 409;
    error.code = 'revision_conflict';
    throw error;
  }
}

function markSystemDirty(system) {
  system.status = 'draft';
  system.updatedAt = nowIso();
}

function findSystem(store, id) {
  return store.systems.find((item) => item.id === id);
}

function requireSystem(store, id) {
  const system = findSystem(store, id);
  if (!system) {
    const error = new Error('业务系统不存在');
    error.statusCode = 404;
    throw error;
  }
  return system;
}

function touchStore(store) {
  const now = nowIso();
  if (!store.createdAt) store.createdAt = now;
  store.updatedAt = now;
}

function nextFunctionCode(system) {
  const used = new Set(system.functions.map((item) => item.code));
  let n = 1;
  while (used.has(`F-${String(n).padStart(3, '0')}`)) n += 1;
  return `F-${String(n).padStart(3, '0')}`;
}

function nextFlowCode(system) {
  const used = new Set(system.flows.map((item) => item.code));
  let n = 1;
  while (used.has(`P${n}`)) n += 1;
  return `P${n}`;
}

function makeFunction(system, raw) {
  const normalized = normalizeFunction(
    {
      ...raw,
      id: '',
      code: text(raw?.code, 32) || nextFunctionCode(system),
      source: raw?.source === 'ai' ? 'ai' : 'manual',
      confirmed: raw?.confirmed === true,
    },
    system.functions.length,
  );
  if (!normalized) {
    const error = new Error('功能名称不能为空');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function makeFlow(system, raw) {
  const normalized = normalizeFlow(
    {
      ...raw,
      id: '',
      code: text(raw?.code, 32) || nextFlowCode(system),
    },
    system.flows.length,
  );
  if (!normalized) {
    const error = new Error('流程名称不能为空');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function applyFunctionPatch(current, patch, manual) {
  const normalized = normalizeFunction({ ...current, ...patch, id: current.id }, 0);
  if (!normalized) throw Object.assign(new Error('功能名称不能为空'), { statusCode: 400 });
  const locked = new Set(current.lockedFields || []);
  const next = { ...current };
  const fields = [
    'name',
    'domain',
    'module',
    'status',
    'purpose',
    'roles',
    'entry',
    'inputs',
    'outputs',
    'rules',
    'writes',
    'exceptions',
    'implementation',
    'evidence',
    'confidence',
  ];
  for (const field of fields) {
    if (manual || !locked.has(field)) next[field] = normalized[field];
  }
  if (manual) {
    next.confirmed = true;
    next.source = current.source === 'ai' ? 'mixed' : 'manual';
    next.lockedFields = [...new Set([...locked, ...Object.keys(patch || {})])];
  }
  next.updatedAt = nowIso();
  return next;
}

function applyFlowPatch(current, patch) {
  const normalized = normalizeFlow({ ...current, ...patch, id: current.id }, 0);
  if (!normalized) throw Object.assign(new Error('流程名称不能为空'), { statusCode: 400 });
  return { ...normalized, id: current.id, updatedAt: nowIso() };
}

function inspectTextFiles(dir, limit = 600) {
  let count = 0;
  const examples = [];
  const stack = [path.resolve(dir)];
  while (stack.length && count < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(md|mdx|txt|json|ya?ml|ts|tsx|js|jsx|vue|java|kt|py|go|cs)$/i.test(entry.name)) {
        continue;
      }
      count += 1;
      if (examples.length < 5) examples.push(path.relative(dir, abs));
      if (count >= limit) break;
    }
  }
  return { count, examples };
}

function inspectDocSources(spaceDir) {
  const dirs = [
    resolveContentRoot(spaceDir, '需求文档库').abs,
    resolveContentRoot(spaceDir, '知识库管理').abs,
  ];
  const items = [];
  for (const dir of dirs) {
    const found = inspectTextFiles(dir, 300);
    items.push(...found.examples.map((name) => ({ dir: path.basename(dir), name })));
  }
  return { count: items.length, items: items.slice(0, 8) };
}

function demoSystem() {
  const now = nowIso();
  const functions = [
    [
      'F-001',
      '来电受理登记',
      '受理域',
      '工单受理',
      '把市民来电登记为来电记录，按需转为工单。',
      '话务员',
      '受理页 / 来电登记区',
      ['诉求要素不全不得建单'],
      ['写入来电记录与工单主表'],
    ],
    [
      'F-002',
      '诉求分类与归口判定',
      '受理域',
      '工单受理',
      '判断诉求类型与归口方向，决定直答还是建单。',
      '话务员',
      '受理页 / 分类归口区',
      ['按归口字典选择', '类型边界不清转班长复核'],
      ['写入诉求类型与归口字段'],
    ],
    [
      'F-003',
      '知识库检索与直答',
      '受理域',
      '知识支撑',
      '检索知识库并按标准口径答复市民。',
      '话务员',
      '受理页 / 知识库检索',
      ['无匹配时转建单'],
      ['写入答复记录与引用条目'],
    ],
    [
      'F-004',
      '工单派发',
      '受理域',
      '工单派发',
      '按归口与负载选择承办单位并派发。',
      '派单岗',
      '待派发工单列表',
      ['按归口字典选择承办单位'],
      ['写入工单状态与派发记录'],
    ],
    [
      'F-005',
      '工单签收',
      '办理域',
      '部门工作台',
      '承办单位确认接收工单，进入办理。',
      '承办单位经办人',
      '部门工作台 / 待办',
      ['拒收需走退回流程'],
      ['写入签收记录与工单状态'],
    ],
    [
      'F-006',
      '工单办理与结果回填',
      '办理域',
      '工单办理',
      '记录核实与办理结果，上传佐证并送审。',
      '承办单位经办人',
      '工单详情 / 办理页',
      ['办理结果必填', '佐证缺失不得送审'],
      ['写入办理记录、附件与状态'],
    ],
    [
      'F-007',
      '工单退回与申请改派',
      '办理域',
      '退回与改派',
      '说明退回理由并申请改派给其他单位。',
      '承办单位经办人、派单岗',
      '工单详情 / 退回入口',
      ['退回理由必填'],
      ['写入退回原因与改派记录'],
    ],
    [
      'F-008',
      '办理延期申请',
      '办理域',
      '时限管理',
      '提交延期理由与拟新时限，暂停计时。',
      '承办单位经办人',
      '工单 / 时限区',
      ['延期理由必填'],
      ['写入延期申请和时限状态'],
    ],
    [
      'F-009',
      '工单审核办结',
      '办理域',
      '审核办结',
      '审核办理结果与佐证，合规后办结归档。',
      '审核岗',
      '待审核列表',
      ['佐证齐全才可办结'],
      ['写入审核记录与办结状态'],
    ],
    [
      'F-010',
      '督办催办',
      '监督评价域',
      '督办管理',
      '时限预警、发起督办并登记督办结果。',
      '督办岗',
      '时限预警 / 督办单',
      ['本系统只登记督办结果'],
      ['写入督办结果与计时信息'],
    ],
    [
      'F-011',
      '办结回访与满意度评价',
      '监督评价域',
      '回访评价',
      '创建回访任务、记录满意度并完成闭环。',
      '回访岗',
      '待回访队列',
      ['三次未接通标记失联'],
      ['写入回访任务与满意度'],
    ],
    [
      'F-012',
      '不满意重办',
      '监督评价域',
      '回访评价',
      '认定不满意并创建重办工单重新派发。',
      '回访岗',
      '回访记录',
      ['不满意需有具体理由'],
      ['写入重办工单与认定依据'],
    ],
  ].map(([code, name, domain, module, purpose, role, entry, rules, writes], index) => ({
    id: `demo_fn_${index + 1}`,
    code,
    name,
    domain,
    module,
    status: '在用',
    purpose,
    roles: [role],
    entry,
    inputs: [],
    outputs: [],
    rules,
    writes,
    exceptions: [],
    implementation: [],
    evidence: [
      {
        type: index % 2 ? 'doc' : 'page',
        title: index % 2 ? '示例需求文档与知识条目' : '示例系统页面',
        confidence: index === 7 || index === 11 ? 'low' : 'medium',
      },
    ],
    confidence: index === 7 || index === 11 ? 'low' : 'medium',
    source: index === 0 || index === 3 || index === 5 ? 'mixed' : 'ai',
    confirmed: index === 0 || index === 3 || index === 5,
    lockedFields: index === 0 || index === 3 || index === 5 ? ['purpose', 'rules', 'writes'] : [],
    createdAt: now,
    updatedAt: now,
  }));
  const flowDefs = [
    [
      'P1',
      '咨询类来电直答',
      '答复完成并归档，不生成工单',
      [
        ['接听并确认诉求', '话务员', '示例系统', 'F-001'],
        ['判定咨询类型', '话务员', '示例系统', 'F-002'],
        ['检索知识库并答复', '话务员', '示例知识库', 'F-003', '无匹配 → 转 P2 建单'],
        ['答复归档、不建单', '系统', '示例系统', 'F-001'],
      ],
    ],
    [
      'P2',
      '投诉受理到派发签收',
      '工单状态为已签收，承办单位明确',
      [
        ['接听并记录诉求', '话务员', '示例系统', 'F-001'],
        ['判定类型与归口', '话务员', '示例系统', 'F-002'],
        ['建立工单', '话务员', '示例系统', 'F-001'],
        ['选择承办单位并派发', '派单岗', '示例系统', 'F-004'],
        ['确认签收', '承办单位经办人', '示例工作台', 'F-005'],
        ['告知诉求人', '话务员', '示例系统', 'F-001', '', true],
      ],
    ],
    [
      'P3',
      '承办办理到审核办结',
      '工单已办结，有办理结果与佐证',
      [
        ['领取工单', '承办单位经办人', '示例工作台', 'F-006'],
        ['调查核实诉求', '承办单位经办人', '示例工作台', 'F-006', '', true],
        ['回填办理结果', '承办单位经办人', '示例工作台', 'F-006'],
        ['提交审核', '承办单位经办人', '示例系统', 'F-006'],
        ['审核办理结果', '审核岗', '示例系统', 'F-009', '不通过 → 回第 3 步'],
        ['确认办结', '审核岗', '示例系统', 'F-009'],
      ],
    ],
    [
      'P4',
      '超期督办与延期',
      '延期获批或督办后按期办结',
      [
        ['识别临期与超期', '系统', '示例配置中心', 'F-010'],
        ['提交延期申请', '承办单位经办人', '示例系统', 'F-008'],
        ['审批延期', '督办岗', '示例系统', 'F-010'],
        ['发起督办', '督办岗', '示例系统', 'F-010'],
        ['响应督办', '承办单位经办人', '示例工作台', 'F-010', '', true],
        ['记录结果并结算计时', '督办岗', '示例系统', 'F-010'],
      ],
    ],
    [
      'P5',
      '办结回访与不满意重办',
      '满意闭环或转不满意重办',
      [
        ['生成回访任务', '系统', '示例系统', 'F-011'],
        ['电话回访', '回访岗', '示例系统', 'F-011', '', true],
        ['记录满意度', '回访岗', '示例系统', 'F-011', '不满意 → 第 4 步', false, true],
        ['认定不满意并重办', '回访岗', '示例系统', 'F-012'],
        ['派发重办工单', '派单岗', '示例系统', 'F-004'],
        ['归档满意评价', '回访岗', '示例系统', 'F-011'],
      ],
    ],
  ];
  const flows = flowDefs.map(([code, name, result, steps]) => ({
    id: `demo_flow_${code}`,
    code,
    name,
    result,
    status: code === 'P5' ? '待补全' : '健康',
    steps: steps.map(
      (
        [title, role, system, fnCode, branch = '', manual = false, branchBroken = false],
        index,
      ) => ({
        id: `demo_step_${code}_${index + 1}`,
        n: index + 1,
        title,
        role,
        system,
        functionId: functions.find((item) => item.code === fnCode)?.id || '',
        input: '',
        output: '',
        next: index === steps.length - 1 ? '结束' : String(index + 2),
        branch,
        branchBroken,
        manual,
        dependencies:
          system === '示例系统' && title.includes('归口')
            ? [{ system: '示例配置中心', label: '读取归口与派单字典' }]
            : system === '示例知识库'
              ? [{ system: '示例知识库', label: '查询知识条目' }]
              : [],
        evidence: [{ type: 'page', title: '示例系统页面', confidence: 'medium' }],
      }),
    ),
    evidence: [{ type: 'page', title: '示例系统菜单与页面', confidence: 'medium' }],
    createdAt: now,
    updatedAt: now,
  }));
  return normalizeSystem({
    id: 'demo_work_order',
    name: '示例系统',
    description: '虚构业务数据，仅用于演示功能目录、业务流程与证据维护。',
    entryUrl: 'https://example.com',
    sourceDir: '',
    loginState: '',
    status: 'draft',
    functions,
    flows,
    proposals: [],
    createdAt: now,
    updatedAt: now,
  });
}

function validateForPublish(system) {
  const items = [];
  const pending = system.proposals.filter((item) => item.status === 'pending').length;
  if (pending) {
    items.push({
      level: 'block',
      code: 'pending_proposals',
      title: `${pending} 项 AI 识别结果未审核`,
      ref: 'proposals',
    });
  }
  const noPurpose = system.functions.filter((item) => !item.purpose).length;
  if (noPurpose) {
    items.push({
      level: 'warn',
      code: 'function_purpose',
      title: `${noPurpose} 个功能缺少作用说明`,
      ref: 'functions',
    });
  }
  let brokenBranches = 0;
  let missingFunctions = 0;
  for (const flow of system.flows) {
    brokenBranches += flow.steps.filter((step) => step.branchBroken).length;
    missingFunctions += flow.steps.filter(
      (step) => !step.manual && !system.functions.some((item) => item.id === step.functionId),
    ).length;
  }
  const emptyFlows = system.flows.filter((flow) => !flow.steps.length).length;
  if (emptyFlows)
    items.push({
      level: 'block',
      code: 'empty_flows',
      title: `${emptyFlows} 条流程还没有步骤`,
      ref: 'flows',
    });
  if (brokenBranches) {
    items.push({
      level: 'block',
      code: 'broken_branch',
      title: `${brokenBranches} 个流程分支未连接`,
      ref: 'flows',
    });
  }
  if (missingFunctions) {
    items.push({
      level: 'block',
      code: 'missing_function',
      title: `${missingFunctions} 个步骤没有承载功能`,
      ref: 'flows',
    });
  }
  if (!system.functions.length) {
    items.push({
      level: 'block',
      code: 'empty_map',
      title: '业务地图还没有功能',
      ref: 'functions',
    });
  }
  if (!items.some((item) => item.level === 'block')) {
    items.push({ level: 'ok', code: 'structure', title: '功能与流程结构完整', ref: '' });
  }
  return {
    ok: !items.some((item) => item.level === 'block'),
    items,
    score: Math.max(
      40,
      100 -
        items.filter((item) => item.level === 'block').length * 18 -
        items.filter((item) => item.level === 'warn').length * 5,
    ),
  };
}

function analysisProposals(system, sources) {
  const createdAt = nowIso();
  const docCount = Number(sources?.stats?.docCount) || 0;
  const codeCount = Number(sources?.stats?.codeFileCount) || 0;
  const pageScope = text(sources?.page?.scope, 200) || system.analysisScope;
  const output = [];
  output.push({
    id: newId('prop'),
    action: 'add',
    targetType: 'function',
    targetId: '',
    title: '补充“工单附件预览”功能',
    detail: '办理页面存在附件与预览动作，当前地图只登记了结果回填。',
    source: `页面 · ${pageScope}`,
    risk: '低',
    confidence: 'medium',
    evidence: [{ type: 'page', title: '办理页 / 附件预览', confidence: 'medium' }],
    payload: {
      name: '工单附件预览',
      domain: '办理域',
      module: '工单办理',
      purpose: '在工单详情中预览图片和 PDF 佐证，避免下载后重复打开。',
      roles: ['承办单位经办人', '审核岗'],
      entry: '工单办理页 / 附件区',
      rules: ['仅允许预览当前工单附件'],
      writes: [],
      source: 'ai',
      confidence: 'medium',
    },
    status: 'pending',
    createdAt,
    appliedAt: '',
  });
  output.push({
    id: newId('prop'),
    action: 'add',
    targetType: 'function',
    targetId: '',
    title: '补充“处理时限变更记录”功能',
    detail: '详情面板存在只读变更记录，可作为独立查询能力维护。',
    source: `源码 · ${codeCount} 个文本文件`,
    risk: '低',
    confidence: 'low',
    evidence: [{ type: 'code', title: 'time-limit / history', confidence: 'low' }],
    payload: {
      name: '处理时限变更记录',
      domain: '办理域',
      module: '时限管理',
      purpose: '查看工单时限、延期和督办产生的历史变更。',
      roles: ['督办岗', '审核岗'],
      entry: '工单详情 / 时限记录',
      rules: ['变更记录只读'],
      writes: [],
      source: 'ai',
      confidence: 'low',
    },
    status: 'pending',
    createdAt,
    appliedAt: '',
  });
  const mergeCandidate = system.functions.find((item) => item.name.includes('满意度'));
  if (mergeCandidate) {
    output.push({
      id: newId('prop'),
      action: 'delete',
      targetType: 'function',
      targetId: mergeCandidate.id,
      title: '合并重复的满意度归档动作',
      detail:
        '“记录满意度”和“归档满意评价”指向同一回访页与同一落库对象，建议确认后合并，删除单独维护的功能项。',
      source: '页面动作 · 流程引用 · 源码对象',
      risk: '高',
      confidence: 'medium',
      evidence: [{ type: 'page', title: '回访结果 / 满意评价', confidence: 'medium' }],
      payload: {},
      status: 'pending',
      createdAt,
      appliedAt: '',
    });
  }
  const defer = system.functions.find((item) => item.name.includes('延期'));
  if (defer) {
    output.push({
      id: newId('prop'),
      action: 'update',
      targetType: 'function',
      targetId: defer.id,
      title: '延期申请补充审批角色',
      detail: '页面存在“延期审批”动作，原规则只记录了申请人。',
      source: docCount ? `文档 · ${docCount} 份关联资料` : '页面 · 时限区',
      risk: '中',
      confidence: 'medium',
      evidence: [{ type: 'page', title: '工单 / 延期审批', confidence: 'medium' }],
      payload: {
        roles: [...new Set([...(defer.roles || []), '督办岗'])],
        rules: [...new Set([...(defer.rules || []), '延期通过后才更新时限'])],
        source: 'ai',
      },
      status: 'pending',
      createdAt,
      appliedAt: '',
    });
  }
  output.push({
    id: newId('prop'),
    action: 'add',
    targetType: 'flow',
    targetId: '',
    title: '新增候选流程：延期审批',
    detail: '根据“申请 → 审批 → 更新时限”动作推断出候选流程。',
    source: '页面动作 · 源码路由',
    risk: '中',
    confidence: 'medium',
    evidence: [
      { type: 'page', title: '时限区' },
      { type: 'code', title: 'extend 路由' },
    ],
    payload: {
      name: '延期审批',
      result: '延期审批完成并更新工单时限',
      steps: [
        {
          title: '提交延期申请',
          role: '承办单位经办人',
          system: system.name,
          functionId: defer?.id || '',
          input: '工单',
          output: '延期申请',
          next: '2',
        },
        {
          title: '审批延期',
          role: '督办岗',
          system: system.name,
          functionId: defer?.id || '',
          input: '延期申请',
          output: '审批结果',
          next: '3',
        },
        {
          title: '更新处理时限',
          role: '系统',
          system: '系统设置',
          functionId: defer?.id || '',
          input: '审批结果',
          output: '新时限',
          next: '结束',
        },
      ],
    },
    status: 'pending',
    createdAt,
    appliedAt: '',
  });
  output.push({
    id: newId('prop'),
    action: 'update',
    targetType: 'flow',
    targetId: system.flows.find((flow) => flow.code === 'P5')?.id || '',
    title: '修复 P5 不满意分支连接',
    detail: '页面和源码都表明不满意后进入“认定并重办”，建议连接到第 4 步。',
    source: '页面 · 源码 · 当前地图',
    risk: '高',
    confidence: 'high',
    evidence: [
      { type: 'page', title: '回访记录' },
      { type: 'code', title: 'visit/rework' },
    ],
    payload: {},
    status: 'pending',
    createdAt,
    appliedAt: '',
  });
  return output.filter(
    (item) => item.targetType !== 'flow' || item.targetId || item.action === 'add',
  );
}

function applyProposal(system, proposal) {
  if (proposal.status !== 'pending') return;
  if (proposal.targetType === 'function') {
    if (proposal.action === 'add') {
      const created = makeFunction(system, {
        ...proposal.payload,
        source: 'ai',
        confidence: proposal.confidence,
        evidence: proposal.evidence,
      });
      system.functions.push(created);
    } else {
      const index = system.functions.findIndex((item) => item.id === proposal.targetId);
      if (index < 0)
        throw Object.assign(new Error(`找不到提案目标：${proposal.title}`), { statusCode: 409 });
      if (proposal.action === 'update') {
        system.functions[index] = applyFunctionPatch(
          system.functions[index],
          proposal.payload,
          false,
        );
      } else if (proposal.action === 'delete') {
        system.functions.splice(index, 1);
        for (const flow of system.flows) {
          for (const step of flow.steps) {
            if (step.functionId === proposal.targetId) step.functionId = '';
          }
        }
      }
    }
  } else {
    if (proposal.action === 'add') {
      const steps = (proposal.payload.steps || []).map((step) => ({
        ...step,
        functionId:
          step.functionId || system.functions.find((fn) => fn.name === step.functionName)?.id || '',
      }));
      system.flows.push(
        makeFlow(system, { ...proposal.payload, steps, evidence: proposal.evidence }),
      );
    } else {
      const index = system.flows.findIndex((item) => item.id === proposal.targetId);
      if (index < 0)
        throw Object.assign(new Error(`找不到提案目标：${proposal.title}`), { statusCode: 409 });
      if (proposal.action === 'update') {
        const patch = { ...proposal.payload };
        const current = system.flows[index];
        if (
          system.id === 'demo_work_order' &&
          current.code === 'P5' &&
          !Object.keys(patch).length
        ) {
          patch.steps = current.steps.map((step) =>
            step.branchBroken
              ? {
                  ...step,
                  branchBroken: false,
                  branch: step.branch.replace('（尚未连到步骤）', ''),
                }
              : step,
          );
          patch.status = '健康';
        }
        system.flows[index] = applyFlowPatch(current, patch);
      } else {
        system.flows.splice(index, 1);
      }
    }
  }
  proposal.status = 'applied';
  proposal.appliedAt = nowIso();
}

function parseSystemPayload(raw) {
  const name = text(raw?.name, 200);
  if (!name) throw Object.assign(new Error('系统名称不能为空'), { statusCode: 400 });
  return normalizeSystem({
    ...raw,
    id: '',
    name,
    functions: [],
    flows: [],
    proposals: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

export function createBusinessAnalysisService(options = {}) {
  return createAnalysisService({
    readSystem(root, id) {
      return requireSystem(readStore(root), id);
    },
    prompt(root) {
      return readPluginPrompt(BUSINESS_MAP_PROMPT_FILE, root);
    },
    commit(root, id, candidates, job) {
      const store = readStore(root),
        system = requireSystem(store, id);
      const result = { autoApplied: [], pending: 0, duplicates: 0 };
      const currentSignatures = new Set(
        system.proposals.map((item) => item.fingerprint).filter(Boolean),
      );
      for (const candidate of candidates) {
        if (currentSignatures.has(candidate.fingerprint)) {
          result.duplicates++;
          continue;
        }
        const name = text(candidate.payload?.name, 300);
        const existing = (
          candidate.targetType === 'function' ? system.functions : system.flows
        ).find((item) => item.name.replace(/\s/g, '') === name.replace(/\s/g, ''));
        let action = candidate.action,
          targetId = candidate.targetId;
        const currentTarget = (
          candidate.targetType === 'function' ? system.functions : system.flows
        ).find((item) => item.id === targetId);
        if (
          action === 'update' &&
          currentTarget &&
          Object.entries(candidate.payload).every(
            ([field, value]) => JSON.stringify(currentTarget[field]) === JSON.stringify(value),
          ) &&
          candidate.evidence.every((ref) =>
            currentTarget.evidence.some((item) => item.ref === ref.ref && item.note === ref.note),
          )
        ) {
          result.duplicates++;
          continue;
        }

        if (action === 'add' && existing) {
          const sameEvidence = candidate.evidence.every((ref) =>
            existing.evidence.some((item) => item.ref === ref.ref && item.note === ref.note),
          );
          const samePayload = Object.entries(candidate.payload).every(
            ([field, value]) => JSON.stringify(existing[field]) === JSON.stringify(value),
          );
          if (sameEvidence && samePayload) {
            result.duplicates++;
            continue;
          }
          action = 'update';
          targetId = existing.id;
        }
        const proposal = normalizeProposal({
          ...candidate,
          action,
          targetId,
          analysisId: job.id,
          fingerprint: candidate.fingerprint,
        });
        if (!proposal) continue;
        if (
          candidate.autoEligible &&
          job.config.autoDraft &&
          action === 'add' &&
          candidate.targetType === 'function'
        ) {
          const created = makeFunction(system, {
            ...candidate.payload,
            source: 'ai',
            confirmed: false,
            evidence: candidate.evidence,
            confidence: 'high',
          });
          system.functions.push(created);
          proposal.status = 'applied';
          proposal.targetId = created.id;
          proposal.appliedAt = nowIso();
          result.autoApplied.push({ id: created.id, signature: hash(JSON.stringify(created)) });
        } else result.pending++;
        currentSignatures.add(candidate.fingerprint);
        system.proposals.push(proposal);
      }
      system.lastAnalysis = {
        at: nowIso(),
        status: job.issues.length ? 'partial' : 'done',
        pageCount: job.coverage.pages,
        docCount: job.coverage.documents,
        codeFileCount: job.coverage.codeFiles,
        summary: `实际采集 ${job.coverage.pages} 个页面、${job.coverage.documents} 份文档、${job.coverage.codeFiles} 个源码文件；自动新增 ${result.autoApplied.length} 个功能，${result.pending} 项待审核。`,
      };
      markSystemDirty(system);
      writeStore(root, store);
      return result;
    },
    rollback(root, id, job) {
      const store = readStore(root),
        system = requireSystem(store, id),
        removed = [],
        skipped = [];
      for (const item of job.result.autoApplied) {
        const fn = system.functions.find((fn) => fn.id === item.id);
        if (!fn) continue;
        if (
          hash(JSON.stringify(fn)) !== item.signature ||
          system.flows.some((flow) => flow.steps.some((step) => step.functionId === fn.id))
        ) {
          skipped.push(fn.id);
          continue;
        }
        system.functions = system.functions.filter((fn) => fn.id !== item.id);
        removed.push(item.id);
        for (const proposal of system.proposals)
          if (proposal.analysisId === job.id && proposal.targetId === item.id)
            proposal.status = 'ignored';
      }
      if (removed.length) {
        markSystemDirty(system);
        writeStore(root, store);
      }
      return { removed, skipped };
    },
    ...options,
  });
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhBusinessMapPlugin(options = {}) {
  const analyses = createBusinessAnalysisService(options);
  return {
    name: 'lh-business-map',
    configureServer(server) {
      server.httpServer?.once('close', () => analyses.close());
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        const root = getDataRoot();
        try {
          const tail = parsed.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '');
          const parts = tail ? tail.split('/') : [];
          const method = req.method || 'GET';

          if (method === 'GET' && parsed.searchParams.get('health') === '1') {
            return sendJson(res, 200, {
              ok: true,
              file: businessMapFilePath(root),
              promptFile: BUSINESS_MAP_PROMPT_FILE,
            });
          }

          if (method === 'GET' && tail === 'documents')
            return sendJson(res, 200, { ok: true, documents: documentCatalog(root) });

          if (method === 'GET' && tail === 'prompt') {
            if (isPluginOnInSpace('businessMap', root)) {
              ensurePluginPrompt(BUSINESS_MAP_PROMPT_FILE, BUSINESS_MAP_PROMPT_TEMPLATE, root);
            }
            const content = readPluginPrompt(BUSINESS_MAP_PROMPT_FILE, root);
            return sendJson(res, 200, {
              ok: true,
              file: BUSINESS_MAP_PROMPT_FILE,
              exists: Boolean(content.trim()),
              content,
            });
          }

          if (method === 'POST' && tail === 'prompt/sync') {
            const body = JSON.parse((await readBody(req)) || '{}');
            if (body.enabled !== true) {
              return sendJson(res, 200, {
                ok: true,
                enabled: false,
                removed: false,
                file: BUSINESS_MAP_PROMPT_FILE,
                exists: Boolean(readPluginPrompt(BUSINESS_MAP_PROMPT_FILE, root).trim()),
              });
            }
            const out = ensurePluginPrompt(
              BUSINESS_MAP_PROMPT_FILE,
              BUSINESS_MAP_PROMPT_TEMPLATE,
              root,
            );
            return sendJson(res, 200, { ok: true, enabled: true, ...out });
          }

          if (method === 'GET' && !tail) {
            return sendJson(res, 200, { ok: true, store: readStore(root) });
          }

          if (method === 'POST' && tail === 'demo') {
            const store = readStore(root);
            requireRevision(store, Number(JSON.parse((await readBody(req)) || '{}').revision));
            const system = demoSystem();
            const existing = store.systems.findIndex((item) => item.name === system.name);
            if (existing >= 0) store.systems[existing] = system;
            else store.systems.push(system);
            touchStore(store);
            const saved = writeStore(root, store);
            return sendJson(res, 200, { ok: true, store: saved, systemId: system.id });
          }

          if (method === 'POST' && tail === 'systems') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = readStore(root);
            requireRevision(store, body.revision);
            const system = parseSystemPayload(body.system || body);
            store.systems.push(system);
            touchStore(store);
            const saved = writeStore(root, store);
            return sendJson(res, 200, { ok: true, store: saved, systemId: system.id });
          }

          if (parts[0] !== 'systems' || !parts[1]) {
            return sendJson(res, 404, { ok: false, error: '接口不存在' });
          }

          const systemId = parts[1];
          const store = readStore(root);
          const body = ['POST', 'PUT', 'DELETE'].includes(method)
            ? JSON.parse((await readBody(req)) || '{}')
            : {};
          const system = requireSystem(store, systemId);
          if (parts[2] === 'analyses') {
            const id = parts[3],
              command = parts[4];
            if (method === 'GET' && !id)
              return sendJson(res, 200, { ok: true, jobs: analyses.list(root, systemId) });
            if (method === 'GET' && id)
              return sendJson(res, 200, { ok: true, job: analyses.get(root, systemId, id) });
            if (method === 'POST' && !id) {
              requireRevision(store, body.revision);
              return sendJson(res, 202, {
                ok: true,
                job: analyses.start(root, system, body.config || {}, body.settings),
              });
            }
            if (method === 'POST' && id && command === 'cancel')
              return sendJson(res, 200, { ok: true, job: analyses.cancel(root, systemId, id) });
            if (method === 'POST' && id && command === 'retry')
              return sendJson(res, 202, {
                ok: true,
                job: analyses.retry(root, systemId, id, body.settings),
              });
            if (method === 'POST' && id && command === 'rollback')
              return sendJson(res, 200, { ok: true, job: analyses.rollback(root, systemId, id) });
            return sendJson(res, 404, { ok: false, error: '任务接口不存在' });
          }
          requireRevision(store, body.revision);

          if (method === 'PUT' && parts.length === 2) {
            const patch = body.system || body;
            const normalized = normalizeSystem({ ...system, ...patch, id: system.id });
            Object.assign(system, normalized, {
              functions: system.functions,
              flows: system.flows,
              proposals: system.proposals,
            });
            markSystemDirty(system);
            touchStore(store);
            const saved = writeStore(root, store);
            return sendJson(res, 200, { ok: true, store: saved, systemId });
          }

          if (method === 'DELETE' && parts.length === 2) {
            store.systems = store.systems.filter((item) => item.id !== systemId);
            touchStore(store);
            const saved = writeStore(root, store);
            return sendJson(res, 200, { ok: true, store: saved });
          }

          if (parts[2] === 'functions') {
            if (method === 'POST' && parts.length === 3) {
              const fn = makeFunction(system, body.function || body);
              system.functions.push(fn);
              markSystemDirty(system);
              touchStore(store);
              return sendJson(res, 200, { ok: true, store: writeStore(root, store), item: fn });
            }
            const functionId = parts[3];
            const index = system.functions.findIndex((item) => item.id === functionId);
            if (index < 0) return sendJson(res, 404, { ok: false, error: '功能不存在' });
            if (method === 'PUT') {
              system.functions[index] = applyFunctionPatch(
                system.functions[index],
                body.function || body,
                true,
              );
              markSystemDirty(system);
              touchStore(store);
              return sendJson(res, 200, {
                ok: true,
                store: writeStore(root, store),
                item: system.functions[index],
              });
            }
            if (method === 'DELETE') {
              system.functions.splice(index, 1);
              for (const flow of system.flows) {
                for (const step of flow.steps) {
                  if (step.functionId === functionId) step.functionId = '';
                }
              }
              markSystemDirty(system);
              touchStore(store);
              return sendJson(res, 200, { ok: true, store: writeStore(root, store) });
            }
          }

          if (parts[2] === 'flows') {
            if (method === 'POST' && parts.length === 3) {
              const flow = makeFlow(system, body.flow || body);
              system.flows.push(flow);
              markSystemDirty(system);
              touchStore(store);
              return sendJson(res, 200, { ok: true, store: writeStore(root, store), item: flow });
            }
            const flowId = parts[3];
            const index = system.flows.findIndex((item) => item.id === flowId);
            if (index < 0) return sendJson(res, 404, { ok: false, error: '流程不存在' });
            if (method === 'PUT') {
              system.flows[index] = applyFlowPatch(system.flows[index], body.flow || body);
              markSystemDirty(system);
              touchStore(store);
              return sendJson(res, 200, {
                ok: true,
                store: writeStore(root, store),
                item: system.flows[index],
              });
            }
            if (method === 'DELETE') {
              system.flows.splice(index, 1);
              markSystemDirty(system);
              touchStore(store);
              return sendJson(res, 200, { ok: true, store: writeStore(root, store) });
            }
          }

          if (method === 'POST' && parts[2] === 'analyze') {
            if (system.id !== 'demo_work_order') {
              return sendJson(res, 501, {
                ok: false,
                code: 'use_analysis_tasks',
                error: '请使用 /analyses 后台识别任务接口；旧 /analyze 仅保留工单示例兼容演示。',
              });
            }
            const sources = body.sources && typeof body.sources === 'object' ? body.sources : {};
            const requestedSourceDir = text(sources.code?.sourceDir, 2000);
            const requestedPageScope = text(sources.page?.scope, 1000);
            if (requestedSourceDir) system.sourceDir = requestedSourceDir;
            if (requestedPageScope) system.analysisScope = requestedPageScope;
            const docs = sources.doc?.enabled ? inspectDocSources(root) : { count: 0, items: [] };
            const code =
              sources.code?.enabled && system.sourceDir
                ? inspectTextFiles(system.sourceDir)
                : { count: 0, examples: [] };
            // 尚未接通页面采集，不把客户端传入的数量当作真实读取结果。
            const pageCount = 0;
            system.proposals = [
              ...system.proposals.filter((item) => item.status === 'pending'),
              ...analysisProposals(system, {
                page: sources.page,
                stats: { docCount: docs.count, codeFileCount: code.count },
              }),
            ];
            system.lastAnalysis = {
              at: nowIso(),
              status: 'demo',
              pageCount,
              docCount: docs.count,
              codeFileCount: code.count,
              summary: `示例演示：发现 ${docs.count} 份文档和 ${code.count} 个源码文件，生成 ${system.proposals.filter((item) => item.status === 'pending').length} 项固定示例提案，未执行页面探索或模型分析。`,
            };
            markSystemDirty(system);
            touchStore(store);
            return sendJson(res, 200, {
              ok: true,
              store: writeStore(root, store),
              system,
              sourceStats: { docs, code },
            });
          }

          if (method === 'POST' && parts[2] === 'proposals' && parts[3] === 'apply') {
            const ids = new Set(stringList(body.ids, 200, 64));
            if (!ids.size) return sendJson(res, 400, { ok: false, error: '至少选择一项提案' });
            for (const proposal of system.proposals) {
              if (ids.has(proposal.id) && proposal.status === 'pending')
                applyProposal(system, proposal);
            }
            markSystemDirty(system);
            touchStore(store);
            return sendJson(res, 200, { ok: true, store: writeStore(root, store), system });
          }

          if (method === 'POST' && parts[2] === 'proposals' && parts[3] === 'ignore') {
            const ids = new Set(stringList(body.ids, 200, 64));
            for (const proposal of system.proposals) {
              if (ids.has(proposal.id) && proposal.status === 'pending')
                proposal.status = 'ignored';
            }
            markSystemDirty(system);
            touchStore(store);
            return sendJson(res, 200, { ok: true, store: writeStore(root, store), system });
          }

          if (method === 'POST' && parts[2] === 'publish') {
            const check = validateForPublish(system);
            if (!check.ok) return sendJson(res, 409, { ok: false, error: '发布检查未通过', check });
            system.status = 'published';
            system.publishedRevision = store.revision + 1;
            system.updatedAt = nowIso();
            touchStore(store);
            const saved = writeStore(root, store);
            return sendJson(res, 200, { ok: true, store: saved, check });
          }

          return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        } catch (error) {
          return sendJson(res, Number(error?.statusCode) || 500, {
            ok: false,
            code: text(error?.code, 80),
            error: String(error?.message ?? error),
          });
        }
      });
    },
  };
}

export const BUSINESS_MAP_FILE = `${DIR_NAME}/${FILE_NAME}`;
export function businessMapPromptPath(spaceDir) {
  const dir = resolveContentRoot(spaceDir, '提示词管理').abs;
  return path.join(dir, BUSINESS_MAP_PROMPT_FILE);
}
export function validateBusinessMapSystem(system) {
  return validateForPublish(normalizeSystem(system));
}
