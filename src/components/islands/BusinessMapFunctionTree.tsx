import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';

import type { BusinessDirectory, BusinessFunction } from '../../lib/business-map';
import {
  businessDirectoryUsesDropdown,
  businessMenuDropPosition,
  businessPromotedFunctionIds,
  organizeBusinessDirectories,
  type BusinessMenuNavigationItem,
} from '../../lib/business-map-view';
import OverflowHint from './OverflowHint';
import { PmIcon } from './PmShared';

interface Props {
  directories: BusinessDirectory[];
  functions: BusinessFunction[];
  query: string;
  menuNavigation?: BusinessMenuNavigationItem[];
  selectedDirectoryId: string;
  selectedFunctionId: string;
  expandedIds: Set<string>;
  onSelectDirectory: (id: string) => void;
  onSelectFunction: (id: string) => void;
  onToggleDirectory: (id: string) => void;
  onCreateDirectory: (parentId: string) => void;
  onRenameDirectory: (directory: BusinessDirectory) => void;
  onCreateFunction: (directoryId: string) => void;
  onDeleteDirectory: (directory: BusinessDirectory) => void;
  onMove: (move: {
    kind: 'directory' | 'function';
    id: string;
    parentId: string;
    beforeId?: string;
    rootMenu?: boolean;
    menuOrder?: number;
  }) => void;
}

interface DragItem {
  kind: 'directory' | 'function';
  id: string;
}

interface DropHint {
  id: string;
  position: 'before' | 'inside' | 'after';
}

function FolderIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

function HomeIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path d="m4 10 8-6.5 8 6.5v9.5H4Z" />
      <path d="M9 20v-6h6v6" />
    </svg>
  );
}

function LeafMenuIcon({ name, className = '' }: { name: string; className?: string }) {
  const normalized = name.replace(/\s+/g, '').toLowerCase();
  if (normalized === '首页') return <HomeIcon className={className} />;
  return (
    <PmIcon
      name={normalized.includes('查询') || normalized.includes('搜索') ? 'search' : 'file'}
      size={15}
      className={className}
    />
  );
}

function directoryPath(directories: BusinessDirectory[], id: string): BusinessDirectory[] {
  const byId = new Map(directories.map((item) => [item.id, item]));
  const path: BusinessDirectory[] = [];
  const visited = new Set<string>();
  let current = byId.get(id);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function normalizedMenuName(value: string) {
  return value.replace(/\s+/g, '').toLowerCase();
}

export default function BusinessMapFunctionTree({
  directories,
  functions,
  query,
  menuNavigation = [],
  selectedDirectoryId,
  selectedFunctionId,
  expandedIds,
  onSelectDirectory,
  onSelectFunction,
  onToggleDirectory,
  onCreateDirectory,
  onRenameDirectory,
  onCreateFunction,
  onDeleteDirectory,
  onMove,
}: Props) {
  const draggedRef = useRef<DragItem | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const term = query.trim().toLowerCase();
  const tree = useMemo(() => organizeBusinessDirectories(directories), [directories]);
  const functionsByDirectory = useMemo(() => {
    const map = new Map<string, BusinessFunction[]>();
    for (const fn of functions) {
      const list = map.get(fn.directoryId) || [];
      list.push(fn);
      map.set(fn.directoryId, list);
    }
    for (const list of map.values())
      list.sort((left, right) => left.order - right.order || left.code.localeCompare(right.code));
    return map;
  }, [functions]);
  const selectedDirectoryPathIds = useMemo(
    () => new Set(directoryPath(directories, selectedDirectoryId).map((directory) => directory.id)),
    [directories, selectedDirectoryId],
  );
  const menuOrderByName = useMemo(() => {
    const ranks = new Map<string, number>();
    for (const item of menuNavigation) {
      const key = normalizedMenuName(item.label.replace(/^\d+\+?\s*/, ''));
      if (!key) continue;
      ranks.set(key, Math.min(ranks.get(key) ?? Number.POSITIVE_INFINITY, item.order));
    }
    return ranks;
  }, [menuNavigation]);
  const promotedFunctionIds = useMemo(
    () => businessPromotedFunctionIds(directories, functions, menuNavigation),
    [directories, functions, menuNavigation],
  );
  function functionMatches(fn: BusinessFunction): boolean {
    if (!term) return true;
    return [fn.code, fn.name, fn.purpose, fn.entry, fn.domain, fn.module]
      .join(' ')
      .toLowerCase()
      .includes(term);
  }

  function directoryMatches(directory: BusinessDirectory): boolean {
    const ownMatches = [directory.name, ...directory.menuPath]
      .join(' ')
      .toLowerCase()
      .includes(term);
    if (!term || ownMatches) return true;
    return (
      (tree.children.get(directory.id) || []).some(directoryMatches) ||
      (functionsByDirectory.get(directory.id) || []).some(functionMatches)
    );
  }

  const rootNodes = [
    ...tree.roots
      .filter(directoryMatches)
      .map((directory) => ({ kind: 'directory' as const, id: directory.id, directory })),
    ...functions
      .filter((fn) => promotedFunctionIds.has(fn.id) && functionMatches(fn))
      .map((fn) => ({ kind: 'function' as const, id: fn.id, fn })),
  ];
  const isHomeNode = (node: (typeof rootNodes)[number]) =>
    node.kind === 'directory' &&
    [node.directory.name, ...node.directory.menuPath].some((name) => name.trim() === '首页');
  const rootNodeName = (node: (typeof rootNodes)[number]) =>
    node.kind === 'directory' ? node.directory.name : node.fn.name;
  const rootNodeMenuOrder = (node: (typeof rootNodes)[number]) =>
    node.kind === 'directory' ? node.directory.menuOrder : node.fn.menuOrder;
  const rootNodeOrder = (node: (typeof rootNodes)[number]) =>
    node.kind === 'directory' ? node.directory.order : node.fn.order;
  const rootNodeRank = (node: (typeof rootNodes)[number]) => {
    const explicit = rootNodeMenuOrder(node);
    if (explicit !== undefined) return explicit;
    return menuOrderByName.get(normalizedMenuName(rootNodeName(node)));
  };
  rootNodes.sort((left, right) => {
    const homeOrder = Number(isHomeNode(right)) - Number(isHomeNode(left));
    if (homeOrder) return homeOrder;
    const leftName = rootNodeName(left);
    const rightName = rootNodeName(right);
    const leftRank = rootNodeRank(left);
    const rightRank = rootNodeRank(right);
    if (leftRank !== undefined || rightRank !== undefined) {
      return (
        (leftRank ?? Number.POSITIVE_INFINITY) - (rightRank ?? Number.POSITIVE_INFINITY) ||
        leftName.localeCompare(rightName, 'zh-CN')
      );
    }
    const leftOrder = rootNodeOrder(left);
    const rightOrder = rootNodeOrder(right);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.kind !== right.kind) return left.kind === 'function' ? -1 : 1;
    return leftName.localeCompare(rightName, 'zh-CN');
  });

  function rootMenuOrderForDrop(
    target: { kind: 'directory' | 'function'; id: string },
    position: 'before' | 'after',
  ) {
    const dragged = draggedRef.current;
    const nodes = rootNodes.filter((node) => node.id !== dragged?.id);
    const targetIndex = nodes.findIndex(
      (node) => node.kind === target.kind && node.id === target.id,
    );
    if (targetIndex < 0) return undefined;
    const positionOf = (node: (typeof nodes)[number], fallbackIndex: number) =>
      rootNodeRank(node) ?? fallbackIndex;
    const targetOrder = positionOf(nodes[targetIndex], targetIndex);
    if (position === 'before') {
      const previous = nodes[targetIndex - 1];
      const previousOrder = previous ? positionOf(previous, targetIndex - 1) : targetOrder - 1;
      return Math.max(0, (previousOrder + targetOrder) / 2);
    }
    const next = nodes[targetIndex + 1];
    const nextOrder = next ? positionOf(next, targetIndex + 1) : targetOrder + 1;
    return Math.max(0, (targetOrder + nextOrder) / 2);
  }

  function dropPosition(event: DragEvent, kind: DragItem['kind']): DropHint['position'] {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
    return businessMenuDropPosition(kind, ratio);
  }

  function handleDrop(
    event: DragEvent,
    target: { kind: 'directory' | 'function'; id: string; parentId: string },
    depth: number,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const item = draggedRef.current;
    const position = dropPosition(event, target.kind);
    draggedRef.current = null;
    setDropHint(null);
    if (!item || item.id === target.id) return;
    if (target.kind === 'function') {
      if (depth === 0) {
        onMove({
          kind: item.kind,
          id: item.id,
          parentId: '',
          ...(item.kind === 'function' ? { rootMenu: true } : {}),
          menuOrder: rootMenuOrderForDrop(target, position === 'before' ? 'before' : 'after'),
        });
        return;
      }
      const siblings = functionsByDirectory.get(target.parentId) || [];
      const index = siblings.findIndex((entry) => entry.id === target.id);
      onMove({
        kind: item.kind,
        id: item.id,
        parentId: target.parentId,
        beforeId: position === 'before' ? target.id : siblings[index + 1]?.id,
      });
      return;
    }
    if (position === 'inside') {
      if (item.kind === 'directory') {
        onMove({ kind: item.kind, id: item.id, parentId: target.id });
      } else {
        onMove({ kind: item.kind, id: item.id, parentId: target.id });
      }
      return;
    }
    const siblings = tree.children.get(target.parentId) || [];
    const index = siblings.findIndex((entry) => entry.id === target.id);
    onMove({
      kind: item.kind,
      id: item.id,
      parentId: depth === 0 ? '' : target.parentId,
      beforeId: position === 'before' ? target.id : siblings[index + 1]?.id,
      ...(depth === 0
        ? {
            ...(item.kind === 'function' ? { rootMenu: true } : {}),
            menuOrder: rootMenuOrderForDrop(target, position === 'before' ? 'before' : 'after'),
          }
        : {}),
    });
  }

  function beginDrag(event: DragEvent, item: DragItem) {
    event.stopPropagation();
    draggedRef.current = item;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${item.kind}:${item.id}`);
  }

  function renderFunction(fn: BusinessFunction, depth: number) {
    const hint = dropHint?.id === fn.id ? dropHint.position : '';
    return (
      <div
        key={fn.id}
        className={`tw-bm-tree-row function ${selectedFunctionId === fn.id ? 'active' : ''} ${hint ? `is-drop-${hint}` : ''}`}
        role="listitem"
        style={{ paddingLeft: `${depth * 16}px` }}
        draggable
        onDragStart={(event) => beginDrag(event, { kind: 'function', id: fn.id })}
        onDragEnd={() => {
          draggedRef.current = null;
          setDropHint(null);
        }}
        onDragOver={(event) => {
          if (!draggedRef.current || draggedRef.current.id === fn.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropHint({ id: fn.id, position: dropPosition(event, 'function') });
        }}
        onDrop={(event) =>
          handleDrop(
            event,
            {
              kind: 'function',
              id: fn.id,
              parentId: fn.directoryId,
            },
            depth,
          )
        }
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropHint(null);
        }}
      >
        <button
          type="button"
          className="tw-bm-tree-select"
          aria-current={selectedFunctionId === fn.id ? 'true' : undefined}
          onClick={() => onSelectFunction(fn.id)}
        >
          <LeafMenuIcon
            name={fn.name}
            className={`tw-bm-tree-leaf-icon ${selectedFunctionId === fn.id ? 'is-selected-path' : ''} ${fn.confirmed ? 'confirmed' : 'ai'}`}
          />
          <OverflowHint text={fn.name} className="tw-bm-tree-label" />
          <small>{fn.code}</small>
        </button>
      </div>
    );
  }

  function renderDirectory(directory: BusinessDirectory, depth: number) {
    if (!directoryMatches(directory)) return null;
    const childDirectories = (tree.children.get(directory.id) || []).filter(directoryMatches);
    const directoryFunctions = functionsByDirectory.get(directory.id) || [];
    const childFunctions = directoryFunctions.filter(
      (fn) =>
        !promotedFunctionIds.has(fn.id) &&
        normalizedMenuName(fn.name) !== normalizedMenuName(directory.name),
    );
    const visibleFunctions = childFunctions.filter(functionMatches);
    const count = directoryFunctions.length + (tree.children.get(directory.id)?.length || 0);
    const isHomeDirectory = [directory.name, ...directory.menuPath].some(
      (name) => name.trim() === '首页',
    );
    const usesDropdown = term
      ? childDirectories.length > 0 || (visibleFunctions.length > 0 && !isHomeDirectory)
      : businessDirectoryUsesDropdown(directory, directories, functions);
    const expanded = term ? true : expandedIds.has(directory.id);
    const hint = dropHint?.id === directory.id ? dropHint.position : '';
    const selectDirectory = () => {
      onSelectDirectory(directory.id);
      if (usesDropdown) onToggleDirectory(directory.id);
    };
    return (
      <div className="tw-bm-tree-branch" key={directory.id}>
        <div
          className={`tw-bm-tree-row directory ${selectedDirectoryId === directory.id ? 'active' : ''} ${hint ? `is-drop-${hint}` : ''}`}
          role="listitem"
          style={{ paddingLeft: `${depth * 16}px` }}
          draggable
          onDragStart={(event) => beginDrag(event, { kind: 'directory', id: directory.id })}
          onDragEnd={() => {
            draggedRef.current = null;
            setDropHint(null);
          }}
          onDragOver={(event) => {
            if (!draggedRef.current || draggedRef.current.id === directory.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropHint({
              id: directory.id,
              position: dropPosition(event, 'directory'),
            });
          }}
          onDrop={(event) =>
            handleDrop(
              event,
              {
                kind: 'directory',
                id: directory.id,
                parentId: directory.parentId,
              },
              depth,
            )
          }
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDropHint(null);
          }}
        >
          <button
            type="button"
            className="tw-bm-tree-select"
            aria-current={selectedDirectoryId === directory.id ? 'true' : undefined}
            aria-expanded={usesDropdown ? expanded : undefined}
            onClick={selectDirectory}
          >
            {usesDropdown ? (
              <FolderIcon
                className={`tw-bm-tree-folder ${selectedDirectoryPathIds.has(directory.id) ? 'is-selected-path' : ''}`}
              />
            ) : (
              <LeafMenuIcon
                name={directory.name}
                className={`tw-bm-tree-leaf-icon ${selectedDirectoryPathIds.has(directory.id) ? 'is-selected-path' : ''}`}
              />
            )}
            <OverflowHint text={directory.name} className="tw-bm-tree-label" />
            <small>({count})</small>
            {usesDropdown ? (
              <PmIcon
                name={expanded ? 'chevronDown' : 'chevronRight'}
                size={13}
                className="tw-bm-tree-chevron"
              />
            ) : null}
          </button>
          <Menu>
            <MenuButton
              type="button"
              className="tw-bm-tree-more"
              aria-label={`目录操作：${directory.name}`}
              onClick={(event) => event.stopPropagation()}
            >
              ⋯
            </MenuButton>
            <MenuItems
              transition
              anchor={{ to: 'bottom end', gap: 4 }}
              className="tw-bm-tree-menu tw-menu-anim"
            >
              <MenuItem as="button" type="button" onClick={() => onCreateDirectory(directory.id)}>
                <PmIcon name="plus" size={14} />
                <span>新建子目录</span>
              </MenuItem>
              <MenuItem as="button" type="button" onClick={() => onCreateFunction(directory.id)}>
                <PmIcon name="file" size={14} />
                <span>新建功能</span>
              </MenuItem>
              <MenuItem as="button" type="button" onClick={() => onRenameDirectory(directory)}>
                <PmIcon name="pencil" size={14} />
                <span>重命名</span>
              </MenuItem>
              <div className="tw-bm-tree-menu-divider" role="separator" />
              <MenuItem
                as="button"
                type="button"
                className="danger"
                onClick={() => onDeleteDirectory(directory)}
              >
                <PmIcon name="trash" size={14} />
                <span>删除目录</span>
              </MenuItem>
            </MenuItems>
          </Menu>
          <span className="sr-only">
            {childDirectories.length} 个子目录，{directoryFunctions.length} 个直属功能
          </span>
        </div>
        {usesDropdown ? (
          <div
            className={`tw-collapse ${expanded ? 'is-open' : ''}`}
            aria-hidden={!expanded}
            inert={!expanded}
          >
            <div className="tw-collapse-inner" role="group">
              {childDirectories.map((child) => renderDirectory(child, depth + 1))}
              {visibleFunctions.map((fn) => renderFunction(fn, depth + 1))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="tw-bm-function-tree" role="list" aria-label="功能目录">
      {rootNodes.map((node) =>
        node.kind === 'directory' ? renderDirectory(node.directory, 0) : renderFunction(node.fn, 0),
      )}
      {!rootNodes.length ? (
        <div className="tw-bm-tree-empty">{term ? '没有匹配的目录' : '还没有功能目录'}</div>
      ) : null}
    </div>
  );
}

export { directoryPath };
