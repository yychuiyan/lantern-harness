/**
 * 脚本编排：列表 → 详情。
 * 详情：左步骤 + 中阶段（对话 → 代码）；试跑在代码页底部日志栏。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { streamChatWithTools, type ChatMessage } from '../../lib/llm';
import { loadSettings, openSettings } from '../../lib/settings';
import {
  BROWSER_CLOSED_MESSAGE,
  buildUiAgentSystemPrompt,
  buildUiAgentUserPrompt,
  closeBrowser,
  deleteGeneration,
  emitGeneration,
  fetchGenerationSession,
  fetchGenerationSessions,
  isBrowserClosedOutput,
  prepareGeneration,
  revealPath,
  revertGeneration,
  runUiAutoAgentTool,
  saveGeneration,
  UI_AUTO_AGENT_TOOLS,
  verifyGeneration,
  writeDraftFiles,
  writeGeneration,
  type UiDraftSummary,
  type UiEmitFile,
  type UiGenSession,
  type UiPlanStep,
  type UiTestIr,
  type UiTestTarget,
  type UiVerifyResult,
} from '../../lib/ui-auto-agent';
import {
  defaultOrchestrateTitle,
  displayOrchestrateTitle,
  ensureOrchestrateChatSession,
  filterGenSessionsByWorkbench,
  syncOrchestrateStatus,
  UIAUTO_ORCHESTRATE_ACTION_EVENT,
  UIAUTO_PLAN_UPDATED_EVENT,
} from '../../lib/ui-auto-orchestrate';
import { fetchUiAutoPrompt } from '../../lib/ui-auto-prompt';
import { runProjectAuthSetup, runProjectSsoLogin, type UiAutoProject } from '../../lib/ui-auto';
import {
  buildLoginOrchestratePlan,
  detectLoginWall,
  loginOrchestrateTitle,
  loginWallAutoSteps,
  resolveLoginWallHighlight,
  type LoginWallChoice,
  type LoginWallSuggestion,
} from '../../lib/ui-auto-login-wall';
import {
  flushSessionStore,
  hydrateSessionStore,
  loadSessionStore,
  updateSessionMeta,
} from '../../lib/sessions';
import { readViewText, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import LoginWallDialog from './LoginWallDialog';
import UiAutoOrchestrateCodePane from './UiAutoOrchestrateCodePane';
import UiAutoOrchestratePanel, { appendOrchestrateNotice } from './UiAutoOrchestratePanel';
import UiAutoOrchestrateRunLog from './UiAutoOrchestrateRunLog';
import UiAutoSteps from './UiAutoSteps';
import { showToast } from './Toast';

/** 编排探索默认不开过程截图，少一轮无关工具 */
const EXPLORE_TOOLS = UI_AUTO_AGENT_TOOLS.filter(
  (tool) => tool.function.name !== 'ui_browser_screenshot',
);

function mergeServerPlan(prev: UiPlanStep[], incoming: UiPlanStep[]): UiPlanStep[] {
  if (!incoming.length) return prev;
  const byId = new Map(incoming.map((step) => [step.id, step]));
  const merged = prev.map((step) => {
    const next = byId.get(step.id);
    if (!next) return step;
    return {
      ...step,
      status: next.status,
      locator: next.locator,
      warning: next.warning,
    };
  });
  for (const step of incoming) {
    if (!prev.some((item) => item.id === step.id)) merged.push(step);
  }
  return merged;
}

function requirementFromSession(session: UiGenSession, plan: UiPlanStep[], title: string): string {
  const source = String(session.source || '').trim();
  if (source) return source;
  if (plan.length) {
    return plan
      .map((step, index) => `${index + 1}. ${step.action} ${step.target || step.url || ''}`.trim())
      .join('\n');
  }
  return title.trim() || session.title || '未命名编排';
}

const DETAIL_PREF = 'ui-auto.orchestrate.detail';
const STEPS_WIDTH_PREF = 'ui-auto.orch.steps-left';
const STEPS_WIDTH_LEGACY = 'ui-auto.orchestrate.stepswidth';
const STAGE_PREF = 'ui-auto.orch.stage';
const LOG_PANEL_PREF = 'ui-auto.orch.log-panel';
const STEPS_MIN = 280;
const STEPS_MAX = 480;
const DEFAULT_STEPS = 320;
const LOG_PANEL_MIN = 140;
const DEFAULT_LOG_PANEL = 220;
const COLLAPSED_LOG_PANEL = 36;
const LOG_PANEL_COLLAPSE_AT = COLLAPSED_LOG_PANEL + 24;

type OrchStage = 'chat' | 'code';

const STAGES: ReadonlyArray<{ value: OrchStage; label: string }> = [
  { value: 'chat', label: '对话' },
  { value: 'code', label: '代码' },
];

function readStepsWidthPref(): number {
  const raw = Number(readViewText(STEPS_WIDTH_PREF) || readViewText(STEPS_WIDTH_LEGACY));
  if (!Number.isFinite(raw) || raw < STEPS_MIN) return DEFAULT_STEPS;
  return Math.min(raw, STEPS_MAX);
}

function readStagePref(): OrchStage {
  const raw = readViewText(STAGE_PREF);
  // 旧「试跑」阶段已并进代码页
  if (raw === 'code' || raw === 'verify') return 'code';
  return 'chat';
}

function readLogPanelHeight(): number {
  const raw = Number(readViewText(LOG_PANEL_PREF));
  if (!Number.isFinite(raw) || raw < COLLAPSED_LOG_PANEL || raw <= LOG_PANEL_COLLAPSE_AT) {
    return DEFAULT_LOG_PANEL;
  }
  return raw;
}

type OrchestrateStatus = 'draft' | 'planned' | 'bound' | 'written';

type ListItem = Partial<UiGenSession> & { id: string };

const STATUS_META: Record<OrchestrateStatus, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-stone-100 text-stone-500' },
  planned: { label: '已有步骤', className: 'bg-sky-50 text-sky-700' },
  bound: { label: '已绑定', className: 'bg-emerald-50 text-emerald-700' },
  written: { label: '已写入', className: 'bg-violet-50 text-violet-700' },
};

function statusOf(session: ListItem): OrchestrateStatus {
  if (session.savedPath || session.status === 'written') return 'written';
  const plan = Array.isArray(session.plan) ? session.plan : [];
  const irSteps = session.ir?.steps;
  const steps = Array.isArray(irSteps) && irSteps.length ? irSteps : plan;
  const count = stepCountOf(session);
  if (
    steps.some((step) => (step as UiPlanStep).locator || (step as UiPlanStep).status === 'bound')
  ) {
    return 'bound';
  }
  if (count > 0 || steps.length > 0 || (session.status && session.status !== 'draft')) {
    return 'planned';
  }
  return 'draft';
}

function stepCountOf(session: ListItem): number {
  // 列表接口只回 stepCount 摘要（不含 plan / ir 全文）
  if (typeof session.stepCount === 'number' && session.stepCount > 0) return session.stepCount;
  if (Array.isArray(session.ir?.steps) && session.ir.steps.length) return session.ir.steps.length;
  if (Array.isArray(session.plan)) return session.plan.length;
  return 0;
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizePlan(plan: UiPlanStep[] | undefined | null): UiPlanStep[] {
  if (!Array.isArray(plan)) return [];
  return plan.filter((step) => step && typeof step.id === 'string');
}

export default function UiAutoOrchestrateBoard({
  project,
  promptFile,
  onError,
}: {
  project: UiAutoProject;
  promptFile: string;
  onError?: (message: string) => void;
}) {
  const detailPrefKey = `${DETAIL_PREF}.${project.id}`;
  const [items, setItems] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [exploring, setExploring] = useState(false);
  /** 登录墙选「我已登录」后：等用户在浏览器登完，再点「我已登录，继续」 */
  const [awaitingManualLogin, setAwaitingManualLogin] = useState(false);
  /** 正在自动 SSO / auth.setup 拿登录态 */
  const [fetchingAuth, setFetchingAuth] = useState(false);
  const [loginWall, setLoginWall] = useState<{
    evidence: string;
    suggestion: LoginWallSuggestion;
  } | null>(null);
  const [wallBusy, setWallBusy] = useState(false);
  const [ssoConfigured, setSsoConfigured] = useState(() => Boolean(project.ssoConfigured));
  const [authSetupDetected, setAuthSetupDetected] = useState(() =>
    Boolean(project.authSetupDetected),
  );
  const [activeId, setActiveId] = useState(() => readViewText(detailPrefKey));
  const [session, setSession] = useState<UiGenSession | null>(null);
  const [chatSessionId, setChatSessionId] = useState('');
  const [plan, setPlan] = useState<UiPlanStep[]>([]);
  const [title, setTitle] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [stepsWidth, setStepsWidth] = useState(() => readStepsWidthPref());
  const [stage, setStage] = useState<OrchStage>(() => readStagePref());
  const [emitFiles, setEmitFiles] = useState<UiEmitFile[]>([]);
  /** 最近一次「出码」原文：脏点 = 与此对比，撤销回原文即消失 */
  const [emitBaseline, setEmitBaseline] = useState<Record<string, string>>({});
  const [emitSelectedPaths, setEmitSelectedPaths] = useState<string[]>([]);
  const [emitForceOverwrite, setEmitForceOverwrite] = useState(false);
  const [emitWriting, setEmitWriting] = useState(false);
  const [emitReverting, setEmitReverting] = useState(false);
  const [emitRunning, setEmitRunning] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verify, setVerify] = useState<UiVerifyResult | null>(null);
  const [draft, setDraft] = useState<UiDraftSummary | null>(null);
  const [suggestedPath, setSuggestedPath] = useState('');
  const [logPanelHeight, setLogPanelHeight] = useState(() => readLogPanelHeight());
  const [logPanelCollapsed, setLogPanelCollapsed] = useState(
    () => readViewText(LOG_PANEL_PREF) === 'closed',
  );
  const [logPanelDragging, setLogPanelDragging] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const logDragRef = useRef<{
    startY: number;
    startHeight: number;
    restoreHeight: number;
  } | null>(null);
  const planSaveRef = useRef<number | null>(null);
  const titleSaveRef = useRef<number | null>(null);
  const openingRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const planRef = useRef(plan);
  planRef.current = plan;
  /** 用 ref 防「探索已结束但 state 未刷完」时再次点确认被 exploring 挡掉 */
  const exploringRef = useRef(false);
  /** SSO 注入后立刻用于下次探索，不等父组件刷新 project */
  const storageOverrideRef = useRef<string | null>(null);
  /** 探索 finally 后再跑自动拿 token，避免与 exploring 状态打架 */
  const loginWallPendingRef = useRef<string | null>(null);
  const onConfirmExploreRef = useRef<() => void>(() => undefined);
  /** 本轮已自动拿过登录态：再撞墙只弹窗，避免 SSO↔探索死循环 */
  const autoAuthConsumedRef = useRef(false);

  useEffect(() => {
    setSsoConfigured(Boolean(project.ssoConfigured));
  }, [project.ssoConfigured]);

  useEffect(() => {
    setAuthSetupDetected(Boolean(project.authSetupDetected));
  }, [project.authSetupDetected]);

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      await hydrateSessionStore().catch(() => null);
      const list = await fetchGenerationSessions(project.id);
      const chats = loadSessionStore().sessions;
      const visible = filterGenSessionsByWorkbench(
        list.sessions.filter((item) => item.mode !== 'business'),
        chats,
      );
      visible.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      setItems(visible);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message);
      showToast(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [onError, project.id]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const goStage = useCallback((next: OrchStage) => {
    setStage(next);
    writeViewText(STAGE_PREF, next);
  }, []);

  const expandLogPanel = useCallback(() => {
    setLogPanelCollapsed(false);
    writeViewText(LOG_PANEL_PREF, String(Math.max(LOG_PANEL_MIN, logPanelHeight)));
  }, [logPanelHeight]);

  const toggleLogPanel = useCallback(() => {
    setLogPanelCollapsed((prev) => {
      const next = !prev;
      writeViewText(
        LOG_PANEL_PREF,
        next ? 'closed' : String(Math.max(LOG_PANEL_MIN, logPanelHeight)),
      );
      return next;
    });
  }, [logPanelHeight]);

  const onLogPanelDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const restoreHeight = Math.max(LOG_PANEL_MIN, logPanelHeight);
      logDragRef.current = {
        startY: event.clientY,
        startHeight: logPanelCollapsed ? COLLAPSED_LOG_PANEL : logPanelHeight,
        restoreHeight,
      };
      if (logPanelCollapsed) {
        setLogPanelCollapsed(false);
        setLogPanelHeight(COLLAPSED_LOG_PANEL);
      }
      setLogPanelDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [logPanelCollapsed, logPanelHeight],
  );

  const onLogPanelDragMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = logDragRef.current;
    if (!drag) return;
    const max = Math.max(LOG_PANEL_MIN, Math.round(window.innerHeight * 0.65));
    setLogPanelHeight(
      Math.min(
        max,
        Math.max(COLLAPSED_LOG_PANEL, drag.startHeight + (drag.startY - event.clientY)),
      ),
    );
  }, []);

  const onLogPanelDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = logDragRef.current;
    if (!drag) return;
    logDragRef.current = null;
    setLogPanelDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    const max = Math.max(LOG_PANEL_MIN, Math.round(window.innerHeight * 0.65));
    const settled = Math.min(
      max,
      Math.max(COLLAPSED_LOG_PANEL, drag.startHeight + (drag.startY - event.clientY)),
    );
    if (settled <= LOG_PANEL_COLLAPSE_AT) {
      setLogPanelHeight(drag.restoreHeight);
      setLogPanelCollapsed(true);
      writeViewText(LOG_PANEL_PREF, 'closed');
      return;
    }
    setLogPanelHeight(settled);
    setLogPanelCollapsed(false);
    writeViewText(LOG_PANEL_PREF, String(settled));
  }, []);

  const onLogPanelDragCancel = useCallback(() => {
    const drag = logDragRef.current;
    logDragRef.current = null;
    setLogPanelDragging(false);
    if (drag && logPanelHeight <= LOG_PANEL_COLLAPSE_AT) {
      setLogPanelHeight(drag.restoreHeight);
      setLogPanelCollapsed(true);
      writeViewText(LOG_PANEL_PREF, 'closed');
    }
  }, [logPanelHeight]);

  const openDetail = useCallback(
    async (id: string) => {
      if (!id || openingRef.current === id) return;
      openingRef.current = id;
      setActiveId(id);
      writeViewText(detailPrefKey, id);
      setDetailLoading(true);
      setAwaitingManualLogin(false);
      setFetchingAuth(false);
      setLoginWall(null);
      autoAuthConsumedRef.current = false;
      setEmitFiles([]);
      setEmitBaseline({});
      setEmitSelectedPaths([]);
      setEmitForceOverwrite(false);
      setEmitWriting(false);
      setEmitReverting(false);
      setVerify(null);
      setDraft(null);
      setSuggestedPath('');
      setEmitRunning(false);
      setVerifying(false);
      goStage('chat');
      try {
        const detail = await fetchGenerationSession(id);
        setSession(detail.session);
        setTitle(detail.session.title || '未命名编排');
        setPlan(normalizePlan(detail.session.plan));
        setSuggestedPath(detail.suggestedPath || '');
        setDraft(detail.draft ?? null);
        if (detail.session.lastVerify) {
          setVerify({
            passed: detail.session.lastVerify.passed,
            exitCode: detail.session.lastVerify.exitCode,
            durationMs: detail.session.lastVerify.durationMs,
            log: detail.session.lastVerify.log,
          });
        }
        const linked = await ensureOrchestrateChatSession({
          projectId: project.id,
          projectName: project.name,
          projectDir: project.dir,
          uiautoSessionId: detail.session.id,
          requirement: detail.session.source || detail.session.title || '',
          status: detail.session.status || 'draft',
          forceNew: false,
        });
        setChatSessionId(linked.chatSessionId);
        if (
          !detail.session.chatSessionId ||
          detail.session.chatSessionId !== linked.chatSessionId
        ) {
          await saveGeneration({
            sessionId: detail.session.id,
            chatSessionId: linked.chatSessionId,
          }).catch(() => undefined);
        }
        // 已探索过：静默补出码，方便直接进代码 / 试跑
        if (detail.session.ir?.steps?.length) {
          try {
            const testDir = detail.suggestedPath.includes('/')
              ? detail.suggestedPath.replace(/\/[^/]+$/, '')
              : 'tests';
            const emitted = await emitGeneration(detail.session.ir, detail.session.target || 'ts', {
              testDir,
              projectId: project.id,
              sessionId: detail.session.id,
            });
            const baseline: Record<string, string> = {};
            for (const file of emitted.files) baseline[file.path] = file.content;
            setEmitBaseline(baseline);
            const savedEdits = Array.isArray(detail.session.editedFiles)
              ? detail.session.editedFiles
              : [];
            if (savedEdits.length) {
              const byPath = new Map(savedEdits.map((file) => [file.path, file]));
              setEmitFiles(
                emitted.files.map((file) => {
                  const edit = byPath.get(file.path);
                  return edit
                    ? {
                        ...file,
                        content: typeof edit.content === 'string' ? edit.content : file.content,
                        role: edit.role || file.role,
                      }
                    : file;
                }),
              );
            } else {
              setEmitFiles(emitted.files);
            }
            setEmitSelectedPaths(emitted.files.map((file) => file.path));
          } catch {
            // 打开详情时出码失败不挡浏览
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onError?.(message);
        showToast(message, 'error');
        setActiveId('');
        writeViewText(detailPrefKey, '');
        setSession(null);
        setChatSessionId('');
      } finally {
        setDetailLoading(false);
        openingRef.current = '';
      }
    },
    [detailPrefKey, goStage, onError, project.dir, project.id, project.name],
  );

  // 刷新后立刻进详情，不等列表；会话不存在时 openDetail 会清掉 activeId
  useEffect(() => {
    if (!activeId || session?.id === activeId || detailLoading) return;
    if (openingRef.current === activeId) return;
    void openDetail(activeId);
  }, [activeId, detailLoading, openDetail, session?.id]);

  // 列表回来后：记忆的 id 已不在可见列表里则退回列表
  useEffect(() => {
    if (!activeId || loading || detailLoading) return;
    if (session?.id === activeId) return;
    if (items.some((item) => item.id === activeId)) return;
    setActiveId('');
    writeViewText(detailPrefKey, '');
  }, [activeId, detailLoading, detailPrefKey, items, loading, session?.id]);

  const backToList = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (session?.id) void closeBrowser(session.id).catch(() => undefined);
    exploringRef.current = false;
    setExploring(false);
    setAwaitingManualLogin(false);
    setEmitFiles([]);
    setEmitBaseline({});
    setEmitSelectedPaths([]);
    setEmitForceOverwrite(false);
    setEmitWriting(false);
    setEmitReverting(false);
    setVerify(null);
    setDraft(null);
    setSuggestedPath('');
    setEmitRunning(false);
    setVerifying(false);
    goStage('chat');
    setFetchingAuth(false);
    setLoginWall(null);
    loginWallPendingRef.current = null;
    autoAuthConsumedRef.current = false;
    setActiveId('');
    setSession(null);
    setChatSessionId('');
    setPlan([]);
    setTitle('');
    writeViewText(detailPrefKey, '');
    void refreshList();
  }, [detailPrefKey, goStage, refreshList, session?.id]);

  const onCreate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const name = defaultOrchestrateTitle();
      const target: UiTestTarget = project.framework === 'pytest' ? 'python' : 'ts';
      const created = await prepareGeneration({
        projectId: project.id,
        title: name,
        target,
        baseURL: project.baseURL || project.detectedBaseURL || '',
        storageState: project.storageState || project.detectedStorageState || '',
        source: '',
        headed: true,
        reset: true,
      });
      const linked = await ensureOrchestrateChatSession({
        projectId: project.id,
        projectName: project.name,
        projectDir: project.dir,
        uiautoSessionId: created.session.id,
        requirement: name,
        status: 'draft',
        forceNew: true,
      });
      // 生成会话与工作台会话共用同一标题
      await saveGeneration({
        sessionId: created.session.id,
        chatSessionId: linked.chatSessionId,
        title: name,
      }).catch(() => undefined);
      await hydrateSessionStore().catch(() => null);
      let store = loadSessionStore();
      store = updateSessionMeta(store, linked.chatSessionId, { title: name });
      await flushSessionStore(store);
      await refreshList();
      await openDetail(created.session.id);
      showToast('已新建编排，在会话里描述自动化需求即可', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message);
      showToast(message, 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, onError, openDetail, project, refreshList]);

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await deleteGeneration(target.id);
      if (activeId === target.id) backToList();
      else await refreshList();
      showToast('已删除', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, 'error');
    }
  }, [activeId, backToList, deleteTarget, refreshList]);

  const persistPlan = useCallback(
    (next: UiPlanStep[]) => {
      setPlan(next);
      if (!session?.id) return;
      if (planSaveRef.current) window.clearTimeout(planSaveRef.current);
      planSaveRef.current = window.setTimeout(() => {
        void saveGeneration({
          sessionId: session.id,
          plan: next,
          allowEmptyPlan: true,
        }).catch(() => undefined);
      }, 400);
    },
    [session?.id],
  );

  /** 会话里 ui_plan_steps 写入后，刷新右侧步骤栏 */
  useEffect(() => {
    if (!session?.id) return;
    const onPlanUpdated = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          uiautoSessionId?: string;
          plan?: UiPlanStep[];
          title?: string;
        }>
      ).detail;
      if (!detail?.uiautoSessionId || detail.uiautoSessionId !== session.id) return;
      if (Array.isArray(detail.plan)) setPlan(normalizePlan(detail.plan));
      const nextTitle = String(detail.title || '').trim();
      if (nextTitle) setTitle(nextTitle);
    };
    window.addEventListener(UIAUTO_PLAN_UPDATED_EVENT, onPlanUpdated);
    return () => window.removeEventListener(UIAUTO_PLAN_UPDATED_EVENT, onPlanUpdated);
  }, [session?.id]);

  const persistTitle = useCallback(
    (next: string) => {
      setTitle(next);
      if (!session?.id) return;
      if (titleSaveRef.current) window.clearTimeout(titleSaveRef.current);
      titleSaveRef.current = window.setTimeout(() => {
        const cleaned = next.trim() || '未命名编排';
        void (async () => {
          await saveGeneration({ sessionId: session.id, title: cleaned }).catch(() => undefined);
          if (!chatSessionId) return;
          await hydrateSessionStore().catch(() => null);
          let store = loadSessionStore();
          store = updateSessionMeta(store, chatSessionId, { title: cleaned });
          await flushSessionStore(store);
          try {
            window.dispatchEvent(
              new CustomEvent('lantern:chat-session-updated', {
                detail: { sessionId: chatSessionId },
              }),
            );
          } catch {
            // ignore
          }
        })();
      }, 500);
    },
    [chatSessionId, session?.id],
  );

  const onStopExplore = useCallback(() => {
    abortRef.current?.abort();
    loginWallPendingRef.current = null;
    setLoginWall(null);
    setFetchingAuth(false);
    setAwaitingManualLogin(false);
    if (session?.id) void closeBrowser(session.id).catch(() => undefined);
  }, [session?.id]);

  /** 纯账密路径：新建独立「登录并保存登录态」编排 */
  const createLoginOrchestration = useCallback(async () => {
    const name = loginOrchestrateTitle();
    const target: UiTestTarget = project.framework === 'pytest' ? 'python' : 'ts';
    const loginPlan = buildLoginOrchestratePlan('/login');
    const created = await prepareGeneration({
      projectId: project.id,
      title: name,
      target,
      baseURL: project.baseURL || project.detectedBaseURL || '',
      storageState: project.storageState || project.detectedStorageState || '',
      source: '登录并保存登录态（账号密码）。成功后供业务用例复用 storageState。',
      headed: true,
      reset: true,
      plan: loginPlan,
    });
    await saveGeneration({
      sessionId: created.session.id,
      title: name,
      plan: loginPlan,
      status: 'planned',
    }).catch(() => undefined);
    const linked = await ensureOrchestrateChatSession({
      projectId: project.id,
      projectName: project.name,
      projectDir: project.dir,
      uiautoSessionId: created.session.id,
      requirement: name,
      status: 'planned',
      forceNew: true,
    });
    await saveGeneration({
      sessionId: created.session.id,
      chatSessionId: linked.chatSessionId,
      title: name,
    }).catch(() => undefined);
    await hydrateSessionStore().catch(() => null);
    let store = loadSessionStore();
    store = updateSessionMeta(store, linked.chatSessionId, { title: name });
    await flushSessionStore(store);
    await appendOrchestrateNotice(
      linked.chatSessionId,
      '已生成登录步骤计划。确认无误后点右侧「确认并探索」绑定定位器；成功后业务编排可复用登录态。',
    );
    await refreshList();
    await openDetail(created.session.id);
    showToast('已新建登录编排', 'success');
  }, [openDetail, project, refreshList]);

  /** 静默跑 auth.setup → SSO，成功返回 storageState（不开有头业务浏览器） */
  const tryAcquireAuth = useCallback(
    async (
      steps: ReturnType<typeof loginWallAutoSteps>,
    ): Promise<
      | { ok: true; storageState: string; via: 'sso' | 'auth_setup' }
      | { ok: false; failures: string[] }
    > => {
      const failures: string[] = [];
      for (const step of steps) {
        try {
          if (step === 'sso') {
            const result = await runProjectSsoLogin({
              projectId: project.id,
              envName: project.envName || '',
              baseURL: project.baseURL || project.detectedBaseURL || '',
            });
            setSsoConfigured(true);
            return { ok: true, storageState: result.storageState, via: 'sso' };
          }
          const result = await runProjectAuthSetup({
            projectId: project.id,
            envName: project.envName || '',
          });
          setAuthSetupDetected(true);
          return { ok: true, storageState: result.storageState, via: 'auth_setup' };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(step === 'sso' ? `SSO：${message}` : `auth.setup：${message}`);
          if (step === 'sso' && /LOGIN_API_PATH|LOGIN_API_URL|登录接口地址/.test(message)) {
            setSsoConfigured(false);
          }
        }
      }
      return { ok: false, failures };
    },
    [project],
  );

  /** 撞墙回落：再试自动拿登录态；全失败弹三选一 */
  const runLoginWallAuto = useCallback(
    async (evidence: string) => {
      const chatId = chatSessionId;
      const steps = autoAuthConsumedRef.current
        ? []
        : loginWallAutoSteps({ ssoConfigured, authSetupDetected });
      const openDialog = async (failedHints: string[]) => {
        setFetchingAuth(false);
        if (chatId) {
          const hint = failedHints.length
            ? `自动获取登录态未成功（${failedHints.join('；')}）。请在弹窗里选择处理方式。`
            : autoAuthConsumedRef.current
              ? '已自动注入登录态后仍碰到登录墙。请在弹窗里选择处理方式。'
              : '探索暂停：检测到需要登录。请在弹窗里选择「登录编排 / SSO / 手动登录后继续」。';
          await appendOrchestrateNotice(chatId, hint);
        }
        setLoginWall({
          evidence: evidence.slice(0, 400),
          suggestion: resolveLoginWallHighlight(project.loginStrategy, evidence),
        });
        showToast('检测到登录墙，请选择处理方式', 'error');
      };

      if (!steps.length) {
        await openDialog([]);
        return;
      }

      setFetchingAuth(true);
      setAwaitingManualLogin(false);
      setLoginWall(null);
      if (chatId) {
        await appendOrchestrateNotice(
          chatId,
          `检测到登录墙，正在自动获取登录态（${steps.map((s) => (s === 'sso' ? 'SSO' : 'auth.setup')).join(' → ')}）…`,
        );
      }

      const acquired = await tryAcquireAuth(steps);
      if (acquired.ok) {
        storageOverrideRef.current = acquired.storageState;
        if (session?.id) void closeBrowser(session.id).catch(() => undefined);
        if (chatId) {
          await appendOrchestrateNotice(
            chatId,
            acquired.via === 'sso'
              ? `已通过 SSO / 接口登录写入 ${acquired.storageState}，正在续探索…`
              : `已跑完 auth.setup，登录态 ${acquired.storageState}，正在续探索…`,
          );
        }
        autoAuthConsumedRef.current = true;
        setFetchingAuth(false);
        showToast('已自动获取登录态，继续探索', 'success');
        onConfirmExploreRef.current();
        return;
      }
      await openDialog(acquired.failures);
    },
    [
      authSetupDetected,
      chatSessionId,
      project.loginStrategy,
      session?.id,
      ssoConfigured,
      tryAcquireAuth,
    ],
  );

  const onLoginWallChoose = useCallback(
    async (choice: LoginWallChoice) => {
      if (wallBusy) return;
      setWallBusy(true);
      try {
        if (choice === 'ui_orchestrate') {
          setLoginWall(null);
          setAwaitingManualLogin(false);
          if (session?.id) void closeBrowser(session.id).catch(() => undefined);
          await createLoginOrchestration();
          return;
        }
        if (choice === 'sso') {
          const result = await runProjectSsoLogin({
            projectId: project.id,
            envName: project.envName || '',
            baseURL: project.baseURL || project.detectedBaseURL || '',
          });
          storageOverrideRef.current = result.storageState;
          setSsoConfigured(true);
          setLoginWall(null);
          setAwaitingManualLogin(false);
          if (session?.id) void closeBrowser(session.id).catch(() => undefined);
          if (chatSessionId) {
            await appendOrchestrateNotice(
              chatSessionId,
              `已通过 SSO / 接口登录写入 ${result.storageState}。请再点「确认并探索」继续业务步骤。`,
            );
          }
          showToast('接口登录成功，请再点确认并探索', 'success');
          return;
        }
        // continue：浏览器保持开着，进入等待；用户登完再点「我已登录，继续」
        setLoginWall(null);
        setAwaitingManualLogin(true);
        if (chatSessionId) {
          await appendOrchestrateNotice(
            chatSessionId,
            '等待手动登录：请在已打开的浏览器完成登录，完成后点右侧「我已登录，继续」。',
          );
          void syncOrchestrateStatus({ chatSessionId, status: 'draft' });
        }
        showToast('等待你在浏览器完成登录', 'success');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(message, 'error');
        if (choice === 'sso' && /LOGIN_API_PATH|LOGIN_API_URL|登录接口地址/.test(message)) {
          setSsoConfigured(false);
        }
      } finally {
        setWallBusy(false);
      }
    },
    [chatSessionId, createLoginOrchestration, project, session?.id, wallBusy],
  );

  const onConfirmExplore = useCallback(async () => {
    if (exploringRef.current || busy || detailLoading) return;
    if (!session?.id) return;
    const activePlan = planRef.current;
    if (!activePlan.length) {
      showToast('先在会话里生成步骤，或在右侧手动加几步', 'error');
      return;
    }
    const settingsNow = loadSettings();
    if (!settingsNow) {
      openSettings('model');
      showToast('请先配置模型', 'error');
      return;
    }
    const promptNow = await fetchUiAutoPrompt(promptFile, project.framework);
    if (!promptNow.exists || !String(promptNow.agent || '').trim()) {
      showToast('请先在关联技能里配置 UI 自动化「探索阶段」规则', 'error');
      return;
    }

    if (planSaveRef.current) {
      window.clearTimeout(planSaveRef.current);
      planSaveRef.current = null;
    }

    const resumeAfterManualLogin = awaitingManualLogin;
    setAwaitingManualLogin(false);
    // 关掉登录墙弹窗再开探索，避免按钮一直 disabled
    setLoginWall(null);
    loginWallPendingRef.current = null;

    const sid = session.id;
    const chatId = chatSessionId;
    const target: UiTestTarget = session.target === 'python' ? 'python' : 'ts';
    const baseURL = project.baseURL || project.detectedBaseURL || session.baseURL || '';
    const requirement = requirementFromSession(session, activePlan, title);

    // 先进入 exploring，避免预取登录态结束到开浏览器之间闪回「确认并探索」
    const controller = new AbortController();
    abortRef.current = controller;
    exploringRef.current = true;
    setExploring(true);
    goStage('chat');
    // 新一轮探索作废上一轮出码 / 试跑展示
    setEmitFiles([]);
    setEmitBaseline({});
    setEmitSelectedPaths([]);
    setEmitForceOverwrite(false);
    setVerify(null);
    setSuggestedPath('');
    if (sid) {
      void saveGeneration({ sessionId: sid, editedFiles: null }).catch(() => undefined);
    }

    let preAuthNote = '';
    // 有登录用例 / SSO：必须先拿到 token，再开有头业务浏览器（避免先跳登录页再二次注入）
    // 不因 project.storageState 路径字符串跳过：文件可能已删或已过期
    if (!resumeAfterManualLogin && !autoAuthConsumedRef.current) {
      const preSteps = loginWallAutoSteps({ ssoConfigured, authSetupDetected });
      if (preSteps.length) {
        setFetchingAuth(true);
        if (chatId) {
          await appendOrchestrateNotice(
            chatId,
            `探索前先执行登录拿 token（${preSteps.map((s) => (s === 'sso' ? 'SSO' : 'auth.setup')).join(' → ')}），成功后再打开业务浏览器…`,
          );
        }
        const acquired = await tryAcquireAuth(preSteps);
        setFetchingAuth(false);
        if (acquired.ok) {
          storageOverrideRef.current = acquired.storageState;
          autoAuthConsumedRef.current = true;
          preAuthNote =
            acquired.via === 'sso'
              ? `已通过 SSO 写入 ${acquired.storageState}，接着打开业务浏览器。`
              : `已执行登录用例 / auth.setup，写入 ${acquired.storageState}，接着打开业务浏览器。`;
          showToast('登录态已就绪，开始探索', 'success');
        } else {
          exploringRef.current = false;
          setExploring(false);
          if (chatId) {
            await appendOrchestrateNotice(
              chatId,
              `探索前获取登录态未成功（${acquired.failures.join('；')}）。尚未打开业务浏览器，请处理登录后再点「确认并探索」。`,
            );
          }
          setLoginWall({
            evidence: acquired.failures.join('\n').slice(0, 400),
            suggestion: resolveLoginWallHighlight(
              project.loginStrategy,
              acquired.failures.join(' '),
            ),
          });
          showToast('请先完成登录态，再探索', 'error');
          return;
        }
      }
    }

    const storageState =
      storageOverrideRef.current ||
      project.storageState ||
      project.detectedStorageState ||
      session.storageState ||
      '';

    try {
      if (controller.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (preAuthNote && chatId) {
        await appendOrchestrateNotice(chatId, preAuthNote);
      }
      await prepareGeneration({
        projectId: project.id,
        sessionId: sid,
        title: title.trim() || session.title || '未命名编排',
        target,
        baseURL,
        storageState,
        source: requirement,
        headed: true,
        // 手动登录续跑：保留已打开浏览器里的登录态，只清旧 IR
        reset: true,
        plan: activePlan,
      });
      await saveGeneration({ sessionId: sid, plan: activePlan, status: 'exploring' });
      void syncOrchestrateStatus({ chatSessionId: chatId, status: 'exploring' });
      await appendOrchestrateNotice(
        chatId,
        resumeAfterManualLogin
          ? `继续探索：已假定浏览器内登录完成，按 ${activePlan.length} 步计划绑定定位器。`
          : storageState
            ? `开始探索：已带登录态 ${storageState}，按 ${activePlan.length} 步计划打开浏览器。`
            : `开始探索：按 ${activePlan.length} 步计划打开浏览器并绑定定位器。`,
      );

      const systemContent = buildUiAgentSystemPrompt(
        project,
        target,
        activePlan,
        promptNow.agent,
        promptNow.code,
        promptNow.skeleton,
      );
      const baseUser = buildUiAgentUserPrompt(requirement, baseURL, target, activePlan);
      const userContent = resumeAfterManualLogin
        ? `${baseUser}\n\n【平台提示】用户已在已打开的有头浏览器中手动完成登录。请直接对当前页 snapshot / probe，从业务步骤继续绑定定位器；不要再回到登录页，也不要因为看不到登录态就重新 ui_browser_open 清掉当前会话。`
        : baseUser;
      let messages: ChatMessage[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ];

      const toolCtx = {
        sessionId: sid,
        target,
        allowScreenshot: false as const,
        onPlan: (next: UiPlanStep[]) => {
          setPlan((prev) => mergeServerPlan(prev, next));
        },
        onIr: (ir: UiTestIr) => {
          void appendOrchestrateNotice(chatId, `已提交步骤（${ir.steps.length} 步）。`);
        },
      };

      const runExplorePass = async (passMessages: ChatMessage[]) => {
        let answer = '';
        let browserTouched = false;
        let setSteps = false;
        let opened = false;
        for await (const chunk of streamChatWithTools(
          settingsNow,
          passMessages,
          controller.signal,
          {
            tools: EXPLORE_TOOLS,
            maxToolRounds: 40,
            // 探索要动手开浏览器；关思考减少「只想不调工具就收口」
            thinking: false,
            runTool: async (name, args) => {
              const out = await runUiAutoAgentTool(name, args, toolCtx);
              if (isBrowserClosedOutput(out)) {
                throw new Error(BROWSER_CLOSED_MESSAGE);
              }
              return out;
            },
          },
        )) {
          if (chunk.type === 'content') {
            answer += chunk.delta;
            continue;
          }
          if (chunk.type !== 'tool' || chunk.status !== 'running') continue;
          if (chunk.name.startsWith('ui_browser_') || chunk.name === 'ui_locator_probe') {
            browserTouched = true;
          }
          if (chunk.name === 'ui_test_set_steps') setSteps = true;
          if (chunk.name === 'ui_browser_open' && !opened) {
            opened = true;
            void appendOrchestrateNotice(chatId, '已打开浏览器，正在按计划探测元素…');
          }
        }
        return { answer: answer.trim(), browserTouched, setSteps };
      };

      let pass = await runExplorePass(messages);
      let detail = await fetchGenerationSession(sid);
      setPlan((prev) => mergeServerPlan(prev, detail.session.plan ?? []));
      let steps = detail.session.ir?.steps?.length ?? 0;

      // 模型只回了文字、或逛了页面却没提交 IR：再催一轮，避免「还没动手就结束」
      if (!steps && !controller.signal.aborted && (!pass.browserTouched || !pass.setSteps)) {
        if (pass.answer) {
          await appendOrchestrateNotice(chatId, pass.answer.slice(0, 1500));
        }
        if (detectLoginWall(pass.answer)) {
          await saveGeneration({ sessionId: sid, status: 'draft' }).catch(() => undefined);
          void syncOrchestrateStatus({ chatSessionId: chatId, status: 'draft' });
          setAwaitingManualLogin(false);
          loginWallPendingRef.current = pass.answer.slice(0, 400);
          return;
        }
        await appendOrchestrateNotice(
          chatId,
          pass.browserTouched
            ? '还没有提交步骤，正在催促模型继续 probe / 提交…'
            : '还没有打开浏览器，正在催促模型按计划开始探索…',
        );
        messages = [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
          ...(pass.answer ? [{ role: 'assistant' as const, content: pass.answer }] : []),
          {
            role: 'user',
            content: pass.browserTouched
              ? '不要只文字说明。请立刻继续 probe 未绑定步骤，并调用 ui_test_set_steps 提交完整步骤（含定位器）。'
              : '不要只文字说明。请立刻调用 ui_browser_open 打开计划中的起始页，再 snapshot / probe，最后必须调用 ui_test_set_steps 提交。',
          },
        ];
        pass = await runExplorePass(messages);
        detail = await fetchGenerationSession(sid);
        setPlan((prev) => mergeServerPlan(prev, detail.session.plan ?? []));
        steps = detail.session.ir?.steps?.length ?? 0;
      }

      if (pass.answer) {
        await appendOrchestrateNotice(chatId, pass.answer.slice(0, 1500));
      }

      setSession({ ...detail.session, status: detail.session.status || 'explored' });
      if (!steps) {
        await saveGeneration({ sessionId: sid, status: 'draft' }).catch(() => undefined);
        void syncOrchestrateStatus({ chatSessionId: chatId, status: 'draft' });
        if (detectLoginWall(pass.answer)) {
          setAwaitingManualLogin(false);
          loginWallPendingRef.current = pass.answer.slice(0, 400);
          return;
        }
        const hint = pass.browserTouched
          ? '探索未完成：已打开过浏览器，但本轮没有提交可用步骤。可改步骤后再点「确认并探索」。'
          : '探索未完成：模型没有打开浏览器就收口了。请再点一次「确认并探索」，或先在会话里补清需求。';
        await appendOrchestrateNotice(chatId, hint);
        showToast('探索未完成', 'error');
        return;
      }
      await saveGeneration({ sessionId: sid, status: 'explored' }).catch(() => undefined);
      setSession({ ...detail.session, status: 'explored' });
      void syncOrchestrateStatus({ chatSessionId: chatId, status: 'explored' });
      autoAuthConsumedRef.current = false;
      // 先关浏览器再提示，避免「探索完成」后窗口还挂着
      await closeBrowser(sid).catch(() => undefined);
      await appendOrchestrateNotice(
        chatId,
        `探索完成（${steps} 步）。定位器已写入左侧步骤，浏览器已关闭；在会话里发送「生成代码」即可出码。`,
      );
      showToast(`探索完成，已绑定 ${steps} 步`, 'success');
      void refreshList();
    } catch (err) {
      const aborted =
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error && /aborted/i.test(err.message));
      const browserClosed = err instanceof Error && err.message === BROWSER_CLOSED_MESSAGE;
      // 用户主动停 / 关浏览器：丢掉待处理登录墙，避免「取消探测又弹窗」且挡死再次确认
      if (aborted || browserClosed) {
        loginWallPendingRef.current = null;
        setLoginWall(null);
        autoAuthConsumedRef.current = false;
      }
      if (aborted) {
        await appendOrchestrateNotice(chatId, '已停止探索。');
        showToast('已停止探索', 'success');
      } else if (browserClosed) {
        await appendOrchestrateNotice(
          chatId,
          '浏览器已关闭，本轮探索结束；已提交的步骤与计划保留。',
        );
        showToast('浏览器已关闭，探索结束', 'success');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        onError?.(message);
        await appendOrchestrateNotice(chatId, `探索中断：${message}`);
        showToast(message, 'error');
      }
      await saveGeneration({ sessionId: sid, status: 'draft' }).catch(() => undefined);
      void syncOrchestrateStatus({ chatSessionId: chatId, status: 'draft' });
    } finally {
      abortRef.current = null;
      exploringRef.current = false;
      setExploring(false);
      setFetchingAuth(false);
      const pendingWall = loginWallPendingRef.current;
      const stopped = controller.signal.aborted;
      if (pendingWall != null && !stopped) {
        // 登录墙：先留着浏览器，方便选「手动登录后继续」；SSO 成功路径里会自己关
        loginWallPendingRef.current = null;
        void runLoginWallAuto(pendingWall);
      } else {
        loginWallPendingRef.current = null;
        // 探索正常结束 / 未完成 / 停止：关掉有头浏览器，形成闭环（成功路径已关过，再调一次无害）
        await closeBrowser(sid).catch(() => undefined);
      }
    }
  }, [
    authSetupDetected,
    awaitingManualLogin,
    busy,
    chatSessionId,
    detailLoading,
    onError,
    project,
    promptFile,
    refreshList,
    goStage,
    runLoginWallAuto,
    session,
    ssoConfigured,
    title,
    tryAcquireAuth,
  ]);

  onConfirmExploreRef.current = () => {
    void onConfirmExplore();
  };

  const hasIrSteps = Boolean(session?.ir?.steps?.length);
  const codeUnlocked = hasIrSteps || session?.status === 'explored' || emitFiles.length > 0;
  const verifyUnlocked = emitFiles.length > 0 || Boolean(draft?.hasSteps);

  const onEmitCode = useCallback(async () => {
    if (!session?.id || emitRunning || exploring || verifying) return;
    setEmitRunning(true);
    try {
      const detail = await fetchGenerationSession(session.id);
      setSession(detail.session);
      setSuggestedPath(detail.suggestedPath || '');
      setDraft(detail.draft ?? null);
      const ir = detail.session.ir;
      if (!ir?.steps?.length) {
        showToast('还没有可出码的步骤，请先确认并探索', 'error');
        return;
      }
      const target: UiTestTarget = detail.session.target === 'python' ? 'python' : 'ts';
      const testDir = detail.suggestedPath.includes('/')
        ? detail.suggestedPath.replace(/\/[^/]+$/, '')
        : 'tests';
      const emitted = await emitGeneration(ir, target, {
        testDir,
        projectId: project.id,
        sessionId: session.id,
      });
      const baseline: Record<string, string> = {};
      for (const file of emitted.files) baseline[file.path] = file.content;
      setEmitBaseline(baseline);
      setEmitFiles(emitted.files);
      setEmitSelectedPaths(emitted.files.map((file) => file.path));
      setEmitForceOverwrite(false);
      await saveGeneration({ sessionId: session.id, editedFiles: null }).catch(() => undefined);
      void writeDraftFiles(session.id, emitted.files).catch(() => undefined);
      goStage('code');
      if (chatSessionId) {
        await appendOrchestrateNotice(
          chatSessionId,
          `已生成 ${emitted.files.length} 个文件（用例 / 页面对象等）。要重出可再说「重新出码」；运行请到代码页底部。`,
        );
      }
      showToast(`已出码 ${emitted.files.length} 个文件`, 'success');
      void refreshList();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message);
      showToast(message, 'error');
    } finally {
      setEmitRunning(false);
    }
  }, [
    chatSessionId,
    emitRunning,
    exploring,
    goStage,
    onError,
    project.id,
    refreshList,
    session?.id,
    verifying,
  ]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; chatSessionId?: string }>).detail;
      if (detail?.action !== 'emit') return;
      if (detail.chatSessionId && chatSessionId && detail.chatSessionId !== chatSessionId) return;
      void onEmitCode();
    };
    window.addEventListener(UIAUTO_ORCHESTRATE_ACTION_EVENT, onAction);
    return () => window.removeEventListener(UIAUTO_ORCHESTRATE_ACTION_EVENT, onAction);
  }, [chatSessionId, onEmitCode]);

  const verifyingRef = useRef(false);
  const onVerifyRun = useCallback(async () => {
    if (!session?.id || verifyingRef.current || exploring || emitRunning) return;
    verifyingRef.current = true;
    setVerifying(true);
    // 先清掉旧日志，避免「点了没反应」的错觉
    setVerify((prev) =>
      prev
        ? {
            ...prev,
            log: '正在重新运行…',
            passed: undefined,
            exitCode: null,
            durationMs: 0,
          }
        : {
            ok: true,
            log: '正在运行…',
            passed: undefined,
            exitCode: null,
            durationMs: 0,
          },
    );
    goStage('code');
    expandLogPanel();
    if (chatSessionId) {
      void appendOrchestrateNotice(chatSessionId, '开始试跑：写入草稿并执行用例…');
    }
    try {
      // 手改已 debounce 写入草稿；这里再带 files，保证与编辑器一致
      const files =
        emitFiles.length > 0
          ? emitFiles.map((file) => ({
              path: file.path,
              content: file.content,
              role: file.role,
            }))
          : undefined;
      const result = await verifyGeneration(session.id, undefined, undefined, { files });
      setVerify(result);
      if (result.draftRoot || result.draftPath) {
        setDraft((prev) => ({
          draftRoot: result.draftRoot || prev?.draftRoot || '',
          draftDir: prev?.draftDir || '',
          artifactDir: result.artifactDir || prev?.artifactDir || '',
          configPath: result.configPath || prev?.configPath || '',
          exists: true,
          hasSteps: true,
          tracePath: result.tracePath || prev?.tracePath || '',
        }));
      }
      const detail = await fetchGenerationSession(session.id).catch(() => null);
      if (detail) {
        setSession(detail.session);
        setDraft(detail.draft ?? null);
      }
      if (chatSessionId) {
        void appendOrchestrateNotice(
          chatSessionId,
          result.passed
            ? '试跑通过。可在代码页底部查看运行日志与草稿。'
            : `试跑未通过${result.exitCode != null ? `（exit ${result.exitCode}）` : ''}，请看代码页底部运行日志。`,
        );
      }
      showToast(result.passed ? '试跑通过' : '试跑失败', result.passed ? 'success' : 'error');
      void refreshList();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message);
      showToast(message, 'error');
      setVerify((prev) => ({
        ok: false,
        passed: false,
        log:
          prev?.log && prev.log !== '正在运行…' && prev.log !== '正在重新运行…'
            ? `${prev.log}\n\n试跑中断：${message}`
            : `试跑中断：${message}`,
        draftPath: prev?.draftPath,
        draftRoot: prev?.draftRoot,
        configPath: prev?.configPath,
        artifactDir: prev?.artifactDir,
        tracePath: prev?.tracePath,
      }));
      if (chatSessionId) {
        void appendOrchestrateNotice(chatSessionId, `试跑中断：${message}`);
      }
    } finally {
      verifyingRef.current = false;
      setVerifying(false);
    }
  }, [
    chatSessionId,
    emitFiles,
    emitRunning,
    expandLogPanel,
    exploring,
    goStage,
    onError,
    refreshList,
    session?.id,
  ]);

  const emitDirtySet = useMemo(() => {
    const dirty = new Set<string>();
    for (const file of emitFiles) {
      if (emitBaseline[file.path] !== file.content) dirty.add(file.path);
    }
    return dirty;
  }, [emitBaseline, emitFiles]);

  const emitPersistRef = useRef<number | null>(null);
  const persistEmitEdits = useCallback(
    (files: UiEmitFile[]) => {
      if (!session?.id) return;
      if (emitPersistRef.current) window.clearTimeout(emitPersistRef.current);
      emitPersistRef.current = window.setTimeout(() => {
        emitPersistRef.current = null;
        const baselineDiffers = files.some((file) => emitBaseline[file.path] !== file.content);
        void writeDraftFiles(session.id, files).catch(() => undefined);
        void saveGeneration({
          sessionId: session.id,
          editedFiles: baselineDiffers ? files : null,
        }).catch(() => undefined);
      }, 450);
    },
    [emitBaseline, session?.id],
  );

  useEffect(() => {
    return () => {
      if (emitPersistRef.current) window.clearTimeout(emitPersistRef.current);
    };
  }, []);

  const onEmitContentChange = useCallback(
    (path: string, content: string) => {
      setEmitFiles((prev) => {
        const next = prev.map((file) => (file.path === path ? { ...file, content } : file));
        persistEmitEdits(next);
        return next;
      });
    },
    [persistEmitEdits],
  );

  const onEmitPathChange = useCallback(
    (from: string, to: string) => {
      const nextPath = to.trim();
      if (!nextPath || nextPath === from) return;
      setEmitFiles((prev) => {
        const next = prev.map((file) => (file.path === from ? { ...file, path: nextPath } : file));
        persistEmitEdits(next);
        return next;
      });
      setEmitSelectedPaths((prev) =>
        prev.includes(from) ? prev.map((path) => (path === from ? nextPath : path)) : prev,
      );
    },
    [persistEmitEdits],
  );

  const emitSelectedSet = useMemo(() => new Set(emitSelectedPaths), [emitSelectedPaths]);
  const emitWrittenSet = useMemo(() => {
    const paths = session?.savedPaths?.length
      ? session.savedPaths
      : session?.savedPath
        ? [session.savedPath]
        : [];
    return new Set(paths.filter(Boolean));
  }, [session?.savedPath, session?.savedPaths]);

  const onToggleEmitSelect = useCallback((path: string) => {
    setEmitSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path],
    );
  }, []);

  const onToggleEmitSelectAll = useCallback(
    (select: boolean) => {
      setEmitSelectedPaths(select ? emitFiles.map((file) => file.path) : []);
    },
    [emitFiles],
  );

  const onWriteSelectedFiles = useCallback(async () => {
    if (!session?.id || emitWriting || emitReverting || emitRunning || verifying) return;
    const selected = emitFiles.filter((file) => emitSelectedSet.has(file.path));
    if (!selected.length) {
      showToast('请先勾选要写入的文件', 'error');
      return;
    }
    setEmitWriting(true);
    try {
      const result = await writeGeneration({
        sessionId: session.id,
        files: selected.map((file) => ({
          path: file.path,
          content: file.content,
          role: file.role,
        })),
        force: emitForceOverwrite,
      });
      if (!result.ok) {
        const conflictHint = result.conflicts?.length
          ? `（冲突 ${result.conflicts.length} 个，可勾选整文件覆盖）`
          : '';
        showToast(`${result.error || '写入失败'}${conflictHint}`, 'error');
        return;
      }
      const detail = await fetchGenerationSession(session.id).catch(() => null);
      if (detail) {
        setSession(detail.session);
        setSuggestedPath(detail.suggestedPath || '');
      } else {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                status: 'written',
                savedPath: result.savedPaths?.[0] || prev.savedPath,
                savedPaths: result.savedPaths || prev.savedPaths,
              }
            : prev,
        );
      }
      const summary = result.summary;
      const bits = [
        summary?.created ? `新建 ${summary.created}` : '',
        summary?.merged ? `合并 ${summary.merged}` : '',
        summary?.updated ? `覆盖 ${summary.updated}` : '',
        summary?.unchanged ? `无变化 ${summary.unchanged}` : '',
      ].filter(Boolean);
      showToast(
        `已写入 ${result.savedPaths?.length ?? selected.length} 个文件${
          bits.length ? `（${bits.join('、')}）` : ''
        }`,
        'success',
      );
      if (chatSessionId) {
        void appendOrchestrateNotice(
          chatSessionId,
          `已写入项目 ${result.savedPaths?.length ?? selected.length} 个文件。可继续草稿试跑，或勾选已写入项「从项目移除」。`,
        );
      }
      setEmitForceOverwrite(false);
      void refreshList();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message);
      showToast(message, 'error');
    } finally {
      setEmitWriting(false);
    }
  }, [
    chatSessionId,
    emitFiles,
    emitForceOverwrite,
    emitReverting,
    emitRunning,
    emitSelectedSet,
    emitWriting,
    onError,
    refreshList,
    session?.id,
    verifying,
  ]);

  const onRevertSelectedFiles = useCallback(async () => {
    if (!session?.id || emitWriting || emitReverting || emitRunning || verifying) return;
    const selectedWritten = emitSelectedPaths.filter((path) => emitWrittenSet.has(path));
    if (!selectedWritten.length) {
      showToast('请勾选已写入项目的文件再移除', 'error');
      return;
    }
    const skippedOnly = emitSelectedPaths.length - selectedWritten.length;
    const ok = window.confirm(
      `确定从项目移除已选的 ${selectedWritten.length} 个文件？\n` +
        `新建的会删除，合并/覆盖的会还原写入前内容。` +
        (skippedOnly > 0 ? `\n另有 ${skippedOnly} 个未写入项会跳过。` : ''),
    );
    if (!ok) return;
    setEmitReverting(true);
    try {
      const result = await revertGeneration({
        sessionId: session.id,
        paths: selectedWritten,
      });
      if (!result.ok) {
        showToast(result.error || '移除失败', 'error');
        return;
      }
      if (result.session) {
        setSession(result.session);
      } else {
        const detail = await fetchGenerationSession(session.id).catch(() => null);
        if (detail) setSession(detail.session);
      }
      const skipped = result.skipped?.length ?? 0;
      showToast(
        `已从项目移除 ${result.reverted?.length ?? selectedWritten.length} 个文件${
          skipped ? `，跳过 ${skipped} 个` : ''
        }`,
        'success',
      );
      if (chatSessionId) {
        void appendOrchestrateNotice(
          chatSessionId,
          `已按账本从项目移除 ${result.reverted?.length ?? selectedWritten.length} 个文件。`,
        );
      }
      void refreshList();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message);
      showToast(message, 'error');
    } finally {
      setEmitReverting(false);
    }
  }, [
    chatSessionId,
    emitReverting,
    emitRunning,
    emitSelectedPaths,
    emitWrittenSet,
    emitWriting,
    onError,
    refreshList,
    session?.id,
    verifying,
  ]);

  const onRevealDraft = useCallback(
    async (path: string) => {
      if (!path || !session?.id) return;
      try {
        await revealPath({ sessionId: session.id, path });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(message, 'error');
      }
    },
    [session?.id],
  );

  const boundCount = useMemo(
    () =>
      plan.filter((step) => step.status === 'bound' || step.status === 'done' || step.locator)
        .length,
    [plan],
  );
  const stages = STAGES;

  /** 左侧主按钮只负责探索；出码走会话「生成代码 / 重新出码」，运行在代码页底栏 */
  const primaryAction = useMemo(() => {
    if (exploring) {
      return {
        kind: 'stop_explore' as const,
        label: '停止探索',
        disabled: false,
      };
    }
    if (awaitingManualLogin) {
      return { kind: 'explore' as const, label: '我已登录，继续', disabled: false };
    }
    if (fetchingAuth) {
      return { kind: 'explore' as const, label: '获取登录态…', disabled: true };
    }
    return {
      kind: 'explore' as const,
      label: codeUnlocked ? '重新探索' : '确认并探索',
      disabled: !plan.length || detailLoading || busy || emitRunning || verifying,
    };
  }, [
    awaitingManualLogin,
    busy,
    codeUnlocked,
    detailLoading,
    emitRunning,
    exploring,
    fetchingAuth,
    plan.length,
    verifying,
  ]);

  const deleteDialog = (
    <ConfirmDialog
      open={deleteTarget !== null}
      title="删除编排"
      message={`确定删除「${deleteTarget?.label ?? ''}」？\n关联会话与步骤会一起清掉，此操作无法恢复。`}
      confirmLabel="删除"
      danger="solid"
      onClose={() => setDeleteTarget(null)}
      onConfirm={() => void confirmDelete()}
    />
  );

  const loginWallDialog = (
    <LoginWallDialog
      open={loginWall !== null}
      suggestion={loginWall?.suggestion ?? 'ui_orchestrate'}
      evidence={loginWall?.evidence}
      ssoConfigured={ssoConfigured}
      busy={wallBusy}
      onClose={() => {
        setLoginWall(null);
        setFetchingAuth(false);
        setWallBusy(false);
        exploringRef.current = false;
        setExploring(false);
        if (session?.id) void closeBrowser(session.id).catch(() => undefined);
      }}
      onChoose={(choice) => void onLoginWallChoose(choice)}
    />
  );

  if (activeId) {
    const stageHint =
      exploring && fetchingAuth
        ? '正在获取登录态…'
        : exploring
          ? '正在打开浏览器绑定定位器…'
          : verifying
            ? '正在写入草稿并执行用例…'
            : emitRunning
              ? '正在按步骤生成代码…'
              : loginWall
                ? '检测到登录墙，请先在弹窗里选择处理方式'
                : awaitingManualLogin
                  ? '等待你在已打开的浏览器完成登录…'
                  : codeUnlocked
                    ? '会话里发「生成代码」出码；代码页底部可运行'
                    : '确认后打开浏览器绑定定位器';

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#fafaf9]">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-stone-200/90 bg-white px-3">
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-800"
            onClick={backToList}
          >
            <span aria-hidden="true">←</span>
            返回
          </button>
          <span className="h-4 w-px shrink-0 bg-stone-200" aria-hidden="true" />
          <input
            className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-[14px] font-medium text-stone-800 outline-none transition-colors hover:bg-stone-50 focus:border-stone-200 focus:bg-white focus:ring-2 focus:ring-[#4176e6]/20 disabled:opacity-60"
            value={title}
            onChange={(event) => persistTitle(event.target.value)}
            aria-label="编排标题"
            placeholder="未命名编排"
            disabled={exploring}
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] tabular-nums text-stone-600">
              {plan.length ? `${boundCount}/${plan.length} 已绑定` : '尚无步骤'}
            </span>
            {verify ? (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  verify.passed ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                }`}
              >
                {verify.passed ? '试跑通过' : '试跑失败'}
              </span>
            ) : emitFiles.length ? (
              <span className="rounded-full bg-[#4176e6]/8 px-2 py-0.5 text-[11px] text-[#4176e6]">
                已出码
              </span>
            ) : null}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside
            className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-stone-200/80 bg-white"
            style={{ width: stepsWidth }}
          >
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stone-100 px-3">
              <span className="text-[13px] font-medium text-stone-800">步骤</span>
              {detailLoading && !plan.length ? (
                <span className="text-[11px] text-stone-400">打开中…</span>
              ) : plan.length ? (
                <span className="text-[11px] tabular-nums text-stone-400">
                  {boundCount}/{plan.length}
                </span>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-2.5 pt-2 pb-2">
              <UiAutoSteps
                plan={plan}
                onChange={persistPlan}
                disabled={exploring || verifying || (detailLoading && !session)}
                compactHeader
              />
            </div>
            <div className="shrink-0 border-t border-stone-200/80 bg-stone-50/60 px-3 py-2.5">
              <button
                type="button"
                className={`inline-flex h-9 w-full items-center justify-center rounded-lg text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  primaryAction.kind === 'stop_explore'
                    ? 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
                    : 'bg-[#4176e6] text-white shadow-[0_1px_0_rgba(65,118,230,0.25)] hover:bg-[#3566d0]'
                }`}
                disabled={primaryAction.disabled}
                onClick={() => {
                  if (primaryAction.kind === 'stop_explore') {
                    onStopExplore();
                    return;
                  }
                  if (loginWall) setLoginWall(null);
                  void onConfirmExplore();
                }}
              >
                {primaryAction.label}
              </button>
              <p className="mt-1.5 text-center text-[11px] leading-4 text-stone-400">{stageHint}</p>
            </div>
          </aside>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整步骤栏宽度"
            className="group relative w-1.5 shrink-0 cursor-col-resize bg-transparent"
            onPointerDown={(event) => {
              dragRef.current = { startX: event.clientX, startWidth: stepsWidth };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag) return;
              const next = Math.min(
                STEPS_MAX,
                Math.max(STEPS_MIN, drag.startWidth + (event.clientX - drag.startX)),
              );
              setStepsWidth(next);
            }}
            onPointerUp={(event) => {
              if (!dragRef.current) return;
              dragRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              writeViewText(STEPS_WIDTH_PREF, String(stepsWidth));
            }}
          >
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-stone-200 transition-colors group-hover:bg-[#4176e6]/55" />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
            <div className="flex h-11 shrink-0 items-center border-b border-stone-100 px-3">
              <div className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-stone-100/90 p-0.5">
                {stages.map((item, index) => {
                  const locked = exploring || (item.value === 'code' && !codeUnlocked);
                  const active = stage === item.value;
                  const done =
                    (item.value === 'code' && (emitFiles.length > 0 || Boolean(verify))) ||
                    (item.value === 'chat' && codeUnlocked);
                  let label = item.label;
                  if (item.value === 'code' && emitFiles.length) {
                    label = `代码 ${emitFiles.length}`;
                  }
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors disabled:cursor-not-allowed ${
                        active
                          ? 'bg-white font-medium text-stone-800 shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
                          : locked
                            ? 'text-stone-300'
                            : done
                              ? 'text-stone-600 hover:text-stone-800'
                              : 'text-stone-500 hover:text-stone-700'
                      }`}
                      disabled={locked && item.value !== 'chat'}
                      onClick={() => {
                        if (locked && item.value !== 'chat') return;
                        goStage(item.value);
                      }}
                    >
                      <span
                        className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] tabular-nums ${
                          active
                            ? 'bg-[#4176e6] text-white'
                            : done
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-stone-200/80 text-stone-500'
                        }`}
                      >
                        {index + 1}
                      </span>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {stage === 'chat' ? (
                <UiAutoOrchestratePanel
                  chatSessionId={chatSessionId}
                  projectDir={project.dir}
                  projectName={project.name}
                />
              ) : null}
              {stage === 'code' ? (
                <>
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    <UiAutoOrchestrateCodePane
                      files={emitFiles}
                      reemitting={emitRunning}
                      dirtyPaths={emitDirtySet}
                      writtenPaths={emitWrittenSet}
                      selectedPaths={emitSelectedSet}
                      forceOverwrite={emitForceOverwrite}
                      writing={emitWriting}
                      reverting={emitReverting}
                      onReemit={() => void onEmitCode()}
                      onChangeContent={onEmitContentChange}
                      onChangePath={onEmitPathChange}
                      onToggleSelect={onToggleEmitSelect}
                      onToggleSelectAll={onToggleEmitSelectAll}
                      onForceOverwriteChange={setEmitForceOverwrite}
                      onWriteSelected={() => void onWriteSelectedFiles()}
                      onRevertSelected={() => void onRevertSelectedFiles()}
                    />
                  </div>
                  <UiAutoOrchestrateRunLog
                    verify={verify}
                    draft={draft}
                    verifying={verifying}
                    canRun={verifyUnlocked && !exploring && !emitRunning}
                    collapsed={logPanelCollapsed}
                    dragging={logPanelDragging}
                    height={logPanelHeight}
                    onToggle={toggleLogPanel}
                    onVerify={() => void onVerifyRun()}
                    onReveal={(path) => void onRevealDraft(path)}
                    onDragStart={onLogPanelDragStart}
                    onDragMove={onLogPanelDragMove}
                    onDragEnd={onLogPanelDragEnd}
                    onDragCancel={onLogPanelDragCancel}
                  />
                </>
              ) : null}
            </div>
          </div>
        </div>
        {deleteDialog}
        {loginWallDialog}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-stone-50/60 p-3">
      <section className="flex shrink-0 flex-wrap items-end justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-wide text-stone-500">新建编排</p>
          <p className="mt-1 text-[13px] leading-relaxed text-stone-500">
            用会话拆步骤，确认后探索绑定位器，再出码与试跑
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-8 shrink-0 items-center rounded-lg bg-[#4176e6] px-3 text-[13px] font-medium text-white transition-colors hover:bg-[#3566d0] disabled:opacity-40"
          disabled={busy}
          onClick={() => void onCreate()}
        >
          新建编排
        </button>
      </section>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
        <div className="flex h-10 shrink-0 items-center border-b border-stone-100 px-4">
          <span className="text-[12px] text-stone-400">
            {loading ? '读取中…' : `共 ${items.length} 条`}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!loading && items.length === 0 ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 py-12 text-center">
              <p className="text-sm font-medium text-stone-700">还没有脚本编排</p>
              <p className="mt-1.5 max-w-sm text-[12px] leading-relaxed text-stone-400">
                点上方「新建编排」，在会话里描述要测的流程即可
              </p>
              <button
                type="button"
                className="mt-4 inline-flex h-8 items-center rounded-lg border border-stone-200 px-3 text-[12px] text-stone-600 transition-colors hover:bg-stone-50"
                disabled={busy}
                onClick={() => void onCreate()}
              >
                新建编排
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="h-full min-h-24" aria-busy="true" aria-label="正在读取编排列表" />
          ) : (
            <ul className="divide-y divide-stone-100">
              {items.map((item) => {
                const status = statusOf(item);
                const meta = STATUS_META[status];
                const label = displayOrchestrateTitle(item.title || item.source || item.id);
                const count = stepCountOf(item);
                return (
                  <li
                    key={item.id}
                    className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-stone-50"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => void openDetail(item.id)}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-medium text-stone-800">
                          {label}
                        </span>
                        <span
                          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] leading-4 ${meta.className}`}
                        >
                          {meta.label}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[12px] leading-4 text-stone-400">
                        <span>{count ? `${count} 步` : '尚无步骤'}</span>
                        <span className="text-stone-300">·</span>
                        <span>{formatTime(item.updatedAt || item.createdAt)}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600"
                      onClick={() => setDeleteTarget({ id: item.id, label })}
                    >
                      删除
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
      {deleteDialog}
      {loginWallDialog}
    </div>
  );
}
