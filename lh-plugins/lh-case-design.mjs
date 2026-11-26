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
import { createCaseSetupWindows } from './case-setup-window.mjs';
import {
  ensureCitationHeader,
  normalizeGeneratedCaseRows,
  polishCaseWorkbook,
} from './case-design-output.mjs';
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
  resolveRequirementBreakdown,
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

async function readCaseSource(
  root,
  sourcePath,
  { fromAnalysis = false, allowMissing = false } = {},
) {
  if (!sourcePath) return { source: null, sourcePath, warnings: [] };
  try {
    return {
      source: { ...(await readReqSourceFile(root, sourcePath)), path: sourcePath },
      sourcePath,
      warnings: [],
    };
  } catch (error) {
    if (!fromAnalysis || error.statusCode !== 404) throw error;
    // Only relocate a missing analysis source when its exact filename is unique.
    const matches = listRequirementSourceOptions(root).filter(
      (item) =>
        path.posix.basename(item.path) === path.posix.basename(sourcePath.replaceAll('\\', '/')),
    );
    if (matches.length === 1) {
      const resolvedPath = matches[0].path;
      return {
        source: { ...(await readReqSourceFile(root, resolvedPath)), path: resolvedPath },
        sourcePath: resolvedPath,
        warnings: [
          `分析记录的来源路径已失效，本次使用唯一同名文档：${sourcePath} → ${resolvedPath}；未修改原分析记录。`,
        ],
      };
    }
    if (!allowMissing) throw error;
    return {
      source: null,
      sourcePath,
      warnings: [`${error.message}；仍可选择用户故事，生成前需恢复来源文档或修正关联路径。`],
    };
  }
}

export async function caseDesignContext(root, raw) {
  const analysis = raw.analysisId ? analysisSnapshot(root, raw.analysisId) : null;
  const { source, sourcePath, warnings } = await readCaseSource(
    root,
    analysis?.sourcePath || clean(raw.sourcePath),
    { fromAnalysis: !!analysis },
  );
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
    warnings,
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
      rows: `数组：按 headers 输出字符串字段；当前类型为 ${caseType.label}；需求编号使用需求文档根需求 XQ，引用需求点使用 RO / TP，禁止编造引用`,
      requirementNumber:
        '“需求编号”填写需求文档根需求 XQ-xxx；没有根需求编号时写“无”；同一根需求下的多条用例允许重复该编号',
      references:
        '“引用需求点”必须独立成列，格式为“RO-id 标题或摘录；TP-xxx”，不得把 US 混入引用需求点',
      order:
        '用例按需求文档条目顺序输出；同一需求条目内按用户故事和测试点清单顺序输出，不要按模块或 TP 全局编号重排',
      module:
        '“模块”取需求拆解 XMind 的一级系统章节（如工单系统、坐席系统、IVR系统、报表系统、质检系统）；“子模块”取该根章节下的二级需求名称。禁止根据标题关键词另造系统名',
      excelFormat:
        'Excel 输出必须冻结首行表头，并保持长文本自动换行、数据行自适应高度、优先级和用例状态下拉',
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
  const { source, sourcePath, warnings } = await readCaseSource(
    root,
    clean(raw.sourcePath) || analysis?.sourcePath || '',
    { fromAnalysis: !!analysis && !clean(raw.sourcePath), allowMissing: true },
  );
  const caseType = resolveCaseType(root, raw.caseType);
  const scopedAnalysis = selectAnalysisScope(analysis, raw);
  const breakdowns = isPluginOnInSpace('reqBreakdowns', root)
    ? listRequirementBreakdownOptions(root)
    : [];
  const businessSystems = isPluginOnInSpace('businessMap', root)
    ? listBusinessSystemOptions(root)
    : [];
  const templates = await listCaseTemplateOptions(root, caseTypes);
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
      outputFormat: ['xlsx', 'csv', 'md'].includes(raw.outputFormat) ? raw.outputFormat : 'xlsx',
    },
    warnings,
  };
}

/** @param {any} raw @param {any} [analysis] */
export function validateCaseDesign(raw, analysis = null) {
  const sourceAnalysis = analysis;
  analysis = selectAnalysisScope(sourceAnalysis, raw);
  const requestedHeaders = ensureCitationHeader(
    executionHeaders(
      Array.isArray(raw.headers) && raw.headers.length
        ? [...new Set(raw.headers.map(String))]
        : raw.caseType
          ? defaultCaseHeaders({ id: String(raw.caseType), label: String(raw.caseType) })
          : defaultHeaders,
    ),
  );
  const normalized = normalizeGeneratedCaseRows(
    Array.isArray(raw.rows) ? raw.rows : [],
    requestedHeaders,
    sourceAnalysis,
    raw.requirementBreakdownTree || [],
  );
  const headers = normalized.headers;
  const rows = normalized.rows;
  const issues = [];
  const caseType = clean(raw.caseType);
  const functional = !caseType || /功能|functional/i.test(caseType);
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
  const preconditionHeader = mapped.precondition;
  const remarkHeader = headers.find((header) => /备注/.test(header));
  const functionalScopeChecks = [
    [
      /模拟[^。\n]*(?:接口|服务|API|超时|返回错误|保存失败|权限校验|取数)/i,
      '包含接口 / 服务模拟，应改写为用户可操作的网络、外部渠道或数据状态，或转接口测试',
    ],
    [/Mock|桩|抓包|状态码|返回码|报文/i, '包含接口实现细节，应转接口测试'],
    [/接口(?:对接|调用|返回|地址|字段|不可用|超时)/i, '包含接口专项场景，应转接口测试'],
    [/压测|QPS|TPS|响应时间阈值|大数据量/i, '包含性能专项场景，应转性能测试'],
  ];
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
    if (functional) {
      const text = [titleHeader, preconditionHeader, stepsHeader, expectedHeader, remarkHeader]
        .filter(Boolean)
        .map((header) => String(row?.[header] || ''))
        .join(' | ');
      for (const [pattern, message] of functionalScopeChecks) {
        if (pattern.test(text)) issues.push(`第 ${index + 1} 条${message}`);
      }
    }
  });
  if (analysis && headers.some((header) => /引用需求点|需求点|关联需求点|reqcite/i.test(header))) {
    const citationHeader = headers.find((header) =>
      /引用需求点|需求点|关联需求点|reqcite/i.test(header),
    );
    rows.forEach((row, index) => {
      if (!clean(row?.[citationHeader])) issues.push(`第 ${index + 1} 条缺少引用需求点`);
    });
  }
  const storiesByRef = new Map();
  for (const story of analysis?.stories || []) {
    for (const ref of story.sourceRefs || []) {
      const list = storiesByRef.get(ref) || [];
      list.push(story.id);
      storiesByRef.set(ref, list);
    }
  }
  for (const point of analysis?.testPoints?.points || []) {
    const list = storiesByRef.get(point.id) || [];
    list.push(point.storyId);
    storiesByRef.set(point.id, list);
  }
  for (const id of [...covered.RO, ...covered.TP]) {
    for (const storyId of storiesByRef.get(id) || []) covered.US.add(storyId);
  }
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
  const { sourcePath } = await readCaseSource(root, analysis?.sourcePath || clean(raw.sourcePath), {
    fromAnalysis: !!analysis,
  });
  if (raw.expectedSourceFileHash && raw.expectedSourceFileHash !== sourceFileHash(root, sourcePath))
    fail('需求源文件已变化，请重新读取后生成', 409);
  if (sourcePath && !raw.expectedSourceFileHash)
    fail('保存前必须读取需求基线并携带 sourceFileHash', 409);
  const requestedHeaders = ensureCitationHeader(
    executionHeaders(
      Array.isArray(raw.headers) && raw.headers.length
        ? [...new Set(raw.headers.map(String))]
        : raw.caseType
          ? defaultCaseHeaders({ id: String(raw.caseType), label: String(raw.caseType) })
          : defaultHeaders,
    ),
  );
  const breakdown = raw.requirementBreakdownId
    ? await resolveRequirementBreakdown(root, {}, raw.requirementBreakdownId)
    : null;
  const normalized = normalizeGeneratedCaseRows(
    raw.rows,
    requestedHeaders,
    analysis,
    breakdown?.tree || [],
  );
  const checked = validateCaseDesign(
    { ...raw, headers: normalized.headers, rows: normalized.rows },
    analysis,
  );
  if (!checked.ok) fail(checked.issues.join('；'), 422);
  const headers = checked.headers;
  const executionMap = caseExecutionFieldMap(headers);
  const statusHeader = executionMap.status,
    actualHeader = executionMap.actual;
  const rows = normalized.rows.map((row, index) =>
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
    sheet['!cols'] = headers.map((header) => ({
      wch:
        header === '需求编号'
          ? 18
          : header === '用例标题'
            ? 50
            : header === '实际结果' || header === '优先级' || header === '用例状态'
              ? 12
              : /前置条件|测试步骤|预期结果|引用需求点|请求参数|性能指标/.test(header)
                ? 48
                : Math.min(28, Math.max(12, header.length + 4)),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '测试用例');
    const rawBook = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    fs.writeFileSync(abs, await polishCaseWorkbook(rawBook, headers), { flag: 'wx' });
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
  const setupWindows = createCaseSetupWindows({
    setup: caseDesignSetup,
    context: caseDesignContext,
  });
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
          if (action === '/setup-window' && method === 'POST')
            return send(200, await setupWindows.create(root, body));
          const windowAction = action.match(
            /^\/setup-window\/([a-f0-9-]{36})(?:\/(confirm|cancel))?$/,
          );
          if (windowAction) {
            const [, id, operation] = windowAction;
            if (method === 'GET' && !operation) return send(200, setupWindows.get(root, id));
            if (method === 'POST' && operation === 'confirm')
              return send(200, await setupWindows.confirm(root, id, body));
            if (method === 'POST' && operation === 'cancel')
              return send(200, setupWindows.cancel(root, id));
            return send(405, { ok: false, error: '请求方法不支持' });
          }
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
