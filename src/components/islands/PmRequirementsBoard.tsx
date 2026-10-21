/**
 * 需求管理：表格 + 项目 / 迭代 / 状态 / 优先级筛选。
 *
 * 编号（REQ-001）由服务端分配；状态可在行内直接改，其余字段走右侧抽屉。
 * 切项目时，原来关联的迭代若不属于新项目会自动清空。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  cleanupPmAttachments,
  createPmItems,
  deletePmItems,
  filterRequirements,
  parseAttachments,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_PRIORITY_LABEL,
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUS_LABEL,
  updatePmItem,
  type AcceptanceCriterion,
  type RequirementItem,
  type RequirementPriority,
  type RequirementStatus,
} from '../../lib/pm';
import { pluginDisabledMessage } from '../../lib/plugins';
import ConfirmDialog from './ConfirmDialog';
import DocsPager, { usePageSize } from './DocsPager';
import PmAttachmentField from './PmAttachmentField';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';
import {
  PmDrawer,
  PmDot,
  PmEmpty,
  PmEmptyState,
  PmErrorBar,
  PmField,
  PmFilterPills,
  PmIcon,
  PmLoading,
  PmNotice,
  PmSelect,
  PmTag,
  PM_TEXTAREA,
  REQUIREMENT_PRIORITY_TONE,
  REQUIREMENT_STATUS_TONE,
  pmProjectHref,
  usePmFilter,
  usePmFilterText,
  usePmPlugin,
  usePmStore,
  type PmFilterOption,
} from './PmShared';

/** 每页条数默认 20（与测试统计一致），选择结果按页面记住 */
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_KEY = 'tw.pm-requirements.page-size.v1';

const STATUS_FILTERS: readonly (RequirementStatus | 'all')[] = ['all', ...REQUIREMENT_STATUSES];
const PRIORITY_FILTERS: readonly (RequirementPriority | 'all')[] = [
  'all',
  ...REQUIREMENT_PRIORITIES,
];

/** 筛选记忆的键：按数据空间各记各的 */
const FILTER_PROJECT = 'pm.requirements.project';
const FILTER_ITERATION = 'pm.requirements.iteration';
const FILTER_STATUS = 'pm.requirements.status';
const FILTER_PRIORITY = 'pm.requirements.priority';
const FILTER_KEYWORD = 'pm.requirements.keyword';

interface Draft {
  id?: string;
  projectId: string;
  iterationId: string;
  title: string;
  priority: RequirementPriority;
  status: RequirementStatus;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  githubIssue: string;
  attachment: string;
}

const PRIORITY_OPTIONS = REQUIREMENT_PRIORITIES.map((value) => ({
  value,
  label: REQUIREMENT_PRIORITY_LABEL[value],
}));

const STATUS_OPTIONS = REQUIREMENT_STATUSES.map((value) => ({
  value,
  label: REQUIREMENT_STATUS_LABEL[value],
}));

function emptyDraft(projectId = ''): Draft {
  return {
    projectId,
    iterationId: '',
    title: '',
    priority: 'medium',
    status: 'pending',
    description: '',
    acceptanceCriteria: [],
    githubIssue: '',
    attachment: '',
  };
}

interface PmRequirementsBoardProps {
  /** 项目详情页传入：锁定到当前项目，隐藏项目筛选与表单里的项目字段 */
  scopeProjectId?: string;
}

export default function PmRequirementsBoard({
  scopeProjectId = '',
}: PmRequirementsBoardProps = {}) {
  const scoped = Boolean(scopeProjectId);
  const gate = usePmPlugin('pmRequirements');
  const { store, live, loading, error, setError, reload } = usePmStore();
  const [projectId, setProjectId] = usePmFilterText(FILTER_PROJECT, 'all');
  const effectiveProjectId = scopeProjectId || projectId;
  const [iterationId, setIterationId] = usePmFilterText(FILTER_ITERATION, 'all');
  const [status, setStatus] = usePmFilter<RequirementStatus | 'all'>(
    FILTER_STATUS,
    STATUS_FILTERS,
    'all',
  );
  const [priority, setPriority] = usePmFilter<RequirementPriority | 'all'>(
    FILTER_PRIORITY,
    PRIORITY_FILTERS,
    'all',
  );
  const [keyword, setKeyword] = usePmFilterText(FILTER_KEYWORD);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(DEFAULT_PAGE_SIZE, PAGE_SIZE_KEY);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RequirementItem | null>(null);
  /** 这次抽屉里出现过的附件地址：点 X 移除的也算，关闭时交给服务端判断是否还有引用 */
  const seenUrlsRef = useRef<Set<string>>(new Set());

  const projectOptions = useMemo(
    () => [
      { value: 'all', label: '全部项目' },
      ...store.projects.map((p) => ({ value: p.id, label: p.name })),
    ],
    [store.projects],
  );

  const iterationOptions = useMemo(
    () => [
      { value: 'all', label: '全部迭代' },
      ...store.iterations
        .filter((it) => effectiveProjectId === 'all' || it.projectId === effectiveProjectId)
        .map((it) => ({ value: it.id, label: it.name })),
    ],
    [store.iterations, effectiveProjectId],
  );

  const projectName = useMemo(() => {
    const map = new Map(store.projects.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? '—';
  }, [store.projects]);

  const iterationName = useMemo(() => {
    const map = new Map(store.iterations.map((it) => [it.id, it.name]));
    return (id: string) => (id ? (map.get(id) ?? '—') : '—');
  }, [store.iterations]);

  const matched = useMemo(
    () =>
      filterRequirements(store.requirements, {
        projectId: effectiveProjectId,
        iterationId,
        status,
        priority,
        keyword,
      }),
    [store.requirements, effectiveProjectId, iterationId, status, priority, keyword],
  );
  const scopeTotal = scoped
    ? store.requirements.filter((rq) => rq.projectId === effectiveProjectId).length
    : store.requirements.length;
  const totalPages = Math.max(1, Math.ceil(matched.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = matched.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // 记住了上次的项目 / 迭代筛选：等数据真的拉回来再校验，别在首屏空 store 时把记忆清掉
  useEffect(() => {
    if (scoped) return;
    if (live !== true) return;
    if (projectId !== 'all' && !store.projects.some((p) => p.id === projectId)) setProjectId('all');
  }, [live, store.projects, projectId, setProjectId, scoped]);

  useEffect(() => {
    if (live !== true) return;
    if (
      iterationId !== 'all' &&
      !store.iterations.some(
        (it) =>
          it.id === iterationId &&
          (effectiveProjectId === 'all' || it.projectId === effectiveProjectId),
      )
    ) {
      setIterationId('all');
    }
  }, [live, store.iterations, effectiveProjectId, iterationId, setIterationId]);

  const draftIterations = draft
    ? store.iterations.filter((it) => it.projectId === draft.projectId)
    : [];

  async function save() {
    if (!draft) return;
    if (!draft.projectId) {
      setError('请先选择所属项目');
      return;
    }
    const title = draft.title.trim();
    if (!title) {
      setError('需求描述不能为空');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        projectId: draft.projectId,
        iterationId: draft.iterationId,
        title,
        priority: draft.priority,
        status: draft.status,
        description: draft.description,
        acceptanceCriteria: draft.acceptanceCriteria.filter((x) => x.text.trim()),
        githubIssue: draft.githubIssue,
        attachment: draft.attachment,
      };
      if (draft.id) await updatePmItem<RequirementItem>('requirements', draft.id, payload);
      else await createPmItems<RequirementItem>('requirements', [payload]);
      const editing = Boolean(draft.id);
      setDraft(null);
      // 保存后附件已被记录引用，不需要惦记清理
      seenUrlsRef.current.clear();
      setError('');
      await reload(true);
      showToast(editing ? '已保存需求' : '已新建需求', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`保存需求失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 关抽屉：这次传上来、后来被 X 掉或没保存的附件顺手清掉，避免空间里堆废文件 */
  function closeDraft() {
    const urls = [
      ...seenUrlsRef.current,
      ...parseAttachments(draft?.attachment ?? '').map((x) => x.url),
    ];
    seenUrlsRef.current.clear();
    setDraft(null);
    if (urls.length) void cleanupPmAttachments(urls);
  }

  async function patchStatus(item: RequirementItem, next: RequirementStatus) {
    setBusy(true);
    try {
      await updatePmItem<RequirementItem>('requirements', item.id, { status: next });
      await reload(true);
      showToast(`已更新需求状态为「${next}」`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`更新状态失败：${msg}`, 'error');
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
      await deletePmItems('requirements', [target.id]);
      await reload(true);
      showToast('已删除需求', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除需求失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!gate.ready) return <PmLoading label="正在读取插件开关" />;
  if (!gate.on) return <PmNotice>{pluginDisabledMessage('pmRequirements')}</PmNotice>;
  if (live === null) return <PmLoading label="正在连接项目管理服务" />;
  if (!live) {
    return (
      <PmNotice>需求管理需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。</PmNotice>
    );
  }
  if (store.projects.length === 0 && !loading && !scoped) {
    return <PmNotice>还没有项目。请先在「项目列表」里新建一个项目，再回来维护需求。</PmNotice>;
  }

  const statusPills: readonly PmFilterOption<RequirementStatus | 'all'>[] = [
    { value: 'all', label: '全部' },
    ...STATUS_OPTIONS,
  ];

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="text-xs text-stone-400">
          共 <span className="font-medium text-stone-600">{scopeTotal}</span> 条需求
          {matched.length !== scopeTotal ? ` · 筛选出 ${matched.length} 条` : ''}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {scoped ? null : (
            <SelectDropdown
              flat
              showCheck={false}
              ariaLabel="按项目筛选需求"
              className="w-36"
              options={projectOptions}
              value={projectId}
              onChange={(v) => {
                setProjectId(v);
                setIterationId('all');
                setPage(1);
              }}
            />
          )}
          <SelectDropdown
            flat
            showCheck={false}
            ariaLabel="按迭代筛选需求"
            className="w-32"
            options={iterationOptions}
            value={iterationId}
            onChange={(v) => {
              setIterationId(v);
              setPage(1);
            }}
          />
          <SelectDropdown
            flat
            showCheck={false}
            ariaLabel="按优先级筛选需求"
            className="w-28"
            options={[{ value: 'all', label: '全部优先级' }, ...PRIORITY_OPTIONS]}
            value={priority}
            onChange={(v) => {
              setPriority(v as RequirementPriority | 'all');
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
              placeholder="搜索编号 / 名称…"
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
            新建需求
          </button>
        </div>
      </div>

      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
        <PmFilterPills
          ariaLabel="按状态筛选需求"
          options={statusPills}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
      </div>

      {error ? <PmErrorBar message={error} onClose={() => setError('')} /> : null}

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="tw-data-table w-full border-collapse text-sm">
            <thead className="tw-table-head sticky top-0 z-10 text-xs text-stone-500">
              <tr>
                <th className="w-24 px-4 py-2.5 text-left font-medium whitespace-nowrap">ID</th>
                <th className="px-4 py-2.5 text-left font-medium">需求描述</th>
                <th className="w-24 px-3 py-2.5 text-left font-medium whitespace-nowrap">优先级</th>
                <th className="w-32 px-3 py-2.5 text-left font-medium whitespace-nowrap">
                  需求状态
                </th>
                {scoped ? null : (
                  <th className="w-40 px-3 py-2.5 text-left font-medium whitespace-nowrap">
                    所属项目
                  </th>
                )}
                <th className="w-40 px-3 py-2.5 text-left font-medium whitespace-nowrap">
                  所属迭代
                </th>
                <th className="w-24 px-3 py-2.5 text-center font-medium whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && !store.requirements.length ? (
                <tr>
                  <td colSpan={scoped ? 6 : 7} className="px-4 py-16 text-center">
                    <span className="tw-lib-spin" aria-hidden="true" />
                  </td>
                </tr>
              ) : pageItems.length === 0 ? (
                <tr>
                  <td colSpan={scoped ? 6 : 7}>
                    {scopeTotal ? (
                      <PmEmpty>没有符合筛选条件的需求。</PmEmpty>
                    ) : (
                      <PmEmptyState
                        icon="file"
                        title="暂无需求"
                        hint="拆出第一条需求，再关联迭代、补充描述。"
                        action={
                          <button
                            type="button"
                            onClick={() =>
                              setDraft(
                                emptyDraft(effectiveProjectId === 'all' ? '' : effectiveProjectId),
                              )
                            }
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stone-200 px-3 text-xs text-stone-600 transition-colors hover:bg-stone-50"
                          >
                            <PmIcon name="plus" size={13} />
                            新建需求
                          </button>
                        }
                      />
                    )}
                  </td>
                </tr>
              ) : null}
              {pageItems.map((item) => (
                <tr key={item.id} className="border-t border-stone-100 hover:bg-[#f7f8fa]">
                  <td className="px-4 py-2.5 font-mono text-xs text-stone-400">{item.autoId}</td>
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() =>
                        setDraft({
                          id: item.id,
                          projectId: item.projectId,
                          iterationId: item.iterationId,
                          title: item.title,
                          priority: item.priority,
                          status: item.status,
                          description: item.description,
                          acceptanceCriteria: item.acceptanceCriteria.map((x) => ({ ...x })),
                          githubIssue: item.githubIssue,
                          attachment: item.attachment,
                        })
                      }
                      className="max-w-full truncate text-left text-stone-800 hover:text-[#3370ff]"
                    >
                      {item.title}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <PmTag tone={REQUIREMENT_PRIORITY_TONE[item.priority]}>
                      {REQUIREMENT_PRIORITY_LABEL[item.priority]}
                    </PmTag>
                  </td>
                  <td className="px-3 py-2.5">
                    <SelectDropdown
                      unstyled
                      ariaLabel={`修改 ${item.title} 的状态`}
                      disabled={busy}
                      options={STATUS_OPTIONS}
                      value={item.status}
                      onChange={(v) => void patchStatus(item, v)}
                      renderOptionPrefix={(o) => <PmDot tone={REQUIREMENT_STATUS_TONE[o.value]} />}
                      renderTrigger={() => (
                        <PmTag tone={REQUIREMENT_STATUS_TONE[item.status]}>
                          {REQUIREMENT_STATUS_LABEL[item.status]}
                        </PmTag>
                      )}
                    />
                  </td>
                  {scoped ? null : (
                    <td className="truncate px-3 py-2.5 text-sm text-stone-600">
                      <a
                        href={pmProjectHref(item.projectId)}
                        className="transition-colors hover:text-[#3370ff]"
                      >
                        {projectName(item.projectId)}
                      </a>
                    </td>
                  )}
                  <td className="truncate px-3 py-2.5 text-sm text-stone-500">
                    {iterationName(item.iterationId)}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <button
                      type="button"
                      aria-label={`删除 ${item.title}`}
                      disabled={busy}
                      onClick={() => setDeleteTarget(item)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-300 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                    >
                      <PmIcon name="trash" size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {matched.length > 0 ? (
          <DocsPager
            page={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            busy={busy}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        ) : null}
      </div>

      <PmDrawer
        open={draft !== null}
        title={draft?.id ? '编辑需求' : '新建需求'}
        busy={busy}
        submitLabel={draft?.id ? '保存' : '创建'}
        onClose={() => closeDraft()}
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
                  onChange={(v) => {
                    const belongs = store.iterations.some(
                      (it) => it.id === draft.iterationId && it.projectId === v,
                    );
                    setDraft({
                      ...draft,
                      projectId: v,
                      iterationId: belongs ? draft.iterationId : '',
                    });
                  }}
                />
              </PmField>
            )}
            <PmField label="所属迭代">
              <PmSelect
                ariaLabel="所属迭代"
                options={[
                  { value: '', label: '不关联迭代' },
                  ...draftIterations.map((it) => ({ value: it.id, label: it.name })),
                ]}
                value={draft.iterationId}
                onChange={(v) => setDraft({ ...draft, iterationId: v })}
                disabled={draftIterations.length === 0}
              />
            </PmField>
            <PmField label="需求描述" required>
              <textarea
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="一句话写清要做什么"
                rows={3}
                className={PM_TEXTAREA}
              />
            </PmField>
            <PmField label="优先级">
              <PmSelect
                ariaLabel="优先级"
                options={PRIORITY_OPTIONS}
                value={draft.priority}
                onChange={(v) => setDraft({ ...draft, priority: v })}
                renderOptionPrefix={(o) => <PmDot tone={REQUIREMENT_PRIORITY_TONE[o.value]} />}
              />
            </PmField>
            <PmField label="需求状态">
              <PmSelect
                ariaLabel="需求状态"
                options={STATUS_OPTIONS}
                value={draft.status}
                onChange={(v) => setDraft({ ...draft, status: v })}
                renderOptionPrefix={(o) => <PmDot tone={REQUIREMENT_STATUS_TONE[o.value]} />}
              />
            </PmField>
            <PmField label="附件">
              <PmAttachmentField
                value={draft.attachment}
                onChange={(next) => setDraft((cur) => (cur ? { ...cur, attachment: next } : cur))}
                entity="requirements"
                recordId={draft.id ?? ''}
                seenUrls={seenUrlsRef}
                onError={setError}
                onPersisted={() => void reload(true)}
              />
            </PmField>
            <PmField label="备注">
              <textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="补充背景、目标与范围（可选）"
                rows={4}
                className={PM_TEXTAREA}
              />
            </PmField>
          </div>
        ) : null}
      </PmDrawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除需求"
        message={`确定删除「${deleteTarget?.title ?? ''}」？关联的缺陷会保留，但不再关联到这条需求。`}
        confirmLabel="删除"
        danger="solid"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
