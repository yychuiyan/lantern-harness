/**
 * 工作台输入栏的「自动化项目」入口。
 *
 * 只有当前工作区正好是某个已挂载 / 生成的自动化项目目录时才渲染（否则返回 null，
 * 不占输入栏位置）。菜单里能直接一键安装依赖、回看生成过程，或跳到自动化项目页。
 */
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
} from '@headlessui/react';
import { useEffect, useState } from 'react';

import {
  fetchProjects,
  matchProjectByDir,
  type SetupPlanStep,
  type UiAutoProject,
} from '../../lib/ui-auto';
import UiAutoGenerationDialog from './UiAutoGenerationDialog';
import UiAutoSetupPanel from './UiAutoSetupPanel';

function ChevronIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function BeakerIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M9 3h6" />
      <path d="M10 3v6.2L5.6 17A2.4 2.4 0 0 0 7.7 20.6h8.6a2.4 2.4 0 0 0 2.1-3.6L14 9.2V3" />
      <path d="M7.5 14h9" />
    </svg>
  );
}

function ItemIcon({ kind }: { kind: 'install' | 'history' | 'open' }) {
  if (kind === 'install') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0"
      >
        <path d="m5 8 4 4-4 4" />
        <path d="M13 16h6" />
      </svg>
    );
  }
  if (kind === 'history') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0"
      >
        <path d="M7 3.5h6.5L18 8v12.5H7Z" />
        <path d="M13.5 3.5V8H18" />
        <path d="M10 12.5h5" />
        <path d="M10 16h5" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2h7.8A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
    </svg>
  );
}

const MENU_ROW =
  'w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] data-[focus]:bg-stone-100 disabled:opacity-50';

export default function UiAutoWorkspaceActions({ workspace }: { workspace: string }) {
  const [project, setProject] = useState<UiAutoProject | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [generationOpen, setGenerationOpen] = useState(false);

  useEffect(() => {
    if (!workspace.trim()) {
      setProject(null);
      return;
    }
    let alive = true;
    void fetchProjects()
      .then((data) => {
        if (alive) setProject(matchProjectByDir(data.projects, workspace));
      })
      .catch(() => {
        // 插件未就绪：不渲染入口，不打扰工作台
        if (alive) setProject(null);
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  const refresh = () => {
    if (!workspace.trim()) return;
    void fetchProjects()
      .then((data) => setProject(matchProjectByDir(data.projects, workspace)))
      .catch(() => undefined);
  };

  if (!project) return null;

  const plan: SetupPlanStep[] = project.setupPlan ?? [];
  const settingUp = project.setup?.status === 'running';
  const needsSetup =
    !project.frameworkReady &&
    project.setup?.status !== 'running' &&
    project.setup?.status !== 'done';

  return (
    <>
      <Menu>
        <MenuButton
          aria-label={`自动化项目：${project.name}`}
          className="tw-composer-bar-ws group flex items-center gap-1 h-7 shrink-0 max-w-[min(40vw,11rem)] pl-1.5 pr-1 text-[13px] leading-5 font-medium text-stone-600 rounded-md outline-none focus:outline-none focus-visible:outline-none hover:bg-stone-100 data-[open]:bg-stone-100 transition-colors"
        >
          <BeakerIcon className="w-3.5 h-3.5 shrink-0 text-stone-500" />
          <span className="tw-composer-bar-label truncate">{project.name}</span>
          {settingUp ? (
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#4176e6]" />
          ) : needsSetup ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
          ) : null}
          <ChevronIcon className="tw-composer-bar-chevron w-3.5 h-3.5 shrink-0 text-stone-400 transition-transform group-data-[open]:rotate-180" />
        </MenuButton>
        <MenuItems
          transition
          anchor={{ to: 'top start', gap: 8 }}
          className="tw-select-menu tw-menu-anim z-50 w-[min(100vw-2rem,15rem)] rounded-xl border border-stone-200 py-1 shadow-xl focus:outline-none"
        >
          <p className="truncate px-3 pb-1 pt-1 text-[11px] text-stone-400">
            {project.frameworkLabel || project.framework}
            {settingUp ? ' · 正在安装依赖' : needsSetup ? ' · 环境未就绪' : ''}
          </p>
          <MenuItem>
            <button
              type="button"
              className={MENU_ROW}
              onClick={() => setSetupOpen(true)}
              disabled={!project.setupSupported}
            >
              <ItemIcon kind="install" />
              安装依赖
            </button>
          </MenuItem>
          {project.hasGenerationRecord ? (
            <MenuItem>
              <button type="button" className={MENU_ROW} onClick={() => setGenerationOpen(true)}>
                <ItemIcon kind="history" />
                查看生成过程
              </button>
            </MenuItem>
          ) : null}
          <div className="my-1 border-t border-stone-100" />
          <MenuItem>
            <a
              className={MENU_ROW}
              href={`${import.meta.env.BASE_URL || '/'}test-automation/projects/`}
            >
              <ItemIcon kind="open" />
              打开自动化项目页
            </a>
          </MenuItem>
        </MenuItems>
      </Menu>

      <Dialog open={setupOpen} onClose={() => setSetupOpen(false)} className="relative z-110">
        <DialogBackdrop
          transition
          className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
          aria-hidden="true"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="tw-pop-dialog-anim relative flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--tw-border)] bg-[var(--tw-surface-panel)] shadow-xl"
          >
            <div className="shrink-0 border-b border-[var(--tw-border)] px-5 py-3.5">
              <DialogTitle className="truncate text-base font-semibold text-[var(--tw-label-primary)]">
                安装依赖 · {project.name}
              </DialogTitle>
              <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--tw-label-tertiary)]">
                {project.dir}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
              <UiAutoSetupPanel
                projectId={project.id}
                plan={plan}
                note={project.setupNote ?? ''}
                showTitle={false}
                onStatusChange={refresh}
              />
            </div>
            <div className="flex shrink-0 justify-end border-t border-[var(--tw-border)] px-5 py-3">
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-lg border border-[var(--tw-border)] px-3 text-sm text-[var(--tw-label-secondary)] transition-colors hover:bg-[var(--tw-session-hover-bg)] hover:text-[var(--tw-label-primary)]"
                onClick={() => {
                  setSetupOpen(false);
                  refresh();
                }}
              >
                关闭
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      {generationOpen ? (
        <UiAutoGenerationDialog
          project={project}
          onClose={() => {
            setGenerationOpen(false);
            refresh();
          }}
          onSetupFinished={refresh}
        />
      ) : null}
    </>
  );
}
