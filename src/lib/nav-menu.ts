/**
 * 侧栏菜单项与用户分组（邮箱文件夹那种：勾选条目，创建/编辑分组）。
 * 默认不带任何分组：菜单平铺，分组由用户创建或由磁盘文件夹扫描得出。
 */
export type NavEntryId =
  | 'dashboard'
  | 'tasks'
  | 'todos'
  | 'projects'
  | 'iterations'
  | 'pmRequirements'
  | 'bugs'
  | 'reports'
  | 'testStats'
  | 'caseExec'
  | 'cases'
  | 'prompts'
  | 'knowledgeLib'
  | 'requirements'
  | 'templates';

export type NavOrderKey = `item:${NavEntryId}` | `group:${string}`;

export interface NavEntryDef {
  id: NavEntryId;
  href: string;
  i18n:
    | 'nav.dashboard'
    | 'nav.tasks'
    | 'nav.todos'
    | 'nav.projects'
    | 'nav.iterations'
    | 'nav.requirementsMgmt'
    | 'nav.bugs'
    | 'nav.reports'
    | 'nav.testStats'
    | 'nav.caseExec'
    | 'nav.caseManage'
    | 'nav.prompts'
    | 'nav.knowledge'
    | 'nav.requirements'
    | 'nav.templates';
  /** 对应扩展插件；未设则始终可见 */
  plugin?:
    | 'dashboard'
    | 'tasks'
    | 'todos'
    | 'projects'
    | 'iterations'
    | 'pmRequirements'
    | 'bugs'
    | 'reports'
    | 'testStats'
    | 'caseExec'
    | 'cases'
    | 'prompts'
    | 'knowledgeLib'
    | 'requirements'
    | 'templates';
  match: string;
}

export interface NavMenuGroup {
  id: string;
  name: string;
  items: NavEntryId[];
  /** 子分组的父级；只支持一层 */
  parentId?: string;
}

export const NAV_ENTRIES: readonly NavEntryDef[] = [
  {
    id: 'dashboard',
    href: 'dashboard/',
    i18n: 'nav.dashboard',
    plugin: 'dashboard',
    match: 'dashboard',
  },
  {
    id: 'tasks',
    href: 'tasks/',
    i18n: 'nav.tasks',
    plugin: 'tasks',
    match: 'tasks',
  },
  {
    id: 'todos',
    href: 'todos/',
    i18n: 'nav.todos',
    plugin: 'todos',
    match: 'todos',
  },
  {
    id: 'projects',
    href: 'pm/projects/',
    i18n: 'nav.projects',
    plugin: 'projects',
    match: 'pm/projects',
  },
  {
    id: 'iterations',
    href: 'pm/iterations/',
    i18n: 'nav.iterations',
    plugin: 'iterations',
    match: 'pm/iterations',
  },
  {
    id: 'pmRequirements',
    href: 'pm/requirements/',
    i18n: 'nav.requirementsMgmt',
    plugin: 'pmRequirements',
    match: 'pm/requirements',
  },
  {
    id: 'bugs',
    href: 'pm/bugs/',
    i18n: 'nav.bugs',
    plugin: 'bugs',
    match: 'pm/bugs',
  },
  {
    id: 'reports',
    href: 'reports/',
    i18n: 'nav.reports',
    plugin: 'reports',
    match: 'reports',
  },
  {
    id: 'testStats',
    href: 'test-stats/',
    i18n: 'nav.testStats',
    plugin: 'testStats',
    match: 'test-stats',
  },
  {
    id: 'caseExec',
    href: 'case-exec/',
    i18n: 'nav.caseExec',
    plugin: 'caseExec',
    match: 'case-exec',
  },
  {
    id: 'cases',
    href: 'cases/library/',
    i18n: 'nav.caseManage',
    plugin: 'cases',
    match: 'cases',
  },
  {
    id: 'prompts',
    href: 'prompts/',
    i18n: 'nav.prompts',
    plugin: 'prompts',
    match: 'prompts',
  },
  {
    id: 'knowledgeLib',
    href: 'knowledge/',
    i18n: 'nav.knowledge',
    plugin: 'knowledgeLib',
    match: 'knowledge',
  },
  {
    id: 'requirements',
    href: 'requirements/',
    i18n: 'nav.requirements',
    plugin: 'requirements',
    match: 'requirements',
  },
  {
    id: 'templates',
    href: 'templates/',
    i18n: 'nav.templates',
    plugin: 'templates',
    match: 'templates',
  },
];

/**
 * 默认不预置任何分组：空间新建时菜单平铺，分组由用户创建或由磁盘文件夹扫描得出。
 * （历史版本曾内置「文档库」分组，导致空空间刷新时闪一下写死的分组。）
 */
export const DEFAULT_NAV_GROUPS: NavMenuGroup[] = [];

/**
 * 固定条目：不参与分组与手动排序，始终渲染在侧栏底部（帮助中心上方）。
 * 提示词管理每个空间都有、且常与其他内容库混在同一分组里，固定在底部更好找。
 */
export const PINNED_NAV_ENTRIES: readonly NavEntryId[] = ['prompts'];

export function isPinnedNavEntry(id: NavEntryId): boolean {
  return PINNED_NAV_ENTRIES.includes(id);
}

/** 菜单图标：内置一组线性图标，用户可在菜单的「选择图标」里换 */
export type NavIconId =
  | 'check'
  | 'pencil'
  | 'book'
  | 'fileText'
  | 'layers'
  | 'list'
  | 'folder'
  | 'star'
  | 'database'
  | 'target'
  | 'code'
  | 'flask'
  | 'home'
  | 'clipboard'
  | 'bug'
  | 'calendar'
  | 'chart'
  | 'globe'
  | 'link'
  | 'users'
  | 'terminal'
  | 'tag'
  | 'flag'
  | 'zap'
  | 'dashboard';

export const NAV_ICON_IDS: readonly NavIconId[] = [
  'check',
  'pencil',
  'book',
  'fileText',
  'layers',
  'list',
  'folder',
  'star',
  'database',
  'target',
  'code',
  'flask',
  'home',
  'clipboard',
  'bug',
  'calendar',
  'chart',
  'globe',
  'link',
  'users',
  'terminal',
  'tag',
  'flag',
  'zap',
  'dashboard',
];

export const DEFAULT_NAV_ICONS: Record<NavEntryId, NavIconId> = {
  dashboard: 'dashboard',
  tasks: 'clipboard',
  todos: 'list',
  projects: 'folder',
  iterations: 'calendar',
  pmRequirements: 'fileText',
  bugs: 'bug',
  reports: 'fileText',
  testStats: 'chart',
  caseExec: 'target',
  cases: 'check',
  prompts: 'pencil',
  knowledgeLib: 'book',
  requirements: 'fileText',
  templates: 'layers',
};

export function isNavIconId(id: unknown): id is NavIconId {
  return typeof id === 'string' && (NAV_ICON_IDS as readonly string[]).includes(id);
}

export function normalizeNavIcons(raw: unknown): Record<NavEntryId, NavIconId> {
  const out = { ...DEFAULT_NAV_ICONS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const entry of NAV_ENTRIES) {
    const value = (raw as Record<string, unknown>)[entry.id];
    if (isNavIconId(value)) out[entry.id] = value;
  }
  return out;
}

const ENTRY_IDS = new Set<NavEntryId>(NAV_ENTRIES.map((e) => e.id));

export function isNavEntryId(id: unknown): id is NavEntryId {
  return typeof id === 'string' && ENTRY_IDS.has(id as NavEntryId);
}

export function getNavEntry(id: NavEntryId): NavEntryDef {
  return NAV_ENTRIES.find((e) => e.id === id)!;
}

export function itemOrderKey(id: NavEntryId): NavOrderKey {
  return `item:${id}`;
}

export function groupOrderKey(id: string): NavOrderKey {
  return `group:${id}`;
}

function uid(): string {
  return `ng_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function cloneDefault(): NavMenuGroup[] {
  return DEFAULT_NAV_GROUPS.map((g) => ({ id: g.id, name: g.name, items: [...g.items] }));
}

export function normalizeNavGroups(raw: unknown, fallbackToDefault = true): NavMenuGroup[] {
  // 磁盘扫描结果为空就是「没有分组」，不能回落到默认分组
  if (raw === undefined || raw === null) return fallbackToDefault ? cloneDefault() : [];
  if (!Array.isArray(raw)) return fallbackToDefault ? cloneDefault() : [];
  const seen = new Set<NavEntryId>();
  const parsed: NavMenuGroup[] = [];
  const usedIds = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = String(o.name ?? '').trim();
    if (!name) continue;
    let id = String(o.id ?? '').trim() || uid();
    if (usedIds.has(id)) id = uid();
    const items: NavEntryId[] = [];
    if (Array.isArray(o.items)) {
      for (const x of o.items) {
        if (!isNavEntryId(x) || seen.has(x)) continue;
        seen.add(x);
        items.push(x);
      }
    }
    const parentId = String(o.parentId ?? '').trim() || undefined;
    usedIds.add(id);
    parsed.push({ id, name, items, parentId });
  }
  const ids = new Set(parsed.map((g) => g.id));
  const cleaned: NavMenuGroup[] = parsed.map((g) => {
    let parentId = g.parentId;
    if (!parentId || parentId === g.id || !ids.has(parentId)) parentId = undefined;
    return parentId ? { ...g, parentId } : { id: g.id, name: g.name, items: g.items };
  });
  const byId = new Map(cleaned.map((g) => [g.id, g]));
  const hoisted: NavMenuGroup[] = cleaned.map((g) => {
    if (!g.parentId) return g;
    const parent = byId.get(g.parentId);
    if (parent?.parentId) {
      const root = parent.parentId;
      return root && root !== g.id && ids.has(root)
        ? { ...g, parentId: root }
        : { id: g.id, name: g.name, items: g.items };
    }
    return g;
  });
  const childOf = new Set(hoisted.map((g) => g.parentId).filter((x): x is string => Boolean(x)));
  return hoisted.filter((g) => g.items.length > 0 || childOf.has(g.id));
}

export function upsertNavGroup(
  groups: NavMenuGroup[],
  draft: { id?: string; name: string; items: NavEntryId[]; parentId?: string },
): { groups: NavMenuGroup[]; id: string } {
  const name = draft.name.trim();
  const items = draft.items.filter((id, i, arr) => isNavEntryId(id) && arr.indexOf(id) === i);
  if (!name || !items.length) return { groups, id: draft.id?.trim() || '' };
  const id = draft.id?.trim() || uid();
  const existing = groups.find((g) => g.id === id);
  let parentId =
    draft.parentId !== undefined ? draft.parentId.trim() || undefined : existing?.parentId;
  if (parentId === id) parentId = undefined;
  if (parentId) {
    const parent = groups.find((g) => g.id === parentId);
    if (!parent) parentId = undefined;
    else if (parent.parentId) parentId = parent.parentId;
  }
  const take = new Set(items);
  const next = groups
    .filter((g) => g.id !== id)
    .map((g) => ({ ...g, items: g.items.filter((x) => !take.has(x)) }));
  next.push(parentId ? { id, name, items, parentId } : { id, name, items });
  return { groups: normalizeNavGroups(next), id };
}

export function childGroupIds(groups: NavMenuGroup[], parentId: string): string[] {
  return groups.filter((g) => g.parentId === parentId).map((g) => g.id);
}

export function listChildGroups(groups: NavMenuGroup[], parentId: string): NavMenuGroup[] {
  return groups.filter((g) => g.parentId === parentId);
}

export function topLevelGroups(groups: NavMenuGroup[]): NavMenuGroup[] {
  return groups.filter((g) => !g.parentId);
}

export function removeNavGroup(groups: NavMenuGroup[], id: string): NavMenuGroup[] {
  const removed = groups.find((g) => g.id === id);
  if (!removed) return groups;
  const rest = groups.filter((g) => g.id !== id);
  if (removed.parentId) {
    return rest.map((g) => {
      if (g.id === removed.parentId) {
        return { ...g, items: [...g.items, ...removed.items] };
      }
      if (g.parentId === id) return { ...g, parentId: removed.parentId };
      return g;
    });
  }
  return rest.map((g) => (g.parentId === id ? { id: g.id, name: g.name, items: g.items } : g));
}

export function addItemToGroup(
  groups: NavMenuGroup[],
  groupId: string,
  itemId: NavEntryId,
): NavMenuGroup[] {
  const g = groups.find((x) => x.id === groupId);
  if (!g || !isNavEntryId(itemId) || g.items.includes(itemId)) return groups;
  return upsertNavGroup(groups, { id: g.id, name: g.name, items: [...g.items, itemId] }).groups;
}

export function removeItemFromGroup(
  groups: NavMenuGroup[],
  itemId: NavEntryId,
): { groups: NavMenuGroup[]; owner: NavMenuGroup | null } {
  const owner = groups.find((g) => g.items.includes(itemId)) ?? null;
  if (!owner) return { groups, owner: null };
  return {
    groups: groups
      .map((g) => (g.id === owner.id ? { ...g, items: g.items.filter((x) => x !== itemId) } : g))
      .filter((g) => g.items.length > 0),
    owner,
  };
}

export function orderAfterLeaveGroup(
  order: readonly string[],
  itemId: NavEntryId,
  owner: NavMenuGroup,
  nextGroups: NavMenuGroup[],
): NavOrderKey[] {
  const itemKey = itemOrderKey(itemId);
  const groupKey = groupOrderKey(owner.id);
  const still = nextGroups.some((g) => g.id === owner.id);
  const idx = order.indexOf(groupKey);
  const filtered = order.filter((k) => k !== itemKey && (still || k !== groupKey));
  const at = idx < 0 ? filtered.length : still ? idx + 1 : idx;
  filtered.splice(at, 0, itemKey);
  return normalizeNavOrder(filtered, nextGroups);
}

export type NavRenderNode =
  { type: 'item'; id: NavEntryId } | { type: 'group'; group: NavMenuGroup };

/** 未分组项按目录顺序；顶层分组出现在其（含子孙）第一个成员原本的位置 */
export function catalogNavRenderList(groups: NavMenuGroup[]): NavRenderNode[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const grouped = new Map<NavEntryId, NavMenuGroup>();
  for (const g of groups) {
    const top = g.parentId ? (byId.get(g.parentId) ?? g) : g;
    for (const id of g.items) grouped.set(id, top);
  }
  const emitted = new Set<string>();
  const out: NavRenderNode[] = [];
  for (const entry of NAV_ENTRIES) {
    const g = grouped.get(entry.id);
    if (g) {
      if (emitted.has(g.id)) continue;
      emitted.add(g.id);
      out.push({ type: 'group', group: g });
    } else {
      out.push({ type: 'item', id: entry.id });
    }
  }
  return out;
}

/**
 * 默认顺序：顶层项 / 顶层分组照目录顺序，子分组的 key 紧跟在父组后面。
 * 子分组 key 不参与侧栏顶层渲染，只用来记同一父组内的相对顺序。
 */
export function defaultNavOrder(groups: NavMenuGroup[]): NavOrderKey[] {
  const childrenOf = new Map<string, NavMenuGroup[]>();
  for (const g of groups) {
    if (!g.parentId) continue;
    const list = childrenOf.get(g.parentId);
    if (list) list.push(g);
    else childrenOf.set(g.parentId, [g]);
  }
  const out: NavOrderKey[] = [];
  const emitted = new Set<string>();
  const pushGroup = (g: NavMenuGroup) => {
    if (emitted.has(g.id)) return;
    emitted.add(g.id);
    out.push(groupOrderKey(g.id));
    for (const child of childrenOf.get(g.id) ?? []) pushGroup(child);
  };
  for (const node of catalogNavRenderList(groups)) {
    if (node.type === 'item') out.push(itemOrderKey(node.id));
    else pushGroup(node.group);
  }
  // 目录顺序里没出现的分组（例如父组分面没有自己的菜单项）兜底接在后面
  for (const g of groups) pushGroup(g);
  return out;
}

function validOrderKeys(groups: NavMenuGroup[]): Set<string> {
  const grouped = new Set<NavEntryId>();
  const valid = new Set<string>();
  for (const g of groups) {
    // 顶层与子分组都记顺序：子分组只用相对顺序，渲染时不会出现在顶层
    valid.add(groupOrderKey(g.id));
    for (const id of g.items) grouped.add(id);
  }
  for (const e of NAV_ENTRIES) {
    if (!grouped.has(e.id)) valid.add(itemOrderKey(e.id));
  }
  return valid;
}

export function normalizeNavOrder(raw: unknown, groups: NavMenuGroup[]): NavOrderKey[] {
  const valid = validOrderKeys(groups);
  const out: NavOrderKey[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (typeof x !== 'string' || !valid.has(x) || seen.has(x)) continue;
      seen.add(x);
      out.push(x as NavOrderKey);
    }
  }
  for (const k of defaultNavOrder(groups)) {
    if (!seen.has(k)) out.push(k);
  }
  return out;
}

export function buildNavRenderList(
  groups: NavMenuGroup[],
  order?: readonly string[],
): NavRenderNode[] {
  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const groupedItems = new Set(groups.flatMap((g) => g.items));
  const keys = normalizeNavOrder(order, groups);
  const out: NavRenderNode[] = [];
  for (const key of keys) {
    if (key.startsWith('group:')) {
      const g = byGroup.get(key.slice(6));
      // 子分组的 key 只用于父组内排序，不能出现在侧栏顶层
      if (g && !g.parentId) out.push({ type: 'group', group: g });
      continue;
    }
    if (key.startsWith('item:')) {
      const id = key.slice(5);
      if (isNavEntryId(id) && !groupedItems.has(id)) out.push({ type: 'item', id });
    }
  }
  return out;
}

export function orderAfterUpsert(
  order: readonly string[],
  nextGroups: NavMenuGroup[],
  groupId: string,
): NavOrderKey[] {
  const g = nextGroups.find((x) => x.id === groupId);
  if (!g) return normalizeNavOrder(order, nextGroups);
  const take = new Set(g.items.map((id) => itemOrderKey(id)));
  const groupKey = groupOrderKey(groupId);
  // 子分组不占顶层位置：key 紧跟在父组后面，只影响同一父组内的相对顺序
  if (g.parentId) {
    const rest = order.filter((k) => k !== groupKey);
    const parentKey = groupOrderKey(g.parentId);
    const at = rest.indexOf(parentKey);
    const filtered = [...rest];
    if (at < 0) filtered.push(groupKey);
    else filtered.splice(at + 1, 0, groupKey);
    return normalizeNavOrder(filtered, nextGroups);
  }
  const prev = [...order];
  let insertAt = prev.length;
  for (let i = 0; i < prev.length; i++) {
    const k = prev[i];
    if (k === groupKey || take.has(k as NavOrderKey)) {
      insertAt = prev
        .slice(0, i)
        .filter((x) => x !== groupKey && !take.has(x as NavOrderKey)).length;
      break;
    }
  }
  const filtered = prev.filter((k) => k !== groupKey && !take.has(k as NavOrderKey));
  filtered.splice(insertAt, 0, groupKey);
  return normalizeNavOrder(filtered, nextGroups);
}

/**
 * 同一父组下的子分组按 navOrder 的相对顺序排列。
 * 顺序里没有的子分组保持在原数组位置（排在已记录的后面）。
 */
export function orderedChildGroups(
  groups: NavMenuGroup[],
  parentId: string,
  order?: readonly string[],
): NavMenuGroup[] {
  const children = listChildGroups(groups, parentId);
  if (!order?.length || children.length < 2) return children;
  const index = new Map<string, number>();
  order.forEach((key, i) => {
    if (!index.has(key)) index.set(key, i);
  });
  return children
    .map((group, i) => ({ group, i, at: index.get(groupOrderKey(group.id)) }))
    .sort((a, b) => {
      const av = a.at ?? Number.POSITIVE_INFINITY;
      const bv = b.at ?? Number.POSITIVE_INFINITY;
      return av === bv ? a.i - b.i : av - bv;
    })
    .map((x) => x.group);
}

/** 把某个父组下的子分组顺序写回 navOrder（不改动其它分组的 key） */
export function orderAfterChildReorder(
  order: readonly string[],
  groups: NavMenuGroup[],
  parentId: string,
  childIds: readonly string[],
): NavOrderKey[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const moved = childIds.filter((id) => byId.get(id)?.parentId === parentId);
  const movedKeys = new Set<string>(moved.map(groupOrderKey));
  const rest = order.filter((k) => !movedKeys.has(k));
  const parentKey = groupOrderKey(parentId);
  const at = rest.indexOf(parentKey);
  const insert = moved.map(groupOrderKey);
  const next = [...rest];
  if (at < 0) next.push(...insert);
  else next.splice(at + 1, 0, ...insert);
  return normalizeNavOrder(next, groups);
}

/** navOrder 里的 key 是否属于子分组（顶层排序弹层要跳过） */
export function isChildGroupKey(key: string, groups: NavMenuGroup[]): boolean {
  if (!key.startsWith('group:')) return false;
  const id = key.slice(6);
  return groups.some((g) => g.id === id && Boolean(g.parentId));
}

export function orderAfterRemove(
  order: readonly string[],
  removed: NavMenuGroup,
  nextGroups: NavMenuGroup[],
  childIds: readonly string[] = [],
): NavOrderKey[] {
  if (removed.parentId) return normalizeNavOrder(order, nextGroups);
  const groupKey = groupOrderKey(removed.id);
  // 删除分组后，组内菜单平铺到侧栏底部（帮助中心上方），而不是占回分组原来的位置
  const append = [
    ...childIds.map((id) => groupOrderKey(id)),
    ...removed.items.map((id) => itemOrderKey(id)),
  ];
  const filtered = order.filter((k) => k !== groupKey);
  filtered.push(...append);
  return normalizeNavOrder(filtered, nextGroups);
}

export function moveNavOrder(
  order: readonly NavOrderKey[],
  key: NavOrderKey,
  dir: -1 | 1,
): NavOrderKey[] {
  const i = order.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const next = [...order];
  const a = next[i];
  const b = next[j];
  if (a === undefined || b === undefined) return next;
  next[i] = b;
  next[j] = a;
  return next;
}

export function moveListItem<T>(list: readonly T[], id: T, dir: -1 | 1): T[] {
  const i = list.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  const a = next[i];
  const b = next[j];
  if (a === undefined || b === undefined) return next;
  next[i] = b;
  next[j] = a;
  return next;
}

export function reorderList<T>(list: readonly T[], from: T, to: T): T[] {
  const i = list.indexOf(from);
  const j = list.indexOf(to);
  if (i < 0 || j < 0 || i === j) return [...list];
  const next = [...list];
  const [item] = next.splice(i, 1);
  if (item === undefined) return [...list];
  next.splice(j, 0, item);
  return next;
}

export function reorderNavOrder(
  order: readonly NavOrderKey[],
  fromKey: NavOrderKey,
  toKey: NavOrderKey,
): NavOrderKey[] {
  return reorderList(order, fromKey, toKey);
}
