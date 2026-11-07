/**
 * 骨架配置库：空间里的骨架 JSON 怎么读、怎么渲染、什么时候补种子。
 *
 * 为什么把骨架挪到文件里（而不是写死在代码里）：
 * - 企业里各团队的目录 / 标签 / 流水线口径不一样，骨架要能改；
 * - 改完点「新建项目」立刻生效，不用等版本；
 * - 内置种子只是兜底，用户改过那份文件之后不再覆盖。
 *
 * 落盘位置：
 * - 骨架：`<空间>/.lantern/config/uiauto/skeleton/<id>.json`（跟着空间走，可入库）
 * - 指纹账本：`<空间>/.lantern/local/uiauto-skeletons.json`（本机，判断「有没有人改过」）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { spaceConfigFile, spaceLocalFile } from '../../builtin/session/space-layout.mjs';
import {
  builtinSkeletonText,
  hasBuiltinSkeleton,
  PLAYWRIGHT_TS_SKELETON_ID,
} from './templates/playwright-ts.mjs';

/** 骨架格式版本：将来结构再变时用它做迁移判断 */
export const SKELETON_SCHEMA = 1;

const SKELETON_DIR = 'skeleton';
const LEDGER_FILE = 'uiauto-skeletons.json';

/** 单个文件 / 整份骨架的体积上限：骨架是代码模板，超过这个量级一定是配错了 */
const MAX_FILE_CHARS = 512 * 1024;
const MAX_TOTAL_CHARS = 8 * 1024 * 1024;
const MAX_FILES = 400;

/**
 * 结果落点：骨架没写 layout 时按这套默认值
 * （与 Harness 出码器的默认布局一致）
 */
export const DEFAULT_LAYOUT = Object.freeze({
  testDir: 'tests',
  pagesDir: 'pages',
  fixturesDir: 'fixtures',
  utilsDir: 'utils',
  dataDir: 'data',
});

/** 骨架 id 用小写短横线；选项 id 沿用 camelCase（authState / webServer） */
const SKELETON_ID_TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPTION_ID_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const digest = (text) =>
  crypto
    .createHash('sha256')
    .update(String(text ?? ''), 'utf8')
    .digest('hex')
    .slice(0, 32);

/* ---------------------------- 位置 ---------------------------- */

export function skeletonsDir(spaceDir) {
  return spaceConfigFile(spaceDir, 'uiauto', SKELETON_DIR);
}

export function skeletonFile(spaceDir, id = PLAYWRIGHT_TS_SKELETON_ID) {
  return path.join(skeletonsDir(spaceDir), `${id}.json`);
}

function ledgerFile(spaceDir) {
  return spaceLocalFile(spaceDir, LEDGER_FILE);
}

export function readLedger(spaceDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(spaceDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLedger(spaceDir, ledger) {
  try {
    const file = ledgerFile(spaceDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  } catch {
    // 账本写不进去只影响「自动升级」，不影响生成
  }
}

/** 技术栈 → 默认骨架 id（不同语言将来可以各有一份） */
export function defaultSkeletonId(stackId) {
  const value = String(stackId ?? '').trim();
  if (value === 'playwright') return PLAYWRIGHT_TS_SKELETON_ID;
  if (hasBuiltinSkeleton(value)) return value;
  return '';
}

/* --------------------------- 解析 --------------------------- */

function asText(value, field, max = 300) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
  if (!text) throw new Error(`骨架缺少 ${field}`);
  return text.slice(0, max);
}

function optionalText(value, max = 300) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, max);
}

/** 统一成 `/` 分隔的相对路径；越界 / 绝对路径一律拒绝 */
export function assertSafeSkeletonPath(file) {
  const rel = String(file ?? '')
    .trim()
    .replace(/\\/g, '/');
  if (!rel) throw new Error('骨架里有空文件路径');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`骨架文件路径必须是相对路径：${rel}`);
  }
  if (rel.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`骨架文件路径不合法：${rel}`);
  }
  return rel;
}

function normalizeLayout(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const layout = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LAYOUT)) {
    const value = optionalText(source[key], 200)
      .replace(/^\.?\//, '')
      .replace(/\/+$/, '');
    layout[key] = value || fallback;
  }
  return layout;
}

function normalizeOption(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`骨架的 options[${index}] 不是对象`);
  }
  const id = optionalText(raw.id, 64);
  if (!OPTION_ID_TOKEN.test(id)) {
    throw new Error(`骨架选项 id 不合法：${id || '(空)'}（只能用小写字母、数字、连字符）`);
  }
  return {
    id,
    label: optionalText(raw.label, 60) || id,
    hint: optionalText(raw.hint, 120),
  };
}

/** 文件级开关：允许 `lint` / `!lint`，必须引用已声明的选项 */
function normalizeWhen(raw, ids) {
  const value = optionalText(raw, 80);
  if (!value) return '';
  const negated = value.startsWith('!');
  const id = (negated ? value.slice(1) : value).trim();
  if (!ids.has(id)) throw new Error(`骨架文件的 when 引用了未声明的选项：${value}`);
  return negated ? `!${id}` : id;
}

/** 条件块里引用的选项也必须是声明过的：写错一个字母不该等到生成时才炸 */
function checkConditionTokens(content, ids, filePath) {
  const tokens = String(content).match(/\{\{\s*[#/](?:if|unless)\s*([\w-]*)\s*\}\}/g) ?? [];
  for (const token of tokens) {
    const name = /\{\{\s*[#/](?:if|unless)\s*([\w-]*)\s*\}\}/.exec(token)?.[1] ?? '';
    if (!name) continue;
    if (!ids.has(name)) {
      throw new Error(`骨架文件 ${filePath} 的条件块引用了未声明的选项：${name}`);
    }
  }
  const opens = (String(content).match(/\{\{\s*[#](?:if|unless)\b/g) ?? []).length;
  const closes = (String(content).match(/\{\{\s*\/(?:if|unless)\s*\}\}/g) ?? []).length;
  if (opens !== closes) {
    throw new Error(`骨架文件 ${filePath} 的条件块没有配对（${opens} 开 / ${closes} 合）`);
  }
}

/**
 * 严格解析骨架：结构不对直接抛错，不产出半套文件。
 * @param {unknown} raw JSON 对象或 JSON 文本
 * @param {{ fallbackId?: string }} [options]
 */
export function parseSkeleton(raw, options = {}) {
  let source = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw);
    } catch (error) {
      throw new Error(`骨架不是合法 JSON：${error instanceof Error ? error.message : error}`);
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('骨架必须是一个 JSON 对象');
  }

  const id = optionalText(source.id, 64) || optionalText(options.fallbackId, 64);
  if (!SKELETON_ID_TOKEN.test(id)) throw new Error(`骨架 id 不合法：${id || '(空)'}`);

  const status = source.status === 'planned' ? 'planned' : 'ready';
  const declared = Array.isArray(source.options) ? source.options : [];
  const seenIds = new Set();
  const optionList = declared.map((item, index) => {
    const option = normalizeOption(item, index);
    if (seenIds.has(option.id)) throw new Error(`骨架选项重复：${option.id}`);
    seenIds.add(option.id);
    return option;
  });

  const defaultRaw = Array.isArray(source.defaultOptions) ? source.defaultOptions : [];
  const defaultOptions = optionList
    .map((option) => option.id)
    .filter((optionId) => defaultRaw.includes(optionId));

  const filesRaw = Array.isArray(source.files) ? source.files : [];
  if (!filesRaw.length) throw new Error('骨架没有任何文件');
  if (filesRaw.length > MAX_FILES) throw new Error(`骨架文件数超过 ${MAX_FILES}`);

  let total = 0;
  const files = filesRaw.map((file, index) => {
    if (!file || typeof file !== 'object') throw new Error(`骨架的 files[${index}] 不是对象`);
    const filePath = assertSafeSkeletonPath(file.path);
    if (file.content == null) throw new Error(`骨架文件缺少 content：${filePath}`);
    const content = String(file.content);
    if (content.length > MAX_FILE_CHARS) {
      throw new Error(`骨架文件过大（${content.length} 字符）：${filePath}`);
    }
    total += content.length;
    if (total > MAX_TOTAL_CHARS) throw new Error('骨架总体积过大，检查是不是把产物打进去了');
    checkConditionTokens(content, seenIds, filePath);
    return { path: filePath, content, when: normalizeWhen(file.when, seenIds) };
  });

  return {
    schema: Number.isFinite(Number(source.schema)) ? Number(source.schema) : SKELETON_SCHEMA,
    id,
    stack: asText(source.stack, 'stack', 40),
    label: optionalText(source.label, 80) || id,
    kind: optionalText(source.kind, 20) || 'ui',
    language: optionalText(source.language, 20) || 'ts',
    status,
    hint: optionalText(source.hint, 200),
    promptFile: optionalText(source.promptFile, 200),
    layout: normalizeLayout(source.layout),
    options: optionList,
    defaultOptions,
    files,
  };
}

/* --------------------------- 渲染 --------------------------- */

const PLACEHOLDER = /\{\{\s*(projectName|packageName|baseURL|stack)\s*\}\}/g;
const CONDITION = /^(#if|#unless|\/if|\/unless)\s*([\w-]*)$/;

/**
 * 条件块渲染：支持嵌套，未选中的整块删掉。
 * 先把 GitHub Actions 的 `${{ ... }}` 摘出去，避免被当成模板。
 */
function resolveConditions(text, picked, declaredIds, filePath) {
  const stash = [];
  const stashed = String(text).replace(/\$\{\{[\s\S]*?\}\}/g, (match) => {
    stash.push(match);
    return `\u0000${stash.length - 1}\u0000`;
  });

  let cursor = 0;
  const walk = (nested) => {
    let out = '';
    while (cursor < stashed.length) {
      const open = stashed.indexOf('{{', cursor);
      if (open < 0) {
        out += stashed.slice(cursor);
        cursor = stashed.length;
        break;
      }
      out += stashed.slice(cursor, open);
      const close = stashed.indexOf('}}', open);
      if (close < 0) {
        out += stashed.slice(open);
        cursor = stashed.length;
        break;
      }
      const token = stashed.slice(open + 2, close).trim();
      cursor = close + 2;

      const matched = CONDITION.exec(token);
      if (!matched) {
        out += `{{${token}}}`;
        continue;
      }
      const [, kind, name] = matched;
      if (kind === '/if' || kind === '/unless') {
        if (!nested) throw new Error(`骨架文件 ${filePath} 有多余的闭合标记 {{${token}}}`);
        return { text: out, closed: true };
      }
      if (!declaredIds.has(name)) {
        throw new Error(`骨架文件 ${filePath} 的条件块引用了未声明的选项：${name}`);
      }
      const body = walk(true);
      if (!body.closed) throw new Error(`骨架文件 ${filePath} 的条件块 {{${token}}} 没有闭合`);
      const hit = kind === '#if' ? picked.has(name) : !picked.has(name);
      if (hit) out += body.text;
    }
    if (nested) return { text: out, closed: false };
    return { text: out, closed: true };
  };

  const result = walk(false);
  if (!result.closed) throw new Error(`骨架文件 ${filePath} 的条件块没有闭合`);
  return result.text.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)]);
}

function fillPlaceholders(text, ctx) {
  return text.replace(PLACEHOLDER, (_, key) => String(ctx[key] ?? ''));
}

/**
 * 项目名 → npm 包名：`web e2e` → `web-e2e`。
 * npm 只收小写字母 / 数字 / 点 / 下划线 / 连字符，中文之类的直接去掉。
 */
export function toPackageName(projectName) {
  const slug = String(projectName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
  return slug && /^[a-z0-9]/.test(slug) ? slug : 'e2e-project';
}

/** 文件级开关：`lint` 选中才要，`!lint` 没选才要 */
export function whenMatches(when, picked) {
  const value = String(when ?? '').trim();
  if (!value) return true;
  const negated = value.startsWith('!');
  const id = negated ? value.slice(1).trim() : value;
  return negated ? !picked.has(id) : picked.has(id);
}

/** 只保留骨架声明过的选项，顺序跟着骨架（向导里怎么排就怎么出） */
export function pickOptions(skeleton, raw) {
  const desired = new Set(Array.isArray(raw) ? raw.map((item) => String(item)) : []);
  return skeleton.options.map((option) => option.id).filter((id) => desired.has(id));
}

/**
 * 按骨架渲染出待写入的文件清单（纯计算，不碰磁盘）。
 * @param {ReturnType<typeof parseSkeleton>} skeleton 已解析的骨架
 * @param {{ projectName: string, baseURL?: string, options?: string[] }} ctx
 */
export function renderFromSkeleton(skeleton, ctx = {}) {
  const projectName = String(ctx.projectName ?? '').trim();
  if (!projectName) throw new Error('请填写项目名');
  const pickedList = pickOptions(skeleton, ctx.options);
  const picked = new Set(pickedList);
  const declaredIds = new Set(skeleton.options.map((option) => option.id));
  const values = {
    projectName,
    packageName: toPackageName(projectName),
    baseURL: String(ctx.baseURL ?? ''),
    stack: skeleton.stack,
  };

  const seen = new Set();
  const files = [];
  let total = 0;
  for (const file of skeleton.files) {
    if (!whenMatches(file.when, picked)) continue;
    if (seen.has(file.path)) throw new Error(`骨架里有重复文件：${file.path}`);
    seen.add(file.path);
    const content = fillPlaceholders(
      resolveConditions(file.content, picked, declaredIds, file.path),
      values,
    );
    total += content.length;
    if (total > MAX_TOTAL_CHARS) throw new Error('渲染结果过大，检查骨架内容');
    files.push({ path: file.path, content });
  }
  if (!files.length) throw new Error('按当前选项没有生成任何文件');
  return { stack: skeleton.stack, options: pickedList, files };
}

/** 把骨架的选项 / 提示词挂到技术栈视图上（向导里显示的就是骨架里那份） */
export function applySkeletonToStack(stack, skeleton, source = 'builtin') {
  if (!skeleton) return { ...stack, skeleton: '', skeletonSource: '' };
  return {
    ...stack,
    hint: skeleton.hint || stack.hint,
    options: skeleton.options.map((option) => ({ ...option })),
    defaultOptions: [...skeleton.defaultOptions],
    promptFile: skeleton.promptFile || stack.promptFile || '',
    skeleton: skeleton.id,
    skeletonSource: source,
  };
}

/* ------------------------- 种子 / 读取 ------------------------- */

/**
 * 缺文件就补种子；已存在时：
 * - 内容仍与上次种子一致（没人改过）→ 跟内置版本对齐，自动升级；
 * - 内容被人改过 → 一个字都不动，用户改的优先；
 * - 老版本留下的文件（没有账本）→ 只登记指纹，不覆盖。
 *
 * @returns {{ file: string, created: boolean, updated: boolean, exists: boolean }}
 */
export function ensureSkeletonSeed(spaceDir, id = PLAYWRIGHT_TS_SKELETON_ID) {
  if (!hasBuiltinSkeleton(id)) throw new Error(`没有内置骨架：${id}`);
  const rendered = builtinSkeletonText(id);
  const renderedHash = digest(rendered);
  const dest = skeletonFile(spaceDir, id);
  const ledger = readLedger(spaceDir);

  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, rendered, 'utf8');
      writeLedger(spaceDir, { ...ledger, [id]: renderedHash });
      return { file: dest, created: true, updated: false, exists: true };
    } catch {
      return { file: dest, created: false, updated: false, exists: false };
    }
  }

  let current = '';
  try {
    current = fs.readFileSync(dest, 'utf8');
  } catch {
    return { file: dest, created: false, updated: false, exists: true };
  }
  const currentHash = digest(current);

  // 没有账本：老种子或用户自己写的，先只登记，不冒险覆盖
  if (!ledger[id]) {
    writeLedger(spaceDir, { ...ledger, [id]: currentHash });
    return { file: dest, created: false, updated: false, exists: true };
  }
  // 有人改过 → 保持原样
  if (ledger[id] !== currentHash) {
    return { file: dest, created: false, updated: false, exists: true };
  }
  // 没人改过但内置骨架变了 → 自动升级
  if (currentHash !== renderedHash) {
    try {
      fs.writeFileSync(dest, rendered, 'utf8');
      writeLedger(spaceDir, { ...ledger, [id]: renderedHash });
      return { file: dest, created: false, updated: true, exists: true };
    } catch {
      return { file: dest, created: false, updated: false, exists: true };
    }
  }
  return { file: dest, created: false, updated: false, exists: true };
}

/**
 * 读空间里的骨架；没有就补种子再用。
 * 空间里那份写坏了也不能挡住「新建项目」：回退内置骨架并把错误带出去。
 */
export function loadSkeleton(spaceDir, id = PLAYWRIGHT_TS_SKELETON_ID) {
  const wanted = optionalText(id, 64) || PLAYWRIGHT_TS_SKELETON_ID;
  try {
    ensureSkeletonSeed(spaceDir, wanted);
  } catch {
    // 种子写不进去（只读空间等）时用内置的
  }

  const file = skeletonFile(spaceDir, wanted);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }

  if (text.trim()) {
    try {
      return { skeleton: parseSkeleton(text, { fallbackId: wanted }), source: 'space', error: '' };
    } catch (error) {
      const builtin = hasBuiltinSkeleton(wanted)
        ? parseSkeleton(builtinSkeletonText(wanted), { fallbackId: wanted })
        : null;
      if (builtin) {
        return {
          skeleton: builtin,
          source: 'builtin',
          error: `空间里的骨架写错了，已回退内置版本：${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      throw error;
    }
  }

  if (!hasBuiltinSkeleton(wanted)) throw new Error(`没有内置骨架：${wanted}`);
  return {
    skeleton: parseSkeleton(builtinSkeletonText(wanted), { fallbackId: wanted }),
    source: 'builtin',
    error: '',
  };
}
