/**
 * 知识库管理：平铺列表（子目录仅作路径分类，不呈现目录树）+ 生成入库。
 *
 * 表格 / 搜索 / 排序 / 分页复用 DocsFileBrowser，与用例、提示词管理同源。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { docRootLabelPath } from '../../lib/doc-roots';
import { readDocsListCache, writeDocsListCache } from '../../lib/docs-list-cache';
import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  deleteDocs,
  fetchDocsHealth,
  listDocs,
  openDocsFile,
  type DocsEntry,
} from '../../lib/project-docs';
import { openDocsInChatSession } from '../../lib/open-docs-in-session';
import { hydrateSessionStore } from '../../lib/sessions';
import ConfirmDialog from './ConfirmDialog';
import DocsFileBrowser, { useDocsList } from './DocsFileBrowser';

/** 每页条数默认值（可在分页条切换，选择会被记住） */
const DEFAULT_PAGE_SIZE = 10;

/** 递归收集 .md 文件（顺序交给列表层的排序处理） */
async function walkKnowledgeFiles(dir = '.'): Promise<DocsEntry[]> {
  const { entries } = await listDocs('knowledge', dir);
  const files: DocsEntry[] = [];
  for (const e of entries) {
    if (e.type === 'file') {
      if (e.name.endsWith('.md')) files.push(e);
    } else {
      files.push(...(await walkKnowledgeFiles(e.path)));
    }
  }
  return files;
}

interface Props {
  staticCount?: number;
  base: string;
}

type DeleteTarget = { kind: 'one'; entry: DocsEntry } | { kind: 'batch'; paths: string[] } | null;

export default function KnowledgeLibrary({ staticCount = 0, base }: Props) {
  const boot = readDocsListCache('knowledge');
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  const [live, setLive] = useState<boolean | null>(boot ? true : null);
  const [files, setFiles] = useState<DocsEntry[]>(() => boot ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);

  const list = useDocsList(files, DEFAULT_PAGE_SIZE, 'knowledge');

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const listed = await walkKnowledgeFiles('.');
      setFiles(listed);
      writeDocsListCache('knowledge', listed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => setPluginOn(Boolean(map.knowledgeLib)));
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('knowledgeLib'));
      setPluginReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchDocsHealth('knowledge');
      if (!ok) {
        setLive(false);
        return;
      }
      await hydrateSessionStore().catch(() => null);
      await refresh();
      setLive(true);
    })();
  }, [pluginReady, pluginOn, refresh]);

  const selectedPaths = useMemo(() => Object.keys(selected).filter((p) => selected[p]), [selected]);

  function goGenerate() {
    if (!isPluginEnabled('knowledgeGen')) {
      setError(pluginDisabledMessage('knowledgeGen'));
      return;
    }
    window.location.href = `${base}?plugin=knowledgeGen`;
  }

  async function onOpenLocal(entry: DocsEntry) {
    setBusy(true);
    setError(null);
    try {
      await openDocsFile('knowledge', entry.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openInSession(entry: DocsEntry) {
    setBusy(true);
    setError(null);
    try {
      await openDocsInChatSession('knowledge', entry);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'one') {
        await deleteDocs('knowledge', target.entry.path);
      } else {
        for (const p of target.paths) {
          await deleteDocs('knowledge', p);
        }
        setSelected({});
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const deleteMessage =
    deleteTarget?.kind === 'one'
      ? `删除「${deleteTarget.entry.name}」？将从 ${docRootLabelPath('knowledge')} 中移除。`
      : deleteTarget?.kind === 'batch'
        ? `确认删除已选中的 ${deleteTarget.paths.length} 个知识库文件？此操作不可恢复。`
        : '';

  if (!pluginReady) {
    return (
      <div
        className="rounded-xl border border-stone-200 bg-white overflow-hidden flex flex-col min-h-0"
        aria-busy="true"
        aria-label="正在读取插件开关"
      >
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <span className="tw-lib-spin" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!pluginOn) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        {pluginDisabledMessage('knowledgeLib')}
      </div>
    );
  }

  if (live === null) {
    return (
      <div
        className="rounded-xl border border-stone-200 bg-white overflow-hidden flex flex-col min-h-0"
        aria-busy="true"
        aria-label="正在连接本地文档服务"
      >
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <span className="tw-lib-spin" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!live) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        知识库管理需要本地文档服务，当前未就绪
        {staticCount > 0 ? `（构建期约有 ${staticCount} 份文档可浏览）` : ''}。
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white overflow-hidden flex flex-col min-h-0">
      <div className="shrink-0 px-4 py-3 border-b border-stone-100 flex items-center gap-2 flex-wrap">
        <div className="text-sm text-stone-600 flex-1 min-w-0">
          {list.query.trim() ? (
            <>
              匹配 <span className="font-medium text-stone-800">{list.filtered.length}</span> 个
              <span className="text-stone-400"> · 共 {files.length}</span>
            </>
          ) : (
            <>
              共 <span className="font-medium text-stone-800">{files.length}</span> 个知识库文件
            </>
          )}
          {selectedPaths.length > 0 ? (
            <span className="text-stone-400"> · 已选 {selectedPaths.length}</span>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy || selectedPaths.length === 0}
          onClick={() => setDeleteTarget({ kind: 'batch', paths: selectedPaths })}
          className="h-8 px-3 shrink-0 whitespace-nowrap text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-40"
        >
          批量删除
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={goGenerate}
          className="h-8 px-3 shrink-0 whitespace-nowrap text-sm font-medium text-white bg-[#4176e6] rounded-lg hover:bg-[#3565c7] disabled:opacity-40"
        >
          生成知识库
        </button>
      </div>

      {error ? (
        <div className="shrink-0 mx-4 mt-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
          {error}
        </div>
      ) : null}

      <DocsFileBrowser
        files={files}
        filtered={list.filtered}
        pageFiles={list.pageFiles}
        query={list.query}
        onQuery={list.setQuery}
        sortBy={list.sortBy}
        onSortBy={list.setSortBy}
        page={list.page}
        totalPages={list.totalPages}
        pageSize={list.pageSize}
        onPage={list.setPage}
        onPageSize={list.setPageSize}
        busy={busy}
        emptyText="暂无知识库文件，点击「生成知识库」前往我的工作台。"
        searchPlaceholder="搜索文件名或路径…"
        selected={selected}
        onToggleRow={(path) => setSelected((m) => ({ ...m, [path]: !m[path] }))}
        onSelectPage={(paths, value) =>
          setSelected((m) => {
            const next = { ...m };
            for (const p of paths) {
              if (value) next[p] = true;
              else delete next[p];
            }
            return next;
          })
        }
        onRowDoubleClick={(f) => void onOpenLocal(f)}
        renderBadge={(f) => {
          // 子目录名作为分类徽标（仅知识库有这个标记）
          const cat = f.path.includes('/') ? f.path.split('/')[0] : '';
          return cat ? (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-100">
              {cat}
            </span>
          ) : null;
        }}
        renderActions={(f) => (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void openInSession(f)}
              className="text-xs whitespace-nowrap text-white bg-[#4176e6] px-2 py-1 rounded hover:bg-[#3565c7] cursor-pointer disabled:opacity-40"
            >
              在会话中打开
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeleteTarget({ kind: 'one', entry: f })}
              className="text-xs whitespace-nowrap text-red-600 hover:bg-red-50 px-2 py-1 rounded cursor-pointer disabled:opacity-40"
            >
              删除
            </button>
          </>
        )}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        title={deleteTarget?.kind === 'batch' ? '批量删除' : '删除知识库文件'}
        message={deleteMessage}
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
