/**
 * 自动化测试：一张卡片里切换项目、运行 / 停止、看日志、历史与目录。
 *
 * - 项目通过系统原生选目录挂载，只在卡片顶部用一个下拉切换；目录不在了标灰提示重选。
 * - 运行时按 1s 轮询增量日志，结束后自动刷新汇总与历史。
 * - 日志是卡片内的一块普通面板（浅色、等宽字体），不模拟终端窗口。
 * - 目录浏览与文件预览只读，代码用 <pre> 展示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addProject,
  deleteRun,
  describeRunArgs,
  fetchFile,
  fetchProjects,
  fetchRunLog,
  fetchRuns,
  formatDateTime,
  formatDuration,
  isTerminalStatus,
  pickProjectDirectory,
  removeProject,
  RUN_STATUS_META,
  startRun,
  stopRun,
  summarizeRun,
  updateProject,
  type FilePreview,
  type RunOptions,
  type UiAutoProject,
  type UiAutoRun,
} from '../../lib/ui-auto';
import { readViewText, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import SelectDropdown from './SelectDropdown';
import AutoFileTree from './ui-auto/AutoFileTree';
import {
  PmEmpty,
  PmEmptyState,
  PmErrorBar,
  PmIcon,
  PmLoading,
  PmTag,
  PmTabs,
  usePmPlugin,
} from './PmShared';

type Tab = 'run' | 'history' | 'files';

const TABS = [
  { value: 'run', label: '运行' },
  { value: 'history', label: '历史' },
  { value: 'files', label: '目录' },
] as const;

const PROJECT_PREF = 'ui-auto.project';
const POLL_MS = 1000;

const WORKERS = [
  { value: '0', label: '默认并发' },
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '8', label: '8' },
];

const BTN_PRIMARY =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#4176e6] px-3 text-sm font-medium text-white transition-colors hover:bg-[#3566d0] disabled:cursor-not-allowed disabled:opacity-50';
const BTN_GHOST =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-stone-200 px-3 text-sm text-stone-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40';
const BTN_DANGER =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-sm text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40';
const FIELD =
  'h-8 rounded-lg border border-stone-200 bg-white px-2.5 text-sm text-stone-700 outline-none transition-colors focus:border-[#3370ff]';

function statusTone(project: UiAutoProject): string {
  if (!project.exists) return 'bg-stone-300';
  if (project.runningRunId) return 'bg-[#3370ff] animate-pulse';
  switch (project.lastStatus) {
    case 'passed':
      return 'bg-green-500';
    case 'failed':
    case 'error':
      return 'bg-red-500';
    case 'cancelled':
    case 'interrupted':
      return 'bg-amber-400';
    default:
      return 'bg-stone-300';
  }
}

function projectSubtitle(project: UiAutoProject): string {
  if (!project.exists) return '目录不存在，需重新选择';
  if (project.runningRunId) return '运行中…';
  if (!project.lastRunAt) return '尚未运行';
  const label = project.lastStatus ? RUN_STATUS_META[project.lastStatus].label : '';
  return `${label} · ${formatDateTime(project.lastRunAt)}`;
}

export default function UiAutoBoard() {
  const { ready, on } = usePmPlugin('uiAuto');

  const [projects, setProjects] = useState<UiAutoProject[]>([]);
  const [selectedId, setSelectedId] = useState(() => readViewText(PROJECT_PREF));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('run');

  const [runs, setRuns] = useState<UiAutoRun[]>([]);
  const [activeRun, setActiveRun] = useState<UiAutoRun | null>(null);
  const [log, setLog] = useState('');
  const [stopping, setStopping] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [busy, setBusy] = useState(false);
  const offsetRef = useRef(0);
  const logRef = useRef<HTMLPreElement | null>(null);
  const stickRef = useRef(true);

  const [file, setFile] = useState('');
  const [grep, setGrep] = useState('');
  const [projectName, setProjectName] = useState('');
  const [headed, setHeaded] = useState(false);
  const [workers, setWorkers] = useState('0');
  const [lastFailed, setLastFailed] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<UiAutoProject | null>(null);
  const [deleteRunTarget, setDeleteRunTarget] = useState<UiAutoRun | null>(null);

  const [filePath, setFilePath] = useState('');
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [now, setNow] = useState(() => Date.now());

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? null,
    [projects, selectedId],
  );

  const projectOptions = useMemo(
    () => projects.map((project) => ({ value: project.id, label: project.name })),
    [projects],
  );

  /** Playwright 项目名：优先用当前项目上次运行拿到的列表，其次汇总历史 */
  const playwrightProjects = useMemo(() => {
    const own = selected?.projectNames ?? [];
    const names = own.length ? own : runs.flatMap((run) => run.projectNames ?? []);
    return [...new Set(names)];
  }, [selected, runs]);

  const projectNameOptions = useMemo(
    () => [
      { value: '', label: '全部项目' },
      ...playwrightProjects.map((name) => ({ value: name, label: name })),
    ],
    [playwrightProjects],
  );

  const refreshProjects = useCallback(async () => {
    const list = await fetchProjects();
    setProjects(list);
    return list;
  }, []);

  const refreshRuns = useCallback(async (projectId: string) => {
    const list = await fetchRuns(projectId);
    setRuns(list);
    return list;
  }, []);

  const attachRun = useCallback(async (runId: string) => {
    const res = await fetchRunLog(runId, 0);
    setActiveRun(res.run);
    setLog(res.log);
    setStopping(res.stopping);
    offsetRef.current = res.nextOffset;
    stickRef.current = true;
    setAutoScroll(true);
  }, []);

  // 首次加载项目列表
  useEffect(() => {
    if (!on) return;
    let alive = true;
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
      return;
    }
    let alive = true;
    setRuns([]);
    setActiveRun(null);
    setLog('');
    setStopping(false);
    setPreview(null);
    setFilePath('');
    setFile('');
    setGrep('');
    setProjectName('');
    setLastFailed(false);
    offsetRef.current = 0;
    refreshRuns(selectedId)
      .then((list) => {
        if (!alive) return;
        const latest = list.find((run) => run.status === 'running') ?? list[0];
        if (latest) void attachRun(latest.id).catch(() => undefined);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [on, selectedId, refreshRuns, attachRun]);

  const refreshAfterRun = useCallback(async () => {
    await refreshProjects().catch(() => null);
    if (selectedId) await refreshRuns(selectedId).catch(() => null);
  }, [refreshProjects, refreshRuns, selectedId]);

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

  // 日志自动滚底；用户往上翻时暂停
  useEffect(() => {
    const el = logRef.current;
    if (el && autoScroll && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [log, autoScroll]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = atBottom;
    // 往上翻时自动暂停，滚回底部再恢复
    setAutoScroll((prev) => (prev === atBottom ? prev : atBottom));
  };

  const doRun = useCallback(
    async (overrides: Partial<RunOptions> = {}) => {
      if (!selectedId) return;
      setError('');
      setBusy(true);
      try {
        const run = await startRun(selectedId, {
          file: file || undefined,
          grep: grep.trim() || undefined,
          project: projectName || undefined,
          headed,
          workers: Number(workers) || 0,
          lastFailed,
          ...overrides,
        });
        setActiveRun(run);
        setLog('');
        setStopping(false);
        offsetRef.current = 0;
        stickRef.current = true;
        setAutoScroll(true);
        setTab('run');
        await refreshRuns(selectedId).catch(() => null);
        await refreshProjects().catch(() => null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [
      selectedId,
      file,
      grep,
      projectName,
      headed,
      workers,
      lastFailed,
      refreshRuns,
      refreshProjects,
    ],
  );

  const onAddProject = async () => {
    setError('');
    setBusy(true);
    try {
      const dir = await pickProjectDirectory();
      if (!dir) return;
      const project = await addProject(dir);
      await refreshProjects();
      setSelectedId(project.id);
      writeViewText(PROJECT_PREF, project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onReselect = async (project: UiAutoProject) => {
    setError('');
    setBusy(true);
    try {
      const dir = await pickProjectDirectory();
      if (!dir) return;
      await updateProject({ id: project.id, dir });
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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
    setFile('');
    setGrep('');
    setLastFailed(true);
    void doRun({ lastFailed: true, file: '', grep: '' });
  };

  const openFile = async (path: string) => {
    if (!selectedId) return;
    setFilePath(path);
    setPreviewLoading(true);
    setError('');
    try {
      setPreview(await fetchFile(selectedId, path));
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
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

  if (!ready) return <PmLoading label="加载自动化测试…" />;

  if (!on) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        该插件未启用，到「我的插件」里打开「自动化测试」就能挂载 Playwright 项目。
      </div>
    );
  }

  if (!loading && projects.length === 0) {
    return (
      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
        {error ? <PmErrorBar message={error} onClose={() => setError('')} /> : null}
        <PmEmptyState
          icon="folder"
          title="还没有挂载项目"
          hint="选择已有的 Playwright 项目目录，插件只负责运行与查看，不会修改项目文件。"
          action={
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => void onAddProject()}
              disabled={busy}
            >
              <PmIcon name="plus" size={14} />
              选择项目目录
            </button>
          }
        />
      </div>
    );
  }

  const elapsedMs = activeRun
    ? activeRunning
      ? Math.max(0, now - Date.parse(activeRun.startedAt))
      : activeRun.durationMs
    : 0;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
      {error ? <PmErrorBar message={error} onClose={() => setError('')} /> : null}

      {/* 顶栏：项目切换 + 挂载操作 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3">
        {selected ? (
          <>
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusTone(selected)}`} />
            <SelectDropdown
              options={projectOptions}
              value={selected.id}
              onChange={(id) => {
                setSelectedId(id);
                writeViewText(PROJECT_PREF, id);
              }}
              compact
              className="w-52"
              ariaLabel="切换项目"
            />
            <span className="max-w-[300px] min-w-0 truncate text-xs text-stone-400">
              {selected.dir}
            </span>
            <span className="text-xs text-stone-400">· {projectSubtitle(selected)}</span>
            {selected.lastStatus ? (
              <PmTag tone={RUN_STATUS_META[selected.lastStatus].tone}>
                {RUN_STATUS_META[selected.lastStatus].label}
              </PmTag>
            ) : null}
            {!selected.playwrightInstalled ? (
              <span className="text-[11px] text-amber-600">未检测到本地 Playwright</span>
            ) : null}
          </>
        ) : (
          <span className="text-sm text-stone-500">加载中…</span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={BTN_GHOST}
            onClick={() => void onAddProject()}
            disabled={busy}
          >
            <PmIcon name="plus" size={13} />
            添加项目
          </button>
          {selected ? (
            <>
              <button
                type="button"
                className={BTN_GHOST}
                onClick={() => void onReselect(selected)}
                disabled={busy}
              >
                <PmIcon name="folder" size={13} />
                重选目录
              </button>
              <button
                type="button"
                className={BTN_DANGER}
                onClick={() => setRemoveTarget(selected)}
              >
                <PmIcon name="trash" size={13} />
                移出
              </button>
            </>
          ) : null}
        </div>
      </div>

      {selected ? (
        <>
          <div className="shrink-0 px-4 pt-3">
            <PmTabs
              tabs={
                tab === 'history'
                  ? TABS.map((item) =>
                      item.value === 'history' ? { ...item, count: runs.length } : item,
                    )
                  : TABS
              }
              value={tab}
              onChange={setTab}
              ariaLabel="自动化测试视图"
            />
          </div>

          {tab === 'run' ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <SelectDropdown
                  options={[
                    { value: '', label: '全部用例' },
                    ...selected.specFiles.map((path) => ({ value: path, label: path })),
                  ]}
                  value={file}
                  onChange={setFile}
                  compact
                  className="w-56"
                  ariaLabel="指定测试文件"
                />
                <input
                  className={`${FIELD} w-44`}
                  value={grep}
                  onChange={(event) => setGrep(event.target.value)}
                  placeholder="grep 用例名"
                  aria-label="grep"
                />
                <SelectDropdown
                  options={projectNameOptions}
                  value={projectName}
                  onChange={setProjectName}
                  compact
                  className="w-40"
                  ariaLabel="Playwright 项目"
                />
                <SelectDropdown
                  options={WORKERS}
                  value={workers}
                  onChange={setWorkers}
                  compact
                  className="w-28"
                  ariaLabel="并发数"
                />
                <label className="flex h-8 items-center gap-1.5 text-xs text-stone-600">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[#3370ff]"
                    checked={headed}
                    onChange={(event) => setHeaded(event.target.checked)}
                  />
                  headed
                </label>
                <label className="flex h-8 items-center gap-1.5 text-xs text-stone-600">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[#3370ff]"
                    checked={lastFailed}
                    onChange={(event) => setLastFailed(event.target.checked)}
                  />
                  仅上次失败
                </label>
                {activeRunning ? (
                  <button
                    type="button"
                    className={BTN_DANGER}
                    onClick={() => void onStop()}
                    disabled={stopping}
                  >
                    {stopping ? '停止中…' : '停止'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={BTN_PRIMARY}
                    onClick={() => void doRun()}
                    disabled={busy || !selected.exists}
                  >
                    <PmIcon name="play" size={14} />
                    {busy ? '启动中…' : '运行'}
                  </button>
                )}
              </div>

              {!selected.exists ? (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                  项目目录已不存在（换机器或被移动过）：点右上角「重选目录」，记录与历史报告不会丢。
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
                    <span className="text-stone-400">{describeRunArgs(activeRun.args)}</span>
                    <div className="ml-auto flex items-center gap-2">
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
                  <label className="ml-auto flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-[#3370ff]"
                      checked={autoScroll}
                      onChange={(event) => {
                        setAutoScroll(event.target.checked);
                        stickRef.current = event.target.checked;
                      }}
                    />
                    自动滚动
                  </label>
                </div>
                <pre
                  ref={logRef}
                  onScroll={onLogScroll}
                  className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-white p-3 font-mono text-[12px] leading-relaxed text-stone-700"
                >
                  {log || '运行后这里会显示 Playwright 的实时输出…'}
                </pre>
              </div>
            </div>
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
                          {describeRunArgs(run.args)}
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

          {tab === 'files' ? (
            <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] overflow-hidden">
              <div className="min-h-0 overflow-auto border-r border-stone-100">
                <AutoFileTree
                  projectId={selected.id}
                  selectedPath={filePath}
                  onOpenFile={(path) => void openFile(path)}
                />
              </div>
              <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stone-100 px-3">
                  <span className="truncate font-mono text-xs text-stone-600">
                    {preview?.path || filePath || '未选择文件'}
                  </span>
                  {preview ? (
                    <span className="ml-auto shrink-0 text-[11px] text-stone-400">
                      {preview.size} B{preview.truncated ? ' · 仅预览前 256KB' : ''}
                    </span>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {previewLoading ? (
                    <p className="p-3 text-xs text-stone-400">加载中…</p>
                  ) : !preview ? (
                    <p className="p-3 text-xs text-stone-400">从左侧选择文件查看内容</p>
                  ) : preview.binary ? (
                    <p className="p-3 text-xs text-stone-400">二进制文件，不支持预览</p>
                  ) : (
                    <pre className="whitespace-pre p-3 font-mono text-[12px] leading-relaxed text-stone-700">
                      {preview.content}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="移出项目"
        message={`确定把「${removeTarget?.name ?? ''}」移出挂载列表吗？\n只删除挂载记录，项目文件与历史报告都保留。`}
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
