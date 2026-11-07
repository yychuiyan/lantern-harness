/**
 * 「自动化测试」提示词：与当前空间「提示词管理」里的 .md 文件联动。
 *
 * - 打开插件时由开关同步接口补种子（已存在不覆盖）；
 * - 生成页每次开始规划 / 探索前重新取一次，用户改完提示词不用重启；
 * - 插件开启期间这份提示词在提示词管理里不可删除，关闭后可删；
 * - 读不到时由调用方 toast 提示（平台以提示词管理为准，代码里的只是兜底）。
 *
 * 文件内容走「提示词管理」的 docs 接口读取（与提示词管理页面同源），
 * 改完提示词不用等插件服务重启。
 */
import { readDocsText, writeDocsText } from './project-docs';

const API = '/__tb_uiauto';

/** 提示词管理里的默认文件名（与 lh-plugins/plugin-prompts.mjs 保持一致） */
export const UI_AUTO_PROMPT_FILE = '自动化执行提示词.md';
/** 「自动化项目」入口用的那份：新建项目时体检 / 补全骨架 */
export const UI_AUTO_PROJECT_PROMPT_FILE = '自动化项目提示词.md';
/** 新建提示词对话框里的文件名示例（与插件默认那份保持一致） */
export const NEW_PROMPT_EXAMPLE = '自动化执行提示词';

export interface UiAutoPrompt {
  ok: boolean;
  file: string;
  exists: boolean;
  /** 规划阶段 system prompt（为空时用内置） */
  plan: string;
  /** 探索阶段 system prompt（为空时用内置） */
  agent: string;
  /** 生成代码：出码 / 写入的工程约定（项目结构、语法、代码规范） */
  code: string;
  /** 项目骨架：目录 / 标签口径，作为「生成」时的规范注入探索阶段 prompt */
  skeleton?: string;
  /** 读取失败时的原因（文件不存在以外的异常） */
  error?: string;
}

export interface UiAutoPromptSync {
  ok: boolean;
  enabled: boolean;
  file: string;
  created?: boolean;
  updated?: boolean;
  exists?: boolean;
  removed?: boolean;
}

/**
 * 「项目骨架」段里的框架子段挑选（与 lh-plugins/uiauto-prompt.mjs 同一口径）。
 *
 * 一份提示词要同时服务 Playwright / pytest / Selenium，目录与标签口径各不相同；
 * 放在同一段里用 `### playwright` 这类子标题分开，读取时按项目框架取一份：
 * - 整段没有 `###` 子段：原样返回（老提示词完全兼容）；
 * - 命中当前框架：共用部分（第一个子段之前）+ 该子段正文；
 * - 有子段但没命中：只返回共用部分 —— 宁可少给约定，也不要把别的框架的标签塞进来。
 */
export function pickFrameworkSection(section: string, framework?: string): string {
  const body = String(section ?? '').trim();
  if (!body) return '';
  const lines = body.split('\n');
  const starts: number[] = [];
  lines.forEach((line, index) => {
    // 只认三级标题：二级标题已经被 parseUiAutoSections 切成别的段了
    if (/^###\s+\S/.test(line)) starts.push(index);
  });
  if (!starts.length) return body;
  const shared = lines.slice(0, starts[0]).join('\n').trim();
  const wanted = String(framework ?? '')
    .trim()
    .toLowerCase();
  if (!wanted) return shared;
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const title = lines[start]
      .replace(/^###\s+/, '')
      .trim()
      .toLowerCase();
    // 标题里带框架名就算命中（`### Python + pytest` 这类写法也认）
    if (title.includes(wanted)) {
      const chunk = lines
        .slice(start + 1, end)
        .join('\n')
        .trim();
      return [shared, chunk].filter(Boolean).join('\n\n');
    }
  }
  return shared;
}

/**
 * 解析提示词文件的分段正文。
 * 认 `## 规划阶段` / `## 探索阶段` / `## 生成代码` / `## 项目骨架`
 * （也接受不带「阶段」的写法）；某段缺失或为空时返回空串，调用方据此拦下来提示。
 * `framework` 只影响「项目骨架」段：按项目框架挑 `### playwright` 这类子段。
 */
export function parseUiAutoSections(
  text: string,
  framework?: string,
): Pick<UiAutoPrompt, 'plan' | 'agent' | 'code' | 'skeleton'> {
  const raw = String(text ?? '');
  const out = { plan: '', agent: '', code: '', skeleton: '' };
  if (!raw.trim()) return out;
  let current: '' | 'plan' | 'agent' | 'code' | 'skeleton' = '';
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (current) out[current] = body;
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1];
      if (/骨架/.test(name)) current = 'skeleton';
      else if (/规划/.test(name)) current = 'plan';
      else if (/探索/.test(name)) current = 'agent';
      else if (/代码|出码/.test(name)) current = 'code';
      else current = '';
      continue;
    }
    // 一级标题 / 引用块在段外，忽略即可（段内保留引用）
    if (!current && (/^#\s/.test(line) || /^>\s?/.test(line))) continue;
    if (current) buffer.push(line);
  }
  flush();
  // 骨架段按框架挑子段；其它段只有一份，与框架无关
  out.skeleton = pickFrameworkSection(out.skeleton, framework);
  return out;
}

/**
 * 新建提示词时的空白骨架。
 * 三段标题必须保留：生成前会按 `## 规划阶段` / `## 探索阶段` / `## 生成代码`
 * 切段，缺哪段就等于那一步没有提示词。
 */
export function buildPromptSkeleton(name: string): string {
  const title = name.replace(/\.md$/i, '').trim() || UI_AUTO_PROMPT_FILE.replace(/\.md$/i, '');
  return [
    `# ${title}`,
    '',
    '> 自动化测试提示词：生成时按下面三段分别作为「规划 / 探索 / 出码」的系统提示词。',
    '',
    '## 规划阶段',
    '',
    '- 一行一步，只写「动作 + 目标」；',
    '- 覆盖：打开页面、关键前置（登录 / 导航）、核心操作、至少一条结果断言。',
    '',
    '## 探索阶段',
    '',
    '- 每一步先用可读描述定位目标，再回填真实定位器；',
    '- 关键节点截一张图，方便人确认；',
    '- 账号 / 密码等占位数据写成 `${ENV_NAME}`，不要写死。',
    '',
    '## 生成代码',
    '',
    '- 复用项目已有的 page object / fixture / 登录态，不要另起一套；',
    '- 选择器用探索阶段确认过的定位器，不加与断言无关的 sleep。',
    '',
  ].join('\n');
}

/**
 * 规整提示词文件名：补 `.md`、去掉路径分隔符等非法字符。
 * 不合法的返回空串，由调用方拦下并提示。
 */
export function normalizePromptFileName(raw: string): string {
  const cleaned = Array.from(String(raw ?? ''))
    // 控制字符与文件系统保留字符一律换成空格（不用正则，避免 no-control-regex）
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const withExt = /\.md$/i.test(cleaned) ? cleaned : `${cleaned}.md`;
  return withExt.length > 120 ? '' : withExt;
}

/**
 * 在「提示词管理」里新建一份提示词，返回文件名。
 * `from` 有值且读得到就整份复制（同框架另一份改改就能用），否则写三段骨架。
 */
export async function createUiAutoPrompt(rawName: string, from?: string): Promise<string> {
  const file = normalizePromptFileName(rawName);
  if (!file) throw new Error('文件名不合法：不能包含 / \\ : * ? " < > |');
  let content = '';
  if (from) {
    try {
      content = (await readDocsText('prompts', from)).content;
    } catch {
      // 来源读不到就退回骨架，不要把新建也一起失败
      content = '';
    }
  }
  await writeDocsText('prompts', file, content.trim() ? content : buildPromptSkeleton(file));
  return file;
}

/** 开关联动：enabled=true 缺提示词就补种子；false 只停用、不删文件 */ export async function syncUiAutoPrompt(
  enabled: boolean,
): Promise<UiAutoPromptSync> {
  const res = await fetch(`${API}/prompt/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`同步 UI 自动化测试提示词失败（${res.status}）`);
  return (await res.json()) as UiAutoPromptSync;
}

/**
 * 读取当前空间某份提示词的三段正文；不传 file 用插件默认那份。
 * `framework` 只影响「项目骨架」段：按项目框架挑 `### playwright` / `### pytest` 子段。
 * 读不到时各段为空串，由调用方拦下来提示，不用代码里的兜底顶替。
 */
export async function fetchUiAutoPrompt(file?: string, framework?: string): Promise<UiAutoPrompt> {
  const wanted = String(file ?? '').trim() || UI_AUTO_PROMPT_FILE;
  const empty: UiAutoPrompt = {
    ok: false,
    file: wanted,
    exists: false,
    plan: '',
    agent: '',
    code: '',
  };
  try {
    const { content } = await readDocsText('prompts', wanted);
    return {
      ok: true,
      file: wanted,
      exists: Boolean(content.trim()),
      ...parseUiAutoSections(content, framework),
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
