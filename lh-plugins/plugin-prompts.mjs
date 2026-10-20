/**
 * 插件自带的提示词文件：落在当前空间的「提示词管理」里，插件运行时引用。
 *
 * 规则（全局）：
 * - 打开插件时补一份种子提示词（已存在就不覆盖，用户改过的内容优先）；
 * - 插件开启期间，这份提示词在「提示词管理」里不允许删除 / 改名；
 * - 关闭插件只停用，文件保留；下次打开仍引用同一份，不会重新盖一份；
 * - 文件被删掉后再打开插件，会重新生成种子。
 *
 * 文件名与所属插件的对应关系在前端 `src/lib/prompts-meta.ts` 里也有一份，两处要一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot, spaceLocalFile } from '../builtin/session/space-layout.mjs';

/** 与 DOC_ROOT_DIRS.prompts.dirName 一致；这里写死避免与 lh-project-docs.mjs 形成循环依赖 */
const PROMPTS_DIR_NAME = '提示词管理';

/** 种子账本：记下「上次由插件写入的内容指纹」，用来判断这份文件有没有被人改过 */
const SEED_STATE_FILE = 'plugin-prompts.json';

const digest = (text) =>
  crypto
    .createHash('sha256')
    .update(String(text ?? ''), 'utf8')
    .digest('hex')
    .slice(0, 32);

function seedStatePath(spaceDir) {
  return spaceLocalFile(spaceDir, SEED_STATE_FILE);
}

function readSeedState(spaceDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(seedStatePath(spaceDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSeedState(spaceDir, state) {
  try {
    const file = seedStatePath(spaceDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // 账本写不进去只影响「自动升级」，不影响正常使用
  }
}

/** 提示词文件名 → 所属插件 id */
export const PLUGIN_PROMPT_FILES = Object.freeze({
  '工作汇报提示词.md': 'reports',
  'Playwright提示词.md': 'uiAuto',
});

export const UI_AUTO_PROMPT_FILE = 'Playwright提示词.md';

/** 当前空间的提示词目录（可能被归进分组文件夹） */
export function promptsDir(spaceDir = getDataRoot()) {
  return resolveContentRoot(spaceDir, PROMPTS_DIR_NAME).abs;
}

/** 空间里某份插件提示词的绝对路径 */
export function pluginPromptPath(name, spaceDir = getDataRoot()) {
  return path.join(promptsDir(spaceDir), name);
}

/** 读插件提示词正文；不存在返回空串 */
export function readPluginPrompt(name, spaceDir = getDataRoot()) {
  try {
    return fs.readFileSync(pluginPromptPath(name, spaceDir), 'utf8');
  } catch {
    return '';
  }
}

/**
 * 缺就补种子；已存在时：
 * - 内容仍与上次插件写入的一致（没人改过）→ 跟内置模板对齐，自动升级到新版本；
 * - 内容被人改过 → 一个字都不动，改动优先；
 * - 老版本留下的种子（没有账本）→ 只登记指纹，不覆盖。
 *
 * @returns {{ created: boolean, updated: boolean, exists: boolean, file: string }}
 */
export function ensurePluginPrompt(name, template, spaceDir = getDataRoot()) {
  const dest = pluginPromptPath(name, spaceDir);
  const state = readSeedState(spaceDir);
  const rendered = String(template ?? '');
  const renderedHash = digest(rendered);

  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, rendered, 'utf8');
      writeSeedState(spaceDir, { ...state, [name]: renderedHash });
      return { created: true, updated: false, exists: true, file: name };
    } catch {
      return { created: false, updated: false, exists: false, file: name };
    }
  }

  let current = '';
  try {
    current = fs.readFileSync(dest, 'utf8');
  } catch {
    return { created: false, updated: false, exists: true, file: name };
  }
  const currentHash = digest(current);

  // 没有账本：老种子或用户自己写的，先只登记，不冒险覆盖
  if (!state[name]) {
    writeSeedState(spaceDir, { ...state, [name]: currentHash });
    return { created: false, updated: false, exists: true, file: name };
  }

  // 有人改过（当前内容已不是插件上次写的）→ 保持原样
  if (state[name] !== currentHash) {
    return { created: false, updated: false, exists: true, file: name };
  }

  // 没人改过但内置模板变了 → 自动升级
  if (currentHash !== renderedHash) {
    try {
      fs.writeFileSync(dest, rendered, 'utf8');
      writeSeedState(spaceDir, { ...state, [name]: renderedHash });
      return { created: false, updated: true, exists: true, file: name };
    } catch {
      return { created: false, updated: false, exists: true, file: name };
    }
  }

  return { created: false, updated: false, exists: true, file: name };
}

/**
 * 显式把这份提示词恢复成插件内置版本（用户在界面上确认过才调用）。
 * @returns {{ ok: boolean, file: string }}
 */
export function resetPluginPrompt(name, template, spaceDir = getDataRoot()) {
  const dest = pluginPromptPath(name, spaceDir);
  const rendered = String(template ?? '');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rendered, 'utf8');
    writeSeedState(spaceDir, { ...readSeedState(spaceDir), [name]: digest(rendered) });
    return { ok: true, file: name };
  } catch {
    return { ok: false, file: name };
  }
}

/** 这份提示词是否已经和插件内置版本不一致（给人看「可同步」提示用） */
export function pluginPromptDiffers(name, template, spaceDir = getDataRoot()) {
  const dest = pluginPromptPath(name, spaceDir);
  let current = '';
  try {
    current = fs.readFileSync(dest, 'utf8');
  } catch {
    return false;
  }
  return digest(current) !== digest(template);
}

function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 空间里某个插件的开关状态：本机配置优先，其次空间内默认配置。
 * 与 lh-project-docs.mjs 的 isContentRootEnabled 同一口径。
 */
export function isPluginOnInSpace(pluginId, spaceDir = getDataRoot()) {
  if (!pluginId) return false;
  const defaults = readJsonOr(spaceLocalFile(spaceDir, 'app.defaults.json'), {})?.plugins ?? {};
  const local = readJsonOr(spaceLocalFile(spaceDir, 'app.config.json'), {})?.plugins ?? {};
  return (local[pluginId] ?? defaults[pluginId]) === true;
}

/**
 * 这份提示词当前是否被某个「开启中」的插件锁定（不可删除 / 改名）。
 * @returns {string} 锁定原因；未锁定时为空串
 */
export function pluginPromptLock(name, spaceDir = getDataRoot()) {
  const base = String(name ?? '')
    .split('/')
    .pop();
  const owner = PLUGIN_PROMPT_FILES[base];
  if (!owner) return '';
  if (!isPluginOnInSpace(owner, spaceDir)) return '';
  return '插件开启中，这份提示词由插件引用；先在「我的插件」里关闭对应插件再删除';
}
