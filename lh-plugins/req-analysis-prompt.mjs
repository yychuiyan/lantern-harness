/**
 * 「需求分析」提示词：缺省短种子 + 分段解析。
 *
 * 运行时与日常维护以空间「提示词管理/需求分析提示词.md」为准；增删改只改那里。
 * 完整写法可参考仓库 `prompt/需求分析提示词.md`（仅参考，不当运行种子）。
 * 打开插件时缺文件才写入下方短 TEMPLATE；两段为 `## 拆解需求` / `## 生成用户故事`。
 */

import { REQ_ANALYSIS_PROMPT_FILE, SOURCE_STRUCTURE_PROMPT_FILE } from './plugin-prompts.mjs';

export { REQ_ANALYSIS_PROMPT_FILE, SOURCE_STRUCTURE_PROMPT_FILE };

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
  const out = { decompose: '', stories: '', structure: '', audit: '', fix: '' };
  if (!raw.trim()) return out;
  let current = '';
  let buffer = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (current === 'decompose') out.decompose = body;
    else if (current === 'stories') out.stories = body;
    else if (current === 'structure') out.structure = body;
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
      if (/原文结构/.test(name)) current = 'structure';
      else if (/拆解需求|整理需求|整理条目/.test(name)) current = 'decompose';
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

/**
 * 缺文件时写入「提示词管理/原文结构提示词.md」。
 * 日常只改空间里那一份；这里只在文件不存在、或用户没改过种子时补上。
 */
export const SOURCE_STRUCTURE_PROMPT_TEMPLATE = `# 原文结构提示词

整理需求原文的目录，方便按大类阅读。只输出 JSON，不要解释。

## 规则

- 只做分组。\`category\`、\`title\`、\`body\` 都必须是原文里连续出现的原句，一个字都不要改写。
- \`category\` 是大类或模块（例如「工单系统」）。文档没有单独写出大类时，用原文里最接近的模块名；实在没有就不要编。
- \`title\` 是该条需求的短标题，用原文标题，不要自己起名。
- \`body\` 是这条标题下面的原文段落。标题行本身不要再写进 body。
- 不同文档的标题层级不一样，按语义归组，不要假设「# 一定是大类、## 一定是标题」。
- 对不上原文的条目不要输出。

## 输出

\`\`\`json
{"groups":[{"category":"原文中的大类","items":[{"title":"原文中的需求标题","body":"标题下的原文段落"}]}]}
\`\`\`
`;
