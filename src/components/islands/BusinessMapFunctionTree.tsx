import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';

import type { BusinessDirectory, BusinessFunction } from '../../lib/business-map';
import OverflowHint from './OverflowHint';
import { PmIcon } from './PmShared';

interface Props {
  directories: BusinessDirectory[];
  functions: BusinessFunction[];
  query: string;
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

function FolderIcon({ className = '', open = false }: { className?: string; open?: boolean }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      {open ? (
        <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      )}
    </svg>
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

export default function BusinessMapFunctionTree({
  directories,
  functions,
  query,
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
  const [dragged, setDragged] = useState<DragItem | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const term = query.trim().toLowerCase();
  const byParent = useMemo(() => {
    const map = new Map<string, BusinessDirectory[]>();
    for (const directory of directories) {
      const list = map.get(directory.parentId) || [];
      list.push(directory);
      map.set(directory.parentId, list);
    }
    for (const [parentId, list] of map) {
      list.sort((left, right) => {
        if (!parentId) {
          const leftHome = [left.name, ...left.menuPath].some((name) => name.trim() === '首页');
          const rightHome = [right.name, ...right.menuPath].some((name) => name.trim() === '首页');
          if (leftHome !== rightHome) return leftHome ? -1 : 1;
        }
        return left.order - right.order || left.name.localeCompare(right.name);
      });
    }
    return map;
  }, [directories]);
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
  const selectedDirectoryPathIds = useMemo(() => {
    const selectedFunction = functions.find((fn) => fn.id === selectedFunctionId);
    if (!selectedFunction?.directoryId) return new Set<string>();
    return new Set(
      directoryPath(directories, selectedFunction.directoryId).map((directory) => directory.id),
    );
  }, [directories, functions, selectedFunctionId]);

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
      (byParent.get(directory.id) || []).some(directoryMatches) ||
      (functionsByDirectory.get(directory.id) || []).some(functionMatches)
    );
  }

  function dropPosition(event: DragEvent, kind: DragItem['kind']): DropHint['position'] {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
    if (kind === 'directory' && ratio > 0.28 && ratio < 0.72) return 'inside';
    return ratio < 0.5 ? 'before' : 'after';
  }

  function handleDrop(
    event: DragEvent,
    target: { kind: 'directory' | 'function'; id: string; parentId: string },
  ) {
    event.preventDefault();
    event.stopPropagation();
    const item = dragged;
    const position = dropPosition(event, target.kind);
    setDragged(null);
    setDropHint(null);
    if (!item || item.id === target.id) return;
    if (target.kind === 'function') {
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
    const siblings = byParent.get(target.parentId) || [];
    const index = siblings.findIndex((entry) => entry.id === target.id);
    onMove({
      kind: item.kind,
      id: item.id,
      parentId: target.parentId,
      beforeId: position === 'before' ? target.id : siblings[index + 1]?.id,
    });
  }

  function renderDirectory(directory: BusinessDirectory, depth: number): ReactNode {
    if (!directoryMatches(directory)) return null;
    const childDirectories = byParent.get(directory.id) || [];
    const childFunctions = (functionsByDirectory.get(directory.id) || []).filter(functionMatches);
    const count = childDirectories.length + childFunctions.length;
    const hasChildren = count > 0;
    const expanded = term ? true : expandedIds.has(directory.id);
    const hint = dropHint?.id === directory.id ? dropHint.position : '';
    const toggleDirectory = () => {
      onSelectDirectory(directory.id);
      if (hasChildren) onToggleDirectory(directory.id);
    };
    return (
      <div className="tw-bm-tree-branch" key={directory.id}>
        <div
          className={`tw-bm-tree-row directory ${hint ? `is-drop-${hint}` : ''}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          role="treeitem"
          aria-expanded={hasChildren ? expanded : undefined}
          tabIndex={0}
          draggable
          onDragStart={(event) => {
            event.stopPropagation();
            setDragged({ kind: 'directory', id: directory.id });
            event.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(event) => {
            if (!dragged || dragged.id === directory.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropHint({
              id: directory.id,
              position: dropPosition(event, 'directory'),
            });
          }}
          onDrop={(event) =>
            handleDrop(event, {
              kind: 'directory',
              id: directory.id,
              parentId: directory.parentId,
            })
          }
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDropHint(null);
          }}
          onClick={toggleDirectory}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggleDirectory();
            }
            if (event.key === 'ArrowRight' && hasChildren && !expanded)
              onToggleDirectory(directory.id);
            if (event.key === 'ArrowLeft' && hasChildren && expanded)
              onToggleDirectory(directory.id);
          }}
        >
          <FolderIcon
            className={`tw-bm-tree-folder ${selectedDirectoryPathIds.has(directory.id) ? 'is-selected-path' : ''}`}
            open={hasChildren && expanded}
          />
          <OverflowHint text={directory.name} className="tw-bm-tree-label" />
          <small>({count})</small>
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
        </div>
        <div
          className={`tw-collapse ${expanded ? 'is-open' : ''}`}
          aria-hidden={!expanded}
          inert={!expanded}
        >
          <div className="tw-collapse-inner" role="group">
            {childDirectories.map((child) => renderDirectory(child, depth + 1))}
            {childFunctions.map((fn) => {
              const hint = dropHint?.id === fn.id ? dropHint.position : '';
              return (
                <div
                  key={fn.id}
                  className={`tw-bm-tree-row function ${selectedFunctionId === fn.id ? 'active' : ''} ${hint ? `is-drop-${hint}` : ''}`}
                  style={{ paddingLeft: `${36 + (depth + 1) * 16}px` }}
                  role="treeitem"
                  tabIndex={0}
                  draggable
                  onDragStart={(event) => {
                    event.stopPropagation();
                    setDragged({ kind: 'function', id: fn.id });
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(event) => {
                    if (!dragged || dragged.id === fn.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDropHint({ id: fn.id, position: dropPosition(event, 'function') });
                  }}
                  onDrop={(event) =>
                    handleDrop(event, {
                      kind: 'function',
                      id: fn.id,
                      parentId: fn.directoryId,
                    })
                  }
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      setDropHint(null);
                  }}
                  onClick={() => onSelectFunction(fn.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectFunction(fn.id);
                    }
                  }}
                >
                  <span className={`tw-bm-tree-dot ${fn.confirmed ? 'confirmed' : 'ai'}`} />
                  <OverflowHint text={fn.name} className="tw-bm-tree-label" />
                  <small>{fn.code}</small>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  const roots = (byParent.get('') || []).filter(directoryMatches);
  const rootFunctions = (functionsByDirectory.get('') || []).filter(functionMatches);
  const orphanFunctions = functions.filter(
    (fn) =>
      functionMatches(fn) &&
      (!fn.directoryId || !directories.some((directory) => directory.id === fn.directoryId)),
  );
  return (
    <div className="tw-bm-function-tree" role="tree" aria-label="功能目录树">
      {roots.map((directory) => renderDirectory(directory, 0))}
      {rootFunctions.map((fn) => (
        <div
          key={fn.id}
          className={`tw-bm-tree-row function root ${selectedFunctionId === fn.id ? 'active' : ''}`}
          role="treeitem"
          tabIndex={0}
          onClick={() => onSelectFunction(fn.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelectFunction(fn.id);
            }
          }}
        >
          <span className={`tw-bm-tree-dot ${fn.confirmed ? 'confirmed' : 'ai'}`} />
          <OverflowHint text={fn.name} className="tw-bm-tree-label" />
          <small>{fn.code}</small>
        </div>
      ))}
      {orphanFunctions
        .filter((fn) => !rootFunctions.some((item) => item.id === fn.id))
        .map((fn) => (
          <div
            key={fn.id}
            className={`tw-bm-tree-row function root ${selectedFunctionId === fn.id ? 'active' : ''}`}
            role="treeitem"
            tabIndex={0}
            onClick={() => onSelectFunction(fn.id)}
          >
            <span className={`tw-bm-tree-dot ${fn.confirmed ? 'confirmed' : 'ai'}`} />
            <OverflowHint text={`${fn.name}（未归档）`} className="tw-bm-tree-label" />
            <small>{fn.code}</small>
          </div>
        ))}
      {!roots.length && !rootFunctions.length && !orphanFunctions.length ? (
        <div className="tw-bm-tree-empty">{term ? '没有匹配的目录或功能' : '还没有功能目录'}</div>
      ) : null}
    </div>
  );
}

export { directoryPath };
