/**
 * 脚手架渲染：把「技术栈 + 项目名 + 被测地址 + 可选内容」变成待写入的文件清单。
 *
 * 这里只做纯计算，不碰磁盘：预览接口和真正写盘都基于同一份结果，
 * 保证「预览看到什么就写什么」。
 *
 * 文件清单来源优先级：
 *   空间骨架 JSON（`library.loadSkeleton`）→ 内置骨架（`templates/*.json`）
 * 骨架缺失或未解析时回退，保证「新建项目」不会因为配置文件坏了而不可用。
 */
import { findStack, SCAFFOLD_STACKS } from './manifest.mjs';
import {
  assertSafeSkeletonPath,
  defaultSkeletonId,
  parseSkeleton,
  pickOptions,
  renderFromSkeleton,
  whenMatches,
} from './library.mjs';
import { builtinSkeletonText, hasBuiltinSkeleton } from './templates/playwright-ts.mjs';

/** 项目名：字母 / 数字 / 汉字开头，允许空格、点、下划线、连字符，最长 60 */
const PROJECT_NAME = /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 ._-]{0,59}$/;

export function normalizeProjectName(raw) {
  const value = String(raw ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) throw new Error('请填写项目名');
  if (!PROJECT_NAME.test(value)) {
    throw new Error('项目名只能用字母、数字、汉字、空格、点、下划线或连字符');
  }
  return value;
}

/** 被测地址：允许留空（用模板默认值），填了必须是 http(s) 且去掉结尾斜杠 */
export function normalizeBaseURL(raw) {
  const value = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!value) return '';
  if (!/^https?:\/\/[^\s]+$/i.test(value)) {
    throw new Error('被测地址必须以 http:// 或 https:// 开头');
  }
  return value;
}

/**
 * 只保留声明过的选项，顺序按声明（注册表或骨架），去重。
 * 兼容旧签名：第一个参数既可以是栈（取 `.options`），也可以直接是选项数组。
 */
export function normalizeOptions(stackOrOptions, raw) {
  const declared = Array.isArray(stackOrOptions)
    ? stackOrOptions
    : Array.isArray(stackOrOptions?.options)
      ? stackOrOptions.options
      : [];
  const ids = declared.map((option) => (typeof option === 'string' ? option : option.id));
  const picked = new Set(Array.isArray(raw) ? raw.filter((id) => ids.includes(id)) : []);
  return ids.filter((id) => picked.has(id));
}

/** 内置骨架（缺省回退）；还没落地的栈没有内置骨架 */
function builtinSkeletonFor(stackId) {
  const id = defaultSkeletonId(stackId);
  if (!id || !hasBuiltinSkeleton(id)) return null;
  return parseSkeleton(builtinSkeletonText(id), { fallbackId: id });
}

/**
 * @param {{
 *   stack?: string,
 *   name?: string,
 *   baseURL?: string,
 *   options?: string[],
 *   skeleton?: object|string|null,
 *   skeletonSource?: 'space'|'builtin'|'custom'
 * }} input
 * @returns {{
 *   stack: string,
 *   skeleton: string,
 *   skeletonSource: 'space'|'builtin'|'custom',
 *   promptFile: string,
 *   layout: Record<string, string>,
 *   options: string[],
 *   files: Array<{ path: string, content: string }>
 * }}
 */
export function renderScaffold(input = {}) {
  const stack = findStack(input.stack);
  if (!stack) {
    const ids = SCAFFOLD_STACKS.map((item) => item.id).join(' / ');
    throw new Error(`不支持的技术栈：${input.stack || '(空)'}；可选 ${ids}`);
  }
  if (stack.status !== 'ready') {
    throw new Error(`${stack.label} 的骨架还在规划中，当前只能用 Playwright + TypeScript`);
  }

  // 空间里那份骨架优先；传进来的骨架写坏了就抛出去，不静默换一份（否则「预览≠生成」）
  const provided = input.skeleton;
  const skeleton = provided ? parseSkeleton(provided, { fallbackId: stack.skeleton }) : null;
  const effective = skeleton ?? builtinSkeletonFor(stack.id);
  if (!effective) throw new Error(`${stack.label} 还没有骨架配置`);

  const projectName = normalizeProjectName(input.name);
  const baseURL = normalizeBaseURL(input.baseURL) || 'http://127.0.0.1:3000';
  const options = pickOptions(effective, input.options);
  const rendered = renderFromSkeleton(effective, { projectName, baseURL, options });

  // 最后一道闸：路径安全 + 过滤后仍然不能重复
  const seen = new Set();
  const files = [];
  for (const file of rendered.files) {
    const rel = assertSafeSkeletonPath(file?.path);
    if (seen.has(rel)) throw new Error(`骨架里有重复文件：${rel}`);
    seen.add(rel);
    files.push({ path: rel, content: String(file?.content ?? '') });
  }
  if (!files.length) throw new Error('骨架没有产出任何文件');

  return {
    stack: stack.id,
    skeleton: effective.id,
    skeletonSource: provided ? input.skeletonSource || 'space' : 'builtin',
    promptFile: effective.promptFile || stack.promptFile || '',
    layout: { ...effective.layout },
    options: rendered.options,
    files,
  };
}

export { whenMatches };
