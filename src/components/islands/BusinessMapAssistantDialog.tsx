import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
} from '@headlessui/react';

import type { BusinessSystem } from '../../lib/business-map';
import {
  applyBusinessAssistant,
  loadBusinessAssistant,
  resetBusinessAssistant,
  sendBusinessAssistantMessage,
  stopBusinessAssistant,
  watchBusinessAssistant,
  type AssistantEvent,
  type AssistantPhase,
  type AssistantSession,
  type DirectoryProposal,
  type FlowProposal,
} from '../../lib/business-map-assistant';
import { loadSettings } from '../../lib/settings';
import ConfirmDialog from './ConfirmDialog';
import { PmIcon } from './PmShared';
import { showToast } from './Toast';

interface Props {
  system: BusinessSystem;
  revision: number;
  closing?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onApplied: () => void;
}

const STATUS_LABEL: Record<AssistantSession['status'], string> = {
  idle: '等待指令',
  running: 'AI 正在整理',
  awaiting_confirmation: '等待应用草案',
  stopped: '已停止',
  error: '识别失败',
  interrupted: '已中断',
};

function eventTone(event: AssistantEvent): string {
  if (event.type === 'error') return 'is-error';
  if (event.type === 'warning') return 'is-warning';
  if (event.type === 'proposal') return 'is-success';
  if (event.type === 'progress') return 'is-progress';
  return '';
}

function DirectoryPreview({ proposal }: { proposal: DirectoryProposal }) {
  const byParent = new Map<string, DirectoryProposal['directories']>();
  for (const directory of proposal.directories) {
    const list = byParent.get(directory.parentKey) || [];
    list.push(directory);
    byParent.set(directory.parentKey, list);
  }
  const functions = new Map<string, DirectoryProposal['functions']>();
  for (const fn of proposal.functions) {
    const list = functions.get(fn.directoryKey) || [];
    list.push(fn);
    functions.set(fn.directoryKey, list);
  }
  function branch(parentKey: string, depth: number): ReactNode {
    const directories = byParent.get(parentKey) || [];
    return directories.map((directory) => (
      <div className="tw-bm-ai-proposal-branch" key={directory.key}>
        <div className="tw-bm-ai-proposal-directory" style={{ paddingLeft: `${depth * 14}px` }}>
          <PmIcon name="folder" size={13} />
          <strong>{directory.name}</strong>
          <small>{directory.menuPath.join(' / ')}</small>
        </div>
        {branch(directory.key, depth + 1)}
        {(functions.get(directory.key) || []).map((fn) => (
          <div
            className="tw-bm-ai-proposal-function"
            style={{ paddingLeft: `${(depth + 1) * 14}px` }}
            key={`${directory.key}-${fn.name}`}
          >
            <span />
            <div>
              <strong>{fn.name}</strong>
              <small>{fn.purpose || '待补充作用'}</small>
            </div>
          </div>
        ))}
      </div>
    ));
  }
  return (
    <div className="tw-bm-ai-proposal-tree">
      {branch('', 0)}
      {(functions.get('') || []).map((fn) => (
        <div className="tw-bm-ai-proposal-function" key={`root-${fn.name}`}>
          <span />
          <div>
            <strong>{fn.name}</strong>
            <small>{fn.purpose || '待补充作用'}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function FlowPreview({ proposal }: { proposal: FlowProposal }) {
  return (
    <div className="tw-bm-ai-flow-proposals">
      {proposal.flows.map((flow) => (
        <article key={flow.name}>
          <header>
            <strong>{flow.name}</strong>
            <span>{flow.steps.length} 步</span>
          </header>
          <p>{flow.result || '最终结果待补充'}</p>
          <ol>
            {flow.steps.map((step) => (
              <li key={`${flow.name}-${step.n}`}>
                <i>{step.n}</i>
                <div>
                  <strong>{step.title}</strong>
                  <small>
                    {[step.role, step.system, step.manual ? '人工环节' : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                  {step.input || step.output ? (
                    <span>
                      {step.input || '输入'} → {step.output || '输出'}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </div>
  );
}

export default function BusinessMapAssistantDialog({
  system,
  revision,
  closing,
  onClose,
  onChanged,
  onApplied,
}: Props) {
  const [session, setSession] = useState<AssistantSession | null>(null);
  const [phase, setPhase] = useState<AssistantPhase>('directory');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [modelName, setModelName] = useState(() => loadSettings()?.model || '未配置模型');
  const [logsOpen, setLogsOpen] = useState(() => window.innerWidth >= 1280);
  const [resetOpen, setResetOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState(() => Date.now());
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const watcherRef = useRef<(() => void) | null>(null);
  const sessionSeqRef = useRef(0);

  const canFlow = Boolean(session?.directoryApplied || system.functions.length);
  const running = session?.status === 'running';
  const proposal = session?.proposal || null;
  const progress = session?.progress;
  const elapsedSeconds =
    progress?.startedAt && running
      ? Math.max(
          Number(progress.elapsedSeconds) || 0,
          Math.max(0, Math.floor((clock - Date.parse(progress.startedAt)) / 1000)),
        )
      : Math.max(0, Number(progress?.elapsedSeconds) || 0);
  const indeterminate = Boolean(running && (progress?.indeterminate || !progress?.total));
  const events = useMemo(
    () => [...(session?.events || [])].sort((left, right) => left.seq - right.seq),
    [session?.events],
  );

  useEffect(() => {
    sessionSeqRef.current = session?.seq || 0;
  }, [session?.seq]);

  useEffect(() => {
    setModelName(loadSettings()?.model || '未配置模型');
  }, []);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(180, Math.max(52, element.scrollHeight))}px`;
  }, [input]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [addMenuOpen]);

  useEffect(() => {
    if (!running) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const refreshSession = useCallback(async () => {
    const next = await loadBusinessAssistant(system.id);
    setSession(next);
    return next;
  }, [system.id]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void loadBusinessAssistant(system.id)
      .then((next) => {
        if (!alive) return;
        setSession(next);
        setPhase(next.phase || 'directory');
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [system.id]);

  useEffect(() => {
    watcherRef.current?.();
    watcherRef.current = null;
    if (session?.status !== 'running') return;
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    watcherRef.current = watchBusinessAssistant(system.id, sessionSeqRef.current, {
      signal: controller.signal,
      onEvent: (event) => {
        setSession((current) => {
          if (!current) return current;
          const seen = new Set(current.events.map((item) => item.seq));
          return {
            ...current,
            seq: Math.max(current.seq, event.seq),
            progress: event.progress || current.progress,
            events: seen.has(event.seq) ? current.events : [...current.events, event].slice(-500),
          };
        });
        if (['proposal', 'error'].includes(event.type) || event.status === 'stopped') {
          if (refreshTimer) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            void refreshSession().catch(() => undefined);
          }, 120);
        }
        if (
          event.type === 'status' &&
          ['completed', 'stopped', 'error', 'interrupted'].includes(event.status || '')
        )
          controller.abort();
      },
      onDisconnect: () => undefined,
    });
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      controller.abort();
      watcherRef.current?.();
      watcherRef.current = null;
    };
  }, [refreshSession, session?.runId, session?.status, system.id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [session?.messages.length, proposal]);

  async function send(message = input) {
    const content = message.trim();
    if (!content || busy || running) return;
    const settings = loadSettings();
    if (!settings) {
      setError('请先在模型设置中配置可用模型');
      return;
    }
    setModelName(settings.model);
    setBusy(true);
    setError('');
    try {
      const next = await sendBusinessAssistantMessage(system.id, {
        revision,
        phase,
        message: content,
        settings,
      });
      setSession(next);
      setInput('');
      setAddMenuOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      setSession(await stopBusinessAssistant(system.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function applyProposal() {
    if (!proposal) return;
    setBusy(true);
    setError('');
    try {
      const result = await applyBusinessAssistant(system.id, revision);
      setSession(result.session);
      setPhase(result.session.phase);
      onApplied();
      showToast(
        proposal.kind === 'directory' ? '功能目录已应用到地图' : '业务流程已应用到地图',
        'success',
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      const next = await resetBusinessAssistant(system.id);
      setSession(next);
      setPhase('directory');
      setResetOpen(false);
      showToast('AI 会话已重置', 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open onClose={onClose} className="tw-bm-theme relative z-110">
        <DialogBackdrop className={`tw-bm-overlay ${closing ? 'is-closing' : ''}`} />
        <DialogPanel
          className={`tw-bm-assistant-dialog ${closing ? 'is-closing' : ''} ${logsOpen ? 'with-logs' : ''}`}
        >
          <header className="tw-bm-assistant-head">
            <div>
              <span className="tw-bm-badge accent">AI 助手</span>
              <DialogTitle as="h2">{system.name}</DialogTitle>
              <DialogDescription>
                先识别并确认功能目录，再基于已确认功能梳理业务流程。
              </DialogDescription>
            </div>
            <div className="tw-bm-assistant-head-actions">
              <button
                type="button"
                className={logsOpen ? 'active' : ''}
                onClick={() => setLogsOpen((value) => !value)}
              >
                任务栏
              </button>
              <button type="button" onClick={() => setResetOpen(true)}>
                重置会话
              </button>
              <button type="button" className="tw-bm-icon-btn" aria-label="关闭" onClick={onClose}>
                ×
              </button>
            </div>
          </header>

          <div className="tw-bm-assistant-phases">
            <button
              type="button"
              className={phase === 'directory' ? 'active' : ''}
              onClick={() => setPhase('directory')}
            >
              <span>1</span>
              <strong>功能目录</strong>
              <small>{session?.directoryApplied ? '已应用' : '识别目录与功能'}</small>
            </button>
            <i />
            <button
              type="button"
              className={phase === 'flow' ? 'active' : ''}
              disabled={!canFlow}
              onClick={() => setPhase('flow')}
            >
              <span>2</span>
              <strong>业务流程</strong>
              <small>{canFlow ? '基于功能树识别' : '先应用功能目录'}</small>
            </button>
            <span className="spacer" />
            <span className={`tw-bm-ai-status is-${session?.status || 'idle'}`}>
              {session ? STATUS_LABEL[session.status] : '加载中'}
            </span>
            {running ? (
              <button type="button" className="tw-bm-btn danger ghost" onClick={() => void stop()}>
                停止
              </button>
            ) : null}
          </div>

          <div className="tw-bm-assistant-body">
            <main className="tw-bm-assistant-chat">
              <div className="tw-bm-assistant-messages">
                {!session?.messages.length && !loading ? (
                  <div className="tw-bm-assistant-empty">
                    <span>AI</span>
                    <strong>从真实菜单开始整理业务地图</strong>
                    <p>可以直接输入要求，也可以使用下面的快捷指令。</p>
                    <div>
                      <button
                        type="button"
                        onClick={() => void send('识别系统全部菜单，整理为功能目录树和业务功能。')}
                      >
                        识别功能目录
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPhase('directory');
                          setInput(`按我提供的菜单清单识别功能目录，网页扫描只用于查找页面证据：
- 一级菜单
  - 二级菜单`);
                          requestAnimationFrame(() => textareaRef.current?.focus());
                        }}
                      >
                        按菜单清单识别
                      </button>
                      {canFlow ? (
                        <button
                          type="button"
                          onClick={() => {
                            setPhase('flow');
                            void send('基于当前已确认功能目录，识别全部业务流程。');
                          }}
                        >
                          识别业务流程
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {session?.messages.map((message) => (
                  <article className={`tw-bm-assistant-message ${message.role}`} key={message.id}>
                    <span>{message.role === 'assistant' ? 'AI' : '我'}</span>
                    <div>
                      <p>{message.content}</p>
                      {message.applied ? <small>已应用到正式地图</small> : null}
                    </div>
                  </article>
                ))}
                {running && !proposal ? (
                  <div className="tw-bm-assistant-thinking" role="status" aria-live="polite">
                    <span aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <div>
                      <strong>{progress?.label || '正在处理'}</strong>
                      <p>
                        {indeterminate
                          ? elapsedSeconds
                            ? `已等待 ${elapsedSeconds} 秒，模型连接仍然正常。可以继续等待或停止任务。`
                            : '正在等待模型响应，任务会在后台继续。'
                          : '正在校验返回结果，请稍候。'}
                      </p>
                    </div>
                  </div>
                ) : null}
                {proposal ? (
                  <section className="tw-bm-ai-proposal">
                    <header>
                      <div>
                        <span className="tw-bm-badge accent">
                          {proposal.kind === 'directory' ? '目录草案' : '流程草案'}
                        </span>
                        <strong>
                          {proposal.kind === 'directory'
                            ? `${proposal.directories.length} 个目录 · ${proposal.functions.length} 个功能`
                            : `${proposal.flows.length} 条业务流程`}
                        </strong>
                      </div>
                      <button
                        type="button"
                        className="tw-bm-btn primary"
                        disabled={busy}
                        onClick={() => void applyProposal()}
                      >
                        {proposal.kind === 'directory' ? '应用为功能目录' : '应用业务流程'}
                      </button>
                    </header>
                    {proposal.kind === 'directory' ? (
                      <DirectoryPreview proposal={proposal} />
                    ) : (
                      <FlowPreview proposal={proposal} />
                    )}
                    {proposal.warnings.length ? (
                      <details>
                        <summary>{proposal.warnings.length} 项识别说明</summary>
                        <ul>
                          {proposal.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </section>
                ) : null}
                <div ref={chatEndRef} />
              </div>

              {error ? <p className="tw-bm-field-error">{error}</p> : null}
              <div className="tw-bm-assistant-composer" ref={composerRef}>
                {addMenuOpen ? (
                  <div className="tw-bm-assistant-add-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setPhase('directory');
                        setInput('识别系统全部菜单，整理为功能目录树和业务功能。');
                        setAddMenuOpen(false);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      <PmIcon name="folder" size={14} />
                      <span>
                        <strong>识别功能目录</strong>
                        <small>按系统菜单整理目录和功能</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPhase('directory');
                        setInput(`按我提供的菜单清单识别功能目录，网页扫描只用于查找页面证据：
- 一级菜单
  - 二级菜单`);
                        setAddMenuOpen(false);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      <PmIcon name="paste" size={14} />
                      <span>
                        <strong>按菜单清单识别</strong>
                        <small>用你提供的层级清单锁定目录骨架</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={!canFlow}
                      onClick={() => {
                        setPhase('flow');
                        setInput('基于当前已确认功能目录，识别全部业务流程。');
                        setAddMenuOpen(false);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      <PmIcon name="chat" size={14} />
                      <span>
                        <strong>识别业务流程</strong>
                        <small>{canFlow ? '基于已应用功能生成流程' : '请先应用功能目录'}</small>
                      </span>
                    </button>
                  </div>
                ) : null}
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={input}
                  disabled={running || busy}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && addMenuOpen) {
                      event.preventDefault();
                      setAddMenuOpen(false);
                      return;
                    }
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  className="tw-chat-input"
                  placeholder={
                    phase === 'directory'
                      ? '例如：识别全部菜单；按我提供的菜单清单识别；把新建工单归到工单受理'
                      : '例如：识别全部业务流程；只分析工单受理和工单办理'
                  }
                />
                <div className="tw-composer-bar">
                  <button
                    type="button"
                    className={`tw-icon-btn tw-bm-composer-add ${addMenuOpen ? 'is-open' : ''}`}
                    aria-label="添加快捷指令"
                    onClick={() => setAddMenuOpen((value) => !value)}
                  >
                    <PmIcon name="plus" size={16} />
                  </button>
                  <span className="tw-bm-composer-chip" title={system.name}>
                    <PmIcon name="folder" size={13} />
                    <span>{system.name}</span>
                  </span>
                  <span className="tw-bm-composer-chip is-readonly" title="仅执行只读页面采集">
                    <i />
                    只读采集
                  </span>
                  <span className="spacer" />
                  <span className="tw-bm-composer-model" title={modelName}>
                    {modelName}
                  </span>
                  <button
                    type="button"
                    className={`tw-bm-composer-send ${running ? 'is-stop' : ''}`}
                    disabled={!running && (!input.trim() || busy)}
                    aria-label={running ? '停止识别' : '发送'}
                    onClick={() => {
                      if (running) void stop();
                      else void send();
                    }}
                  >
                    {running ? (
                      <span className="tw-bm-composer-stop" />
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m5 12 14-7-4 14-3-5Z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </main>

            {logsOpen ? (
              <aside className="tw-bm-assistant-logs">
                <header>
                  <strong>任务执行</strong>
                  <span>{STATUS_LABEL[session?.status || 'idle']}</span>
                </header>
                <div className="tw-bm-assistant-progress">
                  <div>
                    <span>{progress?.label || '等待开始'}</span>
                    <strong>
                      {indeterminate
                        ? elapsedSeconds
                          ? `${elapsedSeconds}s`
                          : '处理中'
                        : `${progress?.percent || 0}%`}
                    </strong>
                  </div>
                  <i className={indeterminate ? 'is-indeterminate' : ''}>
                    <span style={{ width: `${progress?.percent || 0}%` }} />
                  </i>
                  {indeterminate ? (
                    <small>
                      {elapsedSeconds
                        ? `已等待 ${elapsedSeconds} 秒，仍在等待模型返回`
                        : '正在等待模型返回，界面会持续更新'}
                    </small>
                  ) : progress?.total ? (
                    <small>
                      {progress.current} / {progress.total}
                    </small>
                  ) : null}
                </div>
                <div className="tw-bm-assistant-log-title">
                  <strong>执行日志</strong>
                  <span>{events.length} 条</span>
                </div>
                <div className="tw-bm-assistant-event-list">
                  {events.map((event) => (
                    <div className={`tw-bm-assistant-event ${eventTone(event)}`} key={event.seq}>
                      <span>{event.at ? new Date(event.at).toLocaleTimeString() : ''}</span>
                      <div>
                        <strong>{event.title}</strong>
                        {event.detail ? <small>{event.detail}</small> : null}
                      </div>
                    </div>
                  ))}
                  {!events.length ? <p>还没有执行记录。</p> : null}
                </div>
              </aside>
            ) : null}
          </div>
        </DialogPanel>
      </Dialog>
      {resetOpen ? (
        <ConfirmDialog
          open
          title="重置 AI 会话"
          message="将清空当前会话消息、草案和日志，不会修改已经应用的业务地图。"
          confirmLabel="重置会话"
          danger="solid"
          onClose={() => setResetOpen(false)}
          onConfirm={() => void reset()}
        />
      ) : null}
    </>
  );
}
