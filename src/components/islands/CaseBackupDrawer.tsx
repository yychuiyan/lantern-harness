/**
 * 用例管理「备份」抽屉：旁路 .bak* + 评审写回 backup，展示过期时间，支持手动删除。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { backupExpiresAt, backupExpiryLabel, isCaseBackupFile } from '../../lib/case-backup-ttl';
import {
  deleteCaseReviewBackups,
  fetchCaseReviewBackups,
  fetchCaseReviewHealth,
} from '../../lib/case-review';
import { deleteDocs, listDocs, openDocsFile, type DocsEntry } from '../../lib/project-docs';
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
import OverflowHint from './OverflowHint';
import SlideOverDrawer from './SlideOverDrawer';
import { showToast } from './Toast';

/** 勾选列宽；文件列 sticky left 对齐此值 */
const SELECT_W = 40;
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_KEY = 'tw.case-backup.page-size.v1';

const COLUMNS: ColumnSpec[] = [
  { key: 'select', width: SELECT_W, min: 36 },
  { key: 'name', width: 260, min: 140 },
  { key: 'kind', width: 88, min: 64 },
  { key: 'mtime', width: 148, min: 120 },
  { key: 'expiry', width: 120, min: 88 },
  { key: 'size', width: 88, min: 64 },
  { key: 'filler', filler: true },
  { key: 'action', width: 112, min: 96 },
];

export type CaseBackupKind = 'sidecar' | 'review';

export interface CaseBackupRow {
  id: string;
  kind: CaseBackupKind;
  name: string;
  /** 旁路：cases 相对路径；评审：空间相对路径（仅展示） */
  path: string;
  /** 评审删除用 basename */
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

async function walkCaseBackupFiles(dir = '.'): Promise<DocsEntry[]> {
  const { entries } = await listDocs('cases', dir);
  const files: DocsEntry[] = [];
  for (const e of entries) {
    if (e.type === 'file') {
      if (isCaseBackupFile(e.name) || isCaseBackupFile(e.path)) files.push(e);
    } else {
      files.push(...(await walkCaseBackupFiles(e.path)));
    }
  }
  return files;
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
    // 旁路扫失败仍尝试评审备份
  }
  try {
    if (await fetchCaseReviewHealth()) {
      const items = await fetchCaseReviewBackups();
      for (const it of items) {
        rows.push({
          id: `review:${it.name}`,
          kind: 'review',
          name: it.name,
          path: it.path,
          reviewName: it.name,
          mtime: it.mtime,
          size: it.size,
        });
      }
    }
  } catch {
    // 评审插件未开 / 服务未就绪
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(DEFAULT_PAGE_SIZE, PAGE_SIZE_KEY);
  const cols = useColumnWidths('lh:case-backup:cols:v2', COLUMNS);
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
      const sidecar = targets.filter((t) => t.kind === 'sidecar');
      const review = targets.filter((t) => t.kind === 'review');
      for (const t of sidecar) {
        await deleteDocs('cases', t.path);
      }
      if (review.length) {
        await deleteCaseReviewBackups(review.map((t) => t.reviewName || t.name));
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
    if (row.kind !== 'sidecar') return;
    try {
      await openDocsFile('cases', row.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        title="用例备份"
        closeAriaLabel="关闭备份列表"
        widthClass="max-w-3xl"
        escDisabled={Boolean(confirm)}
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
        <p className="text-xs text-stone-500 leading-5">
          旁路备份在用例目录旁（对话改文件时留下）；评审写回备份在空间本地
          case-review/backup。均按修改时间保留 7
          天，过期会在打开用例库或写回时自动清理，也可在此手动删除。
        </p>

        {error ? (
          <div className="mt-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {error}
          </div>
        ) : null}

        <div className="mt-3 flex items-center gap-2 text-xs text-stone-500">
          <span>
            共 <span className="font-medium text-stone-800">{rows.length}</span> 个
          </span>
          {loading ? <span>加载中…</span> : null}
        </div>

        {rows.length === 0 && !loading ? (
          <div className="mt-6 rounded-xl border border-dashed border-stone-200 px-4 py-10 text-center text-sm text-stone-400">
            暂无备份文件
          </div>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-stone-200">
            <div ref={scrollRef} className="tw-scroll-x overflow-x-auto">
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
                      文件
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
                      过期
                      <ColumnResizeHandle {...cols.resizeProps('expiry')} />
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
                  {pageItems.map((row) => {
                    const expired = Number.isFinite(row.mtime)
                      ? backupExpiresAt(row.mtime) <= Date.now()
                      : false;
                    return (
                      <tr key={row.id} className="border-t border-stone-100">
                        <td className={STICKY_CELL_L}>
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
                          <OverflowHint
                            text={row.name}
                            className="block truncate font-medium text-stone-800"
                          />
                        </td>
                        <td className="px-3 py-2.5 text-xs text-stone-600 whitespace-nowrap">
                          {row.kind === 'sidecar' ? '旁路' : '评审写回'}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-stone-600 whitespace-nowrap">
                          {formatWhen(row.mtime)}
                        </td>
                        <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                          <span className={expired ? 'text-rose-600' : 'text-stone-600'}>
                            {backupExpiryLabel(row.mtime)}
                          </span>
                          <div className="mt-0.5 text-[11px] text-stone-400">
                            {formatWhen(backupExpiresAt(row.mtime))}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-stone-600 whitespace-nowrap tabular-nums">
                          {formatSize(row.size)}
                        </td>
                        <td aria-hidden="true" />
                        <td className={STICKY_CELL_R}>
                          <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                            {row.kind === 'sidecar' ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void openLocal(row)}
                                className="h-7 px-2 text-xs font-medium text-stone-700 rounded-md hover:bg-stone-100 disabled:opacity-40"
                              >
                                打开
                              </button>
                            ) : null}
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
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > 0 ? (
              <DocsPager
                page={currentPage}
                totalPages={totalPages}
                pageSize={pageSize}
                busy={busy || loading}
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
    </>
  );
}
