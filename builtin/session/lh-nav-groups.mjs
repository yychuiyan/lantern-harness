/**
 * 侧栏分组 ↔ 空间文件夹。
 *
 * 分组的真身在磁盘：空间根下一个普通文件夹就是一层分组，文件夹里的 `.group.json`
 * 只记录稳定 id 与成员菜单。这样把整个空间目录拷到另一台机器后，服务扫一遍就能
 * 还原侧栏分组，而不依赖 `.lantern/local` 里的本机配置。
 *
 * ```
 * <空间>/
 * ├── 用例管理/ 需求文档库/ …            ← 内容根固定，不参与分组扫描
 * ├── 文档库/
 * │   └── .group.json { "id": "docs", "items": ["requirements", "templates"] }
 * └── 项目A/
 *     ├── .group.json { "id": "grp_x", "items": ["cases"] }
 *     └── 子分组/
 *         └── .group.json { "id": "grp_y", "items": ["prompts"] }
 * ```
 *
 * 只认带 `.group.json` 的目录：空间里其它随意建的文件夹不会被误当成菜单分组。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DOC_ROOT_DIRS } from '../../lh-plugins/lh-project-docs.mjs';
import { REPORT_ROOT_DIR } from '../../lh-plugins/lh-reports.mjs';
import { TASK_DIR_NAME, TODO_DIR_NAME } from '../../lh-plugins/lh-work-store.mjs';
import { CASE_EXEC_DIR_NAME, TEST_STATS_DIR_NAME } from '../../lh-plugins/lh-stats.mjs';
import { PM_DIR_NAMES } from '../../lh-plugins/lh-pm.mjs';
import { REQ_ANALYSIS_DIR_NAME } from '../../lh-plugins/lh-req-analysis.mjs';
import { getUserConfigDir } from '../../cli/user-config.mjs';
import { getDataRoot } from './space-context.mjs';
import { GROUP_MANIFEST_FILE, resolveContentRoot, spaceLocalFile } from './space-layout.mjs';

const PREFIX = '/__tb_nav/groups';

/** 分组清单文件名（藏在分组目录里） */
export { GROUP_MANIFEST_FILE };

/** 自动识别内容根后要打开的插件（没有对应插件的目录暂不处理） */
const ROOT_PLUGIN_IDS = {
  cases: 'cases',
  prompts: 'prompts',
  knowledge: 'knowledgeLib',
  requirements: 'requirements',
  templates: 'templates',
};

/** 识别账本（本机，不跟空间走）：整份空间拷到新机器后会重新识别一次 */
const AUTODETECT_FILE = 'nav-autodetect.json';

/** 内容根 key → 侧栏菜单项 id（知识库的名字和目录 key 不同） */
const ROOT_ITEM_IDS = {
  requirements: 'requirements',
  cases: 'cases',
  templates: 'templates',
  prompts: 'prompts',
  knowledge: 'knowledgeLib',
};

/** 内容目录名（含旧名）→ 菜单项 id：分组文件夹里出现这些目录就还原成组内菜单 */
const DIR_ITEM_IDS = new Map();
for (const [key, def] of Object.entries(DOC_ROOT_DIRS)) {
  const navId = ROOT_ITEM_IDS[key];
  if (!navId) continue;
  for (const name of [def.dirName, ...(def.legacyDirNames ?? [])]) DIR_ITEM_IDS.set(name, navId);
}

/** 菜单项 id → 内容目录名 */
const ITEM_DIR_NAMES = new Map(
  Object.entries(DOC_ROOT_DIRS)
    .filter(([key]) => ROOT_ITEM_IDS[key])
    .map(([key, def]) => [ROOT_ITEM_IDS[key], def.dirName]),
);

/**
 * 不是内容库、但同样在空间里占一个目录的菜单项（待办 / 任务 / 工作汇报的数据）。
 * 分组同样是物理归档，所以这几项也要跟着搬进分组文件夹，否则「加了分组但目录没动」。
 */
const WORK_ITEM_DIR_NAMES = new Map([
  ['todos', TODO_DIR_NAME],
  ['tasks', TASK_DIR_NAME],
  ['reports', REPORT_ROOT_DIR],
  ['testStats', TEST_STATS_DIR_NAME],
  ['caseExec', CASE_EXEC_DIR_NAME],
]);
for (const [itemId, dirName] of WORK_ITEM_DIR_NAMES) {
  ITEM_DIR_NAMES.set(itemId, dirName);
  DIR_ITEM_IDS.set(dirName, itemId);
}

const CONTENT_DIR_NAMES = new Set(
  Object.values(DOC_ROOT_DIRS).flatMap((d) => [d.dirName, ...(d.legacyDirNames ?? [])]),
);

/** 这些目录即使带清单也不当分组（内容根、包目录、空间容器等） */
const SKIP_DIR_NAMES = new Set([
  ...CONTENT_DIR_NAMES,
  // 项目管理四个插件的固定数据目录：与导航分组同名时靠改名避免冲突
  ...PM_DIR_NAMES,
  // 需求分析的空间数据目录，同样是插件的而不是导航分组
  REQ_ANALYSIS_DIR_NAME,
  'node_modules',
  'dist',
  '.astro',
  '空间池',
  '公共空间',
]);

function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readJson(fp, fallback) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 读分组目录里的清单；没有或格式不对都不算分组 */
function readManifest(dir) {
  const fp = path.join(dir, GROUP_MANIFEST_FILE);
  if (!fs.existsSync(fp)) return null;
  const raw = readJson(fp, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const items = Array.isArray(raw.items)
    ? raw.items.filter((x) => typeof x === 'string' && x.trim())
    : [];
  return { id, items };
}

function onlyManifest(dir) {
  try {
    const rest = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== '.DS_Store' && e.name !== '.gitkeep');
    return rest.length === 0 || (rest.length === 1 && rest[0].name === GROUP_MANIFEST_FILE);
  } catch {
    return false;
  }
}

/** 递归检查目录里是否有真实内容（忽略占位与隐藏文件） */
function dirHasContent(dir) {
  if (!isDir(dir)) return false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of entries) {
    if (ent.name === '.DS_Store' || ent.name === '.gitkeep' || ent.name.startsWith('.')) continue;
    if (ent.isDirectory()) {
      if (dirHasContent(path.join(dir, ent.name))) return true;
    } else if (ent.isFile()) {
      return true;
    }
  }
  return false;
}

/**
 * 分组文件夹里直接放着的内容目录（需求文档库 / 用例管理 …）。
 * 分组 = 物理归档，所以即使清单丢了，也能从目录结构还原出组内菜单。
 * @param {string} absDir
 * @returns {string[]} 菜单项 id
 */
function nestedContentItems(absDir) {
  const out = [];
  for (const name of safeReaddir(absDir)) {
    if (name.startsWith('.')) continue;
    const navId = DIR_ITEM_IDS.get(name);
    if (!navId) continue;
    if (isDir(path.join(absDir, name))) out.push(navId);
  }
  return out;
}

/**
 * 扫描空间里的分组目录。
 * @param {string} spaceDir
 * @returns {{ groups: Array<{id:string,name:string,items:string[],parentId?:string}>, found: boolean }}
 *   found 表示磁盘上至少还原出一个分组（用于区分「没有分组」与「还没文件夹化」）
 */
export function scanNavGroups(spaceDir) {
  const root = path.resolve(spaceDir);
  const groups = [];
  const usedIds = new Set();
  const usedItems = new Set();

  const takeItems = (items) => {
    const out = [];
    for (const id of items) {
      if (usedItems.has(id)) continue;
      usedItems.add(id);
      out.push(id);
    }
    return out;
  };

  const takeId = (preferred, fallback) => {
    let id = preferred || fallback;
    if (usedIds.has(id)) id = fallback;
    let n = 2;
    while (usedIds.has(id)) id = `${fallback}#${n++}`;
    usedIds.add(id);
    return id;
  };

  const top = [];
  for (const name of safeReaddir(root)) {
    if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
    const abs = path.join(root, name);
    if (!isDir(abs)) continue;
    const manifest = readManifest(abs);
    if (!manifest) continue;
    const g = {
      id: takeId(manifest.id, `dir:${name}`),
      name,
      items: takeItems([...manifest.items, ...nestedContentItems(abs)]),
    };
    top.push(g);
    groups.push(g);
  }

  for (const parent of top) {
    const parentAbs = path.join(root, parent.name);
    for (const name of safeReaddir(parentAbs)) {
      if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
      const abs = path.join(parentAbs, name);
      if (!isDir(abs)) continue;
      const manifest = readManifest(abs);
      if (!manifest) continue;
      groups.push({
        id: takeId(manifest.id, `dir:${parent.name}/${name}`),
        name,
        items: takeItems([...manifest.items, ...nestedContentItems(abs)]),
        parentId: parent.id,
      });
    }
  }

  const childOf = new Set(groups.map((g) => g.parentId).filter(Boolean));
  const kept = groups.filter((g) => g.items.length > 0 || childOf.has(g.id));
  // 只有真正能还原出分组时才算「磁盘已有分组」；否则按尚未文件夹化处理，避免清空配置
  return { groups: kept, found: kept.length > 0 };
}

/** 空间身份：优先用清单里的 id（目录改名后仍能对上账），没有清单时退回绝对路径 */
function autodetectKey(root) {
  for (const rel of ['.lantern/space.json', 'space.json', '.tb/space.json']) {
    const raw = readJson(path.join(root, rel), null);
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (id) return `id:${id}`;
  }
  return root;
}

function ledgerPathOf() {
  return path.join(getUserConfigDir(), AUTODETECT_FILE);
}

function readLedgerStore() {
  const raw = readJson(ledgerPathOf(), null);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function writeLedgerStore(store) {
  try {
    const fp = ledgerPathOf();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  } catch {
    // 账本写不进去只会导致下次再判断一次，不影响启动
  }
}

/** 手动开关记录：跟空间走，目录改名 / 换机器都不会被自动识别覆盖 */
function manualOffFile(root) {
  return spaceLocalFile(root, 'plugins-manual.json');
}

function readManualOff(root) {
  const raw = readJson(manualOffFile(root), null);
  const list = Array.isArray(raw?.off) ? raw.off.filter((x) => typeof x === 'string') : [];
  return new Set(list);
}

/** 用户在插件页手动关掉 / 打开的开关：记进空间自己的本机状态，自动识别不再覆盖 */
function updateOffList(spaceDir, add = [], remove = []) {
  const root = path.resolve(spaceDir);
  const off = readManualOff(root);
  for (const id of remove) off.delete(id);
  for (const id of add) off.add(id);
  try {
    const fp = manualOffFile(root);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify({ off: [...off] }, null, 2)}\n`, 'utf8');
  } catch {
    // 写不进去只影响下一次自动识别，不影响插件开关本身
  }
}

export function markPluginsDisabled(spaceDir, ids) {
  updateOffList(
    spaceDir,
    (ids ?? []).filter((x) => typeof x === 'string'),
    [],
  );
}

export function markPluginsEnabled(spaceDir, ids) {
  updateOffList(
    spaceDir,
    [],
    (ids ?? []).filter((x) => typeof x === 'string'),
  );
}

/**
 * 自动识别内容根并按需打开对应插件（每个根只处理一次）。
 * 识别依据：目录里已有内容，或已被某个分组引用（整份空间拷过来时靠后者）。
 * 用户手动关掉的开关不会被重新打开。
 * @param {string} spaceDir
 * @param {Record<string, boolean>} plugins 当前空间插件开关
 * @param {Array<{items?: string[]}>} [navGroups] 配置里的分组（磁盘还没文件夹化时也能识别）
 * @returns {{ plugins: Record<string, boolean>, changed: boolean }}
 */
export function autoEnableDetectedPlugins(spaceDir, plugins, navGroups) {
  const root = path.resolve(spaceDir);
  const next = { ...(plugins ?? {}) };
  const referenced = new Set(scanNavGroups(root).groups.flatMap((g) => g.items));
  for (const g of Array.isArray(navGroups) ? navGroups : []) {
    if (!Array.isArray(g?.items)) continue;
    for (const id of g.items) if (typeof id === 'string') referenced.add(id);
  }
  const store = readLedgerStore();
  const key = autodetectKey(root);
  const entry = store[key] ?? store[root];
  const seen = new Set(
    Array.isArray(entry?.roots) ? entry.roots.filter((x) => typeof x === 'string') : [],
  );
  const off = readManualOff(root);

  let changed = false;
  let ledgerChanged = false;
  for (const rootId of Object.keys(DOC_ROOT_DIRS)) {
    if (seen.has(rootId)) continue;
    const detected =
      referenced.has(rootId) || dirHasContent(path.join(root, DOC_ROOT_DIRS[rootId].dirName));
    if (!detected) continue;
    seen.add(rootId);
    ledgerChanged = true;
    const pluginId = ROOT_PLUGIN_IDS[rootId];
    if (pluginId && !off.has(pluginId) && next[pluginId] !== true) {
      next[pluginId] = true;
      changed = true;
    }
  }

  if (ledgerChanged) {
    store[key] = { ...entry, roots: [...seen] };
    if (key !== root) delete store[root];
    writeLedgerStore(store);
  }
  return { plugins: next, changed };
}

/**
 * 新建空间铺完骨架后调用：把「种子里已经落位的根」记为已识别。
 *
 * 种子只是初始文件（默认提示词、模板），不该被当成「用户搬进来的内容」，
 * 否则新建空间会因为播种而自动打开提示词 / 模板插件。之后用户再往空间里放内容，
 * 仍会按首次识别自动打开对应插件。
 * @param {string} spaceDir
 * @param {string[]} [rootIds] 要登记的根 key（缺省 = 当前已有内容的根）
 * @returns {string[]} 本次登记的根 key
 */
export function markNavRootsDetected(spaceDir, rootIds) {
  const root = path.resolve(spaceDir);
  const ids = (
    Array.isArray(rootIds) && rootIds.length
      ? rootIds
      : Object.keys(DOC_ROOT_DIRS).filter((id) =>
          dirHasContent(resolveContentRoot(root, DOC_ROOT_DIRS[id].dirName).abs),
        )
  ).filter((id) => Object.hasOwn(DOC_ROOT_DIRS, id));
  if (!ids.length) return [];

  const store = readLedgerStore();
  const key = autodetectKey(root);
  const entry = store[key] ?? store[root];
  const seen = new Set(
    Array.isArray(entry?.roots) ? entry.roots.filter((x) => typeof x === 'string') : [],
  );
  for (const id of ids) seen.add(id);
  store[key] = { ...entry, roots: [...seen] };
  if (key !== root) delete store[root];
  writeLedgerStore(store);
  return ids;
}

/** 文件夹名清洗：去掉路径分隔符与首尾点，避开内容根 / 保留目录名 */
function safeName(raw) {
  let name = String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .trim();
  if (!name) return '';
  if (SKIP_DIR_NAMES.has(name) || name === GROUP_MANIFEST_FILE) {
    name = `${name} (分组)`;
  }
  return name;
}

/** 在父目录里占一个不冲突的文件夹名；重名时依次加 (2)、(3) */
function claimName(parentAbs, desired) {
  let name = desired;
  let n = 2;
  while (fs.existsSync(path.join(parentAbs, name))) {
    name = `${desired} (${n++})`;
  }
  return name;
}

function moveDir(fromAbs, toAbs) {
  if (path.resolve(fromAbs) === path.resolve(toAbs)) return;
  if (!fs.existsSync(fromAbs)) return;
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  try {
    fs.renameSync(fromAbs, toAbs);
  } catch {
    // 跨卷等场景：逐条目搬运（极少数，空间目录内部一般不会发生）
    fs.mkdirSync(toAbs, { recursive: true });
    for (const name of fs.readdirSync(fromAbs)) {
      const from = path.join(fromAbs, name);
      const to = path.join(toAbs, name);
      if (fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
      } catch {
        // 搬不动就保留原地，避免丢数据
      }
    }
  }
}

/**
 * 把内容目录搬到目标位置（分组文件夹里，或搬回空间根）。
 *
 * 目标已有同名条目时逐条目合并、绝不覆盖；搬空的源目录直接删掉。
 * 用逐条目搬运而不是整目录 rename：分组文件夹里可能已经有用户放进去的同类内容。
 *
 * @param {string} spaceDir
 * @param {string} dirName 内容目录名
 * @param {string} targetAbs 目标绝对路径（<分组>/<dirName> 或 <空间根>/<dirName>）
 * @param {string[]} [extraSources] 额外来源（例如没有清单的残留文件夹里的同名目录）
 * @returns {{ moved: boolean, conflicted: string[] }} conflicted 为冲突条目（未覆盖）
 */
function relocateContentDir(spaceDir, dirName, targetAbs, extraSources = []) {
  const root = path.resolve(spaceDir);
  const target = path.resolve(targetAbs);
  const conflicted = [];
  // 来源可能有两处：分组内（上次布局）与空间根（骨架铺出来的空壳）；再加调用方指定的残留位置
  const sources = new Set([
    resolveContentRoot(root, dirName).abs,
    path.join(root, dirName),
    ...extraSources,
  ]);
  let moved = false;

  for (const raw of sources) {
    const src = path.resolve(raw);
    if (src === target || !fs.existsSync(src)) continue;
    let st;
    try {
      st = fs.statSync(src);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const from = path.join(src, name);
      const to = path.join(target, name);
      if (fs.existsSync(to)) {
        if (name !== '.gitkeep' && name !== '.DS_Store') conflicted.push(`${dirName}/${name}`);
        continue;
      }
      try {
        fs.renameSync(from, to);
        moved = true;
      } catch {
        conflicted.push(`${dirName}/${name}`);
      }
    }
    // 搬空后删掉源目录，避免空间根与分组里各留一个空壳
    try {
      const rest = fs.readdirSync(src).filter((n) => n !== '.DS_Store' && n !== '.gitkeep');
      if (rest.length === 0) fs.rmSync(src, { recursive: true, force: true });
    } catch {
      // 删不掉就留着，不影响读取（resolveContentRoot 优先取分组里的）
    }
  }
  return { moved, conflicted };
}

/**
 * 应用数据目录：残留文件夹里只装这些时，多半是取消分组没搬完的空壳。
 * （内容库目录不在此列：用户可能把自己的备份放成 `备份/提示词管理`，不该去动。）
 */
const WORK_DATA_DIRS = new Set([TODO_DIR_NAME, TASK_DIR_NAME, REPORT_ROOT_DIR]);

/**
 * 修复历史残留：没有清单、又只装着待办 / 任务 / 工作汇报数据目录的文件夹。
 * 这些是「取消分组时清单已删、数据没搬走」留下的；数据先搬回空间根，空壳再删掉。
 * 只在空间根上对应的目录还没有内容时才接手（否则视为用户的备份副本，原样保留）。
 */
function repairOrphanWorkFolders(root, warnings, liveRels = new Set()) {
  for (const name of safeReaddir(root)) {
    if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
    if (liveRels.has(name)) continue; // 本次布局里的分组（清单可能还没写）不算残留
    const abs = path.join(root, name);
    if (!isDir(abs) || readManifest(abs)) continue;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    const visible = entries.filter((e) => e.name !== '.DS_Store' && e.name !== '.gitkeep');
    if (!visible.length) continue;
    if (!visible.every((e) => e.isDirectory() && WORK_DATA_DIRS.has(e.name))) continue;
    // 有数据的才修；全空壳的文件夹不动，避免误删用户随手建的空目录
    const dataDirs = visible.filter((e) => dirHasContent(path.join(abs, e.name)));
    if (!dataDirs.length) continue;
    if (dataDirs.some((e) => dirHasContent(path.join(root, e.name)))) continue;
    for (const ent of dataDirs) {
      const out = relocateContentDir(root, ent.name, path.join(root, ent.name), [
        path.join(abs, ent.name),
      ]);
      if (out.conflicted.length) {
        warnings.push(
          `「${name}/${ent.name}」里已有同名内容，未覆盖：${out.conflicted.slice(0, 5).join('、')}`,
        );
      }
    }
    if (!onlyManifest(abs)) continue;
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      warnings.push(`「${name}」里留着取消分组时的数据，已搬回空间根并清理空目录`);
    } catch {
      warnings.push(`无法删除残留目录「${name}」`);
    }
  }
}

/**
 * 把界面上的分组布局落成空间里的文件夹结构：新建、重命名、移动、删除。
 * 删除分组目录时只删「只剩清单」的目录；里面有用户其它文件时保留并返回 warning。
 * 组内菜单对应的内容目录会搬进分组文件夹（分组 = 物理归档）。
 *
 * @param {string} spaceDir
 * @param {Array<{id:string,name:string,items?:string[],parentId?:string}>} groups
 * @returns {{ groups: Array<{id:string,name:string,items:string[],parentId?:string}>, warnings: string[] }}
 */
export function syncNavGroups(spaceDir, groups) {
  const root = path.resolve(spaceDir);
  fs.mkdirSync(root, { recursive: true });

  const before = new Map();
  for (const g of scanGroupDirs(root)) before.set(g.id, g.rel);

  const wanted = [];
  const byId = new Map();
  for (const raw of Array.isArray(groups) ? groups : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const name = safeName(raw.name);
    if (!id || !name || byId.has(id)) continue;
    const g = {
      id,
      name,
      items: Array.isArray(raw.items) ? raw.items : [],
      parentId: typeof raw.parentId === 'string' ? raw.parentId.trim() : '',
    };
    byId.set(id, g);
    wanted.push(g);
  }
  for (const g of wanted) {
    const parentId = typeof g.parentId === 'string' ? g.parentId : '';
    const parent = parentId ? byId.get(parentId) : null;
    g.parentId = parent && !parent.parentId && parent.id !== g.id ? parent.id : '';
  }

  const warnings = [];
  const newRel = new Map();

  // 先顶层：父目录改名会带着子目录一起走，子分组随后按新父路径计算
  for (const g of wanted.filter((x) => !x.parentId)) {
    const oldRel = before.get(g.id) ?? '';
    const oldAbs = oldRel ? path.join(root, oldRel) : '';
    let name = g.name;
    if (oldRel !== name) {
      // 目标名被别的目录占着（包括没有清单的普通文件夹）时，另取一个不冲突的名字
      if (fs.existsSync(path.join(root, name))) name = claimName(root, name);
      if (oldAbs && fs.existsSync(oldAbs)) moveDir(oldAbs, path.join(root, name));
    }
    fs.mkdirSync(path.join(root, name), { recursive: true });
    newRel.set(g.id, name);
  }

  for (const g of wanted.filter((x) => x.parentId)) {
    const parentOld = before.get(g.parentId) ?? '';
    const parentNew = newRel.get(g.parentId);
    if (!parentNew) continue;
    let oldRel = before.get(g.id) ?? '';
    // 父目录刚改过名：子目录实际已跟着移到新父路径下
    if (oldRel && parentOld && parentOld !== parentNew && oldRel.startsWith(`${parentOld}/`)) {
      oldRel = `${parentNew}${oldRel.slice(parentOld.length)}`;
    }
    const parentAbs = path.join(root, parentNew);
    const oldAbs = oldRel ? path.join(root, oldRel) : '';
    let name = g.name;
    const targetRel = `${parentNew}/${name}`;
    if (oldRel !== targetRel) {
      if (fs.existsSync(path.join(parentAbs, name))) name = claimName(parentAbs, name);
      if (oldAbs && fs.existsSync(oldAbs)) moveDir(oldAbs, path.join(parentAbs, name));
    }
    fs.mkdirSync(path.join(parentAbs, name), { recursive: true });
    newRel.set(g.id, `${parentNew}/${name}`);
  }

  // 分组 = 物理归档：把组内菜单对应的内容目录搬进分组文件夹，取消分组的搬回空间根。
  // 必须在写清单 / 删分组之前做：被删掉的分组里的内容要先搬出来，否则会变成「挂在废目录里的数据」。
  const desiredRel = new Map();
  for (const g of wanted) {
    const rel = newRel.get(g.id);
    if (!rel) continue;
    for (const itemId of g.items) {
      const dirName = ITEM_DIR_NAMES.get(itemId);
      if (!dirName || desiredRel.has(dirName)) continue;
      desiredRel.set(dirName, rel);
    }
  }
  for (const dirName of new Set(ITEM_DIR_NAMES.values())) {
    const groupRel = desiredRel.get(dirName);
    const targetAbs = groupRel ? path.join(root, groupRel, dirName) : path.join(root, dirName);
    const out = relocateContentDir(root, dirName, targetAbs);
    if (out.conflicted.length) {
      warnings.push(
        `「${dirName}」里已有同名内容，未覆盖：${out.conflicted.slice(0, 5).join('、')}`,
      );
    }
  }

  // 旧版本留下的残留（取消分组后清单删了、数据没搬走）：顺手把数据接回空间根
  repairOrphanWorkFolders(root, warnings, new Set(newRel.values()));

  // 写清单（先写新的，再删旧的，避免中途失败丢分组）
  for (const g of wanted) {
    const rel = newRel.get(g.id);
    if (!rel) continue;
    const manifest = {
      id: g.id,
      items: [...new Set(g.items.filter((x) => typeof x === 'string'))],
    };
    const fp = path.join(root, rel, GROUP_MANIFEST_FILE);
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    try {
      // 内容没变就不重写：读取时也会对齐一次布局，避免每次进页面都改 mtime
      if (fs.readFileSync(fp, 'utf8') === body) continue;
    } catch {
      // 文件还不存在：照常写
    }
    fs.writeFileSync(fp, body, 'utf8');
  }

  // 删掉本次布局里已经不存在的分组目录（深的先删）
  const liveRels = new Set(newRel.values());
  const removed = [...before.entries()]
    .filter(([id]) => !byId.has(id))
    .sort((a, b) => b[1].split('/').length - a[1].split('/').length);
  for (const [, rel] of removed) {
    if (liveRels.has(rel)) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    // 兜底：取消分组时把还留在这个目录里的已知内容目录搬出去（上面的通用搬运可能因为
    // 目录已被改名 / 清单丢失而没算到它），否则「取消分组」会留下一坨搬不走的数据
    for (const dirName of new Set(ITEM_DIR_NAMES.values())) {
      const inside = path.join(abs, dirName);
      if (!fs.existsSync(inside)) continue;
      const out = relocateContentDir(root, dirName, path.join(root, dirName), [inside]);
      if (out.conflicted.length) {
        warnings.push(
          `「${dirName}」里已有同名内容，未覆盖：${out.conflicted.slice(0, 5).join('、')}`,
        );
      }
    }
    if (!onlyManifest(abs)) {
      // 目录里还有用户文件：保留目录，但摘掉清单，避免下次扫描又把分组加回来
      try {
        fs.rmSync(path.join(abs, GROUP_MANIFEST_FILE), { force: true });
      } catch {
        // ignore
      }
      warnings.push(`分组目录「${rel}」里还有其它文件，已保留目录，仅移除分组关系`);
      continue;
    }
    try {
      fs.rmSync(abs, { recursive: true, force: true });
    } catch {
      warnings.push(`无法删除分组目录「${rel}」`);
    }
  }

  return { groups: scanNavGroups(root).groups, warnings };
}

/** 扫描所有带清单的分组目录（含空分组），返回 id → 相对路径 */
function scanGroupDirs(root) {
  const out = [];
  const usedIds = new Set();
  const takeId = (preferred, fallback) => {
    let id = preferred || fallback;
    if (usedIds.has(id)) id = fallback;
    let n = 2;
    while (usedIds.has(id)) id = `${fallback}#${n++}`;
    usedIds.add(id);
    return id;
  };
  const top = [];
  for (const name of safeReaddir(root)) {
    if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
    const abs = path.join(root, name);
    if (!isDir(abs)) continue;
    const manifest = readManifest(abs);
    if (!manifest) continue;
    const id = takeId(manifest.id, `dir:${name}`);
    top.push({ id, name });
    out.push({ id, rel: name });
  }
  for (const parent of top) {
    const parentAbs = path.join(root, parent.name);
    for (const name of safeReaddir(parentAbs)) {
      if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
      const abs = path.join(parentAbs, name);
      if (!isDir(abs)) continue;
      const manifest = readManifest(abs);
      if (!manifest) continue;
      out.push({
        id: takeId(manifest.id, `dir:${parent.name}/${name}`),
        rel: `${parent.name}/${name}`,
      });
    }
  }
  return out;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 本地中间件：分组目录的读写入口 */
export function lhNavGroupsPlugin() {
  return {
    name: 'lh-nav-groups',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (url !== PREFIX) return next();
        try {
          if (req.method === 'GET') {
            const root = getDataRoot();
            const { groups, found } = scanNavGroups(root);
            if (!found) return sendJson(res, 200, { ok: true, scanned: false, groups });
            // 读取时顺带把组内内容目录对齐一次：旧空间（例如刚支持搬家的待办 / 任务）
            // 不用重新编辑分组也能自愈；syncNavGroups 本身是幂等的。
            const out = syncNavGroups(root, groups);
            return sendJson(res, 200, { ok: true, scanned: true, groups: out.groups });
          }
          if (req.method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const out = syncNavGroups(getDataRoot(), body.groups ?? []);
            return sendJson(res, 200, { ok: true, groups: out.groups, warnings: out.warnings });
          }
          return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      });
    },
  };
}
