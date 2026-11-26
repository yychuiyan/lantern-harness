import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot } from '../builtin/session/space-layout.mjs';
import { executionHeaders, normalizeExecutionStatus } from '../builtin/case-workflow-contract.mjs';
import {
  analysisSnapshot,
  sourceFileHash,
  linkCaseArtifact,
  readWorkflowAssets,
  caseContentFingerprint,
} from './case-execution/assets.mjs';
import { loadCaseDocument, caseExecutionFieldMap } from './case-execution/files.mjs';
import { analysisRevision } from './req-analysis-revision.mjs';
import { readReqSourceFile } from './lh-req-analysis.mjs';
import { isPluginOnInSpace } from './plugin-prompts.mjs';
import {
  defaultCaseHeaders,
  listBusinessSystemOptions,
  listCaseTemplateOptions,
  listCaseTypes,
  listRequirementAnalysisOptions,
  listRequirementBreakdownOptions,
  listRequirementSourceOptions,
  recommendRequirementAnalysis,
  resolveCaseGenerationExtras,
  resolveCaseType,
} from './case-generation-context.mjs';

const PREFIX = '/__tb_case_design';
const defaultHeaders = [
  '用例编号',
  '需求编号',
  '用例标题',
  '前置条件',
  '测试步骤',
  '预期结果',
  '优先级',
  '引用需求点',
  '备注',
];
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
function flatten(items) {
  return (items || []).flatMap((item) => [item, ...flatten(item.children)]);
}

function selectedIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
}

function selectAnalysisScope(analysis, raw = {}) {
  if (!analysis) return null;
  const storyIds = selectedIds(raw.storyIds);
  const testPointIds = selectedIds(raw.testPointIds);
  const storySelection = raw.storySelection === 'selected' ? 'selected' : 'all';
  const testPointSelection = raw.testPointSelection === 'selected' ? 'selected' : 'all';
  const storySet = new Set(storyIds);
  const pointSet = new Set(testPointIds);
  const stories =
    storySelection === 'selected'
      ? (analysis.stories || []).filter((story) => storySet.has(story.id))
      : analysis.stories || [];
  const storyScope = new Set(stories.map((story) => story.id));
  const points =
    testPointSelection === 'selected'
      ? (analysis.testPoints?.points || []).filter((point) => pointSet.has(point.id))
      : storySelection === 'selected'
        ? (analysis.testPoints?.points || []).filter(
            (point) => !point.storyId || storyScope.has(point.storyId),
          )
        : analysis.testPoints?.points || [];
  const referencedRo = new Set(stories.flatMap((story) => story.sourceRefs || []));
  const outline =
    storySelection === 'selected'
      ? flatten(analysis.outline).filter((item) => referencedRo.has(item.id))
      : analysis.outline;
  return {
    ...analysis,
    outline,
    stories,
    testPoints: analysis.testPoints ? { ...analysis.testPoints, points } : null,
  };
}

export async function caseDesignContext(root, raw) {
  const analysis = raw.analysisId ? analysisSnapshot(root, raw.analysisId) : null;
  const sourcePath = analysis?.sourcePath || clean(raw.sourcePath);
  const source = sourcePath
    ? { ...(await readReqSourceFile(root, sourcePath)), path: sourcePath }
    : null;
  if (!analysis && !source) fail('请选择需求分析或需求来源');
  let extras;
  try {
    extras = await resolveCaseGenerationExtras(root, raw, analysis, source);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 422);
  }
  const {
    caseType,
    skillPath,
    skill,
    template,
    headers,
    requirementBreakdownContext,
    businessContexts,
  } = extras;
  const scopedAnalysis = selectAnalysisScope(analysis, raw);
  const businessBlock = businessContexts.map((item) => item.block).join('\n\n');
  return {
    ok: true,
    analysis: scopedAnalysis,
    analysisSummary: scopedAnalysis
      ? {
          storyCount: scopedAnalysis.stories?.length || 0,
          testPointCount: scopedAnalysis.testPoints?.points?.length || 0,
        }
      : null,
    revision: analysis ? analysisRevision(analysis) : '',
    source,
    sourcePath,
    sourceFileHash: sourceFileHash(root, sourcePath),
    caseType,
    skill,
    skillPath,
    template,
    headers,
    requirementBreakdownContext,
    businessContexts,
    businessContext:
      businessContexts.length === 1
        ? {
            systemId: businessContexts[0].systemId,
            systemName: businessContexts[0].systemName,
            functionCount: businessContexts[0].functionCount,
            flowCount: businessContexts[0].flowCount,
            block: businessContexts[0].block,
          }
        : undefined,
    context: {
      requirement: source || null,
      requirementBreakdown: requirementBreakdownContext,
      business: businessBlock || '',
    },
    outputContract: {
      rows: `数组：按 headers 输出字符串字段；当前类型为 ${caseType.label}；需求编号使用 US，引用需求点使用 RO / TP，禁止编造引用`,
      finalStatus: '待验证；实际结果必须留空',
      folder: caseType.casesFolder,
      template: template?.id || '',
    },
  };
}

export async function caseDesignSetup(root, raw = {}) {
  const caseTypes = listCaseTypes(root);
  const analyses = listRequirementAnalysisOptions(root);
  const sources = listRequirementSourceOptions(root);
  const requestedAnalysis = raw.analysisId
    ? analyses.find((item) => item.id === raw.analysisId)
    : clean(raw.sourcePath)
      ? null
      : recommendRequirementAnalysis(analyses, clean(raw.prompt));
  const analysis = requestedAnalysis ? analysisSnapshot(root, requestedAnalysis.id) : null;
  const sourcePath = clean(raw.sourcePath) || analysis?.sourcePath || '';
  const source = sourcePath
    ? { ...(await readReqSourceFile(root, sourcePath)), path: sourcePath }
    : null;
  const caseType = resolveCaseType(root, raw.caseType);
  const scopedAnalysis = selectAnalysisScope(analysis, raw);
  const breakdowns = isPluginOnInSpace('reqBreakdowns', root)
    ? listRequirementBreakdownOptions(root)
    : [];
  const businessSystems = isPluginOnInSpace('businessMap', root)
    ? listBusinessSystemOptions(root)
    : [];
  const templates = await listCaseTemplateOptions(root, caseTypes);
  const warnings = [];
  let extras = null;
  if (analysis || source) {
    try {
      extras = await resolveCaseGenerationExtras(
        root,
        {
          ...raw,
          caseType: caseType.id,
          headers: undefined,
        },
        analysis,
        source,
      );
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  const selectedAnalysis = scopedAnalysis
    ? {
        id: scopedAnalysis.id,
        title: scopedAnalysis.title,
        sourcePath: scopedAnalysis.sourcePath,
        sourceTitle: scopedAnalysis.sourceTitle,
        stories: (scopedAnalysis.stories || []).map((story) => ({
          id: story.id,
          title: story.title,
          priority: story.priority,
        })),
        testPoints: (scopedAnalysis.testPoints?.points || []).map((point) => ({
          id: point.id,
          storyId: point.storyId,
          title: point.title,
          dimension: point.dimension,
          priority: point.priority,
        })),
      }
    : null;
  return {
    ok: true,
    caseTypes: caseTypes.map((item) => ({
      id: item.id,
      label: item.label,
      casesFolder: item.casesFolder,
      templateFolder: item.templateFolder,
    })),
    outputFormats: [
      { id: 'xlsx', label: 'Excel' },
      { id: 'csv', label: 'CSV' },
      { id: 'md', label: 'Markdown' },
    ],
    analyses,
    sources,
    breakdowns,
    businessSystems,
    templates,
    selectedAnalysis,
    recommended: {
      caseType: caseType.id,
      analysisId: selectedAnalysis?.id || '',
      sourcePath: sourcePath || '',
      storyIds: selectedAnalysis?.stories.map((story) => story.id) || [],
      testPointIds: selectedAnalysis?.testPoints.map((point) => point.id) || [],
      templateId:
        extras?.template?.id || templates.find((item) => item.caseTypeId === caseType.id)?.id || '',
      requirementBreakdownId: extras?.requirementBreakdownContext?.entryId || '',
      businessSystemIds: extras?.businessContexts?.map((context) => context.systemId) || [],
      outputFormat: 'xlsx',
    },
    warnings,
  };
}

/** @param {any} raw @param {any} [analysis] */
export function validateCaseDesign(raw, analysis = null) {
  analysis = selectAnalysisScope(analysis, raw);
  const headers = executionHeaders(
    Array.isArray(raw.headers) && raw.headers.length
      ? [...new Set(raw.headers.map(String))]
      : raw.caseType
        ? defaultCaseHeaders({ id: String(raw.caseType), label: String(raw.caseType) })
        : defaultHeaders,
  );
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const issues = [];
  if (!rows.length || rows.length > 10000) issues.push('用例数量必须在 1 到 10000 条之间');
  const outline = flatten(analysis?.outline);
  const roAll = new Set(outline.map((item) => item.id));
  const childTargets = outline.filter((item) => item.kind && item.parentId);
  const ro = new Set(
    (childTargets.length ? childTargets : outline.filter((item) => !item.parentId)).map(
      (item) => item.id,
    ),
  );
  const us = new Set((analysis?.stories || []).map((item) => item.id));
  const tp = new Set((analysis?.testPoints?.points || []).map((item) => item.id));
  const covered = { RO: new Set(), US: new Set(), TP: new Set() };
  const mapped = caseExecutionFieldMap(headers);
  const titleHeader = mapped.title,
    stepsHeader = mapped.steps,
    expectedHeader = mapped.expected;
  rows.forEach((row, index) => {
    for (const [label, header] of [
      ['标题', titleHeader],
      ['步骤', stepsHeader],
      ['预期结果', expectedHeader],
    ]) {
      if (!header || !clean(row?.[header])) issues.push(`第 ${index + 1} 条缺少${label}`);
    }
    const cite = headers
      .filter((h) => /需求编号|引用需求点|关联需求|需求id/i.test(h))
      .map((h) => String(row?.[h] || ''))
      .join(' ');
    for (const match of cite.matchAll(/\b(RO-[A-Za-z0-9_-]+|US-\d+|TP-\d+)\b/g)) {
      const id = match[1],
        group = id.slice(0, 2),
        valid = group === 'RO' ? roAll : group === 'US' ? us : tp;
      if (analysis && !valid.has(id)) issues.push(`第 ${index + 1} 条引用了不存在的 ${id}`);
      else covered[group].add(id);
    }
  });
  const caseType = clean(raw.caseType);
  const specialized = /接口|api/i.test(caseType)
    ? [
        ['请求方法', /请求方法|http方法|method/i],
        ['请求地址', /请求地址|接口地址|接口路径|请求路径|url|path/i],
      ]
    : /性能|performance|perf/i.test(caseType)
      ? [
          ['负载模型', /负载模型|压力模型|场景模型/i],
          ['并发数', /并发数|并发用户|线程数/i],
          ['持续时间', /持续时间|执行时长|压测时长/i],
          ['性能指标', /性能指标|阈值|成功率|响应时间|tps|qps/i],
        ]
      : /自动化|automation|e2e/i.test(caseType)
        ? [['自动化断言', /自动化断言|断言|定位器|选择器/i]]
        : [];
  for (const [label, pattern] of specialized) {
    const header = headers.find((item) => pattern.test(item));
    if (!header) continue;
    rows.forEach((row, index) => {
      if (!clean(row?.[header])) issues.push(`第 ${index + 1} 条缺少${label}`);
    });
  }
  const coverage = Object.fromEntries(
    [
      ['RO', ro],
      ['US', us],
      ['TP', tp],
    ].map(([kind, ids]) => {
      const missing = [...ids].filter((id) => !covered[kind].has(id));
      return [
        kind,
        {
          targets: [...ids],
          total: ids.size,
          covered: ids.size - missing.length,
          rate: ids.size ? Math.round(((ids.size - missing.length) / ids.size) * 100) : null,
          missing,
        },
      ];
    }),
  );
  return { ok: !issues.length, headers, issues: issues.slice(0, 200), coverage };
}

export async function saveCaseDesign(root, raw) {
  const analysis = raw.analysisId ? analysisSnapshot(root, raw.analysisId) : null;
  if (analysis && raw.expectedRevision !== analysisRevision(analysis))
    fail('需求分析已变化，请重新读取后生成', 409);
  const sourcePath = analysis?.sourcePath || clean(raw.sourcePath);
  if (raw.expectedSourceFileHash && raw.expectedSourceFileHash !== sourceFileHash(root, sourcePath))
    fail('需求源文件已变化，请重新读取后生成', 409);
  if (sourcePath && !raw.expectedSourceFileHash)
    fail('保存前必须读取需求基线并携带 sourceFileHash', 409);
  const checked = validateCaseDesign(raw, analysis);
  if (!checked.ok) fail(checked.issues.join('；'), 422);
  const headers = checked.headers;
  const executionMap = caseExecutionFieldMap(headers);
  const statusHeader = executionMap.status,
    actualHeader = executionMap.actual;
  const rows = raw.rows.map((row, index) =>
    Object.fromEntries(
      headers.map((h) => [
        h,
        h === statusHeader
          ? '待验证'
          : h === actualHeader
            ? ''
            : String(row[h] ?? (h === '用例编号' ? index + 1 : '')),
      ]),
    ),
  );
  const ext = ['xlsx', 'csv', 'md'].includes(raw.format) ? raw.format : 'xlsx';
  const base = clean(raw.title || analysis?.title || '测试用例')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 100);
  const folder = (clean(raw.folder) || resolveCaseType(root, raw.caseType).casesFolder)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
  const rel = `${folder ? `${folder}/` : ''}${base}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
  const dir = path.join(resolveContentRoot(root, '用例管理').abs, folder);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(resolveContentRoot(root, '用例管理').abs, rel);
  if (ext === 'xlsx') {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '测试用例');
    fs.writeFileSync(abs, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), {
      flag: 'wx',
    });
  } else if (ext === 'csv') {
    const cell = (value) => '"' + String(value).replaceAll('"', '""') + '"';
    fs.writeFileSync(
      abs,
      '\uFEFF' +
        [headers, ...rows.map((row) => headers.map((h) => row[h]))]
          .map((row) => row.map(cell).join(','))
          .join('\n'),
      { flag: 'wx' },
    );
  } else {
    const cell = (value) => String(value).replaceAll('|', '&#124;').replace(/\r?\n/g, '<br>');
    fs.writeFileSync(
      abs,
      [headers, headers.map(() => '---'), ...rows.map((row) => headers.map((h) => row[h]))]
        .map((row) => '| ' + row.map(cell).join(' | ') + ' |')
        .join('\n'),
      { flag: 'wx' },
    );
  }
  const document = await loadCaseDocument(root, rel);
  const artifact = linkCaseArtifact(root, document, {
    analysisId: analysis?.id || '',
    analysisRevision: analysis ? analysisRevision(analysis) : '',
    sourcePath,
    sourceFileHash: sourceFileHash(root, sourcePath),
    coverage: checked.coverage,
  });
  return {
    ok: true,
    path: rel,
    artifactId: artifact.id,
    caseCount: rows.length,
    coverage: checked.coverage,
    executable: document.executable,
  };
}

export async function caseAcceptance(root, casePath, environmentKey = '') {
  const document = await loadCaseDocument(root, casePath);
  const artifact = readWorkflowAssets(root).artifacts.find(
    (item) => item.id === document.provenance.artifactId,
  );
  const history = artifact?.verificationHistory || [];
  const envKey = (env) => JSON.stringify([env?.name || '', env?.role || '', env?.build || '']);
  const envs = new Map();
  history.forEach((item) => {
    if (item.baselineId === artifact?.baselineId)
      envs.set(envKey(item.environment), item.environment);
  });
  const runsFolder = path.join(root, '.lantern', 'local', 'case-execution', 'runs');
  if (fs.existsSync(runsFolder))
    for (const file of fs.readdirSync(runsFolder).filter((name) => name.endsWith('.json'))) {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(runsFolder, file), 'utf8'));
        if (
          run.provenance?.artifactId === artifact?.id &&
          run.provenance?.baselineId === artifact?.baselineId &&
          run.environment
        )
          envs.set(envKey(run.environment), run.environment);
      } catch {
        /* Ignore incomplete runtime records. */
      }
    }
  const plansFolder = path.join(root, '.lantern', 'local', 'case-execution', 'plans');
  if (fs.existsSync(plansFolder))
    for (const file of fs.readdirSync(plansFolder).filter((name) => name.endsWith('.json'))) {
      try {
        const plan = JSON.parse(fs.readFileSync(path.join(plansFolder, file), 'utf8'));
        if (
          plan.provenance?.artifactId === artifact?.id &&
          plan.provenance?.baselineId === artifact?.baselineId &&
          plan.environment
        )
          envs.set(envKey(plan.environment), plan.environment);
      } catch {
        /* Ignore incomplete plans. */
      }
    }
  const environments = [...envs.entries()].map(([key, env]) => ({
    key,
    label: [env?.name, env?.role, env?.build].filter(Boolean).join(' / ') || '未标注环境',
  }));
  if (environmentKey) {
    for (const item of document.cases) {
      const verified = history
        .filter(
          (entry) =>
            entry.caseId === item.id &&
            envKey(entry.environment) === environmentKey &&
            entry.baselineId === artifact?.baselineId &&
            entry.sourceFileHash === (artifact?.sourceFileHash || '') &&
            entry.contentFingerprint === caseContentFingerprint(item),
        )
        .at(-1);
      item.status =
        verified && !document.provenance.stale && !artifact?.needsReview?.includes(item.id)
          ? verified.status
          : '待验证';
    }
  }
  const analysis = document.provenance.analysisId
    ? analysisSnapshot(root, document.provenance.analysisId)
    : null;
  const rows = document.cases.map((item) =>
    Object.fromEntries((item.fields || []).map((f) => [f.name, f.value])),
  );
  const design = validateCaseDesign({ rows, headers: document.headers }, analysis);
  const statuses = document.cases.map((item) => normalizeExecutionStatus(item.status));
  const progressCoverage = Object.fromEntries(
    Object.entries(design.coverage).map(([kind, value]) => {
      const refs = new Map();
      document.cases.forEach((item) => {
        const text = (item.fields || [])
          .filter((field) => /需求编号|引用需求点|关联需求|需求id/i.test(field.name))
          .map((field) => field.value)
          .join(' ');
        for (const match of text.matchAll(/\b(RO-[A-Za-z0-9_-]+|US-\d+|TP-\d+)\b/g)) {
          if (!match[1].startsWith(kind + '-')) continue;
          const states = refs.get(match[1]) || [];
          states.push(normalizeExecutionStatus(item.status));
          refs.set(match[1], states);
        }
      });
      const validStates = [...refs.entries()]
        .filter(([id]) => value.targets.includes(id))
        .map(([, states]) => states);
      const executed = validStates.filter((states) =>
        states.every((status) => status !== '待验证'),
      ).length;
      const passed = validStates.filter((states) =>
        states.every((status) => status === '通过'),
      ).length;
      return [
        kind,
        {
          total: value.total,
          executed,
          passed,
          executionRate: value.total ? Math.round((executed / value.total) * 100) : null,
          passRate: value.total ? Math.round((passed / value.total) * 100) : null,
        },
      ];
    }),
  );
  const passed = statuses.filter((status) => status === '通过').length;
  const pending = statuses.filter((status) => status === '待验证').length;
  const failed = statuses.filter((status) => status === '不通过').length;
  const blocked = statuses.filter((status) => status === '阻塞').length;
  const skipped = statuses.filter((status) => status === '跳过').length;
  const reasons = [...document.provenance.reasons];
  if (!environmentKey && environments.length > 1)
    reasons.push('包含多个环境或构建的验证记录，请选择具体环境查看验收');
  if (!design.ok) reasons.push('用例字段或需求引用校验未通过');
  if (pending) reasons.push(`${pending} 条待验证`);
  if (failed || blocked) reasons.push(`${failed} 条不通过，${blocked} 条阻塞`);
  if (skipped) reasons.push(`${skipped} 条跳过，需说明接受风险`);
  if (!analysis) reasons.push('未关联需求分析，无法核验需求覆盖');
  if (Object.values(design.coverage).some((item) => item.total && item.missing.length))
    reasons.push('存在未覆盖需求或测试点');
  return {
    ok: true,
    path: casePath,
    provenance: document.provenance,
    environments,
    environmentKey,
    designCoverage: design.coverage,
    progressCoverage,
    total: statuses.length,
    passed,
    pending,
    failed,
    blocked,
    skipped,
    executionRate: statuses.length
      ? Math.round(((statuses.length - pending) / statuses.length) * 100)
      : 0,
    acceptance: { ready: !!statuses.length && !reasons.length, reasons },
    note: '仅汇总用户手动判定状态；不包含缺陷平台状态或性能测试，不替代项目最终准出审批',
  };
}

export async function linkCaseBaseline(root, raw) {
  const document = await loadCaseDocument(root, raw.casePath);
  const analysis = analysisSnapshot(root, raw.analysisId);
  const revision = analysisRevision(analysis);
  const preview = {
    fileHash: document.fileHash,
    revision,
    affected: document.cases.map((item) => ({ id: item.id, title: item.title })),
    note: '关联或更新基线后，历史结果保留但需逐条人工复核，未复核结果不计为通过',
  };
  if (raw.mode !== 'apply') return { ok: true, preview };
  if (raw.expectedFileHash !== document.fileHash || raw.expectedRevision !== revision)
    fail('文件或需求已变化，请重新预览', 409);
  linkCaseArtifact(root, document, {
    analysisId: analysis.id,
    analysisRevision: revision,
    sourcePath: analysis.sourcePath,
    sourceFileHash: sourceFileHash(root, analysis.sourcePath),
    needsReview: document.cases.map((item) => item.id),
  });
  return { ok: true, preview };
}

export function lhCaseDesignPlugin() {
  return {
    name: 'lh-case-design',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith(PREFIX + '/')) return next();
        const send = (code, value) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(value));
        };
        try {
          const root = getDataRoot(),
            action = url.pathname.slice(PREFIX.length),
            method = req.method || 'GET';
          if (!isPluginOnInSpace('cases', root)) fail('请开启用例管理', 403);
          if (
            method !== 'GET' &&
            req.headers.origin &&
            new URL(req.headers.origin).host !== req.headers.host
          )
            fail('请求来源不匹配', 403);
          if (action === '/acceptance' && method === 'GET')
            return send(
              200,
              await caseAcceptance(
                root,
                url.searchParams.get('casePath') || '',
                url.searchParams.get('environmentKey') || '',
              ),
            );
          if (action !== '/link' && !isPluginOnInSpace('caseGen', root))
            fail('请开启用例生成', 403);
          let body = {};
          if (method === 'POST') {
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 10 * 1024 * 1024) fail('请求超过 10MB', 413);
              chunks.push(chunk);
            }
            body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          }
          if (action === '/link' && method === 'POST')
            return send(200, await linkCaseBaseline(root, body));
          if (action === '/setup')
            return send(
              200,
              await caseDesignSetup(
                root,
                method === 'GET' ? Object.fromEntries(url.searchParams) : body,
              ),
            );
          if (action === '/context')
            return send(
              200,
              await caseDesignContext(
                root,
                method === 'GET' ? Object.fromEntries(url.searchParams) : body,
              ),
            );
          if (action === '/validate' && method === 'POST')
            return send(
              200,
              validateCaseDesign(
                body,
                body.analysisId ? analysisSnapshot(root, body.analysisId) : null,
              ),
            );
          if (action === '/save' && method === 'POST')
            return send(200, await saveCaseDesign(root, body));
          return send(404, { ok: false, error: '接口不存在' });
        } catch (error) {
          return send(error.statusCode || 500, { ok: false, error: error.message });
        }
      });
    },
  };
}
