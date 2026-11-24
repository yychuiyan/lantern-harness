import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startRun, getRun, stopRun, confirmRun } from './service.mjs';
import { loadCaseDocument, applyCaseExecutionResult } from './files.mjs';
import { caseContentFingerprint, recordManualVerification } from './assets.mjs';
import { isPluginOnInSpace } from '../plugin-prompts.mjs';
import {
  startAutomationProjectRun,
  stopAutomationProjectRun,
  readAutomationProjectRun,
} from '../lh-uiauto.mjs';

const active = new Map();
const folder = (root) => path.join(root, '.lantern', 'local', 'case-execution', 'plans');
const key = (root, id) => `${root}\0${id}`;
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function file(root, id) {
  if (!/^[a-z0-9-]{36}$/.test(id || '')) fail('计划编号无效');
  return path.join(folder(root), id + '.json');
}
function save(root, plan) {
  fs.mkdirSync(folder(root), { recursive: true });
  plan.updatedAt = new Date().toISOString();
  fs.writeFileSync(file(root, plan.id) + '.tmp', JSON.stringify(plan, null, 2), { mode: 0o600 });
  fs.renameSync(file(root, plan.id) + '.tmp', file(root, plan.id));
}
function view(plan) {
  return { ...plan, storageStatePath: plan.storageStatePath ? '[local]' : '' };
}
function read(root, id) {
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(file(root, id), 'utf8'));
  } catch {
    fail('执行计划不存在', 404);
  }
  if (plan.status === 'running' && !active.has(key(root, id))) {
    plan.status = 'interrupted';
    plan.error = '服务重启导致计划中断；可显式继续未完成项，已完成证据保留';
    plan.items.forEach((item) => {
      if (item.status === 'running') item.status = 'interrupted';
    });
    save(root, plan);
  }
  return plan;
}
export function listExecutionPlans(root, casePath = '') {
  if (!fs.existsSync(folder(root))) return [];
  return fs
    .readdirSync(folder(root))
    .filter((name) => name.endsWith('.json'))
    .map((name) => read(root, name.slice(0, -5)))
    .filter((plan) => !casePath || plan.casePath === casePath)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(view);
}
export function getExecutionPlan(root, id) {
  return view(read(root, id));
}
export async function createExecutionPlan(root, raw) {
  if (!String(raw.environment?.name || '').trim() || !String(raw.environment?.build || '').trim())
    fail('环境名称与被测构建版本不能为空');
  const document = await loadCaseDocument(root, raw.casePath);
  if (raw.expectedFileHash !== document.fileHash) fail('用例文件已变化，请重新选择计划范围', 409);
  if (document.provenance?.stale) fail('需求基线已变化，请先更新用例', 409);
  const selected = new Set(Array.isArray(raw.caseIds) ? raw.caseIds : []);
  const cases = document.cases.filter((item) => selected.has(item.id));
  if (!cases.length || cases.length !== selected.size) fail('请选择有效的用例范围');
  const engine = raw.engine === 'automation' ? 'automation' : 'browser';
  if (engine === 'browser' && !document.executable) fail(document.executionIssue, 422);
  if (engine === 'browser') {
    const url = new URL(raw.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      fail('目标地址必须为 HTTP / HTTPS');
  }
  if (engine === 'automation' && !String(raw.file || '').trim())
    fail('请选择指定测试文件，避免误运行整个项目');
  if (engine === 'automation' && !raw.projectId) fail('请选择已挂载的自动化项目');
  const plan = {
    version: 1,
    id: crypto.randomUUID(),
    casePath: document.path,
    fileHash: document.fileHash,
    provenance: document.provenance,
    engine,
    url: String(raw.url || ''),
    storageStatePath: String(raw.storageStatePath || ''),
    allowedOrigins: raw.allowedOrigins || [],
    environment: {
      name: String(raw.environment?.name || '').slice(0, 100),
      role: String(raw.environment?.role || '').slice(0, 100),
      build: String(raw.environment?.build || '').slice(0, 200),
      dataNote: String(raw.environment?.dataNote || '').slice(0, 2000),
    },
    projectId: String(raw.projectId || ''),
    taskId: String(raw.taskId || 'full'),
    setupTaskId: String(raw.setupTaskId || ''),
    cleanupTaskId: String(raw.cleanupTaskId || ''),
    file: String(raw.file || ''),
    items: cases.map((item) => ({
      caseId: item.id,
      title: item.title,
      fingerprint: caseContentFingerprint(item),
      status: 'pending',
      runId: '',
      error: '',
    })),
    status: 'draft',
    error: '',
    createdAt: new Date().toISOString(),
  };
  save(root, plan);
  return view(plan);
}
async function execute(root, plan, state) {
  try {
    const snapshot = await loadCaseDocument(root, plan.casePath);
    if (
      snapshot.provenance?.stale ||
      snapshot.provenance?.artifactId !== plan.provenance?.artifactId ||
      snapshot.provenance?.analysisRevision !== plan.provenance?.analysisRevision ||
      snapshot.provenance?.baselineId !== plan.provenance?.baselineId ||
      snapshot.provenance?.sourcePath !== plan.provenance?.sourcePath
    )
      fail('计划需求基线已变化，请重新创建计划');
    for (const item of plan.items) {
      const current = snapshot.cases.find((row) => row.id === item.caseId);
      if (!current || caseContentFingerprint(current) !== item.fingerprint)
        fail('计划用例已变化，请重新创建计划');
    }
    if (state.stop) {
      plan.status = 'stopped';
      return;
    }
    if (plan.engine === 'automation') {
      if (!isPluginOnInSpace('uiAuto', root)) fail('请开启自动化测试插件');
      const runTask = async (taskId, label) => {
        if (state.stop) return null;
        const result = startAutomationProjectRun(root, {
          projectId: plan.projectId,
          taskId,
          file: plan.file,
        });
        if (result.error) fail(result.error);
        state.externalRunId = result.run.id;
        plan.externalRunId = result.run.id;
        plan.taskRuns ||= [];
        plan.taskRuns.push({ label, runId: result.run.id, status: 'running' });
        save(root, plan);
        let run;
        do {
          run = readAutomationProjectRun(root, result.run.id);
          plan.externalResult = {
            id: run.id,
            status: run.status,
            total: run.total,
            passed: run.passed,
            failed: run.failed,
            skipped: run.skipped,
            reportUrl: run.reportUrl,
            logUrl: run.logUrl,
            error: run.error,
          };
          save(root, plan);
          if (state.stop || run.status !== 'running') break;
          await sleep(500);
        } while (true);
        plan.taskRuns[plan.taskRuns.length - 1].status = run.status;
        state.externalRunId = '';
        return run;
      };
      let result;
      try {
        if (plan.setupTaskId) {
          const setup = await runTask(plan.setupTaskId, '准备数据');
          if (setup?.status !== 'passed') fail('准备任务未成功，主测试未执行；请查看项目日志');
        }
        result = await runTask(plan.taskId, '测试执行');
      } finally {
        const primary = plan.externalResult;
        if (plan.cleanupTaskId && !state.stop) {
          const cleanup = await runTask(plan.cleanupTaskId, '清理数据');
          if (cleanup?.status !== 'passed') plan.cleanupWarning = '清理任务未成功，请人工清理数据';
        }
        plan.externalResult = primary;
      }
      if (!result) {
        plan.status = 'stopped';
        return;
      }
      plan.items.forEach((item) => {
        item.status = 'awaiting_confirmation';
        item.externalRunId = result.id;
      });
      plan.note = '自动化项目汇总不等于每条业务用例通过，请核对报告后逐条手动选择结果';
    } else
      for (const item of plan.items.filter((item) =>
        ['pending', 'interrupted'].includes(item.status),
      )) {
        if (state.stop) break;
        const document = await loadCaseDocument(root, plan.casePath);
        const row = document.cases.find((row) => row.id === item.caseId);
        if (
          !row ||
          caseContentFingerprint(row) !== item.fingerprint ||
          document.provenance?.stale ||
          document.provenance?.analysisRevision !== plan.provenance?.analysisRevision ||
          document.provenance?.baselineId !== plan.provenance?.baselineId
        )
          fail('用例内容或需求基线已变化，计划已阻塞');
        const run = await startRun(root, {
          casePath: plan.casePath,
          rowIndex: row.rowIndex,
          url: plan.url,
          storageStatePath: plan.storageStatePath,
          allowedOrigins: plan.allowedOrigins,
          environment: plan.environment,
        });
        state.runId = run.id;
        if (state.stop) stopRun(root, run.id);
        item.runId = run.id;
        item.status = 'running';
        save(root, plan);
        let latest = run;
        while (!state.stop && latest.status === 'running') {
          await sleep(500);
          latest = getRun(root, run.id);
        }
        item.status = state.stop ? 'interrupted' : 'awaiting_confirmation';
        item.error = latest.error || '';
        save(root, plan);
        state.runId = '';
      }
    plan.status = state.stop ? 'stopped' : 'awaiting_confirmation';
  } catch (error) {
    plan.status = state.stop ? 'stopped' : 'blocked';
    plan.error = state.stop ? '用户已停止计划；未完成项可显式继续' : error.message;
  } finally {
    save(root, plan);
    active.delete(key(root, plan.id));
  }
}
export function startExecutionPlan(root, id) {
  if (active.size) fail('已有执行计划运行中', 409);
  const plan = read(root, id);
  if (!['draft', 'interrupted', 'stopped', 'blocked'].includes(plan.status))
    fail('此计划不可重复启动；重跑请新建计划', 409);
  const state = { stop: false, runId: '', externalRunId: '' };
  active.set(key(root, id), state);
  plan.status = 'running';
  plan.error = '';
  save(root, plan);
  void execute(root, plan, state);
  return view(plan);
}
export function stopExecutionPlan(root, id) {
  const state = active.get(key(root, id));
  if (state) {
    state.stop = true;
    if (state.runId) stopRun(root, state.runId);
    if (state.externalRunId) stopAutomationProjectRun(state.externalRunId);
  }
  return view(read(root, id));
}

export async function verifyExecutionPlanItem(root, id, raw) {
  const plan = read(root, id);
  if (plan.status === 'running' || active.has(key(root, id)))
    fail('计划仍在执行，请结束或停止后验证', 409);
  const item = plan.items.find((item) => item.caseId === raw.caseId);
  if (!item || (!item.runId && !item.externalRunId)) fail('该用例没有本计划的执行记录', 409);
  const document = await loadCaseDocument(root, plan.casePath);
  const row = document.cases.find((row) => row.id === item.caseId);
  if (
    !row ||
    caseContentFingerprint(row) !== item.fingerprint ||
    document.provenance?.stale ||
    document.provenance?.baselineId !== plan.provenance?.baselineId
  )
    fail('计划用例或需求基线已变化，请重新执行', 409);
  if (!String(raw.actualResult || '').trim()) fail('请先填写人工核验的实际结果');
  let applied;
  if (item.runId) {
    applied = await confirmRun(root, item.runId, {
      ...raw,
      executor: '人工验证',
      expectedFileHash: raw.expectedFileHash,
    });
  } else {
    applied = await applyCaseExecutionResult(root, {
      path: plan.casePath,
      rowIndex: row.rowIndex,
      expectedFileHash: raw.expectedFileHash,
      status: raw.status,
      actualResult: String(raw.actualResult),
      executor: '人工验证',
      executedAt: new Date().toISOString(),
      evidence: plan.externalResult?.reportUrl || plan.externalResult?.logUrl || '',
      defectNo: row.defectNo,
    });
    recordManualVerification(
      root,
      await loadCaseDocument(root, plan.casePath),
      row.rowIndex,
      plan.environment,
    );
  }
  item.finalStatus = raw.status;
  item.status = 'verified';
  item.verifiedAt = new Date().toISOString();
  if (plan.items.every((item) => item.status === 'verified')) plan.status = 'completed';
  save(root, plan);
  return { ok: true, plan: view(plan), applied };
}
