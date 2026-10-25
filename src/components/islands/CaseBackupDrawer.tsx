/**
 * 用例管理「备份列表」抽屉：用例管理/备份列表/ + 历史旁路 .bak* / legacy review backup；仅手动删除。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  CASE_BACKUP_DIR_NAME,
  isCaseBackupDirName,
  isCaseBackupFile,
} from '../../lib/case-backup-ttl';
import {
  deleteCaseReviewBackups,
  fetchCaseReviewBackups,
  fetchCaseReviewHealth,
} from '../../lib/case-review';
import {
  deleteDocs,
  listDocs,
  openDocsFile,
  parentDirPath,
  renameDocs,
  type DocsEntry,
} from '../../lib/project-docs';
import {
  ColumnResizeHandle,
  STICKY_CELL_L,
  STICKY_CELL_R,
  STICKY_HEAD_L,
  STICKY_HEAD_L_RESIZE,
  STICKY_HEAD_R,
  useColumnWidths,
  useScrollEdges,
  type ColumnSpec,
} from './ColumnResize';
import ConfirmDialog from './ConfirmDialog';
import DocsPager, { usePageSize } from './DocsPager';
import NamePromptDialog from './NamePromptDialog';
import OverflowHint from './OverflowHint';
import { PmIcon } from './PmShared';
import SlideOverDrawer from './SlideOverDrawer';
import { showToast } from './Toast';

/** 勾选列宽；文件列 sticky left 对齐此值 */
const SELECT_W = 40;
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_KEY = 'tw.case-backup.page-size.v1';

const COLUMNS: ColumnSpec[] = [
  { key: 'select', width: SELECT_W, min: 36 },
  { key: 'name', width: 280, min: 140 },
  { key: 'kind', width: 100, min: 72 },
  { key: 'mtime', width: 148, min: 120 },
  { key: 'size', width: 88, min: 64 },
  { key: 'filler', filler: true },
  { key: 'action', width: 72, min: 64 },
];

export type CaseBackupKind = 'folder' | 'sidecar' | 'legacy';

export interface CaseBackupRow {
  id: string;
  kind: CaseBackupKind;
  name: string;
  /** cases 相对路径（folder / sidecar）；legacy 仅展示 */
  path: string;
  /** legacy 删除用 basename */
  reviewName?: string;
  mtime: number;
  size?: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 列表变化后通知外层刷新数量 / 用例库 */
  onChanged?: () => void;
}

/** 扫历史旁路 .bak*；跳过「备份列表」目录（该目录由 API 列出） */
async function walkCaseBackupFiles(dir = '.'): Promise<DocsEntry[]> {
  const { entries } = await listDocs('cases', dir);
  const files: DocsEntry[] = [];
  for (const e of entries) {
    if (e.type === 'file') {
      if (isCaseBackupFile(e.name) || isCaseBackupFile(e.path)) files.push(e);
    } else if (!isCaseBackupDirName(e.name) && !isCaseBackupDirName(e.path)) {
      files.push(...(await walkCaseBackupFiles(e.path)));
    }
  }
  return files;
}

function kindLabel(kind: CaseBackupKind): string {
  if (kind === 'folder') return '备份列表';
  if (kind === 'sidecar') return '旁路';
  return '历史';
}

function formatWhen(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

function formatSize(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export async function loadCaseBackupRows(): Promise<CaseBackupRow[]> {
  const rows: CaseBackupRow[] = [];
  try {
    if (await fetchCaseReviewHealth()) {
      const items = await fetchCaseReviewBackups();
      for (const it of items) {
        const kind: CaseBackupKind = it.kind === 'legacy' ? 'legacy' : 'folder';
        const casesPath = it.casesPath || (kind === 'folder' ? it.path : '');
        rows.push({
          id: `${kind}:${it.name}:${it.mtime}`,
          kind,
          name: it.name,
          path: casesPath || it.path,
          reviewName: kind === 'legacy' ? it.name : undefined,
          mtime: it.mtime,
          size: it.size,
        });
      }
    }
  } catch {
    // 插件未开 / 服务未就绪：仍可扫旁路
  }
  try {
    const sidecar = await walkCaseBackupFiles('.');
    for (const e of sidecar) {
      const mtime = typeof e.mtime === 'number' ? e.mtime : 0;
      rows.push({
        id: `sidecar:${e.path}`,
        kind: 'sidecar',
        name: e.name,
        path: e.path,
        mtime,
        size: e.size,
      });
    }
  } catch {
    // ignore
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

export default function CaseBackupDrawer({ open, onClose, onChanged }: Props) {
  const [rows, setRows] = useState<CaseBackupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<
    { kind: 'one'; row: CaseBackupRow } | { kind: 'batch'; ids: string[] } | null
  >(null);
  const [renameTarget, setRenameTarget] = useState<CaseBackupRow | null>(null);
  const [renameNameError, setRenameNameError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(DEFAULT_PAGE_SIZE, PAGE_SIZE_KEY);
  const cols = useColumnWidths('lh:case-backup:cols:v4', COLUMNS);
  const scrollRef = useScrollEdges('case-backup');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadCaseBackupRows();
      setRows(next);
      setSelected((prev) => {
        const keep: Record<string, boolean> = {};
        for (const r of next) {
          if (prev[r.id]) keep[r.id] = true;
        }
        return keep;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setPage(1);
    void refresh();
  }, [open, refresh]);

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => rows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [rows, currentPage, pageSize],
  );

  const selectedIds = useMemo(() => Object.keys(selected).filter((id) => selected[id]), [selected]);

  const pageAllSelected = pageItems.length > 0 && pageItems.every((r) => selected[r.id]);

  async function runDelete(targets: CaseBackupRow[]) {
    setBusy(true);
    setError(null);
    try {
      const viaCases = targets.filter((t) => t.kind === 'folder' || t.kind === 'sidecar');
      const legacy = targets.filter((t) => t.kind === 'legacy');
      for (const t of viaCases) {
        await deleteDocs('cases', t.path);
      }
      if (legacy.length) {
        await deleteCaseReviewBackups(legacy.map((t) => t.reviewName || t.name));
      }
      showToast(
        targets.length === 1 ? `已删除「${targets[0]!.name}」` : `已删除 ${targets.length} 个备份`,
        'success',
      );
      await refresh();
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const target = confirm;
    setConfirm(null);
    if (!target) return;
    if (target.kind === 'one') {
      await runDelete([target.row]);
      return;
    }
    const map = new Map(rows.map((r) => [r.id, r]));
    const list = target.ids.map((id) => map.get(id)).filter(Boolean) as CaseBackupRow[];
    if (list.length) await runDelete(list);
  }

  async function openLocal(row: CaseBackupRow) {
    if (row.kind === 'legacy') return;
    try {
      await openDocsFile('cases', row.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function askRename(row: CaseBackupRow) {
    if (row.kind === 'legacy') return;
    setRenameNameError('');
    setRenameTarget(row);
  }

  async function confirmRename(name: string) {
    const target = renameTarget;
    if (!target || target.kind === 'legacy') return;
    const renamed = name.trim();
    if (!renamed || renamed === target.name) {
      setRenameTarget(null);
      setRenameNameError('');
      return;
    }
    const dir = parentDirPath(target.path);
    const wanted = (dir === '.' ? renamed : `${dir}/${renamed}`).toLowerCase();
    const dup = rows.find(
      (r) => r.id !== target.id && r.kind !== 'legacy' && r.path.toLowerCase() === wanted,
    );
    if (dup) {
      setRenameNameError(`已存在同名文件「${dup.name}」，换个名字再试`);
      return;
    }
    setBusy(true);
    setError(null);
    setRenameNameError('');
    try {
      await renameDocs('cases', target.path, renamed);
      setRenameTarget(null);
      showToast(`已重命名为「${renamed}」`, 'success');
      await refresh();
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRenameNameError(msg);
      showToast(`重命名失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  const confirmMessage =
    confirm?.kind === 'one'
      ? `删除备份「${confirm.row.name}」？此操作不可恢复。`
      : confirm?.kind === 'batch'
        ? `确认删除已选中的 ${confirm.ids.length} 个备份？此操作不可恢复。`
        : '';

  return (
    <>
      <SlideOverDrawer
        open={open}
        onClose={onClose}
        title="备份列表"
        closeAriaLabel="关闭备份列表"
        widthClass="max-w-5xl"
        bodyClassName="flex flex-col gap-3 overflow-hidden"
        escDisabled={Boolean(confirm) || renameTarget != null}
        footer={
          <footer className="shrink-0 p-4 border-t border-stone-100 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || selectedIds.length === 0}
              onClick={() => setConfirm({ kind: 'batch', ids: selectedIds })}
              className="h-9 px-3 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-40"
            >
              删除所选{selectedIds.length ? `（${selectedIds.length}）` : ''}
            </button>
            <div className="flex-1" />
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void refresh()}
              className="h-9 px-3 text-sm font-medium text-stone-700 border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-40"
            >
              刷新
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3 text-sm font-medium text-stone-700 border border-stone-200 rounded-lg hover:bg-stone-50"
            >
              关闭
            </button>
          </footer>
        }
      >
        <p className="shrink-0 text-xs text-stone-500 leading-5">
          新备份在「用例管理/{CASE_BACKUP_DIR_NAME}
          /」（首次备份时自动创建，主列表不展示该文件夹）。历史旁路 .bak*
          仍可在此查看。备份不会自动过期，请手动删除。
        </p>

        {error ? (
          <div className="shrink-0 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {error}
          </div>
        ) : null}

        <div className="shrink-0 flex items-center gap-2 text-xs text-stone-500">
          <span>
            共 <span className="font-medium text-stone-800">{rows.length}</span> 个
          </span>
          {loading ? <span>加载中…</span> : null}
        </div>

        {rows.length === 0 && !loading ? (
          <div className="flex-1 min-h-0 rounded-xl border border-dashed border-stone-200 px-4 py-10 flex items-center justify-center text-sm text-stone-400">
            暂无备份文件
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden rounded-xl border border-stone-200 flex flex-col">
            <div ref={scrollRef} className="tw-scroll-x flex-1 min-h-0 overflow-auto">
              <table
                className="tw-data-table tw-sticky-table w-full table-fixed text-left text-sm"
                style={cols.tableStyle}
              >
                <colgroup>
                  {COLUMNS.map((c) => (
                    <col
                      key={c.key}
                      style={cols.widthOf(c.key) ? { width: cols.widthOf(c.key) } : undefined}
                    />
                  ))}
                </colgroup>
                <thead className="bg-stone-50 text-xs text-stone-500">
                  <tr>
                    <th className={`${STICKY_HEAD_L} relative`}>
                      <input
                        type="checkbox"
                        checked={pageAllSelected}
                        disabled={busy || pageItems.length === 0}
                        onChange={(e) => {
                          const value = e.target.checked;
                          setSelected((prev) => {
                            const next = { ...prev };
                            for (const r of pageItems) {
                              if (value) next[r.id] = true;
                              else delete next[r.id];
                            }
                            return next;
                          });
                        }}
                        aria-label="全选本页备份"
                      />
                      <ColumnResizeHandle {...cols.resizeProps('select')} />
                    </th>
                    <th
                      className={STICKY_HEAD_L_RESIZE}
                      style={{ '--tw-sticky-left': `${SELECT_W}px` } as CSSProperties}
                    >
                      文件名
                      <ColumnResizeHandle {...cols.resizeProps('name')} />
                    </th>
                    <th className="relative px-3 py-2 font-medium whitespace-nowrap">
                      类型
                      <ColumnResizeHandle {...cols.resizeProps('kind')} />
                    </th>
                    <th className="relative px-3 py-2 font-medium whitespace-nowrap">
                      备份时间
                      <ColumnResizeHandle {...cols.resizeProps('mtime')} />
                    </th>
                    <th className="relative px-3 py-2 font-medium whitespace-nowrap">
                      大小
                      <ColumnResizeHandle {...cols.resizeProps('size')} />
                    </th>
                    <th aria-hidden="true" />
                    <th className={STICKY_HEAD_R}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((row) => (
                    <tr
                      key={row.id}
                      className={`group border-t border-stone-100 ${
                        row.kind !== 'legacy' ? 'cursor-pointer' : ''
                      }`}
                      onDoubleClick={() => {
                        if (row.kind === 'legacy' || busy) return;
                        void openLocal(row);
                      }}
                    >
                      <td className={STICKY_CELL_L} onDoubleClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={Boolean(selected[row.id])}
                          disabled={busy}
                          onChange={(e) =>
                            setSelected((prev) => ({ ...prev, [row.id]: e.target.checked }))
                          }
                          aria-label={`选择 ${row.name}`}
                        />
                      </td>
                      <td
                        className={`${STICKY_CELL_L} min-w-0 max-w-0`}
                        style={{ '--tw-sticky-left': `${SELECT_W}px` } as CSSProperties}
                      >
                        <div className="inline-flex min-w-0 max-w-full items-center">
                          <OverflowHint
                            text={row.name}
                            className="min-w-0 truncate font-medium text-stone-800"
                          />
                          {row.kind !== 'legacy' ? (
                            <span
                              className="ml-0.5 mr-1 flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
                              onDoubleClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                disabled={busy}
                                aria-label={`重命名 ${row.name}`}
                                onClick={() => askRename(row)}
                                className="inline-flex h-6 w-6 items-center justify-center rounded text-stone-400 transition-colors hover:bg-[#e8f0fe] hover:text-[#4176e6] disabled:opacity-40"
                              >
                                <PmIcon name="pencil" size={12} />
                              </button>
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-stone-600 whitespace-nowrap">
                        {kindLabel(row.kind)}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-stone-600 whitespace-nowrap">
                        {formatWhen(row.mtime)}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-stone-600 whitespace-nowrap tabular-nums">
                        {formatSize(row.size)}
                      </td>
                      <td aria-hidden="true" />
                      <td className={STICKY_CELL_R} onDoubleClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirm({ kind: 'one', row })}
                            className="h-7 px-2 text-xs font-medium text-red-600 rounded-md hover:bg-red-50 disabled:opacity-40"
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 0 ? (
              <DocsPager
                page={currentPage}
                totalPages={totalPages}
                pageSize={pageSize}
                busy={busy || loading}
                className="shrink-0 !px-4 !py-2"
                onPage={setPage}
                onPageSize={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            ) : null}
          </div>
        )}
      </SlideOverDrawer>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.kind === 'batch' ? '批量删除备份' : '删除备份'}
        message={confirmMessage}
        confirmLabel="删除"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={() => void confirmDelete()}
      />

      <NamePromptDialog
        open={renameTarget != null}
        title="重命名备份"
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
    </>
  );
}
