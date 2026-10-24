/**
 * 「生成测试用例」的提示词：与当前空间「提示词管理」里的 .md 文件联动。
 *
 * 一个用例类型只挂一份（见 case-types 的 bindCaseTypePrompt），
 * 未挂载时抽屉不允许确认；这里只负责「新建一份提示词」。
 */
import { writeDocsText } from './project-docs';
import { normalizePromptFileName } from './ui-auto-prompt';

/** 新建提示词时的空白骨架（`## 生成用例` 段就是本轮的系统提示词） */
export function buildCasePromptSkeleton(name: string): string {
  const title = name.replace(/\.md$/i, '').trim() || '用例生成提示词';
  return [
    `# ${title}`,
    '',
    '> 用例生成提示词：确认后本轮只按这份提示词写用例，工作台的系统提示词不再叠加。',
    '',
    '## 生成用例',
    '',
    '- 逐条覆盖需求 / 用户故事，一条用例只验一个点，不合并步骤；',
    '- 前置条件、操作步骤、预期结果要一一对应，步骤给人看也能照着执行；',
    '- 正常流程之外补齐边界值、异常与业务规则，非功能（性能 / 兼容 / 安全）按需覆盖；',
    '- 每条用例标注优先级 P0–P3，P0 放主流程与核心校验；',
    '- 字段与顺序严格跟随用例模板；Ideal 表时「模块」=大模块、「子模块」=小模块原文，并按小模块行序输出；',
    '- 「待业务确认」类不确定项也要写成用例，并在「备注」标注「待业务确认：…」，不要只写进未覆盖说明；',
    '',
  ].join('\n');
}

/**
 * 在「提示词管理」里新建一份用例生成提示词，返回文件名。
 */
export async function createCasePrompt(rawName: string): Promise<string> {
  const file = normalizePromptFileName(rawName);
  if (!file) throw new Error('文件名不合法：不能包含 / \\ : * ? " < > |');
  await writeDocsText('prompts', file, buildCasePromptSkeleton(file));
  return file;
}
