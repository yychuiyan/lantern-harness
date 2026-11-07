/**
 * 自动化项目列表：管理已挂载 / 生成的项目。
 *
 * - 「创建项目」先选方式：挂载已有项目目录，或用模板从零生成一套基础框架。
 * - 「进入项目」写回 `ui-auto.project` 后跳到「自动化执行」，页面沿用上次选中的项目。
 * - 只操作挂载记录，不动项目文件；移出项目不删目录、不删历史报告。
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
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  fetchProjects,
  formatDateTime,
  frameworkKindLabel,
  pickProjectDirectory,
  removeProject,
  RUN_STATUS_META,
  updateProject,
  type UiAutoProject,
} from '../../lib/ui-auto';
import { fetchFsHealth } from '../../lib/fs-tools';
import { openProjectInSession } from '../../lib/open-project-in-session';
import { revealPath } from '../../lib/ui-auto-agent';
import { readViewText, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import OverflowHint from './OverflowHint';
import UiAutoGenerationDialog from './UiAutoGenerationDialog';
import UiAutoProjectConfigDialog from './UiAutoProjectConfigDialog';
import UiAutoScaffoldDialog, { type NewProjectMode } from './UiAutoScaffoldDialog';
import { PmEmptyState, PmErrorBar, PmIcon, PmLoading, PmNotice, usePmPlugin } from './PmShared';
import { showToast } from './Toast';

const PROJECT_PREF = 'ui-auto.project';
const BTN_PRIMARY =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-(--tw-accent) px-3 text-sm font-medium whitespace-nowrap text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const BTN_GHOST =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) px-3 text-sm text-(--tw-label-secondary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary) disabled:cursor-not-allowed disabled:opacity-50';
/** 卡片上的信息胶囊：弱底 + 主题描边，深浅两套主题都不用换类名 */
const CHIP_ACCENT =
  'inline-flex h-5 max-w-full items-center truncate rounded-md bg-(--tw-accent-soft) px-1.5 text-[11px] font-medium text-(--tw-accent)';
const CHIP_MUTED =
  'inline-flex h-5 max-w-full items-center truncate rounded-md border border-(--tw-border) px-1.5 text-[11px] text-(--tw-label-secondary)';
/** 卡片操作菜单里的一行：图标 + 文案，整行可点（hover 与键盘 focus 同样高亮） */
const MENU_ROW =
  'flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left text-[13px] text-(--tw-label-secondary) transition-colors hover:bg-(--tw-session-hover-bg) data-[focus]:bg-(--tw-accent-soft) data-[focus]:text-(--tw-label-primary) disabled:cursor-not-allowed disabled:opacity-50';
const MENU_ROW_DANGER =
  'flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left text-[13px] text-red-600 transition-colors hover:bg-red-500/10 data-[focus]:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50';

const STATUS_DOT: Record<string, string> = {
  passed: 'bg-emerald-500',
  failed: 'bg-red-500',
  error: 'bg-red-500',
  interrupted: 'bg-amber-500',
  cancelled: 'bg-(--tw-label-tertiary)',
  running: 'bg-(--tw-accent)',
};

function basePath(): string {
  const base = import.meta.env.BASE_URL || '/';
  return base.endsWith('/') ? base : `${base}/`;
}

/** 进入项目：写回选中项后跳到「自动化执行」 */
function enterProject(project: UiAutoProject): void {
  writeViewText(PROJECT_PREF, project.id);
  window.location.href = `${basePath()}test-automation/`;
}

export default function UiAutoProjectsPage() {
  const { ready, on } = usePmPlugin('uiAuto');
  const [projects, setProjects] = useState<UiAutoProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  /** 打开向导时直接进入的方式；空 = 先让用户选 */
  const [dialogMode, setDialogMode] = useState<NewProjectMode | null>(null);
  const [removeTarget, setRemoveTarget] = useState<UiAutoProject | null>(null);
  const [dirTarget, setDirTarget] = useState<UiAutoProject | null>(null);
  const [dirValue, setDirValue] = useState('');
  const [dirPicking, setDirPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 生成过程回看弹窗 */
  const [generationTarget, setGenerationTarget] = useState<UiAutoProject | null>(null);
  /** 项目配置弹窗：基本信息 + 安装依赖 + 环境配置都在里面 */
  const [configTarget, setConfigTarget] = useState<UiAutoProject | null>(null);
  /** 本地文件服务是否在线：不在线时「在会话中打开」置灰（注册不了工作区） */
  const [fsReady, setFsReady] = useState(false);

  // 从「自动化执行」带 ?new=1 过来时直接打开向导
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') setDialogOpen(true);
  }, []);

  const openDialog = useCallback((mode: NewProjectMode | null = null) => {
    setDialogMode(mode);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setDialogMode(null);
  }, []);

  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await fetchProjects();
      setProjects(data.projects);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready || !on) return;
    void reload();
    void fetchFsHealth()
      .then((health) => setFsReady(Boolean(health?.ok)))
      .catch(() => setFsReady(false));
  }, [ready, on, reload]);

  const matched = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return projects.filter((project) => {
      if (!key) return true;
      return project.name.toLowerCase().includes(key) || project.dir.toLowerCase().includes(key);
    });
  }, [projects, keyword]);

  const onOpenDirectory = async (project: UiAutoProject) => {
    try {
      // 用访达打开项目根目录，别丢给默认编辑器
      await revealPath({ projectId: project.id, path: '', app: 'finder' });
    } catch (err) {
      showToast(`打开目录失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  /** 在会话中打开：注册并激活工作区 → 复用/新建同目录会话 → 跳工作台 */
  const onOpenInSession = async (project: UiAutoProject) => {
    if (!fsReady) {
      showToast('本地文件服务未就绪，无法把项目目录设为工作区', 'error');
      return;
    }
    try {
      await openProjectInSession(project);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  /** 原生选目录：确认后把路径写进输入框，取消则保持原值 */
  const onBrowseDir = async () => {
    setDirPicking(true);
    try {
      const dir = await pickProjectDirectory();
      if (dir) setDirValue(dir);
    } catch (err) {
      showToast(
        `选择目录失败：${err instanceof Error ? err.message : String(err)}，可直接手动填写路径`,
        'error',
      );
    } finally {
      setDirPicking(false);
    }
  };

  const onSubmitDir = async () => {
    const target = dirTarget;
    if (!target) return;
    const dir = dirValue.trim();
    if (!dir || dir === target.dir) {
      setDirTarget(null);
      showToast('目录没有变化', 'info');
      return;
    }
    setBusy(true);
    try {
      await updateProject({ id: target.id, dir });
      setDirTarget(null);
      await reload(true);
      showToast('已更新项目目录', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(`更新目录失败：${message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onConfirmRemove = async () => {
    const target = removeTarget;
    if (!target) return;
    setRemoveTarget(null);
    setBusy(true);
    try {
      await removeProject(target.id);
      if (readViewText(PROJECT_PREF) === target.id) writeViewText(PROJECT_PREF, '');
      await reload(true);
      showToast('已移出项目', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(`移出失败：${message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <PmLoading label="正在读取插件开关" />;
  if (!on) {
    return (
      <PmNotice>
        该插件未启用，到「我的插件」里打开「自动化测试」就能管理 Playwright / pytest / Selenium
        项目。
      </PmNotice>
    );
  }

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {/* 空列表不在这里写「暂无项目」：下面已经有空状态卡片，重复 */}
        {projects.length ? (
          <div className="text-xs text-(--tw-label-tertiary)">
            共 <span className="font-medium text-(--tw-label-secondary)">{projects.length}</span>{' '}
            个项目
            {matched.length !== projects.length ? ` · 筛选出 ${matched.length} 个` : ''}
          </div>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="relative block">
            <PmIcon
              name="search"
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-(--tw-label-tertiary)"
            />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索项目名称 / 目录…"
              aria-label="搜索项目"
              className="h-9 w-56 rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) pl-8 pr-3 text-sm text-(--tw-label-primary) outline-none transition-colors placeholder:text-(--tw-label-tertiary) focus:border-(--tw-accent)"
            />
          </label>
          <button type="button" className={BTN_PRIMARY} onClick={() => openDialog()}>
            <PmIcon name="plus" size={14} />
            创建项目
          </button>
        </div>
      </div>

      {error ? <PmErrorBar message={error} onClose={() => setError('')} /> : null}

      <div className="mt-4 min-h-0 flex-1 overflow-auto pt-1 pb-4">
        {loading && !projects.length ? (
          <div className="flex min-h-[200px] items-center justify-center">
            <span className="tw-lib-spin" aria-hidden="true" />
          </div>
        ) : matched.length === 0 ? (
          projects.length ? (
            <PmEmptyState
              icon="search"
              title="没有符合筛选条件的项目"
              hint="换个关键词试试，或者清空搜索框"
            />
          ) : (
            <PmEmptyState
              icon="folder"
              title="还没有自动化项目"
              hint="挂载已有的 Playwright / pytest / Selenium 项目，或从模板生成一套基础框架"
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    className={BTN_PRIMARY}
                    onClick={() => openDialog('scaffold')}
                  >
                    <PmIcon name="plus" size={14} />
                    创建全新项目
                  </button>
                  <button type="button" className={BTN_GHOST} onClick={() => openDialog('mount')}>
                    <PmIcon name="folder" size={14} />
                    挂载本地项目
                  </button>
                </div>
              }
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {matched.map((project) => {
              const status = project.lastStatus ? RUN_STATUS_META[project.lastStatus] : null;
              const missing = project.exists === false;
              return (
                <article
                  key={project.id}
                  className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-(--tw-border) bg-(--tw-surface-panel) transition-colors hover:border-(--tw-accent)"
                >
                  <div className="flex items-start gap-2.5 px-4 pt-4">
                    <span
                      className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-(--tw-accent-soft) text-[13px] font-bold text-(--tw-accent)"
                      aria-hidden="true"
                    >
                      {(project.name.trim()[0] || '?').toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => enterProject(project)}
                        className="block w-full truncate text-left text-[15px] font-semibold text-(--tw-label-primary) transition-colors hover:text-(--tw-accent)"
                      >
                        {project.name}
                      </button>
                      <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-(--tw-label-tertiary)">
                        <PmIcon name="folder" size={11} className="shrink-0" />
                        <OverflowHint
                          text={project.dir}
                          className="block min-w-0 flex-1 truncate font-mono"
                        />
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 px-4">
                    <span className={CHIP_ACCENT}>
                      {project.frameworkLabel || project.framework}
                    </span>
                    {project.kind ? (
                      <span className={CHIP_MUTED}>{frameworkKindLabel(project.kind)}</span>
                    ) : null}
                    <span className={CHIP_MUTED}>{project.specFiles?.length ?? 0} 个用例文件</span>
                    <span className={`${CHIP_MUTED} ml-auto`}>
                      {project.source === 'scaffold' ? '生成' : '挂载'}
                    </span>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-3 text-[11px] text-(--tw-label-secondary)">
                    {missing ? (
                      <span className="text-amber-600">目录已不存在，重新指定目录后才能运行</span>
                    ) : project.setup?.status === 'running' ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-(--tw-accent)">
                        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-(--tw-accent)" />
                        正在安装依赖…
                      </span>
                    ) : project.setup?.status === 'failed' ? (
                      <span className="text-red-600">依赖安装失败（项目配置里可重试）</span>
                    ) : project.frameworkReady ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            STATUS_DOT[project.lastStatus] ?? 'bg-(--tw-label-tertiary)'
                          }`}
                        />
                        <span className="truncate">{status ? status.label : '还没运行过'}</span>
                        {project.lastRunAt ? (
                          <span className="shrink-0 text-(--tw-label-tertiary)">
                            · {formatDateTime(project.lastRunAt)}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-amber-600">运行环境未就绪（项目配置 → 运行环境）</span>
                    )}
                    {project.promptFile ? null : (
                      <span className="text-amber-600">未挂载提示词</span>
                    )}
                  </div>

                  <div className="mt-auto flex items-center gap-2 border-t border-(--tw-border) px-4 py-2.5">
                    <button
                      type="button"
                      className={`${BTN_PRIMARY} flex-1 justify-center`}
                      onClick={() => enterProject(project)}
                      disabled={!project.exists}
                    >
                      <PmIcon name="play" size={13} />
                      进入项目
                    </button>
                    {/* 项目配置：改名 / 安装依赖 / 环境配置都在这个弹窗里，入口不再藏在菜单深处 */}
                    <button
                      type="button"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-(--tw-border) text-(--tw-label-secondary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary)"
                      onClick={() => setConfigTarget(project)}
                      aria-label={`${project.name} 的项目配置`}
                    >
                      <PmIcon name="sliders" size={15} />
                    </button>
                    <Menu as="div" className="relative shrink-0">
                      <MenuButton
                        type="button"
                        aria-label={`${project.name} 的项目操作`}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-(--tw-border) text-(--tw-label-secondary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary) data-[open]:border-(--tw-accent) data-[open]:bg-(--tw-accent-soft) data-[open]:text-(--tw-accent)"
                      >
                        <PmIcon name="more" size={16} />
                      </MenuButton>
                      {/* 贴着触发按钮向下展开（空间不足时自动上翻）：菜单出现在卡片外侧，
                          不遮挡本卡片的标题与信息 */}
                      <MenuItems
                        anchor={{ to: 'bottom end', gap: 8, padding: 12 }}
                        transition
                        className="tw-select-menu tw-menu-anim z-80 w-44 rounded-xl p-1 shadow-lg ring-1 ring-[var(--tw-border)] focus:outline-none"
                      >
                        <p className="truncate px-2 pt-1 pb-1.5 text-[11px] font-medium text-(--tw-label-tertiary)">
                          {project.name}
                        </p>
                        <div className="mx-1 mb-1 h-px bg-(--tw-border)" aria-hidden="true" />
                        <MenuItem>
                          <button
                            type="button"
                            className={MENU_ROW}
                            onClick={() => void onOpenInSession(project)}
                            disabled={missing || !fsReady}
                          >
                            <PmIcon name="chat" size={14} className="shrink-0" />
                            在会话中打开
                          </button>
                        </MenuItem>
                        <MenuItem>
                          <button
                            type="button"
                            className={MENU_ROW}
                            onClick={() => void onOpenDirectory(project)}
                            disabled={missing}
                          >
                            <PmIcon name="folder" size={14} className="shrink-0" />
                            打开本地目录
                          </button>
                        </MenuItem>
                        {/* 「查看生成过程」是条件项：分割线跟着它一起出现，
                            否则没有生成记录时两条 h-px 会贴在一起 */}
                        {project.hasGenerationRecord ? (
                          <>
                            <div className="mx-1 my-1 h-px bg-(--tw-border)" aria-hidden="true" />
                            <MenuItem>
                              <button
                                type="button"
                                className={MENU_ROW}
                                onClick={() => setGenerationTarget(project)}
                              >
                                <PmIcon name="file" size={14} className="shrink-0" />
                                查看生成过程
                              </button>
                            </MenuItem>
                          </>
                        ) : null}
                        <div className="mx-1 my-1 h-px bg-(--tw-border)" aria-hidden="true" />
                        <MenuItem>
                          <button
                            type="button"
                            className={MENU_ROW}
                            onClick={() => {
                              setDirTarget(project);
                              setDirValue(project.dir);
                            }}
                            disabled={busy}
                          >
                            <PmIcon name="pencil" size={14} className="shrink-0" />
                            重新指定目录
                          </button>
                        </MenuItem>
                        <div className="mx-1 my-1 h-px bg-(--tw-border)" aria-hidden="true" />
                        <MenuItem>
                          <button
                            type="button"
                            className={MENU_ROW_DANGER}
                            onClick={() => setRemoveTarget(project)}
                            disabled={busy}
                          >
                            <PmIcon name="trash" size={14} className="shrink-0" />
                            移出项目
                          </button>
                        </MenuItem>
                      </MenuItems>
                    </Menu>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {dialogOpen ? (
        <UiAutoScaffoldDialog
          initialMode={dialogMode ?? undefined}
          onClose={() => {
            closeDialog();
            // 生成页里点过「一键安装」的话，关掉向导后卡片要显示安装状态
            void reload(true);
          }}
          onCreated={(project) => {
            void reload(true);
            closeDialog();
            enterProject(project);
          }}
        />
      ) : null}

      {configTarget ? (
        <UiAutoProjectConfigDialog
          project={configTarget}
          onChanged={(next) => {
            // 弹窗里的写操作会带回最新项目：同步到列表，也更新弹窗自己的入参
            if (next) setConfigTarget(next);
            void reload(true);
          }}
          onClose={() => {
            setConfigTarget(null);
            void reload(true);
          }}
        />
      ) : null}

      {generationTarget ? (
        <UiAutoGenerationDialog
          project={generationTarget}
          onClose={() => {
            setGenerationTarget(null);
            void reload(true);
          }}
          onSetupFinished={() => void reload(true)}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="移出项目"
        message={
          removeTarget
            ? `确定把「${removeTarget.name}」移出自动化项目？只删除挂载记录，项目文件与历史报告都会保留。`
            : ''
        }
        confirmLabel="移出"
        danger="outline"
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void onConfirmRemove()}
      />

      <Dialog
        open={Boolean(dirTarget)}
        onClose={busy ? () => undefined : () => setDirTarget(null)}
        className="relative z-110"
      >
        <DialogBackdrop
          transition
          className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
          aria-hidden="true"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="tw-pop-dialog-anim relative w-full max-w-md rounded-xl border border-(--tw-border) bg-(--tw-surface-panel) p-5 shadow-xl"
          >
            <DialogTitle className="text-base font-semibold text-(--tw-label-primary)">
              重新指定项目目录
            </DialogTitle>
            <p className="mt-2 text-xs leading-relaxed text-(--tw-label-secondary)">
              只改挂载记录，不动旧目录里的文件；新目录里要能识别到 Playwright / pytest / Selenium
              项目。
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                value={dirValue}
                onChange={(event) => setDirValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void onSubmitDir();
                }}
                placeholder="/path/to/your-test-project"
                aria-label="项目目录"
                spellCheck={false}
                className="h-9 min-w-0 flex-1 rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) px-2.5 font-mono text-xs text-(--tw-label-primary) outline-none transition-colors placeholder:text-(--tw-label-tertiary) focus:border-(--tw-accent)"
              />
              <button
                type="button"
                className={BTN_GHOST}
                onClick={() => void onBrowseDir()}
                disabled={dirPicking || busy}
              >
                <PmIcon name="folder" size={14} />
                {dirPicking ? '选择中…' : '浏览…'}
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className={BTN_PRIMARY}
                onClick={() => void onSubmitDir()}
                disabled={busy || !dirValue.trim()}
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </section>
  );
}
