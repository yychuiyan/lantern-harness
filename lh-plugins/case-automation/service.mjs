import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveContentRoot } from '../../builtin/session/space-layout.mjs';
import { resolveModelForSpace } from '../lh-config.mjs';
import { readPluginPrompt } from '../plugin-prompts.mjs';
import {
  detectProject,
  readAutomationProjectRun,
  startAutomationProjectRun,
  stopAutomationProjectRun,
  uiautoCachePaths,
  uiautoStorePaths,
} from '../lh-uiauto.mjs';
import {
  detectEmitLayout,
  findGeneratedSessionByAutomationCaseId,
  removeGeneratedSession,
  saveGeneratedSession,
} from '../uiauto-explorer/sessions.mjs';
import { normalizePlan, PLAN_ACTIONS } from '../uiauto-explorer/plan.mjs';
import { applyCaseExecutionResult, loadCaseDocument } from '../case-execution/files.mjs';
import { caseContentFingerprint } from '../case-execution/assets.mjs';
import {
  CASE_AUTOMATION_FLOW_PROMPT_FILE,
  CASE_AUTOMATION_PROMPT_FILE,
} from '../case-automation-prompt.mjs';
import { backupFile, fileHash, readTable, writeTableAtomic } from './tables.mjs';
import {
  readAssessment,
  readAutomationLinks,
  readFlowStore,
  readProjectMap,
  rememberAssessments,
  rememberProjectSelection,
  upsertAutomationLinks,
  upsertFlowCases,
  writeAssessment,
  writeBatch,
  readBatch,
  automationSummaryForCase,
} from './store.mjs';

const ACTIVE_BATCHES = new Map();
export const AUTOMATION_HEADERS = [
  '用例类型',
  '自动化用例编号',
  '流程用例编号',
  '来源用例文件',
  '来源用例编号',
  '来源自动化用例',
  '自动化用例标题',
  '执行角色',
  '检查点',
  '引用需求点',
  '前置条件',
  '自动化步骤',
  '预期结果',
  '优先级',
  '可行性',
  '自动化项目',
  '迭代版本',
  '目标迭代文件',
  '测试标签',
  '脚本状态',
  '运行状态',
  '实际结果',
  '报告地址',
  '说明',
];
const DECISIONS = new Set(['automatable', 'needs_manual', 'not_automatable']);
const SCOPE_ACTIONS = new Set(['keep', 'move_to_api', 'move_to_perf', 'retire']);
const STABILITY_MODES = new Set(['stable', 'relationship', 'exploratory']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
const clean = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export function caseAutomationSkillHash(root) {
  return crypto
    .createHash('sha256')
    .update(readPluginPrompt(CASE_AUTOMATION_PROMPT_FILE, root))
    .digest('hex');
}

export function automationDependencyHash(root, project, roleIds, systemId = '', flowId = '') {
  let mapDependency = null;
  if (systemId) {
    try {
      const file = path.join(resolveContentRoot(root, '业务地图').abs, '业务地图.json');
      const map = JSON.parse(fs.readFileSync(file, 'utf8'));
      const system = (map.systems || []).find((item) => item.id === systemId);
      const flow = flowId ? (system?.flows || []).find((item) => item.id === flowId) : null;
      mapDependency = system
        ? {
            systemId,
            systemUpdatedAt: system.updatedAt || '',
            flowId,
            flowUpdatedAt: flow?.updatedAt || '',
            flowSteps: flow?.steps || [],
          }
        : { systemId, missing: true };
    } catch {
      mapDependency = { systemId, missing: true };
    }
  }
  const roles = (project?.roles || [])
    .filter((role) => roleIds.includes(role.id))
    .map((role) => ({
      id: role.id,
      usernameEnv: role.usernameEnv || '',
      passwordEnv: role.passwordEnv || '',
      storageState: role.storageState || '',
      status: role.status || 'unbound',
    }));
  const projectDependency = {
    id: project?.id || '',
    dir: project?.dir || '',
    framework: project?.framework || '',
    baseURL: project?.baseURL || '',
  };
  const flowSkillHash = crypto
    .createHash('sha256')
    .update(readPluginPrompt(CASE_AUTOMATION_FLOW_PROMPT_FILE, root))
    .digest('hex');
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ projectDependency, mapDependency, roles, flowSkillHash }))
    .digest('hex');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function projectRecord(root, projectId) {
  const store = readJson(uiautoStorePaths(root).projectsFile, { projects: [] });
  const project = (store.projects || []).find((item) => item.id === projectId);
  if (!project) fail('自动化项目不存在', 404);
  let health;
  try {
    health = detectProject(project.dir, project.framework);
  } catch {
    fail('自动化项目目录不可用，请重新挂载项目', 409);
  }
  if (!health.exists) fail('自动化项目目录不存在，请重新挂载项目', 409);
  if (health.kind !== 'ui') fail('功能测试用例只能选择 UI 自动化项目', 409);
  const framework = project.framework || health.framework || 'playwright';
  if (framework !== 'playwright') fail('首版脚本生成仅支持 Playwright + TypeScript 项目', 422);
  if (!health.frameworkReady) fail(health.readyHint || '自动化项目运行环境未就绪', 409);
  return { project: { ...project, framework }, health };
}

export function storageStateStatus(project, storageState) {
  const value = clean(storageState, 300);
  if (!value) return { ok: false, reason: '缺少 storageState' };
  const abs = path.isAbsolute(value) ? value : path.resolve(project?.dir || '', value);
  try {
    return fs.statSync(abs).isFile()
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'storageState 不是文件' };
  } catch {
    return { ok: false, reason: 'storageState 文件不存在' };
  }
}

export function normalizeIteration(raw) {
  let value = clean(raw, 80)
    .replace(/\.spec\.ts$/i, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!value) fail('请选择或创建迭代版本');
  if (/^\d/.test(value)) value = `v${value}`;
  return value;
}

function iterationList(project, health) {
  const layout = detectEmitLayout(project.dir, health.testDir || '');
  const dir = path.join(project.dir, layout.testDir, 'iteration');
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => /\.spec\.ts$/i.test(name))
        .sort((a, b) => a.localeCompare(b, 'zh'))
    : [];
  return {
    testDir: layout.testDir,
    iterationDir: path.join(layout.testDir, 'iteration').replaceAll(path.sep, '/'),
    files: files.map((name) => ({
      name,
      value: `${layout.testDir}/iteration/${name}`.replaceAll(path.sep, '/'),
    })),
  };
}

export function listIterations(root, projectId, casePath = '') {
  const { project, health } = projectRecord(root, projectId);
  const iterations = iterationList(project, health);
  const version = String(path.basename(casePath))
    .match(/v\d+(?:\.\d+)*/i)?.[0]
    ?.toLowerCase();
  const suggested =
    iterations.files.find((file) => version && file.name.toLowerCase().includes(version)) ||
    (iterations.files.length === 1 ? iterations.files[0] : null);
  return {
    project: {
      id: project.id,
      name: project.name,
      framework: project.framework,
      kind: health.kind,
      baseURL: project.baseURL || '',
    },
    ...iterations,
    suggestedIteration: suggested?.name.replace(/\.spec\.ts$/i, '') || '',
  };
}

export async function sourceDocument(root, casePath) {
  const document = await loadCaseDocument(root, casePath);
  const { _parsed, _map, abs, ...publicDocument } = document;
  return {
    ...publicDocument,
    cases: publicDocument.cases.map((item) => ({
      ...item,
      automation: automationSummaryForCase(root, publicDocument.path, item.id),
    })),
  };
}

export function projectSelection(root, casePath) {
  return readProjectMap(root).files?.[casePath] || null;
}

function modelCall(settings, messages, signal) {
  const url = new URL(settings.baseURL.replace(/\/+$/, '') + '/chat/completions');
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: 0.1,
      stream: false,
    }),
    signal,
  });
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) fail('模型没有返回合法 JSON', 502);
  try {
    return JSON.parse(candidate);
  } catch {
    fail('模型返回的 JSON 无法解析', 502);
  }
}

function planValid(plan) {
  return (
    plan.length > 0 &&
    plan.length <= 40 &&
    plan.some((step) => ['expect', 'expectUrl'].includes(step.action)) &&
    plan.every((step) => PLAN_ACTIONS.includes(step.action))
  );
}

function normalizeRoleId(value) {
  return clean(value, 60)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '');
}

function normalizeRequiredRoles(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw
    .slice(0, 20)
    .map((item) => {
      const value = typeof item === 'string' ? { roleName: item } : item;
      if (!value || typeof value !== 'object') return null;
      const roleName = clean(value.roleName ?? value.name, 80);
      let roleId = normalizeRoleId(value.roleId ?? value.id ?? roleName);
      if (!roleName || !roleId) return null;
      if (seen.has(roleId)) return null;
      seen.add(roleId);
      return { roleId, roleName, reason: clean(value.reason, 500) };
    })
    .filter(Boolean);
}

export function normalizeAssessments(raw, cases, project, iteration, iterationFile) {
  const results = Array.isArray(raw?.cases) ? raw.cases : [];
  return cases.map((source) => {
    const hit = results.find((item) => clean(item?.sourceCaseId, 100) === source.id);
    const decision = DECISIONS.has(hit?.decision) ? hit.decision : 'needs_manual';
    const scopeAction = SCOPE_ACTIONS.has(hit?.scopeAction) ? hit.scopeAction : 'keep';
    const executionMode =
      hit?.executionMode === 'auto' || hit?.executionMode === 'manual'
        ? hit.executionMode
        : decision === 'automatable'
          ? 'auto'
          : 'manual';
    const requiredRoles = normalizeRequiredRoles(hit?.requiredRoles);
    const manualReason =
      clean(hit?.manualReason, 1000) ||
      (executionMode === 'manual' ? clean(hit?.reason, 1000) : '');
    const stability = STABILITY_MODES.has(hit?.stability) ? hit.stability : 'stable';
    const requestedGateEligible =
      hit?.gateEligible === true &&
      executionMode === 'auto' &&
      stability !== 'exploratory' &&
      scopeAction === 'keep';
    const automationCases = [];
    const modelCases = Array.isArray(hit?.automationCases) ? hit.automationCases : [];
    for (let index = 0; index < modelCases.length; index += 1) {
      const item = modelCases[index];
      const plan = normalizePlan(item?.plan);
      if (!planValid(plan)) continue;
      const title = clean(item?.title, 240) || source.title;
      // 稳定 ID 由来源用例 + 拆分序号生成，重复评估时仍命中同一条自动化用例。
      const automationCaseId = `AUTO-${crypto
        .createHash('sha256')
        .update(`${source.id}\0${index}`)
        .digest('hex')
        .slice(0, 12)
        .toUpperCase()}`;
      automationCases.push({
        automationCaseId,
        title,
        precondition: clean(item?.precondition, 4000) || source.precondition,
        steps: (Array.isArray(item?.steps) ? item.steps : [])
          .map((step) => clean(step, 1000))
          .filter(Boolean)
          .slice(0, 30),
        expected: clean(item?.expected, 4000) || source.expected,
        priority: /^P[0-3]$/.test(clean(item?.priority, 10))
          ? clean(item?.priority, 10)
          : source.priority || 'P2',
        tag:
          clean(item?.tag, 40) ||
          (['P0', 'P1'].includes(source.priority) ? '@regression' : '@edge'),
        caseKind: 'atomic',
        flowOnly: item?.flowOnly === true || plan.some((step) => Boolean(step.valueFrom)),
        plan,
        automationTag: `@lantern-${automationCaseId.toLowerCase()}`,
        actorRoleId:
          normalizeRoleId(item?.actorRoleId) ||
          normalizeRoleId(item?.roleId) ||
          requiredRoles[0]?.roleId ||
          '',
        requiredRoleIds:
          Array.isArray(item?.requiredRoleIds) && item.requiredRoleIds.length
            ? item.requiredRoleIds.map(normalizeRoleId).filter(Boolean)
            : requiredRoles.map((role) => role.roleId),
        projectId: project.id,
        projectName: project.name,
        framework: project.framework,
        iteration,
        iterationFile,
      });
    }
    const scopeReason =
      scopeAction === 'move_to_api'
        ? '该用例应转入接口测试，不在当前 UI 自动化范围内'
        : scopeAction === 'move_to_perf'
          ? '该用例应转入性能测试，不在当前 UI 自动化范围内'
          : scopeAction === 'retire'
            ? '该用例建议退役，不生成 UI 自动化脚本'
            : '';
    const blockedByScope = scopeAction !== 'keep';
    const forcedManual = decision === 'automatable' && executionMode === 'manual';
    const missingExecutionRole = automationCases.some(
      (item) => !item.actorRoleId && !item.requiredRoleIds.length,
    );
    const finalDecision =
      decision === 'automatable' && blockedByScope
        ? 'not_automatable'
        : decision === 'automatable' &&
            (forcedManual || !automationCases.length || missingExecutionRole)
          ? 'needs_manual'
          : decision;
    const finalExecutionMode = finalDecision === 'automatable' ? executionMode : 'manual';
    const finalManualReason =
      finalExecutionMode === 'manual'
        ? scopeReason ||
          (forcedManual
            ? '模型判定为手动执行，不能生成原子 UI 自动化；请重新评估执行方式'
            : missingExecutionRole
              ? '未识别执行角色，请补充角色和 storageState 后重新评估'
              : manualReason ||
                (finalDecision === 'needs_manual' ? '当前无法形成可执行 UI Plan' : ''))
        : '';
    const flowRequired =
      hit?.flowRequired === true ||
      requiredRoles.length > 1 ||
      automationCases.some((item) => item.flowOnly);
    return {
      sourceCaseId: source.id,
      sourceCaseNo: source.no,
      sourceTitle: source.title,
      sourceFingerprint: caseContentFingerprint(source),
      decision: finalDecision,
      executionMode: finalExecutionMode,
      scopeAction,
      manualReason: finalManualReason,
      flowRequired,
      stability,
      gateEligible: requestedGateEligible && !flowRequired && finalDecision === 'automatable',
      requiredRoles,
      reason:
        scopeReason ||
        clean(hit?.reason, 4000) ||
        (finalDecision === 'needs_manual' ? '缺少可执行的 UI Plan 或需要人工条件' : ''),
      risks: (Array.isArray(hit?.risks) ? hit.risks : [])
        .map((risk) => clean(risk, 1000))
        .filter(Boolean)
        .slice(0, 20),
      automationCases: finalDecision === 'automatable' ? automationCases : [],
    };
  });
}

export async function assessCases(root, raw) {
  const casePath = clean(raw.casePath, 1000);
  const projectId = clean(raw.projectId, 80);
  const iteration = normalizeIteration(raw.iteration);
  const document = await loadCaseDocument(root, casePath);
  const selected = new Set(Array.isArray(raw.caseIds) ? raw.caseIds.map(String) : []);
  const cases = document.cases.filter((item) => selected.has(item.id));
  if (!cases.length || cases.length !== selected.size) fail('请选择有效的功能用例范围');
  if (cases.length > 100) fail('单次最多评估 100 条用例');
  const { project, health } = projectRecord(root, projectId);
  const iterations = iterationList(project, health);
  const iterationFile = `${iterations.iterationDir}/${iteration}.spec.ts`;
  const skill = readPluginPrompt(CASE_AUTOMATION_PROMPT_FILE, root).trim();
  if (!skill) fail('功能用例转 UI 自动化技能尚未就绪', 422);
  const skillHash = caseAutomationSkillHash(root);
  const settings = resolveModelForSpace(root);
  if (!settings.baseURL || !settings.apiKey || !settings.model)
    fail('请先在设置中配置可用模型', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('模型评估超时')), 90_000);
  let message;
  try {
    const response = await modelCall(
      settings,
      [
        {
          role: 'system',
          content: `${skill}\n\n当前 UI 自动化项目：${project.name}，框架：${project.framework}，迭代：${iteration}，目标文件：${iterationFile}。`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            cases: cases.map((item) => ({
              sourceCaseId: item.id,
              no: item.no,
              title: item.title,
              module: item.module,
              priority: item.priority,
              precondition: item.precondition,
              steps: item.steps,
              expected: item.expected,
              requirementRefs: (item.fields || []).filter((field) =>
                /需求|requirement|reqcite|reqpoint/i.test(field.name),
              ),
            })),
          }),
        },
      ],
      controller.signal,
    );
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      fail(`模型请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`, 502);
    }
    const data = await response.json();
    message = data.choices?.[0]?.message?.content || '';
  } catch (error) {
    if (controller.signal.aborted) fail('模型评估超时，请重试', 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const normalized = normalizeAssessments(
    extractJson(message),
    cases,
    project,
    iteration,
    iterationFile,
  );
  const assessment = writeAssessment(root, {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sourcePath: casePath,
    sourceFileHash: document.fileHash,
    projectId,
    projectName: project.name,
    framework: project.framework,
    iteration,
    iterationFile,
    cases: normalized,
    skillHash,
  });
  for (const item of normalized) {
    rememberAssessments(root, casePath, item.sourceCaseId, [
      {
        decision: item.decision,
        executionMode: item.executionMode,
        scopeAction: item.scopeAction,
        manualReason: item.manualReason,
        requiredRoles: item.requiredRoles,
        reason: item.reason,
        automationCaseId: item.automationCases[0]?.automationCaseId || '',
      },
    ]);
  }
  rememberProjectSelection(root, casePath, projectId, iteration);
  return { assessment };
}

function automationFileName(casePath) {
  const ext = path.extname(casePath).toLowerCase();
  const outputExt = ext === '.xls' ? '.xlsx' : ext;
  const stem = path
    .basename(casePath, ext)
    .replace(/_(?:功能|接口|性能|自动化)测试用例(?:_\d{8}-\d{6})?$/i, '');
  return `${stem || '功能用例'}_自动化测试用例${outputExt}`;
}

async function automationFileTarget(root, sourcePath) {
  const dir = path.join(resolveContentRoot(root, '用例管理').abs, '自动化测试');
  fs.mkdirSync(dir, { recursive: true });
  const baseName = automationFileName(sourcePath);
  const preferred = path.join(dir, baseName);
  if (!fs.existsSync(preferred)) return preferred;
  const ext = path.extname(preferred).toLowerCase();
  const table = await readTable(preferred, ext);
  if (!table.rows.length || table.rows.some((row) => row['来源用例文件'] === sourcePath)) {
    return preferred;
  }
  const stem = path.basename(preferred, ext);
  const suffix = crypto.createHash('sha256').update(sourcePath).digest('hex').slice(0, 8);
  return path.join(dir, `${stem}-${suffix}${ext}`);
}

function sourceRefs(item) {
  return (item.fields || [])
    .filter((field) => /需求|requirement|reqcite|reqpoint/i.test(field.name))
    .map((field) => `${field.name}：${field.value}`)
    .join('；');
}

function statusText(status) {
  return (
    {
      connected: '已接入',
      running: '运行中',
      passed: '已通过',
      failed: '运行失败',
      stale: '已过期',
      needs_manual: '需人工辅助',
      needs_role: '待绑定角色',
    }[status] || status
  );
}

export async function applyAssessment(root, raw) {
  const assessment = readAssessment(root, raw.assessmentId);
  if (!assessment) fail('评估结果不存在或已过期', 404);
  const { project } = projectRecord(root, assessment.projectId);
  const iterationAbs = path.resolve(project.dir, assessment.iterationFile);
  const projectRoot = `${path.resolve(project.dir)}${path.sep}`;
  if (!iterationAbs.startsWith(projectRoot)) fail('目标迭代文件路径越界', 400);
  const document = await loadCaseDocument(root, assessment.sourcePath);
  if (document.fileHash !== assessment.sourceFileHash) fail('功能用例文件已变化，请重新评估', 409);
  if (assessment.skillHash && caseAutomationSkillHash(root) !== assessment.skillHash) {
    fail('功能用例转 UI 自动化技能已变化，请重新评估', 409);
  }
  const selected = new Set(
    (Array.isArray(raw.selectedSourceCaseIds) ? raw.selectedSourceCaseIds : []).map(String),
  );
  const selectedAutomationCaseIds = new Set(
    (Array.isArray(raw.selectedAutomationCaseIds) ? raw.selectedAutomationCaseIds : []).map(String),
  );
  if (!selected.size) fail('请至少选择一条有效转换结果');
  if ([...selected].some((id) => !assessment.cases.some((item) => item.sourceCaseId === id))) {
    fail('评估结果中的来源用例已变化，请重新评估', 409);
  }
  const chosen = assessment.cases.filter((item) => selected.has(item.sourceCaseId));
  if (!chosen.length) fail('请至少选择一条有效转换结果');
  if (!selectedAutomationCaseIds.size) fail('请至少选择一条原子自动化用例');
  const knownAutomationCaseIds = new Set(
    chosen.flatMap((item) =>
      item.automationCases.map((automationCase) => automationCase.automationCaseId),
    ),
  );
  if ([...selectedAutomationCaseIds].some((id) => !knownAutomationCaseIds.has(id))) {
    fail('评估结果中的自动化用例已变化，请重新评估', 409);
  }

  const resolved = [];
  const missingRoles = [];
  for (const result of chosen) {
    if (result.decision !== 'automatable') continue;
    const source = document.cases.find((item) => item.id === result.sourceCaseId);
    if (!source) continue;
    for (const item of result.automationCases) {
      if (!selectedAutomationCaseIds.has(item.automationCaseId)) continue;
      const projectRole = (project.roles || []).find((role) => role.id === item.actorRoleId);
      const storageState = projectRole?.storageState || '';
      const storage = storageStateStatus(project, storageState);
      if (!projectRole || projectRole.status === 'invalid' || !storage.ok) {
        missingRoles.push(projectRole?.name || item.actorRoleId || result.sourceTitle);
      }
      resolved.push({ result, source, item, storageState, storage });
    }
  }
  if (missingRoles.length) {
    fail(`以下角色未绑定有效的 storageState 文件：${[...new Set(missingRoles)].join('、')}`, 422);
  }

  const iterationExisted = fs.existsSync(iterationAbs);
  const createdSessionIds = [];
  let target = '';
  let backup = '';
  let hadTarget = false;
  let createdIteration = false;
  let writtenTarget = false;
  try {
    if (!iterationExisted) {
      fs.mkdirSync(path.dirname(iterationAbs), { recursive: true });
      fs.writeFileSync(
        iterationAbs,
        `// ${assessment.iteration} 迭代 UI 自动化用例\n// 由 Lantern 功能用例自动化转换创建，后续测试块会合并到此文件。\n`,
        { flag: 'wx' },
      );
      createdIteration = true;
    }
    target = await automationFileTarget(root, assessment.sourcePath);
    hadTarget = fs.existsSync(target);
    const automationFileRel = path
      .relative(resolveContentRoot(root, '用例管理').abs, target)
      .replaceAll(path.sep, '/');
    const ext = path.extname(target).toLowerCase();
    const existing = await readTable(target, ext);
    const headers = [...new Set([...AUTOMATION_HEADERS, ...existing.headers])];
    const rows = existing.rows.slice();
    const byId = new Map(rows.map((row, index) => [row['自动化用例编号'], index]));
    const links = [];
    backup = backupFile(target);
    let createdSessions = 0;
    for (const { result, source, item, storageState, storage } of resolved) {
      const row = {
        ...Object.fromEntries(headers.map((header) => [header, ''])),
        用例类型: '原子',
        自动化用例编号: item.automationCaseId,
        来源用例文件: assessment.sourcePath,
        来源用例编号: source.no || '',
        来源自动化用例: '',
        自动化用例标题: item.title,
        执行角色: item.actorRoleId || '',
        检查点: '',
        引用需求点: sourceRefs(source),
        前置条件: item.precondition,
        自动化步骤: item.steps.join('\n'),
        预期结果: item.expected,
        优先级: item.priority,
        可行性: item.flowOnly ? '仅流程' : '可自动化',
        自动化项目: assessment.projectName,
        迭代版本: assessment.iteration,
        目标迭代文件: assessment.iterationFile,
        测试标签: item.automationTag || '',
        脚本状态: storage.ok ? '待探索' : '待绑定角色',
        运行状态: '待运行',
        实际结果: '',
        报告地址: '',
        说明: [result.reason, item.flowOnly ? '依赖前序流程数据，只能通过冒烟/回归流程运行' : '']
          .filter(Boolean)
          .join('；'),
      };
      const index = byId.get(item.automationCaseId);
      if (index == null) {
        byId.set(item.automationCaseId, rows.length);
        rows.push(row);
      } else {
        rows[index] = { ...rows[index], ...row, 运行状态: rows[index]['运行状态'] || '待运行' };
      }
      let uiSessionId = '';
      if (storage.ok) {
        const sourceText = [
          `来源功能用例：${source.no || source.id} ${source.title}`,
          `前置条件：${source.precondition || '无'}`,
          `测试步骤：${source.steps || '无'}`,
          `预期结果：${source.expected || '无'}`,
        ].join('\n');
        const sessionBase = uiautoCachePaths(root).dir;
        const existingSession = findGeneratedSessionByAutomationCaseId(
          sessionBase,
          item.automationCaseId,
        );
        const session = saveGeneratedSession(sessionBase, {
          id: existingSession?.id,
          projectId: assessment.projectId,
          title: item.title,
          target: 'ts',
          baseURL: '',
          storageState: '',
          roleStorageStates: item.actorRoleId ? { [item.actorRoleId]: storageState } : {},
          source: sourceText,
          headed: true,
          plan: item.plan,
          status: 'planned',
          automationCaseId: item.automationCaseId,
          automationTag: item.automationTag,
          iteration: assessment.iteration,
          iterationFile: assessment.iterationFile,
          keepAlive: true,
        });
        uiSessionId = session.id;
        if (!existingSession) {
          createdSessions += 1;
          createdSessionIds.push(session.id);
        }
      }
      links.push({
        automationCaseId: item.automationCaseId,
        title: item.title,
        source: {
          casePath: assessment.sourcePath,
          caseId: source.id,
          caseNo: source.no,
          title: source.title,
          fingerprint: caseContentFingerprint(source),
        },
        caseKind: 'atomic',
        flowOnly: item.flowOnly === true,
        skillHash: assessment.skillHash || '',
        actorRoleId: item.actorRoleId || '',
        requiredRoleIds: item.requiredRoleIds || [],
        projectId: assessment.projectId,
        projectName: assessment.projectName,
        framework: assessment.framework,
        iteration: assessment.iteration,
        iterationFile: assessment.iterationFile,
        automationFilePath: automationFileRel,
        tag: item.automationTag,
        uiSessionId,
        status: storage.ok ? 'connected' : 'needs_role',
      });
    }
    const written = await writeTableAtomic(target, ext, headers, rows);
    writtenTarget = true;
    const related = readAutomationLinks(root).items.filter(
      (item) => item.automationFilePath === automationFileRel,
    );
    upsertAutomationLinks(root, [
      ...related.map((item) => ({ ...item, automationFileHash: written.fileHash })),
      ...links.map((link) => ({ ...link, automationFileHash: written.fileHash })),
    ]);
    return {
      ok: true,
      automationFile: path
        .relative(resolveContentRoot(root, '用例管理').abs, target)
        .replaceAll(path.sep, '/'),
      fileHash: written.fileHash,
      backup,
      createdSessions,
      links,
    };
  } catch (error) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, target);
    else if (!hadTarget && writtenTarget && target && fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
    }
    if (createdIteration) fs.rmSync(iterationAbs, { force: true });
    for (const id of createdSessionIds) {
      removeGeneratedSession(uiautoCachePaths(root).dir, id);
    }
    throw error;
  }
}

function findLink(root, automationCaseId) {
  return readAutomationLinks(root).items.find((item) => item.automationCaseId === automationCaseId);
}

export async function updateAutomationRow(root, link, values) {
  const base = resolveContentRoot(root, '用例管理').abs;
  const file = link.automationFilePath ? path.join(base, link.automationFilePath) : '';
  if (!file || !fs.existsSync(file)) return false;
  const ext = path.extname(file).toLowerCase();
  const expected = link.automationFileHash || '';
  if (expected && fileHash(file) !== expected) return false;
  if (link.caseKind === 'flow') {
    const current = readFlowStore(root).items.find(
      (item) =>
        item.flowCaseId === link.flowCaseId || item.automationCaseId === link.automationCaseId,
    );
    if (!current) return false;
    upsertFlowCases(root, [
      {
        ...current,
        status:
          values['运行状态'] === '已通过'
            ? 'passed'
            : values['运行状态'] === '运行失败'
              ? 'failed'
              : current.status,
        latestRunId: link.latestRunId || current.latestRunId || '',
        reportUrl: values['报告地址'] || current.reportUrl || '',
        actualResult:
          link.caseKind === 'flow'
            ? link.status === 'passed'
              ? '流程通过，检查点全部通过'
              : link.failureSummary || values['实际结果'] || current.actualResult || ''
            : values['实际结果'] || current.actualResult || '',
        checkpointResults:
          link.caseKind === 'flow'
            ? link.checkpointResults || current.checkpointResults || []
            : current.checkpointResults || [],
        failureSummary:
          link.caseKind === 'flow'
            ? link.failureSummary || current.failureSummary || ''
            : current.failureSummary || '',
        failureCategory:
          link.caseKind === 'flow'
            ? link.failureCategory || current.failureCategory || ''
            : current.failureCategory || '',
      },
    ]);
  }
  const table = await readTable(file, ext);
  const index = table.rows.findIndex((row) => row['自动化用例编号'] === link.automationCaseId);
  if (index < 0) return false;
  const backup = backupFile(file);
  table.rows[index] = { ...table.rows[index], ...values };
  const written = await writeTableAtomic(file, ext, table.headers, table.rows);
  const related = readAutomationLinks(root).items.filter(
    (item) => item.automationFilePath === link.automationFilePath,
  );
  upsertAutomationLinks(
    root,
    (related.length ? related : [link]).map((item) =>
      item.automationCaseId === link.automationCaseId
        ? { ...item, ...link, ...values, automationFileHash: written.fileHash, backup }
        : { ...item, automationFileHash: written.fileHash },
    ),
  );
  return true;
}

function runStatus(link, run) {
  if (!run || run.status === 'cancelled' || run.status === 'interrupted') return 'failed';
  if (run.status === 'error' || run.error) return 'failed';
  if (run.flaky > 0) return 'failed';
  return run.status === 'passed' ? 'passed' : 'failed';
}

function classifyFlowFailure(messages) {
  const text = messages.filter(Boolean).join('\n');
  if (/missing[_ ]role|角色未绑定|缺少角色/i.test(text)) return 'missing_role';
  if (/session.?expired|storageState|登录态.*(失效|过期)|token.*expired|401/i.test(text)) {
    return 'role_session_expired';
  }
  if (/permission|forbidden|403|无权限|权限不足/i.test(text)) return 'role_permission_mismatch';
  if (/login|登录失败|用户名|密码/i.test(text)) return 'login';
  if (/locator|strict mode|selector|not found|waiting for|元素.*(找不到|不可见)/i.test(text)) {
    return 'locator';
  }
  if (/test data|测试数据|数据不存在|缺少数据/i.test(text)) return 'test_data';
  if (/expect|assertion|断言|toEqual|toContain/i.test(text)) return 'assertion';
  if (/ECONN|network|网络|服务.*(不可用|异常)|timeout|超时/i.test(text)) return 'environment';
  return text ? 'dependency' : '';
}

function checkpointMatches(step, checkpoint) {
  const title = String(step?.title || '');
  return title === checkpoint.title || title.endsWith(` › ${checkpoint.title}`);
}

export function applyFlowRunResult(root, link, flow, matched, run, finalStatus, errors) {
  const recorded = Array.isArray(matched?.steps) ? matched.steps : [];
  const planned = Array.isArray(flow.checkpoints) ? flow.checkpoints : [];
  let firstFailureIndex = -1;
  const checkpointResults = planned.map((checkpoint, index) => {
    const hit = recorded.find((step) => checkpointMatches(step, checkpoint));
    if (firstFailureIndex >= 0) {
      return {
        ...checkpoint,
        status: 'not_reached',
        actual: '前序检查点失败，未继续执行',
        error: '',
        failureCategory: '',
        durationMs: 0,
      };
    }
    if (hit) {
      const failed = hit.status === 'error' || Boolean(hit.error);
      if (failed) firstFailureIndex = index;
      return {
        ...checkpoint,
        status: failed ? 'failed' : 'passed',
        actual: failed ? hit.error || errors[0] || '检查点执行失败' : '检查点通过',
        error: failed ? hit.error || errors[0] || '' : '',
        failureCategory: failed ? classifyFlowFailure([hit.error, ...errors]) : '',
        durationMs: Number(hit.durationMs) || 0,
      };
    }
    if (finalStatus === 'failed') {
      firstFailureIndex = index;
      const category = classifyFlowFailure(errors);
      const blocked = [
        'login',
        'role_session_expired',
        'missing_role',
        'role_permission_mismatch',
      ].includes(category);
      return {
        ...checkpoint,
        status: blocked ? 'blocked' : 'failed',
        actual: errors[0] || '运行失败，未定位到该检查点结果',
        error: errors[0] || '',
        failureCategory: category,
        durationMs: 0,
      };
    }
    return {
      ...checkpoint,
      status: finalStatus === 'passed' ? 'passed' : 'not_reached',
      actual: finalStatus === 'passed' ? '检查点通过' : '未执行',
      error: '',
      failureCategory: '',
      durationMs: 0,
    };
  });
  const failure = checkpointResults.find((item) =>
    ['failed', 'blocked'].includes(String(item.status || '')),
  );
  const failureCategory =
    failure?.failureCategory || (finalStatus === 'failed' ? classifyFlowFailure(errors) : '');
  const failureSummary =
    finalStatus === 'passed'
      ? ''
      : [
          failure?.title ? `失败检查点：${failure.title}` : '',
          failure?.actorRoleId ? `角色：${failure.actorRoleId}` : '',
          failureCategory ? `分类：${failureCategory}` : '',
          errors[0] || '',
        ]
          .filter(Boolean)
          .join('；');
  const nextFlow = {
    ...flow,
    status: finalStatus,
    latestRunId: run.id,
    reportUrl: run.reportUrl || '',
    actualResult:
      finalStatus === 'passed'
        ? `流程通过，${checkpointResults.filter((item) => item.status === 'passed').length} 个检查点全部通过`
        : failureSummary,
    checkpointResults,
    failureSummary,
    failureCategory,
  };
  upsertFlowCases(root, [nextFlow]);
  upsertAutomationLinks(root, [
    {
      ...link,
      status: finalStatus,
      latestRunId: run.id,
      reportUrl: run.reportUrl || '',
      checkpointResults,
      failureSummary,
      failureCategory,
    },
  ]);
  return nextFlow;
}

function projectStore(root) {
  return readJson(uiautoStorePaths(root).projectsFile, { projects: [] });
}

function safeProjectFile(project, relativePath) {
  const projectDir = path.resolve(project.dir);
  const abs = path.resolve(projectDir, relativePath);
  if (!abs.startsWith(`${projectDir}${path.sep}`)) return null;
  return abs;
}

/**
 * 自动化链路必须和当前源用例、iteration 文件和脚本块保持一致。
 * 任一来源变化都只标记 stale，不删除历史结果，也不允许旧结果继续回写。
 */
export function refreshAutomationLinks(root, document) {
  if (!document?.path) return {};
  const all = readAutomationLinks(root);
  const targets = all.items.filter((item) => item.source?.casePath === document.path);
  if (!targets.length) return {};
  const projects = new Map(
    (projectStore(root).projects || []).map((item) => [String(item.id || ''), item]),
  );
  const cases = new Map(document.cases.map((item) => [item.id, item]));
  const changed = [];
  const refreshed = {};
  for (const link of targets) {
    let staleReason = '';
    const sources = link.caseKind === 'flow' && link.sources?.length ? link.sources : [link.source];
    for (const ref of sources) {
      const source =
        cases.get(ref?.caseId) ||
        document.cases.find(
          (item) => item.no === ref?.caseNo && (!ref?.title || item.title === ref.title),
        );
      if (!source) {
        staleReason = '来源功能用例已删除或无法匹配';
      } else if (ref?.fingerprint && caseContentFingerprint(source) !== ref.fingerprint) {
        staleReason = '来源功能用例内容已变化';
      }
      if (staleReason) break;
    }
    if (!staleReason && link.skillHash && caseAutomationSkillHash(root) !== link.skillHash) {
      staleReason = '功能用例转 UI 自动化技能已变化';
    }

    const project = projects.get(link.projectId);
    if (!staleReason && link.caseKind === 'flow' && link.dependencyHash) {
      const currentDependencyHash = automationDependencyHash(
        root,
        project,
        link.requiredRoleIds || [],
        link.businessSystemId || '',
        link.businessFlowId || '',
      );
      if (currentDependencyHash !== link.dependencyHash) {
        staleReason = '流程角色、业务地图或关键依赖已变化';
      }
    }
    const automationAbs = link.automationFilePath
      ? path.join(resolveContentRoot(root, '用例管理').abs, link.automationFilePath)
      : '';
    if (!staleReason && !project?.dir) {
      staleReason = 'UI 自动化项目不存在或未挂载';
    } else if (!staleReason && (!automationAbs || !fs.existsSync(automationAbs))) {
      staleReason = '自动化用例文件已缺失';
    } else if (
      !staleReason &&
      link.automationFileHash &&
      fileHash(automationAbs) !== link.automationFileHash
    ) {
      staleReason = '自动化用例文件已变化';
    } else if (!staleReason && !link.iterationFile) {
      staleReason = '自动化用例未绑定目标 iteration 文件';
    } else if (!staleReason) {
      const iterationAbs = safeProjectFile(project, link.iterationFile);
      if (!iterationAbs || !fs.existsSync(iterationAbs)) {
        staleReason = '目标 iteration 文件已缺失';
      } else if (link.scriptPath) {
        const scriptAbs = safeProjectFile(project, link.scriptPath);
        const content =
          scriptAbs && fs.existsSync(scriptAbs) ? fs.readFileSync(scriptAbs, 'utf8') : '';
        const marker = `/* lantern-automation:start ${link.automationCaseId} */`;
        if (!content.includes(marker)) staleReason = 'iteration 文件中的自动化测试块已缺失';
      }
    }
    let status = link.status;
    let staleReasonNext = link.staleReason || '';
    let lastStableStatus = link.lastStableStatus || '';
    if (staleReason) {
      if (status !== 'stale') lastStableStatus = status || 'connected';
      status = 'stale';
      staleReasonNext = staleReason;
    } else if (status === 'stale') {
      status = lastStableStatus || 'connected';
      staleReasonNext = '';
      lastStableStatus = '';
    }
    const next = {
      ...link,
      status,
      staleReason: staleReasonNext,
      lastStableStatus,
    };
    refreshed[link.automationCaseId] = next;
    if (
      next.status !== link.status ||
      next.staleReason !== (link.staleReason || '') ||
      next.lastStableStatus !== (link.lastStableStatus || '')
    ) {
      changed.push(next);
    }
  }
  if (changed.length) upsertAutomationLinks(root, changed);
  return refreshed;
}

async function executeBatch(root, batch) {
  batch.status = 'running';
  writeBatch(root, batch);
  const documents = new Map();
  for (const id of batch.automationCaseIds) {
    const link = findLink(root, id);
    const casePath = link?.source?.casePath;
    if (!casePath || documents.has(casePath)) continue;
    const document = await loadCaseDocument(root, casePath).catch(() => null);
    documents.set(casePath, document);
    if (document) refreshAutomationLinks(root, document);
  }
  for (const id of batch.automationCaseIds) {
    if (batch.stop) break;
    let link = findLink(root, id);
    const item = { automationCaseId: id, status: 'running' };
    batch.items.push(item);
    writeBatch(root, batch);
    if (!link) {
      item.status = 'failed';
      item.error = '自动化关联不存在';
      writeBatch(root, batch);
      continue;
    }
    if (link.status === 'stale') {
      item.status = 'failed';
      item.error = '自动化用例已过期';
      writeBatch(root, batch);
      continue;
    }
    if (!link.iterationFile) {
      item.status = 'failed';
      item.error = '缺少 iteration 文件绑定';
      writeBatch(root, batch);
      continue;
    }
    link = { ...link, status: 'running' };
    upsertAutomationLinks(root, [link]);
    const started = startAutomationProjectRun(root, {
      projectId: link.projectId,
      taskId: 'full',
      file: link.iterationFile,
      grep: link.tag,
      env: batch.env || '',
    });
    if (started.error) {
      upsertAutomationLinks(root, [
        { ...link, status: 'failed', error: started.error, latestRunId: '' },
      ]);
      item.status = 'failed';
      item.error = started.error;
      writeBatch(root, batch);
      continue;
    }
    batch.activeRunId = started.run.id;
    item.runId = started.run.id;
    writeBatch(root, batch);
    let run = started.run;
    while (!batch.stop && run.status === 'running') {
      await sleep(500);
      run = readAutomationProjectRun(root, started.run.id);
    }
    if (batch.stop) {
      stopAutomationProjectRun(started.run.id);
      item.status = 'failed';
      item.error = '用户已停止运行';
    } else {
      const status = runStatus(link, run);
      const tests = Array.isArray(run.tests) ? run.tests : [];
      const matched =
        tests.find((test) => test.automationCaseId === id) ||
        tests.find((test) => Array.isArray(test.tags) && test.tags.includes(link.tag));
      const errors = !matched
        ? [`运行报告未找到 automationCaseId ${id} 对应的测试结果`]
        : matched.errors?.length
          ? matched.errors
          : run.error
            ? [run.error]
            : [];
      const finalStatus = matched ? status : 'failed';
      const actual =
        errors.join('\n') || (finalStatus === 'passed' ? '自动化运行通过' : '自动化运行失败');
      let flowBeforeUpdate = null;
      if (link.caseKind === 'flow') {
        const flow = readFlowStore(root).items.find(
          (item) => item.flowCaseId === link.flowCaseId || item.automationCaseId === id,
        );
        if (flow) {
          flowBeforeUpdate = flow;
          const nextFlow = applyFlowRunResult(root, link, flow, matched, run, finalStatus, errors);
          link = {
            ...link,
            status: nextFlow.status,
            latestRunId: run.id,
            reportUrl: run.reportUrl || '',
            checkpointResults: nextFlow.checkpointResults,
            failureSummary: nextFlow.failureSummary,
            failureCategory: nextFlow.failureCategory,
          };
        }
      }
      link = {
        ...link,
        status: finalStatus,
        latestRunId: run.id,
        reportUrl: run.reportUrl || '',
        logUrl: run.logUrl || '',
        error: errors[0] || '',
      };
      upsertAutomationLinks(root, [link]);
      const rowUpdated = await updateAutomationRow(root, link, {
        运行状态: statusText(finalStatus),
        实际结果: actual,
        报告地址: run.reportUrl || '',
      }).catch(() => false);
      if (!rowUpdated) {
        if (flowBeforeUpdate) upsertFlowCases(root, [flowBeforeUpdate]);
        link = {
          ...link,
          status: 'failed',
          error: '自动化用例文件已变化，运行结果未能回写',
        };
        upsertAutomationLinks(root, [link]);
      }
      item.status = link.status;
      item.runId = run.id;
      item.reportUrl = run.reportUrl || '';
      item.error = link.error || errors[0] || '';
    }
    batch.activeRunId = '';
    writeBatch(root, batch);
  }
  await syncPassedSources(root, [
    ...new Set(
      batch.automationCaseIds.map((id) => findLink(root, id)?.source?.casePath).filter(Boolean),
    ),
  ]);
  batch.status = batch.stop ? 'stopped' : 'completed';
  writeBatch(root, batch);
  ACTIVE_BATCHES.delete(batch.id);
}

export function startBatch(root, raw) {
  const ids = (Array.isArray(raw.automationCaseIds) ? raw.automationCaseIds : [])
    .map(String)
    .filter(Boolean);
  if (!ids.length) fail('请选择要运行的自动化用例');
  if (ACTIVE_BATCHES.size) fail('已有自动化用例正在运行', 409);
  const links = ids.map((id) => findLink(root, id));
  if (links.some((item) => !item)) fail('存在无效的自动化用例');
  const flowOnly = links.find((item) => item?.caseKind !== 'flow' && item?.flowOnly === true);
  if (flowOnly) {
    fail(`自动化用例「${flowOnly.title}」依赖前序流程数据，请从对应冒烟/回归流程运行`, 422);
  }
  const batch = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    env: clean(raw.env, 80),
    automationCaseIds: ids,
    items: [],
    stop: false,
    activeRunId: '',
  };
  ACTIVE_BATCHES.set(batch.id, batch);
  writeBatch(root, batch);
  void executeBatch(root, batch).catch((error) => {
    batch.status = 'error';
    batch.error = error instanceof Error ? error.message : String(error);
    writeBatch(root, batch);
    if (batch.activeRunId) stopAutomationProjectRun(batch.activeRunId);
    ACTIVE_BATCHES.delete(batch.id);
  });
  return batch;
}

export function stopBatch(root, id) {
  const batch = ACTIVE_BATCHES.get(id) || readBatch(root, id);
  if (!batch) fail('运行批次不存在', 404);
  batch.stop = true;
  if (batch.activeRunId) stopAutomationProjectRun(batch.activeRunId);
  writeBatch(root, batch);
  return batch;
}

export function getBatch(root, id) {
  const batch = readBatch(root, id);
  if (!batch) fail('运行批次不存在', 404);
  if (['pending', 'running'].includes(batch.status) && !ACTIVE_BATCHES.has(id)) {
    batch.status = 'interrupted';
    batch.error = '本地服务已重启，原自动化运行已中断；可重新发起';
    writeBatch(root, batch);
  }
  return batch;
}

export async function syncPassedSources(root, casePaths) {
  for (const casePath of casePaths) {
    const document = await loadCaseDocument(root, casePath).catch(() => null);
    if (!document?.executable) continue;
    refreshAutomationLinks(root, document);
    const items = readAutomationLinks(root).items.filter(
      (item) => item.caseKind !== 'flow' && item.source?.casePath === casePath,
    );
    const caseIds = [...new Set(items.map((item) => item.source.caseId))];
    for (const caseId of caseIds) {
      const current = items.filter((item) => item.source.caseId === caseId);
      if (!current.length || !current.every((item) => item.status === 'passed')) continue;
      const row = document.cases.find((item) => item.id === caseId);
      if (!row) continue;
      const executor = clean(row.executor, 200);
      const manual =
        executor !== '自动化' &&
        (Boolean(executor) ||
          (clean(row.status, 20) && clean(row.status, 20) !== '待验证') ||
          Boolean(clean(row.executedAt, 80)));
      if (manual) continue;
      const evidence = current
        .map((item) => [item.latestRunId, item.logUrl, item.reportUrl].filter(Boolean).join(' | '))
        .filter(Boolean)
        .join('\n');
      const applied = await applyCaseExecutionResult(root, {
        path: casePath,
        expectedFileHash: document.fileHash,
        rowIndex: row.rowIndex,
        status: '通过',
        actualResult: '自动化脚本正式运行通过',
        executor: '自动化',
        executedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        evidence,
        defectNo: row.defectNo,
      }).catch(() => null);
      if (applied) document.fileHash = applied.fileHash;
    }
  }
}

export async function statuses(root, casePath) {
  const document = await loadCaseDocument(root, casePath);
  refreshAutomationLinks(root, document);
  const caseIds = document.cases.map((item) => item.id);
  const store = readAutomationLinks(root);
  const updates = store.items.filter(
    (item) =>
      item.source?.caseId &&
      caseIds.includes(item.source.caseId) &&
      item.source.casePath !== casePath,
  );
  if (updates.length) {
    upsertAutomationLinks(
      root,
      updates.map((item) => ({
        ...item,
        source: { ...item.source, casePath },
      })),
    );
  }
  return Object.fromEntries(
    caseIds.map((caseId) => [caseId, automationSummaryForCase(root, casePath, caseId)]),
  );
}

export async function refreshAutomationFile(root, casePath) {
  const document = await loadCaseDocument(root, casePath);
  refreshAutomationLinks(root, document);
  return document;
}
