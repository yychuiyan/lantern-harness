import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { docRootLabelPath } from '../../lib/doc-roots';
import { readDocsListCache, writeDocsListCache } from '../../lib/docs-list-cache';
import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  deleteDocs,
  fetchDocsHealth,
  listDocs,
  openDocsFile,
  isOfficeLockFile,
  parentDirPath,
  renameDocs,
  uploadDocsFile,
  type DocsEntry,
} from '../../lib/project-docs';
import { isCaseBackupDirName, isCaseBackupFile } from '../../lib/case-backup-ttl';
import { openDocsInChatSession } from '../../lib/open-docs-in-session';
import { hydrateSessionStore } from '../../lib/sessions';
import {
  createCaseReviewBackup,
  fetchCaseReviewEntry,
  fetchCaseReviewSummaries,
  saveCaseReviewEntry,
  type CaseReviewSummary,
} from '../../lib/case-review';
import ConfirmDialog from './ConfirmDialog';
import CaseBackupDrawer, { loadCaseBackupRows } from './CaseBackupDrawer';
import CaseReviewDrawer from './CaseReviewDrawer';
import DocsFileBrowser, { useDocsList } from './DocsFileBrowser';
import NamePromptDialog from './NamePromptDialog';
import { PmIcon } from './PmShared';
import { showToast } from './Toast';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';

/** 每页条数默认值（可在分页条切换，选择会被记住） */
const DEFAULT_PAGE_SIZE = 10;

/** 可上传且评审可读的扩展名（不含 docx：能上传但不能评） */
const CASE_UPLOAD_EXTS = new Set(['.xlsx', '.xls', '.csv', '.md']);
const CASE_UPLOAD_ACCEPT =
  '.xlsx,.xls,.csv,.md,text/csv,text/markdown,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';

function caseUploadExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function isAllowedCaseUpload(name: string): boolean {
  return CASE_UPLOAD_EXTS.has(caseUploadExt(name));
}

/** 写前备份 / 临时文件：不当正式用例列出来 */
function isCaseJunkFile(name: string): boolean {
  const base = name.split(/[/\\]/).pop() || name;
  if (isOfficeLockFile(base)) return true;
  if (isCaseBackupFile(base)) return true;
  if (base.startsWith('~$') || base.endsWith('~')) return true;
  return false;
}

async function walkCaseFiles(dir = '.'): Promise<DocsEntry[]> {
  const { entries } = await listDocs('cases', dir);
  const files: DocsEntry[] = [];
  for (const e of entries) {
    if (e.type === 'file') {
      if (!isCaseJunkFile(e.path) && !isCaseJunkFile(e.name)) files.push(e);
    } else if (!isCaseBackupDirName(e.name) && !isCaseBackupDirName(e.path)) {
      // 「备份列表」文件夹主列表不展示
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
  const [reviewOn, setReviewOn] = useState(false);
  const [blindspotOn, setBlindspotOn] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, CaseReviewSummary>>({});
  /** 路径与是否打开分开记：关抽屉不清路径，切菜单回来还能接上同一份评审 */
  const [reviewPath, setReviewPath] = useState(() => readViewText('caseReview.path'));
  const [reviewOpen, setReviewOpen] = useState(
    () =>
      Boolean(readViewText('caseReview.path')) &&
      readViewPref('caseReview.open', ['0', '1'], '0') === '1',
  );
  const [live, setLive] = useState<boolean | null>(boot ? true : null);
  const [files, setFiles] = useState<DocsEntry[]>(() => boot ?? []);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: 'one'; entry: DocsEntry } | { kind: 'batch'; paths: string[] } | null
  >(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupCount, setBackupCount] = useState(0);
  /** 行内备份：弹窗确认文件名 */
  const [backupTarget, setBackupTarget] = useState<DocsEntry | null>(null);
  const [backupNameError, setBackupNameError] = useState('');
  /** 行内改名 */
  const [renameTarget, setRenameTarget] = useState<DocsEntry | null>(null);
  const [renameNameError, setRenameNameError] = useState('');
  /** 上传：同名覆盖确认前暂存 */
  const [uploadPending, setUploadPending] = useState<File[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useDocsList(files, DEFAULT_PAGE_SIZE, 'cases');

  const refreshBackupCount = useCallback(async () => {
    try {
      const rows = await loadCaseBackupRows();
      setBackupCount(rows.length);
    } catch {
      setBackupCount(0);
    }
  }, []);

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
    void refreshBackupCount();
  }, [refreshBackupCount]);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => {
      setPluginOn(Boolean(map.cases));
      setReviewOn(Boolean(map.caseReview));
      setBlindspotOn(Boolean(map.caseBlindspot));
    });
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('cases'));
      setReviewOn(isPluginEnabled('caseReview'));
      setBlindspotOn(isPluginEnabled('caseBlindspot'));
      setPluginReady(true);
    });
    return off;
  }, []);

  /** 评审摘要：文件行上的「评审」列靠它显示分数 / 补全条数 */
  const loadSummaries = useCallback(async () => {
    if (!reviewOn && !blindspotOn) {
      setSummaries({});
      return;
    }
    try {
      const list = await fetchCaseReviewSummaries();
      setSummaries(Object.fromEntries(list.map((x) => [x.path, x])));
    } catch {
      setSummaries({});
    }
  }, [reviewOn, blindspotOn]);

  useEffect(() => {
    if (!pluginReady || !pluginOn || live === false) return;
    void loadSummaries();
  }, [pluginReady, pluginOn, live, loadSummaries]);

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

  function askBackup(entry: DocsEntry) {
    setBackupNameError('');
    setBackupTarget(entry);
  }

  function askRename(entry: DocsEntry) {
    setRenameNameError('');
    setRenameTarget(entry);
  }

  /** 同一目录下是否已有同名文件（大小写不敏感） */
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

  async function confirmRename(name: string) {
    const target = renameTarget;
    if (!target) return;
    const renamed = name.trim();
    if (!renamed || renamed === target.name) {
      setRenameTarget(null);
      setRenameNameError('');
      return;
    }
    const dup = duplicateName(parentDirPath(target.path), renamed, target.path);
    if (dup) {
      setRenameNameError(`已存在同名文件「${dup}」，换个名字再试`);
      return;
    }
    setBusy(true);
    setError(null);
    setRenameNameError('');
    try {
      const nextPath = await renameDocs('cases', target.path, renamed);
      // 评审报告按路径存：改名后把报告迁到新路径，避免分数挂在旧名上
      if (nextPath !== target.path && (reviewOn || blindspotOn)) {
        try {
          const { entry } = await fetchCaseReviewEntry(target.path);
          if (entry?.review || entry?.blindspot) {
            await saveCaseReviewEntry(nextPath, {
              review: entry.review ?? null,
              blindspot: entry.blindspot ?? null,
            });
            await saveCaseReviewEntry(target.path, { review: null, blindspot: null });
          }
        } catch {
          // 报告迁移失败不挡改名；摘要刷新后旧路径会显示未评审
        }
      }
      if (reviewPath === target.path) {
        setReviewPath(nextPath);
        writeViewText('caseReview.path', nextPath);
      }
      setRenameTarget(null);
      await refresh();
      void loadSummaries();
      showToast(`已重命名为「${renamed}」`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRenameNameError(msg);
      showToast(`重命名失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmBackup(name: string) {
    const entry = backupTarget;
    if (!entry) return;
    setBusy(true);
    setError(null);
    setBackupNameError('');
    try {
      const { name: saved } = await createCaseReviewBackup(entry.path, name);
      setBackupTarget(null);
      showToast(`已备份到备份列表：${saved}`, 'success');
      await refreshBackupCount();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBackupNameError(msg);
      showToast(`备份失败：${msg}`, 'error');
    } finally {
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

  /** 根目录已有同名（大小写不敏感） */
  function rootConflicts(uploadFiles: File[]): string[] {
    const existing = new Set(
      files.filter((f) => parentDirPath(f.path) === '.').map((f) => f.name.toLowerCase()),
    );
    const hit: string[] = [];
    const seen = new Set<string>();
    for (const f of uploadFiles) {
      const key = f.name.toLowerCase();
      if (existing.has(key) && !seen.has(key)) {
        hit.push(f.name);
        seen.add(key);
      }
    }
    return hit;
  }

  async function runUpload(uploadFiles: File[]) {
    if (!uploadFiles.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of uploadFiles) {
        await uploadDocsFile('cases', '.', f);
      }
      await refresh();
      showToast(`已上传 ${uploadFiles.length} 个文件`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`上传失败：${msg}`, 'error');
    } finally {
      setBusy(false);
      setUploadPending(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function onPickUpload(picked: FileList | null) {
    if (!picked?.length) return;
    const all = Array.from(picked);
    const allowed = all.filter((f) => isAllowedCaseUpload(f.name));
    const rejected = all.filter((f) => !isAllowedCaseUpload(f.name));
    if (rejected.length) {
      showToast(
        `已跳过 ${rejected.length} 个不支持的格式（仅 .xlsx / .xls / .csv / .md）`,
        'error',
      );
    }
    if (!allowed.length) {
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    const conflicts = rootConflicts(allowed);
    if (conflicts.length) {
      setUploadPending(allowed);
      return;
    }
    void runUpload(allowed);
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
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={CASE_UPLOAD_ACCEPT}
          className="hidden"
          onChange={(e) => onPickUpload(e.target.files)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => setBackupOpen(true)}
          className="h-8 px-3 shrink-0 whitespace-nowrap text-sm font-medium text-stone-700 border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-40"
        >
          备份列表{backupCount > 0 ? `（${backupCount > 99 ? '99+' : backupCount}）` : ''}
        </button>
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
          onClick={() => fileRef.current?.click()}
          className="h-8 px-3 shrink-0 whitespace-nowrap text-sm font-medium text-stone-700 border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-40"
        >
          上传用例
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
        emptyText="暂无用例文件，可「上传用例」导入本地文件，或点「生成用例」前往工作台。"
        searchPlaceholder="搜索文件名或路径…"
        // 操作列表头与按钮都居中，避免上下错位
        resizeKey="docs:cases:cols:v1"
        extraColumn={
          reviewOn || blindspotOn
            ? {
                header: '评审',
                render: (f) => {
                  const s = summaries[f.path];
                  if (!s) return <span className="text-[11px] text-stone-300">—</span>;
                  const score = s.score;
                  const tone =
                    score == null
                      ? 'text-stone-500'
                      : score >= 85
                        ? 'text-emerald-700'
                        : score >= 60
                          ? 'text-amber-700'
                          : 'text-rose-700';
                  return (
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {score != null ? (
                        /* 纯文字带色，不加边框/底色：胶囊在小列宽里会被压扁、边框还会割裂行视觉 */
                        <span className={`shrink-0 text-[11px] font-medium tabular-nums ${tone}`}>
                          {score} 分
                        </span>
                      ) : (
                        <span className="shrink-0 text-[10px] text-stone-400">未评审</span>
                      )}
                      {s.blindspotCount ? (
                        <span className="shrink-0 text-[10px] text-stone-400">
                          补 {s.blindspotCount}
                        </span>
                      ) : null}
                      {s.stale ? (
                        <span className="shrink-0 text-[10px] text-amber-600">过期</span>
                      ) : null}
                    </span>
                  );
                },
              }
            : undefined
        }
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
        renderNameAction={(f) => (
          <button
            type="button"
            disabled={busy}
            aria-label={`重命名 ${f.name}`}
            onClick={() => askRename(f)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-stone-400 transition-colors hover:bg-[#e8f0fe] hover:text-[#4176e6] disabled:opacity-40"
          >
            <PmIcon name="pencil" size={12} />
          </button>
        )}
        renderActions={(f) => (
          <>
            {reviewOn || blindspotOn ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setReviewPath(f.path);
                  setReviewOpen(true);
                  writeViewText('caseReview.path', f.path);
                  writeViewPref('caseReview.open', '1');
                }}
                className="text-xs whitespace-nowrap text-stone-700 border border-stone-200 px-2 py-1 rounded hover:bg-stone-50 cursor-pointer disabled:opacity-40"
              >
                评审
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => askBackup(f)}
              className="text-xs whitespace-nowrap text-stone-700 border border-stone-200 px-2 py-1 rounded hover:bg-stone-50 cursor-pointer disabled:opacity-40"
            >
              备份
            </button>
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

      <ConfirmDialog
        open={uploadPending != null}
        title="覆盖同名文件"
        message={
          uploadPending
            ? `以下文件已存在于用例管理根目录，继续将覆盖：${rootConflicts(uploadPending).join('、')}。是否继续？`
            : ''
        }
        confirmLabel="覆盖上传"
        cancelLabel="取消"
        danger
        onClose={() => {
          if (busy) return;
          setUploadPending(null);
          if (fileRef.current) fileRef.current.value = '';
        }}
        onConfirm={() => {
          const pending = uploadPending;
          if (pending) void runUpload(pending);
        }}
      />

      <NamePromptDialog
        open={backupTarget != null}
        title="备份用例"
        label="备份文件名"
        placeholder="请输入备份文件名"
        initialValue={backupTarget?.name ?? ''}
        lockExtension
        confirmLabel="备份"
        cancelLabel="取消"
        error={backupNameError}
        onClose={() => {
          if (busy) return;
          setBackupTarget(null);
          setBackupNameError('');
        }}
        onConfirm={(name) => void confirmBackup(name)}
      />

      <NamePromptDialog
        open={renameTarget != null}
        title="重命名用例"
        label="文件名称"
        placeholder="请输入文件名"
        initialValue={renameTarget?.name ?? ''}
        lockExtension
        confirmLabel="保存"
        cancelLabel="取消"
        error={renameNameError}
        onClose={() => {
          if (busy) return;
          setRenameTarget(null);
          setRenameNameError('');
        }}
        onConfirm={(name) => void confirmRename(name)}
      />

      <CaseReviewDrawer
        open={reviewOpen && Boolean(reviewPath)}
        path={reviewPath}
        reviewOn={reviewOn}
        blindspotOn={blindspotOn}
        onClose={() => {
          setReviewOpen(false);
          writeViewPref('caseReview.open', '0');
          void loadSummaries();
        }}
        onSaved={() => void loadSummaries()}
      />

      <CaseBackupDrawer
        open={backupOpen}
        onClose={() => setBackupOpen(false)}
        onChanged={() => void refresh()}
      />
    </div>
  );
}
