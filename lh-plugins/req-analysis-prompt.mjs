/**
 * 「需求分析」提示词：缺省短种子 + 分段解析。
 *
 * 运行时与日常维护以空间「提示词管理/需求分析提示词.md」为准；增删改只改那里。
 * 完整写法可参考仓库 `prompt/需求分析提示词.md`（仅参考，不当运行种子）。
 * 打开插件时缺文件才写入下方短 TEMPLATE；两段为 `## 拆解需求` / `## 生成用户故事`。
 */

import { REQ_ANALYSIS_PROMPT_FILE } from './plugin-prompts.mjs';

export { REQ_ANALYSIS_PROMPT_FILE };

export const DECOMPOSE_SECTION = '拆解需求';
export const STORIES_SECTION = '生成用户故事';
/** 旧版单段标题；解析时整段复用到 decompose + stories */
export const LEGACY_DECOMPOSE_SECTION = '拆解';
/** 旧版把体检 / 补写放在这里，仅用于识别老文件；新文件不该再有这两段 */
export const AUDIT_SECTION = '体检';
export const FIX_SECTION = '补写';

/** 缺文件时写入提示词管理的短种子；完整正文请维护空间文件，写稿可参考仓库 prompt/需求分析提示词.md */
export const REQ_ANALYSIS_PROMPT_TEMPLATE = `# 需求分析提示词

> 由「需求分析」插件引用。日常增删改请只改本空间「提示词管理」里的本文件。
> 完整写法可参考仓库 \`prompt/需求分析提示词.md\`。体检与补写见「用户故事审查提示词.md」。

## 拆解需求

（请在提示词管理中维护：按文档父级整理查/改子点，一能力一点。）

## 生成用户故事

（请在提示词管理中维护：按子点拆用户故事，sourceRefs 挂真实 id。）
`;

/**
 * 解析提示词文件分段。
 * 认 `## 拆解需求` / `## 生成用户故事`；旧 `## 拆解` 整段复用到两段；
 * 仍识别旧 `## 体检` / `## 补写`（需求分析不再使用）。
 */
export function parseReqPromptSections(text) {
  const raw = String(text ?? '');
  const out = { decompose: '', stories: '', audit: '', fix: '' };
  if (!raw.trim()) return out;
  let current = '';
  let buffer = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (current === 'decompose') out.decompose = body;
    else if (current === 'stories') out.stories = body;
    else if (current === 'legacy') {
      // 旧单段「## 拆解」：两边都用，靠运行时工具白名单限权
      if (body) {
        if (!out.decompose) out.decompose = body;
        if (!out.stories) out.stories = body;
      }
    } else if (current === 'audit') out.audit = body;
    else if (current === 'fix') out.fix = body;
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1].trim();
      if (/拆解需求|整理需求|整理条目/.test(name)) current = 'decompose';
      else if (/生成用户故事/.test(name)) current = 'stories';
      else if (/^拆解$/.test(name) || /^(拆分|分析)$/.test(name)) current = 'legacy';
      else if (/拆解|拆分/.test(name) && !/需求|故事|审查|补写/.test(name)) current = 'legacy';
      else if (/体检|审查|检查|评审/.test(name)) current = 'audit';
      else if (/补写|修订|修复|补齐/.test(name)) current = 'fix';
      else current = '';
      continue;
    }
    if (!current && (/^#\s/.test(line) || /^>\s?/.test(line))) continue;
    if (current) buffer.push(line);
  }
  flush();
  if (out.decompose && !out.stories) out.stories = out.decompose;
  if (out.stories && !out.decompose) out.decompose = out.stories;
  return out;
}
