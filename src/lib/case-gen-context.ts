/**
 * 用例生成上下文：匹配并压缩需求拆解库与业务地图数据，供插件提示词使用。
 */
import type {
  BusinessEvidence,
  BusinessFunction,
  BusinessMapStore,
  BusinessSystem,
} from './business-map';
import type {
  RequirementBreakdownContent,
  RequirementBreakdownEntry,
} from './requirement-breakdown-library';

export interface CaseGenContextSource {
  title?: string;
  docTitle?: string;
  sourceTitle?: string;
  sourcePath?: string;
}

export interface CaseGenRequirementBreakdownContext {
  entryId: string;
  title: string;
  fileName: string;
  block: string;
}

export interface CaseGenBusinessContext {
  systemId: string;
  systemName: string;
  functionCount: number;
  flowCount: number;
  block: string;
}

export interface CaseGenContextRefresh {
  requirementBreakdownContext?: CaseGenRequirementBreakdownContext;
  businessContext?: CaseGenBusinessContext;
  warnings: string[];
}

export interface CaseGenContextReaders {
  getRequirementBreakdown: (entryId: string) => Promise<{
    entry: RequirementBreakdownEntry;
    content: RequirementBreakdownContent | null;
  }>;
  loadBusinessMap: () => Promise<BusinessMapStore>;
}

const MAX_BUSINESS_CONTEXT_CHARS = 60_000;
const MAX_BREAKDOWN_CONTEXT_CHARS = 80_000;
const MAX_FOCUSED_CONTEXT_CHARS = 24_000;
const MAX_EVIDENCE_EXCERPT_CHARS = 180;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compact(value: unknown): string {
  return clean(value)
    .toLowerCase()
    .replace(/\.(md|txt|docx?|xlsx?|csv|xmind)$/i, '')
    .replace(/[\s_\-—:：/\\()[\]（）【】]+/g, '');
}

function redactSensitive(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(
      /([\w-]*(?:password|passwd|pwd|secret|token|cookie|authorization|api[_-]?key|access[_-]?key|session[_-]?id|csrf)[\w-]*\s*[:=：]\s*)[^\s,;，；]+/gi,
      '$1[已隐藏]',
    );
}

function safeRef(value: string): string {
  const ref = clean(value);
  if (!ref) return '';
  try {
    const url = new URL(ref);
    return `${url.origin}${url.pathname}`;
  } catch {
    return ref.replace(/[?#].*$/, '');
  }
}

function reqMatchKey(value: string): string {
  const text = clean(value).replace(/\.[^.]+$/, '');
  const match = text.match(/^(.+?)[vV](\d+(?:\.\d+)+)/);
  return match ? `${compact(match[1])}v${match[2]}` : compact(text);
}

function sourceValues(source: CaseGenContextSource): string[] {
  return [
    source.sourceTitle,
    source.sourcePath?.split(/[\\/]/).pop(),
    source.title,
    source.docTitle,
  ]
    .map(clean)
    .filter(Boolean);
}

function bigrams(value: string): Set<string> {
  const input = compact(value);
  const out = new Set<string>();
  for (let index = 0; index < input.length - 1; index += 1) {
    out.add(input.slice(index, index + 2));
  }
  return out;
}

function similarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const part of a) if (b.has(part)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function scoreBreakdown(entry: RequirementBreakdownEntry, source: CaseGenContextSource): number {
  const values = sourceValues(source);
  const normalizedValues = values.map(compact);
  const sourceTitle = compact(source.sourceTitle);
  const sourceKeys = new Set(values.map(reqMatchKey));
  const entryValues = [entry.sourceTitle, entry.sourcePath, entry.title, entry.project];
  let score = 0;
  if (sourceTitle && compact(entry.sourceTitle) === sourceTitle) score += 160;
  if (sourceKeys.has(reqMatchKey(entry.sourceTitle))) score += 120;
  if (sourceKeys.has(reqMatchKey(entry.title))) score += 100;
  for (const value of entryValues.map(compact)) {
    if (!value) continue;
    if (normalizedValues.some((candidate) => candidate === value)) score += 70;
    else if (normalizedValues.some((candidate) => candidate.includes(value))) score += 35;
    else if (normalizedValues.some((candidate) => value.includes(candidate))) score += 25;
  }
  if (entry.iteration && values.some((value) => value.toUpperCase().includes(entry.iteration))) {
    score += 20;
  }
  return score;
}

function scoreSystem(system: BusinessSystem, source: CaseGenContextSource): number {
  return Math.max(
    ...sourceValues(source).map((value) => {
      const systemName = compact(system.name);
      const reqName = compact(value);
      if (!systemName || !reqName) return 0;
      if (reqName.includes(systemName)) return 150;
      if (systemName.includes(reqName)) return 130;
      return Math.round(similarity(system.name, value) * 100);
    }),
  );
}

export function recommendRequirementBreakdown(
  entries: RequirementBreakdownEntry[],
  source: CaseGenContextSource,
): RequirementBreakdownEntry | undefined {
  return entries
    .map((entry, index) => ({ entry, index, score: scoreBreakdown(entry, source) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .find((item) => item.score > 0)?.entry;
}

export function recommendBusinessSystem(
  systems: BusinessSystem[],
  source: CaseGenContextSource,
): BusinessSystem | undefined {
  if (systems.length === 1) return systems[0];
  return systems
    .map((system, index) => ({ system, index, score: scoreSystem(system, source) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .find((item) => item.score >= 20)?.system;
}

function clipBlock(block: string, maxChars: number, label: string): string {
  if (block.length <= maxChars) return block;
  return `${block.slice(0, maxChars).trimEnd()}\n\n[${label}内容较长，已按 ${maxChars} 字符截断；未显示部分请以原始来源为准]`;
}

export function buildRequirementBreakdownContext(
  entry: RequirementBreakdownEntry,
  content: RequirementBreakdownContent | null,
): CaseGenRequirementBreakdownContext | null {
  const tree = clean(content?.text);
  if (!tree) return null;
  const lines = [
    `### 需求拆解库（最新 XMind）：${entry.title}`,
    `- 项目：${entry.project || '未分类'}`,
    `- 迭代：${entry.iteration || '未标注'}`,
    ...(entry.note ? [`- 备注：${entry.note}`] : []),
    '',
    '以下内容是用户在 XMind 客户端维护后的最新原文结构：',
    tree,
  ];
  return {
    entryId: entry.id,
    title: entry.title,
    fileName: entry.fileName,
    block: clipBlock(lines.join('\n'), MAX_BREAKDOWN_CONTEXT_CHARS, '需求拆解库'),
  };
}

function directoryPath(system: BusinessSystem, directoryId: string): string {
  const names: string[] = [];
  const visited = new Set<string>();
  let current = system.directories.find((item) => item.id === directoryId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = system.directories.find((item) => item.id === current?.parentId);
  }
  return names.join(' / ') || '未归类';
}

function listText(values: unknown, max = 1200): string {
  if (!Array.isArray(values)) return '';
  return values.map(clean).filter(Boolean).join('；').slice(0, max);
}

function evidenceExcerpt(evidence: BusinessEvidence): string {
  const title = clean(evidence.title);
  const note = clean(evidence.note);
  const ref = safeRef(evidence.ref);
  const detail = note || ref;
  const text = [title, detail].filter(Boolean).join('：');
  return redactSensitive(text).slice(0, MAX_EVIDENCE_EXCERPT_CHARS);
}

function evidenceLines(evidence: BusinessEvidence[], indent = '  '): string[] {
  const items = evidence.map(evidenceExcerpt).filter(Boolean).slice(0, 2);
  if (!items.length) return [];
  return [`${indent}- 证据：`, ...items.map((item) => `${indent}  - ${item}`)];
}

function functionText(system: BusinessSystem, fn: BusinessFunction): string[] {
  const lines = [
    `- ${fn.code} ${fn.name}｜目录：${directoryPath(system, fn.directoryId)}｜状态：${fn.status}`,
  ];
  if (fn.purpose) lines.push(`  - 作用：${fn.purpose}`);
  if (fn.entry) lines.push(`  - 入口：${fn.entry}`);
  const roles = listText(fn.roles);
  if (roles) lines.push(`  - 角色：${roles}`);
  const inputs = listText(fn.inputs);
  if (inputs) lines.push(`  - 输入：${inputs}`);
  const outputs = listText(fn.outputs);
  if (outputs) lines.push(`  - 输出：${outputs}`);
  const rules = listText(fn.rules);
  if (rules) lines.push(`  - 业务规则：${rules}`);
  const writes = listText(fn.writes);
  if (writes) lines.push(`  - 落库：${writes}`);
  const exceptions = listText(fn.exceptions);
  if (exceptions) lines.push(`  - 异常：${exceptions}`);
  lines.push(...evidenceLines(fn.evidence));
  return lines;
}

export function buildBusinessCaseContext(
  store: BusinessMapStore,
  systemId: string,
): CaseGenBusinessContext | null {
  const system = store.systems.find((item) => item.id === systemId);
  if (!system) return null;
  const functions = [...system.functions].sort(
    (left, right) =>
      directoryPath(system, left.directoryId).localeCompare(
        directoryPath(system, right.directoryId),
        'zh',
      ) ||
      left.order - right.order ||
      left.code.localeCompare(right.code),
  );
  const flows = system.flows.slice(0, 80);
  const lines = [
    `### 业务地图：${system.name}`,
    ...(system.description ? [`- 说明：${system.description}`] : []),
    `- 功能：${functions.length} 个；业务流程：${system.flows.length} 条`,
    '',
    '#### 功能目录与规则',
    ...functions.flatMap((fn) => functionText(system, fn)),
  ];
  if (flows.length) {
    lines.push('', '#### 业务流程');
    const dependencyLines: string[] = [];
    for (const flow of flows) {
      lines.push(
        `- ${flow.code} ${flow.name}｜结果：${flow.result || '未填写'}｜状态：${flow.status}`,
      );
      lines.push(...evidenceLines(flow.evidence));
      flow.steps.forEach((step, index) => {
        const fn = system.functions.find((item) => item.id === step.functionId);
        const dependencies = step.dependencies
          .map((dependency) => `${dependency.system}·${dependency.label}`)
          .filter(Boolean);
        if (dependencies.length) {
          dependencyLines.push(`- ${flow.code}「${step.title}」→ ${dependencies.join('；')}`);
        }
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
    if (dependencyLines.length) {
      lines.push('', '#### 跨系统依赖', ...dependencyLines);
    }
    if (system.flows.length > flows.length) {
      lines.push(`- 其余 ${system.flows.length - flows.length} 条流程未注入`);
    }
  }
  return {
    systemId: system.id,
    systemName: system.name,
    functionCount: functions.length,
    flowCount: system.flows.length,
    block: clipBlock(lines.join('\n'), MAX_BUSINESS_CONTEXT_CHARS, '业务地图'),
  };
}

/**
 * 发送前按当前选择重新读取上下文。读取失败时保留上次缓存，避免网络抖动让整次生成不可用。
 * 选择 ID 始终保留，后续重试仍会读同一个 XMind / 业务系统。
 */
export async function refreshCaseGenContext(
  current: Pick<
    {
      requirementBreakdownContext?: CaseGenRequirementBreakdownContext;
      businessContext?: CaseGenBusinessContext;
    },
    'requirementBreakdownContext' | 'businessContext'
  >,
  readers: CaseGenContextReaders,
): Promise<CaseGenContextRefresh> {
  let requirementBreakdownContext = current.requirementBreakdownContext;
  let businessContext = current.businessContext;
  const warnings: string[] = [];

  const entryId = current.requirementBreakdownContext?.entryId;
  if (entryId) {
    try {
      const detail = await readers.getRequirementBreakdown(entryId);
      const latest = buildRequirementBreakdownContext(detail.entry, detail.content);
      if (latest) requirementBreakdownContext = latest;
      else warnings.push('需求拆解 XMind 没有可读取内容，已使用上次缓存');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`需求拆解 XMind 刷新失败：${message}，已使用上次缓存`);
    }
  }

  const systemId = current.businessContext?.systemId;
  if (systemId) {
    try {
      const map = await readers.loadBusinessMap();
      const latest = buildBusinessCaseContext(map, systemId);
      if (latest) businessContext = latest;
      else warnings.push('业务地图系统已不存在，已使用上次缓存');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`业务地图刷新失败：${message}，已使用上次缓存`);
    }
  }

  return { requirementBreakdownContext, businessContext, warnings };
}

interface FocusedBlock {
  text: string;
  score: number;
}

function textScore(query: string, value: string): number {
  const keywordBigrams = (input: string) =>
    new Set([...bigrams(input)].filter((part) => /^[\p{L}\p{Script=Han}]{2,}$/u.test(part)));
  const left = keywordBigrams(query);
  const right = keywordBigrams(value);
  if (!left.size || !right.size) return 0;
  let score = 0;
  for (const part of left) if (right.has(part)) score += 1;
  return score;
}

function focusRequirementBreakdown(
  context: CaseGenRequirementBreakdownContext | undefined,
  query: string,
): CaseGenRequirementBreakdownContext | undefined {
  if (!context?.block || !query.trim()) return context;
  const lines = context.block.split('\n');
  const firstTree = lines.findIndex((line) => /^\s*-\s+/.test(line));
  if (firstTree < 0) return context;
  const header = lines.slice(0, firstTree);
  const tree = lines.slice(firstTree);
  const nodes = tree.map((line, index) => ({
    line,
    index,
    depth: Math.max(0, (line.match(/^\s*/)?.[0].length || 0) / 2),
    parent: -1,
    score: textScore(query, line.replace(/^\s*-\s*/, '')),
  }));
  const stack: number[] = [];
  for (const node of nodes) {
    while (stack.length && nodes[stack[stack.length - 1]!]!.depth >= node.depth) stack.pop();
    node.parent = stack.at(-1) ?? -1;
    stack.push(node.index);
  }
  const matches = nodes
    .filter((node) => node.score >= 2)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 16);
  if (!matches.length) return context;
  const keep = new Set<number>();
  for (const match of matches) {
    let cursor = match.index;
    while (cursor >= 0) {
      keep.add(cursor);
      cursor = nodes[cursor]?.parent ?? -1;
    }
    for (let index = match.index + 1; index < nodes.length; index += 1) {
      if (nodes[index]!.depth <= match.depth) break;
      keep.add(index);
    }
  }
  const focused = tree.filter((_, index) => keep.has(index)).join('\n');
  const block = clipBlock(
    [
      ...header,
      '[本批已按当前测试点裁剪 XMind 树；未显示的分支仍属于同一需求，不代表不存在]',
      focused,
    ].join('\n'),
    MAX_FOCUSED_CONTEXT_CHARS,
    '需求拆解库本批上下文',
  );
  return {
    ...context,
    block,
  };
}

function topLevelBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^-\s+/.test(line)) {
      if (current?.length) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current?.length) blocks.push(current);
  return blocks;
}

function focusBusinessContext(
  context: CaseGenBusinessContext | undefined,
  query: string,
): CaseGenBusinessContext | undefined {
  if (!context?.block || !query.trim()) return context;
  const lines = context.block.split('\n');
  const functionHeading = lines.indexOf('#### 功能目录与规则');
  const flowHeading = lines.indexOf('#### 业务流程');
  const dependencyHeading = lines.indexOf('#### 跨系统依赖');
  if (functionHeading < 0) return context;
  const overview = lines.slice(0, functionHeading);
  const functionEnd =
    flowHeading >= 0 ? flowHeading : dependencyHeading >= 0 ? dependencyHeading : lines.length;
  const functionBlocks = topLevelBlocks(lines.slice(functionHeading + 1, functionEnd));
  const flowEnd = dependencyHeading >= 0 ? dependencyHeading : lines.length;
  const flowBlocks = flowHeading >= 0 ? topLevelBlocks(lines.slice(flowHeading + 1, flowEnd)) : [];
  const dependencies =
    dependencyHeading >= 0 ? lines.slice(dependencyHeading + 1).filter(Boolean) : [];
  const scoredFunctions: FocusedBlock[] = functionBlocks.map((block) => ({
    text: block.join('\n').trim(),
    score: textScore(query, block.join('\n')),
  }));
  const scoredFlows: FocusedBlock[] = flowBlocks.map((block) => ({
    text: block.join('\n').trim(),
    score: textScore(query, block.join('\n')),
  }));
  const matchedFunctions = scoredFunctions
    .filter((block) => block.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
  const matchedFlows = scoredFlows
    .filter((block) => block.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  if (!matchedFunctions.length && !matchedFlows.length) return context;

  const sections = [
    ...overview,
    '[本批已按当前测试点裁剪业务地图；未显示内容仍属于当前系统，不代表不存在]',
    '#### 功能目录与规则',
    ...(matchedFunctions.length
      ? matchedFunctions.map((block) => block.text)
      : ['- 本批没有直接命中的功能，按已列流程与测试点判断']),
  ];
  if (matchedFlows.length) {
    sections.push('', '#### 业务流程', ...matchedFlows.map((block) => block.text));
  }
  if (dependencies.length) sections.push('', '#### 跨系统依赖', ...dependencies);
  return {
    ...context,
    block: clipBlock(sections.join('\n'), MAX_FOCUSED_CONTEXT_CHARS, '业务地图本批上下文'),
  };
}

export function focusCaseGenContextForBatch(
  requirementBreakdownContext: CaseGenRequirementBreakdownContext | undefined,
  businessContext: CaseGenBusinessContext | undefined,
  query: string,
): {
  requirementBreakdownContext?: CaseGenRequirementBreakdownContext;
  businessContext?: CaseGenBusinessContext;
} {
  return {
    requirementBreakdownContext: focusRequirementBreakdown(requirementBreakdownContext, query),
    businessContext: focusBusinessContext(businessContext, query),
  };
}
