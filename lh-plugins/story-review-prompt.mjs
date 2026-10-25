/**
 * 「用户故事审查」提示词：缺省短种子 + 分段解析。
 *
 * 运行时与日常维护以空间「提示词管理/用户故事审查提示词.md」为准；增删改只改那里。
 * 完整写法可参考仓库 `prompt/用户故事审查提示词.md`。两段：`## 审查` / `## 补写`。
 */

import { STORY_REVIEW_PROMPT_FILE } from './plugin-prompts.mjs';

export { STORY_REVIEW_PROMPT_FILE };

export const REVIEW_SECTION = '审查';
export const FIX_SECTION = '补写';

/** 缺文件时写入的短种子；完整正文请维护空间文件，可参考仓库 prompt/用户故事审查提示词.md */
export const STORY_REVIEW_PROMPT_TEMPLATE = `# 用户故事审查提示词

> 由「用户故事审查」插件引用。日常增删改请只改本空间「提示词管理」里的本文件。
> 完整写法可参考仓库 \`prompt/用户故事审查提示词.md\`。

## 审查

（请在提示词管理中维护：只报待确认缺口，调用 req_save_check。）

## 补写

（请在提示词管理中维护：按勾选缺口补写故事，调用 req_set_stories。）
`;

/**
 * 解析提示词文件里的两段正文。
 * 认 `## 审查`（也接受「体检」「检查」「评审」）与 `## 补写`（也接受「修订」「修复」）；
 * 某段缺失或为空时返回空串，调用方拦下来提示，不用代码里的兜底顶替。
 */
export function parseStoryReviewPromptSections(text) {
  const raw = String(text ?? '');
  const out = { review: '', fix: '' };
  if (!raw.trim()) return out;
  let current = '';
  let buffer = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (current === 'review') out.review = body;
    else if (current === 'fix') out.fix = body;
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1];
      if (/审查|体检|检查|评审/.test(name)) current = 'review';
      else if (/补写|修订|修复|补齐/.test(name)) current = 'fix';
      else current = '';
      continue;
    }
    // 一级标题 / 引用块在段外，忽略即可（段内保留引用）
    if (!current && (/^#\s/.test(line) || /^>\s?/.test(line))) continue;
    if (current) buffer.push(line);
  }
  flush();
  return out;
}
