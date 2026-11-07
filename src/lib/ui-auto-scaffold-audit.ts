/**
 * 新建项目的「检查」步骤：平台体检 + 模型审骨架。
 *
 * 分两路，互不阻塞：
 * 1. 确定性检查（服务端 `/scaffold/check`）：结构性缺失、选项与文件不一致、目标目录问题；
 * 2. 模型审阅：读「提示词管理/自动化项目提示词.md」，让模型指出问题并给出**补丁**。
 *
 * 模型只输出 findings + patches，落盘由平台按补丁机械应用；
 * 勾选的结果只作用于**本次生成**的骨架副本，不改空间基线。
 */
import { streamChat, type ChatMessage } from './llm';
import { readDocsText } from './project-docs';
import type { LLMSettings } from './settings';
import {
  checkScaffold,
  fetchSpaceSkeleton,
  type ScaffoldCheckItem,
  type ScaffoldCheckResult,
  type SpaceSkeleton,
} from './ui-auto';
import { UI_AUTO_PROJECT_PROMPT_FILE } from './ui-auto-prompt';

/** 检查步骤的日志阶段（左栏按这个分组） */
export type AuditStage =
  'skeleton' | 'structure' | 'render' | 'target' | 'prompt' | 'ai' | 'parse' | 'summary';

/** 阶段中文名：日志前缀用它 */
export const AUDIT_STAGE_LABEL: Record<AuditStage, string> = {
  skeleton: '读骨架',
  structure: '结构检查',
  render: '渲染检查',
  target: '目标目录',
  prompt: '读提示词',
  ai: 'AI 分析',
  parse: '解析输出',
  summary: '汇总',
};

export interface AuditLogEntry {
  /** 序号，React key 用它（时间戳可能重复） */
  seq: number;
  at: number;
  stage: AuditStage;
  level: 'info' | 'warn' | 'error';
  text: string;
  /** 折叠显示的细节（长文本、错误堆栈） */
  detail?: string;
}

/** 骨架补丁的四种原子操作：只做机械增删改，不做语义重写 */
export type SkeletonPatch =
  | { action: 'addFile'; path: string; content: string; when?: string }
  | { action: 'replaceFile'; path: string; content: string }
  | { action: 'removeFile'; path: string }
  | { action: 'setOptions'; add?: SkeletonOptionPatch[]; remove?: string[] };

export interface SkeletonOptionPatch {
  id: string;
  label: string;
  hint?: string;
}

/** 检查项：平台体检和模型建议统一成这个形状，右栏按 level 分组 */
export interface ScaffoldFinding {
  id: string;
  level: 'error' | 'warn' | 'info';
  title: string;
  detail: string;
  /** 平台检查带文件；模型建议也可以指出文件 */
  file?: string;
  /** 来源：platform = 确定性检查（不可勾选，必须修）；model = AI 建议（可勾选应用） */
  source: 'platform' | 'model';
  /** 应用这条建议会动哪些文件（右栏展示） */
  patches: SkeletonPatch[];
}

export interface ScaffoldAuditStats {
  /** 总耗时 */
  ms: number;
  /** 首字延迟（毫秒），没拿到就是 0 */
  firstTokenMs: number;
  /** 模型输出的字符数 */
  chars: number;
  /** 流式心跳次数，用来判断链路是否还活着 */
  beats: number;
  model: string;
}

export interface ScaffoldAuditResult {
  logs: AuditLogEntry[];
  findings: ScaffoldFinding[];
  /** 平台体检原始结果（含 summary） */
  platform: ScaffoldCheckResult | null;
  /** 空间骨架快照（拼 prompt 用，也是「没改动」的对照） */
  space: SpaceSkeleton | null;
  /** 模型原始输出（折叠展示） */
  raw: string;
  /** 提示词是否存在；false 时前端提示「没挂提示词，只跑了平台检查」 */
  promptReady: boolean;
  stats: ScaffoldAuditStats;
  /** 整体是否可用：平台有 error 就是不可用 */
  ok: boolean;
  error: string;
}

export interface ScaffoldAuditInput {
  stack: string;
  name: string;
  parentDir: string;
  /** 修改项目：直接检查这个已有目录（不要求为空） */
  dir?: string;
  baseURL: string;
  options: string[];
  /** 本次已应用的骨架（重跑检查时带上，避免丢掉上一轮勾选的结果） */
  skeleton?: string | null;
}

export interface ScaffoldAuditHooks {
  onLog?: (entry: AuditLogEntry) => void;
  /** 流式增量：左栏的「AI 正在写」区域用它 */
  onDelta?: (delta: string) => void;
  /** 首字到达 */
  onFirstToken?: (ms: number) => void;
  /** 模型原始输出变化（节流后给折叠面板） */
  onRaw?: (text: string) => void;
}

/** 文件路径安全：与服务端 `assertSafeSkeletonPath` 同口径 */
export function isSafeSkeletonPath(raw: string): boolean {
  const value = String(raw ?? '').trim();
  if (!value) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  if (value.split(/[\\/]/).some((part) => part === '..')) return false;
  if (value.length > 240) return false;
  return true;
}

/** 规范化模型给的补丁：丢掉非法动作、越界路径、空内容 */
export function normalizePatches(raw: unknown): SkeletonPatch[] {
  if (!Array.isArray(raw)) return [];
  const out: SkeletonPatch[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const patch = item as Record<string, unknown>;
    const action = String(patch.action ?? '');
    if (action === 'addFile' || action === 'replaceFile') {
      const path = String(patch.path ?? '').trim();
      const content = typeof patch.content === 'string' ? patch.content : '';
      if (!isSafeSkeletonPath(path) || !content) continue;
      if (action === 'addFile') {
        const when = String(patch.when ?? '').trim();
        out.push(when ? { action, path, content, when } : { action, path, content });
      } else {
        out.push({ action, path, content });
      }
    } else if (action === 'removeFile') {
      const path = String(patch.path ?? '').trim();
      if (!isSafeSkeletonPath(path)) continue;
      out.push({ action, path });
    } else if (action === 'setOptions') {
      const add = Array.isArray(patch.add)
        ? patch.add
            .map((option) => {
              const record = (option ?? {}) as Record<string, unknown>;
              const id = String(record.id ?? '').trim();
              if (!/^[a-z][a-zA-Z0-9]*$/.test(id)) return null;
              const label = String(record.label ?? id).trim() || id;
              const hint = String(record.hint ?? '').trim();
              return hint ? { id, label, hint } : { id, label };
            })
            .filter((option): option is SkeletonOptionPatch => Boolean(option))
        : [];
      const remove = Array.isArray(patch.remove)
        ? patch.remove.map((id) => String(id ?? '').trim()).filter(Boolean)
        : [];
      if (add.length || remove.length) out.push({ action, add, remove });
    }
  }
  return out;
}

/** 平台体检项 → 统一的问题清单（source=platform，不可勾选应用） */
export function platformFindings(checks: ScaffoldCheckItem[]): ScaffoldFinding[] {
  return checks.map((item) => ({
    id: `p-${item.id}`,
    level: item.level,
    title: item.title,
    detail: item.detail,
    ...(item.file ? { file: item.file } : {}),
    source: 'platform' as const,
    patches: [],
  }));
}

const LEVELS = new Set(['error', 'warn', 'info']);

/**
 * 解析模型输出：允许代码围栏、前后废话，只取最外层 JSON。
 * 解析失败返回空数组并把原因抛给调用方。
 */
export function parseFindings(text: string): { findings: ScaffoldFinding[]; notes: string } {
  const raw = String(text ?? '').trim();
  if (!raw) return { findings: [], notes: '' };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error(
      `模型输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  const list = Array.isArray(body.findings) ? body.findings : [];
  const findings: ScaffoldFinding[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const title = String(record.title ?? '').trim();
    if (!title) continue;
    const levelRaw = String(record.level ?? 'warn');
    const level = (LEVELS.has(levelRaw) ? levelRaw : 'warn') as ScaffoldFinding['level'];
    const id = String(record.id ?? '').trim() || `m-${findings.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const patches = normalizePatches(record.patches);
    const file = String(record.file ?? '').trim() || patches.find((patch) => 'path' in patch)?.path;
    findings.push({
      id,
      level,
      title,
      detail: String(record.detail ?? '').trim(),
      ...(file ? { file } : {}),
      source: 'model',
      patches,
    });
    if (findings.length >= 12) break;
  }
  return { findings, notes: String(body.notes ?? '').trim() };
}

/** 一条建议会动到的文件（右栏在勾选项下面列出来） */
export function patchTargets(patches: SkeletonPatch[]): string[] {
  const paths: string[] = [];
  for (const patch of patches) {
    if (patch.action === 'setOptions') {
      const options = [
        ...(patch.add ?? []).map((option) => `+${option.id}`),
        ...(patch.remove ?? []).map((id) => `-${id}`),
      ];
      if (options.length) paths.push(`选项 ${options.join(' ')}`);
      continue;
    }
    const mark = patch.action === 'addFile' ? '+' : patch.action === 'removeFile' ? '-' : '~';
    paths.push(`${mark}${patch.path}`);
  }
  return paths;
}

/**
 * 把补丁应用到骨架 JSON 文本上。
 *
 * 只做机械增删改：改完不在这里判合法性，交给服务端的 `/scaffold/check` 与 preview 再验一遍，
 * 这样前端规则不会和服务端（parseSkeleton / assertSafeSkeletonPath）长出两套口径。
 *
 * @throws 骨架不是合法 JSON / 删除必需文件 / 路径不安全
 */
export function applySkeletonPatches(rawText: string, patches: SkeletonPatch[]): string {
  if (!patches.length) return rawText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `骨架不是合法 JSON，无法应用补丁：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('骨架 JSON 顶层必须是对象');
  }
  const skeleton = parsed as Record<string, unknown>;
  const files = Array.isArray(skeleton.files)
    ? skeleton.files.filter(
        (file): file is Record<string, unknown> => Boolean(file) && typeof file === 'object',
      )
    : [];
  let nextFiles = [...files];
  let options = Array.isArray(skeleton.options)
    ? skeleton.options.filter(
        (option): option is Record<string, unknown> =>
          Boolean(option) && typeof option === 'object',
      )
    : [];

  for (const patch of patches) {
    if (patch.action === 'setOptions') {
      const remove = new Set(patch.remove ?? []);
      options = options.filter((option) => !remove.has(String(option.id ?? '')));
      for (const option of patch.add ?? []) {
        if (options.some((item) => String(item.id ?? '') === option.id)) continue;
        options.push({ ...option });
      }
      const defaults = Array.isArray(skeleton.defaultOptions)
        ? skeleton.defaultOptions.map((id) => String(id))
        : [];
      skeleton.defaultOptions = defaults.filter((id) => !remove.has(id));
      continue;
    }
    if (!isSafeSkeletonPath(patch.path)) throw new Error(`补丁路径不安全：${patch.path}`);
    if (patch.action === 'addFile') {
      const exists = nextFiles.some((file) => String(file.path ?? '') === patch.path);
      if (exists) {
        nextFiles = nextFiles.map((file) =>
          String(file.path ?? '') === patch.path ? { ...file, content: patch.content } : file,
        );
      } else {
        nextFiles.push({
          path: patch.path,
          ...(patch.content ? { content: patch.content } : {}),
          ...(patch.when ? { when: patch.when } : {}),
        });
      }
    } else if (patch.action === 'replaceFile') {
      const exists = nextFiles.some((file) => String(file.path ?? '') === patch.path);
      if (!exists) throw new Error(`要替换的文件不在骨架里：${patch.path}`);
      nextFiles = nextFiles.map((file) =>
        String(file.path ?? '') === patch.path ? { ...file, content: patch.content } : file,
      );
    } else if (patch.action === 'removeFile') {
      const before = nextFiles.length;
      nextFiles = nextFiles.filter((file) => String(file.path ?? '') !== patch.path);
      if (nextFiles.length === before) continue;
      if (!nextFiles.length) throw new Error('补丁会删掉骨架里所有文件');
    }
  }

  skeleton.files = nextFiles;
  skeleton.options = options;
  return `${JSON.stringify(skeleton, null, 2)}\n`;
}

/**
 * 模型输入：骨架清单（全部文件）+ 骨架正文（按预算节选）+ 平台结论 + 项目信息。
 *
 * 不能直接把骨架 JSON 截断后丢给模型：骨架 48k 字符，截到 24k 会把后半段
 *（tests/auth.setup.ts、eslint.config.mjs、.husky/*、.github/*）整段切掉，
 * 模型每次都会“发现”这些文件缺失——实际只是没让它看见。
 * 所以清单永远完整，正文按重要度给，并明确告诉模型「清单里有的文件不算缺失」。
 */
export function buildScaffoldAuditPrompt(input: {
  space: SpaceSkeleton;
  platform: ScaffoldCheckResult | null;
  project: ScaffoldAuditInput;
}): string {
  const manifest = readSkeletonManifest(input.space?.raw ?? '');
  const issues = (input.platform?.checks ?? [])
    .map(
      (item) =>
        `- [${item.level}] ${item.title}${item.file ? `（${item.file}）` : ''}：${item.detail}`,
    )
    .join('\n');
  return [
    '## 本次项目',
    `- 名称：${input.project.name || '(未填)'}`,
    `- 技术栈：${input.project.stack}`,
    `- 目标目录：${input.project.dir || input.project.parentDir || '(未选)'}`,
    `- 基础地址：${input.project.baseURL || '(未填，用默认)'}`,
    `- 已勾选附带项：${input.project.options.join(' / ') || '无'}`,
    '',
    '## 平台确定性检查结论',
    issues || '- 没有查出问题',
    '',
    ...(manifest ? buildManifestSection(manifest, input.space) : []),
    ...(manifest ? buildContentSection(manifest) : []),
    '## 判断口径（重要）',
    '- 上「骨架文件清单」是这份骨架的全部文件，按清单判断有没有缺文件；',
    '- 「骨架正文」只是节选，正文里没有出现 ≠ 文件不存在，**禁止**据此报缺失；',
    '- 标注「仅当勾选 X」的文件只在本轮勾了 X 时才落盘，没勾不算缺失；',
    '- 文件正文里的 `{{#if X}}…{{/if}}` 是条件块，未勾 X 时会整段去掉，属正常；',
    '- 只有「清单里没有」「声明了但内容对不上」「选项与文件自相矛盾」才算问题。',
    '',
    '按「自动化项目提示词」的约定输出 JSON：{ "findings": [...], "notes": "" }。',
    '只输出 JSON 本身，不要解释、不要代码围栏。',
  ].join('\n');
}

interface SkeletonFileManifest {
  path: string;
  when: string;
  size: number;
  content: string;
}

/** 解析骨架 JSON 的文件清单；解析不了返回 null，由调用方退回全文 */
function readSkeletonManifest(raw: string): SkeletonFileManifest[] | null {
  if (!String(raw ?? '').trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const files = (parsed as { files?: unknown })?.files;
  if (!Array.isArray(files) || !files.length) return null;
  const list: SkeletonFileManifest[] = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') continue;
    const file = item as { path?: unknown; when?: unknown; content?: unknown };
    const filePath = String(file.path ?? '').trim();
    if (!filePath) continue;
    const content = String(file.content ?? '');
    list.push({
      path: filePath,
      when: String(file.when ?? '').trim(),
      size: content.length,
      content,
    });
  }
  return list.length ? list : null;
}

/** 清单：必须全量列出，模型据此判断「有没有这个文件」 */
function buildManifestSection(files: SkeletonFileManifest[], space: SpaceSkeleton): string[] {
  const lines = files.map((file) => {
    const gate = file.when
      ? file.when.startsWith('!')
        ? `仅当未勾选 ${file.when.slice(1)}`
        : `仅当勾选 ${file.when}`
      : '始终包含';
    return `- ${file.path}（${file.size} 字符，${gate}）`;
  });
  return [
    `## 骨架文件清单（共 ${files.length} 个，完整）`,
    `声明选项：${space.options.join(' / ') || '无'}；默认勾选：${space.defaultOptions.join(' / ') || '无'}`,
    ...lines,
    '',
  ];
}

/** 正文节选：配置 / 工具链类文件优先，单文件与总量都有上限 */
const CONTENT_TOTAL_BUDGET = 24000;
const CONTENT_FILE_BUDGET = 6000;

function contentRank(filePath: string): number {
  if (['package.json', 'playwright.config.ts', 'tsconfig.json', '.nvmrc'].includes(filePath)) {
    return 0;
  }
  if (/^(utils|fixtures|pages)\//.test(filePath)) return 1;
  if (/^(\.env|\.gitignore|eslint\.config|\.prettier|commitlint)/.test(filePath)) return 2;
  if (filePath === 'tests/auth.setup.ts') return 2;
  if (/^\.husky\//.test(filePath)) return 3;
  if (/^tests\//.test(filePath)) return 4;
  if (/^\.github\//.test(filePath)) return 5;
  return 6;
}

function buildContentSection(files: SkeletonFileManifest[]): string[] {
  const ordered = files
    .map((file, index) => ({ file, index, rank: contentRank(file.path) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);

  const blocks: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const { file } of ordered) {
    const head = `### ${file.path}${file.when ? `（仅当勾选 ${file.when.replace(/^!/, '未勾选 ')}）` : ''}`;
    if (!file.content.trim()) {
      blocks.push(`${head}\n（空文件）`);
      continue;
    }
    if (used >= CONTENT_TOTAL_BUDGET) {
      omitted.push(file.path);
      continue;
    }
    const room = Math.min(CONTENT_FILE_BUDGET, CONTENT_TOTAL_BUDGET - used);
    const trimmed =
      file.content.length > room
        ? `${file.content.slice(0, room)}\n…（本文件过长，已截断，共 ${file.content.length} 字符）`
        : file.content;
    used += Math.min(file.content.length, room);
    blocks.push(`${head}\n\`\`\`\n${trimmed}\n\`\`\``);
  }

  return [
    `## 骨架正文（节选，按重要度取前 ${CONTENT_TOTAL_BUDGET} 字符）`,
    ...blocks,
    ...(omitted.length
      ? ['', `以下文件正文未展开（仍在清单里、会正常生成）：${omitted.join('、')}`]
      : []),
    '',
  ];
}

export async function runScaffoldAudit(
  input: ScaffoldAuditInput,
  settings: LLMSettings | null,
  signal: AbortSignal | undefined,
  hooks: ScaffoldAuditHooks = {},
): Promise<ScaffoldAuditResult> {
  const started = Date.now();
  const logs: AuditLogEntry[] = [];
  let seq = 0;
  const log = (stage: AuditStage, level: AuditLogEntry['level'], text: string, detail?: string) => {
    const entry: AuditLogEntry = {
      seq: ++seq,
      at: Date.now(),
      stage,
      level,
      text,
      ...(detail ? { detail } : {}),
    };
    logs.push(entry);
    hooks.onLog?.(entry);
  };

  let space: SpaceSkeleton | null = null;
  let platform: ScaffoldCheckResult | null = null;
  let findings: ScaffoldFinding[] = [];
  let raw = '';
  let promptReady = false;
  let error = '';
  let firstTokenMs = 0;
  let chars = 0;
  let beats = 0;
  /* 1. 读空间骨架 */
  log('skeleton', 'info', '读取空间骨架…');
  try {
    space = await fetchSpaceSkeleton(input.stack);
    if (!space.ok) {
      error = space.error || '没有读到空间骨架';
      log('skeleton', 'error', error);
      return finish();
    }
    log(
      'skeleton',
      'info',
      `骨架 ${space.id}：${space.files} 个文件、${space.options.length} 个选项` +
        (space.source === 'builtin' ? '（内置版本）' : space.modified ? '（空间里改过）' : ''),
    );
    if (input.skeleton) log('skeleton', 'info', '本次使用带补丁的骨架（上一轮建议已应用）');
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log('skeleton', 'error', `读取骨架失败：${error}`);
    return finish();
  }

  /* 2. 平台体检 */
  log('structure', 'info', '开始结构检查（必需文件 / 路径 / 选项一致性）…');
  try {
    platform = await checkScaffold({
      stack: input.stack,
      name: input.name,
      parentDir: input.parentDir,
      ...(input.dir ? { dir: input.dir } : {}),
      baseURL: input.baseURL,
      options: input.options,
      skeleton: input.skeleton ?? null,
    });
    for (const entry of platform.logs) {
      const stage = (['skeleton', 'structure', 'render', 'target'] as AuditStage[]).includes(
        entry.stage as AuditStage,
      )
        ? (entry.stage as AuditStage)
        : 'render';
      log(
        stage,
        entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info',
        entry.message,
      );
    }
    log(
      'structure',
      platform.summary.errors ? 'warn' : 'info',
      `检查完成：${platform.summary.files} 个文件 / ${platform.summary.bytes} 字节，` +
        `${platform.summary.errors} 个必须处理、${platform.summary.warnings} 个提示`,
    );
    findings = platformFindings(platform.checks);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log('structure', 'error', `检查失败：${error}（仍然可以让 AI 看一遍骨架）`);
  }

  /* 3. 读「自动化项目提示词」 */
  let projectPrompt = '';
  try {
    const doc = await readDocsText('prompts', UI_AUTO_PROJECT_PROMPT_FILE);
    projectPrompt = doc.content ?? '';
    promptReady = Boolean(projectPrompt.trim());
    log(
      'prompt',
      promptReady ? 'info' : 'warn',
      promptReady
        ? `读到提示词「${UI_AUTO_PROJECT_PROMPT_FILE}」（${projectPrompt.length} 字符）`
        : `没读到「${UI_AUTO_PROJECT_PROMPT_FILE}」，本次只做平台检查`,
    );
  } catch (err) {
    log(
      'prompt',
      'warn',
      `读取「${UI_AUTO_PROJECT_PROMPT_FILE}」失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /* 4. 模型审阅 */
  if (promptReady && settings) {
    log('ai', 'info', `开始 AI 分析（${settings.model}）…`);
    const messages: ChatMessage[] = [
      { role: 'system', content: projectPrompt },
      {
        role: 'user',
        content: buildScaffoldAuditPrompt({
          space: space as SpaceSkeleton,
          platform,
          project: input,
        }),
      },
    ];
    let streamed = '';
    let lastRawAt = 0;
    try {
      for await (const chunk of streamChat(settings, messages, signal, { thinking: false })) {
        if (signal?.aborted) break;
        if (chunk.type === 'content') {
          if (!firstTokenMs) {
            firstTokenMs = Date.now() - started;
            hooks.onFirstToken?.(firstTokenMs);
            log('ai', 'info', `首字 ${(firstTokenMs / 1000).toFixed(1)}s`);
          }
          streamed += chunk.delta;
          chars = streamed.length;
          hooks.onDelta?.(chunk.delta);
          const now = Date.now();
          if (now - lastRawAt > 400) {
            lastRawAt = now;
            hooks.onRaw?.(streamed);
          }
        } else if (chunk.type === 'reasoning') {
          beats += 1;
          if (beats % 20 === 0) log('ai', 'info', `思考中… 已产出 ${chars} 字符`);
        }
      }
      raw = streamed.trim();
      hooks.onRaw?.(raw);
      log(
        'ai',
        'info',
        `模型输出完成：${raw.length} 字符，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (signal?.aborted) {
        log('ai', 'warn', '已取消 AI 分析，保留平台检查结果');
      } else {
        error = `AI 分析失败：${message}`;
        log('ai', 'error', error);
      }
    }

    if (raw) {
      try {
        const parsed = parseFindings(raw);
        for (const finding of parsed.findings) findings.push(finding);
        log(
          'parse',
          'info',
          `解析出 ${parsed.findings.length} 条建议` +
            (parsed.notes ? `；模型备注：${parsed.notes.slice(0, 80)}` : ''),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error = error || message;
        log('parse', 'error', `解析模型输出失败：${message}`, raw.slice(0, 2000));
      }
    }
  } else if (!settings) {
    log('ai', 'warn', '没有配置模型，跳过 AI 分析（只保留平台检查）');
  }

  return finish();

  function finish(): ScaffoldAuditResult {
    const errors = findings.filter((item) => item.level === 'error');
    const warns = findings.filter((item) => item.level === 'warn');
    const ok = errors.length === 0;
    const ms = Date.now() - started;
    log(
      'summary',
      ok ? 'info' : 'error',
      ok
        ? `共 ${findings.length} 条：${warns.length} 个提示${error ? '（AI 部分未完成）' : ''}`
        : `${errors.length} 个必须处理、${warns.length} 个提示`,
    );
    return {
      logs,
      findings,
      platform,
      space,
      raw,
      promptReady,
      stats: { ms, firstTokenMs, chars, beats, model: settings?.model ?? '' },
      ok,
      error,
    };
  }
}
