/**
 * 空间磁盘布局：所有「空间在磁盘上叫什么」的唯一来源。
 *
 * 两种落盘方式（「空间池」写死在本模块，并随 npm 包源码发布）：
 *
 * 1. `lantern init` 选中的文件夹：只有各空间，没有「空间池」。
 *    ```
 *    <选中的文件夹>/
 *    ├── 公共空间/
 *    └── 项目A/
 *    ```
 *
 * 2. 源码 / npm 安装后的包目录：自带「空间池」，避免和 cli、src 混在一起。
 *    ```
 *    <包根>/
 *    └── 空间池/
 *        └── 公共空间/     ← 仅当以包根当数据目录时（dest）
 *    ```
 */
import fs from 'node:fs';
import path from 'node:path';

/** 空间池目录名：源码仓库里的容器目录；用户数据目录不建这一层 */
export const SPACE_POOL_DIR = '空间池';
/** 内建「公共空间」的文件夹名 */
export const PUBLIC_SPACE_DIR = '公共空间';
/** 空间内元数据目录名（隐藏） */
export const META_DIR = '.lantern';
/** 上一世代的元数据目录名；启动时并进 META_DIR */
export const META_DIR_LEGACY = '.tb';
/** 元数据下的配置目录名（原 `config/`） */
export const META_CONFIG_NAME = 'config';
/** 元数据下的本机状态目录名（原 `.local/`） */
export const META_LOCAL_NAME = 'local';

/**
 * 源码仓库或 npm 安装后的包根：空间进「空间池」。
 * 用户 `lantern init` 选中的普通文件夹没有本包的 package.json，不会建这一层。
 * @param {string} root
 */
export function usesNestedSpacePool(root) {
  const abs = path.resolve(root);
  try {
    const pkgFile = path.join(abs, 'package.json');
    const cliDir = path.join(abs, 'cli');
    const hasCli = ['lantern.mjs', 'tbench.mjs'].some((f) => fs.existsSync(path.join(cliDir, f)));
    if (!fs.existsSync(pkgFile) || !hasCli) {
      return false;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    return ['lantern-harness', 'ai-testbench', '@lantern-harness/lh', '@lantern-ai/lh'].includes(
      pkg?.name,
    );
  } catch {
    return false;
  }
}

/** 公共空间相对源码仓库根的路径（POSIX），供 dest 内容集合使用 */
export const PUBLIC_SPACE_REL = `${SPACE_POOL_DIR}/${PUBLIC_SPACE_DIR}`;
/** 空间内元数据的相对路径前缀（POSIX，供导出过滤与展示用） */
export const META_REL = META_DIR;
/** 空间内本机状态的相对路径（POSIX），如 `.lantern/local` */
export const LOCAL_REL = `${META_DIR}/${META_LOCAL_NAME}`;
/** 空间内配置的相对路径（POSIX），如 `.lantern/config` */
export const CONFIG_REL = `${META_DIR}/${META_CONFIG_NAME}`;
/** 元数据下的文件相对路径，如 `.lantern/local/sessions.json` */
export function metaLocalRel(...segs) {
  return [LOCAL_REL, ...segs].join('/');
}

/**
 * 空间的父目录：源码仓库 = `<根>/空间池`；用户数据目录 = `<根>` 本身。
 * @param {string} root
 */
export function poolPath(root) {
  const abs = path.resolve(root);
  return usesNestedSpacePool(abs) ? path.join(abs, SPACE_POOL_DIR) : abs;
}

/** 公共空间目录 */
export function publicSpacePath(root) {
  return path.join(poolPath(root), PUBLIC_SPACE_DIR);
}

/**
 * 对外展示路径：隐去中间的「空间池」目录。
 * `<根>/空间池/公共空间` → `<根>/公共空间`
 */
export function displaySpacePath(absPath, baseRoot) {
  const root = path.resolve(baseRoot);
  const nestedPool = path.join(root, SPACE_POOL_DIR);
  const full = path.resolve(absPath);
  if (full === nestedPool) return root;
  const prefix = nestedPool + path.sep;
  if (full.startsWith(prefix)) return path.join(root, full.slice(prefix.length));
  return full;
}

/** 空间的元数据目录：`<空间>/.lantern` */
export function spaceMetaDir(spaceDir) {
  return path.join(path.resolve(spaceDir), META_DIR);
}

/** 上一世代元数据目录：`<空间>/.tb` */
export function spaceMetaDirLegacy(spaceDir) {
  return path.join(path.resolve(spaceDir), META_DIR_LEGACY);
}

/** 空间的配置目录：`<空间>/.lantern/config` */
export function spaceConfigDir(spaceDir) {
  return path.join(spaceMetaDir(spaceDir), META_CONFIG_NAME);
}

/** 空间的本机状态目录：`<空间>/.lantern/local` */
export function spaceLocalDir(spaceDir) {
  return path.join(spaceMetaDir(spaceDir), META_LOCAL_NAME);
}

/** 空间清单文件名 */
export const SPACE_MANIFEST_FILE = 'space.json';
/** 空间清单相对空间根的路径：`.lantern/space.json` */
export const SPACE_MANIFEST_REL = `${META_DIR}/${SPACE_MANIFEST_FILE}`;
/** 上一世代清单相对路径：`.tb/space.json` */
export const SPACE_MANIFEST_REL_LEGACY = `${META_DIR_LEGACY}/${SPACE_MANIFEST_FILE}`;

/** 空间清单绝对路径：`<空间>/.lantern/space.json` */
export function spaceManifestFile(spaceDir) {
  return path.join(spaceMetaDir(spaceDir), SPACE_MANIFEST_FILE);
}

/** 升级前根目录清单：`<空间>/space.json` */
export function spaceManifestLegacyFile(spaceDir) {
  return path.join(path.resolve(spaceDir), SPACE_MANIFEST_FILE);
}

/** 空间内的文件绝对路径：配置目录下 */
export function spaceConfigFile(spaceDir, ...segs) {
  return path.join(spaceConfigDir(spaceDir), ...segs);
}

/** 空间内的文件绝对路径：本机状态目录下 */
export function spaceLocalFile(spaceDir, ...segs) {
  return path.join(spaceLocalDir(spaceDir), ...segs);
}

/** 分组清单文件名：放在分组文件夹里，用来把该文件夹识别成分组 */
export const GROUP_MANIFEST_FILE = '.group.json';
/** 分组目录最多嵌套两层（顶层分组 + 一层子分组） */
export const MAX_GROUP_DEPTH = 2;

/** 目录里是否有分组清单 */
export function isGroupDir(absDir) {
  try {
    return fs.statSync(path.join(absDir, GROUP_MANIFEST_FILE)).isFile();
  } catch {
    return false;
  }
}

/**
 * 空间里的分组目录（只认带清单的，深度优先）。
 * @param {string} spaceDir
 * @param {number} [maxDepth]
 * @returns {Array<{ abs: string, rel: string }>} rel 为相对空间根的 POSIX 路径
 */
export function listGroupDirs(spaceDir, maxDepth = MAX_GROUP_DEPTH) {
  const root = path.resolve(spaceDir);
  const out = [];
  const walk = (absDir, relPrefix, depth) => {
    if (depth > maxDepth) return;
    let names;
    try {
      names = fs.readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const abs = path.join(absDir, name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isDirectory() || !isGroupDir(abs)) continue;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      out.push({ abs, rel });
      walk(abs, rel, depth + 1);
    }
  };
  walk(root, '', 1);
  return out;
}

/**
 * 内容根在磁盘上的实际位置：被归进分组文件夹时就在分组里，否则在空间根。
 *
 * 分组即「物理归档」：界面把菜单拖进分组后，对应内容目录会搬进该分组文件夹，
 * 这样整份空间拷到另一台机器上，只靠文件夹结构就能还原出分组。
 * 返回的路径可能还不存在（新空间），调用方按需 mkdir。
 *
 * @param {string} spaceDir
 * @param {string} dirName 内容目录名，如「需求文档库」
 * @returns {{ abs: string, rel: string, grouped: boolean }}
 */
export function resolveContentRoot(spaceDir, dirName) {
  const root = path.resolve(spaceDir);
  const leaf = path.basename(String(dirName ?? '').trim());
  if (!leaf) return { abs: root, rel: '.', grouped: false };
  // 分组内优先：空间根上的同名目录可能只是上次铺骨架留下的空壳
  for (const g of listGroupDirs(root)) {
    const abs = path.join(g.abs, leaf);
    try {
      if (fs.statSync(abs).isDirectory()) return { abs, rel: `${g.rel}/${leaf}`, grouped: true };
    } catch {
      // 不存在就继续找
    }
  }
  const rootAbs = path.join(root, leaf);
  // 顶级分组名与内容根同名时，分组目录本身不能当内容根。
  // 内容必须是分组内的同名子目录，否则「用例管理/.group.json」
  // 会被误当成用例库，真实文件放在下一层时页面就会为空。
  if (isGroupDir(rootAbs)) {
    return { abs: path.join(rootAbs, leaf), rel: `${leaf}/${leaf}`, grouped: true };
  }
  return { abs: rootAbs, rel: leaf, grouped: false };
}
