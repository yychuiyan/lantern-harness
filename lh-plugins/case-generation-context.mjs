/**
 * 用例生成 MCP 上下文：按 caseType 解析技能、模板和目录，并自动关联
 * 需求拆解 XMind 与多个业务地图系统。所有内容只读，不修改业务数据。
 */
import fs from 'node:fs';
import path from 'node:path';

import { executionHeaders, CASE_FIELD_ALIASES } from '../builtin/case-workflow-contract.mjs';
import {
  resolveContentRoot,
  spaceConfigFile,
  spaceLocalFile,
} from '../builtin/session/space-layout.mjs';
import { ensureCitationHeader } from './case-design-output.mjs';
import { businessMapFilePath, normalizeBusinessMapStore } from './lh-business-map.mjs';
import {
  readRequirementBreakdownXMind,
  requirementBreakdownLibraryRoot,
  requirementBreakdownStorePath,
} from './lh-req-breakdown-library.mjs';
import { reqAnalysisStorePath, reqDocsDir } from './lh-req-analysis.mjs';
import { isPluginOnInSpace, readPluginPrompt } from './plugin-prompts.mjs';

const BUILTIN_CASE_TYPES = [
  { id: 'functional', label: '功能测试', casesFolder: '功能测试', templateFolder: '功能测试用例' },
  { id: 'api', label: '接口测试', casesFolder: '接口测试', templateFolder: '接口测试用例' },
  {
    id: 'performance',
    label: '性能测试',
    casesFolder: '性能测试',
    templateFolder: '性能测试用例',
  },
  {
    id: 'automation',
    label: '自动化测试',
    casesFolder: '自动化测试',
    templateFolder: '自动化测试用例',
  },
];

const BUILTIN_CASE_SKILLS = {
  functional: '功能测试用例提示词.md',
  api: '接口测试用例提示词.md',
  performance: '性能测试用例提示词.md',
  automation: '自动化测试用例提示词.md',
};

const DEFAULT_HEADERS = {
  functional: [
    '用例编号',
    '需求编号',
    '用例标题',
    '前置条件',
    '测试步骤',
    '预期结果',
    '优先级',
    '引用需求点',
    '备注',
  ],
  api: [
    '用例编号',
    '需求编号',
    '接口名称',
    '请求方法',
    '请求地址',
    '请求参数',
    '前置条件',
    '测试步骤',
    '预期结果',
    '优先级',
    '引用需求点',
    '备注',
  ],
  performance: [
    '用例编号',
    '需求编号',
    '性能场景',
    '负载模型',
    '并发数',
    '持续时间',
    '性能指标',
    '前置条件',
    '测试步骤',
    '预期结果',
    '优先级',
    '引用需求点',
    '备注',
  ],
  automation: [
    '用例编号',
    '需求编号',
    '用例标题',
    '前置条件',
    '测试步骤',
    '预期结果',
    '自动化断言',
    '优先级',
    '引用需求点',
    '备注',
  ],
};

const text = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const safeJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const compact = (value) =>
  clean(value)
    .toLowerCase()
    .replace(/\.(md|txt|docx?|xlsx?|csv|xmind)$/i, '')
    .replace(/[\s_\-—:：/\\()[\]（）【】]+/g, '');

function requestKey(value) {
  const raw = clean(value).replace(/\.[^.]+$/, '');
  const match = raw.match(/^(.+?)[vV](\d+(?:\.\d+)+)/);
  return match ? `${compact(match[1])}v${match[2]}` : compact(raw);
}

function similarity(left, right) {
  const grams = (value) => {
    const input = compact(value);
    const out = new Set();
    for (let index = 0; index < input.length - 1; index += 1)
      out.add(input.slice(index, index + 2));
    return out;
  };
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function flatten(items) {
  return (items || []).flatMap((item) => [item, ...flatten(item?.children)]);
}

function sourceValues(source) {
  return [
    source.sourceTitle,
    source.sourcePath?.split(/[\\/]/).pop(),
    source.title,
    source.docTitle,
  ]
    .map(clean)
    .filter(Boolean);
}

function analysisText(analysis, source) {
  const stories = (analysis?.stories || []).flatMap((story) => [
    story.title,
    story.role,
    story.goal,
    story.value,
    ...(story.preconditions || []),
    ...(story.acceptance || []).flatMap((item) => [item.given, item.when, item.then]),
  ]);
  const points = (analysis?.testPoints?.points || []).flatMap((point) => [
    point.title,
    point.precondition,
    ...(point.steps || []),
    point.expected,
  ]);
  return [source?.content, analysis?.title, ...stories, ...points].filter(Boolean).join('\n');
}

function normalizeCaseTypeDef(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const label = text(raw.label, 80);
  if (!label) return null;
  const fallback = BUILTIN_CASE_TYPES[index] || BUILTIN_CASE_TYPES[0];
  return {
    id: text(raw.id, 80) || fallback.id,
    label,
    casesFolder: text(raw.casesFolder, 120) || label,
    templateFolder: text(raw.templateFolder, 120) || `${label}用例`,
    promptPath: text(raw.promptPath, 500),
  };
}

export function listCaseTypes(spaceDir) {
  const local = safeJson(spaceLocalFile(spaceDir, 'app.config.json'), {});
  const defaults = safeJson(spaceConfigFile(spaceDir, 'app.defaults.json'), {});
  const raw =
    Array.isArray(local.caseTypes) && local.caseTypes.length
      ? local.caseTypes
      : Array.isArray(defaults.caseTypes) && defaults.caseTypes.length
        ? defaults.caseTypes
        : BUILTIN_CASE_TYPES;
  const out = [];
  const seen = new Set();
  raw.forEach((item, index) => {
    const def = normalizeCaseTypeDef(item, index);
    if (!def || seen.has(def.id)) return;
    seen.add(def.id);
    out.push(def);
  });
  return out.length ? out : BUILTIN_CASE_TYPES.map((item) => ({ ...item }));
}

export function resolveCaseType(spaceDir, raw = 'functional') {
  const wanted = clean(raw).toLowerCase();
  const list = listCaseTypes(spaceDir);
  const byId = list.find((item) => item.id.toLowerCase() === wanted);
  const byLabel = list.find((item) => item.label.toLowerCase() === wanted);
  if (byId || byLabel) return byId || byLabel;
  const alias = /性能|performance|perf/.test(wanted)
    ? 'performance'
    : /接口|api/.test(wanted)
      ? 'api'
      : /自动化|automation|e2e/.test(wanted)
        ? 'automation'
        : 'functional';
  return list.find((item) => item.id === alias) || list[0] || { ...BUILTIN_CASE_TYPES[0] };
}

export function resolveCaseSkillPath(caseType, explicitPath = '') {
  const pathValue = clean(explicitPath) || clean(caseType.promptPath);
  if (pathValue) return pathValue;
  return (
    BUILTIN_CASE_SKILLS[caseType.id] ||
    (/性能|performance|perf/i.test(caseType.label)
      ? BUILTIN_CASE_SKILLS.performance
      : /接口|api/i.test(caseType.label)
        ? BUILTIN_CASE_SKILLS.api
        : /自动化|automation|e2e/i.test(caseType.label)
          ? BUILTIN_CASE_SKILLS.automation
          : BUILTIN_CASE_SKILLS.functional)
  );
}

export function defaultCaseHeaders(caseType) {
  return [
    ...(DEFAULT_HEADERS[caseType.id] ||
      (/性能|performance|perf/i.test(caseType.label)
        ? DEFAULT_HEADERS.performance
        : /接口|api/i.test(caseType.label)
          ? DEFAULT_HEADERS.api
          : /自动化|automation|e2e/i.test(caseType.label)
            ? DEFAULT_HEADERS.automation
            : DEFAULT_HEADERS.functional)),
  ];
}

function within(base, abs) {
  return abs === base || abs.startsWith(base + path.sep);
}

function templateCandidates(root, caseType, templateId = '') {
  const templatesRoot = resolveContentRoot(root, '测试模板库').abs;
  if (templateId) {
    const rel = String(templateId).replaceAll('\\', '/').replace(/^\/+/, '');
    const abs = path.resolve(templatesRoot, rel);
    if (!within(templatesRoot, abs)) throw new Error('模板路径越界');
    return { templatesRoot, files: [abs] };
  }
  const folder = path.resolve(templatesRoot, caseType.templateFolder);
  if (!within(templatesRoot, folder)) throw new Error('模板目录越界');
  let names = [];
  try {
    names = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return { templatesRoot, files: [] };
  }
  const files = names
    .filter((entry) => entry.isFile() && /\.(xlsx?|csv|md|txt)$/i.test(entry.name))
    .map((entry) => {
      const abs = path.join(folder, entry.name);
      return { abs, mtime: fs.statSync(abs).mtimeMs };
    })
    .sort((left, right) => right.mtime - left.mtime)
    .map((item) => item.abs);
  return { templatesRoot, files };
}

function normalizedHeader(value) {
  return String(value || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s*＊・·:：]/g, '')
    .toLowerCase();
}

function uniqueHeaders(cells) {
  const out = [];
  const seen = new Set();
  for (const cell of cells) {
    const header = String(cell ?? '').trim();
    const key = normalizedHeader(header);
    if (!header || seen.has(key)) continue;
    seen.add(key);
    out.push(header);
  }
  return out;
}

function findHeaderRow(rows) {
  const aliases = new Set(
    Object.values(CASE_FIELD_ALIASES)
      .flat()
      .map((item) => normalizedHeader(item)),
  );
  for (let index = 0; index < Math.min(rows.length, 40); index += 1) {
    const values = (rows[index] || []).map(normalizedHeader).filter(Boolean);
    const hits = values.filter((value) => aliases.has(value)).length;
    if (hits >= 3) return index;
  }
  return 0;
}

async function parseTemplate(abs, templatesRoot) {
  const ext = path.extname(abs).toLowerCase();
  let headers = [];
  let body = '';
  const title = path.basename(abs).replace(/\.[^.]+$/, '');
  if (ext === '.xlsx' || ext === '.xls') {
    const { default: XLSX } = await import('xlsx');
    const book = XLSX.read(fs.readFileSync(abs), { type: 'buffer', cellDates: true });
    for (const sheetName of book.SheetNames) {
      const sheet = book.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      const headerRow = findHeaderRow(rows);
      const next = uniqueHeaders(rows[headerRow] || []);
      if (next.length < 2) continue;
      headers = next;
      const samples = rows
        .slice(headerRow + 1)
        .filter((row) => row.some((cell) => String(cell ?? '').trim()))
        .slice(0, 3)
        .map((row) =>
          Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? '')])),
        );
      body = [
        `工作表：${sheetName}`,
        `字段（必须原样作为 JSON 对象键，顺序一致）：${headers.join('、')}`,
        '',
        '样例行（风格与粒度请对齐，勿照抄业务内容）：',
        ...samples.map((row) => JSON.stringify(row, null, 2)),
      ].join('\n');
      break;
    }
  } else if (ext === '.csv') {
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split(/\r?\n/);
    const headerRow = findHeaderRow(lines.map((line) => line.split(',')));
    headers = uniqueHeaders(
      (lines[headerRow] || '').split(',').map((item) => item.replace(/^"|"$/g, '')),
    );
    body = `字段（必须原样作为 JSON 对象键）：${headers.join('、')}\n\n${content}`;
  } else {
    const content = fs.readFileSync(abs, 'utf8');
    const row = content.match(/^\|(.+)\|\s*$/m);
    headers = row?.[1]
      ? uniqueHeaders(
          row[1]
            .split('|')
            .map((item) => item.trim())
            .filter((item) => item && !/^[-:]+$/.test(item)),
        )
      : [];
    body = headers.length
      ? `字段（必须原样作为 JSON 对象键）：${headers.join('、')}\n\n${content}`
      : content;
  }
  if (!headers.length) return null;
  return {
    id: path.relative(templatesRoot, abs).replaceAll('\\', '/'),
    title,
    headers,
    body,
  };
}

export async function resolveCaseTemplate(root, caseType, templateId = '') {
  const { templatesRoot, files } = templateCandidates(root, caseType, templateId);
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const parsed = await parseTemplate(file, templatesRoot);
    if (parsed) return parsed;
  }
  return null;
}

export function listRequirementAnalysisOptions(root) {
  const store = safeJson(reqAnalysisStorePath(root), {});
  return (Array.isArray(store.docs) ? store.docs : [])
    .map((doc) => ({
      id: text(doc.id, 100),
      title: text(doc.title, 300) || text(doc.sourceTitle, 300) || text(doc.sourcePath, 500),
      sourcePath: text(doc.sourcePath, 1000),
      sourceTitle: text(doc.sourceTitle, 300),
      storyCount: Array.isArray(doc.stories) ? doc.stories.length : 0,
      testPointCount: Array.isArray(doc.testPoints?.points) ? doc.testPoints.points.length : 0,
      updatedAt: text(doc.updatedAt, 80),
    }))
    .filter((doc) => doc.id && doc.title)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function recommendRequirementAnalysis(analyses, prompt = '') {
  if (!analyses.length) return null;
  const query = compact(prompt);
  if (!query) return analyses[0];
  const ranked = analyses
    .map((analysis, index) => ({
      analysis,
      index,
      score: Math.max(
        compact(analysis.title) && query.includes(compact(analysis.title)) ? 160 : 0,
        compact(analysis.sourcePath) && query.includes(compact(analysis.sourcePath)) ? 140 : 0,
        Math.round(similarity(analysis.title, String(prompt || '').slice(0, 120)) * 100),
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0]?.score > 0 ? ranked[0].analysis : analyses[0];
}

export function listRequirementSourceOptions(root, limit = 200) {
  const base = path.resolve(reqDocsDir(root));
  const out = [];
  const walk = (dir, depth = 0) => {
    if (out.length >= limit || depth > 10) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh'))) {
      if (out.length >= limit || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!/\.(md|txt|docx|csv|xlsx|xls)$/i.test(entry.name)) continue;
      const rel = path.relative(base, abs).replaceAll('\\', '/');
      out.push({
        path: rel,
        title: rel,
        name: entry.name,
      });
    }
  };
  walk(base);
  return out;
}

export function listRequirementBreakdownOptions(root) {
  return loadBreakdownEntries(root)
    .map((entry) => ({
      id: text(entry.id, 100),
      title: text(entry.title, 300),
      fileName: text(entry.fileName, 300) || path.basename(entry.localPath),
      project: text(entry.project, 200),
      iteration: text(entry.iteration, 100),
      sourcePath: text(entry.sourcePath, 1000),
      sourceTitle: text(entry.sourceTitle, 300),
      exists: fs.existsSync(entry.localPath),
    }))
    .filter((entry) => entry.id && entry.title && entry.exists);
}

export function listBusinessSystemOptions(root) {
  const store = normalizeBusinessMapStore(safeJson(businessMapFilePath(root), {}));
  return store.systems.map((system) => ({
    id: system.id,
    name: system.name,
    description: system.description,
    functionCount: system.functions.length,
    flowCount: system.flows.length,
    status: system.status,
  }));
}

export async function listCaseTemplateOptions(root, caseTypes) {
  const out = [];
  for (const caseType of caseTypes) {
    const { files } = templateCandidates(root, caseType);
    for (const file of files.slice(0, 30)) {
      try {
        const parsed = await parseTemplate(file, resolveContentRoot(root, '测试模板库').abs);
        if (!parsed) continue;
        out.push({
          id: parsed.id,
          title: parsed.title,
          caseTypeId: caseType.id,
          caseTypeLabel: caseType.label,
          headers: parsed.headers,
        });
      } catch {
        // 损坏模板不阻塞配置窗口，自动匹配时会继续尝试下一份。
      }
    }
  }
  return out;
}

function breakdownScore(entry, source) {
  const values = sourceValues(source);
  const normalized = values.map(compact);
  const keys = new Set(values.map(requestKey));
  let score = 0;
  if (source.sourceTitle && compact(entry.sourceTitle) === compact(source.sourceTitle))
    score += 160;
  if (keys.has(requestKey(entry.sourceTitle))) score += 120;
  if (keys.has(requestKey(entry.title))) score += 100;
  for (const value of [entry.sourceTitle, entry.sourcePath, entry.title, entry.project]
    .map(compact)
    .filter(Boolean)) {
    if (normalized.some((candidate) => candidate === value)) score += 70;
    else if (normalized.some((candidate) => candidate.includes(value))) score += 35;
    else if (normalized.some((candidate) => value.includes(candidate))) score += 25;
  }
  if (entry.iteration && values.some((value) => value.toUpperCase().includes(entry.iteration)))
    score += 20;
  return score;
}

function loadBreakdownEntries(root) {
  const base = path.resolve(requirementBreakdownLibraryRoot(root));
  const store = safeJson(requirementBreakdownStorePath(root), {});
  return (Array.isArray(store.entries) ? store.entries : [])
    .map((entry) => {
      const localPath = path.resolve(base, entry.relativePath || '');
      return within(base, localPath) ? { ...entry, localPath } : null;
    })
    .filter(Boolean)
    .filter((entry) => entry.id && entry.title && entry.localPath);
}

export async function resolveRequirementBreakdown(root, source, requestedId = '') {
  const entries = loadBreakdownEntries(root);
  const candidates = requestedId
    ? entries.filter((item) => item.id === requestedId)
    : entries
        .map((item, index) => ({ item, index, score: breakdownScore(item, source) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((item) => item.item);
  if (!candidates.length) {
    if (requestedId) throw new Error('所选需求拆解 XMind 不存在');
    return null;
  }
  let entry;
  let content;
  for (const candidate of candidates) {
    try {
      content = await readRequirementBreakdownXMind(candidate.localPath);
      entry = candidate;
      break;
    } catch {
      if (requestedId) throw new Error('所选需求拆解 XMind 无法读取');
    }
  }
  if (!entry || !content) return null;
  const block = [
    `### 需求拆解库（最新 XMind）：${entry.title}`,
    `- 项目：${entry.project || '未分类'}`,
    `- 迭代：${entry.iteration || '未标注'}`,
    ...(entry.note ? [`- 备注：${entry.note}`] : []),
    '',
    '以下内容是用户在 XMind 客户端维护后的最新原文结构：',
    content.text,
  ].join('\n');
  return {
    entryId: entry.id,
    title: entry.title,
    fileName: entry.fileName || path.basename(entry.localPath),
    block: block.slice(0, 80_000),
    tree: content.tree || [],
  };
}

function systemScore(system, source) {
  const metadataScore = Math.max(
    0,
    ...sourceValues(source).map((value) => {
      const systemName = compact(system.name);
      const reqName = compact(value);
      if (!systemName || !reqName) return 0;
      if (reqName.includes(systemName)) return 150;
      if (systemName.includes(reqName)) return 130;
      return Math.round(similarity(system.name, value) * 100);
    }),
  );
  const content = compact(source.content);
  if (!content) return metadataScore;
  let contentScore = 0;
  const systemName = compact(system.name);
  if (systemName.length >= 2 && content.includes(systemName)) contentScore += 180;
  const signals = [
    system.name,
    system.description,
    ...(system.functions || []).flatMap((fn) => [fn.name, fn.purpose, fn.entry]),
    ...(system.flows || []).flatMap((flow) => [
      flow.name,
      flow.result,
      ...(flow.steps || []).flatMap((step) => [
        step.title,
        step.system,
        ...(step.dependencies || []).flatMap((dependency) => [dependency.system, dependency.label]),
      ]),
    ]),
  ];
  const seen = new Set();
  for (const signal of signals) {
    const key = compact(signal);
    if (key.length < 4 || seen.has(key)) continue;
    seen.add(key);
    if (!content.includes(key)) continue;
    contentScore += key === systemName ? 80 : 28;
    if (contentScore >= 160) break;
  }
  return Math.max(metadataScore, contentScore);
}

function redactSensitive(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(
      /([\w-]*(?:password|passwd|pwd|secret|token|cookie|authorization|api[_-]?key|access[_-]?key|session[_-]?id|csrf)[\w-]*\s*[:=：]\s*)[^\s,;，；]+/gi,
      '$1[已隐藏]',
    );
}

function safeRef(value) {
  const ref = clean(value);
  if (!ref) return '';
  try {
    const url = new URL(ref);
    return `${url.origin}${url.pathname}`;
  } catch {
    return ref.replace(/[?#].*$/, '');
  }
}

function listText(values, max = 1200) {
  return (Array.isArray(values) ? values : []).map(clean).filter(Boolean).join('；').slice(0, max);
}

function directoryPath(system, directoryId) {
  const names = [];
  const visited = new Set();
  let current = (system.directories || []).find((item) => item.id === directoryId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = (system.directories || []).find((item) => item.id === current?.parentId);
  }
  return names.join(' / ') || '未归类';
}

function evidenceLines(evidence, indent = '  ') {
  const items = (evidence || [])
    .map((item) =>
      redactSensitive([item.title, item.note || safeRef(item.ref)].filter(Boolean).join('：')),
    )
    .filter(Boolean)
    .slice(0, 2);
  return items.length ? [`${indent}- 证据：`, ...items.map((item) => `${indent}  - ${item}`)] : [];
}

function buildSystemBlock(system) {
  const functions = [...(system.functions || [])].sort(
    (left, right) =>
      directoryPath(system, left.directoryId).localeCompare(
        directoryPath(system, right.directoryId),
        'zh',
      ) ||
      left.order - right.order ||
      left.code.localeCompare(right.code),
  );
  const lines = [
    `### 业务地图：${system.name}`,
    ...(system.description ? [`- 说明：${system.description}`] : []),
    `- 功能：${functions.length} 个；业务流程：${(system.flows || []).length} 条`,
    '',
    '#### 功能目录与规则',
  ];
  for (const fn of functions) {
    lines.push(
      `- ${fn.code} ${fn.name}｜目录：${directoryPath(system, fn.directoryId)}｜状态：${fn.status}`,
    );
    for (const [label, value] of [
      ['作用', fn.purpose],
      ['入口', fn.entry],
      ['角色', listText(fn.roles)],
      ['输入', listText(fn.inputs)],
      ['输出', listText(fn.outputs)],
      ['业务规则', listText(fn.rules)],
      ['落库', listText(fn.writes)],
      ['异常', listText(fn.exceptions)],
    ]) {
      if (value) lines.push(`  - ${label}：${value}`);
    }
    lines.push(...evidenceLines(fn.evidence));
  }
  const flows = (system.flows || []).slice(0, 80);
  if (flows.length) {
    lines.push('', '#### 业务流程');
    const dependencyLines = [];
    for (const flow of flows) {
      lines.push(
        `- ${flow.code} ${flow.name}｜结果：${flow.result || '未填写'}｜状态：${flow.status}`,
      );
      lines.push(...evidenceLines(flow.evidence));
      flow.steps.forEach((step, index) => {
        const fn = functions.find((item) => item.id === step.functionId);
        const dependencies = (step.dependencies || [])
          .map((dependency) => `${dependency.system}·${dependency.label}`)
          .filter(Boolean);
        if (dependencies.length)
          dependencyLines.push(`- ${flow.code}「${step.title}」→ ${dependencies.join('；')}`);
        const targets = [
          step.role ? `角色=${step.role}` : '',
          step.system ? `系统=${step.system}` : '',
          fn ? `功能=${fn.code} ${fn.name}` : step.manual ? '人工步骤' : '',
          dependencies.length ? `依赖=${dependencies.join('；')}` : '',
          step.input ? `输入=${step.input}` : '',
          step.output ? `输出=${step.output}` : '',
          step.next ? `下一步=${step.next}` : '',
          step.branch ? `分支=${step.branch}` : '',
          step.branchBroken ? '分支待补全' : '',
        ].filter(Boolean);
        lines.push(
          `  ${index + 1}. ${step.title}${targets.length ? `｜${targets.join('｜')}` : ''}`,
        );
        lines.push(...evidenceLines(step.evidence, '    '));
      });
    }
    if (dependencyLines.length) lines.push('', '#### 跨系统依赖', ...dependencyLines);
  }
  return lines.join('\n').slice(0, 60_000);
}

export function resolveBusinessContexts(root, source, requestedIds = [], mode = 'auto') {
  const store = normalizeBusinessMapStore(safeJson(businessMapFilePath(root), {}));
  const ids = [...new Set((requestedIds || []).map(clean).filter(Boolean))];
  let systems;
  if (ids.length) {
    systems = ids.map((id) => store.systems.find((system) => system.id === id));
    if (systems.some((system) => !system)) throw new Error('部分所选业务地图系统不存在');
  } else if (mode === 'manual') {
    systems = [];
  } else {
    const scored = store.systems
      .map((system, index) => ({ system, index, score: systemScore(system, source) }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    systems = scored.filter((item) => item.score >= 20).map((item) => item.system);
    if (!systems.length && store.systems.length === 1) systems = [store.systems[0]];
  }
  return systems.filter(Boolean).map((system) => ({
    systemId: system.id,
    systemName: system.name,
    functionCount: system.functions.length,
    flowCount: system.flows.length,
    block: buildSystemBlock(system),
  }));
}

export async function resolveCaseGenerationExtras(root, raw, analysis, source) {
  const caseType = resolveCaseType(root, raw.caseType);
  const skillPath = resolveCaseSkillPath(caseType, raw.skillPath);
  const skill = readPluginPrompt(skillPath, root).trim();
  if (!skill) throw new Error(`请先准备「${caseType.label}」用例生成技能：${skillPath}`);
  const template = await resolveCaseTemplate(root, caseType, raw.templateId);
  const headers = ensureCitationHeader(
    executionHeaders(
      raw.headers?.length
        ? raw.headers
        : template?.headers?.length
          ? template.headers
          : defaultCaseHeaders(caseType),
    ),
  );
  const matchingSource = {
    title: analysis?.title || source?.path || '',
    docTitle: analysis?.title || '',
    sourceTitle: analysis?.sourceTitle || source?.path || '',
    sourcePath: analysis?.sourcePath || source?.path || '',
    content: analysisText(analysis, source),
  };
  const breakdownOn = isPluginOnInSpace('reqBreakdowns', root);
  const breakdownMode =
    raw.requirementBreakdownMode === 'none' || raw.requirementBreakdownMode === 'manual'
      ? raw.requirementBreakdownMode
      : raw.requirementBreakdownMode === 'auto'
        ? 'auto'
        : raw.requirementBreakdownId
          ? 'manual'
          : 'auto';
  if (raw.requirementBreakdownId && !breakdownOn)
    throw new Error('需求拆解库插件未启用，无法读取所选 XMind');
  const requirementBreakdownContext =
    breakdownOn && breakdownMode !== 'none'
      ? await resolveRequirementBreakdown(
          root,
          matchingSource,
          breakdownMode === 'manual' ? raw.requirementBreakdownId || '' : '',
        )
      : null;
  const businessMapOn = isPluginOnInSpace('businessMap', root);
  const businessSystemMode = raw.businessSystemMode === 'manual' ? 'manual' : 'auto';
  const requestedBusinessIds = raw.businessSystemIds?.length
    ? raw.businessSystemIds
    : raw.businessSystemId
      ? [raw.businessSystemId]
      : [];
  if (requestedBusinessIds.length && !businessMapOn)
    throw new Error('业务地图插件未启用，无法读取所选业务系统');
  const businessContexts = businessMapOn
    ? resolveBusinessContexts(root, matchingSource, requestedBusinessIds, businessSystemMode)
    : [];
  return {
    caseType,
    skillPath,
    skill,
    template,
    headers,
    requirementBreakdownContext,
    businessContexts,
    matchingSource,
  };
}
