/**
 * 迭代管理：按项目维护迭代周期与状态。
 *
 * 进度条是「时间进度」（按开始 / 截止日期流逝算），不是需求完成度；
 * 逾期天数只在未完成且过了截止日期时出现。
 */
import { useEffect, useMemo, useState } from 'react';

import {
  createPmItems,
  deletePmItems,
  filterIterations,
  ITERATION_STATUSES,
  ITERATION_STATUS_LABEL,
  iterationOverdueDays,
  iterationProgressPercent,
  sortIterationsNewestFirst,
  todayIso,
  updatePmItem,
  type IterationItem,
  type IterationStatus,
} from '../../lib/pm';
import { pluginDisabledMessage } from '../../lib/plugins';
import ConfirmDialog from './ConfirmDialog';
import DatePicker from './DatePicker';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';
import {
  ITERATION_STATUS_TONE,
  PmDrawer,
  PmDot,
  PmEmpty,
  PmEmptyState,
  PmErrorBar,
  PmField,
  PmIcon,
  PmLoading,
  PmNotice,
  PmPager,
  PmSelect,
  PmTag,
  PM_INPUT,
  PM_TEXTAREA,
  pmProjectHref,
  usePmFilter,
  usePmFilterText,
  usePmPlugin,
  usePmStore,
} from './PmShared';

/** 与 luckytask 一致：固定每页 10 条，翻页条只在多页时出现 */
const PAGE_SIZE = 10;

const STATUS_FILTERS: readonly (IterationStatus | 'all')[] = ['all', ...ITERATION_STATUSES];

/** 筛选记忆的键：按数据空间各记各的 */
const FILTER_PROJECT = 'pm.iterations.project';
const FILTER_STATUS = 'pm.iterations.status';
const FILTER_KEYWORD = 'pm.iterations.keyword';

interface Draft {
  id?: string;
  projectId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: IterationStatus;
  remark: string;
}

const STATUS_OPTIONS = ITERATION_STATUSES.map((value) => ({
  value,
  label: ITERATION_STATUS_LABEL[value],
}));

function emptyDraft(projectId = ''): Draft {
  return { projectId, name: '', startDate: '', endDate: '', status: 'planning', remark: '' };
}

interface PmIterationsBoardProps {
  /** 项目详情页传入：锁定到当前项目，隐藏项目筛选与表单里的项目字段 */
  scopeProjectId?: string;
}

export default function PmIterationsBoard({ scopeProjectId = '' }: PmIterationsBoardProps = {}) {
  const scoped = Boolean(scopeProjectId);
  const gate = usePmPlugin('iterations');
  const { store, live, loading, error, setError, reload } = usePmStore();
  const [projectId, setProjectId] = usePmFilterText(FILTER_PROJECT, 'all');
  const effectiveProjectId = scopeProjectId || projectId;
  const [status, setStatus] = usePmFilter<IterationStatus | 'all'>(
    FILTER_STATUS,
    STATUS_FILTERS,
    'all',
  );
  const [keyword, setKeyword] = usePmFilterText(FILTER_KEYWORD);
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IterationItem | null>(null);
  const today = todayIso();

  const projectName = useMemo(() => {
    const map = new Map(store.projects.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? '未关联项目';
  }, [store.projects]);

  const projectOptions = useMemo(
    () => [
      { value: 'all', label: '全部项目' },
      ...store.projects.map((p) => ({ value: p.id, label: p.name })),
    ],
    [store.projects],
  );

  const matched = useMemo(
    () =>
      sortIterationsNewestFirst(
        filterIterations(store.iterations, { projectId: effectiveProjectId, status, keyword }),
      ),
    [store.iterations, effectiveProjectId, status, keyword],
  );
  const scopeTotal = scoped
    ? store.iterations.filter((it) => it.projectId === effectiveProjectId).length
    : store.iterations.length;
  const totalPages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = matched.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // 记住了上次的项目筛选：等数据真的拉回来再校验，别在首屏空 store 时把记忆清掉
  useEffect(() => {
    if (scoped) return;
    if (live !== true) return;
    if (projectId !== 'all' && !store.projects.some((p) => p.id === projectId)) setProjectId('all');
  }, [live, store.projects, projectId, setProjectId, scoped]);

  async function save() {
    if (!draft) return;
    if (!draft.projectId) {
      setError('请先选择所属项目');
      return;
    }
    const name = draft.name.trim();
    if (!name) {
      setError('迭代名称不能为空');
      return;
    }
    if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) {
      setError('迭代结束日期不能早于开始日期');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        projectId: draft.projectId,
        name,
        startDate: draft.startDate,
        endDate: draft.endDate,
        status: draft.status,
        remark: draft.remark,
      };
      if (draft.id) {
        await updatePmItem<IterationItem>('iterations', draft.id, payload);
      } else {
        await createPmItems<IterationItem>('iterations', [payload]);
      }
      setDraft(null);
      setError('');
      await reload(true);
      showToast(draft.id ? '已保存迭代' : '已新建迭代', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`保存迭代失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function patchStatus(item: IterationItem, status: IterationStatus) {
    setBusy(true);
    try {
      await updatePmItem<IterationItem>('iterations', item.id, { status });
      await reload(true);
      showToast(`已更新迭代状态为「${status}」`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`更新迭代失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusy(true);
    try {
      await deletePmItems('iterations', [target.id]);
      await reload(true);
      showToast('已删除迭代', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除迭代失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!gate.ready) return <PmLoading label="正在读取插件开关" />;
  if (!gate.on) return <PmNotice>{pluginDisabledMessage('iterations')}</PmNotice>;
  if (live === null) return <PmLoading label="正在连接项目管理服务" />;
  if (!live) {
    return (
      <PmNotice>迭代管理需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。</PmNotice>
    );
  }
  if (store.projects.length === 0 && !loading && !scoped) {
    return <PmNotice>还没有项目。请先在「项目列表」里新建一个项目，再回来维护迭代。</PmNotice>;
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="text-xs text-stone-400">
          共 <span className="font-medium text-stone-600">{scopeTotal}</span> 个迭代
          {matched.length !== scopeTotal ? ` · 筛选出 ${matched.length} 个` : ''}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {scoped ? null : (
            <SelectDropdown
              flat
              showCheck={false}
              ariaLabel="按项目筛选迭代"
              className="w-36"
              options={projectOptions}
              value={projectId}
              onChange={(v) => {
                setProjectId(v);
                setPage(1);
              }}
            />
          )}
          <SelectDropdown
            flat
            showCheck={false}
            ariaLabel="按状态筛选迭代"
            className="w-28"
            options={[{ value: 'all', label: '全部状态' }, ...STATUS_OPTIONS]}
            value={status}
            onChange={(v) => {
              setStatus(v as IterationStatus | 'all');
              setPage(1);
            }}
          />
          <label className="relative block">
            <PmIcon
              name="search"
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400"
            />
            <input
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                setPage(1);
              }}
              placeholder="搜索迭代名称…"
              className="h-9 w-44 rounded-lg border border-stone-200 bg-white pl-8 pr-3 text-sm text-stone-800 outline-none transition-colors focus:border-[#3370ff]"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setDraft(emptyDraft(effectiveProjectId === 'all' ? '' : effectiveProjectId))
            }
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white transition-colors hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            <PmIcon name="plus" size={14} />
            新建迭代
          </button>
        </div>
      </div>

      {error ? <PmErrorBar message={error} onClose={() => setError('')} /> : null}

      <div className="mt-4 min-h-0 flex-1 overflow-auto pb-4">
        {loading && !store.iterations.length ? (
          <div className="flex min-h-[200px] items-center justify-center">
            <span className="tw-lib-spin" aria-hidden="true" />
          </div>
        ) : pageItems.length === 0 ? (
          scopeTotal ? (
            <PmEmpty>没有符合筛选条件的迭代。</PmEmpty>
          ) : (
            <PmEmptyState
              icon="calendar"
              title="暂无迭代"
              hint="新建一个迭代，用开始 / 截止日期跟踪进度。"
              action={
                <button
                  type="button"
                  onClick={() =>
                    setDraft(emptyDraft(effectiveProjectId === 'all' ? '' : effectiveProjectId))
                  }
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stone-200 px-3 text-xs text-stone-600 transition-colors hover:bg-stone-50"
                >
                  <PmIcon name="plus" size={13} />
                  新建迭代
                </button>
              }
            />
          )
        ) : (
          <div className="space-y-3">
            {pageItems.map((item) => {
              const progress = iterationProgressPercent(item, today);
              const overdue = iterationOverdueDays(item, today);
              const daysLeft =
                item.endDate && item.status !== 'done'
                  ? Math.round(
                      (Date.parse(`${item.endDate}T00:00:00`) - Date.parse(`${today}T00:00:00`)) /
                        86_400_000,
                    )
                  : null;
              return (
                <div
                  key={item.id}
                  className="rounded-xl border border-stone-200 bg-white px-4 py-3.5 transition-[border-color,box-shadow] hover:border-[#ddd6fe] hover:shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[15px] font-medium text-stone-800">
                          {item.name}
                        </span>
                        <PmTag tone={ITERATION_STATUS_TONE[item.status]}>
                          {ITERATION_STATUS_LABEL[item.status]}
                        </PmTag>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
                        {scoped ? null : (
                          <>
                            <a
                              href={pmProjectHref(item.projectId)}
                              className="transition-colors hover:text-[#3370ff]"
                            >
                              {projectName(item.projectId)}
                            </a>
                            <span className="text-stone-300">·</span>
                          </>
                        )}
                        <span className="tabular-nums">
                          {item.startDate || '—'} → {item.endDate || '—'}
                        </span>
                        {overdue !== null ? (
                          <span className="text-red-500">逾期 {overdue} 天</span>
                        ) : daysLeft !== null && daysLeft >= 0 && item.endDate ? (
                          <span className="text-stone-400">还剩 {daysLeft} 天</span>
                        ) : null}
                      </div>
                      {item.remark ? (
                        <p className="mt-1 line-clamp-1 text-xs text-stone-400">{item.remark}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {item.status === 'planning' ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void patchStatus(item, 'in_progress')}
                          className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-40"
                        >
                          <PmIcon name="play" size={12} />
                          开始
                        </button>
                      ) : null}
                      {item.status === 'in_progress' ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void patchStatus(item, 'done')}
                          className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-40"
                        >
                          <PmIcon name="check" size={12} />
                          完成
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`编辑 ${item.name}`}
                        onClick={() =>
                          setDraft({
                            id: item.id,
                            projectId: item.projectId,
                            name: item.name,
                            startDate: item.startDate,
                            endDate: item.endDate,
                            status: item.status,
                            remark: item.remark,
                          })
                        }
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
                      >
                        <PmIcon name="pencil" size={15} />
                      </button>
                      <button
                        type="button"
                        aria-label={`删除 ${item.name}`}
                        disabled={busy}
                        onClick={() => setDeleteTarget(item)}
                        className="tw-icon-danger flex h-8 w-8 items-center justify-center rounded-lg"
                      >
                        <PmIcon name="trash" size={15} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
                      <div
                        className="h-full rounded-full bg-[#3370ff] transition-[width] duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <span className="w-9 shrink-0 text-right text-xs tabular-nums text-stone-500">
                      {progress}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {matched.length > 0 ? (
        <PmPager page={currentPage} totalPages={totalPages} busy={busy} onPage={setPage} />
      ) : null}

      <PmDrawer
        open={draft !== null}
        title={draft?.id ? '编辑迭代' : '新建迭代'}
        busy={busy}
        submitLabel={draft?.id ? '保存' : '创建'}
        onClose={() => setDraft(null)}
        onSubmit={() => void save()}
      >
        {draft ? (
          <div className="space-y-1">
            {scoped ? null : (
              <PmField label="所属项目" required>
                <PmSelect
                  ariaLabel="所属项目"
                  options={store.projects.map((p) => ({ value: p.id, label: p.name }))}
                  value={draft.projectId}
                  onChange={(v) => setDraft({ ...draft, projectId: v })}
                  disabled={store.projects.length === 0}
                />
              </PmField>
            )}
            <PmField label="迭代名称" required>
              <input
                autoFocus
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="如：v1.0 迭代"
                className={PM_INPUT}
              />
            </PmField>
            <PmField label="开始日期">
              <DatePicker
                value={draft.startDate}
                onChange={(value) => setDraft({ ...draft, startDate: value })}
                placeholder="选择开始日期"
                className={`${PM_INPUT} tabular-nums`}
              />
            </PmField>
            <PmField label="截止日期">
              <DatePicker
                value={draft.endDate}
                onChange={(value) => setDraft({ ...draft, endDate: value })}
                placeholder="选择截止日期"
                className={`${PM_INPUT} tabular-nums`}
              />
            </PmField>
            <PmField label="状态">
              <PmSelect
                ariaLabel="迭代状态"
                options={STATUS_OPTIONS}
                value={draft.status}
                onChange={(v) => setDraft({ ...draft, status: v })}
                renderOptionPrefix={(o) => <PmDot tone={ITERATION_STATUS_TONE[o.value]} />}
              />
            </PmField>
            <PmField label="备注">
              <textarea
                value={draft.remark}
                onChange={(e) => setDraft({ ...draft, remark: e.target.value })}
                placeholder="迭代目标、范围等（可选）"
                rows={3}
                className={PM_TEXTAREA}
              />
            </PmField>
          </div>
        ) : null}
      </PmDrawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除迭代"
        message={`确定删除「${deleteTarget?.name ?? ''}」？关联的需求与缺陷会保留，但不再关联到这个迭代。`}
        confirmLabel="删除"
        danger="solid"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
