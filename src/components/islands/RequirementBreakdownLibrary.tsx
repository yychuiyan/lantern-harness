import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

import { pluginDisabledMessage } from '../../lib/plugins';
import {
  backfillRequirementBreakdowns,
  deleteRequirementBreakdown,
  fetchRequirementBreakdownHealth,
  importRequirementBreakdown,
  listRequirementBreakdownCandidates,
  listRequirementBreakdowns,
  openRequirementBreakdown,
  retryRequirementBreakdown,
  updateRequirementBreakdown,
  type RequirementBreakdownCandidate,
  type RequirementBreakdownEntry,
} from '../../lib/requirement-breakdown-library';
import ConfirmDialog from './ConfirmDialog';
import {
  ColumnResizeHandle,
  useFlexColumnWidths,
  useScrollEdges,
  type ColumnSpec,
} from './ColumnResize';
import OverflowHint from './OverflowHint';
import { PmIcon, PmLoading, PmNotice, usePmPlugin } from './PmShared';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';

const ALL = '__all__';

function formatWhen(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function EditEntryDialog({
  entry,
  busy,
  error,
  onClose,
  onSave,
}: {
  entry: RequirementBreakdownEntry;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (title: string, note: string) => void;
}) {
  const [title, setTitle] = useState(entry.title);
  const [note, setNote] = useState(entry.note);
  return (
    <Dialog open onClose={busy ? () => undefined : onClose} className="tw-bm-theme relative z-110">
      <DialogBackdrop className="fixed inset-0 z-[109] bg-black/35" />
      <div className="fixed inset-0 z-[110] grid place-items-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-2xl border border-(--tw-border) bg-(--tw-surface-panel) p-5 shadow-2xl">
          <DialogTitle className="text-base font-semibold text-(--tw-label-primary)">
            修改拆解条目
          </DialogTitle>
          <div className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-xs text-(--tw-label-secondary)">
              显示标题
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="h-9 rounded-lg border border-(--tw-border) bg-(--tw-surface-recessed) px-3 text-sm text-(--tw-label-primary) outline-none focus:border-[#4176e6]"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-(--tw-label-secondary)">
              备注
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={5}
                placeholder="记录本次拆解的补充说明"
                className="resize-y rounded-lg border border-(--tw-border) bg-(--tw-surface-recessed) px-3 py-2 text-sm leading-6 text-(--tw-label-primary) outline-none focus:border-[#4176e6]"
              />
            </label>
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="h-9 rounded-lg border border-(--tw-border) px-3 text-sm text-(--tw-label-secondary) hover:bg-(--tw-surface-recessed)"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy || !title.trim()}
              onClick={() => onSave(title.trim(), note.trim())}
              className="h-9 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white hover:bg-[#3565c7] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function BackfillDialog({
  candidates,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  candidates: RequirementBreakdownCandidate[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const selectable = candidates.filter((item) => !item.recorded);
  const selectedForSubmit = selected.filter((id) =>
    selectable.some((item) => item.analysisId === id),
  );

  useEffect(() => {
    const available = new Set(
      candidates.filter((item) => !item.recorded).map((item) => item.analysisId),
    );
    setSelected((current) => current.filter((id) => available.has(id)));
  }, [candidates]);

  return (
    <Dialog open onClose={busy ? () => undefined : onClose} className="tw-bm-theme relative z-110">
      <DialogBackdrop className="fixed inset-0 z-[109] bg-black/35" />
      <div className="fixed inset-0 z-[110] grid place-items-center p-4">
        <DialogPanel className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-(--tw-border) bg-(--tw-surface-panel) shadow-2xl">
          <header className="border-b border-(--tw-border) px-5 py-4">
            <DialogTitle className="text-base font-semibold text-(--tw-label-primary)">
              从历史分析补录
            </DialogTitle>
            <p className="mt-1 text-xs text-(--tw-label-secondary)">
              只显示已经包含原文结构的需求分析；已入库批次不能重复选择。
            </p>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!candidates.length ? (
              <p className="py-10 text-center text-sm text-(--tw-label-tertiary)">
                没有可补录的历史分析。
              </p>
            ) : (
              <div className="space-y-1">
                {candidates.map((item) => (
                  <label
                    key={`${item.analysisId}-${item.sourceExportAt}`}
                    className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${
                      item.recorded
                        ? 'border-transparent opacity-55'
                        : 'border-(--tw-border) hover:bg-(--tw-surface-recessed)'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={item.recorded || selected.includes(item.analysisId)}
                      disabled={item.recorded}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...new Set([...current, item.analysisId])]
                            : current.filter((id) => id !== item.analysisId),
                        )
                      }
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-(--tw-label-primary)">
                        {item.sourceTitle || item.title}
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-(--tw-label-tertiary)">
                        {item.sourcePath || item.title} · {formatWhen(item.updatedAt)}
                      </span>
                    </span>
                    {item.recorded ? (
                      <span className="rounded-full bg-(--tw-surface-recessed) px-2 py-0.5 text-[10px] text-(--tw-label-tertiary)">
                        已入库
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            )}
            {error ? (
              <p className="mt-3 whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                {error}
              </p>
            ) : null}
          </div>
          <footer className="flex items-center justify-between border-t border-(--tw-border) px-5 py-3">
            <span className="text-xs text-(--tw-label-tertiary)">
              已选 {selectedForSubmit.length} / {selectable.length}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="h-9 rounded-lg border border-(--tw-border) px-3 text-sm text-(--tw-label-secondary)"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy || !selectedForSubmit.length}
                onClick={() => onSubmit(selectedForSubmit)}
                className="h-9 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? '补录中…' : `补录 ${selectedForSubmit.length} 项`}
              </button>
            </span>
          </footer>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

const BREAKDOWN_RESIZE_KEY = 'req-breakdowns:list:cols:v2';
const BREAKDOWN_COLUMNS: ColumnSpec[] = [
  { key: 'title', min: 280 },
  { key: 'project', width: 120, min: 90 },
  { key: 'iteration', width: 80, min: 64 },
  { key: 'type', width: 72, min: 60 },
  { key: 'created', width: 128, min: 100 },
  { key: 'modified', width: 128, min: 100 },
];
const BREAKDOWN_ACTIONS_WIDTH = 168;
const BREAKDOWN_COLUMN_GAP = 8;
const BREAKDOWN_DEFAULT_MIN_WIDTH =
  280 + 120 + 80 + 72 + 128 + 128 + BREAKDOWN_ACTIONS_WIDTH + BREAKDOWN_COLUMN_GAP * 7;

function BreakdownTable({
  entries,
  totalCount,
  selectedId,
  busy,
  onSelect,
  onOpen,
  onEdit,
  onDelete,
  onRetry,
}: {
  entries: RequirementBreakdownEntry[];
  totalCount: number;
  selectedId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onOpen: (entry: RequirementBreakdownEntry) => void;
  onEdit: (entry: RequirementBreakdownEntry) => void;
  onDelete: (entry: RequirementBreakdownEntry) => void;
  onRetry: (entry: RequirementBreakdownEntry) => void;
}) {
  const cols = useFlexColumnWidths(BREAKDOWN_RESIZE_KEY, BREAKDOWN_COLUMNS);
  const scrollRef = useScrollEdges(BREAKDOWN_RESIZE_KEY);
  const titleWidth = cols.styleOf('title')?.width;
  const titleStyle = titleWidth
    ? { width: titleWidth, flex: '0 0 auto', minWidth: 280 }
    : { minWidth: 280 };
  const columnWidths = {
    project: 120,
    iteration: 80,
    type: 72,
    created: 128,
    modified: 128,
  };
  const colStyle = (key: keyof typeof columnWidths) => ({
    width: cols.styleOf(key)?.width ?? columnWidths[key],
    flex: '0 0 auto' as const,
  });
  const listMinWidth =
    (titleWidth ?? 280) +
    (cols.styleOf('project')?.width ?? columnWidths.project) +
    (cols.styleOf('iteration')?.width ?? columnWidths.iteration) +
    (cols.styleOf('type')?.width ?? columnWidths.type) +
    (cols.styleOf('created')?.width ?? columnWidths.created) +
    (cols.styleOf('modified')?.width ?? columnWidths.modified) +
    BREAKDOWN_ACTIONS_WIDTH +
    BREAKDOWN_COLUMN_GAP * 7;

  return (
    <div ref={scrollRef} className="tw-scroll-x h-full overflow-auto">
      <ul
        className="tw-sticky-list divide-y divide-stone-100"
        style={{ minWidth: Math.max(BREAKDOWN_DEFAULT_MIN_WIDTH, listMinWidth) }}
      >
        <li className="flex items-stretch gap-2 bg-stone-50 text-[11px] font-medium text-stone-500">
          <span
            className="tw-sticky-l relative flex min-w-0 items-center py-2 pl-4"
            style={titleStyle}
            data-col="title"
          >
            标题
            <ColumnResizeHandle {...cols.resizeProps('title')} />
          </span>
          <span
            className="relative flex items-center py-2"
            style={colStyle('project')}
            data-col="project"
          >
            项目
            <ColumnResizeHandle {...cols.resizeProps('project')} />
          </span>
          <span
            className="relative flex items-center py-2"
            style={colStyle('iteration')}
            data-col="iteration"
          >
            迭代
            <ColumnResizeHandle {...cols.resizeProps('iteration')} />
          </span>
          <span
            className="relative flex items-center py-2"
            style={colStyle('type')}
            data-col="type"
          >
            类型
            <ColumnResizeHandle {...cols.resizeProps('type')} />
          </span>
          <span
            className="relative flex items-center py-2"
            style={colStyle('created')}
            data-col="created"
          >
            创建日期
            <ColumnResizeHandle {...cols.resizeProps('created')} />
          </span>
          <span
            className="relative flex items-center py-2"
            style={colStyle('modified')}
            data-col="modified"
          >
            修改日期
            <ColumnResizeHandle {...cols.resizeProps('modified')} />
          </span>
          <span className="flex-1" aria-hidden="true" />
          <span
            className="tw-sticky-r flex items-center justify-center px-3 py-2 text-center"
            style={{ width: BREAKDOWN_ACTIONS_WIDTH, flex: '0 0 auto' }}
          >
            操作
          </span>
        </li>
        {entries.map((entry) => (
          <li
            key={entry.id}
            role="button"
            tabIndex={0}
            aria-label={`${entry.title}${entry.exists ? '' : '，文件缺失'}`}
            onClick={() => onSelect(entry.id)}
            onDoubleClick={() => onOpen(entry)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onOpen(entry);
              }
            }}
            className={`flex cursor-pointer items-stretch gap-2 outline-none transition-colors hover:bg-stone-50 focus-visible:bg-[#edf3fe] ${
              selectedId === entry.id ? 'bg-[#f5f8ff]' : ''
            }`}
          >
            <div
              className="tw-sticky-l flex min-w-0 items-center py-2.5 pl-4 pr-1"
              style={titleStyle}
            >
              <div className="flex min-w-0 items-center gap-2">
                <OverflowHint
                  text={entry.title}
                  className={`block min-w-0 truncate ${
                    entry.exists ? 'text-stone-800' : 'text-red-600'
                  }`}
                />
                {!entry.exists ? (
                  <span className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[9px] text-red-600">
                    文件缺失
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex min-w-0 items-center py-2.5" style={colStyle('project')}>
              <OverflowHint
                text={entry.project}
                className="block truncate text-xs text-stone-700"
              />
            </div>
            <div className="flex min-w-0 items-center py-2.5" style={colStyle('iteration')}>
              <OverflowHint
                text={entry.iteration}
                className="block truncate text-xs text-stone-500"
              />
            </div>
            <div className="flex items-center py-2.5" style={colStyle('type')}>
              <span className="inline-flex max-w-full rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-500">
                <OverflowHint
                  text={entry.kind === 'generated' ? '自动生成' : '手动上传'}
                  className="block truncate"
                />
              </span>
            </div>
            <div className="flex min-w-0 items-center py-2.5" style={colStyle('created')}>
              <OverflowHint
                text={formatWhen(entry.createdAt)}
                className="block truncate text-xs text-stone-500 tabular-nums"
              />
            </div>
            <div className="flex min-w-0 items-center py-2.5" style={colStyle('modified')}>
              <OverflowHint
                text={formatWhen(entry.fileMtime || entry.mtime)}
                className="block truncate text-xs text-stone-500 tabular-nums"
              />
            </div>
            <span className="flex-1" aria-hidden="true" />
            <div
              className="tw-sticky-r flex items-center justify-center gap-1 px-3 py-2.5"
              style={{ width: BREAKDOWN_ACTIONS_WIDTH, flex: '0 0 auto' }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {!entry.exists && entry.kind === 'generated' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry(entry);
                  }}
                  className="rounded px-1.5 py-1 text-[11px] text-amber-700 hover:bg-amber-50 disabled:opacity-40"
                >
                  重新生成
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(entry);
                }}
                className="rounded px-1.5 py-1 text-[11px] text-stone-600 hover:bg-stone-100 disabled:opacity-40"
              >
                修改
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(entry);
                }}
                className="rounded px-1.5 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-40"
              >
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!entries.length ? (
        <div className="grid min-h-56 place-items-center p-8 text-center">
          <div>
            <strong className="text-sm text-stone-700">
              {totalCount ? '没有匹配的拆解记录' : '还没有需求拆解 XMind'}
            </strong>
            <p className="mt-1 text-xs text-stone-400">
              {totalCount ? '调整搜索或筛选条件。' : '完成一次需求拆解，或上传已有 XMind 文件。'}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function RequirementBreakdownLibrary() {
  const gate = usePmPlugin('reqBreakdowns');
  const [live, setLive] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<RequirementBreakdownEntry[]>([]);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [project, setProject] = useState(ALL);
  const [iteration, setIteration] = useState(ALL);
  const [kind, setKind] = useState(ALL);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editEntry, setEditEntry] = useState<RequirementBreakdownEntry | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RequirementBreakdownEntry | null>(null);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillCandidates, setBackfillCandidates] = useState<RequirementBreakdownCandidate[]>([]);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillError, setBackfillError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const data = await listRequirementBreakdowns();
    setEntries(data.entries);
    setRevision(data.revision);
    setLive(true);
    setError('');
  }, []);

  useEffect(() => {
    if (!gate.on) return;
    let alive = true;
    void fetchRequirementBreakdownHealth().then((ready) => {
      if (!alive) return;
      setLive(ready);
      if (ready) void load().catch((reason) => setError(String(reason)));
    });
    const refresh = () => {
      if (document.visibilityState === 'visible')
        void load().catch((reason) => setError(String(reason)));
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [gate.on, load]);

  const projects = useMemo(
    () => [...new Set(entries.map((entry) => entry.project))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const iterations = useMemo(
    () => [...new Set(entries.map((entry) => entry.iteration))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter(
      (entry) =>
        (project === ALL || entry.project === project) &&
        (iteration === ALL || entry.iteration === iteration) &&
        (kind === ALL || entry.kind === kind) &&
        (!needle ||
          [
            entry.title,
            entry.sourceTitle,
            entry.sourcePath,
            entry.project,
            entry.iteration,
            entry.note,
          ]
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    );
  }, [entries, iteration, kind, project, query]);

  async function openEntry(entry: RequirementBreakdownEntry) {
    setSelectedId(entry.id);
    if (!entry.exists) {
      showToast('XMind 文件不存在，请重新上传或重新生成', 'error');
      return;
    }
    try {
      await openRequirementBreakdown(entry.id);
    } catch (reason) {
      showToast(`打开失败：${reason instanceof Error ? reason.message : String(reason)}`, 'error');
    }
  }

  async function upload(file: File) {
    setBusy(true);
    try {
      const result = await importRequirementBreakdown(file, revision);
      setRevision(result.revision);
      await load();
      showToast('XMind 已加入需求拆解库', 'success');
    } catch (reason) {
      showToast(`上传失败：${reason instanceof Error ? reason.message : String(reason)}`, 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function saveEntry(title: string, note: string) {
    if (!editEntry) return;
    setEditBusy(true);
    setEditError('');
    try {
      const result = await updateRequirementBreakdown(editEntry.id, revision, { title, note });
      setRevision(result.revision);
      setEditEntry(null);
      await load();
      showToast('拆解条目已更新', 'success');
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setEditBusy(false);
    }
  }

  async function retry(entry: RequirementBreakdownEntry) {
    setBusy(true);
    try {
      const result = await retryRequirementBreakdown(entry.id, revision);
      setRevision(result.revision);
      await load();
      showToast('XMind 已重新生成', 'success');
    } catch (reason) {
      showToast(`生成失败：${reason instanceof Error ? reason.message : String(reason)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      setRevision(await deleteRequirementBreakdown(deleteTarget.id, revision));
      setDeleteTarget(null);
      await load();
      showToast('拆解条目已删除，XMind 文件已移入废纸篓', 'success');
    } catch (reason) {
      showToast(`删除失败：${reason instanceof Error ? reason.message : String(reason)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openBackfill() {
    setBackfillOpen(true);
    setBackfillBusy(true);
    setBackfillError('');
    try {
      const data = await listRequirementBreakdownCandidates();
      setRevision(data.revision);
      setBackfillCandidates(data.candidates);
    } catch (reason) {
      setBackfillError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBackfillBusy(false);
    }
  }

  async function submitBackfill(ids: string[]) {
    setBackfillBusy(true);
    setBackfillError('');
    try {
      const result = await backfillRequirementBreakdowns(ids, revision);
      setRevision(result.revision);
      await load();
      if (result.failed.length) {
        const latest = await listRequirementBreakdownCandidates();
        setRevision(latest.revision);
        setBackfillCandidates(latest.candidates);
        setBackfillError(
          result.failed
            .map((item) => {
              const title =
                backfillCandidates.find((candidate) => candidate.analysisId === item.analysisId)
                  ?.sourceTitle || item.analysisId;
              return `${title}：${item.error}`;
            })
            .join('\n'),
        );
        showToast(`已补录 ${result.created.length} 项，${result.failed.length} 项失败`, 'error');
      } else {
        setBackfillOpen(false);
        showToast(`已补录 ${result.created.length} 项`, 'success');
      }
    } catch (reason) {
      setBackfillError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBackfillBusy(false);
    }
  }

  if (gate.ready && !gate.on) return <PmNotice>{pluginDisabledMessage('reqBreakdowns')}</PmNotice>;
  if (!gate.ready || live === null) return <PmLoading label="正在连接需求拆解库" />;
  if (!live)
    return (
      <PmNotice>
        需求拆解库需要本地服务。请确认服务已升级并重启，或使用最新的 `lantern` 一体服务。
      </PmNotice>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3">
        <div className="min-w-0 flex-1 text-sm text-stone-600">
          {query.trim() || project !== ALL || iteration !== ALL || kind !== ALL ? (
            <>
              匹配 <span className="font-medium text-stone-800">{filtered.length}</span> 条
              <span className="text-stone-400"> · 共 {entries.length}</span>
            </>
          ) : (
            <>
              共 <span className="font-medium text-stone-800">{entries.length}</span> 条拆解记录
            </>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void openBackfill()}
          className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-stone-200 px-3 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40"
        >
          从历史分析补录
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xmind"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="h-8 shrink-0 whitespace-nowrap rounded-lg bg-[#4176e6] px-3 text-sm font-medium text-white hover:bg-[#3565c7] disabled:opacity-40"
        >
          上传 XMind
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3">
        <label className="relative block min-w-[220px] flex-1">
          <PmIcon
            name="search"
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、项目或备注…"
            className="h-8 w-full rounded-lg border border-stone-200 bg-white pl-8 pr-3 text-sm text-stone-800 outline-none focus:border-[#4176e6]"
          />
        </label>
        <div className="w-40">
          <SelectDropdown
            flat
            value={project}
            onChange={setProject}
            ariaLabel="筛选项目"
            options={[
              { value: ALL, label: '全部项目' },
              ...projects.map((item) => ({ value: item, label: item })),
            ]}
          />
        </div>
        <div className="w-32">
          <SelectDropdown
            flat
            value={iteration}
            onChange={setIteration}
            ariaLabel="筛选迭代"
            options={[
              { value: ALL, label: '全部迭代' },
              ...iterations.map((item) => ({ value: item, label: item })),
            ]}
          />
        </div>
        <div className="w-32">
          <SelectDropdown
            flat
            value={kind}
            onChange={setKind}
            ariaLabel="筛选类型"
            options={[
              { value: ALL, label: '全部类型' },
              { value: 'generated', label: '自动生成' },
              { value: 'uploaded', label: '手动上传' },
            ]}
          />
        </div>
      </div>

      {error ? (
        <p className="mx-4 mt-3 shrink-0 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <section className="min-h-0 flex-1 overflow-hidden bg-white">
        <BreakdownTable
          entries={filtered}
          totalCount={entries.length}
          selectedId={selectedId}
          busy={busy}
          onSelect={setSelectedId}
          onOpen={(entry) => void openEntry(entry)}
          onEdit={(entry) => {
            setEditEntry(entry);
            setEditError('');
          }}
          onDelete={setDeleteTarget}
          onRetry={(entry) => void retry(entry)}
        />
      </section>

      {editEntry ? (
        <EditEntryDialog
          entry={editEntry}
          busy={editBusy}
          error={editError}
          onClose={() => {
            if (!editBusy) setEditEntry(null);
          }}
          onSave={(title, note) => void saveEntry(title, note)}
        />
      ) : null}
      {backfillOpen ? (
        <BackfillDialog
          candidates={backfillCandidates}
          busy={backfillBusy}
          error={backfillError}
          onClose={() => {
            if (!backfillBusy) setBackfillOpen(false);
          }}
          onSubmit={(ids) => void submitBackfill(ids)}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除需求拆解"
        message={
          deleteTarget
            ? `确定删除「${deleteTarget.title}」？XMind 文件会移入系统废纸篓，原需求分析和来源文档不受影响。`
            : ''
        }
        confirmLabel="删除"
        cancelLabel="取消"
        danger="outline"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
