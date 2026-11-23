import { pendingProposals, type BusinessFunction, type BusinessSystem } from './business-map';

export type BusinessFunctionFilter = 'all' | 'unconfirmed' | 'no-evidence' | 'unlinked';
export type BusinessSystemFilter = 'all' | 'draft' | 'published' | 'pending';
export type BusinessSystemSort = 'updated' | 'name';

export const FUNCTION_FILTERS: ReadonlyArray<{ value: BusinessFunctionFilter; label: string }> = [
  { value: 'all', label: '全部功能' },
  { value: 'unconfirmed', label: '待确认' },
  { value: 'no-evidence', label: '缺少证据' },
  { value: 'unlinked', label: '未关联流程' },
];

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
        : (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
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

export function businessUpdatedLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '尚未更新'
    : `${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(date)} 更新`;
}
