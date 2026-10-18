/**
 * 侧栏可分组菜单：用例 / 提示词 / 知识库 / 需求 / 模板。
 * 默认「文档库」分组；可像邮箱建文件夹那样勾选条目创建新组。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { hydrateAppConfig } from '../../lib/app-config';
import { t, type I18nKey } from '../../lib/i18n';
import { spaceScopedKey } from '../../lib/space-scope';
import {
  hydrateNavLayout,
  listNavGroups,
  listNavIcons,
  listNavOrder,
  saveNavLayout,
  setNavIcon,
  syncNavGroupsToDisk,
} from '../../lib/nav-groups';
import {
  DEFAULT_NAV_ICONS,
  NAV_ICON_IDS,
  buildNavRenderList,
  getNavEntry,
  groupOrderKey,
  itemOrderKey,
  addItemToGroup,
  childGroupIds,
  listChildGroups,
  orderAfterChildReorder,
  orderedChildGroups,
  isChildGroupKey,
  NAV_ENTRIES,
  isPinnedNavEntry,
  orderAfterLeaveGroup,
  orderAfterRemove,
  orderAfterUpsert,
  removeItemFromGroup,
  removeNavGroup,
  upsertNavGroup,
  type NavEntryId,
  type NavIconId,
  type NavMenuGroup,
  type NavOrderKey,
  type NavRenderNode,
} from '../../lib/nav-menu';
import { isPluginEnabled, loadPluginEnabled, onPluginEnabledChanged } from '../../lib/plugins';
import ConfirmDialog from './ConfirmDialog';
import { usePointerReorder } from './use-pointer-reorder';

const base = import.meta.env.BASE_URL;

function joinHref(path: string): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}${path.replace(/^\//, '')}`;
}

function pathHas(pathname: string, seg: string): boolean {
  return pathname.includes(`/${seg}`);
}

function navItemClass(active: boolean): string {
  return ['tw-nav-item', active ? 'is-active font-medium' : ''].filter(Boolean).join(' ');
}

function groupOpenKey(id: string): string {
  return spaceScopedKey(`tw.nav.groupOpen.${id}`);
}

function legacyDocsOpenKey(): string {
  return spaceScopedKey('tw.nav.docsOpen');
}

function readGroupOpen(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(groupOpenKey(id));
    if (v === '1') return true;
    if (v === '0') return false;
    if (id === 'docs') {
      const legacy = localStorage.getItem(legacyDocsOpenKey());
      if (legacy === '1') return true;
      if (legacy === '0') return false;
    }
  } catch {
    // ignore
  }
  return fallback;
}

function writeGroupOpen(id: string, open: boolean) {
  try {
    localStorage.setItem(groupOpenKey(id), open ? '1' : '0');
    if (id === 'docs') localStorage.setItem(legacyDocsOpenKey(), open ? '1' : '0');
  } catch {
    // ignore
  }
}

function displayGroupName(group: NavMenuGroup): string {
  if (group.id === 'docs' && (group.name === '文档库' || group.name === 'Documents')) {
    return t('nav.docs');
  }
  return group.name;
}

function nodeLabel(node: NavRenderNode): string {
  if (node.type === 'group') return displayGroupName(node.group);
  return t(getNavEntry(node.id).i18n as I18nKey);
}

function nodeOrderKey(node: NavRenderNode): NavOrderKey {
  return node.type === 'item' ? itemOrderKey(node.id) : groupOrderKey(node.group.id);
}

function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    document.addEventListener('astro:page-load', sync);
    document.addEventListener('astro:after-swap', sync);
    window.addEventListener('popstate', sync);
    return () => {
      document.removeEventListener('astro:page-load', sync);
      document.removeEventListener('astro:after-swap', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  return path;
}

function Ico({ children }: { children: ReactNode }) {
  return (
    <svg
      className="tw-nav-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function EntryIcon({ id, icon }: { id: NavEntryId; icon?: NavIconId }) {
  return <Ico>{ICON_PATHS[icon ?? DEFAULT_NAV_ICONS[id]]}</Ico>;
}

/** 菜单图标库：与 `NavIconId` 一一对应，均为 24x24 线性图标 */
const ICON_PATHS: Record<NavIconId, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  check: (
    <>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  pencil: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>
  ),
  fileText: (
    <>
      <path d="M14 3v5h5" />
      <path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  star: <path d="m12 3 2.1 5.9L20 11l-5 4.3 1.7 6.2-5.7-3.9-5.7 3.9L7 15.3 2 11l5.9-2.1L12 3z" />,
  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  code: (
    <>
      <path d="m8 8-4 4 4 4" />
      <path d="m16 8 4 4-4 4" />
    </>
  ),
  flask: (
    <>
      <path d="M9 3h6" />
      <path d="M10 3v6l-5 8a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-8V3" />
      <path d="M7.5 14h9" />
    </>
  ),
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20h14V9.5" />
    </>
  ),
  clipboard: (
    <>
      <path d="M9 4h6v3H9z" />
      <path d="M8 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
    </>
  ),
  bug: (
    <>
      <circle cx="12" cy="14" r="5" />
      <path d="M9 6l2 2" />
      <path d="M15 6l-2 2" />
      <path d="M7 11H4" />
      <path d="M20 11h-3" />
      <path d="M7 17H4" />
      <path d="M20 17h-3" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <path d="M3 10h18" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M2 20h20" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 4 5.7 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.7-4-9s1.5-6.5 4-9z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7L11 6.3" />
      <path d="M14 11a4 4 0 0 0-5.7 0L6 13.3a4 4 0 0 0 5.7 5.7L13 17.7" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.5a3.5 3.5 0 0 1 0 7" />
      <path d="M18 20a6 6 0 0 0-2-4.5" />
    </>
  ),
  terminal: (
    <>
      <path d="m5 8 4 4-4 4" />
      <path d="M13 16h6" />
    </>
  ),
  tag: (
    <>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 1.4.6l6.2 6.2a2 2 0 0 1 0 2.6z" />
      <circle cx="8" cy="8" r="1.2" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 5h11l-2 4 2 4H5z" />
    </>
  ),
  zap: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />,
};

function FolderIcons() {
  return (
    <>
      <svg
        className="tw-nav-ico tw-nav-ico--closed"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden
      >
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      </svg>
      <svg
        className="tw-nav-ico tw-nav-ico--open"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden
      >
        <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      </svg>
    </>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <path d="M21 4H14" strokeLinecap="round" />
      <path d="M10 4H3" strokeLinecap="round" />
      <path d="M21 12H12" strokeLinecap="round" />
      <path d="M8 12H3" strokeLinecap="round" />
      <path d="M21 20H16" strokeLinecap="round" />
      <path d="M12 20H3" strokeLinecap="round" />
      <path d="M14 2v4" strokeLinecap="round" />
      <path d="M8 10v4" strokeLinecap="round" />
      <path d="M16 18v4" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8" strokeLinecap="round" />
      <path d="M8 12h8" strokeLinecap="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

function PopFolderIcon() {
  return (
    <svg
      className="tw-nav-group-pop-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

function PopLeaveIcon() {
  return (
    <svg
      className="tw-nav-group-pop-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M9 6H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" strokeLinecap="round" />
      <path d="M16 8l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 12H9" strokeLinecap="round" />
    </svg>
  );
}

function PopIconIcon() {
  return (
    <svg
      className="tw-nav-group-pop-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <circle cx="8.5" cy="8.5" r="4.5" />
      <rect x="12" y="12" width="9" height="9" rx="2" />
    </svg>
  );
}

function SortArrowsIcon() {
  return (
    <Ico>
      <path d="M8 6v12" strokeLinecap="round" />
      <path d="M5 9l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 18V6" strokeLinecap="round" />
      <path d="M13 15l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
    </Ico>
  );
}

function GripIcon() {
  return (
    <svg className="tw-nav-drag-grip" viewBox="0 0 20 20" aria-hidden>
      <circle cx="7" cy="5" r="1.25" fill="currentColor" />
      <circle cx="13" cy="5" r="1.25" fill="currentColor" />
      <circle cx="7" cy="10" r="1.25" fill="currentColor" />
      <circle cx="13" cy="10" r="1.25" fill="currentColor" />
      <circle cx="7" cy="15" r="1.25" fill="currentColor" />
      <circle cx="13" cy="15" r="1.25" fill="currentColor" />
    </svg>
  );
}

function entryVisible(id: NavEntryId, plugins: Record<string, boolean>): boolean {
  // 固定入口（提示词管理）由 Base.astro 渲染在帮助中心上方，不进入分组与排序
  if (isPinnedNavEntry(id)) return false;
  const plugin = getNavEntry(id).plugin;
  if (!plugin) return true;
  return plugins[plugin] !== false;
}

function NavLink({
  id,
  icon,
  pathname,
  actionOpen,
  onMenu,
}: {
  id: NavEntryId;
  icon?: NavIconId;
  pathname: string;
  actionOpen?: boolean;
  onMenu: (el: HTMLElement) => void;
}) {
  const entry = getNavEntry(id);
  const active = pathHas(pathname, entry.match);
  return (
    <div
      className={[navItemClass(active), actionOpen ? 'is-action-open' : '']
        .filter(Boolean)
        .join(' ')}
      data-plugin-nav={entry.plugin}
    >
      <a href={joinHref(entry.href)} className="tw-nav-item-main">
        <EntryIcon id={id} icon={icon} />
        <span className="tw-nav-label">{t(entry.i18n as I18nKey)}</span>
      </a>
      <button
        type="button"
        className="tw-nav-hover-btn"
        aria-label={t('nav.more')}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(e.currentTarget);
        }}
      >
        <MoreIcon />
      </button>
    </div>
  );
}

function groupBranchActive(group: NavMenuGroup, groups: NavMenuGroup[], pathname: string): boolean {
  if (
    group.items.some((id) => {
      if (isPinnedNavEntry(id)) return false;
      const plugin = getNavEntry(id).plugin;
      return (!plugin || isPluginEnabled(plugin)) && pathHas(pathname, getNavEntry(id).match);
    })
  ) {
    return true;
  }
  return listChildGroups(groups, group.id).some((child) =>
    groupBranchActive(child, groups, pathname),
  );
}

function groupHasVisible(group: NavMenuGroup, groups: NavMenuGroup[]): boolean {
  if (
    group.items.some((id) => {
      if (isPinnedNavEntry(id)) return false;
      const plugin = getNavEntry(id).plugin;
      return !plugin || isPluginEnabled(plugin);
    })
  ) {
    return true;
  }
  return listChildGroups(groups, group.id).some((child) => groupHasVisible(child, groups));
}

function NavGroupFolder({
  group,
  groups,
  order,
  icons,
  pathname,
  openItem,
  openGroupId,
  onMenu,
  onItemMenu,
}: {
  group: NavMenuGroup;
  groups: NavMenuGroup[];
  order: NavOrderKey[];
  icons: Record<NavEntryId, NavIconId>;
  pathname: string;
  openItem?: NavEntryId;
  openGroupId?: string;
  onMenu: (group: NavMenuGroup, el: HTMLElement) => void;
  onItemMenu: (id: NavEntryId, el: HTMLElement) => void;
}) {
  const visibleItems = group.items.filter((id) => {
    if (isPinnedNavEntry(id)) return false;
    const plugin = getNavEntry(id).plugin;
    return !plugin || isPluginEnabled(plugin);
  });
  const children = orderedChildGroups(groups, group.id, order);
  const active = groupBranchActive(group, groups, pathname);
  const [open, setOpen] = useState(() => readGroupOpen(group.id, true));
  /** 收起动画进行中：此时再点一下可以立刻收回（重新展开），不会出现「点了没反应」 */
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const closeEndHandler = useRef<((ev: TransitionEvent) => void) | null>(null);

  // 卸载时摘掉「收起结束」监听，避免回调落在已卸载组件上
  useEffect(() => clearCloseWatch, []);

  if (!groupHasVisible(group, groups)) return null;

  /** 摘掉「收起结束」的监听与兜底定时器：中途重新展开时必须调用，否则旧回调会把组又收回去 */
  function clearCloseWatch() {
    if (closeEndHandler.current && panelRef.current) {
      panelRef.current.removeEventListener('transitionend', closeEndHandler.current);
    }
    closeEndHandler.current = null;
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function expand() {
    clearCloseWatch();
    writeGroupOpen(group.id, true);
    setClosing(false);
    setOpen(true);
  }

  function toggle(e: MouseEvent) {
    e.preventDefault();
    // 已展开（含正在收起）：重置为展开，不吞点击
    if (!open || closing) {
      expand();
      return;
    }
    setClosing(true);
    writeGroupOpen(group.id, false);
    const panel = panelRef.current;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearCloseWatch();
      setOpen(false);
      setClosing(false);
    };
    const onEnd = (ev: TransitionEvent) => {
      if (ev.target !== panel) return;
      if (ev.propertyName !== 'grid-template-rows') return;
      finish();
    };
    clearCloseWatch();
    closeEndHandler.current = onEnd;
    panel?.addEventListener('transitionend', onEnd);
    closeTimer.current = window.setTimeout(finish, 360);
  }

  return (
    <details
      className={`tw-nav-details ${closing ? 'is-closing' : ''}`}
      open={open || closing}
      data-nav-group={group.id}
    >
      <summary
        className={[
          'tw-nav-item tw-nav-summary',
          active ? 'is-branch-active' : '',
          openGroupId === group.id ? 'is-action-open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={toggle}
      >
        <FolderIcons />
        <span className="tw-nav-label min-w-0 flex-1 truncate">{displayGroupName(group)}</span>
        <button
          type="button"
          className="tw-nav-hover-btn"
          aria-label={t('nav.groupActions')}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMenu(group, e.currentTarget);
          }}
        >
          <SlidersIcon />
        </button>
        <svg
          className="tw-nav-chevron opacity-70"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          aria-hidden
        >
          <path d="M7 5l6 5-6 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="tw-nav-subtree-anim" ref={panelRef}>
        <div className="tw-nav-subtree">
          {visibleItems.map((id) => (
            <NavLink
              key={id}
              id={id}
              icon={icons[id]}
              pathname={pathname}
              actionOpen={openItem === id}
              onMenu={(el) => onItemMenu(id, el)}
            />
          ))}
          {children.map((child) => (
            <NavGroupFolder
              key={child.id}
              group={child}
              groups={groups}
              order={order}
              icons={icons}
              pathname={pathname}
              openItem={openItem}
              openGroupId={openGroupId}
              onMenu={onMenu}
              onItemMenu={onItemMenu}
            />
          ))}
        </div>
      </div>
    </details>
  );
}

interface Draft {
  id?: string;
  name: string;
  items: NavEntryId[];
  parentId?: string;
}

function GroupEditor({
  open,
  draft,
  groups,
  plugins,
  icons,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  draft: Draft | null;
  groups: NavMenuGroup[];
  plugins: Record<string, boolean>;
  icons: Record<NavEntryId, NavIconId>;
  onClose: () => void;
  onSave: (draft: Draft) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState('');
  const [items, setItems] = useState<NavEntryId[]>([]);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // 已经在其它分组的菜单不再列出；编辑分组时保留本组自己的项
  const ownedElsewhere = new Set(groups.filter((g) => g.id !== draft?.id).flatMap((g) => g.items));
  const catalog = NAV_ENTRIES.filter(
    (e) => entryVisible(e.id, plugins) && (!ownedElsewhere.has(e.id) || items.includes(e.id)),
  );
  const drag = usePointerReorder(items, setItems);

  useEffect(() => {
    if (!open || !draft) return;
    setName(draft.name);
    setItems(draft.items.filter((id) => entryVisible(id, plugins)));
    setError('');
    const tmr = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => window.clearTimeout(tmr);
  }, [open, draft, plugins]);

  function toggle(id: NavEntryId) {
    setItems((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('nav.groupNameRequired'));
      return;
    }
    if (!items.length) {
      setError(t('nav.groupItemsRequired'));
      return;
    }
    const hiddenKept = (draft?.items ?? []).filter((id) => !entryVisible(id, plugins));
    onSave({
      id: draft?.id,
      name: trimmed,
      items: [...hiddenKept, ...items],
      parentId: draft?.parentId,
    });
  }

  const listed = [
    ...items
      .map((id) => catalog.find((e) => e.id === id))
      .filter((e): e is (typeof NAV_ENTRIES)[number] => Boolean(e)),
    ...catalog.filter((e) => !items.includes(e.id)),
  ];

  return (
    <Dialog open={open} onClose={onClose} transition className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="tw-confirm-dialog tw-dialog-panel-anim w-full max-w-sm rounded-xl shadow-xl border border-stone-200 p-5 bg-white"
        >
          <DialogTitle className="tw-confirm-title text-base font-semibold text-stone-900">
            {draft?.id
              ? t('nav.editGroupTitle')
              : draft?.parentId
                ? t('nav.addSubgroup')
                : t('nav.createGroup')}
          </DialogTitle>
          <label className="tw-confirm-msg mt-4 block text-xs font-medium text-stone-500">
            {t('nav.groupName')}
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              className="mt-1.5 w-full h-9 rounded-lg border border-stone-200 px-3 text-sm text-stone-800 outline-none focus:ring-2 focus:ring-[#4176e6]/30 focus:border-[#4176e6]"
            />
          </label>
          <div className="mt-4">
            <div className="text-xs font-medium text-stone-500">{t('nav.groupItems')}</div>
            <p className="mt-1 text-[11px] text-stone-400">{t('nav.groupItemsHint')}</p>
            <div
              ref={drag.listRef}
              className="mt-2 max-h-52 overflow-auto rounded-lg border border-stone-200 p-1"
            >
              {listed.map((entry) => {
                const checked = items.includes(entry.id);
                return (
                  <label
                    key={entry.id}
                    data-sort-key={checked ? entry.id : undefined}
                    className={[
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm text-stone-700 cursor-pointer hover:bg-stone-50',
                      checked ? 'tw-nav-drag-row' : '',
                      drag.dragId === entry.id ? 'is-dragging' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onPointerDown={
                      checked
                        ? (e) => {
                            if ((e.target as HTMLElement).closest('input')) return;
                            drag.onPointerDown(entry.id, e);
                          }
                        : undefined
                    }
                  >
                    {checked ? <GripIcon /> : <span className="tw-nav-drag-grip" />}
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(entry.id)}
                      className="rounded border-stone-300 text-[#4176e6] focus:ring-[#4176e6]/40"
                    />
                    <span className="tw-nav-editor-ico">
                      <EntryIcon id={entry.id} icon={icons[entry.id]} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{t(entry.i18n as I18nKey)}</span>
                  </label>
                );
              })}
              {listed.length ? null : (
                <div className="px-3 py-4 text-center text-[12px] text-stone-400">
                  {t('nav.noAddableItems')}
                </div>
              )}
            </div>
          </div>
          {error ? <p className="mt-2 text-[12px] text-red-600">{error}</p> : null}
          <div className="mt-5 flex items-center gap-2">
            {draft?.id && onDelete ? (
              <button
                type="button"
                onClick={onDelete}
                className="h-8 px-3 text-sm rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
              >
                {t('nav.deleteGroup')}
              </button>
            ) : null}
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="tw-confirm-cancel h-8 px-3 text-sm rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-100"
            >
              {t('nav.groupCancel')}
            </button>
            <button
              type="button"
              onClick={submit}
              className="h-8 px-3 text-sm rounded-lg text-white bg-[#4176e6] hover:bg-[#3566d0]"
            >
              {t('nav.groupSave')}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function SortRows<T extends string>({
  ids,
  labelOf,
  onChange,
  onEnd,
  indent,
}: {
  ids: readonly T[];
  labelOf: (id: T) => string;
  onChange: (next: T[]) => void;
  onEnd?: () => void;
  indent?: boolean;
}) {
  const drag = usePointerReorder(ids, onChange, onEnd);
  return (
    <div ref={drag.listRef} className="flex flex-col">
      {ids.map((id) => (
        <div
          key={id}
          data-sort-key={id}
          className={[
            'tw-nav-drag-row px-3 py-2 text-sm text-stone-700 hover:bg-stone-50',
            indent ? 'tw-nav-drag-row--nested' : '',
            drag.dragId === id ? 'is-dragging' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onPointerDown={(e) => drag.onPointerDown(id, e)}
        >
          <GripIcon />
          <span className="min-w-0 flex-1 truncate">{labelOf(id)}</span>
        </div>
      ))}
    </div>
  );
}

function SortMenuDialog({
  open,
  focusGroupId,
  nodes,
  groups,
  order,
  visible,
  onClose,
  onCommit,
  onChildCommit,
}: {
  open: boolean;
  focusGroupId?: string | null;
  nodes: NavRenderNode[];
  groups: NavMenuGroup[];
  order: NavOrderKey[];
  /** 插件关闭的菜单项不参与排序（侧栏里本来就看不到） */
  visible?: (id: NavEntryId) => boolean;
  onClose: () => void;
  onCommit: (keys: NavOrderKey[], nextGroups: NavMenuGroup[]) => void;
  /** 子分组顺序单独提交：它只在父组内生效，不占侧栏顶层位置 */
  onChildCommit: (parentId: string, childIds: string[]) => void;
}) {
  const isVisible = (id: NavEntryId) => (visible ? visible(id) : true);
  // 只有子分组、自己没有菜单项的分组也要出现在顶层排序里
  const branchVisible = (group: NavMenuGroup): boolean =>
    group.items.some(isVisible) ||
    groups.filter((g) => g.parentId === group.id).some((child) => branchVisible(child));
  const shownNodes = nodes.filter((node) =>
    node.type === 'item' ? isVisible(node.id) : branchVisible(node.group),
  );
  const [keys, setKeys] = useState<NavOrderKey[]>(() => shownNodes.map(nodeOrderKey));
  const [itemOrders, setItemOrders] = useState<Record<string, NavEntryId[]>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, [...g.items]])),
  );
  const [childIds, setChildIds] = useState<string[]>([]);

  const keysRef = useRef(keys);
  keysRef.current = keys;
  const itemOrdersRef = useRef(itemOrders);
  itemOrdersRef.current = itemOrders;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const orderRef = useRef(order);
  orderRef.current = order;
  const nodesRef = useRef(shownNodes);
  nodesRef.current = shownNodes;
  const childIdsRef = useRef(childIds);
  childIdsRef.current = childIds;

  const commit = () => {
    const nextGroups = groupsRef.current.map((g) => ({
      ...g,
      items: itemOrdersRef.current[g.id] ?? g.items,
    }));
    onCommit(keysRef.current, nextGroups);
  };

  const commitChildren = () => {
    if (focusGroupId) onChildCommit(focusGroupId, childIdsRef.current);
  };

  // 只在弹层打开时用当前状态初始化；否则每次拖动后的重渲染都会把顺序重置回去
  useEffect(() => {
    if (!open) return;
    const nextKeys = nodesRef.current.map(nodeOrderKey);
    keysRef.current = nextKeys;
    setKeys(nextKeys);
    const nextItems = Object.fromEntries(groupsRef.current.map((g) => [g.id, [...g.items]]));
    itemOrdersRef.current = nextItems;
    setItemOrders(nextItems);
    const nextChild = focusGroupId
      ? orderedChildGroups(groupsRef.current, focusGroupId, orderRef.current).map((g) => g.id)
      : [];
    childIdsRef.current = nextChild;
    setChildIds(nextChild);
  }, [open, focusGroupId]);

  const changeKeys = (next: NavOrderKey[]) => {
    keysRef.current = next;
    setKeys(next);
  };

  const changeChildIds = (next: string[]) => {
    childIdsRef.current = next;
    setChildIds(next);
  };

  const changeItems = (groupId: string, next: NavEntryId[]) => {
    // 关闭插件的菜单项不显示，但分组关系要保留：排序时把它们接在可见项后面
    const current = itemOrdersRef.current[groupId] ?? [];
    const hidden = current.filter((id) => !isVisible(id));
    const all = {
      ...itemOrdersRef.current,
      [groupId]: next.length ? [...next, ...hidden] : hidden,
    };
    itemOrdersRef.current = all;
    setItemOrders(all);
  };

  const labels = new Map(shownNodes.map((n) => [nodeOrderKey(n), nodeLabel(n)]));
  const focusGroup = focusGroupId ? groups.find((g) => g.id === focusGroupId) : undefined;
  const focusVisible = focusGroup
    ? (itemOrders[focusGroup.id] ?? focusGroup.items).filter(isVisible)
    : [];
  const childList = focusGroup ? orderedChildGroups(groups, focusGroup.id, order) : [];
  // 拖过之后以本地状态为准；首次渲染时回退到当前顺序
  const childRows = childIds.length ? childIds : childList.map((g) => g.id);

  return (
    <Dialog open={open} onClose={onClose} transition className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="tw-confirm-dialog tw-dialog-panel-anim w-full max-w-sm rounded-xl shadow-xl border border-stone-200 p-5 bg-white"
        >
          <DialogTitle className="tw-confirm-title text-base font-semibold text-stone-900">
            {t('nav.sortMenuTitle')}
          </DialogTitle>
          <p className="mt-1 text-[11px] text-stone-400">{t('nav.sortHint')}</p>
          <div className="mt-4 max-h-80 overflow-auto rounded-lg border border-stone-200 p-1">
            {focusGroup ? (
              <>
                <SortRows
                  ids={focusVisible}
                  labelOf={(id) => t(getNavEntry(id).i18n as I18nKey)}
                  onChange={(next) => changeItems(focusGroup.id, next)}
                  onEnd={commit}
                  indent
                />
                {childRows.length ? (
                  <>
                    <div className="mt-1 border-t border-stone-100 px-3 pb-1 pt-2 text-[11px] font-medium text-stone-400">
                      {t('nav.subgroups')}
                    </div>
                    <SortRows
                      ids={childRows}
                      labelOf={(id) => {
                        const g = groups.find((x) => x.id === id);
                        return g ? displayGroupName(g) : id;
                      }}
                      onChange={changeChildIds}
                      onEnd={commitChildren}
                      indent
                    />
                  </>
                ) : null}
              </>
            ) : (
              <SortRows
                ids={keys}
                labelOf={(key) => labels.get(key) ?? key}
                onChange={changeKeys}
                onEnd={commit}
              />
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

type Picker =
  | { kind: 'assign'; itemId: NavEntryId; rect: DOMRect }
  | { kind: 'itemMenu'; itemId: NavEntryId; rect: DOMRect }
  | { kind: 'groupMenu'; group: NavMenuGroup; rect: DOMRect };

function assignGroupRows(
  groups: NavMenuGroup[],
  order: NavOrderKey[],
): { group: NavMenuGroup; indent: boolean }[] {
  const rows: { group: NavMenuGroup; indent: boolean }[] = [];
  for (const g of groups.filter((x) => !x.parentId)) {
    rows.push({ group: g, indent: false });
    for (const child of orderedChildGroups(groups, g.id, order)) {
      rows.push({ group: child, indent: true });
    }
  }
  return rows;
}

function ChevronRightIcon() {
  return (
    <svg
      className="tw-nav-group-pop-arrow"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden
    >
      <path d="M7 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 弹层进退场时长（ms）：与 global.css 里 .tw-nav-group-pop 的动画保持一致 */
const POP_ANIM_MS = 120;

/**
 * 弹层「在场」状态：关闭时先保留 DOM 播完退场动画再卸载。
 * 返回的 value 在退场期间仍是旧值，closing 为 true。
 */
function usePopPresence<T>() {
  const [state, setState] = useState<{ value: T; closing: boolean } | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const open = useCallback(
    (value: T) => {
      clearTimer();
      setState({ value, closing: false });
    },
    [clearTimer],
  );

  const close = useCallback(() => {
    clearTimer();
    setState((cur) => (cur && !cur.closing ? { ...cur, closing: true } : cur));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setState(null);
    }, POP_ANIM_MS);
  }, [clearTimer]);

  const closeNow = useCallback(() => {
    clearTimer();
    setState(null);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { value: state?.value ?? null, closing: !!state?.closing, open, close, closeNow };
}

/** 指针进出弹层的可靠判定：mouseover / mouseout 都是原生事件，portal 里也照常触发 */
function hoverHandlers(onEnter?: () => void, onLeave?: () => void) {
  return {
    onMouseOver: () => onEnter?.(),
    onMouseOut: (e: MouseEvent<HTMLElement>) => {
      const to = e.relatedTarget as Node | null;
      if (to && e.currentTarget.contains(to)) return;
      onLeave?.();
    },
  };
}

/** 二级弹窗：贴着「选择图标」那一行展开，父级菜单保持打开 */
function IconSubmenu({
  anchor,
  current,
  itemId,
  closing,
  onPick,
  onHoverEnter,
  onHoverLeave,
}: {
  anchor: DOMRect;
  current: NavIconId;
  itemId: NavEntryId;
  closing: boolean;
  onPick: (icon: NavIconId) => void;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.top, left: anchor.right + 8 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // 与父菜单齐边（不留空隙，鼠标可以直接移进来）
    let left = anchor.right + 8;
    let top = anchor.top - 6;
    if (left + w > window.innerWidth - 8) left = Math.max(8, anchor.left - w - 6);
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    if (top < 8) top = 8;
    setPos({ top, left });
  }, [anchor]);

  // 挂到 body：父菜单的 overflow 与入场缩放都不会裁到它
  return createPortal(
    <div
      ref={ref}
      className={['tw-nav-group-pop', 'tw-nav-icon-pop', closing ? 'is-closing' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ top: pos.top, left: pos.left }}
      {...hoverHandlers(onHoverEnter, onHoverLeave)}
    >
      <div className="tw-nav-group-pop-head">{t('nav.chooseIcon')}</div>
      <div className="tw-nav-icon-grid">
        {NAV_ICON_IDS.map((icon) => (
          <button
            key={icon}
            type="button"
            className={['tw-nav-icon-cell', current === icon ? 'is-current' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => onPick(icon)}
          >
            <EntryIcon id={itemId} icon={icon} />
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function AnchorMenu({
  rect,
  closing = false,
  onClose,
  onHoverEnter,
  onHoverLeave,
  children,
}: {
  rect: DOMRect;
  closing?: boolean;
  onClose: () => void;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: rect.top, left: rect.right + 6 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = rect.right + 6;
    let top = rect.top;
    if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - w - 6);
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    setPos({ top, left });
  }, [rect]);

  useEffect(() => {
    const onDoc = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (ref.current?.contains(target)) return;
      // 二级图标弹窗挂在 body 上，点它不算「点外面」
      if (target?.closest?.('.tw-nav-icon-pop')) return;
      // 触发按钮自己负责 toggle，避免「先关再开」闪一下
      if (target?.closest?.('.tw-nav-hover-btn')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={['tw-nav-group-pop', closing ? 'is-closing' : ''].filter(Boolean).join(' ')}
      style={{ top: pos.top, left: pos.left }}
      {...hoverHandlers(onHoverEnter, onHoverLeave)}
    >
      {children}
    </div>,
    document.body,
  );
}

export default function NavLibraries() {
  const pathname = usePathname();
  const [groups, setGroups] = useState<NavMenuGroup[]>(() => listNavGroups());
  const [icons, setIcons] = useState<Record<NavEntryId, NavIconId>>(() => listNavIcons());
  const [order, setOrder] = useState<NavOrderKey[]>(() => listNavOrder());
  const [plugins, setPlugins] = useState<Record<string, boolean>>(() => loadPluginEnabled());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [sortGroupId, setSortGroupId] = useState<string | null>(null);
  const pickerPop = usePopPresence<Picker>();
  const iconPop = usePopPresence<{ itemId: NavEntryId; rect: DOMRect }>();
  const picker = pickerPop.value;
  const iconPane = iconPop.value;
  /** 二级菜单关闭的缓冲：鼠标从父菜单移到图标卡片的空隙里不算离开 */
  const iconCloseTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (iconCloseTimer.current !== null) window.clearTimeout(iconCloseTimer.current);
    },
    [],
  );

  function openSort(groupId: string | null) {
    setSortGroupId(groupId);
    setSortOpen(true);
  }

  function openEditor(next: Draft) {
    setDraft(next);
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
    setDeleteId(null);
  }

  useEffect(() => {
    let alive = true;
    const off = onPluginEnabledChanged((map) => {
      setPlugins({ ...map });
    });
    void hydrateAppConfig().then(async () => {
      if (!alive) return;
      // 分组以空间里的文件夹为准（整份空间拷来也能还原）
      await hydrateNavLayout();
      if (!alive) return;
      setGroups(listNavGroups());
      setOrder(listNavOrder());
      setIcons(listNavIcons());
      setPlugins(loadPluginEnabled());
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const nodes = buildNavRenderList(groups, order);

  function persist(nextGroups: NavMenuGroup[], nextOrder: readonly string[]) {
    const saved = saveNavLayout(nextGroups, nextOrder);
    setGroups(saved.groups);
    setOrder(saved.order);
    // 同步成空间文件夹；遇到重名目录时服务端会改名，回来后按规范结果再落一次
    void syncNavGroupsToDisk(saved.groups).then((canonical) => {
      if (!canonical || JSON.stringify(canonical) === JSON.stringify(saved.groups)) return;
      const fixed = saveNavLayout(canonical, saved.order);
      setGroups(fixed.groups);
      setOrder(fixed.order);
    });
  }

  /** 关闭所有弹层（含二级图标卡片），统一走退场动画 */
  function closePops() {
    cancelIconClose();
    iconPop.close();
    pickerPop.close();
  }

  function cancelIconClose() {
    if (iconCloseTimer.current !== null) {
      window.clearTimeout(iconCloseTimer.current);
      iconCloseTimer.current = null;
    }
  }

  function scheduleIconClose() {
    cancelIconClose();
    iconCloseTimer.current = window.setTimeout(() => {
      iconCloseTimer.current = null;
      iconPop.close();
    }, 220);
  }

  function openIcons(itemId: NavEntryId, el: HTMLElement) {
    cancelIconClose();
    iconPop.open({ itemId, rect: el.getBoundingClientRect() });
  }

  function openItemMenu(itemId: NavEntryId, el: HTMLElement) {
    if (picker?.kind === 'itemMenu' && picker.itemId === itemId) {
      closePops();
      return;
    }
    iconPop.closeNow();
    pickerPop.open({ kind: 'itemMenu', itemId, rect: el.getBoundingClientRect() });
  }

  function openGroupMenu(group: NavMenuGroup, el: HTMLElement) {
    if (picker?.kind === 'groupMenu' && picker.group.id === group.id) {
      closePops();
      return;
    }
    iconPop.closeNow();
    pickerPop.open({ kind: 'groupMenu', group, rect: el.getBoundingClientRect() });
  }

  function assignToGroup(groupId: string, itemId: NavEntryId) {
    persist(addItemToGroup(groups, groupId, itemId), order);
    closePops();
  }

  function leaveGroup(itemId: NavEntryId) {
    const { groups: next, owner } = removeItemFromGroup(groups, itemId);
    persist(next, owner ? orderAfterLeaveGroup(order, itemId, owner, next) : order);
    closePops();
  }

  const openItem =
    picker?.kind === 'assign' || picker?.kind === 'itemMenu' ? picker.itemId : undefined;
  const openGroupId = picker?.kind === 'groupMenu' ? picker.group.id : undefined;
  const itemMenu = picker?.kind === 'itemMenu' ? picker : null;
  const groupMenu = picker?.kind === 'groupMenu' ? picker : null;
  const assignMenu = picker?.kind === 'assign' ? picker : null;
  const itemOwner = itemMenu
    ? (groups.find((g) => g.items.includes(itemMenu.itemId)) ?? null)
    : null;

  return (
    <>
      {/* 空标记：所有菜单都关掉时岛屿渲染为空，占位骨架要靠它判断「已挂载」 */}
      <span className="tw-nav-ready" aria-hidden="true" />
      {nodes.map((node) => {
        if (node.type === 'item') {
          if (!entryVisible(node.id, plugins)) return null;
          return (
            <NavLink
              key={node.id}
              id={node.id}
              icon={icons[node.id]}
              pathname={pathname}
              actionOpen={openItem === node.id}
              onMenu={(el) => openItemMenu(node.id, el)}
            />
          );
        }
        return (
          <NavGroupFolder
            key={node.group.id}
            group={node.group}
            groups={groups}
            order={order}
            icons={icons}
            pathname={pathname}
            openItem={openItem}
            openGroupId={openGroupId}
            onMenu={openGroupMenu}
            onItemMenu={openItemMenu}
          />
        );
      })}
      {itemMenu ? (
        <AnchorMenu
          rect={itemMenu.rect}
          closing={pickerPop.closing}
          onClose={closePops}
          onHoverEnter={cancelIconClose}
          onHoverLeave={scheduleIconClose}
        >
          <div className="tw-nav-group-pop-head">
            {t(getNavEntry(itemMenu.itemId).i18n as I18nKey)}
          </div>
          <div
            className="tw-nav-group-pop-list"
            onMouseOver={(e) => {
              // 移到别的菜单行就收起图标卡片（图标那行自己维持打开）
              const row = (e.target as HTMLElement).closest('.tw-nav-group-pop-item');
              if (row && row.getAttribute('data-submenu') !== 'icons') {
                cancelIconClose();
                iconPop.close();
              }
            }}
          >
            {itemOwner ? (
              <button
                type="button"
                className="tw-nav-group-pop-item is-leave"
                onClick={() => leaveGroup(itemMenu.itemId)}
              >
                <PopLeaveIcon />
                <span className="tw-nav-group-pop-name">{t('nav.leaveGroup')}</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="tw-nav-group-pop-item"
                  onClick={() =>
                    pickerPop.open({
                      kind: 'assign',
                      itemId: itemMenu.itemId,
                      rect: itemMenu.rect,
                    })
                  }
                >
                  <PopFolderIcon />
                  <span className="tw-nav-group-pop-name">{t('nav.assignGroup')}</span>
                </button>
                <button
                  type="button"
                  className="tw-nav-group-pop-item"
                  onClick={() => {
                    const itemId = itemMenu.itemId;
                    closePops();
                    openEditor({ name: '', items: [itemId] });
                  }}
                >
                  <span className="tw-nav-group-pop-ico">
                    <PlusIcon />
                  </span>
                  <span className="tw-nav-group-pop-name">{t('nav.addToGroup')}</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="tw-nav-group-pop-item"
              onClick={() => {
                const ownerId = itemOwner?.id ?? null;
                closePops();
                openSort(ownerId);
              }}
            >
              <span className="tw-nav-group-pop-ico">
                <SortArrowsIcon />
              </span>
              <span className="tw-nav-group-pop-name">{t('nav.sortMenu')}</span>
            </button>
            <button
              type="button"
              className="tw-nav-group-pop-item"
              data-submenu="icons"
              onMouseEnter={(e) => openIcons(itemMenu.itemId, e.currentTarget)}
              onClick={(e) => openIcons(itemMenu.itemId, e.currentTarget)}
            >
              <PopIconIcon />
              <span className="tw-nav-group-pop-name">{t('nav.chooseIcon')}</span>
              <ChevronRightIcon />
            </button>
          </div>
        </AnchorMenu>
      ) : null}
      {iconPane && itemMenu && iconPane.itemId === itemMenu.itemId ? (
        <IconSubmenu
          anchor={iconPane.rect}
          itemId={iconPane.itemId}
          current={icons[iconPane.itemId]}
          closing={iconPop.closing}
          onHoverEnter={cancelIconClose}
          onHoverLeave={scheduleIconClose}
          onPick={(icon) => {
            setIcons(setNavIcon(iconPane.itemId, icon));
            closePops();
          }}
        />
      ) : null}
      {groupMenu ? (
        <AnchorMenu rect={groupMenu.rect} closing={pickerPop.closing} onClose={closePops}>
          <div className="tw-nav-group-pop-head">{displayGroupName(groupMenu.group)}</div>
          <div className="tw-nav-group-pop-list">
            {groupMenu.group.parentId ? null : (
              <button
                type="button"
                className="tw-nav-group-pop-item is-create"
                onClick={() => {
                  const parentId = groupMenu.group.id;
                  closePops();
                  openEditor({ name: '', items: [], parentId });
                }}
              >
                <span className="tw-nav-group-pop-ico">
                  <PlusIcon />
                </span>
                <span className="tw-nav-group-pop-name">{t('nav.addSubgroup')}</span>
              </button>
            )}
            <button
              type="button"
              className="tw-nav-group-pop-item"
              onClick={() => {
                const g = groupMenu.group;
                closePops();
                // 顶层分组排的是整个侧栏（分组之间）；子分组只排同一父组内的相对顺序
                openSort(g.parentId ?? null);
              }}
            >
              <span className="tw-nav-group-pop-ico">
                <SortArrowsIcon />
              </span>
              <span className="tw-nav-group-pop-name">{t('nav.sortMenu')}</span>
            </button>
            <button
              type="button"
              className="tw-nav-group-pop-item"
              onClick={() => {
                const g = groupMenu.group;
                closePops();
                openEditor({ id: g.id, name: g.name, items: [...g.items], parentId: g.parentId });
              }}
            >
              <span className="tw-nav-group-pop-ico">
                <SlidersIcon />
              </span>
              <span className="tw-nav-group-pop-name">{t('nav.editGroupTitle')}</span>
            </button>
          </div>
        </AnchorMenu>
      ) : null}
      {assignMenu ? (
        <AnchorMenu rect={assignMenu.rect} closing={pickerPop.closing} onClose={closePops}>
          <div className="tw-nav-group-pop-head">{t('nav.assignGroup')}</div>
          <div className="tw-nav-group-pop-list">
            {groups.length ? (
              assignGroupRows(groups, order).map(({ group: g, indent }) => {
                const current = g.items.includes(assignMenu.itemId);
                return (
                  <button
                    key={g.id}
                    type="button"
                    className={[
                      'tw-nav-group-pop-item',
                      current ? 'is-current' : '',
                      indent ? 'is-child' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (!current) assignToGroup(g.id, assignMenu.itemId);
                    }}
                  >
                    <PopFolderIcon />
                    <span className="tw-nav-group-pop-name">{displayGroupName(g)}</span>
                    {current ? (
                      <span className="tw-nav-group-pop-tag">{t('nav.currentGroup')}</span>
                    ) : null}
                  </button>
                );
              })
            ) : (
              <div className="tw-nav-group-pop-empty">{t('nav.noGroups')}</div>
            )}
          </div>
        </AnchorMenu>
      ) : null}
      <GroupEditor
        open={editorOpen && !deleteId}
        draft={draft}
        groups={groups}
        plugins={plugins}
        icons={icons}
        onClose={closeEditor}
        onSave={(next) => {
          const saved = upsertNavGroup(groups, next);
          persist(saved.groups, orderAfterUpsert(order, saved.groups, saved.id));
          closeEditor();
        }}
        onDelete={draft?.id ? () => setDeleteId(draft.id!) : undefined}
      />
      <SortMenuDialog
        open={sortOpen}
        focusGroupId={sortGroupId}
        nodes={nodes}
        groups={groups}
        order={order}
        visible={(id) => entryVisible(id, plugins)}
        onClose={() => setSortOpen(false)}
        onCommit={(keys, nextGroups) => {
          // 顶层排序弹层里没有子分组：把它们的 key 原样带上，保住各自父组内的顺序
          const childKeys = order.filter((k) => isChildGroupKey(k, nextGroups));
          persist(nextGroups, [...keys, ...childKeys.filter((k) => !keys.includes(k))]);
        }}
        onChildCommit={(parentId, childIds) =>
          persist(groups, orderAfterChildReorder(order, groups, parentId, childIds))
        }
      />
      <ConfirmDialog
        open={Boolean(deleteId)}
        title={t('nav.deleteGroup')}
        message={
          groups.find((g) => g.id === deleteId)?.parentId
            ? t('nav.deleteSubgroupMsg')
            : t('nav.deleteGroupMsg')
        }
        confirmLabel={t('nav.deleteGroup')}
        cancelLabel={t('nav.groupCancel')}
        danger="outline"
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (deleteId) {
            const removed = groups.find((g) => g.id === deleteId);
            const kids = childGroupIds(groups, deleteId);
            const next = removeNavGroup(groups, deleteId);
            persist(next, removed ? orderAfterRemove(order, removed, next, kids) : order);
          }
          closeEditor();
        }}
      />
    </>
  );
}
