/**
 * 「自动化测试」提示词：缺省短种子 + 分段解析。
 *
 * 运行时与日常维护以空间「提示词管理/Playwright提示词.md」为准；增删改只改那里。
 * 完整写法可参考仓库 `prompt/Playwright提示词.md`。三段：规划 / 探索 / 生成代码。
 */

import { UI_AUTO_PROMPT_FILE } from './plugin-prompts.mjs';

export { UI_AUTO_PROMPT_FILE };

export const PLAN_SECTION = '规划阶段';
export const AGENT_SECTION = '探索阶段';
export const CODE_SECTION = '生成代码';

/** 缺文件时写入的短种子；完整正文请维护空间文件，可参考仓库 prompt/Playwright提示词.md */
export const UI_AUTO_PROMPT_TEMPLATE = `# Playwright提示词

> 由「自动化测试」插件引用。日常增删改请只改本空间「提示词管理」里的本文件。
> 完整写法可参考仓库 \`prompt/Playwright提示词.md\`。占位符：\`{{project}}\` \`{{dir}}\` \`{{language}}\` \`{{plan}}\`。

## 规划阶段

（请在提示词管理中维护：拆步骤计划，调用 ui_plan_steps。）

## 探索阶段

（请在提示词管理中维护：浏览器定位并提交步骤 IR。）

{{plan}}

## 生成代码

（请在提示词管理中维护：出码与落盘约定。）
`;

/**
 * 解析提示词文件里的三段正文。
 * 认 `## 规划阶段` / `## 探索阶段` / `## 生成代码`（也接受不带「阶段」的写法）；
 * 某段缺失或为空时返回空串，调用方回退到内置提示词 / 不追加对应段落。
 */
export function parseUiAutoPrompt(text) {
  const raw = String(text ?? '');
  const out = { plan: '', agent: '', code: '' };
  if (!raw.trim()) return out;
  const lines = raw.split('\n');
  let current = '';
  let buffer = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (current === 'plan') out.plan = body;
    else if (current === 'agent') out.agent = body;
    else if (current === 'code') out.code = body;
    buffer = [];
  };
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1];
      if (/规划/.test(name)) current = 'plan';
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
  return out;
}
