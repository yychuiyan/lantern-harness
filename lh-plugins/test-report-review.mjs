/**
 * 测试报告整理：从真实用例、测试统计和执行记录形成上下文，
 * 生成可比较草稿，再由用户确认后原子写入报告文件。
 */
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot } from '../builtin/session/space-layout.mjs';
import { listCaseDocuments, loadCaseDocument } from './case-execution/files.mjs';
import { createReviewDraftStore, hashValue, nowIso, writeTextAtomic } from './review-drafts.mjs';

const PREFIX = '/__tb_test_report_review';
const DRAFTS_REL = 'test-report-review/drafts.json';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 600_000;

const KINDS = {
  functional: {
    label: '功能测试报告',
    reportFolder: '功能测试报告',
    caseFolders: ['功能测试'],
    dimensions: ['功能测试用例', '测试报告', '缺陷统计'],
  },
  api: {
    label: '接口测试报告',
    reportFolder: '接口测试报告',
    caseFolders: ['接口测试'],
    dimensions: ['接口测试用例', '测试报告', '缺陷统计'],
  },
  perf: {
    label: '性能测试报告',
    reportFolder: '性能测试报告',
    caseFolders: ['性能测试'],
    dimensions: ['性能测试用例', '测试报告', '缺陷统计'],
  },
};

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(Object.assign(new Error('提交内容太大（上限 8MB）'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function text(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function date(value) {
  const next = text(value, 10);
  return DATE_RE.test(next) ? next : '';
}

function fileHash(file) {
  try {
    return requireHash(fs.readFileSync(file));
  } catch {
    return '';
  }
}

function requireHash(buffer) {
  return hashValue(buffer.toString('base64'));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function kindDef(raw) {
  const kind = text(raw, 20);
  const def = KINDS[kind];
  if (!def) throw Object.assign(new Error('请选择有效的测试报告类型'), { statusCode: 400 });
  return { kind, def };
}

function safeReportPath(root, id, rawPath, title = '') {
  const { def } = kindDef(id);
  const rootAbs = resolveContentRoot(root, '报告管理').abs;
  const base = path.join(rootAbs, def.reportFolder);
  const fallback = path.join(def.reportFolder, `${title || `${def.label}-草稿`}.md`);
  const rel = text(rawPath || fallback, 500).replaceAll('\\', '/');
  const abs = path.resolve(rootAbs, rel);
  if (!abs.startsWith(base + path.sep) && abs !== base) {
    throw Object.assign(new Error(`报告必须保存在 ${def.reportFolder} 目录内`), {
      statusCode: 400,
    });
  }
  if (!abs.startsWith(rootAbs + path.sep)) {
    throw Object.assign(new Error('报告路径越界'), { statusCode: 403 });
  }
  const ext = path.extname(abs).toLowerCase();
  if (!['.md', '.txt'].includes(ext)) {
    throw Object.assign(new Error('测试报告草稿只支持 .md / .txt；其它格式请先另存'), {
      statusCode: 415,
    });
  }
  return {
    rel: path.relative(rootAbs, abs).split(path.sep).join('/'),
    abs,
    ext,
  };
}

function filterCaseDocuments(documents, def, requestedPaths) {
  const requested = Array.isArray(requestedPaths)
    ? requestedPaths.map((item) => text(item, 500)).filter(Boolean)
    : [];
  if (requested.length) {
    const byPath = new Map(documents.map((item) => [item.path, item]));
    const missing = requested.filter((item) => !byPath.has(item));
    if (missing.length) {
      throw Object.assign(new Error(`用例文件不存在：${missing.join('、')}`), {
        statusCode: 404,
      });
    }
    return requested.map((item) => byPath.get(item));
  }
  const typed = documents.filter((item) =>
    def.caseFolders.some((folder) => item.path === folder || item.path.startsWith(`${folder}/`)),
  );
  if (typed.length) return typed;
  // 旧空间可能把用例平铺在用例根目录，文件名仍保留“功能测试用例”等类型词。
  return documents.filter((item) => def.caseFolders.some((folder) => item.path.includes(folder)));
}

function aggregateCases(documents) {
  const statuses = {
    total: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    pending: 0,
    executed: 0,
    defects: 0,
  };
  const defects = new Set();
  for (const item of documents) {
    for (const row of item.cases || []) {
      statuses.total += 1;
      const value = String(row.status || '').trim();
      if (value === '通过') statuses.passed += 1;
      else if (value === '不通过') statuses.failed += 1;
      else if (value === '阻塞') statuses.blocked += 1;
      else if (value === '跳过') statuses.skipped += 1;
      else statuses.pending += 1;
      if (value && value !== '待验证') statuses.executed += 1;
      if (row.defectNo) defects.add(String(row.defectNo));
    }
  }
  statuses.defects = defects.size;
  statuses.passRate = statuses.executed
    ? Math.round((statuses.passed / statuses.executed) * 10000) / 100
    : null;
  return statuses;
}

function loadTestStats(root, def, from, to) {
  const file = path.join(resolveContentRoot(root, '测试统计').abs, '测试统计.json');
  const store = readJson(file, { items: [] });
  const wanted = new Set(def.dimensions);
  const items = (Array.isArray(store.items) ? store.items : []).filter((item) => {
    if (!item || item.draft === true) return false;
    if (!Array.isArray(item.dimensions) || !item.dimensions.some((name) => wanted.has(name))) {
      return false;
    }
    if (from && String(item.date || '') < from) return false;
    if (to && String(item.date || '') > to) return false;
    return true;
  });
  return {
    file,
    items: items.map((item) => ({
      id: String(item.id || ''),
      date: String(item.date || ''),
      dimension: String(item.dimensions?.[0] || ''),
      count: Number(item.count) || 0,
    })),
  };
}

function loadCaseExec(root, def, from, to) {
  const file = path.join(resolveContentRoot(root, '用例执行统计').abs, '用例执行统计.json');
  const store = readJson(file, { items: [] });
  const items = (Array.isArray(store.items) ? store.items : []).filter((item) => {
    if (!item || item.draft === true) return false;
    const project = String(item.project || '');
    if (
      !def.caseFolders.some(
        (folder) => project.includes(folder.replace('测试', '')) || project.includes(folder),
      )
    ) {
      return false;
    }
    const sample = String(item.date || '');
    if (from && sample < from) return false;
    if (to && sample > to) return false;
    return true;
  });
  return {
    file,
    items: items.map((item) => ({
      id: String(item.id || ''),
      date: String(item.date || ''),
      project: String(item.project || ''),
      total: Number(item.total) || 0,
      pending: Number(item.pending) || 0,
      executed: Number(item.executed) || 0,
    })),
  };
}

async function buildContext(root, raw) {
  const { kind, def } = kindDef(raw.kind);
  const from = date(raw.from);
  const to = date(raw.to);
  if (from && to && from > to)
    throw Object.assign(new Error('开始日期不能晚于结束日期'), { statusCode: 400 });
  const allDocuments = await listCaseDocuments(root);
  const selected = filterCaseDocuments(allDocuments, def, raw.casePaths);
  const documents = [];
  for (const file of selected) {
    let document = null;
    try {
      document = await loadCaseDocument(root, file.path);
    } catch {
      // 解析失败的文件仍作为缺口返回，不能悄悄当作 0 条。
    }
    documents.push({
      path: file.path,
      size: file.size,
      modifiedAt: file.mtime,
      fileHash: document?.fileHash || '',
      parseError: document ? '' : file.executionIssue || file.error || '无法解析用例文件',
      headers: document?.headers || [],
      cases: document?.cases || [],
    });
  }
  const target = safeReportPath(root, kind, raw.reportPath, text(raw.title, 120));
  const reportHash = fileHash(target.abs);
  const reportText = fs.existsSync(target.abs) ? fs.readFileSync(target.abs, 'utf8') : '';
  const stats = aggregateCases(documents);
  const testStats = loadTestStats(root, def, from, to);
  const caseExec = loadCaseExec(root, def, from, to);
  const gaps = [];
  if (!documents.length) gaps.push('未选择可读取的用例文件，报告不能据此生成执行统计。');
  for (const document of documents) {
    if (document.parseError) gaps.push(`${document.path}：${document.parseError}`);
    if (document.cases.length && !document.headers.some((header) => /状态|结果/.test(header))) {
      gaps.push(`${document.path}：缺少用例状态列，无法计算真实通过率。`);
    }
  }
  if (!testStats.items.length) gaps.push('所选日期范围内没有匹配的测试统计记录。');
  if (!caseExec.items.length) gaps.push('所选日期范围内没有匹配的用例执行统计记录。');
  const sourceSnapshot = {
    kind,
    from,
    to,
    documents: documents.map((item) => ({
      path: item.path,
      fileHash: item.fileHash,
      parseError: item.parseError,
    })),
    testStats: testStats.items,
    caseExec: caseExec.items,
  };
  const sourceRevision = hashValue(sourceSnapshot);
  const revision = hashValue({
    sourceRevision,
    reportPath: target.rel,
    reportHash,
  });
  return {
    ok: true,
    kind,
    label: def.label,
    sourceRevision,
    revision,
    reportPath: target.rel,
    reportExists: Boolean(reportHash),
    reportHash,
    reportText,
    from,
    to,
    stats,
    documents: documents.map((item) => ({
      path: item.path,
      fileHash: item.fileHash,
      parseError: item.parseError,
      caseCount: item.cases.length,
      headers: item.headers,
      cases: item.cases.slice(0, 800).map((row) => ({
        no: row.no,
        title: row.title,
        module: row.module,
        priority: row.priority,
        status: row.status,
        actual: row.actual,
        defectNo: row.defectNo,
      })),
    })),
    testStats: testStats.items,
    caseExec: caseExec.items,
    gaps,
    sources: {
      reports: def.reportFolder,
      cases: def.caseFolders,
      testStats: testStats.file,
      caseExec: caseExec.file,
    },
  };
}

function validateDeclaredStats(declared, actual) {
  if (!declared || typeof declared !== 'object') return;
  const errors = [];
  for (const key of [
    'total',
    'passed',
    'failed',
    'blocked',
    'skipped',
    'pending',
    'executed',
    'defects',
  ]) {
    if (!(key in declared)) continue;
    if (Number(declared[key]) !== Number(actual[key] || 0)) {
      errors.push(`${key} 声明 ${declared[key]}，真实材料为 ${actual[key] || 0}`);
    }
  }
  if (errors.length) {
    throw Object.assign(new Error(`报告统计与来源不一致：${errors.join('；')}`), {
      statusCode: 422,
    });
  }
}

async function createDraft(root, raw) {
  const body = text(raw.body, MAX_BODY);
  if (!body) throw Object.assign(new Error('报告正文不能为空'), { statusCode: 400 });
  const context = await buildContext(root, raw);
  if (raw.expectedSourceRevision && raw.expectedSourceRevision !== context.sourceRevision) {
    throw Object.assign(new Error('来源材料已变化，请重新读取报告上下文'), {
      statusCode: 409,
      currentRevision: context.sourceRevision,
    });
  }
  validateDeclaredStats(raw.declaredStats, context.stats);
  const store = createReviewDraftStore({ root, relPath: DRAFTS_REL, kind: '测试报告' });
  const draft = store.create({
    kind: context.kind,
    reportPath: context.reportPath,
    reportHash: context.reportHash,
    sourceRevision: context.sourceRevision,
    casePaths: context.documents.map((item) => item.path),
    sourceHashes: context.documents.map((item) => ({
      path: item.path,
      fileHash: item.fileHash,
    })),
    from: context.from,
    to: context.to,
    stats: context.stats,
    gaps: context.gaps,
    body,
  });
  return {
    ok: true,
    action: 'draft',
    draftId: draft.id,
    revision: draft.revision,
    expiresAt: draft.expiresAt,
    requiresConfirmation: true,
    reportPath: context.reportPath,
    stats: context.stats,
    gaps: context.gaps,
    preview: body.slice(0, 12_000),
    warnings: context.gaps,
    message: draft.message,
  };
}

async function applyDraft(root, raw) {
  const draftId = text(raw.draftId, 100);
  const revision = text(raw.expectedRevision, 100);
  if (!draftId || !revision)
    throw Object.assign(new Error('缺少 draftId 或 revision'), { statusCode: 400 });
  const store = createReviewDraftStore({ root, relPath: DRAFTS_REL, kind: '测试报告' });
  const draft = store.get(draftId);
  if (draft.revision !== revision)
    throw Object.assign(new Error('报告草稿已变化，请重新预览'), { statusCode: 409 });
  if (draft.status !== 'pending')
    throw Object.assign(new Error('报告草稿已处理，不能重复应用'), { statusCode: 409 });
  const payload = draft.payload;
  const context = await buildContext(root, {
    kind: payload.kind,
    reportPath: payload.reportPath,
    casePaths: payload.casePaths,
    from: payload.from,
    to: payload.to,
  });
  if (context.sourceRevision !== payload.sourceRevision) {
    throw Object.assign(new Error('来源材料或目标报告已变化，请重新生成草稿'), {
      statusCode: 409,
      currentRevision: context.sourceRevision,
    });
  }
  if (context.reportHash !== payload.reportHash) {
    throw Object.assign(new Error('目标报告已变化，请重新生成草稿'), {
      statusCode: 409,
      currentReportHash: context.reportHash,
    });
  }
  const target = safeReportPath(root, payload.kind, payload.reportPath);
  writeTextAtomic(target.abs, payload.body.endsWith('\n') ? payload.body : `${payload.body}\n`);
  const nextHash = fileHash(target.abs);
  const appliedAt = nowIso();
  store.update(draftId, { status: 'applied', appliedAt, result: { reportHash: nextHash } });
  return {
    ok: true,
    action: 'apply',
    receipt: `${context.reportExists ? '已更新' : '已创建'}测试报告《${payload.reportPath}》`,
    draftId,
    revision,
    reportPath: payload.reportPath,
    reportHash: nextHash,
    created: !context.reportExists,
    stats: payload.stats,
    gaps: payload.gaps,
    appliedAt,
  };
}

export function lhTestReportReviewPlugin() {
  return {
    name: 'lh-test-report-review',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        const root = getDataRoot();
        const tail = parsed.pathname.slice(PREFIX.length) || '/';
        try {
          if (parsed.searchParams.get('health') === '1' && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, kinds: Object.keys(KINDS) });
          }
          if (tail === '/context' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            return sendJson(res, 200, await buildContext(root, body));
          }
          if (tail === '/draft' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            return sendJson(res, 200, await createDraft(root, body));
          }
          if (tail === '/apply' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            return sendJson(res, 200, await applyDraft(root, body));
          }
          const draftMatch = tail.match(/^\/draft\/(rd_[a-f0-9]{24})$/);
          if (draftMatch && req.method === 'GET') {
            const store = createReviewDraftStore({
              root,
              relPath: DRAFTS_REL,
              kind: '测试报告',
            });
            return sendJson(res, 200, { ok: true, ...store.get(draftMatch[1]) });
          }
          if (draftMatch && req.method === 'DELETE') {
            const store = createReviewDraftStore({
              root,
              relPath: DRAFTS_REL,
              kind: '测试报告',
            });
            return sendJson(res, 200, store.discard(draftMatch[1]));
          }
          return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        } catch (error) {
          return sendJson(res, Number(error?.statusCode) || 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
