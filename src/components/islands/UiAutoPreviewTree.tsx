/**
 * 骨架文件清单的目录树组件：新建项目预览与「生成过程」弹窗共用。
 *
 * 数据来自平铺的 `{ path, bytes }`（服务端只返回路径与体积），
 * 折叠状态由调用方持有（按全路径记，重新渲染不会丢）。
 */
import { buildPreviewTree, subtreeStats, type PreviewNode } from '../../lib/ui-auto-scaffold-tree';
import { PmIcon } from './PmShared';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function UiAutoPreviewTree({
  nodes,
  depth = 0,
  collapsed,
  onToggle,
}: {
  nodes: PreviewNode[];
  depth?: number;
  collapsed: Record<string, boolean>;
  onToggle: (path: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => {
        const stats = subtreeStats(node);
        const folded = node.dir && Boolean(collapsed[node.path]);
        return (
          <li key={node.path}>
            {node.dir ? (
              <button
                type="button"
                onClick={() => onToggle(node.path)}
                className="flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-xs transition-colors hover:bg-[var(--tw-session-hover-bg)]"
                style={{ paddingLeft: 8 + depth * 14 }}
              >
                <PmIcon
                  name={folded ? 'chevronRight' : 'chevronDown'}
                  size={12}
                  className="shrink-0 text-[var(--tw-label-tertiary)]"
                />
                <PmIcon
                  name="folder"
                  size={13}
                  className="shrink-0 text-[var(--tw-label-secondary)]"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--tw-label-primary)]">
                  {node.name}/
                </span>
                <span className="shrink-0 tabular-nums text-[var(--tw-label-tertiary)]">
                  {stats.changed ? (
                    <span className="mr-1.5 text-amber-600">{stats.changed} 处变更</span>
                  ) : null}
                  {stats.files} 个 · {formatBytes(stats.bytes)}
                </span>
              </button>
            ) : (
              <div
                className="flex items-center gap-2 rounded-md py-1 pr-2 text-xs transition-colors hover:bg-[var(--tw-session-hover-bg)]"
                style={{ paddingLeft: 8 + depth * 14 + 18 }}
              >
                <PmIcon
                  name="file"
                  size={13}
                  className="shrink-0 text-[var(--tw-label-tertiary)]"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--tw-label-primary)]">
                  {node.name}
                </span>
                {node.status === 'new' ? (
                  <span className="shrink-0 rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">
                    新增
                  </span>
                ) : node.status === 'changed' ? (
                  <span className="shrink-0 rounded bg-amber-50 px-1 text-[10px] text-amber-700">
                    更新
                  </span>
                ) : null}
                <span className="shrink-0 tabular-nums text-[var(--tw-label-tertiary)]">
                  {formatBytes(node.bytes)}
                </span>
              </div>
            )}
            {node.dir && !folded && node.children.length ? (
              <UiAutoPreviewTree
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** 全展开 / 全收起：只收目录节点（文件不参与折叠） */
export function dirPathsOf(nodes: PreviewNode[]): string[] {
  const out: string[] = [];
  const walk = (list: PreviewNode[]) => {
    for (const node of list) {
      if (!node.dir) continue;
      out.push(node.path);
      if (node.children.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export { buildPreviewTree, subtreeStats };
export type { PreviewNode };
