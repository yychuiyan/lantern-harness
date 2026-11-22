/**
 * 生成 Tab 左侧项目文件树：浏览项目目录，点文件回调打开。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { listProjectFiles, type UiProjectFileNode } from '../../lib/ui-auto-files';
import { PmIcon } from './PmShared';

/** 同级：文件夹在上、文件在下，各自按名字排序 */
function sortTreeNodes(nodes: UiProjectFileNode[]): UiProjectFileNode[] {
  return [...nodes]
    .map((node) =>
      node.dir && node.children?.length
        ? { ...node, children: sortTreeNodes(node.children) }
        : node,
    )
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, 'en');
    });
}

function filterTree(nodes: UiProjectFileNode[], q: string): UiProjectFileNode[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return sortTreeNodes(nodes);
  const out: UiProjectFileNode[] = [];
  for (const node of nodes) {
    if (node.dir) {
      const kids = filterTree(node.children || [], needle);
      if (kids.length || node.name.toLowerCase().includes(needle)) {
        out.push({ ...node, children: kids });
      }
    } else if (
      node.name.toLowerCase().includes(needle) ||
      node.path.toLowerCase().includes(needle)
    ) {
      out.push(node);
    }
  }
  return sortTreeNodes(out);
}

/** 默认展开：根级全部展开；tests / pages / .lantern-ai 也展开 */
function isDefaultFolderOpen(path: string, depth: number): boolean {
  return (
    depth === 0 ||
    path === 'tests' ||
    path === 'pages' ||
    path === '.lantern-ai' ||
    path.startsWith('.lantern-ai/')
  );
}

function TreeNodes({
  nodes,
  depth,
  collapsed,
  activePath,
  dirtyPaths,
  onToggle,
  onOpen,
}: {
  nodes: UiProjectFileNode[];
  depth: number;
  collapsed: Record<string, boolean>;
  activePath: string;
  dirtyPaths: Set<string>;
  /** 传入当前是否收起，避免默认展开规则与 toggle 不一致要点两次 */
  onToggle: (path: string, currentlyFolded: boolean) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <ul className="space-y-0">
      {nodes.map((node) => {
        const isFolded = node.dir
          ? collapsed[node.path] === undefined
            ? !isDefaultFolderOpen(node.path, depth)
            : Boolean(collapsed[node.path])
          : false;
        const dirty = !node.dir && dirtyPaths.has(node.path);
        const active = !node.dir && activePath === node.path;
        return (
          <li key={node.path}>
            {node.dir ? (
              <button
                type="button"
                className="flex w-full items-center gap-1 rounded-md py-0.5 pr-1 text-left text-[11px] text-(--tw-label-secondary) hover:bg-(--tw-session-hover-bg)"
                style={{ paddingLeft: 6 + depth * 12 }}
                onClick={() => onToggle(node.path, isFolded)}
              >
                <PmIcon
                  name={isFolded ? 'chevronRight' : 'chevronDown'}
                  size={11}
                  className="shrink-0 text-(--tw-label-tertiary)"
                />
                <PmIcon name="folder" size={12} className="shrink-0 text-(--tw-label-tertiary)" />
                <span className="min-w-0 flex-1 truncate font-mono">{node.name}/</span>
              </button>
            ) : (
              <button
                type="button"
                className={`flex w-full items-center gap-1 rounded-md py-0.5 pr-1 text-left text-[11px] hover:bg-(--tw-session-hover-bg) ${
                  active
                    ? 'bg-(--tw-session-selected-bg) text-[#4176e6]'
                    : 'text-(--tw-label-secondary)'
                }`}
                style={{ paddingLeft: 6 + depth * 12 + 16 }}
                onClick={() => onOpen(node.path)}
              >
                <PmIcon name="file" size={12} className="shrink-0 text-(--tw-label-tertiary)" />
                <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
                {dirty ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
              </button>
            )}
            {node.dir && !isFolded && node.children?.length ? (
              <TreeNodes
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                activePath={activePath}
                dirtyPaths={dirtyPaths}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export default function UiAutoProjectFiles({
  projectId,
  activePath,
  dirtyPaths,
  onOpenFile,
  refreshKey = 0,
}: {
  projectId: string;
  activePath: string;
  dirtyPaths: Set<string>;
  onOpenFile: (path: string) => void;
  refreshKey?: number;
}) {
  const [tree, setTree] = useState<UiProjectFileNode[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    const res = await listProjectFiles(projectId);
    setLoading(false);
    if (!res.ok) {
      setError(res.error || '读取失败');
      setTree([]);
      return;
    }
    setTree(res.tree || []);
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const visible = useMemo(() => filterTree(tree, filter), [tree, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--tw-surface-panel)">
      <div className="flex items-center gap-1 border-b border-(--tw-border) px-2 py-1.5">
        <span className="text-[11px] font-medium text-(--tw-label-secondary)">项目文件</span>
        <button
          type="button"
          className="ml-auto rounded px-1 text-[11px] text-(--tw-label-tertiary) hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-secondary)"
          onClick={() => void reload()}
          disabled={loading}
        >
          刷新
        </button>
      </div>
      <div className="px-2 py-1">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤…"
          className="tw-input h-7 w-full px-2 text-[11px]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {error ? (
          <p className="px-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
            {error}
          </p>
        ) : null}
        {!error && !visible.length && !loading ? (
          <p className="px-2 text-[11px] text-(--tw-label-tertiary)">暂无文件</p>
        ) : null}
        <TreeNodes
          nodes={visible}
          depth={0}
          collapsed={collapsed}
          activePath={activePath}
          dirtyPaths={dirtyPaths}
          onToggle={(path, currentlyFolded) =>
            setCollapsed((prev) => ({ ...prev, [path]: !currentlyFolded }))
          }
          onOpen={onOpenFile}
        />
      </div>
    </div>
  );
}
