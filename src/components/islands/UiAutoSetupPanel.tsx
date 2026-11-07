/**
 * 一键安装依赖：依赖 + Playwright 浏览器内核，两步串行。
 *
 * 新建项目的完成页与项目卡片菜单共用这个面板：
 * - 运行中 1s 增量拉日志（与「自动化执行」的运行日志同一套 offset 协议）；
 * - 结束后服务端返回日志文件尾部（reset），关掉弹窗再进来还能看到上次输出；
 * - 停止 / 重装都走服务端进程表，关闭弹窗不会打断安装。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchProjectSetup,
  startProjectSetup,
  stopProjectSetup,
  type ProjectSetup,
  type SetupPlanStep,
  type SetupStepStatus,
} from '../../lib/ui-auto';
import { PmIcon } from './PmShared';
import { showToast } from './Toast';

const POLL_MS = 1000;

const TEXT_PRIMARY = 'text-[var(--tw-label-primary)]';
const TEXT_SECONDARY = 'text-[var(--tw-label-secondary)]';
const TEXT_TERTIARY = 'text-[var(--tw-label-tertiary)]';
const PRIMARY_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-(--tw-accent) px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) px-3 text-sm text-(--tw-label-secondary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary) disabled:cursor-not-allowed disabled:opacity-50';

const STEP_DOT: Record<SetupStepStatus, string> = {
  pending: 'bg-(--tw-label-tertiary)',
  running: 'bg-(--tw-accent) animate-pulse',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  skipped: 'bg-(--tw-label-tertiary)',
};

const STEP_TEXT: Record<SetupStepStatus, string> = {
  pending: '待安装',
  running: '安装中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

const STATUS_TEXT: Record<ProjectSetup['status'], string> = {
  idle: '还没安装',
  running: '正在安装',
  done: '环境已就绪',
  failed: '安装未完成',
  stopped: '已停止',
  interrupted: '被中断',
};

/** 整条安装的状态 → 小圆点样式（沿用步骤那套颜色） */
const STATUS_DOT: Record<ProjectSetup['status'], string> = {
  idle: STEP_DOT.pending,
  running: STEP_DOT.running,
  done: STEP_DOT.done,
  failed: STEP_DOT.failed,
  stopped: STEP_DOT.pending,
  interrupted: STEP_DOT.failed,
};

interface Props {
  projectId: string;
  /** 没跑过时用它展示步骤清单（来自项目记录的 setupPlan） */
  plan?: SetupPlanStep[];
  /** 包管理器说明（如「本机没有 pnpm，已改用 npm」），空串不显示 */
  note?: string;
  /** 状态变化（开始 / 结束）时通知外层刷新项目列表 */
  onStatusChange?: (setup: ProjectSetup) => void;
  /** 完成后是否显示「去项目目录看看」之类的附加提示由调用方决定 */
  showTitle?: boolean;
  /**
   * 撑满父容器高度：日志区吃掉剩余空间而不是固定 max-h。
   * 用于整页 / 整个弹窗只放这一块面板的场景（项目配置 → 运行环境）。
   */
  fill?: boolean;
}

export default function UiAutoSetupPanel({
  projectId,
  plan = [],
  note = '',
  onStatusChange,
  showTitle = true,
  fill = false,
}: Props) {
  const [setup, setSetup] = useState<ProjectSetup | null>(null);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const offsetRef = useRef(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const aliveRef = useRef(true);
  const startedAtRef = useRef(0);

  // 回调放进 ref：父组件常传内联箭头函数，直接进 useCallback 依赖会让 reload 每渲染都变，
  // 触发「拉日志 → 通知刷新父列表 → 重渲染 → 再拉」的死循环
  const onChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onChangeRef.current = onStatusChange;
  }, [onStatusChange]);
  const notify = useCallback((next: ProjectSetup) => {
    onChangeRef.current?.(next);
  }, []);

  /** 首次进入 / 切换项目：把已有日志整段读回来 */
  const reload = useCallback(async () => {
    try {
      const res = await fetchProjectSetup(projectId, 0);
      if (!aliveRef.current) return;
      setSetup(res.setup);
      setLog(res.log);
      offsetRef.current = res.nextOffset;
      setStopping(res.stopping);
      setError('');
      startedAtRef.current = res.setup.startedAt ? Date.parse(res.setup.startedAt) : 0;
      notify(res.setup);
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, notify]);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    return () => {
      aliveRef.current = false;
    };
  }, [reload]);

  const running = setup?.status === 'running';

  // 运行中增量拉日志
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetchProjectSetup(projectId, offsetRef.current);
        if (!alive) return;
        if (res.reset) setLog(res.log);
        else if (res.log) setLog((prev) => prev + res.log);
        offsetRef.current = res.nextOffset;
        setStopping(res.stopping);
        setSetup(res.setup);
        if (res.setup.status !== 'running') notify(res.setup);
      } catch {
        // 网络抖动：下一轮再试
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [running, projectId, notify]);

  // 日志自动贴底
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [log]);

  // 已用时
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      const from = startedAtRef.current || (setup?.startedAt ? Date.parse(setup.startedAt) : 0);
      setElapsed(from ? Date.now() - from : 0);
    }, 500);
    return () => window.clearInterval(timer);
  }, [running, setup?.startedAt]);

  const onStart = async () => {
    setBusy(true);
    setError('');
    setLog('');
    offsetRef.current = 0;
    try {
      const res = await startProjectSetup(projectId);
      startedAtRef.current = res.setup.startedAt ? Date.parse(res.setup.startedAt) : Date.now();
      setSetup(res.setup);
      notify(res.setup);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    try {
      await stopProjectSetup(projectId);
      setStopping(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const steps = setup?.steps?.length
    ? setup.steps
    : plan.map((step) => ({
        id: step.id,
        label: step.label,
        command: step.command,
        status: 'pending' as SetupStepStatus,
        startedAt: '',
        finishedAt: '',
        exitCode: null,
      }));
  const status = setup?.status ?? 'idle';
  const failed = status === 'failed' || status === 'interrupted';

  return (
    <div className={fill ? 'flex h-full min-h-0 flex-col gap-2.5' : 'space-y-2.5'}>
      <div className="flex items-center gap-2">
        {showTitle ? <span className={`text-xs font-medium ${TEXT_PRIMARY}`}>运行环境</span> : null}
        <span
          className={`inline-flex items-center gap-1 text-[11px] ${
            status === 'done'
              ? 'text-emerald-600'
              : failed
                ? 'text-red-600'
                : status === 'running'
                  ? 'text-(--tw-accent)'
                  : TEXT_TERTIARY
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
          {STATUS_TEXT[status]}
        </span>
        {running ? (
          <span className={`text-[11px] tabular-nums ${TEXT_TERTIARY}`}>
            {(elapsed / 1000).toFixed(0)}s
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <button
              type="button"
              className={GHOST_BTN}
              onClick={() => void onStop()}
              disabled={busy || stopping}
            >
              {stopping ? '正在停止…' : '停止安装'}
            </button>
          ) : (
            <button
              type="button"
              className={PRIMARY_BTN}
              onClick={() => void onStart()}
              disabled={busy}
            >
              <PmIcon name="play" size={13} />
              {status === 'idle' ? '一键安装依赖' : failed ? '重试安装' : '重新安装'}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1">
        {steps.map((step) => (
          <div
            key={step.id}
            className="flex items-center gap-2 rounded-lg border border-[var(--tw-border)] px-2.5 py-1.5"
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${STEP_DOT[step.status]}`} />
            <span className={`shrink-0 text-[11px] ${TEXT_TERTIARY}`}>{step.label}</span>
            <code className={`min-w-0 flex-1 truncate text-xs ${TEXT_PRIMARY}`}>
              {step.command}
            </code>
            <span
              className={`shrink-0 text-[11px] ${
                step.status === 'failed'
                  ? 'text-red-600'
                  : step.status === 'done'
                    ? 'text-emerald-600'
                    : TEXT_TERTIARY
              }`}
            >
              {STEP_TEXT[step.status]}
            </span>
            <button
              type="button"
              className="shrink-0 text-[var(--tw-label-tertiary)] transition-colors hover:text-[var(--tw-label-primary)]"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(step.command)
                  .then(() => showToast('已复制命令', 'success'))
                  .catch(() => undefined);
              }}
              aria-label={`复制 ${step.command}`}
            >
              <PmIcon name="copy" size={13} />
            </button>
          </div>
        ))}
      </div>

      {note && status === 'idle' ? <p className={`text-[11px] ${TEXT_TERTIARY}`}>{note}</p> : null}

      <div
        className={`overflow-hidden rounded-xl border border-[var(--tw-border)] ${
          fill ? 'flex min-h-0 flex-1 flex-col' : ''
        }`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--tw-border)] px-2.5 py-1.5">
          <span className={`text-[11px] font-medium ${TEXT_SECONDARY}`}>安装日志</span>
          {running ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-(--tw-accent)">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-(--tw-accent)" />
              运行中
            </span>
          ) : null}
          {setup?.finishedAt ? (
            <span className={`ml-auto text-[11px] ${TEXT_TERTIARY}`}>
              {new Date(setup.finishedAt).toLocaleString('zh-CN', { hour12: false })}
            </span>
          ) : null}
        </div>
        <div
          ref={boxRef}
          className={`overflow-auto px-2.5 py-2 font-mono text-[11px] leading-5 ${
            fill ? 'min-h-24 flex-1' : 'max-h-56 min-h-24'
          }`}
        >
          {log ? (
            <pre className={`whitespace-pre-wrap break-words ${TEXT_SECONDARY}`}>{log}</pre>
          ) : (
            <p className={`font-sans ${TEXT_TERTIARY}`}>
              {running ? '等待输出…' : '还没有安装记录，点「一键安装依赖」开始'}
            </p>
          )}
        </div>
      </div>

      {status === 'done' ? (
        <p className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          依赖与浏览器内核已装好，可以直接运行用例了。
        </p>
      ) : null}
      {setup?.error && failed ? (
        <p className="shrink-0 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">
          {setup.error}
        </p>
      ) : null}
      {error ? (
        <p className="shrink-0 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
