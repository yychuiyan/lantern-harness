/**
 * 项目列表：卡片网格 + 状态筛选 + 搜索 + 归档 / 删除。
 *
 * 每个项目下汇总迭代、需求与缺陷数量；删除项目会连带删掉它的迭代 / 需求 / 缺陷，
 * 所以确认文案里要写清楚。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  createPmItems,
  deletePmItems,
  filterProjects,
  projectStats,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABEL,
  updatePmItem,
  type ProjectItem,
  type ProjectStatus,
} from '../../lib/pm';
import ConfirmDialog from './ConfirmDialog';
import SelectDropdown from './SelectDropdown';
import {
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
  PmTag,
  PM_INPUT,
  PM_TEXTAREA,
  PROJECT_STATUS_TONE,
  pmProjectHref,
  usePmFilter,
  usePmFilterText,
  usePmPlugin,
  usePmStore,
} from './PmShared';
import { pluginDisabledMessage } from '../../lib/plugins';

/** 与 luckytask 一致：固定每页 10 条，翻页条只在多页时出现 */
const PAGE_SIZE = 10;

interface Draft {
  id?: string;
  name: string;
  description: string;
  status: ProjectStatus;
}

const STATUS_OPTIONS = PROJECT_STATUSES.map((value) => ({
  value,
  label: PROJECT_STATUS_LABEL[value],
}));

const STATUS_FILTERS: readonly (ProjectStatus | 'all')[] = ['all', ...PROJECT_STATUSES];

/** 筛选记忆的键：按数据空间各记各的 */
const FILTER_STATUS = 'pm.projects.status';
const FILTER_KEYWORD = 'pm.projects.keyword';

function emptyDraft(): Draft {
  return { name: '', description: '', status: 'planning' };
}

export default function PmProjectsBoard() {
  const gate = usePmPlugin('projects');
  const { store, live, loading, error, setError, reload } = usePmStore();
  const [status, setStatus] = usePmFilter<ProjectStatus | 'all'>(
    FILTER_STATUS,
    STATUS_FILTERS,
    'all',
  );
  const [keyword, setKeyword] = usePmFilterText(FILTER_KEYWORD);
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectItem | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const stats = useMemo(() => projectStats(store), [store]);
  const matched = useMemo(
    () => filterProjects(store.projects, { status, keyword }),
    [store.projects, status, keyword],
  );
  const totalPages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = matched.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // 菜单点外面关闭
  useEffect(() => {
    if (!menuId) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuId(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuId(null);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuId]);

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError('项目名称不能为空');
      return;
    }
    setBusy(true);
    try {
      if (draft.id) {
        await updatePmItem<ProjectItem>('projects', draft.id, {
          name,
          description: draft.description,
          status: draft.status,
        });
      } else {
        await createPmItems<ProjectItem>('projects', [
          { name, description: draft.description, status: draft.status },
        ]);
      }
      setDraft(null);
      setError('');
      await reload(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(item: ProjectItem) {
    setMenuId(null);
    setBusy(true);
    try {
      await updatePmItem<ProjectItem>('projects', item.id, {
        status: item.status === 'archived' ? 'planning' : 'archived',
      });
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
      await deletePmItems('projects', [target.id]);
      await reload(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!gate.ready) return <PmLoading label="正在读取插件开关" />;
  if (!gate.on) return <PmNotice>{pluginDisabledMessage('projects')}</PmNotice>;
  if (live === null) return <PmLoading label="正在连接项目管理服务" />;
  if (!live) {
    return (
      <PmNotice>项目列表需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。</PmNotice>
    );
  }

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="text-xs text-stone-400">
          {store.projects.length ? (
            <>
              共 <span className="font-medium text-stone-600">{store.projects.length}</span> 个项目
              {matched.length !== store.projects.length ? ` · 筛选出 ${matched.length} 个` : ''}
            </>
          ) : (
            '暂无项目'
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SelectDropdown
            flat
            showCheck={false}
            ariaLabel="按状态筛选项目"
            className="w-32"
            options={[{ value: 'all', label: '全部状态' }, ...STATUS_OPTIONS]}
            value={status}
            onChange={(v) => {
              setStatus(v as ProjectStatus | 'all');
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
              placeholder="搜索项目名称 / 描述…"
              className="h-9 w-52 rounded-lg border border-stone-200 bg-white pl-8 pr-3 text-sm text-stone-800 outline-none transition-colors focus:border-[#3370ff]"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDraft(emptyDraft())}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white transition-colors hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            <PmIcon name="plus" size={14} />
            新建项目
          </button>
        </div>
      </div>

      {error ? <PmErrorBar message={error} onClose={() => setError('')} /> : null}

      <div className="mt-4 min-h-0 flex-1 overflow-auto pt-1 pb-4">
        {loading && !store.projects.length ? (
          <div className="flex min-h-[200px] items-center justify-center">
            <span className="tw-lib-spin" aria-hidden="true" />
          </div>
        ) : pageItems.length === 0 ? (
          store.projects.length ? (
            <PmEmpty>没有符合筛选条件的项目。</PmEmpty>
          ) : (
            <PmEmptyState
              icon="folder"
              title="暂无项目"
              hint="创建第一个项目开始吧"
              action={
                <button
                  type="button"
                  onClick={() => setDraft(emptyDraft())}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stone-200 px-3 text-xs text-stone-600 transition-colors hover:bg-stone-50"
                >
                  <PmIcon name="plus" size={13} />
                  新建项目
                </button>
              }
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pageItems.map((item) => {
              const stat = stats[item.id];
              return (
                <article
                  key={item.id}
                  className="tw-pm-card group relative rounded-2xl border border-stone-200 bg-white"
                >
                  <span
                    className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl"
                    aria-hidden="true"
                  >
                    <span className="tw-pm-card-accent absolute -right-6 -top-6 h-20 w-20 rounded-full bg-[#f1edff]" />
                  </span>
                  <a
                    href={pmProjectHref(item.id)}
                    aria-label={`打开项目 ${item.name}`}
                    className="absolute inset-0 z-0 rounded-2xl"
                  />
                  <div className="pointer-events-none relative z-10 flex h-full flex-col p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="tw-pm-tile flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-xs font-bold">
                          {item.name.slice(0, 1)}
                        </span>
                        <h3 className="truncate text-[15px] font-semibold text-stone-800">
                          {item.name}
                        </h3>
                      </div>
                      <PmTag tone={PROJECT_STATUS_TONE[item.status]}>
                        {PROJECT_STATUS_LABEL[item.status]}
                      </PmTag>
                    </div>

                    <p
                      className={`mt-3 line-clamp-2 min-h-[40px] text-sm ${
                        item.description ? 'text-stone-500' : 'italic text-stone-300'
                      }`}
                    >
                      {item.description || '暂无描述'}
                    </p>

                    <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-stone-500">
                      <span>{stat?.iterations ?? 0} 迭代</span>
                      <span className="text-stone-300">·</span>
                      <span>{stat?.requirements ?? 0} 需求</span>
                      <span className="text-stone-300">·</span>
                      <span>{stat?.bugs ?? 0} 缺陷</span>
                    </div>

                    <div className="mt-auto flex items-center justify-between pt-4">
                      <div
                        className="pointer-events-auto relative"
                        ref={menuId === item.id ? menuRef : undefined}
                      >
                        <button
                          type="button"
                          aria-label={`${item.name} 的操作`}
                          aria-haspopup="menu"
                          aria-expanded={menuId === item.id}
                          onClick={() => setMenuId(menuId === item.id ? null : item.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
                        >
                          <PmIcon name="more" size={18} />
                        </button>
                        {menuId === item.id ? (
                          <div
                            role="menu"
                            className="absolute left-0 top-9 z-30 w-36 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenuId(null);
                                setDraft({
                                  id: item.id,
                                  name: item.name,
                                  description: item.description,
                                  status: item.status,
                                });
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                            >
                              <PmIcon name="pencil" size={14} />
                              编辑
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => void toggleArchive(item)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                            >
                              <PmIcon name="folder" size={14} />
                              {item.status === 'archived' ? '取消归档' : '归档'}
                            </button>
                            <div className="my-1 border-t border-stone-100" />
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenuId(null);
                                setDeleteTarget(item);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                            >
                              <PmIcon name="trash" size={14} />
                              删除
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <span className="flex items-center gap-1.5 text-xs text-stone-400">
                        需求完成 {stat?.requirementPercent ?? 0}%
                        <PmIcon
                          name="chevronRight"
                          size={14}
                          className="tw-pm-card-chevron text-stone-300"
                        />
                      </span>
                    </div>
                  </div>
                </article>
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
        title={draft?.id ? '编辑项目' : '新建项目'}
        busy={busy}
        submitLabel={draft?.id ? '保存' : '创建'}
        onClose={() => setDraft(null)}
        onSubmit={() => void save()}
      >
        {draft ? (
          <div className="space-y-1">
            <PmField label="项目名称" required>
              <input
                autoFocus
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="输入项目名称"
                className={PM_INPUT}
              />
            </PmField>
            <PmField label="描述">
              <textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="项目描述（可选）"
                rows={4}
                className={PM_TEXTAREA}
              />
            </PmField>
            <PmField label="状态">
              <SelectDropdown
                ariaLabel="项目状态"
                options={STATUS_OPTIONS}
                value={draft.status}
                onChange={(v) => setDraft({ ...draft, status: v })}
                renderOptionPrefix={(o) => <PmDot tone={PROJECT_STATUS_TONE[o.value]} />}
              />
            </PmField>
          </div>
        ) : null}
      </PmDrawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除项目"
        message={`确定删除「${deleteTarget?.name ?? ''}」？该项目下的迭代、需求与缺陷会一并删除，且无法恢复。`}
        confirmLabel="删除"
        cancelLabel="取消"
        danger="solid"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
