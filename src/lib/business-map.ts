/**
 * 业务地图：空间级系统、功能、流程与 AI 提案。
 *
 * 服务端：`lh-plugins/lh-business-map.mjs`
 * 数据：`<数据空间>/业务地图/业务地图.json`
 * 关联技能：业务地图识别（旧文件名仅作为兼容映射）
 */

export const BUSINESS_MAP_API = '/__tb_business_map';
export const BUSINESS_MAP_PROMPT_FILE = '业务地图识别提示词.md';

export type EvidenceType = 'page' | 'doc' | 'code' | 'manual';
export type Confidence = 'high' | 'medium' | 'low';
export type FunctionStatus = '在用' | '停用' | '草稿';
export type FunctionSource = 'ai' | 'manual' | 'mixed';
export type ProposalAction = 'add' | 'update' | 'delete';
export type ProposalTargetType = 'function' | 'flow';
export type ProposalStatus = 'pending' | 'applied' | 'ignored';
export type PublishLevel = 'ok' | 'warn' | 'block';
export type DirectorySource = 'menu' | 'ai' | 'manual';
export type BusinessLoginCopyMode = 'credentials' | 'configuration' | 'none';

export interface BusinessEvidence {
  id: string;
  type: EvidenceType;
  title: string;
  ref: string;
  note: string;
  confidence: Confidence;
}

export interface BusinessDirectory {
  id: string;
  parentId: string;
  name: string;
  order: number;
  source: DirectorySource;
  menuPath: string[];
  entryUrl: string;
  evidence: BusinessEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface BusinessFunction {
  id: string;
  code: string;
  name: string;
  directoryId: string;
  order: number;
  domain: string;
  module: string;
  status: FunctionStatus;
  purpose: string;
  roles: string[];
  entry: string;
  inputs: string[];
  outputs: string[];
  rules: string[];
  writes: string[];
  exceptions: string[];
  implementation: string[];
  evidence: BusinessEvidence[];
  confidence: Confidence;
  source: FunctionSource;
  confirmed: boolean;
  lockedFields: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BusinessDependency {
  system: string;
  label: string;
}

export interface BusinessFlowStep {
  id: string;
  n: number;
  title: string;
  role: string;
  system: string;
  functionId: string;
  input: string;
  output: string;
  next: string;
  branch: string;
  branchBroken: boolean;
  manual: boolean;
  dependencies: BusinessDependency[];
  evidence: BusinessEvidence[];
}

export interface BusinessFlow {
  id: string;
  code: string;
  name: string;
  result: string;
  status: '健康' | '待补全' | '草稿';
  steps: BusinessFlowStep[];
  evidence: BusinessEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface BusinessProposal {
  id: string;
  action: ProposalAction;
  targetType: ProposalTargetType;
  targetId: string;
  title: string;
  detail: string;
  source: string;
  risk: '低' | '中' | '高';
  confidence: Confidence;
  evidence: BusinessEvidence[];
  payload: Record<string, unknown>;
  status: ProposalStatus;
  createdAt: string;
  appliedAt: string;
  analysisId?: string;
  fingerprint?: string;
}

export interface BusinessAnalysis {
  at: string;
  status: string;
  pageCount: number;
  docCount: number;
  codeFileCount: number;
  summary: string;
}

export interface BusinessSystem {
  id: string;
  name: string;
  description: string;
  entryUrl: string;
  sourceDir: string;
  loginState: string;
  docs: {
    requirements: boolean;
    knowledge: boolean;
    scope: string;
  };
  analysisScope: string;
  status: 'draft' | 'published';
  publishedRevision: number;
  lastAnalysis: BusinessAnalysis | null;
  directories: BusinessDirectory[];
  functions: BusinessFunction[];
  flows: BusinessFlow[];
  proposals: BusinessProposal[];
  createdAt: string;
  updatedAt: string;
}

export interface BusinessMapStore {
  version: number;
  revision: number;
  systems: BusinessSystem[];
  createdAt: string;
  updatedAt: string;
}

export interface PublishCheckItem {
  level: PublishLevel;
  code: string;
  title: string;
  ref: string;
}

export interface PublishCheck {
  ok: boolean;
  score: number;
  items: PublishCheckItem[];
}

export interface AnalyzeSources {
  page?: {
    enabled: boolean;
    environment?: string;
    scope?: string;
    pageCount?: number;
  };
  onlineDoc?: {
    enabled: boolean;
    scope?: string;
  };
  process?: {
    enabled: boolean;
  };
  doc?: {
    enabled: boolean;
    source?: string;
    scope?: string;
  };
  material?: {
    enabled: boolean;
    scope?: string;
  };
  code?: {
    enabled: boolean;
    sourceDir?: string;
    scope?: string;
  };
  preserveConfirmed?: boolean;
}

interface ApiPayload {
  ok?: boolean;
  error?: string;
  code?: string;
  store?: BusinessMapStore;
  system?: BusinessSystem;
  systemId?: string;
  item?: BusinessFunction | BusinessFlow;
  directory?: BusinessDirectory;
  check?: PublishCheck;
  sourceStats?: unknown;
  file?: string;
  exists?: boolean;
  content?: string;
  created?: boolean;
  dir?: string;
  canceled?: boolean;
}

export class BusinessMapApiError extends Error {
  status: number;
  code: string;
  check?: PublishCheck;

  constructor(message: string, status: number, code = '', check?: PublishCheck) {
    super(message);
    this.name = 'BusinessMapApiError';
    this.status = status;
    this.code = code;
    this.check = check;
  }
}

async function request(path = '', init: RequestInit = {}): Promise<ApiPayload> {
  const hasBody = init.body !== undefined;
  const res = await fetch(`${BUSINESS_MAP_API}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as ApiPayload;
  if (!res.ok || data.ok === false) {
    throw new BusinessMapApiError(
      data.error || `HTTP ${res.status}`,
      res.status,
      data.code || '',
      data.check,
    );
  }
  return data;
}

function body(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}

export async function fetchBusinessMapHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BUSINESS_MAP_API}?health=1`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function syncBusinessMapPrompt(enabled: boolean): Promise<boolean> {
  const data = await request('/prompt/sync', {
    method: 'POST',
    ...body({ enabled }),
  });
  return data.ok === true;
}

export async function readBusinessMapPrompt(): Promise<{
  file: string;
  exists: boolean;
  content: string;
}> {
  const data = await request('/prompt');
  return {
    file: data.file || BUSINESS_MAP_PROMPT_FILE,
    exists: Boolean(data.exists),
    content: data.content || '',
  };
}

export async function loadBusinessMap(): Promise<BusinessMapStore> {
  const data = await request();
  return normalizeStore(data);
}

export async function createBusinessMapDemo(
  revision: number,
): Promise<{ store: BusinessMapStore; systemId: string }> {
  const data = await request('/demo', { method: 'POST', ...body({ revision }) });
  return { store: normalizeStore(data), systemId: data.systemId || '' };
}

export async function createBusinessSystem(
  revision: number,
  system: Partial<BusinessSystem>,
): Promise<{ store: BusinessMapStore; systemId: string }> {
  const data = await request('/systems', { method: 'POST', ...body({ revision, system }) });
  return { store: normalizeStore(data), systemId: data.systemId || '' };
}

export async function copyBusinessSystem(
  revision: number,
  systemId: string,
  loginCopyMode: BusinessLoginCopyMode = 'configuration',
): Promise<{ store: BusinessMapStore; systemId: string }> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}/copy`, {
    method: 'POST',
    ...body({ revision, loginCopyMode }),
  });
  return { store: normalizeStore(data), systemId: data.systemId || '' };
}

/** 打开系统原生选目录窗口；取消返回空串。 */
export async function pickBusinessSourceDirectory(): Promise<string> {
  const data = await request('/pick-directory', { method: 'POST' });
  return data.canceled ? '' : data.dir || '';
}

export async function updateBusinessSystem(
  revision: number,
  systemId: string,
  patch: Partial<BusinessSystem>,
): Promise<BusinessMapStore> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}`, {
    method: 'PUT',
    ...body({ revision, system: patch }),
  });
  return normalizeStore(data);
}

export async function createBusinessDirectory(
  revision: number,
  systemId: string,
  directory: Partial<BusinessDirectory>,
): Promise<{ store: BusinessMapStore; item: BusinessDirectory }> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}/directories`, {
    method: 'POST',
    ...body({ revision, directory }),
  });
  return { store: normalizeStore(data), item: normalizeDirectory(data.directory) };
}

export async function updateBusinessDirectory(
  revision: number,
  systemId: string,
  id: string,
  patch: Partial<BusinessDirectory>,
): Promise<{ store: BusinessMapStore; item: BusinessDirectory }> {
  const data = await request(
    `/systems/${encodeURIComponent(systemId)}/directories/${encodeURIComponent(id)}`,
    { method: 'PUT', ...body({ revision, directory: patch }) },
  );
  return { store: normalizeStore(data), item: normalizeDirectory(data.directory) };
}

export async function deleteBusinessDirectory(
  revision: number,
  systemId: string,
  id: string,
  cascade = false,
): Promise<BusinessMapStore> {
  const data = await request(
    `/systems/${encodeURIComponent(systemId)}/directories/${encodeURIComponent(id)}`,
    { method: 'DELETE', ...body({ revision, cascade }) },
  );
  return normalizeStore(data);
}

export async function moveBusinessTreeNode(
  revision: number,
  systemId: string,
  move: {
    kind: 'directory' | 'function';
    id: string;
    parentId: string;
    beforeId?: string;
  },
): Promise<BusinessMapStore> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}/tree/move`, {
    method: 'POST',
    ...body({ revision, ...move }),
  });
  return normalizeStore(data);
}

export async function deleteBusinessSystem(
  revision: number,
  systemId: string,
): Promise<BusinessMapStore> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}`, {
    method: 'DELETE',
    ...body({ revision }),
  });
  return normalizeStore(data);
}

export async function createBusinessFunction(
  revision: number,
  systemId: string,
  fn: Partial<BusinessFunction>,
): Promise<{ store: BusinessMapStore; item: BusinessFunction }> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}/functions`, {
    method: 'POST',
    ...body({ revision, function: fn }),
  });
  return { store: normalizeStore(data), item: normalizeFunction(data.item) };
}

export async function updateBusinessFunction(
  revision: number,
  systemId: string,
  id: string,
  patch: Partial<BusinessFunction>,
): Promise<{ store: BusinessMapStore; item: BusinessFunction }> {
  const data = await request(
    `/systems/${encodeURIComponent(systemId)}/functions/${encodeURIComponent(id)}`,
    { method: 'PUT', ...body({ revision, function: patch }) },
  );
  return { store: normalizeStore(data), item: normalizeFunction(data.item) };
}

export async function deleteBusinessFunction(
  revision: number,
  systemId: string,
  id: string,
): Promise<BusinessMapStore> {
  const data = await request(
    `/systems/${encodeURIComponent(systemId)}/functions/${encodeURIComponent(id)}`,
    { method: 'DELETE', ...body({ revision }) },
  );
  return normalizeStore(data);
}

export async function createBusinessFlow(
  revision: number,
  systemId: string,
  flow: Partial<BusinessFlow>,
): Promise<{ store: BusinessMapStore; item: BusinessFlow }> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}/flows`, {
    method: 'POST',
    ...body({ revision, flow }),
  });
  return { store: normalizeStore(data), item: normalizeFlow(data.item) };
}

export async function updateBusinessFlow(
  revision: number,
  systemId: string,
  id: string,
  patch: Partial<BusinessFlow>,
): Promise<{ store: BusinessMapStore; item: BusinessFlow }> {
  const data = await request(
    `/systems/${encodeURIComponent(systemId)}/flows/${encodeURIComponent(id)}`,
    { method: 'PUT', ...body({ revision, flow: patch }) },
  );
  return { store: normalizeStore(data), item: normalizeFlow(data.item) };
}

export async function deleteBusinessFlow(
  revision: number,
  systemId: string,
  id: string,
): Promise<BusinessMapStore> {
  const data = await request(
    `/systems/${encodeURIComponent(systemId)}/flows/${encodeURIComponent(id)}`,
    { method: 'DELETE', ...body({ revision }) },
  );
  return normalizeStore(data);
}

/** @deprecated 仅兼容示例演示；真实识别使用 business-map-analysis 的后台任务接口。 */
export async function analyzeBusinessSystem(
  revision: number,
  systemId: string,
  sources: AnalyzeSources,
): Promise<BusinessMapStore> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}/analyze`, {
    method: 'POST',
    ...body({ revision, sources }),
  });
  return normalizeStore(data);
}

export async function applyBusinessProposals(
  revision: number,
  systemId: string,
  ids: string[],
): Promise<BusinessMapStore> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}/proposals/apply`, {
    method: 'POST',
    ...body({ revision, ids }),
  });
  return normalizeStore(data);
}

export async function ignoreBusinessProposals(
  revision: number,
  systemId: string,
  ids: string[],
): Promise<BusinessMapStore> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}/proposals/ignore`, {
    method: 'POST',
    ...body({ revision, ids }),
  });
  return normalizeStore(data);
}

export async function publishBusinessSystem(
  revision: number,
  systemId: string,
): Promise<{ store: BusinessMapStore; check: PublishCheck }> {
  const data = await request(`/systems/${encodeURIComponent(systemId)}/publish`, {
    method: 'POST',
    ...body({ revision }),
  });
  return {
    store: normalizeStore(data),
    check: data.check || { ok: false, score: 0, items: [] },
  };
}

export function normalizeStore(data: ApiPayload | BusinessMapStore): BusinessMapStore {
  const raw = 'store' in data && data.store ? data.store : (data as BusinessMapStore);
  return {
    version: Number(raw?.version) || 1,
    revision: Math.max(0, Number(raw?.revision) || 0),
    systems: (Array.isArray(raw?.systems) ? raw.systems : []).map(normalizeSystem).filter(Boolean),
    createdAt: str(raw?.createdAt),
    updatedAt: str(raw?.updatedAt),
  };
}

function str(value: unknown, max = 4000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => str(item)).filter(Boolean) : [];
}

function normalizeEvidence(raw: unknown): BusinessEvidence {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    id: str(r.id, 64),
    type: ['page', 'doc', 'code', 'manual'].includes(str(r.type))
      ? (str(r.type) as EvidenceType)
      : 'manual',
    title: str(r.title),
    ref: str(r.ref, 1200),
    note: str(r.note),
    confidence: ['high', 'medium', 'low'].includes(str(r.confidence))
      ? (str(r.confidence) as Confidence)
      : 'medium',
  };
}

export function normalizeFunction(raw: unknown): BusinessFunction {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    id: str(r.id, 64),
    code: str(r.code, 32),
    name: str(r.name, 200),
    directoryId: str(r.directoryId, 64),
    order: Math.max(0, Number(r.order) || 0),
    domain: str(r.domain, 100) || '未归类',
    module: str(r.module, 100) || '未归类',
    status: ['在用', '停用', '草稿'].includes(str(r.status))
      ? (str(r.status) as FunctionStatus)
      : '在用',
    purpose: str(r.purpose, 2000),
    roles: list(r.roles),
    entry: str(r.entry, 1000),
    inputs: list(r.inputs),
    outputs: list(r.outputs),
    rules: list(r.rules),
    writes: list(r.writes),
    exceptions: list(r.exceptions),
    implementation: list(r.implementation),
    evidence: Array.isArray(r.evidence) ? r.evidence.map(normalizeEvidence) : [],
    confidence: ['high', 'medium', 'low'].includes(str(r.confidence))
      ? (str(r.confidence) as Confidence)
      : 'medium',
    source: ['ai', 'manual', 'mixed'].includes(str(r.source))
      ? (str(r.source) as FunctionSource)
      : 'manual',
    confirmed: r.confirmed === true,
    lockedFields: list(r.lockedFields),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

export function normalizeDirectory(raw: unknown): BusinessDirectory {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    id: str(r.id, 64),
    parentId: str(r.parentId, 64),
    name: str(r.name, 200),
    order: Math.max(0, Number(r.order) || 0),
    source: ['menu', 'ai', 'manual'].includes(str(r.source))
      ? (str(r.source) as DirectorySource)
      : 'manual',
    menuPath: list(r.menuPath).slice(0, 20),
    entryUrl: str(r.entryUrl, 2000),
    evidence: Array.isArray(r.evidence) ? r.evidence.map(normalizeEvidence) : [],
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

/** 调整顺序后，数字形式的「下一步」继续指向原步骤，删除目标则清空待补。 */
export function renumberBusinessSteps(
  previous: BusinessFlowStep[],
  ordered: BusinessFlowStep[],
): BusinessFlowStep[] {
  const positions = new Map(ordered.map((step, index) => [step.id, index + 1]));
  return ordered.map((step, index) => {
    const target = /^\d+$/.test(step.next.trim())
      ? previous.find((item) => item.n === Number(step.next))
      : null;
    return {
      ...step,
      n: index + 1,
      next: target ? String(positions.get(target.id) || '') : step.next,
    };
  });
}

export function insertBusinessStep(
  previous: BusinessFlowStep[],
  draft: BusinessFlowStep,
): BusinessFlowStep[] {
  const position = Math.max(0, Math.min(previous.length, draft.n - 1));
  const ordered = [...previous.slice(0, position), draft, ...previous.slice(position)];
  const result = renumberBusinessSteps(previous, ordered);
  const predecessor = result[position - 1];
  // 仅串接原来的顺序边；自定义分支和跳转保持原目标。
  if (predecessor && predecessor.next === result[position].next) {
    result[position - 1] = { ...predecessor, next: String(position + 1) };
  }
  return result;
}

export function normalizeStep(raw: unknown, index = 0): BusinessFlowStep {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    id: str(r.id, 64),
    n: Number(r.n) || index + 1,
    title: str(r.title, 500),
    role: str(r.role, 200),
    system: str(r.system, 200) || '工单系统',
    functionId: str(r.functionId, 64),
    input: str(r.input, 1200),
    output: str(r.output, 1200),
    next: str(r.next, 100),
    branch: str(r.branch, 1000),
    branchBroken: r.branchBroken === true,
    manual: r.manual === true,
    dependencies: Array.isArray(r.dependencies)
      ? r.dependencies
          .map((item) => {
            const d = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
            return { system: str(d.system, 200), label: str(d.label, 500) };
          })
          .filter((item) => item.system || item.label)
      : [],
    evidence: Array.isArray(r.evidence) ? r.evidence.map(normalizeEvidence) : [],
  };
}

export function normalizeFlow(raw: unknown): BusinessFlow {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    id: str(r.id, 64),
    code: str(r.code, 32),
    name: str(r.name, 300),
    result: str(r.result, 1000),
    status: ['健康', '待补全', '草稿'].includes(str(r.status))
      ? (str(r.status) as BusinessFlow['status'])
      : '健康',
    steps: (Array.isArray(r.steps) ? r.steps : []).map(normalizeStep),
    evidence: Array.isArray(r.evidence) ? r.evidence.map(normalizeEvidence) : [],
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

export function normalizeProposal(raw: unknown): BusinessProposal {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    id: str(r.id, 64),
    action: ['add', 'update', 'delete'].includes(str(r.action))
      ? (str(r.action) as ProposalAction)
      : 'add',
    targetType: str(r.targetType) === 'flow' ? 'flow' : 'function',
    targetId: str(r.targetId, 64),
    title: str(r.title, 500),
    detail: str(r.detail, 3000),
    source: str(r.source, 1000),
    risk: ['低', '中', '高'].includes(str(r.risk))
      ? (str(r.risk) as BusinessProposal['risk'])
      : '低',
    confidence: ['high', 'medium', 'low'].includes(str(r.confidence))
      ? (str(r.confidence) as Confidence)
      : 'medium',
    evidence: Array.isArray(r.evidence) ? r.evidence.map(normalizeEvidence) : [],
    payload:
      r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {},
    status: ['pending', 'applied', 'ignored'].includes(str(r.status))
      ? (str(r.status) as ProposalStatus)
      : 'pending',
    createdAt: str(r.createdAt),
    appliedAt: str(r.appliedAt),
    analysisId: str(r.analysisId, 64),
    fingerprint: str(r.fingerprint, 64),
  };
}

export function normalizeSystem(raw: unknown): BusinessSystem {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const docs = r.docs && typeof r.docs === 'object' ? (r.docs as Record<string, unknown>) : {};
  return {
    id: str(r.id, 64),
    name: str(r.name, 200),
    description: str(r.description, 2000),
    entryUrl: str(r.entryUrl, 2000),
    sourceDir: str(r.sourceDir, 2000),
    loginState: str(r.loginState, 2000),
    docs: {
      requirements: docs.requirements !== false,
      knowledge: docs.knowledge !== false,
      scope: str(docs.scope, 500) || '当前系统关联文档',
    },
    analysisScope: str(r.analysisScope, 1000) || '全部菜单',
    status: str(r.status) === 'published' ? 'published' : 'draft',
    publishedRevision: Math.max(0, Number(r.publishedRevision) || 0),
    lastAnalysis:
      r.lastAnalysis && typeof r.lastAnalysis === 'object'
        ? {
            at: str((r.lastAnalysis as Record<string, unknown>).at),
            status: str((r.lastAnalysis as Record<string, unknown>).status),
            pageCount: Number((r.lastAnalysis as Record<string, unknown>).pageCount) || 0,
            docCount: Number((r.lastAnalysis as Record<string, unknown>).docCount) || 0,
            codeFileCount: Number((r.lastAnalysis as Record<string, unknown>).codeFileCount) || 0,
            summary: str((r.lastAnalysis as Record<string, unknown>).summary, 2000),
          }
        : null,
    directories: Array.isArray(r.directories) ? r.directories.map(normalizeDirectory) : [],
    functions: Array.isArray(r.functions) ? r.functions.map(normalizeFunction) : [],
    flows: Array.isArray(r.flows) ? r.flows.map(normalizeFlow) : [],
    proposals: Array.isArray(r.proposals) ? r.proposals.map(normalizeProposal) : [],
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

export function pendingProposals(system: BusinessSystem | null | undefined): BusinessProposal[] {
  return (system?.proposals || []).filter((item) => item.status === 'pending');
}

export function functionFlowRefs(
  system: BusinessSystem | null | undefined,
  functionId: string,
): Array<{ flow: BusinessFlow; step: BusinessFlowStep }> {
  if (!system) return [];
  const out: Array<{ flow: BusinessFlow; step: BusinessFlowStep }> = [];
  for (const flow of system.flows) {
    for (const step of flow.steps) {
      if (step.functionId === functionId) out.push({ flow, step });
    }
  }
  return out;
}

export function participantSystems(flow: BusinessFlow | null | undefined): string[] {
  if (!flow) return [];
  return [
    ...new Set([
      ...flow.steps.map((step) => step.system).filter(Boolean),
      ...flow.steps.flatMap((step) => step.dependencies.map((dep) => dep.system).filter(Boolean)),
    ]),
  ];
}

export function localPublishCheck(system: BusinessSystem): PublishCheck {
  const items: PublishCheckItem[] = [];
  const pending = pendingProposals(system).length;
  if (pending) {
    items.push({
      level: 'block',
      code: 'pending_proposals',
      title: `${pending} 项 AI 识别结果未审核`,
      ref: 'proposals',
    });
  }
  let broken = 0;
  let missing = 0;
  for (const flow of system.flows) {
    broken += flow.steps.filter((step) => step.branchBroken).length;
    missing += flow.steps.filter(
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
  if (broken) {
    items.push({
      level: 'block',
      code: 'broken_branch',
      title: `${broken} 个流程分支未连接`,
      ref: 'flows',
    });
  }
  if (missing) {
    items.push({
      level: 'block',
      code: 'missing_function',
      title: `${missing} 个流程步骤没有承载功能`,
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
  const missingPurpose = system.functions.filter((item) => !item.purpose).length;
  if (missingPurpose) {
    items.push({
      level: 'warn',
      code: 'function_purpose',
      title: `${missingPurpose} 个功能缺少作用说明`,
      ref: 'functions',
    });
  }
  if (!items.length) {
    items.push({ level: 'ok', code: 'structure', title: '功能与流程结构完整', ref: '' });
  }
  return {
    ok: !items.some((item) => item.level === 'block'),
    score: Math.max(
      40,
      100 -
        items.filter((item) => item.level === 'block').length * 18 -
        items.filter((item) => item.level === 'warn').length * 5,
    ),
    items,
  };
}
