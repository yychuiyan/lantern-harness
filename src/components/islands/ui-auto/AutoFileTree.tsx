/**
 * 项目目录树（只读）：根目录一次加载，展开子目录时按需拉取。
 * 忽略规则由服务端统一处理（node_modules / test-results / playwright-report 等）。
 */
import { useCallback, useEffect, useState } from 'react';

import { fetchTree, type TreeEntry } from '../../../lib/ui-auto';

interface Props {
  projectId: string;
  selectedPath: string;
  onOpenFile: (path: string) => void;
}

const ROW =
  'flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs text-stone-700 hover:bg-stone-100';

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="12"
      height="12"
      fill="currentColor"
      className={`shrink-0 text-stone-400 transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M7.21 5.23a.75.75 0 0 1 1.06-.02l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 1 1-1.04-1.08L10.67 10 7.19 6.29a.75.75 0 0 1 .02-1.06Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${open ? 'text-[#3370ff]' : 'text-stone-400'}`}
      aria-hidden="true"
    >
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2h7.8A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-stone-400"
      aria-hidden="true"
    >
      <path d="M7 3.5h6.5L18 8v12.5H7Z" />
      <path d="M13.5 3.5V8H18" />
    </svg>
  );
}

export default function AutoFileTree({ projectId, selectedPath, onOpenFile }: Props) {
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');

  const load = useCallback(
    async (dir: string) => {
      setLoading((prev) => new Set(prev).add(dir));
      try {
        const tree = await fetchTree(projectId, dir, 1);
        setChildren((prev) => ({ ...prev, [dir]: tree.entries }));
        if (tree.truncated) setError('目录条目过多，仅显示前 2000 项');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
      }
    },
    [projectId],
  );

  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    setError('');
    void load('');
  }, [projectId, load]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!children[dir]) void load(dir);
      }
      return next;
    });
  };

  const renderEntries = (dir: string, level: number) => {
    const entries = children[dir] ?? [];
    return entries.map((entry) => {
      const isDir = entry.type === 'dir';
      const open = expanded.has(entry.path);
      const pad = 8 + level * 14;
      if (isDir) {
        return (
          <div key={entry.path}>
            <button
              type="button"
              className={ROW}
              style={{ paddingLeft: pad }}
              onClick={() => toggle(entry.path)}
              aria-expanded={open}
            >
              <Chevron open={open} />
              <FolderIcon open={open} />
              <span className="truncate">{entry.name}</span>
              {loading.has(entry.path) ? (
                <span className="ml-auto text-[10px] text-stone-400">…</span>
              ) : null}
            </button>
            {open ? renderEntries(entry.path, level + 1) : null}
          </div>
        );
      }
      return (
        <button
          key={entry.path}
          type="button"
          className={`${ROW} ${selectedPath === entry.path ? 'bg-[#e1eaff] text-[#1f4ec2]' : ''}`}
          style={{ paddingLeft: pad + 14 }}
          onClick={() => onOpenFile(entry.path)}
        >
          <FileIcon />
          <span className="truncate">{entry.name}</span>
        </button>
      );
    });
  };

  return (
    <div className="min-h-0 overflow-auto py-1">
      {error ? <p className="px-2 py-1 text-[11px] text-red-500">{error}</p> : null}
      {children[''] === undefined ? (
        <p className="px-2 py-1 text-xs text-stone-400">加载中…</p>
      ) : children['']?.length ? (
        renderEntries('', 0)
      ) : (
        <p className="px-2 py-1 text-xs text-stone-400">目录为空</p>
      )}
    </div>
  );
}
