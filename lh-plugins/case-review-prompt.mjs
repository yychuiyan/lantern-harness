/**
 * 「用例质量评审」与「场景遗漏补全」提示词：缺省短种子 + 分段解析。
 *
 * 运行时与日常维护以空间「提示词管理」同名文件为准；增删改只改那里。
 * 完整写法可参考仓库 `prompt/用例质量评审提示词.md`、`prompt/场景遗漏补全提示词.md`。
 */

import { BLINDSPOT_PROMPT_FILE, CASE_REVIEW_PROMPT_FILE } from './plugin-prompts.mjs';

export { BLINDSPOT_PROMPT_FILE, CASE_REVIEW_PROMPT_FILE };

export const REVIEW_SECTION = '评审';
export const DETECT_SECTION = '探测';
export const COMPLETE_SECTION = '补全';

/** 缺文件时写入的短种子；完整正文请维护空间文件，可参考仓库 prompt/用例质量评审提示词.md */
export const CASE_REVIEW_PROMPT_TEMPLATE = `# 用例质量评审提示词

> 由「用例质量评审」插件引用。日常增删改请只改本空间「提示词管理」里的本文件。
> 完整写法可参考仓库 \`prompt/用例质量评审提示词.md\`。

## 评审

（请在提示词管理中维护：逐条判定打分，调用 case_save_review。）
`;

/** 缺文件时写入的短种子；完整正文请维护空间文件，可参考仓库 prompt/场景遗漏补全提示词.md */
export const BLINDSPOT_PROMPT_TEMPLATE = `# 场景遗漏补全提示词

> 由「场景遗漏补全」插件引用。日常增删改请只改本空间「提示词管理」里的本文件。
> 完整写法可参考仓库 \`prompt/场景遗漏补全提示词.md\`。

## 探测

（请在提示词管理中维护：找测试盲区，调用 case_save_blindspots。）

## 补全

（请在提示词管理中维护：按勾选盲区补齐可执行步骤。）
`;

/**
 * 解析「用例质量评审提示词.md」的 `## 评审` 段。
 * 认 `## 评审`（也接受「质检」「检查」「审查」）；
 * 缺失或为空时返回空串，调用方拦下来提示，不用代码里的兜底顶替。
 */
export function parseCaseReviewPromptSections(text) {
  const raw = String(text ?? '');
  const out = { review: '' };
  if (!raw.trim()) return out;
  let current = false;
  let buffer = [];
  const flush = () => {
    if (current) out.review = buffer.join('\n').trim();
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = /评审|质检|检查|审查/.test(heading[1]);
      continue;
    }
    // 一级标题 / 引用块在段外，忽略即可（段内保留引用）
    if (!current && (/^#\s/.test(line) || /^>\s?/.test(line))) continue;
    if (current) buffer.push(line);
  }
  flush();
  return out;
}

/**
 * 解析「场景遗漏补全提示词.md」的两段正文。
 * 认 `## 探测`（也接受「盲区」「遗漏」「扫描」）与 `## 补全`（也接受「补齐」「完善」「改写」）。
 */
export function parseBlindspotPromptSections(text) {
  const raw = String(text ?? '');
  const out = { detect: '', complete: '' };
  if (!raw.trim()) return out;
  let current = '';
  let buffer = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (current === 'detect') out.detect = body;
    else if (current === 'complete') out.complete = body;
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1];
      if (/探测|盲区|遗漏|扫描/.test(name)) current = 'detect';
      else if (/补全|补齐|完善|改写/.test(name)) current = 'complete';
      else current = '';
      continue;
    }
    if (!current && (/^#\s/.test(line) || /^>\s?/.test(line))) continue;
    if (current) buffer.push(line);
  }
  flush();
  return out;
}
