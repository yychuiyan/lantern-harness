/**
 * 报告快照：把项目里的 HTML 报告复制到空间目录，保证历史记录不被下次运行覆盖。
 *
 * 约束：只在项目目录内读、只往空间目录写；限制文件数与总字节数；跳过视频 / 压缩包。
 */
import fs from 'node:fs';
import path from 'node:path';

import { IGNORED_NAMES, SNAPSHOT_SKIP_EXT, isDir } from './uiauto-adapters/shared.mjs';

export const SNAPSHOT_MAX_FILES = 2000;
export const SNAPSHOT_MAX_BYTES = 100 * 1024 * 1024;
const SNAPSHOT_MAX_DEPTH = 8;

function copyTree(srcDir, destDir, state, depth) {
  if (depth > SNAPSHOT_MAX_DEPTH || state.done) return;
  let items;
  try {
    items = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (state.done) return;
    if (IGNORED_NAMES.has(item.name)) continue;
    const src = path.join(srcDir, item.name);
    const dest = path.join(destDir, item.name);
    if (item.isDirectory()) {
      try {
        fs.mkdirSync(dest, { recursive: true });
      } catch {
        continue;
      }
      copyTree(src, dest, state, depth + 1);
      continue;
    }
    if (!item.isFile()) continue;
    if (SNAPSHOT_SKIP_EXT.has(path.extname(item.name).toLowerCase())) {
      state.skipped += 1;
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      continue;
    }
    if (state.files >= SNAPSHOT_MAX_FILES || state.bytes + stat.size > SNAPSHOT_MAX_BYTES) {
      state.truncated = true;
      state.done = true;
      return;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      state.files += 1;
      state.bytes += stat.size;
    } catch {
      state.skipped += 1;
    }
  }
}

function newestIndex(dirs, minMtime) {
  let best = null;
  for (const dir of dirs) {
    const index = path.join(dir, 'index.html');
    let stat;
    try {
      stat = fs.statSync(index);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs < minMtime) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { dir, mtimeMs: stat.mtimeMs };
  }
  return best;
}

/**
 * 从候选目录（项目相对路径）里挑最新的报告，快照到 destAbs。
 * `minMtime` 用来排除上一次运行留下的旧报告（本次没生成报告时不该拿旧的冒充）。
 * @param {{ projectDir: string, candidates: string[], destAbs: string, minMtime?: number }} input
 * @returns {{ files: number, bytes: number, skipped: number, truncated: boolean, source: string }}
 */
export function snapshotReport({ projectDir, candidates, destAbs, minMtime = 0 }) {
  const dirs = candidates
    .map((rel) => path.resolve(projectDir, rel))
    .filter((abs) => abs.startsWith(path.resolve(projectDir)) && isDir(abs));
  const best = newestIndex(dirs, minMtime);
  const state = { files: 0, bytes: 0, skipped: 0, truncated: false, done: false };
  if (!best) return { ...state, source: '' };

  // 单个 HTML 文件（如 surefire-report.html / mochawesome.html）
  try {
    fs.mkdirSync(destAbs, { recursive: true });
  } catch {
    return { ...state, source: '' };
  }
  copyTree(best.dir, destAbs, state, 0);
  return { ...state, source: best.dir };
}

/** 报告目录里是否已经有可看的入口页 */
export function hasReportEntry(destAbs) {
  try {
    return fs.statSync(path.join(destAbs, 'index.html')).isFile();
  } catch {
    return false;
  }
}
