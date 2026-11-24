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
  saveGeneratedSession,
} from '../uiauto-explorer/sessions.mjs';
import { normalizePlan, PLAN_ACTIONS } from '../uiauto-explorer/plan.mjs';
import { applyCaseExecutionResult, loadCaseDocument } from '../case-execution/files.mjs';
import { caseContentFingerprint } from '../case-execution/assets.mjs';
import { CASE_AUTOMATION_PROMPT_FILE } from '../case-automation-prompt.mjs';
import { backupFile, fileHash, readTable, writeTableAtomic } from './tables.mjs';
import {
  readAssessment,
  readAutomationLinks,
  readProjectMap,
  rememberAssessments,
  rememberProjectSelection,
  upsertAutomationLinks,
  writeAssessment,
  writeBatch,
  readBatch,
  automationSummaryForCase,
} from './store.mjs';

const ACTIVE_BATCHES = new Map();
const AUTOMATION_HEADERS = [
  '自动化用例编号',
  '来源用例文件',
  '来源用例编号',
  '自动化用例标题',
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
const clean = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function projectRecord(root, projectId) {
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

function normalizeIteration(raw) {
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
  return publicDocument;
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

function normalizeAssessments(raw, cases, project, iteration, iterationFile) {
  const results = Array.isArray(raw?.cases) ? raw.cases : [];
  return cases.map((source) => {
    const hit = results.find((item) => clean(item?.sourceCaseId, 100) === source.id);
    const decision = DECISIONS.has(hit?.decision) ? hit.decision : 'needs_manual';
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
          (source.priority === 'P0'
            ? '@smoke'
            : source.priority === 'P1'
              ? '@regression'
              : '@edge'),
        plan,
        automationTag: `@lantern-${automationCaseId.toLowerCase()}`,
        projectId: project.id,
        projectName: project.name,
        framework: project.framework,
        iteration,
        iterationFile,
      });
    }
    const finalDecision =
      decision === 'automatable' && !automationCases.length ? 'needs_manual' : decision;
    return {
      sourceCaseId: source.id,
      sourceCaseNo: source.no,
      sourceTitle: source.title,
      sourceFingerprint: caseContentFingerprint(source),
      decision: finalDecision,
      reason:
        clean(hit?.reason, 4000) ||
        (finalDecision === 'needs_manual' ? '缺少可执行的 UI Plan 或需要人工条件' : ''),
      risks: (Array.isArray(hit?.risks) ? hit.risks : [])
        .map((risk) => clean(risk, 1000))
        .filter(Boolean)
        .slice(0, 20),
      automationCases,
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
  });
  for (const item of normalized) {
    rememberAssessments(root, casePath, item.sourceCaseId, [
      {
        decision: item.decision,
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

function automationFileTarget(root, sourcePath) {
  const dir = path.join(resolveContentRoot(root, '用例管理').abs, '自动化测试');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, automationFileName(sourcePath));
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
  if (!fs.existsSync(iterationAbs)) {
    fs.mkdirSync(path.dirname(iterationAbs), { recursive: true });
    fs.writeFileSync(
      iterationAbs,
      `// ${assessment.iteration} 迭代 UI 自动化用例\n// 由 Lantern 功能用例自动化转换创建，后续测试块会合并到此文件。\n`,
      { flag: 'wx' },
    );
  }
  const document = await loadCaseDocument(root, assessment.sourcePath);
  if (document.fileHash !== assessment.sourceFileHash) fail('功能用例文件已变化，请重新评估', 409);
  const selected = new Set(
    (Array.isArray(raw.selectedSourceCaseIds) ? raw.selectedSourceCaseIds : []).map(String),
  );
  if (!selected.size) fail('请至少选择一条有效转换结果');
  const chosen = assessment.cases.filter((item) => selected.has(item.sourceCaseId));
  if (!chosen.length) fail('请至少选择一条有效转换结果');
  const target = automationFileTarget(root, assessment.sourcePath);
  const ext = path.extname(target).toLowerCase();
  const existing = await readTable(target, ext);
  const headers = [...new Set([...AUTOMATION_HEADERS, ...existing.headers])];
  const rows = existing.rows.slice();
  const byId = new Map(rows.map((row, index) => [row['自动化用例编号'], index]));
  const links = [];
  const backup = backupFile(target);
  let createdSessions = 0;
  for (const result of chosen) {
    if (!['automatable', 'needs_manual'].includes(result.decision)) continue;
    const source = document.cases.find((item) => item.id === result.sourceCaseId);
    if (!source) continue;
    const candidates =
      result.decision === 'needs_manual'
        ? [
            {
              automationCaseId: `AUTO-${crypto
                .createHash('sha256')
                .update(`${source.id}\0manual`)
                .digest('hex')
                .slice(0, 12)
                .toUpperCase()}`,
              title: source.title,
              precondition: source.precondition,
              steps: [source.steps],
              expected: source.expected,
              priority: source.priority || 'P2',
              tag: '@edge',
              plan: [],
              automationTag: '',
            },
          ]
        : result.automationCases;
    for (const item of candidates) {
      const row = {
        ...Object.fromEntries(headers.map((header) => [header, ''])),
        自动化用例编号: item.automationCaseId,
        来源用例文件: assessment.sourcePath,
        来源用例编号: source.no || '',
        自动化用例标题: item.title,
        引用需求点: sourceRefs(source),
        前置条件: item.precondition,
        自动化步骤: item.steps.join('\n'),
        预期结果: item.expected,
        优先级: item.priority,
        可行性: result.decision === 'automatable' ? '可自动化' : '需人工辅助',
        自动化项目: assessment.projectName,
        迭代版本: assessment.iteration,
        目标迭代文件: assessment.iterationFile,
        测试标签: item.automationTag || '',
        脚本状态: result.decision === 'automatable' ? '待探索' : '需人工补充',
        运行状态: '待运行',
        实际结果: '',
        报告地址: '',
        说明: result.reason,
      };
      const index = byId.get(item.automationCaseId);
      if (index == null) {
        byId.set(item.automationCaseId, rows.length);
        rows.push(row);
      } else {
        rows[index] = { ...rows[index], ...row, 运行状态: rows[index]['运行状态'] || '待运行' };
      }
      let uiSessionId = '';
      if (result.decision === 'automatable') {
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
        if (!existingSession) createdSessions += 1;
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
        projectId: assessment.projectId,
        projectName: assessment.projectName,
        framework: assessment.framework,
        iteration: assessment.iteration,
        iterationFile: assessment.iterationFile,
        automationFilePath: path
          .relative(resolveContentRoot(root, '用例管理').abs, target)
          .replaceAll(path.sep, '/'),
        tag: item.automationTag,
        uiSessionId,
        status: result.decision === 'automatable' ? 'connected' : 'needs_manual',
      });
    }
  }
  try {
    const written = await writeTableAtomic(target, ext, headers, rows);
    upsertAutomationLinks(
      root,
      links.map((link) => ({ ...link, automationFileHash: written.fileHash })),
    );
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
    throw error;
  }
}

function findLink(root, automationCaseId) {
  return readAutomationLinks(root).items.find((item) => item.automationCaseId === automationCaseId);
}

async function updateAutomationRow(root, link, values) {
  const base = resolveContentRoot(root, '用例管理').abs;
  const file = path.join(base, link.automationFilePath);
  if (!fs.existsSync(file)) return false;
  const ext = path.extname(file).toLowerCase();
  const expected = link.automationFileHash || '';
  if (expected && fileHash(file) !== expected) return false;
  const table = await readTable(file, ext);
  const index = table.rows.findIndex((row) => row['自动化用例编号'] === link.automationCaseId);
  if (index < 0) return false;
  const backup = backupFile(file);
  table.rows[index] = { ...table.rows[index], ...values };
  const written = await writeTableAtomic(file, ext, table.headers, table.rows);
  upsertAutomationLinks(root, [
    { ...link, ...values, automationFileHash: written.fileHash, backup },
  ]);
  return true;
}

function runStatus(link, run) {
  if (!run || run.status === 'cancelled' || run.status === 'interrupted') return 'failed';
  if (run.status === 'error' || run.error) return 'failed';
  if (run.flaky > 0) return 'failed';
  return run.status === 'passed' ? 'passed' : 'failed';
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
    const source = cases.get(link.source?.caseId);
    if (!source) {
      staleReason = '来源功能用例已删除或无法匹配';
    } else if (
      link.source?.fingerprint &&
      caseContentFingerprint(source) !== link.source.fingerprint
    ) {
      staleReason = '来源功能用例内容已变化';
    }

    const project = projects.get(link.projectId);
    const automationAbs = link.automationFilePath
      ? path.join(resolveContentRoot(root, '用例管理').abs, link.automationFilePath)
      : '';
    if (!staleReason && !project?.dir) {
      staleReason = 'UI 自动化项目不存在或未挂载';
    } else if (!staleReason && (!automationAbs || !fs.existsSync(automationAbs))) {
      staleReason = '自动化用例文件已缺失';
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
      if (!rowUpdated && finalStatus === 'passed') {
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

async function syncPassedSources(root, casePaths) {
  for (const casePath of casePaths) {
    const document = await loadCaseDocument(root, casePath).catch(() => null);
    if (!document?.executable) continue;
    refreshAutomationLinks(root, document);
    const items = readAutomationLinks(root).items.filter(
      (item) => item.source?.casePath === casePath,
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
