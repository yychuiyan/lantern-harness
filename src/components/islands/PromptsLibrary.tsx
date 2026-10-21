import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { docRootLabelPath } from '../../lib/doc-roots';
import { readDocsListCache, writeDocsListCache } from '../../lib/docs-list-cache';
import { readMountedPromptsCache, writeMountedPromptsCache } from '../../lib/prompt-mount-cache';
import { hydrateAppConfig } from '../../lib/app-config';
import {
  isPluginEnabled,
  loadPluginEnabled,
  onPluginEnabledChanged,
  pluginDisabledMessage,
  getPluginMeta,
  type PluginId,
} from '../../lib/plugins';
import {
  isProtectedPrompt,
  isPluginPromptLocked,
  isPromptLocked,
  isPromptReferenced,
  normalizePromptPath,
  promptLockedReason,
  promptOwnerKind,
  promptOwnerPlugin,
} from '../../lib/prompts-meta';
import {
  deleteDocs,
  fetchDocsHealth,
  listDocs,
  openDocsFile,
  parentDirPath,
  readDocsText,
  renameDocs,
  writeDocsText,
  type DocsEntry,
} from '../../lib/project-docs';
import { openDocsInChatSession } from '../../lib/open-docs-in-session';
import { REQ_ANALYSIS_PROMPT_FILE, syncReqPrompt } from '../../lib/req-analysis';
import { fetchReportState } from '../../lib/report-prompt';
import { hydrateSessionStore } from '../../lib/sessions';
import { fetchMountedPromptFiles, onPromptMountsChanged } from '../../lib/ui-auto';
import ConfirmDialog from './ConfirmDialog';
import DocsFileBrowser, { useDocsList } from './DocsFileBrowser';
import NamePromptDialog from './NamePromptDialog';
import { PmIcon } from './PmShared';

/** 每页条数默认值（可在分页条切换，选择会被记住） */
const DEFAULT_PAGE_SIZE = 10;

async function walkPromptFiles(dir = '.'): Promise<DocsEntry[]> {
  const { entries } = await listDocs('prompts', dir);
  const files: DocsEntry[] = [];
  for (const e of entries) {
    if (e.type === 'file') files.push(e);
    else files.push(...(await walkPromptFiles(e.path)));
  }
  return files;
}

type DeleteTarget = { kind: 'one'; entry: DocsEntry } | { kind: 'batch'; paths: string[] } | null;

/**
 * 「关联插件」列：文件名右侧标出这份提示词归哪个插件引用。
 * 系统提示词（默认提示词.md）显示「系统默认」；其它没有关联就显示「未关联」；
 * 插件开着时再补一句「引用中」，说明为什么删不掉。
 *
 * mounted 是插件里实际挂载的提示词（自动化测试项目切到了 pytest提示词.md 这类），
 * 与文件名约定无关，但同样算被该插件引用。
 */
function PromptOwnerCell({
  path,
  enabled,
  mounted,
}: {
  path: string;
  enabled: Record<string, boolean>;
  mounted: Record<string, string>;
}) {
  const owner = promptOwnerKind(path, mounted);
  if (!owner) {
    return <span className="text-[11px] text-stone-400">未关联</span>;
  }
  if (owner === 'system') {
    return <span className="text-[11px] text-stone-600">系统默认</span>;
  }
  const name = getPluginMeta(owner as PluginId)?.name ?? owner;
  const on = enabled[owner] === true;
  // 「引用中」只看真实挂载：一个项目只挂一份，换掉之后上一份立刻不再引用
  const referenced = isPromptReferenced(path, mounted);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate text-[11px] text-stone-600">{name}</span>
      {referenced && on ? (
        <span className="shrink-0 rounded bg-(--tw-accent-soft) px-1 text-[10px] text-(--tw-accent)">
          引用中
        </span>
      ) : null}
    </span>
  );
}

export default function PromptsLibrary() {
  const boot = readDocsListCache('prompts');
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  const [live, setLive] = useState<boolean | null>(boot ? true : null);
  const [files, setFiles] = useState<DocsEntry[]>(() => boot ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  /**
   * 插件开关表：插件开启期间，它维护的提示词不允许删除。
   * 关闭插件后同一份文件就可以删，再打开插件会重新生成种子。
   */
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => loadPluginEnabled());
  /**
   * 被插件实际挂载的提示词：自动化测试项目各挂一份（可能是用户自己建的 pytest提示词.md）。
   * 用来在「关联插件」列标出关联关系，与文件名约定无关。
   * 首帧先用上次算好的挂载表（sessionStorage），否则刷新时「引用中」会先消失再出现。
   */
  const [mounted, setMounted] = useState<Record<string, string>>(() => readMountedPromptsCache());
  /** 改名 / 复制：都走同一个命名弹窗，确认时做重名拦截 */
  const [renameTarget, setRenameTarget] = useState<DocsEntry | null>(null);
  const [copyTarget, setCopyTarget] = useState<DocsEntry | null>(null);
  /** 命名弹窗里的校验提示（重名 / 后端拒绝），关窗即清空 */
  const [nameError, setNameError] = useState('');

  const list = useDocsList(files, DEFAULT_PAGE_SIZE, 'prompts');

  /** 需求分析提示词的自愈只尝试一次，避免接口一直失败时反复请求 */
  const reqSeedTried = useRef(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const listed = await walkPromptFiles('.');
      setFiles(listed);
      writeDocsListCache('prompts', listed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * 需求分析插件开着、但「需求分析提示词.md」不见了（外部删除 / 换空间）：
   * 自动补一份种子再刷新列表，保证「插件开着就一定有这份提示词被引用」。
   */
  useEffect(() => {
    if (!live || enabled.reqAnalysis !== true || reqSeedTried.current) return;
    if (files.some((file) => file.name === REQ_ANALYSIS_PROMPT_FILE)) return;
    reqSeedTried.current = true;
    void syncReqPrompt(true)
      .then(() => refresh())
      .catch(() => undefined);
  }, [live, enabled.reqAnalysis, files, refresh]);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => {
      setPluginOn(Boolean(map.prompts));
      setEnabled(map);
    });
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('prompts'));
      setEnabled(loadPluginEnabled());
      setPluginReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchDocsHealth('prompts');
      if (!ok) {
        setLive(false);
        return;
      }
      await hydrateSessionStore().catch(() => null);
      await refresh();
      setLive(true);
    })();
  }, [pluginReady, pluginOn, refresh]);

  /**
   * 插件**实际挂载**的提示词（与文件名约定无关）：
   * - 自动化测试按项目各挂一份，一个项目只挂一份，换掉后旧的就不再算引用；
   * - 工作汇报是空间级的一份，换了自定义的同样算关联。
   * 读不到时沿用上一次的结果（宁可继续锁着，也别把仍被引用的提示词放开删）。
   */
  const refreshMounted = useCallback(async () => {
    const files = await fetchMountedPromptFiles();
    const reportOn = isPluginEnabled('reports');
    const state = reportOn ? await fetchReportState().catch(() => null) : null;
    setMounted((prev) => {
      const next: Record<string, string> = {};
      if (files) {
        for (const file of files) next[normalizePromptPath(file)] = 'uiAuto';
      } else {
        for (const [path, owner] of Object.entries(prev)) {
          if (owner === 'uiAuto') next[path] = owner;
        }
      }
      if (reportOn) {
        if (state?.promptFile) next[normalizePromptPath(state.promptFile)] = 'reports';
        else {
          for (const [path, owner] of Object.entries(prev)) {
            if (owner === 'reports') next[path] = owner;
          }
        }
      }
      // 需求分析固定只用「需求分析提示词.md」：插件一开就是引用中，没有「换一份」的概念。
      // 与文件名约定一致，但这里显式记一笔，让「引用中」徽标不必依赖挂载表也能亮。
      if (enabled.reqAnalysis) next[normalizePromptPath(REQ_ANALYSIS_PROMPT_FILE)] = 'reqAnalysis';
      writeMountedPromptsCache(next);
      return next;
    });
  }, [enabled.reqAnalysis]);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void refreshMounted();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshMounted();
    };
    document.addEventListener('visibilitychange', onVisible);
    // 自动化测试里挂载 / 换提示词 / 移出项目后立即重算，不用等切页或刷新
    const offMounts = onPromptMountsChanged(() => void refreshMounted());
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      offMounts();
    };
  }, [pluginReady, pluginOn, enabled.uiAuto, enabled.reports, enabled.reqAnalysis, refreshMounted]);

  const selectedPaths = useMemo(() => Object.keys(selected).filter((p) => selected[p]), [selected]);

  /**
   * 被插件实际挂载的提示词（运行时挂载，非文件名约定）锁定：返回插件 id（没有则空串）。
   * 例如自动化测试项目切到用户自己建的 pytest提示词.md，或工作汇报换了一份自定义的。
   * 文件名约定的插件提示词仍走 isPluginPromptLocked。
   */
  const mountLockedBy = useCallback(
    (path: string): string => {
      const owner = promptOwnerKind(path, mounted);
      if (!owner || owner === 'system') return '';
      if (promptOwnerPlugin(path)) return '';
      return enabled[owner] === true ? owner : '';
    },
    [mounted, enabled],
  );

  async function onOpenLocal(entry: DocsEntry) {
    setBusy(true);
    setError(null);
    try {
      await openDocsFile('prompts', entry.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** 在会话中打开：挂路径 chip，方便让 AI 直接改这份提示词 */
  async function openInSession(entry: DocsEntry) {
    setBusy(true);
    setError(null);
    try {
      await openDocsInChatSession('prompts', entry);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function onDelete(entry: DocsEntry) {
    if (isProtectedPrompt(entry.path)) {
      setError('默认提示词不可删除');
      return;
    }
    if (isPluginPromptLocked(entry.path, enabled)) {
      setError(promptLockedReason(entry.path, enabled));
      return;
    }
    const mountOwner = mountLockedBy(entry.path);
    if (mountOwner) {
      const name = getPluginMeta(mountOwner as PluginId)?.name ?? mountOwner;
      setError(`这份提示词正被「${name}」的项目挂载，先在那里换一份再删除`);
      return;
    }
    setDeleteTarget({ kind: 'one', entry });
  }

  /** 改名：默认提示词 / 插件引用中 / 项目挂载中的都不让改，避免生成时读不到 */
  function requestRename(entry: DocsEntry) {
    if (isProtectedPrompt(entry.path)) {
      setError('默认提示词不可改名');
      return;
    }
    if (isPluginPromptLocked(entry.path, enabled)) {
      setError(promptLockedReason(entry.path, enabled));
      return;
    }
    const mountOwner = mountLockedBy(entry.path);
    if (mountOwner) {
      const name = getPluginMeta(mountOwner as PluginId)?.name ?? mountOwner;
      setError(`这份提示词正被「${name}」的项目挂载，先在那里换一份再改名`);
      return;
    }
    setRenameTarget(entry);
    setNameError('');
  }

  /** 复制：任何提示词都能复制（复制出来的是普通文件，不带插件归属） */
  function requestCopy(entry: DocsEntry) {
    setCopyTarget(entry);
    setNameError('');
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'one') {
        await deleteDocs('prompts', target.entry.path);
      } else {
        let skipped = 0;
        for (const p of target.paths) {
          if (isProtectedPrompt(p) || isPluginPromptLocked(p, enabled) || mountLockedBy(p)) {
            skipped += 1;
            continue;
          }
          await deleteDocs('prompts', p);
        }
        if (skipped) {
          setError(`有 ${skipped} 个提示词仍被插件或项目引用，已跳过；先解除引用再删。`);
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

  function goGeneratePrompt() {
    if (!isPluginEnabled('promptGen')) {
      setError(pluginDisabledMessage('promptGen'));
      return;
    }
    const base = import.meta.env.BASE_URL || '/';
    window.location.href = `${base}workbench/?plugin=promptGen`;
  }

  /** 同一目录下是否已有同名文件（大小写不敏感，macOS 上也算重名） */
  const duplicateName = useCallback(
    (dir: string, name: string, selfPath = ''): string => {
      const wanted = (dir === '.' ? name : `${dir}/${name}`).toLowerCase();
      const hit = files.find(
        (f) => f.path.toLowerCase() === wanted && f.path.toLowerCase() !== selfPath.toLowerCase(),
      );
      return hit ? hit.name : '';
    },
    [files],
  );

  async function submitRename(name: string) {
    const target = renameTarget;
    if (!target) return;
    const renamed = name.trim();
    if (!renamed || renamed === target.name) {
      setRenameTarget(null);
      setNameError('');
      return;
    }
    const dup = duplicateName(parentDirPath(target.path), renamed, target.path);
    if (dup) {
      setNameError(`已存在同名文件「${dup}」，换个名字再试`);
      return;
    }
    setBusy(true);
    setNameError('');
    try {
      await renameDocs('prompts', target.path, renamed);
      setRenameTarget(null);
      await refresh();
    } catch (e) {
      setNameError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** 复制一份到同目录（弹出命名，默认「原名（副本）」，重名直接拦下） */
  async function submitCopy(name: string) {
    const target = copyTarget;
    if (!target) return;
    const copied = name.trim();
    if (!copied) return;
    const dup = duplicateName(parentDirPath(target.path), copied);
    if (dup) {
      setNameError(`已存在同名文件「${dup}」，换个名字再试`);
      return;
    }
    setBusy(true);
    setNameError('');
    try {
      const { content } = await readDocsText('prompts', target.path);
      await writeDocsText(
        'prompts',
        parentDirPath(target.path) === '.' ? copied : `${parentDirPath(target.path)}/${copied}`,
        content,
      );
      setCopyTarget(null);
      await refresh();
    } catch (e) {
      setNameError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const deleteMessage =
    deleteTarget?.kind === 'one'
      ? `删除「${deleteTarget.entry.name}」？将从 ${docRootLabelPath('prompts')} 中移除。`
      : deleteTarget?.kind === 'batch'
        ? `确认删除已选中的 ${deleteTarget.paths.length} 个提示词？此操作不可恢复。`
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
        {pluginDisabledMessage('prompts')}
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
        提示词管理需要本地文档服务，当前未就绪。
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
              共 <span className="font-medium text-stone-800">{files.length}</span> 个提示词
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
          onClick={goGeneratePrompt}
          className="h-8 px-3 shrink-0 whitespace-nowrap text-sm font-medium text-white bg-[#4176e6] rounded-lg hover:bg-[#3565c7] disabled:opacity-40"
        >
          生成提示词
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
        emptyText="暂无提示词，点击「生成提示词」前往我的工作台。"
        searchPlaceholder="搜索文件名或路径…"
        selectable={(f) => !isPromptLocked(f.path, enabled) && !mountLockedBy(f.path)}
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
        extraColumn={{
          header: '关联插件',
          className: 'w-32 shrink-0',
          render: (f) => <PromptOwnerCell path={f.path} enabled={enabled} mounted={mounted} />,
        }}
        // 操作列：「在会话中打开」+ 删除图标，同一行不换行
        actionsClassName="w-36 shrink-0"
        // 改名 / 复制：都做成文件名右侧的小图标（悬停高亮），操作列只留打开与删除
        renderNameAction={(f) => (
          <>
            <button
              type="button"
              disabled={busy}
              aria-label={`重命名 ${f.name}`}
              onClick={() => requestRename(f)}
              className="rounded p-1 text-stone-400 transition-colors hover:bg-[#e8f0fe] hover:text-[#4176e6] disabled:opacity-40"
            >
              <PmIcon name="pencil" size={12} />
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label={`复制 ${f.name}`}
              onClick={() => requestCopy(f)}
              className="rounded p-1 text-stone-400 transition-colors hover:bg-[#e8f0fe] hover:text-[#4176e6] disabled:opacity-40"
            >
              <PmIcon name="copy" size={12} />
            </button>
          </>
        )}
        renderActions={(f) => {
          const locked = isPromptLocked(f.path, enabled) || Boolean(mountLockedBy(f.path));
          return (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void openInSession(f)}
                className="inline-flex h-6 items-center whitespace-nowrap rounded bg-[#4176e6] px-2 text-xs text-white hover:bg-[#3565c7] cursor-pointer disabled:opacity-40"
              >
                在会话中打开
              </button>
              <button
                type="button"
                disabled={busy || locked}
                aria-label={`删除 ${f.name}`}
                onClick={() => onDelete(f)}
                className="inline-flex h-6 items-center rounded p-1 text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <PmIcon name="trash" size={12} />
              </button>
            </>
          );
        }}
      />

      <NamePromptDialog
        open={renameTarget != null}
        title="重命名提示词"
        label="文件名称"
        initialValue={renameTarget?.name ?? ''}
        lockExtension
        confirmLabel="保存"
        error={nameError}
        onClose={() => {
          setRenameTarget(null);
          setNameError('');
        }}
        onConfirm={(name) => void submitRename(name)}
      />

      <NamePromptDialog
        open={copyTarget != null}
        title="复制提示词"
        label="新文件名称"
        initialValue={
          copyTarget ? copyTarget.name.replace(/(\.[^.]+)?$/, (ext) => `（副本）${ext}`) : ''
        }
        lockExtension
        confirmLabel="复制"
        error={nameError}
        onClose={() => {
          setCopyTarget(null);
          setNameError('');
        }}
        onConfirm={(name) => void submitCopy(name)}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        title={deleteTarget?.kind === 'batch' ? '批量删除' : '删除提示词'}
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
