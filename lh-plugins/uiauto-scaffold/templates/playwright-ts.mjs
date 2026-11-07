/**
 * Playwright + TypeScript 企业级骨架（内置种子）。
 *
 * 正文就是同目录的 `playwright-ts.json`，与「新建项目」写进空间的骨架**完全同一份**：
 * 空间里没有这份文件时按它补种子，用户改过就改空间里那份，内置的不再覆盖。
 *
 * 骨架里的两种模板语法（渲染见 `../library.mjs`）：
 * - 占位符：`{{projectName}}` / `{{baseURL}}` / `{{stack}}`
 * - 条件块：`{{#if lint}} … {{/if}}` / `{{#unless lint}} … {{/unless}}`
 * 文件级开关在 `files[].when`（如 `"husky"`、`"!lint"`）。
 *
 * 改这份骨架的方式：改 JSON（或在空间里改），不要让模板字符串与 JSON 两处并存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PLAYWRIGHT_TS_SKELETON_ID = 'playwright-ts';

const BUILTIN_IDS = {
  'playwright-ts': path.join(HERE, 'playwright-ts.json'),
};

/** 内置骨架的原始 JSON 文本：种子写盘与指纹都基于它 */
export function builtinSkeletonText(id = PLAYWRIGHT_TS_SKELETON_ID) {
  const file = BUILTIN_IDS[id];
  if (!file) throw new Error(`没有内置骨架：${id}`);
  return fs.readFileSync(file, 'utf8');
}

/** 内置骨架（每次返回新对象，调用方改不坏缓存） */
export function enterpriseSkeleton(id = PLAYWRIGHT_TS_SKELETON_ID) {
  return JSON.parse(builtinSkeletonText(id));
}

export function hasBuiltinSkeleton(id) {
  return Boolean(BUILTIN_IDS[String(id ?? '')]);
}

/**
 * 兼容旧调用点：给项目名 / 地址 / 选项，直接返回文件清单。
 * 真正的渲染在 `../library.mjs`，这里只是把两项拼起来，避免模板内容出现两份。
 */
export { PLAYWRIGHT_TS_SKELETON_ID as SKELETON_ID };
