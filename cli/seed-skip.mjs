/**
 * 用户删过的随包种子：记在空间 `.lantern/local/seed-skip.json`，
 * 下次 seedSpaceDir 不再自动补回（否则删了重启又冒出来）。
 *
 * 键格式：`<内容目录名>/<相对路径>`，posix，例如
 * `测试模板库/功能测试用例/功能测试用例模板.xlsx`
 */
import fs from 'node:fs';
import path from 'node:path';

import { spaceLocalFile } from '../builtin/session/space-layout.mjs';

const SEED_SKIP_FILE = 'seed-skip.json';

function skipFile(spaceDir) {
  return spaceLocalFile(spaceDir, SEED_SKIP_FILE);
}

function normalizeKey(key) {
  return String(key || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

/** @param {string} spaceDir */
export function listSkippedSeeds(spaceDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(skipFile(spaceDir), 'utf8'));
    const list = Array.isArray(raw?.paths) ? raw.paths : Array.isArray(raw) ? raw : [];
    return list.map(normalizeKey).filter(Boolean);
  } catch {
    return [];
  }
}

/** @param {string} spaceDir @param {string} key */
export function isSkippedSeed(spaceDir, key) {
  const k = normalizeKey(key);
  if (!k) return false;
  return listSkippedSeeds(spaceDir).includes(k);
}

/** @param {string} spaceDir @param {string} key */
export function rememberSkippedSeed(spaceDir, key) {
  const k = normalizeKey(key);
  if (!k) return;
  const prev = listSkippedSeeds(spaceDir);
  if (prev.includes(k)) return;
  const fp = skipFile(spaceDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify({ paths: [...prev, k] }, null, 2)}\n`, 'utf8');
}

/** 用户又上传了同名文件：允许以后缺了再被种子补回 */
/** @param {string} spaceDir @param {string} key */
export function forgetSkippedSeed(spaceDir, key) {
  const k = normalizeKey(key);
  if (!k) return;
  const next = listSkippedSeeds(spaceDir).filter((p) => p !== k);
  const fp = skipFile(spaceDir);
  if (!next.length) {
    try {
      fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
    return;
  }
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify({ paths: next }, null, 2)}\n`, 'utf8');
}
