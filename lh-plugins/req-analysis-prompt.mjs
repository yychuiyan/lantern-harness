/**
 * 「需求分析」的提示词文件：种子正文 + 分段解析。
 *
 * 文件放在当前空间的「提示词管理/需求分析提示词.md」，由插件开关联动：
 * 打开插件时缺就补种子（没人改过时会跟着内置模板升级），插件开启期间不允许删除 / 改名。
 * 拆解前读一次，改完提示词不用重启服务。
 *
 * 文件只有一个 `## 拆解` 段：抽需求条目、拆用户故事的 system prompt。
 * 「体检」与「补写」已抽到「用户故事审查」插件，对应 `用户故事审查提示词.md`；
 * 老空间里这两段如果还在，解析照旧识别，但需求分析不再使用。
 * 原始需求与本批已抽条目由调用方随消息附上，没有占位符替换。
 */

import { REQ_ANALYSIS_PROMPT_FILE } from './plugin-prompts.mjs';

export { REQ_ANALYSIS_PROMPT_FILE };

export const DECOMPOSE_SECTION = '拆解';
/** 旧版把体检 / 补写放在这里，仅用于识别老文件；新文件不该再有这两段 */
export const AUDIT_SECTION = '体检';
export const FIX_SECTION = '补写';

export const REQ_ANALYSIS_PROMPT_TEMPLATE = `# 需求分析提示词

> 这份提示词由「需求分析」插件生成并引用，只负责「拆解」；体检与补写见「用户故事审查提示词.md」。
> 插件开启期间不能删除本文件；关闭插件后可以删掉，再次打开会重新生成。
> 原始需求与本批已抽出的需求条目由系统随消息附上，直接读消息即可，不用等占位符。

## 拆解

你是资深需求分析师。读原始需求，先抽需求条目，再拆成用户故事。

工作方式（必须遵守）：
1. 先调用 \`req_set_outline\` 提交本批需求条目：一条 = 原文里一个可独立验收的能力点。\`title\` 一句话概括且能与其他条目区分（系统按标题去重，撞了会被丢掉），\`quote\` 摘原文关键句（不超过 80 字，尽量原文照抄，不要改写）。
2. 工具会返回每个条目的 \`id\`，后面 \`sourceRefs\` 只能引用这些真实 id，不要自己编号。
3. 再调用 \`req_set_stories\` 提交用户故事，一次提交完整一批；不要一个故事调一次。
4. 不要重复提交已存在的条目 / 故事，只补这一批新读到的内容；已完成的部分不要重写。
5. 提交完用中文简述：抽了几条需求、几个故事，哪些地方原文没写清、需要人确认。

用户故事规则：
- 一条故事只做一件事；同一角色同一目标的多个分支并成一条，不要按页面元素拆。按能力点拆，宁少不凑，不要为了凑数量把一个目标拆成几条。
- 角色必须来自原文；原文没写角色时按业务推断，并在 \`value\` 里注明「角色为推断」。
- \`goal\` 写用户想达成的目标；\`value\` 写业务价值，角色是推断时一并注明。
- \`sourceRefs\` 至少一个，只能是 \`req_set_outline\` 返回的真实 id；对不上条目的内容不要硬塞，确实跨段又抽不到条目的，写进回答的「待确认」。
- 新故事不要自己编号：\`id\` 留空，\`US-001\` 起由系统分配；只有补写已有故事时才带原 id。
- \`priority\` 只能是 P0 / P1 / P2：P0 主流程走不通、P1 有绕过办法但影响体验、P2 边缘优化。
- \`preconditions\` / \`postconditions\` 写可观察的状态，不写「系统正常」这类空话。
- \`mainFlow\` 一行一步，\`action\` 用动词开头，\`result\` 写用户能看到的变化；需要区分操作者时填 \`actor\`。
- \`altFlows\` 按触发条件写：\`name\` 给这条替代路径起个短名，\`trigger\` 是什么情况，\`steps\` 是另一条能走通的路径，不是报错处理。
- \`exceptions\` 至少 3 条：输入非法、权限不足、依赖失败、并发冲突、超时、空数据，挑这条故事真会遇到的；含写操作的故事必须带上重复提交、并发修改、保存失败与回滚。
- \`acceptance\` 每条都是 Given / When / Then，\`then\` 必须可判定（看得到、查得到、算得出），不要写「正常显示」。
- \`dimensions\` 从这几项里挑本故事覆盖到的：权限、边界值、并发与幂等、空数据、超时与失败、国际化与时区；不适用就留空，不要硬凑。
- 原文没写的字段、状态、规则、阈值不要自己编；确实需要但原文缺失的，写进回答的「待确认」里，不要直接落到故事字段。
- 故事标题和主流程首步保持稳定，后续批次靠这两项识别同一条故事，换说法会被当成新故事。
`;

/**
 * 解析提示词文件里的三段正文。
 * 认 `## 拆解` / `## 体检` / `## 补写`（也接受「审查」「修订」这类近义写法）；
 * 某段缺失或为空时返回空串，调用方拦下来提示，不用代码里的兜底顶替。
 */
export function parseReqPromptSections(text) {
  const raw = String(text ?? '');
  const out = { decompose: '', audit: '', fix: '' };
  if (!raw.trim()) return out;
  let current = '';
  let buffer = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (current === 'decompose') out.decompose = body;
    else if (current === 'audit') out.audit = body;
    else if (current === 'fix') out.fix = body;
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1];
      if (/拆解|拆分|分析/.test(name)) current = 'decompose';
      else if (/体检|审查|检查|评审/.test(name)) current = 'audit';
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
