/**
 * 待办 / 任务的磁盘位置：跟侧栏菜单一一对应，直接放在空间里的普通文件夹，
 * 不再藏进 `.lantern/local`（那里放的是会话、记忆这类本机状态）。
 *
 * ```
 * <空间>/待办事项/待办.json
 * <空间>/任务管理/任务.json
 * ```
 *
 * 目录同样走 `resolveContentRoot`：被拖进导航分组时，数据跟着进分组文件夹。
 * 旧版本存在 `.lantern/local/todos.json`、`tasks.json`，读取时自动搬过来。
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveContentRoot, spaceLocalFile } from '../builtin/session/space-layout.mjs';

export const TODO_DIR_NAME = '待办事项';
export const TASK_DIR_NAME = '任务管理';
export const TODO_STORE_FILE = '待办.json';
export const TASK_STORE_FILE = '任务.json';

/** 旧位置（`.lantern/local` 下）的文件名，仅用于迁移 */
const LEGACY_FILES = {
  todos: 'todos.json',
  tasks: 'tasks.json',
};

/** @typedef {'todos' | 'tasks'} WorkStoreKind */

export function todoStorePath(spaceDir) {
  return path.join(resolveContentRoot(spaceDir, TODO_DIR_NAME).abs, TODO_STORE_FILE);
}

export function taskStorePath(spaceDir) {
  return path.join(resolveContentRoot(spaceDir, TASK_DIR_NAME).abs, TASK_STORE_FILE);
}

/** 只算路径不做任何迁移：health 探测不该顺手建目录 */
export function workStorePath(spaceDir, kind) {
  return kind === 'todos' ? todoStorePath(spaceDir) : taskStorePath(spaceDir);
}

function legacyStorePath(spaceDir, kind) {
  return spaceLocalFile(spaceDir, LEGACY_FILES[kind]);
}

/**
 * 能读到的那份存储：新位置优先，老位置兜底（不迁移、不建目录）。
 * 供跨模块只读引用（例如待办把关联任务拉回「进行中」）。
 */
export function readableStorePath(spaceDir, kind) {
  const next = workStorePath(spaceDir, kind);
  if (fs.existsSync(next)) return next;
  const legacy = legacyStorePath(spaceDir, kind);
  return fs.existsSync(legacy) ? legacy : next;
}

/**
 * 准备写入位置：建好目录，并把 `.lantern/local` 里的旧文件搬出来。
 * 只在真正读写时调用，避免打开页面就铺出空文件夹。
 */
export function prepareStorePath(spaceDir, kind) {
  const next = workStorePath(spaceDir, kind);
  fs.mkdirSync(path.dirname(next), { recursive: true });
  if (fs.existsSync(next)) return next;
  const legacy = legacyStorePath(spaceDir, kind);
  if (!fs.existsSync(legacy)) return next;
  try {
    fs.renameSync(legacy, next);
  } catch {
    try {
      fs.copyFileSync(legacy, next);
      fs.unlinkSync(legacy);
    } catch {
      // 迁移失败就继续用旧文件，不阻断读写
      return legacy;
    }
  }
  return next;
}
