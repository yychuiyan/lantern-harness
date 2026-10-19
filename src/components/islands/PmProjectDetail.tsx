/**
 * 项目详情（二级页面）：项目头部 + 迭代 / 需求 / 缺陷三个页签。
 *
 * 静态输出下没有动态路由，项目 id 通过 `?id=` 传入；三个页签复用四个看板里已有的
 * 迭代 / 需求 / 缺陷组件，并锁定到当前项目，避免 CRUD 表单写三遍。
 */
import { useEffect, useMemo, useState } from 'react';

import { projectStats, PROJECT_STATUS_LABEL, type ProjectStatus } from '../../lib/pm';
import { pluginDisabledMessage } from '../../lib/plugins';
import PmBugsBoard from './PmBugsBoard';
import PmIterationsBoard from './PmIterationsBoard';
import PmRequirementsBoard from './PmRequirementsBoard';
import {
  PmEmptyState,
  PmIcon,
  PmLoading,
  PmNotice,
  PmStoreProvider,
  PmTabs,
  PmTag,
  PROJECT_STATUS_TONE,
  usePmFilter,
  usePmPlugin,
  usePmStore,
} from './PmShared';

const DETAIL_TABS = ['iterations', 'requirements', 'bugs'] as const;
type DetailTab = (typeof DETAIL_TABS)[number];
const FILTER_TAB = 'pm.project.tab';

const base = import.meta.env.BASE_URL || '/';
const PROJECTS_HREF = `${base}pm/projects/`;

export default function PmProjectDetail() {
  const gate = usePmPlugin('projects');
  if (!gate.ready) return <PmLoading label="正在读取插件开关" />;
  if (!gate.on) return <PmNotice>{pluginDisabledMessage('projects')}</PmNotice>;
  return (
    <PmStoreProvider>
      <ProjectDetailBody />
    </PmStoreProvider>
  );
}

function ProjectDetailBody() {
  const { store, live, loading } = usePmStore();
  const [projectId, setProjectId] = useState('');
  const [tab, setTab] = usePmFilter<DetailTab>(FILTER_TAB, DETAIL_TABS, 'iterations');

  useEffect(() => {
    setProjectId(new URLSearchParams(window.location.search).get('id') ?? '');
  }, []);

  const project = useMemo(
    () => store.projects.find((item) => item.id === projectId),
    [store.projects, projectId],
  );
  const stats = useMemo(() => projectStats(store), [store]);

  if (live === null) return <PmLoading label="正在连接项目管理服务" />;
  if (!live) {
    return (
      <PmNotice>项目详情需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。</PmNotice>
    );
  }
  if (!project) {
    if (loading && !store.projects.length) return <PmLoading label="正在读取项目" />;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <BackLink />
        <PmEmptyState
          icon="folder"
          title="没有找到这个项目"
          hint="它可能已被删除，或链接里的项目 id 不正确。"
        />
      </div>
    );
  }

  const stat = stats[project.id];
  const tabs = [
    { value: 'iterations' as const, label: '迭代', count: stat?.iterations ?? 0 },
    { value: 'requirements' as const, label: '需求', count: stat?.requirements ?? 0 },
    { value: 'bugs' as const, label: '缺陷', count: stat?.bugs ?? 0 },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start gap-3">
        <a
          href={PROJECTS_HREF}
          aria-label="返回项目列表"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
        >
          <PmIcon name="arrowLeft" size={18} />
        </a>
        <span className="tw-pm-tile flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold">
          {project.name.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold text-stone-800">{project.name}</h1>
            <PmTag tone={PROJECT_STATUS_TONE[project.status as ProjectStatus]}>
              {PROJECT_STATUS_LABEL[project.status as ProjectStatus]}
            </PmTag>
          </div>
          <p
            className={`mt-0.5 text-xs ${project.description ? 'text-stone-400' : 'text-stone-300 italic'}`}
          >
            {project.description || '暂无描述'}
          </p>
        </div>
      </header>

      <div className="mt-5 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <PmTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="项目二级菜单" />
        <div className="text-xs text-stone-400">
          需求完成 {stat?.requirementPercent ?? 0}% · 缺陷完成 {stat?.bugClosedPercent ?? 100}%
        </div>
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        {tab === 'iterations' ? <PmIterationsBoard scopeProjectId={project.id} /> : null}
        {tab === 'requirements' ? <PmRequirementsBoard scopeProjectId={project.id} /> : null}
        {tab === 'bugs' ? <PmBugsBoard scopeProjectId={project.id} /> : null}
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <a
      href={PROJECTS_HREF}
      className="mb-2 inline-flex w-fit items-center gap-1.5 text-sm text-stone-500 transition-colors hover:text-stone-800"
    >
      <PmIcon name="arrowLeft" size={16} />
      返回项目列表
    </a>
  );
}
