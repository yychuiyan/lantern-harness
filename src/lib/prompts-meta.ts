/** 提示词库约定：文件名与保护规则（平铺在 prompts/） */

/** 当前空间的提示词（用例生成下拉不展示、不可删除） */
export const CHAT_SYSTEM_PROMPT_FILE = '默认提示词.md';

/** 历史文件名：读取与保护时仍识别，启动时迁到 CHAT_SYSTEM_PROMPT_FILE */
export const LEGACY_CHAT_PROMPT_FILES = [
  '空间提示词.md',
  '空间默认提示词.md',
  '系统提示词.md',
  'AI工作台系统提示词.md',
] as const;

/** 默认文案：文件缺失或未启动本地 docs 时回退（仅普通对话；与 config/seeds 默认提示词同源） */
export const DEFAULT_CHAT_SYSTEM_PROMPT =
  '你是 Lantern Harness 的 AI 助手，协助思考、写作、分析、编程与日常工作。\n';

/**
 * 插件自带的提示词文件 → 所属插件 id。
 *
 * 打开插件时会把这份提示词写进「提示词管理」（已存在不覆盖，用户改过就用用户的），
 * 插件运行时会引用它；只要插件还是开启状态，这份文件就不允许删除 / 改名，
 * 关掉插件后才可以删。删除保护在服务端也做了一遍（见 lh-project-docs.mjs）。
 */
export const PLUGIN_PROMPT_FILES: Record<string, string> = {
  '工作汇报提示词.md': 'reports',
  'Playwright提示词.md': 'uiAuto',
};

/** 提示词管理中禁止删除的文件（basename，含旧名） */
export const PROTECTED_PROMPT_FILES = new Set<string>([
  CHAT_SYSTEM_PROMPT_FILE,
  ...LEGACY_CHAT_PROMPT_FILES,
]);

export function isProtectedPrompt(filePathOrName: string): boolean {
  const base = filePathOrName.split('/').pop() ?? filePathOrName;
  return PROTECTED_PROMPT_FILES.has(base);
}

/** 这份提示词是否由某个插件维护（不论插件是否开启） */
export function promptOwnerPlugin(filePathOrName: string): string | undefined {
  const base = filePathOrName.split('/').pop() ?? filePathOrName;
  return PLUGIN_PROMPT_FILES[base];
}

/**
 * 插件开启期间，它维护的提示词文件不允许删除 / 改名。
 * @param enabled 插件开关表；不传时按当前空间配置判断
 */
export function isPluginPromptLocked(
  filePathOrName: string,
  enabled?: Record<string, boolean>,
): boolean {
  const owner = promptOwnerPlugin(filePathOrName);
  if (!owner) return false;
  return enabled ? enabled[owner] === true : false;
}

/**
 * 统一的「不可删除 / 不可覆盖」判定：
 * 1. 内置默认提示词永远保护；
 * 2. 插件维护的提示词，在插件开启时保护（关闭后可删）。
 */
export function isPromptLocked(filePathOrName: string, enabled?: Record<string, boolean>): boolean {
  return isProtectedPrompt(filePathOrName) || isPluginPromptLocked(filePathOrName, enabled);
}

/** 归一化提示词相对路径：项目里存的是相对提示词根目录的路径，比较前统一分隔符与 `./` */
export function normalizePromptPath(filePathOrName: string): string {
  return (filePathOrName || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/**
 * 这份提示词此刻是否真的被挂载着（「引用中」只看真实挂载）。
 *
 * 一个项目只挂一份提示词，换掉之后上一份就不再被引用——所以不能按文件名约定判断：
 * `Playwright提示词.md` 只是插件自带的种子 / 模板，项目切到别的提示词后它就不再是引用。
 */
export function isPromptReferenced(
  filePathOrName: string,
  mounted?: Record<string, string>,
): boolean {
  if (!mounted) return false;
  return Boolean(mounted[normalizePromptPath(filePathOrName)]);
}

/**
 * 「关联插件」列要显示的名字。
 * - 插件维护的提示词 → 插件 id（调用方再换成中文名）；
 * - 系统提示词（默认提示词.md）→ `system`，界面上显示「系统默认」；
 * - 插件里实际挂载的提示词（比如自动化测试项目切到了 pytest提示词.md）→ 挂载它的插件 id；
 * - 其它 → 空串，显示「未关联」。
 *
 * @param mounted 被插件挂载的提示词：归一化路径 → 插件 id。
 *   文件名只是「默认归属」，用户可以把任意提示词挂到项目上，那份也算被该插件引用。
 */
export function promptOwnerKind(
  filePathOrName: string,
  mounted?: Record<string, string>,
): 'system' | string {
  const base = filePathOrName.split('/').pop() ?? filePathOrName;
  if (isProtectedPrompt(base)) return 'system';
  const byName = promptOwnerPlugin(base);
  if (byName) return byName;
  if (!mounted) return '';
  return mounted[normalizePromptPath(filePathOrName)] ?? '';
}

/** 锁定的原因，用于提示文案 */
export function promptLockedReason(
  filePathOrName: string,
  enabled?: Record<string, boolean>,
): string {
  if (isProtectedPrompt(filePathOrName)) return '默认提示词不可删除';
  const owner = promptOwnerPlugin(filePathOrName);
  if (owner && enabled?.[owner]) {
    return '插件开启中，这份提示词由插件自带并维护；先在「我的插件」里关闭对应插件再删除';
  }
  return '';
}

/** 用例生成下拉应排除的提示词（仅 AI 工作台使用） */
export function isChatOnlyPrompt(filePathOrName: string): boolean {
  const base = filePathOrName.split('/').pop() ?? filePathOrName;
  return isProtectedPrompt(base);
}
