/**
 * 数据空间运行时上下文：全进程唯一的「当前数据根」真相源。
 *
 * 单空间时代各插件在 configureServer 里把 root 抓进闭包，导致切换空间只能重启进程；
 * 这里改为惰性读取（每个请求调用 getDataRoot()），切换只需 setActiveRoot()。
 *
 * - baseRoot（池根）：产品 = config.dataRoot；开发 = config.devDataRoot（可回退 dataRoot / 仓库根）
 * - activeRoot：当前生效的空间目录；未切换时 = 公共空间路径
 *
 * 路径口径全部来自 `space-layout.mjs`，本模块只管「当前是哪个」。
 */
import path from 'node:path';

import { publicSpacePath } from './space-layout.mjs';

// 路径常量统一由 space-layout 定义；这里透传，保持既有引用方（含测试）不受影响。
export { PUBLIC_SPACE_DIR, SPACE_POOL_DIR, poolPath, publicSpacePath } from './space-layout.mjs';

/** @type {string} */
let baseRoot = '';
/** @type {string} */
let activeRoot = '';

/**
 * 由插件 configureServer 调用。首次调用确定基准根；重复调用不会覆盖已切换的空间。
 * @param {string} root
 * @returns {string} 当前生效的数据根
 */
export function ensureSpaceContext(root) {
  const abs = path.resolve(root || process.cwd());
  if (!baseRoot) baseRoot = abs;
  if (!activeRoot) activeRoot = publicSpacePath(baseRoot);
  return activeRoot;
}

/** 池根（由 ensureSpaceContext 在启动时写入） */
export function getBaseRoot() {
  return baseRoot || process.cwd();
}

/** 公共空间的数据目录（当前池根下），即 `<池根>/公共空间` */
export function getPublicSpaceRoot() {
  return publicSpacePath(getBaseRoot());
}

/** 当前生效的数据根：所有插件绑定目录的唯一入口 */
export function getDataRoot() {
  return activeRoot || getPublicSpaceRoot();
}

/**
 * 切换到指定数据根。
 * @param {string} root
 */
export function setActiveRoot(root) {
  activeRoot = path.resolve(root);
  return activeRoot;
}

/** 恢复为基准根（公共空间） */
export function resetActiveRoot() {
  activeRoot = publicSpacePath(baseRoot);
  return activeRoot;
}

/** 测试用：清空上下文 */
export function __resetSpaceContext() {
  baseRoot = '';
  activeRoot = '';
}
