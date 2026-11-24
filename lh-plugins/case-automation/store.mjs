import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';

export const AUTOMATION_STATUSES = [
  'not_configured',
  'automatable',
  'needs_manual',
  'not_automatable',
  'connected',
  'running',
  'passed',
  'failed',
  'partial',
  'stale',
  'not_applicable',
];

const rootDir = (root) => path.join(path.resolve(root), '.lantern', 'local', 'case-automation');
export const linksPath = (root) => path.join(rootDir(root), 'links.json');
export const assessmentsDir = (root) => path.join(rootDir(root), 'assessments');
export const batchesDir = (root) => path.join(rootDir(root), 'runs');
export const projectsMapPath = (root) => spaceLocalFile(root, 'case-automation/projects.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

export function readAutomationLinks(root) {
  const data = readJson(linksPath(root), { version: 1, items: [] });
  return Array.isArray(data?.items) ? data : { version: 1, items: [] };
}

export function writeAutomationLinks(root, data) {
  writeJson(linksPath(root), { version: 1, items: data.items || [] });
}

export function upsertAutomationLinks(root, incoming) {
  const store = readAutomationLinks(root);
  const byId = new Map(store.items.map((item) => [item.automationCaseId, item]));
  for (const item of incoming) {
    const previous = byId.get(item.automationCaseId) || {};
    byId.set(item.automationCaseId, {
      ...previous,
      ...item,
      createdAt: previous.createdAt || item.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  const next = { version: 1, items: [...byId.values()] };
  writeAutomationLinks(root, next);
  return next;
}

export function linksForSource(root, casePath, caseId = '') {
  return readAutomationLinks(root).items.filter(
    (item) => item.source?.casePath === casePath && (!caseId || item.source?.caseId === caseId),
  );
}

export function readAssessment(root, id) {
  if (!/^[a-z0-9-]{36}$/i.test(String(id || ''))) return null;
  return readJson(path.join(assessmentsDir(root), `${id}.json`), null);
}

export function writeAssessment(root, record) {
  writeJson(path.join(assessmentsDir(root), `${record.id}.json`), record);
  return record;
}

export function readProjectMap(root) {
  const data = readJson(projectsMapPath(root), { version: 1, files: {} });
  return data && typeof data === 'object' ? data : { version: 1, files: {} };
}

export function rememberProjectSelection(root, casePath, projectId, iteration) {
  const data = readProjectMap(root);
  data.files = data.files || {};
  data.files[casePath] = { projectId, iteration, updatedAt: new Date().toISOString() };
  writeJson(projectsMapPath(root), data);
}

export function readBatch(root, id) {
  if (!/^[a-z0-9-]{36}$/i.test(String(id || ''))) return null;
  return readJson(path.join(batchesDir(root), `${id}.json`), null);
}

export function writeBatch(root, batch) {
  writeJson(path.join(batchesDir(root), `${batch.id}.json`), {
    ...batch,
    updatedAt: new Date().toISOString(),
  });
  return batch;
}

function aggregate(items, assessments) {
  const current = [...items, ...assessments];
  if (!current.length) return { status: 'not_configured', total: 0, passed: 0, failed: 0 };
  if (current.some((item) => item.status === 'stale')) {
    return { status: 'stale', total: items.length, passed: 0, failed: 0 };
  }
  if (current.some((item) => item.status === 'running')) {
    return {
      status: 'running',
      total: items.length,
      passed: items.filter((item) => item.status === 'passed').length,
      failed: items.filter((item) => item.status === 'failed').length,
    };
  }
  if (items.some((item) => item.status === 'failed')) {
    return {
      status: 'failed',
      total: items.length,
      passed: items.filter((item) => item.status === 'passed').length,
      failed: items.filter((item) => item.status === 'failed').length,
    };
  }
  if (items.length && items.every((item) => item.status === 'passed')) {
    return { status: 'passed', total: items.length, passed: items.length, failed: 0 };
  }
  if (items.some((item) => item.status === 'passed')) {
    return {
      status: 'partial',
      total: items.length,
      passed: items.filter((item) => item.status === 'passed').length,
      failed: items.filter((item) => item.status === 'failed').length,
    };
  }
  if (items.length) {
    return {
      status: 'connected',
      total: items.length,
      passed: 0,
      failed: items.filter((item) => item.status === 'failed').length,
    };
  }
  if (current.every((item) => item.status === 'not_automatable'))
    return { status: 'not_automatable', total: 0, passed: 0, failed: 0 };
  if (current.every((item) => item.status === 'needs_manual'))
    return { status: 'needs_manual', total: 0, passed: 0, failed: 0 };
  if (current.some((item) => item.status === 'automatable'))
    return { status: 'automatable', total: 0, passed: 0, failed: 0 };
  return { status: 'connected', total: 0, passed: 0, failed: 0 };
}

export function automationSummaryForCase(root, casePath, caseId) {
  const links = readAutomationLinks(root).items.filter(
    (item) =>
      (item.source?.casePath === casePath && item.source?.caseId === caseId) ||
      (caseId && item.source?.caseId === caseId),
  );
  const store = readProjectMap(root);
  const assessments = Array.isArray(store.assessments?.[caseId]) ? store.assessments[caseId] : [];
  const summary = aggregate(links, assessments);
  return {
    ...summary,
    items: links.map((item) => ({
      automationCaseId: item.automationCaseId,
      title: item.title,
      status: item.status,
      projectId: item.projectId,
      projectName: item.projectName || '',
      framework: item.framework || '',
      iteration: item.iteration || '',
      iterationFile: item.iterationFile || '',
      tag: item.tag || '',
      scriptPath: item.scriptPath || '',
      lastRunId: item.latestRunId || '',
      reportUrl: item.reportUrl || '',
      logUrl: item.logUrl || '',
      error: item.staleReason || item.error || '',
      updatedAt: item.updatedAt || '',
    })),
  };
}

export function automationSummaryForFile(root, casePath) {
  const links = readAutomationLinks(root).items.filter(
    (item) => item.source?.casePath === casePath,
  );
  const data = readProjectMap(root);
  const assessments = Object.values(data.assessments || {})
    .flatMap((items) => (Array.isArray(items) ? items : []))
    .filter((item) => item.sourcePath === casePath);
  if (!links.length && !assessments.length) return null;
  const statuses = [
    ...links.map((item) => item.status || 'connected'),
    ...assessments.map((item) => item.status || 'needs_manual'),
  ];
  let status = 'connected';
  if (statuses.includes('stale')) status = 'stale';
  else if (statuses.includes('running')) status = 'running';
  else if (statuses.includes('failed')) status = 'failed';
  else if (statuses.includes('passed') && statuses.every((value) => value === 'passed'))
    status = 'passed';
  else if (statuses.includes('passed') || statuses.includes('partial')) status = 'partial';
  else if (statuses.includes('needs_manual')) status = 'needs_manual';
  else if (statuses.every((value) => value === 'not_automatable')) status = 'not_automatable';
  return {
    status,
    total: links.length,
    passed: links.filter((item) => item.status === 'passed').length,
    failed: links.filter((item) => item.status === 'failed').length,
  };
}

export function rememberAssessments(root, sourcePath, caseId, entries) {
  const data = readProjectMap(root);
  data.assessments = data.assessments || {};
  data.assessments[caseId] = entries.map((item) => ({
    status: item.decision,
    reason: item.reason || '',
    sourcePath,
    automationCaseId: item.automationCaseId || '',
    updatedAt: new Date().toISOString(),
  }));
  writeJson(projectsMapPath(root), data);
}
