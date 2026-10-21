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
import { showToast } from './Toast';

/** 每页条数默认值（可在分页条切换，选择会被记住） */
const DEFAULT_PAGE_SIZE = 10;

/** Excel/Office 打开文件时留下的临时锁文件（如 ~$xxx.xlsx） */
function isOfficeLockCache(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return base.startsWith('~$') || base.startsWith('.~');
}

async function walkCaseFiles(dir = '.'): Promise<DocsEntry[]> {
  const { entries } = await listDocs('cases', dir);
  const files: DocsEntry[] = [];
  for (const e of entries) {
    if (e.type === 'file') {
      if (!isOfficeLockCache(e.path) && !isOfficeLockCache(e.name)) files.push(e);
    } else {
      files.push(...(await walkCaseFiles(e.path)));
    }
  }
  return files;
}

export default function CasesLibrary() {
  /** 有缓存则首帧直接画列表，避免刷新时探测卡 ↔ 内容卡切换闪一下 */
  const boot = readDocsListCache('cases');
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  const [live, setLive] = useState<boolean | null>(boot ? true : null);
  const [files, setFiles] = useState<DocsEntry[]>(() => boot ?? []);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: 'one'; entry: DocsEntry } | { kind: 'batch'; paths: string[] } | null
  >(null);

  const list = useDocsList(files, DEFAULT_PAGE_SIZE, 'cases');

  const refresh = useCallback(async () => {
    setError(null);
    const listed = await walkCaseFiles('.');
    setFiles(listed);
    writeDocsListCache('cases', listed);
    setSelected((prev) => {
      const next: Record<string, boolean> = {};
      for (const f of listed) {
        if (prev[f.path]) next[f.path] = true;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => setPluginOn(Boolean(map.cases)));
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('cases'));
      setPluginReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchDocsHealth('cases');
      if (!ok) {
        setLive(false);
        return;
      }
      try {
        await hydrateSessionStore().catch(() => null);
        await refresh();
        // 等列表就绪再揭卡，避免「探测 → 空态 → 有数据」连闪两下
        setLive(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLive(true);
      }
    })();
  }, [pluginReady, pluginOn, refresh]);

  const selectedPaths = useMemo(() => Object.keys(selected).filter((p) => selected[p]), [selected]);

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'one') {
        await deleteDocs('cases', target.entry.path);
      } else {
        for (const p of target.paths) {
          await deleteDocs('cases', p);
        }
        setSelected({});
      }
      await refresh();
      showToast(
        target.kind === 'one'
          ? `已删除「${target.entry.name}」`
          : `已删除 ${target.paths.length} 个用例文件`,
        'success',
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  const deleteMessage =
    deleteTarget?.kind === 'one'
      ? `删除「${deleteTarget.entry.name}」？将从 ${docRootLabelPath('cases')} 中移除。`
      : deleteTarget?.kind === 'batch'
        ? `确认删除已选中的 ${deleteTarget.paths.length} 个用例文件？此操作不可恢复。`
        : '';

  function goGenerateCase() {
    if (!isPluginEnabled('caseGen')) {
      setError(pluginDisabledMessage('caseGen'));
      return;
    }
    const base = import.meta.env.BASE_URL || '/';
    window.location.href = `${base}workbench/?plugin=caseGen`;
  }

  async function openInSession(entry: DocsEntry) {
    setBusy(true);
    setError(null);
    try {
      await openDocsInChatSession('cases', entry);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function openLocal(entry: DocsEntry | string) {
    const p = typeof entry === 'string' ? entry : entry.path;
    setError(null);
    try {
      await openDocsFile('cases', p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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
        {pluginDisabledMessage('cases')}
      </div>
    );
  }

  if (live === null) {
    // 外层与正式卡片同壳，避免探测态换成内容态时整卡「跳」一下
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
        用例管理需要本地文档服务，当前未就绪。
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-white overflow-hidden flex flex-col min-h-0">
      <div className="shrink-0 px-4 py-3 border-b border-stone-100 flex items-center gap-2 flex-wrap">
        <div className="text-sm text-stone-600 flex-1 min-w-0">
          {list.query.trim() ? (
            <>
              匹配 <span className="font-medium text-stone-800">{list.filtered.length}</span> 个
              <span className="text-stone-400"> · 共 {files.length}</span>
            </>
          ) : (
            <>
              共 <span className="font-medium text-stone-800">{files.length}</span> 个文件
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
          onClick={goGenerateCase}
          className="h-8 px-3 shrink-0 whitespace-nowrap text-sm font-medium text-white bg-[#4176e6] rounded-lg hover:bg-[#3565c7] disabled:opacity-40"
        >
          生成用例
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
        emptyText="暂无用例文件，点击「生成用例」前往我的工作台。"
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
        onRowDoubleClick={(f) => void openLocal(f)}
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
        title={deleteTarget?.kind === 'batch' ? '批量删除' : '删除用例文件'}
        message={deleteMessage}
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
