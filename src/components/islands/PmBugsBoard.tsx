/**
 * 缺陷管理：表格 + 项目 / 迭代 / 状态 / 严重程度筛选。
 *
 * 编号（BUG-001）由服务端分配；状态可在行内直接改。
 * 关联需求只在同一项目下选择，切项目会清空迭代与需求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  BUG_SEVERITIES,
  BUG_SEVERITY_LABEL,
  BUG_STATUSES,
  BUG_STATUS_LABEL,
  bugTitleFromDescription,
  cleanupPmAttachments,
  createPmItems,
  deletePmItems,
  filterBugs,
  joinAttachments,
  parseAttachments,
  sortBugsNewestFirst,
  sortIterationsNewestFirst,
  updatePmItem,
  uploadPmFiles,
  type BugItem,
  type BugSeverity,
  type BugStatus,
} from '../../lib/pm';
import { pluginDisabledMessage } from '../../lib/plugins';
import ConfirmDialog from './ConfirmDialog';
import DocsPager, { usePageSize } from './DocsPager';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';
import {
  BUG_SEVERITY_TONE,
  BUG_STATUS_TONE,
  PmDrawer,
  PmDot,
  PmEmpty,
  PmEmptyState,
  PmErrorBar,
  PmField,
  PmFilterPills,
  PmIcon,
  PmImagePreview,
  PmLoading,
  PmNotice,
  PmSelect,
  PmTag,
  PM_TEXTAREA,
  pmProjectHref,
  usePmFilter,
  usePmFilterText,
  usePmPlugin,
  usePmStore,
  type PmFilterOption,
} from './PmShared';

/** 每页条数默认 20（与测试统计一致），选择结果按页面记住 */
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_KEY = 'tw.pm-bugs.page-size.v1';

const STATUS_FILTERS: readonly (BugStatus | 'all')[] = ['all', ...BUG_STATUSES];
const SEVERITY_FILTERS: readonly (BugSeverity | 'all')[] = ['all', ...BUG_SEVERITIES];

/** 筛选记忆的键：按数据空间各记各的 */
const FILTER_PROJECT = 'pm.bugs.project';
const FILTER_ITERATION = 'pm.bugs.iteration';
const FILTER_STATUS = 'pm.bugs.status';
const FILTER_SEVERITY = 'pm.bugs.severity';
const FILTER_KEYWORD = 'pm.bugs.keyword';

interface Draft {
  id?: string;
  projectId: string;
  iterationId: string;
  requirementId: string;
  title: string;
  severity: BugSeverity;
  status: BugStatus;
  reproduceSteps: string;
  expectedResult: string;
  actualResult: string;
  environment: string;
  githubIssue: string;
  attachment: string;
  remark: string;
}

const SEVERITY_OPTIONS = BUG_SEVERITIES.map((value) => ({
  value,
  label: BUG_SEVERITY_LABEL[value],
}));

const STATUS_OPTIONS = BUG_STATUSES.map((value) => ({
  value,
  label: BUG_STATUS_LABEL[value],
}));

function emptyDraft(projectId = ''): Draft {
  return {
    projectId,
    iterationId: '',
    requirementId: '',
    title: '',
    severity: 'minor',
    status: 'pending',
    reproduceSteps: '',
    expectedResult: '',
    actualResult: '',
    environment: '',
    githubIssue: '',
    attachment: '',
    remark: '',
  };
}

function isImageAttachment(url: string): boolean {
  try {
    const p = new URL(url, 'http://localhost').searchParams.get('p') ?? '';
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
  } catch {
    return false;
  }
}

interface PmBugsBoardProps {
  /** 项目详情页传入：锁定到当前项目，隐藏项目筛选与表单里的项目字段 */
  scopeProjectId?: string;
}

export default function PmBugsBoard({ scopeProjectId = '' }: PmBugsBoardProps = {}) {
  const scoped = Boolean(scopeProjectId);
  const gate = usePmPlugin('bugs');
  const { store, live, loading, error, setError, reload } = usePmStore();
  const [projectId, setProjectId] = usePmFilterText(FILTER_PROJECT, 'all');
  const effectiveProjectId = scopeProjectId || projectId;
  const [iterationId, setIterationId] = usePmFilterText(FILTER_ITERATION, 'all');
  const [status, setStatus] = usePmFilter<BugStatus | 'all'>(FILTER_STATUS, STATUS_FILTERS, 'all');
  const [severity, setSeverity] = usePmFilter<BugSeverity | 'all'>(
    FILTER_SEVERITY,
    SEVERITY_FILTERS,
    'all',
  );
  const [keyword, setKeyword] = usePmFilterText(FILTER_KEYWORD);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(DEFAULT_PAGE_SIZE, PAGE_SIZE_KEY);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 这次抽屉里出现过的附件地址：点 X 移除的也算，关闭时交给服务端判断是否还有引用 */
  const seenUrlsRef = useRef<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<BugItem | null>(null);
  /** 页内预览的附件图片（不跳新标签） */
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const attachments = useMemo(() => parseAttachments(draft?.attachment ?? ''), [draft?.attachment]);

  useEffect(() => {
    for (const file of attachments) seenUrlsRef.current.add(file.url);
  }, [attachments]);

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
      sortBugsNewestFirst(
        filterBugs(store.bugs, {
          projectId: effectiveProjectId,
          iterationId,
          status,
          severity,
          keyword,
        }),
      ),
    [store.bugs, effectiveProjectId, iterationId, status, severity, keyword],
  );
  const scopeTotal = scoped
    ? store.bugs.filter((bug) => bug.projectId === effectiveProjectId).length
    : store.bugs.length;
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

  // 新建缺陷时迭代下拉按时间倒序，最新的排最前（BUG-010）
  const draftIterations = draft
    ? sortIterationsNewestFirst(store.iterations.filter((it) => it.projectId === draft.projectId))
    : [];
  const draftRequirements = draft
    ? store.requirements.filter((rq) => rq.projectId === draft.projectId)
    : [];

  async function save() {
    if (!draft) return;
    if (!draft.projectId) {
      setError('请先选择所属项目');
      return;
    }
    const description = draft.reproduceSteps.trim();
    if (!description) {
      setError('缺陷描述不能为空');
      return;
    }
    // 标题不再单独填写：取描述第一行，表格 / 搜索仍按标题展示
    const title = bugTitleFromDescription(description);
    setBusy(true);
    try {
      const payload = {
        projectId: draft.projectId,
        iterationId: draft.iterationId,
        requirementId: draft.requirementId,
        title,
        severity: draft.severity,
        status: draft.status,
        reproduceSteps: description,
        expectedResult: draft.expectedResult,
        actualResult: draft.actualResult,
        environment: draft.environment,
        githubIssue: draft.githubIssue,
        attachment: draft.attachment,
        remark: draft.remark,
      };
      if (draft.id) await updatePmItem<BugItem>('bugs', draft.id, payload);
      else await createPmItems<BugItem>('bugs', [payload]);
      const editing = Boolean(draft.id);
      setDraft(null);
      // 保存后附件已被记录引用，不需要惦记清理
      seenUrlsRef.current.clear();
      setError('');
      await reload(true);
      showToast(editing ? '已保存缺陷' : '已新建缺陷', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`保存缺陷失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  const addFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || !files.length) return;
      setUploading(true);
      try {
        const uploaded = await uploadPmFiles(Array.from(files));
        setDraft((cur) => {
          if (!cur) return cur;
          const list = parseAttachments(cur.attachment);
          return { ...cur, attachment: joinAttachments([...list, ...uploaded]) };
        });
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [setError],
  );

  // 抽屉打开时监听粘贴：截图 / 图片直接追加到附件，不用先存成文件再选
  const drawerOpen = draft !== null;
  useEffect(() => {
    if (!drawerOpen) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void addFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [drawerOpen, addFiles]);

  /** 点 X：立刻从这条缺陷上移除并删掉磁盘文件（别的缺陷还在用时服务端会保留） */
  async function removeAttachment(url: string) {
    if (!draft) return;
    const next = joinAttachments(attachments.filter((x) => x.url !== url));
    // 编辑已有缺陷时先把记录改掉，避免「文件删了、记录还指着它」
    if (draft.id) {
      try {
        await updatePmItem<BugItem>('bugs', draft.id, { attachment: next });
        await reload(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setDraft((cur) => (cur ? { ...cur, attachment: next } : cur));
    void cleanupPmAttachments([url], draft.id ?? '');
  }

  /** 关抽屉：这次传上来、后来被 X 掉或没保存的附件顺手清掉，避免空间里堆废文件 */
  function closeDraft() {
    const urls = [...seenUrlsRef.current, ...attachments.map((x) => x.url)];
    seenUrlsRef.current.clear();
    setDraft(null);
    if (urls.length) void cleanupPmAttachments(urls);
  }

  async function patchStatus(item: BugItem, next: BugStatus) {
    setBusy(true);
    try {
      await updatePmItem<BugItem>('bugs', item.id, { status: next });
      await reload(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      await deletePmItems('bugs', [target.id]);
      await reload(true);
      showToast('已删除缺陷', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除缺陷失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!gate.ready) return <PmLoading label="正在读取插件开关" />;
  if (!gate.on) return <PmNotice>{pluginDisabledMessage('bugs')}</PmNotice>;
  if (live === null) return <PmLoading label="正在连接项目管理服务" />;
  if (!live) {
    return (
      <PmNotice>缺陷管理需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。</PmNotice>
    );
  }
  if (store.projects.length === 0 && !loading && !scoped) {
    return <PmNotice>还没有项目。请先在「项目列表」里新建一个项目，再回来记录缺陷。</PmNotice>;
  }

  const statusPills: readonly PmFilterOption<BugStatus | 'all'>[] = [
    { value: 'all', label: '全部' },
    ...STATUS_OPTIONS,
  ];

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="text-xs text-stone-400">
          共 <span className="font-medium text-stone-600">{scopeTotal}</span> 条缺陷
          {matched.length !== scopeTotal ? ` · 筛选出 ${matched.length} 条` : ''}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {scoped ? null : (
            <SelectDropdown
              flat
              showCheck={false}
              ariaLabel="按项目筛选缺陷"
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
            ariaLabel="按迭代筛选缺陷"
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
            ariaLabel="按严重程度筛选缺陷"
            className="w-32"
            options={[{ value: 'all', label: '全部严重程度' }, ...SEVERITY_OPTIONS]}
            value={severity}
            onChange={(v) => {
              setSeverity(v as BugSeverity | 'all');
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
              placeholder="搜索编号 / 标题…"
              className="h-9 w-48 rounded-lg border border-stone-200 bg-white pl-8 pr-3 text-sm text-stone-800 outline-none transition-colors focus:border-[#3370ff]"
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
            新建缺陷
          </button>
        </div>
      </div>

      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
        <PmFilterPills
          ariaLabel="按状态筛选缺陷"
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
                <th className="w-px px-4 py-2.5 text-left font-medium whitespace-nowrap">ID</th>
                <th className="px-4 py-2.5 text-left font-medium">缺陷标题</th>
                <th className="w-28 px-3 py-2.5 text-left font-medium whitespace-nowrap">
                  严重程度
                </th>
                <th className="w-32 px-3 py-2.5 text-left font-medium whitespace-nowrap">
                  缺陷状态
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
              {loading && !store.bugs.length ? (
                <tr>
                  <td colSpan={scoped ? 6 : 7} className="px-4 py-16 text-center">
                    <span className="tw-lib-spin" aria-hidden="true" />
                  </td>
                </tr>
              ) : pageItems.length === 0 ? (
                <tr>
                  <td colSpan={scoped ? 6 : 7}>
                    {scopeTotal ? (
                      <PmEmpty>没有符合筛选条件的缺陷。</PmEmpty>
                    ) : (
                      <PmEmptyState
                        icon="bug"
                        title="暂无缺陷"
                        hint="记录第一个缺陷，跟踪严重程度与修复状态。"
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
                            新建缺陷
                          </button>
                        }
                      />
                    )}
                  </td>
                </tr>
              ) : null}
              {pageItems.map((item) => (
                <tr key={item.id} className="border-t border-stone-100 hover:bg-[#f7f8fa]">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-stone-400">
                    {item.autoId}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() =>
                        setDraft({
                          id: item.id,
                          projectId: item.projectId,
                          iterationId: item.iterationId,
                          requirementId: item.requirementId,
                          title: item.title,
                          severity: item.severity,
                          status: item.status,
                          reproduceSteps: item.reproduceSteps || item.title,
                          expectedResult: item.expectedResult,
                          actualResult: item.actualResult,
                          environment: item.environment,
                          githubIssue: item.githubIssue,
                          attachment: item.attachment,
                          remark: item.remark,
                        })
                      }
                      className="max-w-full truncate text-left text-stone-800 hover:text-[#3370ff]"
                    >
                      {item.title}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <PmTag tone={BUG_SEVERITY_TONE[item.severity]}>
                      {BUG_SEVERITY_LABEL[item.severity]}
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
                      renderOptionPrefix={(o) => <PmDot tone={BUG_STATUS_TONE[o.value]} />}
                      renderTrigger={() => (
                        <PmTag tone={BUG_STATUS_TONE[item.status]}>
                          {BUG_STATUS_LABEL[item.status]}
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
                      className="tw-icon-danger inline-flex h-7 w-7 items-center justify-center rounded-md"
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
        title={draft?.id ? '编辑缺陷' : '新建缺陷'}
        busy={busy}
        submitLabel={draft?.id ? '保存' : '创建'}
        onClose={closeDraft}
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
                  onChange={(v) =>
                    setDraft({ ...draft, projectId: v, iterationId: '', requirementId: '' })
                  }
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
            <PmField label="关联需求">
              <PmSelect
                ariaLabel="关联需求"
                options={[
                  { value: '', label: '不关联需求' },
                  ...draftRequirements.map((rq) => ({
                    value: rq.id,
                    label: `${rq.autoId} ${rq.title}`,
                  })),
                ]}
                value={draft.requirementId}
                onChange={(v) => setDraft({ ...draft, requirementId: v })}
                disabled={draftRequirements.length === 0}
              />
            </PmField>
            <PmField label="缺陷描述" required>
              <textarea
                autoFocus
                value={draft.reproduceSteps}
                onChange={(e) => setDraft({ ...draft, reproduceSteps: e.target.value })}
                placeholder="描述问题现象、复现步骤与影响范围"
                rows={5}
                className={PM_TEXTAREA}
              />
            </PmField>
            <PmField label="严重程度">
              <PmSelect
                ariaLabel="严重程度"
                options={SEVERITY_OPTIONS}
                value={draft.severity}
                onChange={(v) => setDraft({ ...draft, severity: v })}
                renderOptionPrefix={(o) => <PmDot tone={BUG_SEVERITY_TONE[o.value]} />}
              />
            </PmField>
            <PmField label="附件">
              <div className="space-y-2">
                {attachments.length ? (
                  <ul className="space-y-1.5">
                    {attachments.map((file) => {
                      const image = isImageAttachment(file.url);
                      return (
                        <li
                          key={file.url}
                          className="flex items-center gap-2 rounded-lg border border-stone-200 px-2 py-1.5"
                        >
                          {image ? (
                            <button
                              type="button"
                              onClick={() => setPreview(file)}
                              aria-label={`预览附件 ${file.name}`}
                              className="shrink-0 cursor-zoom-in"
                            >
                              <img
                                src={file.url}
                                alt={file.name}
                                className="h-9 w-9 rounded-md border border-stone-100 object-cover"
                              />
                            </button>
                          ) : (
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-400">
                              <PmIcon name="file" size={15} />
                            </span>
                          )}
                          {image ? (
                            <button
                              type="button"
                              onClick={() => setPreview(file)}
                              className="min-w-0 flex-1 truncate text-left text-sm text-stone-700 hover:text-[#3370ff]"
                            >
                              {file.name}
                            </button>
                          ) : (
                            <a
                              href={file.url}
                              target="_blank"
                              rel="noreferrer"
                              className="min-w-0 flex-1 truncate text-sm text-stone-700 hover:text-[#3370ff]"
                            >
                              {file.name}
                            </a>
                          )}
                          <button
                            type="button"
                            aria-label={`移除附件 ${file.name}`}
                            onClick={() => removeAttachment(file.url)}
                            className="tw-icon-danger flex h-6 w-6 shrink-0 items-center justify-center rounded"
                          >
                            ✕
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void addFiles(e.target.files)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-stone-300 px-2.5 text-xs text-stone-500 transition-colors hover:border-stone-400 hover:text-stone-700 disabled:opacity-40"
                  >
                    <PmIcon name={uploading ? 'file' : 'plus'} size={13} />
                    {uploading ? '上传中…' : '上传文件 / 图片'}
                  </button>
                  <span className="text-xs text-stone-400">
                    可直接粘贴截图 / 图片（⌘V / Ctrl+V），支持多张
                  </span>
                </div>
              </div>
            </PmField>
            <PmField label="备注">
              <textarea
                value={draft.remark}
                onChange={(e) => setDraft({ ...draft, remark: e.target.value })}
                rows={2}
                className={PM_TEXTAREA}
              />
            </PmField>
          </div>
        ) : null}
      </PmDrawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除缺陷"
        message={`确定删除「${deleteTarget?.title ?? ''}」？此操作无法恢复。`}
        confirmLabel="删除"
        danger="solid"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />

      <PmImagePreview file={preview} onClose={() => setPreview(null)} />
    </section>
  );
}
