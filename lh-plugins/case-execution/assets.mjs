import { resolveContentRoot } from '../../builtin/session/space-layout.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { reqAnalysisStorePath, reqDocsDir } from '../lh-req-analysis.mjs';
import { analysisRevision } from '../req-analysis-revision.mjs';

const storePath = (root) => path.join(root, '.lantern', 'local', 'case-workflow', 'assets.json');
export const fingerprint = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readWorkflowAssets(root) {
  try {
    return JSON.parse(fs.readFileSync(storePath(root), 'utf8'));
  } catch {
    return { version: 1, artifacts: [] };
  }
}
export function saveWorkflowAssets(root, store) {
  const file = storePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export function analysisSnapshot(root, analysisId) {
  let docs;
  try {
    docs = JSON.parse(fs.readFileSync(reqAnalysisStorePath(root), 'utf8')).docs || [];
  } catch {
    docs = [];
  }
  const doc = docs.find((item) => item.id === analysisId);
  if (!doc) throw Object.assign(new Error('需求分析不存在'), { statusCode: 404 });
  return doc;
}
export function sourceFileHash(root, sourcePath) {
  if (!sourcePath) return '';
  const base = path.resolve(reqDocsDir(root)),
    abs = path.resolve(base, sourcePath);
  if (!abs.startsWith(base + path.sep) || !fs.existsSync(abs)) return '';
  return fingerprint(fs.readFileSync(abs).toString('base64'));
}
export function artifactStaleness(root, artifact) {
  if (!artifact) return { stale: false, tracked: false, reasons: ['历史文件尚未关联需求基线'] };
  const reasons = [];
  if (artifact.analysisId) {
    try {
      if (
        analysisRevision(analysisSnapshot(root, artifact.analysisId)) !== artifact.analysisRevision
      )
        reasons.push('需求分析已变化');
    } catch {
      reasons.push('来源需求分析已删除');
    }
  }
  if (
    artifact.sourceFileHash &&
    sourceFileHash(root, artifact.sourcePath) !== artifact.sourceFileHash
  )
    reasons.push('需求源文件已变化或缺失');
  return {
    stale: !!reasons.length,
    tracked: !!(artifact.analysisId || artifact.sourcePath),
    reasons,
  };
}
export function caseContentFingerprint(item) {
  return fingerprint([
    item.title,
    item.precondition,
    item.steps,
    item.expected,
    (item.fields || [])
      .filter((field) => /需求|requirement|reqcite|reqpoint|outline/i.test(field.name))
      .map((field) => [field.name, field.value]),
  ]);
}
export function bindCaseIdentities(root, document) {
  const store = readWorkflowAssets(root);
  const caseDir = resolveContentRoot(root, '用例管理').abs;
  const moved = (item) => !fs.existsSync(path.join(caseDir, item.path));
  let artifact =
    store.artifacts.find((item) => item.path === document.path) ||
    store.artifacts.find(
      (item) =>
        moved(item) && (item.fileHash === document.fileHash || item.paths?.includes(document.path)),
    );

  if (!artifact) {
    artifact = {
      id: crypto.randomUUID(),
      baselineId: crypto.randomUUID(),
      path: document.path,
      paths: [],
      fileHash: document.fileHash,
      bindings: [],
    };
    store.artifacts.push(artifact);
  }
  if (artifact.path !== document.path) {
    artifact.paths = [...new Set([...(artifact.paths || []), artifact.path])];
    artifact.path = document.path;
  }
  artifact.baselineId ||= crypto.randomUUID();
  const used = new Set();
  document.cases.forEach((item) => {
    const contentHash = caseContentFingerprint(item);
    const noUnique = item.no && document.cases.filter((row) => row.no === item.no).length === 1;
    let binding = artifact.bindings.find(
      (old) => !used.has(old.id) && old.contentHash === contentHash && old.no === item.no,
    );
    if (!binding && noUnique)
      binding = artifact.bindings.find((old) => !used.has(old.id) && old.no === item.no);
    if (!binding) binding = { id: crypto.randomUUID(), no: item.no, contentHash };
    used.add(binding.id);
    item.id = binding.id;
    item.contentFingerprint = contentHash;
    binding.no = item.no;
    binding.contentHash = contentHash;
    if (!artifact.bindings.some((old) => old.id === binding.id)) artifact.bindings.push(binding);
  });
  artifact.fileHash = document.fileHash;
  saveWorkflowAssets(root, store);
  document.provenance = {
    artifactId: artifact.id,
    baselineId: artifact.baselineId,
    sourceFileHash: artifact.sourceFileHash || '',
    analysisId: artifact.analysisId || '',
    analysisRevision: artifact.analysisRevision || '',
    sourcePath: artifact.sourcePath || '',
    ...artifactStaleness(root, artifact),
  };
  for (const item of document.cases) {
    const verification = artifact.verifications?.[item.id];
    const invalid =
      document.provenance.stale ||
      artifact.needsReview?.includes(item.id) ||
      (verification && verification.contentFingerprint !== item.contentFingerprint);
    if (invalid) {
      item.storedStatus = item.status;
      item.status = '待验证';
      item.resultStale = true;
    }
  }
  return document;
}

export function linkCaseArtifact(root, document, source = {}) {
  const store = readWorkflowAssets(root),
    artifact = store.artifacts.find((item) => item.id === document.provenance.artifactId);
  if (!artifact) throw new Error('用例资产未登记');
  Object.assign(artifact, source, {
    baselineId: crypto.randomUUID(),
    createdAt: artifact.createdAt || new Date().toISOString(),
  });
  saveWorkflowAssets(root, store);
  return artifact;
}

export function recordManualVerification(root, document, rowIndex, environment) {
  const item = document.cases[rowIndex];
  const store = readWorkflowAssets(root),
    artifact = store.artifacts.find((asset) => asset.id === document.provenance.artifactId);
  if (!artifact || !item) return;
  artifact.verifications ||= {};
  artifact.verifications[item.id] = {
    at: new Date().toISOString(),
    source: 'manual',
    contentFingerprint: caseContentFingerprint(item),
    analysisRevision: artifact.analysisRevision || '',
    baselineId: artifact.baselineId,
    sourceFileHash: artifact.sourceFileHash || '',
    status: item.storedStatus || item.status,
    environment: environment || artifact.verifications[item.id]?.environment || {},
  };
  artifact.verificationHistory ||= [];
  artifact.verificationHistory.push({ caseId: item.id, ...artifact.verifications[item.id] });
  artifact.verificationHistory = artifact.verificationHistory.slice(-10000);
  artifact.needsReview = (artifact.needsReview || []).filter((id) => id !== item.id);
  saveWorkflowAssets(root, store);
}
