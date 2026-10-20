/**
 * 自动化测试：页面级顶栏（运行 / 生成 / 历史）+ 单行工具条（项目 / 框架 / 打开方式）。
 *
 * - 项目通过系统原生选目录挂载，顶栏只用项目下拉切换；菜单里每项第二行显示真实目录。
 * - 运行时按 1s 轮询增量日志，结束后自动刷新汇总与历史。
 * - 日志是内容区里的一块普通面板（浅色、等宽字体），不模拟终端窗口。
 * - 看文件交给「打开方式」：只在本机拉起已安装的应用，不上传、不改文件。
 */
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addProject,
  deleteRun,
  describeRunArgs,
  displayRunCommand,
  fetchProjects,
  fetchRunLog,
  fetchRuns,
  formatDateTime,
  formatDuration,
  frameworkKindLabel,
  isTerminalStatus,
  notifyPromptMountsChanged,
  pickProjectDirectory,
  removeProject,
  RUN_STATUS_META,
  startRun,
  stopRun,
  summarizeRun,
  updateProject,
  type FrameworkOption,
  type CustomRunTask,
  type TaskOverride,
  type RunTask,
  type RunOptions,
  type UiAutoProject,
  type UiAutoRun,
} from '../../lib/ui-auto';
import { revealPath } from '../../lib/ui-auto-agent';
import { syncUiAutoPrompt, UI_AUTO_PROMPT_FILE } from '../../lib/ui-auto-prompt';
import { listDocs } from '../../lib/project-docs';
import { promptOwnerKind } from '../../lib/prompts-meta';
import { readViewJson, readViewText, writeViewJson, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import OpenWithMenu from './OpenWithMenu';
import OverflowHint from './OverflowHint';
import PromptMountDialog from './PromptMountDialog';
import RunConfigDialog from './RunConfigDialog';
import UiAutoGenerate from './UiAutoGenerate';
import SelectDropdown, { type SelectOption } from './SelectDropdown';
import { PmEmpty, PmErrorBar, PmIcon, PmLoading, PmTag, usePmPlugin } from './PmShared';
import { showToast } from './Toast';

type Tab = 'run' | 'generate' | 'history';

/** 下拉里的任务名：名称（命令）；没有名称就只显示命令 */
function taskTitle(task: RunTask): string {
  if (task.kind === 'full') return '全量运行';
  const name = task.display?.trim() ?? '';
  if (!name || name === task.command) return task.label || task.command;
  return `${name}（${task.command}）`;
}

const TABS = [
  { value: 'run', label: '运行' },
  { value: 'generate', label: '生成' },
  { value: 'history', label: '历史' },
] as const;

const PROJECT_PREF = 'ui-auto.project';
const TAB_PREF = 'ui-auto.tab';
const TASK_PREF = 'ui-auto.task';
/** 运行日志的滚动位置按「运行 id」记：刷新回来自动附着同一次运行，位置也就对得上 */
const logScrollPref = (runId: string) => `ui-auto.log-scroll.${runId}`;
interface LogScrollPref {
  top: number;
  stick: boolean;
}
/** 运行任务按项目分开记：A 项目的 marker 选到 B 项目会失效，不能共用一个键 */
const taskPref = (projectId: string) => `${TASK_PREF}.${projectId}`;
const POLL_MS = 1000;

const BTN_PRIMARY =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#4176e6] px-3 text-sm font-medium text-white transition-colors hover:bg-[#3566d0] disabled:cursor-not-allowed disabled:opacity-50';
const BTN_GHOST =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-stone-200 px-3 text-sm text-stone-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40';
const BTN_DANGER =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-sm text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40';

export default function UiAutoBoard() {
  const { ready, on } = usePmPlugin('uiAuto');

  const [projects, setProjects] = useState<UiAutoProject[]>([]);
  const [frameworks, setFrameworks] = useState<FrameworkOption[]>([]);
  const [selectedId, setSelectedId] = useState(() => readViewText(PROJECT_PREF));
  const [loading, setLoading] = useState(true);
  /**
   * 首屏还没有完整数据（项目 + 选中项目的历史）时为 true。
   * 此时整块渲染成带标记的占位，配合 CSS 让刷新缓存继续顶着，
   * 避免先塌成一个小 loading、再长回整张卡片。
   */
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTabState] = useState<Tab>(() =>
    readViewText(TAB_PREF) === 'history'
      ? 'history'
      : readViewText(TAB_PREF) === 'generate'
        ? 'generate'
        : 'run',
  );
  const [taskId, setTaskId] = useState(() => readViewText(TASK_PREF) || 'full');
  const [configOpen, setConfigOpen] = useState(false);
  const [taskError, setTaskError] = useState('');
  /** 提示词：只读展示当前挂载的那份；点它打开「挂载提示词」弹窗 */
  const [promptOptions, setPromptOptions] = useState<SelectOption[]>([]);
  /** 提示词列表是否已经从磁盘读回来（读回来之前不做「必须挂载」拦截） */
  const [promptReady, setPromptReady] = useState(false);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);

  const [runs, setRuns] = useState<UiAutoRun[]>([]);
  const [activeRun, setActiveRun] = useState<UiAutoRun | null>(null);
  const [log, setLog] = useState('');
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const offsetRef = useRef(0);
  const logRef = useRef<HTMLPreElement | null>(null);
  const stickRef = useRef(true);
  /** 刷新 / 切回时待恢复的滚动位置；等日志真正渲染出来再应用一次 */
  const logRestoreRef = useRef<LogScrollPref | null>(null);
  /** 滚动事件的写入节流：滚动很密，没必要每个像素都写 localStorage */
  const logSaveTimer = useRef(0);

  /** 挂载面板：可系统选目录，也可直接填路径（原生弹窗不可用时兜底） */
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  /** 只有目录失联时才用它来改指新路径 */
  const [addTarget, setAddTarget] = useState<UiAutoProject | null>(null);
  const [addError, setAddError] = useState('');
  const [picking, setPicking] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<UiAutoProject | null>(null);
  const [deleteRunTarget, setDeleteRunTarget] = useState<UiAutoRun | null>(null);
  /** 复制路径后短暂把菜单项文案换成「已复制」 */
  const [copiedPath, setCopiedPath] = useState(false);

  const [now, setNow] = useState(() => Date.now());

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? null,
    [projects, selectedId],
  );

  /**
   * 这个项目实际生效的提示词。
   * 项目里存的文件被删 / 改名（或在提示词管理里挪了位置）时回落到插件默认那份，
   * 避免下拉显示一个已经不存在的文件名、生成时才报「读不到提示词」。
   */
  const activePrompt = useMemo(() => {
    const wanted = selected?.promptFile ?? '';
    return wanted && promptOptions.some((option) => option.value === wanted)
      ? wanted
      : UI_AUTO_PROMPT_FILE;
  }, [selected?.promptFile, promptOptions]);

  /**
   * 「这个项目真的挂着一份还在的提示词」——不能只看 activePrompt：
   * 它读不到时会回落到插件默认那份，那是兜底展示，不代表项目已经挂载。
   * 列表还没读回来时先当作已就绪，避免刚进页面就弹强制挂载。
   */
  const promptMissing = useMemo(() => {
    if (!selected || !promptReady) return false;
    // 连候选都没有时不做强制拦截：那是提示词文件缺失，应该去提示词管理处理，
    // 弹一个选不了任何东西的弹窗只会把人卡死
    if (!promptOptions.length) return false;
    const wanted = (selected.promptFile ?? '').trim();
    return !wanted || !promptOptions.some((option) => option.value === wanted);
  }, [selected, promptReady, promptOptions]);

  // 没挂提示词就拦住：自动弹挂载弹窗，选一份挂上之前不给用页面
  useEffect(() => {
    if (promptMissing) setPromptDialogOpen(true);
  }, [promptMissing]);

  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        value: project.id,
        label: project.name,
        // 第二行显示真实目录：用户目录简写成 `~`，过长由气泡补全
        secondary: project.dir.replace(/^\/Users\/[^/]+/, '~'),
      })),
    [projects],
  );

  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    writeViewText(TAB_PREF, next);
  }, []);

  /**
   * 提示词列表来自「提示词管理」的目录（含分组子目录，只收 .md）。
   * 只列能用来生成的：自动化测试自己那份 + 用户自己建的（未关联任何插件）。
   * 工作汇报提示词、默认提示词这类属于别的用途，选进来也跑不通，直接不展示。
   * 切回页面时再拉一次：在提示词管理里新建 / 改名后，这里能跟上；
   * 目录树接口只给目录不给文件，所以按目录逐层 list。
   * 返回最新列表（新建提示词后要据此判断项目原来挂的那份还在不在）。
   */
  const refreshPrompts = useCallback(async (): Promise<SelectOption[]> => {
    const collect = async (dir: string): Promise<string[]> => {
      const { entries } = await listDocs('prompts', dir);
      const prefix = dir === '.' ? '' : `${dir}/`;
      const files = entries
        .filter((entry) => entry.type === 'file' && /\.md$/i.test(entry.name))
        .map((entry) => `${prefix}${entry.name}`);
      const nested = await Promise.all(
        entries
          .filter((entry) => entry.type === 'dir')
          .map((entry) => collect(`${prefix}${entry.name}`)),
      );
      return [...files, ...nested.flat()];
    };
    const paths = await collect('.');
    const usable = paths.filter((path) => {
      const owner = promptOwnerKind(path);
      return !owner || owner === 'uiAuto';
    });
    const options = usable.sort().map((path) => ({ value: path, label: path }));
    setPromptOptions(options);
    return options;
  }, []);

  useEffect(() => {
    if (!on) return;
    void refreshPrompts()
      .catch(() => undefined)
      .finally(() => setPromptReady(true));
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshPrompts().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [on, refreshPrompts]);

  const refreshProjects = useCallback(async () => {
    const result = await fetchProjects();
    setProjects(result.projects);
    if (result.frameworks.length) setFrameworks(result.frameworks);
    return result.projects;
  }, []);

  const refreshRuns = useCallback(async (projectId: string) => {
    const list = await fetchRuns(projectId);
    setRuns(list);
    return list;
  }, []);

  /** 当前附着的运行 id（滚动位置按它落盘）；渲染期同步，供回调里读到最新值 */
  const activeRunIdRef = useRef('');
  activeRunIdRef.current = activeRun?.id ?? '';

  /** 把运行日志当前滚动位置写进本地偏好：刷新后能回到原处 */
  const persistLogScroll = useCallback(() => {
    const el = logRef.current;
    const id = activeRunIdRef.current;
    if (!el || !id) return;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    writeViewJson(logScrollPref(id), { top: el.scrollTop, stick } satisfies LogScrollPref);
  }, []);

  const attachRun = useCallback(
    async (runId: string) => {
      // 切到别的运行之前，先把当前这份日志的滚动位置存下来
      persistLogScroll();
      const res = await fetchRunLog(runId, 0);
      setActiveRun(res.run);
      setLog(res.log);
      setStopping(res.stopping);
      offsetRef.current = res.nextOffset;
      // 刷新回来自动附着同一次运行：用户上次往上翻着看，就停回原处；
      // 上次本来就在底部（或没有记录）则继续自动跟到底。
      const saved = readViewJson<LogScrollPref | null>(logScrollPref(runId), null);
      const restore = saved && typeof saved.top === 'number' && !saved.stick ? saved : null;
      logRestoreRef.current = restore;
      stickRef.current = !restore;
    },
    [persistLogScroll],
  );

  // 首次加载项目列表
  useEffect(() => {
    if (!on) return;
    let alive = true;
    // 插件开着就保证「提示词管理/Playwright提示词.md」存在（已有内容不覆盖）
    void syncUiAutoPrompt(true).catch(() => undefined);
    setLoading(true);
    refreshProjects()
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [on, refreshProjects]);

  // 选中项失效时回退到第一个项目
  useEffect(() => {
    if (!projects.length) return;
    if (projects.some((project) => project.id === selectedId)) return;
    const next = projects[0].id;
    setSelectedId(next);
    writeViewText(PROJECT_PREF, next);
  }, [projects, selectedId]);

  // 切换项目：加载历史 + 附着到运行中 / 最近一次运行
  useEffect(() => {
    if (!on || !selectedId) {
      setRuns([]);
      setActiveRun(null);
      setLog('');
      // 没有选中项目（还没挂载 / 列表为空）时，首屏到这里就算就绪
      if (on) setBooting(false);
      return;
    }
    let alive = true;
    setRuns([]);
    setActiveRun(null);
    setLog('');
    setStopping(false);
    offsetRef.current = 0;
    logRestoreRef.current = null;
    // 每个项目记自己的运行任务；没记过就回到全量运行
    setTaskId(readViewText(taskPref(selectedId)) || 'full');
    refreshRuns(selectedId)
      .then((list) => {
        if (!alive) return;
        const latest = list.find((run) => run.status === 'running') ?? list[0];
        if (latest) void attachRun(latest.id).catch(() => undefined);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setBooting(false);
      });
    return () => {
      alive = false;
    };
  }, [on, selectedId, refreshRuns, attachRun]);

  const refreshAfterRun = useCallback(async () => {
    await refreshProjects().catch(() => null);
    if (selectedId) await refreshRuns(selectedId).catch(() => null);
  }, [refreshProjects, refreshRuns, selectedId]);

  const tasks = useMemo(() => selected?.runTasks ?? [], [selected?.runTasks]);

  /** 当前任务：选中的那条，失效时退回「全量运行」 */
  const currentTask = useMemo(
    () => tasks.find((task) => task.id === taskId) ?? tasks[0] ?? null,
    [tasks, taskId],
  );

  /** 任务下拉：全量 + 项目自带 + 自定义（后端还是旧版时至少留一条全量） */
  const taskOptions = useMemo(
    () => [
      ...(tasks.length
        ? tasks.map((task) => ({ value: task.id, label: taskTitle(task) }))
        : [{ value: 'full', label: '全量运行' }]),
    ],
    [tasks],
  );

  /** 运行按钮状态：运行中 / 上一次结果 */
  const lastStatus = activeRun?.status ?? '';

  const activeRunId = activeRun?.id ?? '';
  const activeRunning = activeRun?.status === 'running';

  // 运行中：1s 增量拉日志
  useEffect(() => {
    if (!activeRunId || !activeRunning) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetchRunLog(activeRunId, offsetRef.current);
        if (!alive) return;
        if (res.reset) setLog(res.log);
        else if (res.log) setLog((prev) => prev + res.log);
        offsetRef.current = res.nextOffset;
        setStopping(res.stopping);
        setActiveRun(res.run);
        if (isTerminalStatus(res.run.status)) void refreshAfterRun();
      } catch {
        // 网络抖动：下一轮再试
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [activeRunId, activeRunning, refreshAfterRun]);

  // 运行中每秒刷新耗时
  useEffect(() => {
    if (!activeRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeRunning]);

  // 刷新缓存交给 HydrateCache（capture）：它只在「真实内容就绪」时存，
  // 并且在离开页面 / 刷新前再存一次，这里自己按 deps 存会存到半截骨架或旧内容。

  // 空闲时低频轮询：别处改了挂载、或某次运行刚结束，页面自动跟上
  useEffect(() => {
    if (activeRunning) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refreshProjects().catch(() => null);
      if (selectedId) void refreshRuns(selectedId).catch(() => null);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [activeRunning, selectedId, refreshProjects, refreshRuns]);

  // 日志默认自动滚底；用户往上翻时先停住，回到底部再恢复；
  // 刷新 / 切回同一份运行时，按上次记录的位置还原
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const pending = logRestoreRef.current;
    if (pending) {
      logRestoreRef.current = null;
      el.scrollTop = pending.top;
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  // 离开页面（刷新 / 关标签 / 切后台）时把位置存下来
  useEffect(() => {
    const onHide = () => persistLogScroll();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persistLogScroll();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(logSaveTimer.current);
    };
  }, [persistLogScroll]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = atBottom;
    // 滚动很密，节流后再写，避免每个像素都动 localStorage
    window.clearTimeout(logSaveTimer.current);
    logSaveTimer.current = window.setTimeout(() => persistLogScroll(), 200);
  };

  const doRun = useCallback(
    async (overrides: Partial<RunOptions> = {}) => {
      if (!selectedId) return;
      setError('');
      setBusy(true);
      try {
        // 文件 / 表达式 / headed / 并发这些筛选暂时不开放，只留「运行任务」；
        // 重跑失败用例这类入口仍通过 overrides 透传。
        const run = await startRun(selectedId, {
          taskId: currentTask?.id ?? 'full',
          ...overrides,
        });
        setActiveRun(run);
        setLog('');
        setStopping(false);
        offsetRef.current = 0;
        // 新的一次运行没有历史位置：从头跟着输出滚到底
        logRestoreRef.current = null;
        stickRef.current = true;
        setTab('run');
        await refreshRuns(selectedId).catch(() => null);
        await refreshProjects().catch(() => null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [selectedId, currentTask, refreshRuns, refreshProjects, setTab],
  );

  /** 打开卡片内的挂载面板（target 有值表示目录失联后重新指路） */
  const openMountPanel = (target: UiAutoProject | null = null) => {
    setError('');
    setAddError('');
    setAddTarget(target);
    setAddPath(target?.dir ?? '');
    setAddOpen(true);
  };

  const closeMountPanel = () => {
    if (picking) return;
    // 只收起面板：内容保持到淡出结束，避免收起瞬间标题先跳一下
    setAddOpen(false);
  };

  /** 目录 / 文件交给本机应用打开；失败只提示，不影响页面 */
  const openPath = useCallback(
    (params: { path?: string; app?: string }) => {
      if (!selected) return;
      void revealPath({ projectId: selected.id, path: params.path, app: params.app }).catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    },
    [selected],
  );

  const onBrowseDirectory = async () => {
    setPicking(true);
    setAddError('');
    try {
      const dir = await pickProjectDirectory();
      if (dir) setAddPath(dir);
    } catch (err) {
      // 原生弹窗被系统拦住时，直接告诉用户可以手填路径
      setAddError(
        `${err instanceof Error ? err.message : String(err)}（可在下方直接填写目录路径）`,
      );
    } finally {
      setPicking(false);
    }
  };

  /** 运行配置：把改动整组提交给服务端，项目记录里跟着空间走 */
  const submitProjectPatch = async (patch: {
    customTasks?: CustomRunTask[];
    taskOverrides?: TaskOverride[];
    hiddenTasks?: string[];
  }) => {
    if (!selected) return;
    setTaskError('');
    try {
      const project = await updateProject({
        id: selected.id,
        customTasks: patch.customTasks?.map(({ id, name, command }) => ({ id, name, command })),
        taskOverrides: patch.taskOverrides,
        hiddenTasks: patch.hiddenTasks,
      });
      setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)));
      // 当前选中的任务被删掉了：退回全量
      if (!(project.runTasks ?? []).some((task) => task.id === taskId)) {
        setTaskId('full');
        writeViewText(taskPref(project.id), 'full');
      }
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveCustomTasks = (next: CustomRunTask[]) => submitProjectPatch({ customTasks: next });

  /**
   * 挂载提示词：按项目落盘，切回这个项目还是这份。
   * 挂上即「引用」——提示词管理里这份会显示「引用中」，插件开着时不允许删 / 改名。
   * 落盘成功后广播一次，提示词管理页的「引用中」即时重算。
   */
  const onSwitchPrompt = useCallback(
    async (file: string) => {
      if (!selected) return;
      const projectId = selected.id;
      setProjects((prev) =>
        prev.map((item) => (item.id === projectId ? { ...item, promptFile: file } : item)),
      );
      try {
        const project = await updateProject({ id: projectId, promptFile: file });
        setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)));
        setPromptDialogOpen(false);
        notifyPromptMountsChanged();
        showToast(file ? `已挂载「${file}」` : '已取消挂载', 'success');
      } catch (err) {
        // 落盘失败要回滚，否则界面上看着已经换了、生成时还是旧的；错误由弹窗展示
        await refreshProjects().catch(() => undefined);
        throw err;
      }
    },
    [selected, refreshProjects],
  );

  /** 改自动发现的任务：只存与扫描结果的差异，名称 / 命令留空表示不覆盖 */
  const onEditDetected = async (id: string, name: string, command: string) => {
    if (!selected) return;
    const overrides = (selected.taskOverrides ?? []).filter((item) => item.id !== id);
    const next = { id, name: name.trim(), command: command.trim() };
    if (next.name || next.command) overrides.push(next);
    await submitProjectPatch({ taskOverrides: overrides });
  };

  const onHideDetected = async (id: string) => {
    if (!selected) return;
    await submitProjectPatch({
      taskOverrides: (selected.taskOverrides ?? []).filter((item) => item.id !== id),
      hiddenTasks: [...new Set([...(selected.hiddenTasks ?? []), id])],
    });
  };

  /** 恢复默认：清掉所有改动与删除记录，重新按扫描结果展示 */
  const onResetDetected = async () => {
    await submitProjectPatch({ taskOverrides: [], hiddenTasks: [] });
  };

  const onAddTask = async (name: string, command: string) => {
    if (!selected) return;
    const value = command.trim();
    if (!value) {
      setTaskError('先填要执行的命令');
      return;
    }
    // 名称为空就留空，下拉里直接显示命令
    await saveCustomTasks([...(selected.customTasks ?? []), { id: '', name, command: value }]);
  };

  const onRemoveTask = async (id: string) => {
    if (!selected) return;
    await saveCustomTasks((selected.customTasks ?? []).filter((task) => task.id !== id));
  };

  const onSubmitAdd = async () => {
    const dir = addPath.trim();
    if (!dir) {
      setAddError('请先选择或填写项目目录');
      return;
    }
    setBusy(true);
    setAddError('');
    try {
      let projectId: string;
      if (addTarget) {
        const project = await updateProject({ id: addTarget.id, dir });
        projectId = project.id;
      } else {
        const project = await addProject(dir);
        projectId = project.id;
      }
      await refreshProjects();
      // 挂载完直接选中它，停在「运行」页
      setSelectedId(projectId);
      writeViewText(PROJECT_PREF, projectId);
      setTab('run');
      setAddOpen(false);
      setAddTarget(null);
      setAddPath('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 同一个目录重复挂载：直接切到已有那条记录，不当成报错
      const exists = projects.find((item) => item.dir === dir);
      if (exists && /已经添加/.test(message)) {
        setSelectedId(exists.id);
        writeViewText(PROJECT_PREF, exists.id);
        setTab('run');
        setAddOpen(false);
        setAddPath('');
        return;
      }
      setAddError(message);
    } finally {
      setBusy(false);
    }
  };

  /** 顶栏框架已改成只读徽标：框架由目录内容自动识别，不再手动切换 */

  const onStop = async () => {
    if (!activeRun) return;
    setError('');
    try {
      await stopRun(activeRun.id);
      setStopping(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRerunFailed = () => {
    // 任务自己声明不了失败参数（make 目标 / 自定义命令）时别假装能只跑失败
    if (!currentTask?.failureFlags) {
      setError('当前运行任务不支持只跑失败用例，切到「全量运行」或 pytest 任务再试');
      return;
    }
    void doRun({ lastFailed: true });
  };

  const onDeleteRun = async () => {
    if (!deleteRunTarget) return;
    setError('');
    try {
      await deleteRun(deleteRunTarget.id);
      if (activeRun?.id === deleteRunTarget.id) {
        setActiveRun(null);
        setLog('');
      }
      if (selectedId) await refreshRuns(selectedId);
      await refreshProjects().catch(() => null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteRunTarget(null);
    }
  };

  if (!ready || booting) {
    // 带 `.tw-hydrate-pending` 标记：有缓存时 CSS 会先把岛屿藏起来，让缓存继续占位
    return (
      <div className="tw-hydrate-pending h-full w-full">
        <PmLoading label="加载自动化测试…" />
      </div>
    );
  }

  if (!on) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        该插件未启用，到「我的插件」里打开「自动化测试」就能挂载 Playwright / pytest / Selenium
        项目。
      </div>
    );
  }

  /**
   * 挂载面板：直接铺在卡片里（不用弹窗），选目录 → 点「挂载」就完事，
   * 框架由后端按目录内容自动识别，挂完直接选中并停在「运行」页。
   * 空状态分支会提前 return，所以抽成变量让两个分支共用。
   */
  const mountPanel = (
    <div className="border-b border-stone-100 bg-stone-50/60 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-stone-700">
          {addTarget ? '重新指定项目目录' : '挂载项目'}
        </span>
        <span className="text-[11px] text-stone-400">
          自动识别 Playwright / pytest / Selenium，只读取与运行，不改项目文件
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          className="h-8 min-w-[260px] flex-1 rounded-lg border border-stone-200 bg-white px-2.5 font-mono text-xs text-stone-700 outline-none transition-colors focus:border-[#3370ff]"
          value={addPath}
          onChange={(event) => setAddPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void onSubmitAdd();
          }}
          placeholder="/path/to/your-test-project"
          aria-label="项目目录"
          spellCheck={false}
        />
        <button
          type="button"
          className={BTN_GHOST}
          onClick={() => void onBrowseDirectory()}
          disabled={picking}
        >
          <PmIcon name="folder" size={13} />
          {picking ? '选择中…' : '浏览…'}
        </button>
        <button
          type="button"
          className={BTN_PRIMARY}
          onClick={() => void onSubmitAdd()}
          disabled={busy || picking || !addPath.trim()}
        >
          {busy ? '挂载中…' : addTarget ? '保存目录' : '挂载'}
        </button>
      </div>

      {addError ? (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-600">
          {addError}
        </p>
      ) : null}
    </div>
  );

  const elapsedMs = activeRun
    ? activeRunning
      ? Math.max(0, now - Date.parse(activeRun.startedAt))
      : activeRun.durationMs
    : 0;

  /** 挂载面板常驻 DOM，只在展开 / 收起时切高度与透明度；没有项目时保持展开 */
  const mountShown = addOpen || !projects.length;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
      {error ? <PmErrorBar message={error} onClose={() => setError('')} /> : null}

      {/* 顶栏：标题 / 运行·生成·历史 / 项目与操作全在一行；Tab 用下划线式，不再套灰盒 */}
      <header className="relative z-20 flex h-12 shrink-0 items-center gap-3 border-b border-stone-200 px-4">
        <h1 className="shrink-0 text-sm font-semibold text-stone-800">自动化测试</h1>
        <span className="h-4 w-px shrink-0 bg-stone-200" aria-hidden="true" />

        {selected ? (
          <div
            role="tablist"
            aria-label="自动化测试视图"
            className="flex h-full shrink-0 items-stretch"
          >
            {TABS.map((item) => {
              const count = item.value === 'history' ? runs.length : 0;
              const active = tab === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(item.value)}
                  className={`relative flex h-full items-center gap-1.5 border-b-2 px-2.5 text-[13px] transition-colors ${
                    active
                      ? 'border-[#3370ff] font-medium text-stone-900'
                      : 'border-transparent text-stone-500 hover:text-stone-800'
                  }`}
                >
                  {item.label}
                  {count ? (
                    <span
                      className={`rounded-full px-1.5 text-[11px] leading-4 tabular-nums ${
                        active ? 'bg-[#eaf1ff] text-[#3370ff]' : 'bg-stone-100 text-stone-400'
                      }`}
                    >
                      {count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="truncate text-[11px] text-stone-400">
            {loading ? '正在读取挂载列表…' : '还没有挂载项目'}
          </span>
        )}

        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
          {selected ? (
            <>
              {/* 提示词放在项目下拉左边：先定「这轮用哪份提示词」，再定「跑哪个项目」。
                  不做成下拉：固定宽度，只显示当前挂载的那份，超长省略号 + 气泡；
                  点它打开「挂载提示词」弹窗，旁边不再放添加按钮 */}
              <button
                type="button"
                className="flex h-8 w-40 min-w-0 items-center rounded-lg border border-stone-200 bg-white px-2.5 text-left transition-colors hover:border-stone-300 focus:border-[#4176e6] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4176e6]/30"
                onClick={() => setPromptDialogOpen(true)}
                aria-label="挂载提示词"
              >
                <OverflowHint
                  text={activePrompt}
                  className="min-w-0 flex-1 truncate text-sm text-stone-700"
                />
              </button>

              <SelectDropdown
                options={projectOptions}
                value={selected.id}
                onChange={(id) => {
                  setSelectedId(id);
                  writeViewText(PROJECT_PREF, id);
                }}
                compact
                className="w-48"
                ariaLabel="切换项目"
                triggerClassName={selected.exists ? '' : 'text-amber-700'}
                // 项目名被省略号截断也不弹气泡：完整名称在项目下拉里一目了然，省得挡住顶栏
                hideTriggerHint
                // 菜单里每项悬停出一个删除按钮：移出项目（仅删挂载记录，文件与历史都留）
                renderOptionAction={(option) => {
                  const project = projects.find((item) => item.id === option.value);
                  if (!project) return null;
                  return (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`移出 ${project.name}`}
                      className="rounded p-1 text-stone-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0 disabled:group-hover:opacity-40"
                      onClick={() => setRemoveTarget(project)}
                    >
                      <PmIcon name="trash" size={13} />
                    </button>
                  );
                }}
              />

              {/* 框架由目录内容自动识别，只读展示，不做成可点下拉 */}
              {selected.frameworkReady ? (
                <span className="shrink-0 whitespace-nowrap text-[11px] text-stone-500">
                  {[
                    frameworks.find((item) => item.id === selected.framework)?.label ||
                      selected.framework,
                    selected.kind ? frameworkKindLabel(selected.kind) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              ) : (
                <span className="shrink-0 whitespace-nowrap text-[11px] text-amber-600">
                  运行环境未就绪
                </span>
              )}

              <OpenWithMenu
                onOpen={(app) => openPath({ path: '', app: app?.id })}
                disabled={!selected.exists}
              />
            </>
          ) : null}

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className={`${BTN_GHOST} ${
                addOpen ? 'border-[#4176e6] bg-[#f2f6ff] text-[#3566d0] hover:bg-[#eaf1ff]' : ''
              }`}
              onClick={() => (addOpen ? closeMountPanel() : openMountPanel(null))}
              disabled={busy || picking}
              aria-expanded={addOpen}
            >
              <PmIcon name="plus" size={13} />
              挂载
            </button>

            {selected ? (
              <Menu as="div" className="relative shrink-0">
                <MenuButton
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-stone-200 text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-700"
                  aria-label="更多操作"
                >
                  <PmIcon name="more" size={16} />
                </MenuButton>
                <MenuItems
                  anchor={{ to: 'bottom end', gap: 4, padding: 12 }}
                  transition
                  className="tw-select-menu tw-menu-anim z-80 w-max min-w-[168px] space-y-0.5 rounded-lg p-1 pb-2 shadow-lg ring-1 ring-stone-200 focus:outline-none"
                >
                  <MenuItem>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm text-stone-700 data-[focus]:bg-stone-50"
                      onClick={() => {
                        const copying = navigator.clipboard?.writeText(selected.dir);
                        void copying?.then(() => setCopiedPath(true)).catch(() => undefined);
                        window.setTimeout(() => setCopiedPath(false), 1200);
                      }}
                    >
                      {copiedPath ? '已复制路径' : '复制项目路径'}
                    </button>
                  </MenuItem>
                  <MenuItem>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm text-stone-700 data-[focus]:bg-stone-50"
                      onClick={() => openMountPanel(selected)}
                    >
                      重新指定目录
                    </button>
                  </MenuItem>
                  <div className="my-1 h-px bg-stone-100" aria-hidden="true" />
                  <MenuItem>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm text-red-600 data-[focus]:bg-red-50"
                      onClick={() => setRemoveTarget(selected)}
                    >
                      移出项目
                    </button>
                  </MenuItem>
                </MenuItems>
              </Menu>
            ) : null}
          </div>
        </div>
      </header>

      {!selected && !loading ? (
        <p className="shrink-0 border-b border-stone-100 bg-stone-50/60 px-4 py-1.5 text-[11px] text-stone-500">
          还没有挂载项目。点右上角「挂载」选一个 Playwright / pytest / Selenium 目录，自动识别框架。
        </p>
      ) : null}

      {/* 挂载面板：展开 / 收起都走同一条高度 + 淡入淡出过渡，不做硬切 */}
      <div
        className={`grid shrink-0 transition-[grid-template-rows,opacity] duration-200 ease-out ${
          mountShown ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
        aria-hidden={!mountShown}
      >
        <div className="overflow-hidden" inert={!mountShown}>
          {mountPanel}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              {tab === 'run' ? (
                <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* 运行任务：项目自带的脚本 / Makefile 目标 / marker，或运行配置里自己加的命令 */}
                    <span className="text-xs text-stone-400">运行任务</span>
                    <SelectDropdown
                      options={taskOptions}
                      value={currentTask?.id ?? 'full'}
                      onChange={(value) => {
                        setTaskId(value);
                        if (selected) writeViewText(taskPref(selected.id), value);
                      }}
                      compact
                      className="w-60"
                      ariaLabel="运行任务"
                    />
                    {/* 配置入口贴在任务下拉右边：命令会越加越多，收进弹窗，别撑高页面 */}
                    <button
                      type="button"
                      className={BTN_GHOST}
                      onClick={() => {
                        setTaskError('');
                        setConfigOpen(true);
                      }}
                      disabled={busy}
                      aria-label="运行配置"
                    >
                      <svg
                        className="h-3.5 w-3.5 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
                        <circle cx="16" cy="7" r="2" />
                        <circle cx="10" cy="17" r="2" />
                      </svg>
                      配置
                    </button>
                    <div className="ml-auto flex items-center gap-2">
                      {activeRunning ? (
                        <>
                          <button
                            type="button"
                            className={`${BTN_PRIMARY} cursor-default`}
                            disabled
                          >
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/90" />
                            运行中…
                          </button>
                          <button
                            type="button"
                            className={BTN_DANGER}
                            onClick={() => void onStop()}
                            disabled={stopping}
                          >
                            {stopping ? '停止中…' : '停止'}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={BTN_PRIMARY}
                          onClick={() => void doRun()}
                          disabled={busy || !selected.exists}
                        >
                          <PmIcon name="play" size={14} />
                          {busy ? '启动中…' : lastStatus ? '重新运行' : '运行'}
                        </button>
                      )}
                    </div>
                  </div>

                  {!selected.exists ? (
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                      项目目录已不存在（换机器或被移动过），记录与历史报告不会丢。
                      <button
                        type="button"
                        className="font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900"
                        onClick={() => openMountPanel(selected)}
                      >
                        重新指定目录
                      </button>
                    </p>
                  ) : !selected.frameworkReady ? (
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                      {selected.readyHint || '运行环境未就绪，先按项目要求安装依赖后再运行。'}
                    </p>
                  ) : null}

                  {activeRun ? (
                    <div className="rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-600">
                        <PmTag tone={RUN_STATUS_META[activeRun.status].tone}>
                          {RUN_STATUS_META[activeRun.status].label}
                        </PmTag>
                        <span className="tabular-nums">耗时 {formatDuration(elapsedMs)}</span>
                        {activeRun.status !== 'running' ? (
                          <span className="tabular-nums">{summarizeRun(activeRun)}</span>
                        ) : null}
                        {/* 任务运行显示真实命令行；老记录退回参数摘要 */}
                        <span
                          className={
                            activeRun.command
                              ? 'max-w-[360px] truncate font-mono text-[11px] text-stone-400'
                              : 'text-stone-400'
                          }
                        >
                          {activeRun.command
                            ? displayRunCommand(activeRun.command)
                            : describeRunArgs(activeRun.args, activeRun.framework)}
                        </span>
                        {activeRun.reportRel ? (
                          <span className="max-w-[320px] truncate font-mono text-[11px] text-stone-400">
                            存储：{activeRun.reportRel.replace(/\/[^/]+$/, '')}
                          </span>
                        ) : null}
                        <div className="flex items-center gap-2">
                          {activeRun.reportUrl && activeRun.status !== 'running' ? (
                            <a
                              className={BTN_GHOST}
                              href={activeRun.reportUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              查看报告
                            </a>
                          ) : null}
                          {activeRun.failed > 0 && activeRun.status !== 'running' ? (
                            <button
                              type="button"
                              className={BTN_GHOST}
                              onClick={onRerunFailed}
                              disabled={busy || !selected.exists}
                            >
                              重跑失败用例
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {activeRun.error ? (
                        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-red-50 px-2 py-1.5 text-[11px] leading-relaxed text-red-600">
                          {activeRun.error}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex min-h-[220px] flex-1 flex-col overflow-hidden rounded-lg border border-stone-200">
                    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stone-100 bg-stone-50 px-3 text-xs text-stone-500">
                      <span>运行日志</span>
                      {activeRunning ? <span className="text-[#3370ff]">实时</span> : null}
                      {log ? (
                        <span className="tabular-nums text-stone-400">{log.length} 字符</span>
                      ) : null}
                    </div>
                    <pre
                      ref={logRef}
                      onScroll={onLogScroll}
                      className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-white p-3 font-mono text-[12px] leading-relaxed text-stone-700"
                    >
                      {log || '运行后这里会显示实时输出…'}
                    </pre>
                  </div>
                </div>
              ) : null}

              {tab === 'generate' ? (
                <UiAutoGenerate
                  key={selected.id}
                  project={selected}
                  promptFile={activePrompt}
                  onError={setError}
                />
              ) : null}

              {tab === 'history' ? (
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  {runs.length === 0 ? (
                    <PmEmpty>还没有运行记录</PmEmpty>
                  ) : (
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-stone-200 text-left text-xs text-stone-400">
                          <th className="px-2 py-2 font-medium">开始时间</th>
                          <th className="px-2 py-2 font-medium">框架</th>
                          <th className="px-2 py-2 font-medium">结果</th>
                          <th className="px-2 py-2 font-medium">用例</th>
                          <th className="px-2 py-2 font-medium">耗时</th>
                          <th className="px-2 py-2 font-medium">参数</th>
                          <th className="px-2 py-2 text-right font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((run) => (
                          <tr key={run.id} className="border-b border-stone-100 last:border-0">
                            <td className="whitespace-nowrap px-2 py-2 text-xs text-stone-600">
                              {formatDateTime(run.startedAt)}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-xs text-stone-500">
                              {frameworks.find((item) => item.id === run.framework)?.label ??
                                run.framework}
                            </td>
                            <td className="px-2 py-2">
                              <PmTag tone={RUN_STATUS_META[run.status].tone}>
                                {RUN_STATUS_META[run.status].label}
                              </PmTag>
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-xs tabular-nums text-stone-600">
                              {run.total
                                ? `${run.passed}/${run.total} 通过${run.failed ? ` · ${run.failed} 失败` : ''}`
                                : '—'}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-xs tabular-nums text-stone-600">
                              {formatDuration(run.durationMs)}
                            </td>
                            <td className="max-w-[240px] truncate px-2 py-2 text-xs text-stone-500">
                              {run.command
                                ? displayRunCommand(run.command)
                                : describeRunArgs(run.args, run.framework)}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-right">
                              <button
                                type="button"
                                className="text-xs text-[#3370ff] hover:underline"
                                onClick={() => {
                                  setTab('run');
                                  void attachRun(run.id).catch((err) => setError(String(err)));
                                }}
                              >
                                日志
                              </button>
                              {run.reportUrl ? (
                                <a
                                  className="ml-3 text-xs text-[#3370ff] hover:underline"
                                  href={run.reportUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  报告
                                </a>
                              ) : null}
                              <button
                                type="button"
                                className="ml-3 text-xs text-red-500 hover:underline"
                                onClick={() => setDeleteRunTarget(run)}
                              >
                                删除
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ) : null}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-10 text-center">
              <p className="text-sm text-stone-500">挂载一个项目后就能在这里运行用例</p>
              <p className="text-xs text-stone-400">
                移出项目只删除挂载记录，项目文件与历史报告都保留
              </p>
            </div>
          )}
        </div>
      </div>

      <PromptMountDialog
        open={promptDialogOpen}
        prompts={promptOptions.map((option) => option.value)}
        value={
          selected?.promptFile &&
          promptOptions.some((option) => option.value === selected.promptFile)
            ? selected.promptFile
            : ''
        }
        force={promptMissing}
        onClose={() => setPromptDialogOpen(false)}
        onMount={onSwitchPrompt}
      />

      <RunConfigDialog
        open={configOpen}
        projectName={selected?.name ?? ''}
        detected={tasks.filter((task) => !task.custom && task.kind !== 'full')}
        customTasks={selected?.customTasks ?? []}
        hiddenCount={selected?.hiddenTasks?.length ?? 0}
        editedCount={(selected?.taskOverrides ?? []).length}
        error={taskError}
        onClose={() => {
          setConfigOpen(false);
          setTaskError('');
        }}
        onAdd={(name, command) => onAddTask(name, command)}
        onRemove={(id) => onRemoveTask(id)}
        onEdit={(id, name, command) => onEditDetected(id, name, command)}
        onHide={(id) => onHideDetected(id)}
        onReset={() => onResetDetected()}
        onRescan={() => refreshProjects().then(() => undefined)}
      />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="移出项目"
        message={`确定把「${removeTarget?.name ?? ''}」移出挂载列表吗？\n只删除挂载记录，项目文件与历史报告都保留；该项目挂载的提示词也会自动取消引用。`}
        confirmLabel="移出"
        danger="outline"
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (!target) return;
          void removeProject(target.id)
            .then(async () => {
              const list = await refreshProjects();
              if (target.id === selectedId) {
                const next = list[0]?.id ?? '';
                setSelectedId(next);
                writeViewText(PROJECT_PREF, next);
              }
              // 项目记录连同它的 promptFile 一起删掉了，等于自动取消挂载：
              // 广播一次，提示词管理页立刻把这份从「引用中」摘下来
              notifyPromptMountsChanged();
            })
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteRunTarget)}
        title="删除运行记录"
        message="会同时删除该次运行的 HTML 报告与原始日志，确定删除吗？"
        confirmLabel="删除"
        danger="solid"
        onClose={() => setDeleteRunTarget(null)}
        onConfirm={() => void onDeleteRun()}
      />
    </section>
  );
}
