import {
  flushAppConfig,
  getCachedAppConfig,
  isAppConfigFileMode,
  updateAppConfig,
} from './app-config';
import {
  normalizeNavGroups,
  normalizeNavIcons,
  normalizeNavOrder,
  type NavEntryId,
  type NavIconId,
  type NavMenuGroup,
  type NavOrderKey,
} from './nav-menu';

const NAV_API = '/__tb_nav/groups';

export function listNavGroups(): NavMenuGroup[] {
  return getCachedAppConfig().navGroups;
}

export function listNavIcons(): Record<NavEntryId, NavIconId> {
  return normalizeNavIcons(getCachedAppConfig().navIcons);
}

export function setNavIcon(id: NavEntryId, icon: NavIconId): Record<NavEntryId, NavIconId> {
  const next = { ...listNavIcons(), [id]: icon };
  updateAppConfig({ navIcons: next });
  void flushAppConfig();
  return next;
}

export function listNavOrder(): NavOrderKey[] {
  return getCachedAppConfig().navOrder;
}

export function saveNavLayout(
  groups: NavMenuGroup[],
  order: readonly string[],
): { groups: NavMenuGroup[]; order: NavOrderKey[] } {
  const nextGroups = normalizeNavGroups(groups);
  const nextOrder = normalizeNavOrder(order, nextGroups);
  updateAppConfig({ navGroups: nextGroups, navOrder: nextOrder });
  void flushAppConfig();
  return { groups: nextGroups, order: nextOrder };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 把分组布局写成空间里的文件夹结构（仅本地服务模式）；返回落盘后的规范结果与冲突提示 */
export async function syncNavGroupsToDisk(
  groups: NavMenuGroup[],
): Promise<{ groups: NavMenuGroup[]; warnings: string[] } | null> {
  if (!isAppConfigFileMode()) return null;
  try {
    const res = await fetch(NAV_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { groups?: unknown; warnings?: unknown };
    return {
      groups: normalizeNavGroups(data.groups, false),
      warnings: Array.isArray(data.warnings)
        ? data.warnings.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * 启动时用磁盘上的分组目录校正配置：
 * - 空间里已有分组清单（整份目录拷过来的空间）→ 以磁盘为准
 * - 还没有任何分组目录（旧空间）→ 把现有配置落成文件夹，完成一次迁移
 */
export async function hydrateNavLayout(): Promise<void> {
  if (!isAppConfigFileMode()) return;
  const cfg = getCachedAppConfig();

  let data: { scanned?: boolean; groups?: unknown } | null = null;
  try {
    const res = await fetch(NAV_API, { signal: AbortSignal.timeout(4000) });
    if (res.ok) data = (await res.json()) as { scanned?: boolean; groups?: unknown };
  } catch {
    return;
  }
  if (!data) return;

  if (data.scanned) {
    const groups = normalizeNavGroups(data.groups, false);
    const order = normalizeNavOrder(cfg.navOrder, groups);
    if (!sameJson(groups, cfg.navGroups) || !sameJson(order, cfg.navOrder)) {
      updateAppConfig({ navGroups: groups, navOrder: order });
      void flushAppConfig();
    }
    return;
  }

  if (!cfg.navGroups.length) return;
  const canonical = await syncNavGroupsToDisk(cfg.navGroups);
  if (!canonical || sameJson(canonical.groups, cfg.navGroups)) return;
  updateAppConfig({
    navGroups: canonical.groups,
    navOrder: normalizeNavOrder(cfg.navOrder, canonical.groups),
  });
  void flushAppConfig();
}
