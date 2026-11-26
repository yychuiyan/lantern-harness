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

> 用于已有用例的遗漏场景探测和结构化补全。只提交真实缺口，不为凑数虚构。

## 探测

先通读需求和已有用例，再找人工容易遗漏、但实际会导致质量风险的场景。已有用例覆盖的场景不要重复提交；同一场景只报一次。

1. 在 Lantern 工作台内调用 case_save_blindspots；MCP 客户端先调用 lantern_case_blindspot_context 获取文件哈希和已有条目，再调用 lantern_case_blindspot_save 保存完整报告。
2. 每条尽量填写真实需求编号；没有编号时使用同组一致的短编号。写回时插到归属需求组最后一行之后。
3. 只使用以下四类：
   - nonfunctional：超时与失败恢复、弱网 / 断网恢复、大列表渲染、异步任务、外部依赖降级等。
   - security：越权访问、未登录访问、重复提交、并发写入、超长 / 注入输入、敏感信息泄露等。
   - compatibility：分辨率与缩放、浏览器 / 客户端 / App 版本、键盘与读屏、深浅色主题、时区、文件格式、移动端横竖屏等。
   - business：状态互斥、唯一性、跨天边界、批量部分失败、跨模块联动、审批回退、权限生效时机等。
4. 每条写清为什么人工容易漏；说不清依据的不要报。
5. 每条必须填写 category、severity、title、why、precondition、steps、expected、priority、reqAnchor。
6. steps 一步一个动作，最多 20 步；expected 必须是可判定的页面、状态、文案、数量或结果。
7. 功能测试补充不得使用“模拟接口 / 服务超时”“Mock / 桩”“报文 / 状态码”等实现方式；改写成用户可操作的断网、空数据、权限、外部渠道不可用等场景，或归入 nonfunctional / security 并明确边界。
8. reqAnchor 只表示归属需求组，不得直接写进模块、子模块或引用需求点。需求编号使用根需求 XQ；没有根需求编号时写“无”。模块 / 子模块从同一需求组的已有用例继承，引用需求点只使用真实 RO / US。
9. 纯数字编号文件必须从当前最大编号继续递增，不要生成 TC-BL- 前缀；新增行用例状态固定为“待验证”，实际结果留空。

## 补全

只处理用户明确选择的条目。原样保留 id、category、title、why、severity、priority 和 reqAnchor；只补前置条件、步骤和可判定预期，最多 20 步，不要新增未选择条目。每个选中 id 都必须返回，且不得改动其它字段。

Lantern 工作台继续使用 case_save_blindspots。MCP 客户端先通过 lantern_case_blindspot_save 保存补全结果，再调用 lantern_case_blindspot_draft 生成预览。预览逐条展示编号、需求编号、模块、子模块、前置条件、步骤、预期、优先级、状态、引用需求点和插入位置；字段不完整时必须拒绝生成草稿。用户明确确认完整预览后再调用 lantern_case_blindspot_apply。文件哈希或草稿 revision 变化时必须重新探测、补全和预览。
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
