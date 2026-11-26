import {
  pendingProposals,
  type BusinessDirectory,
  type BusinessFunction,
  type BusinessSystem,
} from './business-map';

export type BusinessFunctionFilter = 'all' | 'unconfirmed' | 'no-evidence' | 'unlinked';
export type BusinessSystemFilter = 'all' | 'draft' | 'published' | 'pending';
export type BusinessSystemSort = 'created' | 'name';
export type BusinessMenuDropPosition = 'before' | 'inside' | 'after';
export type BusinessMenuNavigationItem = { label: string; order: number };

export const FUNCTION_FILTERS: ReadonlyArray<{ value: BusinessFunctionFilter; label: string }> = [
  { value: 'all', label: '全部功能' },
  { value: 'unconfirmed', label: '待确认' },
  { value: 'no-evidence', label: '缺少证据' },
  { value: 'unlinked', label: '未关联流程' },
];

function compareDirectoryOrder(left: BusinessDirectory, right: BusinessDirectory) {
  const leftHome = [left.name, ...left.menuPath].some((name) => name.trim() === '首页');
  const rightHome = [right.name, ...right.menuPath].some((name) => name.trim() === '首页');
  return (
    Number(rightHome) - Number(leftHome) ||
    left.order - right.order ||
    left.name.localeCompare(right.name, 'zh-CN')
  );
}

/**
 * 按系统菜单同级顺序组织功能目录。
 * 组件只对有子目录的节点渲染折叠区；没有子目录的节点直接作为独立菜单。
 */
export function organizeBusinessDirectories(directories: BusinessDirectory[]) {
  const children = new Map<string, BusinessDirectory[]>();
  const ids = new Set(directories.map((directory) => directory.id));
  for (const directory of directories) {
    const siblings = children.get(directory.parentId) || [];
    siblings.push(directory);
    children.set(directory.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareDirectoryOrder);
  const orphanedRoots = directories.filter(
    (directory) => directory.parentId && !ids.has(directory.parentId),
  );
  const roots = [...(children.get('') || []), ...orphanedRoots].sort(compareDirectoryOrder);
  return { roots, children };
}

/**
 * 目录是否需要下拉：
 * - 有子目录时必须是容器；
 * - 有直属功能时把它视为承载子菜单的容器；
 * - 首页是没有下级目录的入口，始终作为叶子菜单。
 */
export function businessDirectoryUsesDropdown(
  directory: BusinessDirectory,
  directories: BusinessDirectory[],
  functions: BusinessFunction[],
) {
  if (directories.some((item) => item.parentId === directory.id)) return true;
  if ([directory.name, ...directory.menuPath].some((name) => name.trim() === '首页')) return false;
  const ownFunctions = functions.filter((item) => item.directoryId === directory.id);
  const normalizedName = directory.name.replace(/\s+/g, '').toLowerCase();
  return ownFunctions.some(
    (item) => item.name.replace(/\s+/g, '').toLowerCase() !== normalizedName,
  );
}

export function businessPromotedFunctionIds(
  directories: BusinessDirectory[],
  functions: BusinessFunction[],
  _navigation: BusinessMenuNavigationItem[],
) {
  const promoted = new Set<string>();
  for (const fn of functions) {
    if (fn.menuRoot === true) {
      promoted.add(fn.id);
      continue;
    }
    if (!fn.directoryId) {
      promoted.add(fn.id);
      continue;
    }
    const directory = directories.find((item) => item.id === fn.directoryId);
    if (!directory) continue;
  }
  return promoted;
}

export function businessMenuDropPosition(
  kind: 'directory' | 'function',
  verticalRatio: number,
): BusinessMenuDropPosition {
  const ratio = Math.max(0, Math.min(1, Number(verticalRatio) || 0));
  if (kind === 'directory' && ratio > 0.28 && ratio < 0.72) return 'inside';
  return ratio < 0.5 ? 'before' : 'after';
}

export function businessSystemSummary(system: BusinessSystem) {
  const linked = new Set(
    system.flows.flatMap((flow) => flow.steps.map((step) => step.functionId)).filter(Boolean),
  );
  const domains = system.directories.length
    ? system.directories
        .filter((directory) => !directory.parentId)
        .map((directory) => {
          const ids = new Set([directory.id]);
          const queue = [directory.id];
          while (queue.length) {
            const parentId = queue.shift();
            for (const child of system.directories) {
              if (child.parentId === parentId && !ids.has(child.id)) {
                ids.add(child.id);
                queue.push(child.id);
              }
            }
          }
          const functions = system.functions.filter((item) => ids.has(item.directoryId));
          return {
            name: directory.name,
            functions,
            confirmed: functions.filter((item) => item.confirmed).length,
          };
        })
    : [...new Set(system.functions.map((item) => item.domain || '未归类'))].map((name) => {
        const functions = system.functions.filter((item) => (item.domain || '未归类') === name);
        return { name, functions, confirmed: functions.filter((item) => item.confirmed).length };
      });
  const withEvidence = system.functions.filter((item) => item.evidence.length > 0).length;
  return {
    domains,
    withEvidence,
    evidencePercent: system.functions.length
      ? Math.round((withEvidence / system.functions.length) * 100)
      : 0,
    confirmed: system.functions.filter((item) => item.confirmed).length,
    unconfirmed: system.functions.filter((item) => !item.confirmed).length,
    noEvidence: system.functions.length - withEvidence,
    unlinked: system.functions.filter((item) => !linked.has(item.id)).length,
    pending: pendingProposals(system).length,
    linked,
  };
}

export function filterBusinessFunctions(
  system: BusinessSystem,
  filter: BusinessFunctionFilter,
  domain = '全部',
  query = '',
): BusinessFunction[] {
  const term = query.trim().toLowerCase();
  const { linked } = businessSystemSummary(system);
  return system.functions.filter((item) => {
    if (domain !== '全部' && (item.domain || '未归类') !== domain) return false;
    if (filter === 'unconfirmed' && item.confirmed) return false;
    if (filter === 'no-evidence' && item.evidence.length) return false;
    if (filter === 'unlinked' && linked.has(item.id)) return false;
    return (
      !term ||
      [item.name, item.code, item.domain, item.module, item.purpose, ...item.roles, ...item.rules]
        .join(' ')
        .toLowerCase()
        .includes(term)
    );
  });
}

export function filterBusinessSystems(
  systems: BusinessSystem[],
  filter: BusinessSystemFilter,
  query: string,
  sort: BusinessSystemSort,
) {
  const term = query.trim().toLowerCase();
  return systems
    .filter((system) => {
      if (filter === 'pending' && !pendingProposals(system).length) return false;
      if ((filter === 'draft' || filter === 'published') && system.status !== filter) return false;
      return (
        !term ||
        [
          system.name,
          system.description,
          system.entryUrl,
          ...system.directories.flatMap((item) => [item.name, ...item.menuPath]),
          ...system.functions.flatMap((item) => [item.domain, item.module, item.name]),
        ]
          .join(' ')
          .toLowerCase()
          .includes(term)
      );
    })
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, 'zh-CN')
        : (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) ||
          a.name.localeCompare(b.name, 'zh-CN'),
    );
}

export function businessEntryUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function businessCreatedLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '创建时间未知'
    : `${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(date)} 创建`;
}
