/**
 * 项目配置弹窗：单项目的所有日常设置都收在这一处。
 *
 * 左侧三个分区（切分区不卸载，未保存的环境改动、正在跑的安装日志都不会丢）：
 * - 基本信息：改名、目录、框架 / 用例数 / 最近运行、挂载的提示词；底部折叠「骨架同步」，
 *   点一次就按空间骨架重渲染进项目目录（覆盖前备份），不再走「检查 → 预览」。
 * - 运行环境：一键安装依赖 + 浏览器内核，实时日志。
 * - 环境配置：`.env.<ENV>` 分组编辑（`UiAutoEnvPanel`，与运行条上的环境弹窗同一份实现）。
 *
 * 目录失联时顶部标黄并禁用所有写操作，避免对着不存在的目录改配置。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  fetchScaffoldStacks,
  formatDateTime,
  frameworkKindLabel,
  updateProject,
  updateScaffoldProject,
  type ScaffoldStack,
  type ScaffoldUpdateResult,
  type UiAutoProject,
} from '../../lib/ui-auto';
import { revealPath } from '../../lib/ui-auto-agent';
import {
  fetchNodeInstall,
  fetchProjectNode,
  formatNodeVersion,
  nodeInstallTarget,
  nodeManualHint,
  saveProjectNode,
  startNodeInstall,
  stopNodeInstall,
  type NodeInstallState,
  type ProjectNodeStatus,
} from '../../lib/ui-auto-node';
import { openNodeInstallInChat } from '../../lib/uiauto-node-chat';
import { spaceScopedKey } from '../../lib/space-scope';
import ConfirmDialog from './ConfirmDialog';
import { PmIcon } from './PmShared';
import UiAutoEnvPanel from './UiAutoEnvPanel';
import UiAutoSetupPanel from './UiAutoSetupPanel';
import { showToast } from './Toast';

const TEXT_PRIMARY = 'text-[var(--tw-label-primary)]';
const TEXT_SECONDARY = 'text-[var(--tw-label-secondary)]';
const TEXT_TERTIARY = 'text-[var(--tw-label-tertiary)]';
const INPUT =
  'h-9 w-full rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) px-2.5 text-sm text-(--tw-label-primary) outline-none transition-colors placeholder:text-(--tw-label-tertiary) focus:border-(--tw-accent) disabled:opacity-60';
const PRIMARY_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-(--tw-accent) px-3 text-sm font-medium whitespace-nowrap text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const ICON_BTN =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--tw-label-tertiary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary) disabled:cursor-not-allowed disabled:opacity-40';

type TabId = 'basic' | 'runtime' | 'env';

const TABS: Array<{ id: TabId; label: string; icon: 'pencil' | 'terminal' | 'sliders' }> = [
  { id: 'basic', label: '基本信息', icon: 'pencil' },
  { id: 'runtime', label: '运行环境', icon: 'terminal' },
  { id: 'env', label: '环境配置', icon: 'sliders' },
];

/**
 * 上次停留的分区按数据空间记住：同一个空间里反复开配置，多半是接着改同一块。
 * 鼠标点 tab 不会丢当前输入的密码框，恢复时也只是切显示，不影响任何未保存状态。
 */
const TAB_KEY = 'tw.uiauto.configTab';

function readRememberedTab(): TabId {
  try {
    const saved = localStorage.getItem(spaceScopedKey(TAB_KEY));
    return TABS.some((item) => item.id === saved) ? (saved as TabId) : 'basic';
  } catch {
    return 'basic';
  }
}

function rememberTab(id: TabId) {
  try {
    localStorage.setItem(spaceScopedKey(TAB_KEY), id);
  } catch {
    // 隐私模式忽略
  }
}

interface Props {
  project: UiAutoProject;
  onClose: () => void;
  /** 任何写操作成功后回调：调用方刷新列表 / 同步看板选中项 */
  onChanged?: (project?: UiAutoProject) => void;
}

/** 信息行：左标签定宽、中间值、右侧可选操作（目录复制 / 打开） */
function InfoRow({
  label,
  children,
  action,
  onClick,
  expanded,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
  /** 整行可点（目前只有 Node 版本：点行展开 / 收起下拉） */
  onClick?: () => void;
  expanded?: boolean;
}) {
  const inner = (
    <>
      <span className={`text-[11px] ${TEXT_TERTIARY}`}>{label}</span>
      <span className="min-w-0 text-xs text-[var(--tw-label-primary)]">{children}</span>
      {action ?? null}
    </>
  );
  const base = 'grid min-h-11 grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2';
  if (!onClick) return <div className={base}>{inner}</div>;
  // 整行当按钮用：左键、回车、空格都能切；右侧箭头只是视觉提示，点击也走同一个开关
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      className={`${base} cursor-pointer transition-colors hover:bg-(--tw-session-hover-bg)`}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {inner}
    </div>
  );
}

export default function UiAutoProjectConfigDialog({ project, onClose, onChanged }: Props) {
  const [current, setCurrent] = useState<UiAutoProject>(project);
  const [tab, setTab] = useState<TabId>(readRememberedTab);
  const [name, setName] = useState(project.name);
  const [savingName, setSavingName] = useState(false);
  const [envDirty, setEnvDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // 高级：骨架同步
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [stacks, setStacks] = useState<ScaffoldStack[]>([]);
  const [stackId, setStackId] = useState<string>(project.framework);
  const [stackOpen, setStackOpen] = useState(false);
  const [options, setOptions] = useState<string[]>(project.scaffoldOptions ?? []);
  const [baseURL, setBaseURL] = useState(project.scaffoldBaseURL ?? '');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncResult, setSyncResult] = useState<ScaffoldUpdateResult | null>(null);
  const mountedRef = useRef(true);

  // 基本信息：Node 版本（`.nvmrc` / engines + 本机已装版本）
  const [node, setNode] = useState<ProjectNodeStatus | null>(null);
  const [nodeOpen, setNodeOpen] = useState(false);
  const [nodeSaving, setNodeSaving] = useState(false);
  const [nodeJob, setNodeJob] = useState<NodeInstallState | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Node 版本：进来就读一次，用来显示「项目要哪个 / 本机装没装」
  useEffect(() => {
    let alive = true;
    void fetchProjectNode(project.id)
      .then((next) => {
        if (alive && mountedRef.current) setNode(next);
      })
      .catch(() => {
        // 读不到就只显示「未检测」，不挡其它配置
      });
    return () => {
      alive = false;
    };
  }, [project.id]);

  // 装机 / 安装 Node 版本：状态在服务端，弹窗关掉也继续跑；这里只负责轮询
  useEffect(() => {
    if (nodeJob?.status !== 'running') return;
    let alive = true;
    const timer = window.setInterval(() => {
      void fetchNodeInstall(current.id)
        .then((next) => {
          if (!alive || !mountedRef.current) return;
          setNodeJob(next);
          if (next.status !== 'running') {
            void fetchProjectNode(current.id)
              .then((status) => {
                if (alive && mountedRef.current) setNode(status);
              })
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 1200);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [current.id, nodeJob?.status]);

  // 打开面板时看一眼有没有在装的版本（另一个窗口 / 上次没关弹窗）
  useEffect(() => {
    let alive = true;
    void fetchNodeInstall(current.id)
      .then((next) => {
        if (alive && mountedRef.current && next.status === 'running') setNodeJob(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [current.id]);

  // 只在展开高级区时才去读骨架列表：多数人不需要，别每次开弹窗都拉一遍
  useEffect(() => {
    if (!advancedOpen || stacks.length) return;
    void fetchScaffoldStacks()
      .then((list) => {
        if (!mountedRef.current) return;
        setStacks(list);
        const picked = list.find((item) => item.id === project.framework) ?? list[0];
        if (picked) {
          setStackId(picked.id);
          // 项目勾过的附带内容优先：照默认值重来会把上次同步的结果悄悄改掉
          setOptions((prev) =>
            prev.length
              ? prev
              : project.scaffoldOptions?.length
                ? project.scaffoldOptions
                : picked.defaultOptions,
          );
        }
      })
      .catch((err) => {
        if (mountedRef.current) setSyncError(err instanceof Error ? err.message : String(err));
      });
  }, [advancedOpen, project.framework, project.scaffoldOptions, stacks.length]);

  const stack = useMemo(
    () => stacks.find((item) => item.id === stackId) ?? stacks[0] ?? null,
    [stackId, stacks],
  );

  const missing = current.exists === false;
  const nameChanged = name.trim() !== current.name && Boolean(name.trim());

  // 技术栈：只有 Playwright 可用，其余是「规划中」的占位项。
  // 这里用行内展开而不是浮层下拉——弹层会把下方「附带内容」整块盖住，看着像层级失控。
  const stackChoices = useMemo(
    () =>
      stacks.length
        ? stacks.map((item) => ({
            value: item.id,
            label: item.status === 'planned' ? `${item.label}（规划中）` : item.label,
            disabled: item.status === 'planned',
          }))
        : [{ value: stackId, label: stackId, disabled: false }],
    [stacks, stackId],
  );
  const stackValue = stack?.id ?? stackId;
  const stackLabel = stackChoices.find((item) => item.value === stackValue)?.label ?? stackValue;

  /** 换技术栈：项目自己那套沿用已勾的附带内容，其它栈回到默认值；上一次同步结果作废 */
  const pickStack = (next: string) => {
    setStackOpen(false);
    setStackId(next);
    const picked = stacks.find((item) => item.id === next);
    const saved = project.scaffoldOptions ?? [];
    setOptions(next === project.framework && saved.length ? saved : (picked?.defaultOptions ?? []));
    setSyncResult(null);
  };

  /** 已装版本去重：同一版本可能同时装在 nvm 和 fnm 里，优先保留 nvm 那份 */
  const nodeVersions = useMemo(() => {
    const seen = new Map<string, ProjectNodeStatus['installations'][number]>();
    for (const item of node?.installations ?? []) {
      const previous = seen.get(item.version);
      if (!previous || (previous.manager !== 'nvm' && item.manager === 'nvm')) {
        seen.set(item.version, item);
      }
    }
    return [...seen.values()];
  }, [node?.installations]);

  /** 面板里高亮的版本：真正会用的那个（`.nvmrc` 可能只写 `22`，不能按字符串比） */
  const nodeActiveVersion = node?.matched?.version || (node?.runningSatisfies ? node.running : '');
  /** 声明的版本本机没人能满足：已装的没有、面板进程自己跑的那个也不行 */
  const nodeMissing = Boolean(node?.required && !node.matched && !node.runningSatisfies);
  /** 缺版本时按钮装哪个：范围写法定不出具体版本时为空 */
  const nodeInstallVersion = node ? nodeInstallTarget(node.required) : '';
  /** 本机有没有能装 Node 的版本管理器：没有时「一键安装」跑不了，只能交给会话里的 AI */
  // installers 是服务端新字段；老进程还没返回时退回用 managers（已装过版本的才在里面）
  const nodeInstallers = useMemo(
    () => node?.installers ?? node?.managers ?? [],
    [node?.installers, node?.managers],
  );
  const nodeCanAutoInstall = nodeInstallers.length > 0;
  const nodeJobRunning = nodeJob?.status === 'running';
  /**
   * 底部「需要时手动切换」的提示：.nvmrc 只是文本，读它不需要任何工具；
   * 但终端里想按它切版本，得有对应的版本管理器——本机没装就别给 `nvm use` 这种敲不出来的命令。
   */
  const nodeHint = useMemo(() => (node ? nodeManualHint(node) : { command: '', note: '' }), [node]);

  /** 切换 Node 版本：只写 `.nvmrc`；跑用例 / 安装依赖时服务端会把 PATH 指过去 */
  const pickNode = async (version: string) => {
    setNodeSaving(true);
    try {
      const next = await saveProjectNode({ projectId: current.id, version });
      setNode(next);
      setNodeOpen(false);
      showToast(version ? `已切到 Node ${formatNodeVersion(version)}` : '已移除 .nvmrc', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setNodeSaving(false);
    }
  };

  /** 本机缺的版本：直接后台装（nvm / fnm / volta 自动挑），装完刷新下拉 */
  const installNode = async (version: string) => {
    try {
      const started = await startNodeInstall({ projectId: current.id, version });
      setNodeJob(started);
      showToast(`开始安装 Node ${formatNodeVersion(version)}`, 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const stopNodeJob = async () => {
    try {
      setNodeJob(await stopNodeInstall(current.id));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  /** 平台装不了 / 装不动时，带项目目录进工作台让 AI 装（只给确定性方案覆盖不到的场景兜底） */
  const askAiInstall = async () => {
    if (!node) return;
    try {
      await openNodeInstallInChat(
        { id: current.id, name: current.name, dir: current.dir },
        node,
        nodeInstallVersion,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const applyProject = (next: UiAutoProject) => {
    setCurrent(next);
    setName(next.name);
    onChanged?.(next);
  };

  const saveName = async () => {
    if (!nameChanged) return;
    setSavingName(true);
    try {
      const next = await updateProject({ id: current.id, name: name.trim() });
      applyProject(next);
      showToast('已更新项目名', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSavingName(false);
    }
  };

  /**
   * 打开项目目录：这个按钮就是「去本地看看这个项目」，固定用访达 / 资源管理器，
   * 不跟默认打开方式（多半是编辑器）走，否则点文件夹会跳进 IDE。
   */
  const openDir = () => {
    void revealPath({ projectId: current.id, path: '', app: 'finder' }).catch((err) =>
      showToast(err instanceof Error ? err.message : String(err), 'error'),
    );
  };

  const copyDir = () => {
    void navigator.clipboard
      .writeText(current.dir)
      .then(() => showToast('已复制项目路径', 'success'))
      .catch(() => showToast('复制失败，请手动选中路径复制', 'error'));
  };

  /** 骨架同步：直接备份并写入，不跑检查、不生成过程留档 */
  const syncSkeleton = async () => {
    if (!stack) return;
    setSyncing(true);
    setSyncError('');
    setSyncResult(null);
    try {
      const result = await updateScaffoldProject({
        projectId: current.id,
        stack: stack.id,
        name: name.trim() || current.name,
        baseURL: baseURL.trim(),
        options,
      });
      setSyncResult(result);
      applyProject(result.project);
      // 服务端最终写进 .env.example 的地址：留空时是沿用值，回填后能看到真实结果
      setBaseURL(result.project.scaffoldBaseURL || '');
      showToast(
        result.created + result.changed
          ? `已同步 ${result.created + result.changed} 个文件`
          : '项目已经是最新的，没有文件需要改',
        'success',
      );
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const requestClose = useCallback(() => {
    if (envDirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  }, [envDirty, onClose]);

  /**
   * 切换分区：离开基本信息时把没保存的项目名丢掉（未保存的输入不该被记住），
   * 并记住这次停留，下次打开直接回到这一栏。
   */
  const switchTab = (next: TabId) => {
    if (next === tab) return;
    setName(current.name);
    setTab(next);
    rememberTab(next);
  };

  /** 折叠区里的选项：整行可点，勾上就写进这次同步 */
  const optionRow = (id: string, label: string, hint: string) => (
    <label
      key={id}
      className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-(--tw-session-hover-bg)"
    >
      <input
        type="checkbox"
        className="mt-0.5 accent-[var(--tw-accent)]"
        checked={options.includes(id)}
        onChange={() =>
          setOptions((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
        }
        disabled={syncing || missing}
      />
      <span className="min-w-0">
        <span className="block text-xs leading-5 text-[var(--tw-label-primary)]">{label}</span>
        {hint ? (
          <span className={`block text-[11px] leading-4 ${TEXT_TERTIARY}`}>{hint}</span>
        ) : null}
      </span>
    </label>
  );

  return (
    <Dialog open onClose={requestClose} className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="tw-pop-dialog-anim flex h-[min(86vh,720px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-(--tw-border) bg-(--tw-surface-panel) shadow-2xl"
        >
          {/* 头部：图标 + 标题 + 项目身份（名字 / 真实目录），右侧关闭 */}
          <div className="flex shrink-0 items-start gap-3 border-b border-(--tw-border) px-5 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-(--tw-accent-soft) text-(--tw-accent)">
              <PmIcon name="sliders" size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className={`text-[15px] leading-6 font-semibold ${TEXT_PRIMARY}`}>
                项目配置
              </DialogTitle>
              <p
                className={`mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] ${TEXT_TERTIARY}`}
              >
                <span className="max-w-[40%] shrink-0 truncate">{current.name}</span>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate font-mono">{current.dir}</span>
              </p>
            </div>
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm text-(--tw-label-tertiary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary)"
              onClick={requestClose}
              aria-label="关闭项目配置"
            >
              ✕
            </button>
          </div>

          {missing ? (
            <p className="shrink-0 bg-amber-50 px-5 py-2 text-[11px] leading-4 text-amber-700">
              项目目录已不存在（换机器或被移动过）。先在卡片菜单里「重新指定目录」，这里才能改配置。
            </p>
          ) : null}

          <div className="flex min-h-0 flex-1">
            {/* 左栏：灰底分区列表，选中项浮成白卡；只留图标 + 标签，状态在右栏内容里 */}
            <nav
              className="flex w-[196px] shrink-0 flex-col gap-1 bg-(--tw-surface-recessed) p-2.5"
              role="tablist"
              aria-label="项目配置分区"
            >
              {TABS.map((item) => {
                const active = tab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`ui-auto-config-${item.id}`}
                    onClick={() => switchTab(item.id)}
                    className={`flex items-center gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-(--tw-accent) focus-visible:outline-none ${
                      active
                        ? 'bg-(--tw-surface-panel) shadow-[0_1px_2px_rgb(0_0_0_/0.06)] ring-1 ring-(--tw-border)'
                        : 'hover:bg-(--tw-surface-panel)'
                    }`}
                  >
                    <PmIcon
                      name={item.icon}
                      size={16}
                      className={`h-4 w-4 shrink-0 ${
                        active ? 'text-(--tw-accent)' : 'text-(--tw-label-tertiary)'
                      }`}
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-[13px] ${
                        active
                          ? 'font-medium text-(--tw-label-primary)'
                          : 'text-[var(--tw-label-secondary)]'
                      }`}
                    >
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </nav>

            {/* 内容区：三个分区都常驻，只切显示，切回来时修改与日志都还在 */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--tw-surface-panel)">
              {/* 基本信息 */}
              <div
                id="ui-auto-config-basic"
                role="tabpanel"
                className={`${tab === 'basic' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}
              >
                <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
                  <div className="space-y-5">
                    {/* 项目名：只改显示名，目录与报告路径不动 */}
                    <section>
                      <div className="mb-1.5 flex items-baseline justify-between gap-2">
                        <span className={`text-xs font-medium ${TEXT_SECONDARY}`}>项目名</span>
                        <span className={`text-[10px] ${TEXT_TERTIARY}`}>只改显示名，目录不变</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input
                          className={INPUT}
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveName();
                          }}
                          disabled={missing}
                          spellCheck={false}
                          aria-label="项目名"
                        />
                        {/* 固定宽度槽位：保存按钮消失 / 变「已保存」时输入框不再跟着变宽，避免点保存时整行弹一下。
                            内容靠左贴住输入框，右侧留白由槽位吸收，别把「已保存」顶到最右边 */}
                        <span className="flex w-[84px] shrink-0 items-center justify-start">
                          {nameChanged ? (
                            <button
                              type="button"
                              className={`${PRIMARY_BTN} w-full justify-center`}
                              onClick={() => void saveName()}
                              disabled={savingName || missing}
                            >
                              {savingName ? '保存中…' : '保存'}
                            </button>
                          ) : (
                            <span
                              className={`inline-flex h-8 items-center gap-1 text-[11px] ${TEXT_TERTIARY}`}
                            >
                              <PmIcon name="check" size={12} />
                              已保存
                            </span>
                          )}
                        </span>
                      </div>
                    </section>

                    {/* 项目信息：一行一个事实，目录单独带复制 / 打开 */}
                    <section className="divide-y divide-[var(--tw-border)] overflow-hidden rounded-xl border border-(--tw-border)">
                      <InfoRow
                        label="目录"
                        action={
                          <span className="flex items-center gap-0.5">
                            <button
                              type="button"
                              className={ICON_BTN}
                              onClick={copyDir}
                              aria-label="复制项目路径"
                            >
                              <PmIcon name="copy" size={13} />
                            </button>
                            <button
                              type="button"
                              className={ICON_BTN}
                              onClick={openDir}
                              disabled={missing}
                              aria-label="打开项目目录"
                            >
                              <PmIcon name="folder" size={13} />
                            </button>
                          </span>
                        }
                      >
                        <span className="block truncate font-mono text-[11px]">{current.dir}</span>
                      </InfoRow>
                      <InfoRow label="框架">
                        {current.frameworkLabel || current.framework}
                        {current.kind ? (
                          <span className={TEXT_TERTIARY}>
                            {' '}
                            · {frameworkKindLabel(current.kind)}
                          </span>
                        ) : null}
                      </InfoRow>
                      {/* Node 是 Playwright 这类 Node 项目的属性；pytest 项目不显示，免得出现一个空的版本行 */}
                      {current.framework !== 'pytest' ? (
                        <>
                          <InfoRow
                            label="Node 版本"
                            onClick={() => setNodeOpen((prev) => !prev)}
                            expanded={nodeOpen}
                            action={
                              <PmIcon
                                name="chevronDown"
                                size={13}
                                className={`shrink-0 text-(--tw-label-tertiary) transition-transform ${
                                  nodeOpen ? 'rotate-180' : ''
                                }`}
                              />
                            }
                          >
                            {node ? (
                              <>
                                <span className="font-mono text-[11px]">
                                  {nodeActiveVersion ? (
                                    formatNodeVersion(nodeActiveVersion)
                                  ) : (
                                    <span className="font-sans text-amber-700">未安装</span>
                                  )}
                                </span>
                                {node.required ? (
                                  <span className={TEXT_TERTIARY}>
                                    {' · '}
                                    {node.nvmrc
                                      ? '.nvmrc '
                                      : node.nodeVersion
                                        ? '.node-version '
                                        : 'engines '}
                                    {node.required}
                                  </span>
                                ) : (
                                  <span className={TEXT_TERTIARY}> · 未声明版本</span>
                                )}
                                {nodeMissing ? (
                                  <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                                    本机未装
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <span className={TEXT_TERTIARY}>检测中…</span>
                            )}
                          </InfoRow>
                          {nodeOpen ? (
                            /* 展开区：上留一点缝，不再紧贴上一行的下边框；左右与信息行同一条内边距 */
                            <div className="px-3 pt-1.5 pb-2">
                              <div className="overflow-hidden rounded-lg border border-(--tw-border)">
                                {nodeVersions.length ? (
                                  nodeVersions.map((item) => {
                                    const active = item.version === nodeActiveVersion;
                                    return (
                                      <button
                                        key={`${item.manager}:${item.version}`}
                                        type="button"
                                        disabled={nodeSaving}
                                        onClick={() => void pickNode(item.version)}
                                        className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed ${
                                          active
                                            ? 'bg-(--tw-accent-soft) font-medium text-(--tw-accent)'
                                            : 'text-(--tw-label-primary) hover:bg-(--tw-session-hover-bg)'
                                        }`}
                                      >
                                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                                          {formatNodeVersion(item.version)}
                                        </span>
                                        <span className={`shrink-0 text-[10px] ${TEXT_TERTIARY}`}>
                                          {item.manager}
                                        </span>
                                        {active ? (
                                          <PmIcon name="check" size={12} className="shrink-0" />
                                        ) : null}
                                      </button>
                                    );
                                  })
                                ) : (
                                  <p className={`px-2.5 py-2 text-[11px] ${TEXT_TERTIARY}`}>
                                    没扫到 nvm / fnm / volta 里装好的 Node
                                  </p>
                                )}
                              </div>

                              {/* 声明了版本却装不上：直接在这里装，装完刷新下拉就能选 */}
                              {nodeMissing && !nodeJobRunning ? (
                                <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5">
                                  <span className="min-w-0 flex-1 text-[11px] leading-4 text-amber-800">
                                    本机没有满足 {node?.required} 的 Node
                                    {nodeCanAutoInstall
                                      ? nodeInstallVersion
                                        ? ''
                                        : '，这个写法定不出具体版本'
                                      : '，也没有 nvm / fnm / volta，不能一键装'}
                                  </span>
                                  {nodeCanAutoInstall && nodeInstallVersion ? (
                                    <button
                                      type="button"
                                      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-amber-600 px-2 text-[11px] font-medium whitespace-nowrap text-white transition-opacity hover:opacity-90"
                                      onClick={() => void installNode(nodeInstallVersion)}
                                    >
                                      安装 {formatNodeVersion(nodeInstallVersion)}
                                    </button>
                                  ) : null}
                                  {/* 确定性方案搞不定时（没版本管理器 / 要换源 / 只有上界）交给会话里的 AI */}
                                  <button
                                    type="button"
                                    className={`shrink-0 text-[11px] whitespace-nowrap ${TEXT_SECONDARY} underline-offset-2 transition-colors hover:text-(--tw-label-primary) hover:underline`}
                                    onClick={() => void askAiInstall()}
                                  >
                                    让 AI 处理
                                  </button>
                                </div>
                              ) : null}

                              {nodeJob && nodeJob.status !== 'idle' ? (
                                <div className="mt-1.5 overflow-hidden rounded-lg border border-(--tw-border)">
                                  <div className="flex items-center gap-2 border-b border-(--tw-border) px-2.5 py-1.5">
                                    <span className={`text-[11px] ${TEXT_SECONDARY}`}>
                                      安装 Node {formatNodeVersion(nodeJob.version)}
                                    </span>
                                    <span
                                      className={`text-[10px] ${
                                        nodeJob.status === 'done'
                                          ? 'text-emerald-600'
                                          : nodeJob.status === 'failed'
                                            ? 'text-red-600'
                                            : TEXT_TERTIARY
                                      }`}
                                    >
                                      {nodeJob.status === 'running'
                                        ? nodeJob.stopping
                                          ? '停止中…'
                                          : '安装中…'
                                        : nodeJob.status === 'done'
                                          ? '已完成'
                                          : nodeJob.status === 'stopped'
                                            ? '已停止'
                                            : '失败'}
                                    </span>
                                    {nodeJobRunning ? (
                                      <button
                                        type="button"
                                        className={`ml-auto text-[11px] ${TEXT_TERTIARY} transition-colors hover:text-red-600`}
                                        onClick={() => void stopNodeJob()}
                                        disabled={nodeJob.stopping}
                                      >
                                        停止
                                      </button>
                                    ) : null}
                                  </div>
                                  <pre
                                    className={`max-h-32 overflow-auto px-2.5 py-1.5 font-mono text-[10px] leading-4 whitespace-pre-wrap ${TEXT_TERTIARY}`}
                                  >
                                    {nodeJob.log.trim() || nodeJob.command}
                                  </pre>
                                  {/* 平台装失败了再给 AI 兜底：日志已经说明失败原因，会话里能接着排查 */}
                                  {nodeJob.status === 'failed' ? (
                                    <div className="border-t border-(--tw-border) px-2.5 py-1.5">
                                      <button
                                        type="button"
                                        className={`text-[11px] ${TEXT_SECONDARY} underline-offset-2 transition-colors hover:text-(--tw-label-primary) hover:underline`}
                                        onClick={() => void askAiInstall()}
                                      >
                                        装不上？让 AI 处理
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}

                              {node?.nvmrc ? (
                                <button
                                  type="button"
                                  disabled={nodeSaving}
                                  onClick={() => void pickNode('')}
                                  className={`mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-[11px] ${TEXT_TERTIARY} transition-colors hover:bg-(--tw-session-hover-bg)`}
                                >
                                  {node.engines
                                    ? `移除 .nvmrc（回到 engines ${node.engines}）`
                                    : '移除 .nvmrc（不再限制版本）'}
                                </button>
                              ) : null}
                              <p className={`mt-2 px-2.5 text-[10px] leading-4 ${TEXT_TERTIARY}`}>
                                运行用例与安装依赖用上面勾选版本的 Node；本机终端不受影响。
                                {nodeHint.command ? (
                                  <>
                                    {' '}
                                    需要时执行 <span className="font-mono">{nodeHint.command}</span>
                                    。
                                  </>
                                ) : nodeHint.note ? (
                                  <> {nodeHint.note}</>
                                ) : node?.nodeVersion ? (
                                  ' 项目现用 .node-version 声明；在这里选定版本会写 .nvmrc（优先级更高）。'
                                ) : null}
                              </p>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      <InfoRow label="来源">
                        {current.source === 'scaffold' ? '平台生成' : '挂载本地项目'}
                        <span className={TEXT_TERTIARY}>
                          {' · '}
                          {current.specFiles?.length ?? 0} 个用例文件
                        </span>
                      </InfoRow>
                      <InfoRow label="最近运行">
                        {current.lastRunAt ? (
                          formatDateTime(current.lastRunAt)
                        ) : (
                          <span className={TEXT_TERTIARY}>还没运行过</span>
                        )}
                      </InfoRow>
                      <InfoRow label="提示词">
                        {current.promptFile ? (
                          <span className="block truncate font-mono text-[11px]">
                            {current.promptFile}
                          </span>
                        ) : (
                          <span className={TEXT_TERTIARY}>未挂载 · 在「自动化执行」顶栏挂载</span>
                        )}
                      </InfoRow>
                    </section>

                    {/* 高级：骨架同步。收起时只留一行入口，避免把日常改名的视野挤掉 */}
                    <section className="overflow-hidden rounded-xl border border-(--tw-border)">
                      <button
                        type="button"
                        // 折叠头本身是一整条边框，任何画在外侧的 focus 描边都会和边框之间留一圈白缝。
                        // 内阴影贴在里面画不会有白边，但外层卡片是 rounded-xl + overflow-hidden：
                        // 按钮如果是直角，圆角处的阴影会被裁掉（左上 / 右上缺角）。这里给折叠头加上
                        // 与卡片内圆角一致的顶部圆角，焦点描边跟着弧线走，四角才完整。
                        className="flex w-full items-center gap-2 rounded-t-[11px] px-3.5 py-2.5 text-left transition-colors outline-none hover:bg-(--tw-session-hover-bg) focus-visible:shadow-[inset_0_0_0_2px_var(--tw-accent)]"
                        onClick={() => setAdvancedOpen((prev) => !prev)}
                        aria-expanded={advancedOpen}
                      >
                        <PmIcon
                          name={advancedOpen ? 'chevronDown' : 'chevronRight'}
                          size={12}
                          className={TEXT_TERTIARY}
                        />
                        <span className={`text-xs font-medium ${TEXT_SECONDARY}`}>骨架同步</span>
                        <span
                          className={`rounded bg-(--tw-surface-recessed) px-1.5 py-0.5 text-[10px] leading-3 ${TEXT_TERTIARY}`}
                        >
                          高级
                        </span>
                        <span className={`ml-auto truncate text-[10px] ${TEXT_TERTIARY}`}>
                          按空间骨架更新项目文件
                        </span>
                      </button>
                      {advancedOpen ? (
                        <div className="space-y-3 border-t border-(--tw-border) px-3 py-3">
                          <p className={`text-[11px] leading-4 ${TEXT_TERTIARY}`}>
                            缺的补上、旧模板更新；同名文件先备份到
                            .lantern/local/uiauto-scaffold/backup/
                            再覆盖。不跑检查、不生成过程留档。
                          </p>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <div>
                              <span className={`mb-1 block text-[11px] ${TEXT_TERTIARY}`}>
                                技术栈
                              </span>
                              {/* 行内展开：不用浮层下拉，弹层会把下面「附带内容」整块盖住 */}
                              <div className="relative">
                                <button
                                  type="button"
                                  onClick={() => setStackOpen((prev) => !prev)}
                                  disabled={syncing || missing}
                                  aria-expanded={stackOpen}
                                  aria-label="技术栈"
                                  className={`${INPUT} flex h-8 items-center justify-between gap-2 text-xs disabled:cursor-not-allowed`}
                                >
                                  <span className="truncate">{stackLabel}</span>
                                  <PmIcon
                                    name="chevronDown"
                                    size={12}
                                    className={`shrink-0 text-(--tw-label-tertiary) transition-transform ${
                                      stackOpen ? 'rotate-180' : ''
                                    }`}
                                  />
                                </button>
                                {stackOpen ? (
                                  <div className="mt-1 overflow-hidden rounded-lg border border-(--tw-border) bg-(--tw-surface-panel)">
                                    {stackChoices.map((item) => (
                                      <button
                                        key={item.value}
                                        type="button"
                                        onClick={() => pickStack(item.value)}
                                        disabled={item.disabled}
                                        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                                          item.value === stackValue
                                            ? 'bg-(--tw-accent-soft) font-medium text-(--tw-accent)'
                                            : 'text-(--tw-label-primary) hover:bg-(--tw-session-hover-bg)'
                                        } disabled:cursor-not-allowed disabled:text-(--tw-label-tertiary) disabled:hover:bg-transparent`}
                                      >
                                        <span className="min-w-0 flex-1 truncate">
                                          {item.label}
                                        </span>
                                        {item.value === stackValue ? (
                                          <PmIcon name="check" size={12} className="shrink-0" />
                                        ) : null}
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                            <div>
                              <span className={`mb-1 block text-[11px] ${TEXT_TERTIARY}`}>
                                写入 .env.example 的地址
                              </span>
                              <input
                                className={`${INPUT} h-8 font-mono text-xs`}
                                value={baseURL}
                                onChange={(event) => setBaseURL(event.target.value)}
                                placeholder="留空沿用现有"
                                spellCheck={false}
                                disabled={syncing || missing}
                                aria-label="写入 .env.example 的地址"
                              />
                            </div>
                          </div>

                          {stack?.options.length ? (
                            <div>
                              <span className={`mb-1 block text-[11px] ${TEXT_TERTIARY}`}>
                                附带内容
                              </span>
                              <div className="grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
                                {stack.options.map((option) =>
                                  optionRow(option.id, option.label, option.hint),
                                )}
                              </div>
                            </div>
                          ) : null}

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className={PRIMARY_BTN}
                              onClick={() => void syncSkeleton()}
                              disabled={syncing || missing || !stack}
                            >
                              {syncing ? '同步中…' : '同步骨架文件'}
                            </button>
                            {syncResult ? (
                              <span className={`text-[11px] ${TEXT_SECONDARY}`}>
                                新增 {syncResult.created} · 更新 {syncResult.changed} · 未变{' '}
                                {syncResult.same}
                                {syncResult.kept ? ` · 保留 .env` : ''}
                              </span>
                            ) : null}
                          </div>

                          {syncResult?.backupDir ? (
                            <p
                              className={`break-all rounded-lg bg-(--tw-surface-recessed) px-2.5 py-2 text-[10px] leading-4 ${TEXT_TERTIARY}`}
                            >
                              原文件备份：<span className="font-mono">{syncResult.backupDir}</span>
                            </p>
                          ) : null}
                          {syncError ? (
                            <p className="rounded-lg bg-red-50 px-2.5 py-2 text-[11px] leading-4 text-red-600">
                              {syncError}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                  </div>
                </div>
              </div>

              {/* 运行环境 */}
              <div
                id="ui-auto-config-runtime"
                role="tabpanel"
                className={`${tab === 'runtime' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}
              >
                {/* 四边留一样的 24px：日志吃掉剩余高度，不再留一截空白在下面 */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pt-6 pb-6">
                  {current.setupSupported ? (
                    <UiAutoSetupPanel
                      projectId={current.id}
                      plan={current.setupPlan ?? []}
                      note={current.setupNote ?? ''}
                      showTitle={false}
                      fill
                      onStatusChange={(setup) => {
                        setCurrent((prev) =>
                          prev.setup?.status === setup.status ? prev : { ...prev, setup },
                        );
                        // 开始 / 结束时让列表刷新一次，卡片状态行与左栏状态点跟上
                        onChanged?.();
                      }}
                    />
                  ) : (
                    <div className="rounded-xl bg-(--tw-surface-recessed) px-3.5 py-3 text-[11px] leading-5 text-[var(--tw-label-secondary)]">
                      这个技术栈暂不支持一键安装：pytest 请在项目目录里装好解释器与依赖（
                      <code className="font-mono">pip install -r requirements.txt</code>），Selenium
                      按 Maven / Gradle 的方式拉依赖。装好后回到卡片，运行环境会自己变成就绪。
                    </div>
                  )}
                </div>
              </div>

              {/* 环境配置 */}
              <div
                id="ui-auto-config-env"
                role="tabpanel"
                className={`${tab === 'env' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}
              >
                <UiAutoEnvPanel
                  project={current}
                  embedded
                  onDirtyChange={setEnvDirty}
                  onSaved={(next) => {
                    if (next) applyProject(next);
                    else onChanged?.();
                  }}
                />
              </div>
            </div>
          </div>
        </DialogPanel>
      </div>

      <ConfirmDialog
        open={confirmClose}
        title="关闭项目配置"
        message="环境配置还有未保存的改动，关闭后这些改动会丢掉。"
        confirmLabel="仍然关闭"
        onClose={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
      />
    </Dialog>
  );
}
