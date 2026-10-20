/**
 * AI 生成工作区：左侧「需求 / 步骤计划」占满全高，右侧上半「探索活动」、下半代码 / 变更 / 试跑。
 *
 * 生成不是「让模型直接写脚本」，而是让它真的点一遍页面：
 * 规划步骤（人可改）→ 探索（浏览器工具）→ 探测定位器并回填计划 → 提交步骤 IR
 * → 渲染代码（spec + page object + fixture 多文件）→ 在项目内 .lantern-ai 草稿里试跑 / 调试
 * → 确认后一次写入整组文件并验收。
 *
 * 草稿不删：失败现场要能打开看、能重跑、能回放 trace。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { hydrateAppConfig } from '../../lib/app-config';
import { streamChatWithTools, type ChatMessage } from '../../lib/llm';
import {
  loadSettings,
  onSettingsChanged,
  openSettings,
  type LLMSettings,
} from '../../lib/settings';
import {
  buildUiAgentSystemPrompt,
  buildUiAgentUserPrompt,
  buildUiPlanSystemPrompt,
  buildUiPlanUserPrompt,
  BROWSER_CLOSED_MESSAGE,
  cleanDraft,
  closeBrowser,
  debugGeneration,
  emitGeneration,
  fetchChanges,
  fetchConsole,
  fetchGenerationSession,
  fetchGenerationSessions,
  fetchNetwork,
  isBrowserClosedOutput,
  prepareGeneration,
  revealPath,
  runProjectFile,
  runUiAutoAgentTool,
  saveGeneration,
  stopDebug,
  UI_AUTO_AGENT_TOOLS,
  UI_AUTO_PLAN_TOOLS,
  verifyGeneration,
  writeGeneration,
  type UiChangeEntry,
  type UiDebugResult,
  type UiDraftSummary,
  type UiEmitFile,
  type UiGenSession,
  type UiGitSummary,
  type UiPlanStep,
  type UiRunFileResult,
  type UiTestIr,
  type UiTestTarget,
  type UiVerifyResult,
} from '../../lib/ui-auto-agent';
import {
  fetchUiAutoPrompt,
  UI_AUTO_PROMPT_FILE,
  type UiAutoPrompt,
} from '../../lib/ui-auto-prompt';
import { showToast } from './Toast';
import { updateProject, type UiAutoProject } from '../../lib/ui-auto';
import { readViewJson, readViewText, writeViewJson, writeViewText } from '../../lib/view-prefs';
import { clearHydrateCache } from '../../lib/hydrate-cache';
import { renderMarkdown } from '../../lib/markdown-client';
import UiAutoChanges from './UiAutoChanges';
import UiAutoSteps from './UiAutoSteps';
import OpenWithMenu from './OpenWithMenu';
import SelectDropdown, { type SelectOption } from './SelectDropdown';

/* 动作按钮：统一按下反馈（motion-safe 时轻微下沉 1px + 透明度），
   transition 里带上 transform / opacity，避免「点下去先灰一下再变」的跳变。
   避免用 scale：窄栏里缩放会像在抖。
   注意：深色主题会把 [class~='disabled:text-stone-400'] 常驻成灰色（见 global.css），
   所以这里禁用态一律用 opacity，不改文字色。 */
const BTN_BASE =
  'inline-flex h-8 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm outline-none transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-150 motion-safe:active:translate-y-px focus-visible:ring-2 focus-visible:ring-[#4176e6]/35 disabled:cursor-not-allowed disabled:motion-safe:active:translate-y-0';
const BTN_PRIMARY = `${BTN_BASE} font-medium text-white shadow-[0_1px_2px_rgba(23,43,99,0.12),inset_0_1px_0_rgba(255,255,255,0.18)] bg-[#4176e6] hover:bg-[#3566d0] active:bg-[#2f5cbd] active:shadow-none disabled:opacity-40 disabled:shadow-none disabled:hover:bg-[#4176e6] disabled:active:bg-[#4176e6]`;
const BTN_GHOST = `${BTN_BASE} border border-stone-200 text-stone-600 hover:border-stone-300 hover:bg-stone-50 disabled:opacity-40`;
/** 运行中主按钮：原地变「停止」，红色描边，和主色区分但保持同一尺寸 */
const BTN_STOP = `${BTN_BASE} border border-red-200 bg-red-50 text-red-600 hover:opacity-90 active:opacity-80`;
/** 分段按钮（生成步骤 / 生成代码）：无边框，靠外层描边分组。
    拆成 base / 常态两段：运行中换成 SEG_RUNNING，不再叠加 disabled 灰度，
    避免「点完自己先灰掉」的那一下闪变。 */
const SEG_BTN_BASE =
  'inline-flex h-7 select-none items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs outline-none transition-[background-color,color,box-shadow,opacity,transform] duration-150 motion-safe:active:translate-y-px focus-visible:ring-2 focus-visible:ring-[#4176e6]/30 disabled:cursor-not-allowed disabled:motion-safe:active:translate-y-0';
const SEG_BTN = `${SEG_BTN_BASE} text-stone-600 hover:bg-stone-100 disabled:opacity-40`;
/** 这一项正在跑：淡蓝底 + 主色。
    底色用 CSS 变量（浅色/深色各自有值）；文字色只能用 global.css 里已登记过深色映射的
    `text-[#4176e6]`——直接写 `text-(--tw-accent)` 会被深色主题那条
    `:is(...) { color: label-secondary !important }` 盖掉。 */
const SEG_RUNNING = `${SEG_BTN_BASE} bg-(--tw-accent-soft) text-[#4176e6]`;
const BTN_LINK =
  'text-[11px] text-[#3370ff] hover:underline disabled:opacity-40 disabled:no-underline';
const INPUT =
  'h-8 w-full rounded-lg border border-stone-200 bg-white px-2.5 text-xs text-stone-700 outline-none transition-colors focus:border-[#3370ff]';

const MAX_REPAIR_ROUNDS = 3;

interface ActivityItem {
  id: number;
  kind: 'tool' | 'info' | 'error';
  name: string;
  detail: string;
  status: 'running' | 'done' | 'failed';
  /** 落盘用：刷新后还能看出先后顺序 */
  at?: string;
}

type Phase = 'idle' | 'planning' | 'exploring' | 'verifying' | 'repairing';
/** 上半：看的东西（过程 / 出码 / 变更）；下半：跑的东西（控制台 / 网络 / 试跑） */
type TopTab = 'activity' | 'code' | 'changes';
type BottomTab = 'console' | 'network' | 'run';

const PANEL_PREF = 'ui-auto.gen.panel';
const PANEL_MIN = 160;
const DEFAULT_PANEL = 260;
const COLLAPSED_PANEL = 36;
/** 往下拖到这个高度以内松手就直接收起：把手能一路拉到只剩 Tab 行 */
const PANEL_COLLAPSE_AT = COLLAPSED_PANEL + 24;
const SIDE_PREF = 'ui-auto.gen.side';
/** 最小宽度要装得下动作条（分段按钮 ~185 + 间距 + 主按钮 104 + 两侧内边距），
    之前 300 在这个极限值下会把「开始探索」挤出右边界 */
const SIDE_MIN = 330;
const SIDE_MAX = 560;
const DEFAULT_SIDE = 380;
const TOP_PREF = 'ui-auto.gen.top';
const BOTTOM_PREF = 'ui-auto.gen.bottom';
const TARGET_PREF = 'ui-auto.gen.target';
const REQ_MIN = 72;
const REQ_MAX = 420;
/** 需求框默认就是最小高度；拖过高度的会记住，双击把手恢复到这个默认值 */
const DEFAULT_REQ = REQ_MIN;
const REQ_HEIGHT_PREF = 'ui-auto.gen.reqheight';

const TOP_TABS: ReadonlyArray<{ value: TopTab; label: string }> = [
  { value: 'activity', label: '探索活动' },
  { value: 'code', label: '代码' },
  { value: 'changes', label: '变更' },
];

const BOTTOM_TABS: ReadonlyArray<{ value: BottomTab; label: string }> = [
  { value: 'console', label: '控制台' },
  { value: 'network', label: '网络' },
  { value: 'run', label: '试跑' },
];

/** Tab 记忆：存进去的值不在候选里就回退默认，避免旧版本 / 手改 localStorage 把页面点空 */
function readTabPref<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = readViewText(name);
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * 需求文本可能超过 readViewText 的 200 字上限，所以用 JSON 偏好存（不截断）。
 * 旧版本存的是纯文本，读回时先试 JSON，再退回纯文本，升级后不至于丢已经写好的需求。
 */
const REQ_TEXT_PREF = 'ui-auto.requirement';

function readRequirementText(): string {
  const saved = readViewJson<string>(REQ_TEXT_PREF, '');
  if (typeof saved === 'string' && saved) return saved;
  return readViewText(REQ_TEXT_PREF, '');
}

/** 数字型偏好：越界 / 非数字一律回退默认 */
function readNumberPref(name: string, min: number, max: number, fallback: number): number {
  const raw = Number(readViewText(name));
  if (!Number.isFinite(raw) || raw < min) return fallback;
  return Math.min(raw, max);
}

/** 布尔型偏好：没存过就用默认值 */
function readFlagPref(name: string, fallback: boolean): boolean {
  const raw = readViewText(name);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return fallback;
}

const HEADED_OPTIONS: ReadonlyArray<SelectOption<'1' | '0'>> = [
  { value: '1', label: '有头（可围观）' },
  { value: '0', label: '无头（更快）' },
];

/**
 * 目标语言跟着项目语言走：pytest 项目、或仓库里只有 .py 用例时只出 Python；
 * 其余（Playwright TS / Selenium）默认 TypeScript，仍允许切成 Python。
 */
function projectTargets(
  framework: string,
  files: readonly string[],
): {
  options: Array<SelectOption<UiTestTarget>>;
  fallback: UiTestTarget;
} {
  const hasPy = files.some((file) => file.endsWith('.py'));
  const hasTs = files.some((file) => /\.(ts|js|mjs|cjs|tsx|jsx)$/.test(file));
  const pythonOnly = framework === 'pytest' || (hasPy && !hasTs);
  if (pythonOnly) {
    return { options: [{ value: 'python', label: 'Python' }], fallback: 'python' };
  }
  return {
    options: [
      { value: 'ts', label: 'TypeScript' },
      { value: 'python', label: 'Python' },
    ],
    fallback: 'ts',
  };
}

/** 探测回填时保留本地编辑过的描述，只接受服务端的状态 / 定位器 */
/** 计划里能编辑的动作；旧的「截图」步骤（工具动作，不是测试步骤）直接丢掉 */
const PLAN_ACTIONS = new Set([
  'goto',
  'click',
  'fill',
  'select',
  'press',
  'hover',
  'expect',
  'expectUrl',
  'wait',
]);

function normalizePlanActions(plan: UiPlanStep[]): UiPlanStep[] {
  return plan.filter((step) => PLAN_ACTIONS.has(step.action));
}

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
  return normalizePlanActions(merged);
}

/** 填充值在活动日志里打码，占位符（${ENV}）原样保留 */
function maskArgs(name: string, raw: string): string {
  if (!raw) return '';
  if (name !== 'ui_browser_fill' && name !== 'ui_browser_select') return raw.slice(0, 240);
  try {
    const args = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['text', 'value']) {
      const value = args[key];
      if (typeof value === 'string' && !value.startsWith('${')) {
        args[key] = value.replace(/[\s\S]/g, '•');
      }
    }
    return JSON.stringify(args).slice(0, 240);
  } catch {
    return raw.slice(0, 240);
  }
}

/** 写入 / 验收之后通知页面其它部分刷新（历史、变更） */
function notifyWroteFiles(count: number) {
  window.dispatchEvent(new CustomEvent('lantern:uiauto-changed', { detail: { count } }));
}

function baseName(filePath: string) {
  return filePath.split('/').pop() || filePath;
}

function dirName(filePath: string) {
  const parts = filePath.split('/');
  parts.pop();
  return parts.join('/') || '.';
}

/** 文件角色标签：写进项目后一眼看出哪个是主用例 */
function roleMeta(role: string) {
  if (role === 'page') return { label: '页面', className: 'bg-sky-50 text-sky-600' };
  if (role === 'fixture') return { label: '登录态', className: 'bg-violet-50 text-violet-600' };
  return { label: '用例', className: 'bg-emerald-50 text-emerald-600' };
}

export default function UiAutoGenerate({
  project,
  promptFile,
  onError,
}: {
  project: UiAutoProject;
  /** 该项目引用的提示词（顶栏下拉选，按项目落盘） */
  promptFile: string;
  onError?: (message: string) => void;
}) {
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  /**
   * 读提示词管理里选中的那份（规划 / 探索 / 生成代码三段）。
   * 每次规划 / 探索前重新读一次：用户改完提示词不用重开页面。
   */
  const loadPrompt = useCallback(async (): Promise<UiAutoPrompt> => {
    return fetchUiAutoPrompt(promptFile);
  }, [promptFile]);
  /**
   * 平台里所有提示词都以「提示词管理」为准，代码里的只是兜底。
   * 生成步骤 / 开始探索前必须先读到这份文件，读不到就用 toast 说明原因、不继续。
   */
  const requirePrompt = useCallback(async (): Promise<UiAutoPrompt | null> => {
    const next = await loadPrompt();
    if (!next.plan.trim() && !next.agent.trim()) {
      showToast(
        `没有读到「提示词管理」里的「${next.file || UI_AUTO_PROMPT_FILE}」。` +
          '本平台提示词以提示词管理为准，请先在「提示词管理」里写好（需包含「## 规划阶段」「## 探索阶段」）再生成。',
        'error',
      );
      return null;
    }
    return next;
  }, [loadPrompt]);
  const targetChoices = useMemo(
    () => projectTargets(project.framework, project.specFiles ?? []),
    [project.framework, project.specFiles],
  );
  const [target, setTarget] = useState<UiTestTarget>(() => {
    const { options, fallback } = projectTargets(project.framework, project.specFiles ?? []);
    const stored = readViewText(TARGET_PREF);
    return options.some((option) => option.value === stored) ? (stored as UiTestTarget) : fallback;
  });
  const [requirement, setRequirement] = useState(readRequirementText);
  /**
   * 起始地址按项目记：项目上存过就用存过的，其次用从项目配置探测到的
   * （playwright `use.baseURL` / `.env` 的 BASE_URL），最后才回落到本机上次填的值。
   * 之前是一个跨项目共用的 localStorage 键 + 写死 localhost:5173，
   * 换个项目地址串味、路径后缀（/admin）也永远带不出来。
   */
  const baseURLPrefKey = `ui-auto.baseurl.${project.id}`;
  const [baseURL, setBaseURL] = useState(
    () =>
      project.baseURL ||
      readViewText(baseURLPrefKey) ||
      project.detectedBaseURL ||
      readViewText('ui-auto.baseurl') ||
      'http://localhost:5173',
  );
  /** 项目里探测到的地址：用户没动过时用来提示「这是自动读到的」 */
  const [detectedBaseURL, setDetectedBaseURL] = useState(project.detectedBaseURL || '');
  /**
   * 登录态按项目记：项目上存过（手动填过）就用存过的，其次用项目里探测到的
   * （auth*.json / .auth/…），最后才回落到本项目上次在本机填的值。
   * 之前是一个跨项目共用的 `ui-auto.storage` 键，换项目会沿用上一个项目的
   * 登录态文件名，等于拿 A 项目的 cookie 去跑 B 项目。
   */
  const storagePrefKey = `ui-auto.storage.${project.id}`;
  const [storageState, setStorageState] = useState(
    () =>
      project.storageState || project.detectedStorageState || readViewText(storagePrefKey) || '',
  );
  const [detectedStorageState, setDetectedStorageState] = useState(
    project.detectedStorageState || '',
  );
  const [headed, setHeaded] = useState(() => readFlagPref('ui-auto.headed', true));
  /** 需求框高度：默认最小高度，拖过就记住（双击把手回默认） */
  const [reqHeight, setReqHeight] = useState(() =>
    readNumberPref(REQ_HEIGHT_PREF, REQ_MIN, REQ_MAX, DEFAULT_REQ),
  );
  const [reqDragging, setReqDragging] = useState(false);
  const reqDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  /** 地址与登录态：展开状态也记，下次进页面保持上次的样子 */
  const [addrOpen, setAddrOpen] = useState(() => readFlagPref('ui-auto.gen.address', false));
  /** 试跑面板里的「写入后验收」折叠块同样记住展开状态 */
  const [acceptOpen, setAcceptOpen] = useState(() => readFlagPref('ui-auto.gen.accept', false));
  /** 切项目 / 首屏：正在把上次的草稿捞回来，先给骨架屏，别让空态闪一下 */
  const [restoring, setRestoring] = useState(true);

  const [phase, setPhase] = useState<Phase>('idle');
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [session, setSession] = useState<UiGenSession | null>(null);
  const [plan, setPlan] = useState<UiPlanStep[]>([]);
  const [planSaving, setPlanSaving] = useState(false);
  /** 重新出码中：按钮显示进度，避免连点 */
  const [reemitting, setReemitting] = useState(false);
  const [code, setCode] = useState('');
  const [suggestedPath, setSuggestedPath] = useState('');
  /** 待写入的文件清单（spec + page object + fixture），路径可在写前改 */
  const [files, setFiles] = useState<UiEmitFile[]>([]);
  const [activePath, setActivePath] = useState(() =>
    readViewText(`ui-auto.gen.file.${project.id}`),
  );
  const [force, setForce] = useState(() => readFlagPref('ui-auto.gen.force', false));
  const [conflicts, setConflicts] = useState<string[]>([]);
  /** 左栏宽度（需求 / 步骤占满整列） */
  const [sideWidth, setSideWidth] = useState(() => {
    const raw = Number(readViewText(SIDE_PREF));
    if (!Number.isFinite(raw) || raw < SIDE_MIN) return DEFAULT_SIDE;
    return Math.min(raw, SIDE_MAX);
  });
  const sideDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [shot, setShot] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [verify, setVerify] = useState<UiVerifyResult | null>(null);
  const [round, setRound] = useState(0);
  /** 下半全宽面板：控制台 / 网络 / 试跑 */
  const [bottomTab, setBottomTab] = useState<BottomTab>(() =>
    readTabPref(
      BOTTOM_PREF,
      BOTTOM_TABS.map((item) => item.value),
      'run',
    ),
  );
  /** 上半：探索活动 / 代码 / 变更 */
  const [topTab, setTopTab] = useState<TopTab>(() =>
    readTabPref(
      TOP_PREF,
      TOP_TABS.map((item) => item.value),
      'activity',
    ),
  );
  /** 面板高度（含 Tab 行）；收起时只留 Tab 行。拖到很低也会被记住，收起按 pref 里的 closed 判断 */
  const [panelHeight, setPanelHeight] = useState(() => {
    const raw = Number(readViewText(PANEL_PREF));
    if (!Number.isFinite(raw) || raw < COLLAPSED_PANEL || raw <= PANEL_COLLAPSE_AT) {
      return DEFAULT_PANEL;
    }
    return Math.min(raw, 640);
  });
  const [panelCollapsed, setPanelCollapsed] = useState(() => readViewText(PANEL_PREF) === 'closed');
  /** 拖动时关掉高度过渡，否则跟手会顿 */
  const [panelDragging, setPanelDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [consoleLines, setConsoleLines] = useState<Array<{ type: string; text: string }>>([]);
  const [netRows, setNetRows] = useState<
    Array<{ status: number; url: string; method: string; failure?: string }>
  >([]);

  const [changes, setChanges] = useState<UiChangeEntry[]>([]);
  const [git, setGit] = useState<UiGitSummary | null>(null);
  const [draft, setDraft] = useState<UiDraftSummary | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);

  const [debugResult, setDebugResult] = useState<UiDebugResult | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [uiUrl, setUiUrl] = useState('');
  const [accept, setAccept] = useState<UiRunFileResult | null>(null);
  const [accepting, setAccepting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef('');
  const activityIdRef = useRef(0);
  const runningToolsRef = useRef<number[]>([]);
  const activityRef = useRef<HTMLDivElement | null>(null);
  const gateRef = useRef<{ promise: Promise<void>; release: () => void } | null>(null);
  const planSaveRef = useRef<number | null>(null);
  /** 计划的最新值：建会话 / 重开一轮时带上，别让新会话从空计划开始 */
  const planRef = useRef<UiPlanStep[]>([]);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let alive = true;
    void hydrateAppConfig().then(() => {
      if (alive) setSettings(loadSettings());
    });
    const off = onSettingsChanged(() => setSettings(loadSettings()));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const pushActivity = useCallback((item: Omit<ActivityItem, 'id'>) => {
    activityIdRef.current += 1;
    const id = activityIdRef.current;
    setActivity((prev) => [...prev, { ...item, id, at: item.at ?? new Date().toISOString() }]);
    return id;
  }, []);

  /**
   * 活动日志跟着会话落盘：切 Tab / 刷新 / 换项目再回来还能看到上一轮跑了什么。
   * 只在内容真的变了时才写，避免每次渲染都打一次保存请求。
   */
  const activitySaveRef = useRef<number | null>(null);
  const lastActivityJsonRef = useRef('');
  useEffect(() => {
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    const payload = activity.map(({ kind, name, detail, status, at }) => ({
      kind,
      name,
      detail,
      status,
      at,
    }));
    const json = JSON.stringify(payload);
    if (json === lastActivityJsonRef.current) return;
    lastActivityJsonRef.current = json;
    if (activitySaveRef.current) window.clearTimeout(activitySaveRef.current);
    activitySaveRef.current = window.setTimeout(() => {
      void saveGeneration({ sessionId, activity: payload }).catch(() => undefined);
    }, 600);
  }, [activity]);

  /**
   * 生成页里所有可操作项都随手记住（不等「生成步骤」）：需求、地址、登录态、
   * 有头 / 无头、覆盖开关、地址面板展开状态、选中的文件——刷新或切走再回来都还是原样。
   */
  useEffect(() => {
    writeViewJson(REQ_TEXT_PREF, requirement);
  }, [requirement]);

  useEffect(() => {
    writeViewText(baseURLPrefKey, baseURL);
    writeViewText('ui-auto.baseurl', baseURL);
  }, [baseURLPrefKey, baseURL]);

  /**
   * 地址改了要落到项目上（存在空间的项目记录里，跟着空间走）。
   * 防抖 600ms：别每敲一个字符就写盘；失焦 / 离开页面时也会补一次。
   */
  const baseURLSaveRef = useRef<number | null>(null);
  const lastBaseURLRef = useRef(baseURL);
  useEffect(() => {
    if (baseURL === lastBaseURLRef.current) return;
    lastBaseURLRef.current = baseURL;
    if (baseURLSaveRef.current) window.clearTimeout(baseURLSaveRef.current);
    baseURLSaveRef.current = window.setTimeout(() => {
      void updateProject({ id: project.id, baseURL })
        .then((next) => setDetectedBaseURL(next.detectedBaseURL || ''))
        .catch(() => undefined);
    }, 600);
  }, [baseURL, project.id]);

  useEffect(() => {
    writeViewText(storagePrefKey, storageState);
  }, [storagePrefKey, storageState]);

  /**
   * 登录态改了也落到项目上（跟地址一样按项目走）。
   * 600ms 防抖；探测到的值不自动写回，否则下次探测就永远看不到项目里的新文件。
   */
  const storageSaveRef = useRef<number | null>(null);
  const lastStorageRef = useRef(storageState);
  useEffect(() => {
    if (storageState === lastStorageRef.current) return;
    lastStorageRef.current = storageState;
    if (storageSaveRef.current) window.clearTimeout(storageSaveRef.current);
    storageSaveRef.current = window.setTimeout(() => {
      void updateProject({ id: project.id, storageState })
        .then((next) => setDetectedStorageState(next.detectedStorageState || ''))
        .catch(() => undefined);
    }, 600);
  }, [storageState, project.id]);

  useEffect(() => {
    writeViewText('ui-auto.headed', headed ? '1' : '0');
  }, [headed]);

  useEffect(() => {
    writeViewText('ui-auto.gen.force', force ? '1' : '0');
  }, [force]);

  useEffect(() => {
    writeViewText('ui-auto.gen.address', addrOpen ? '1' : '0');
  }, [addrOpen]);

  useEffect(() => {
    writeViewText('ui-auto.gen.accept', acceptOpen ? '1' : '0');
  }, [acceptOpen]);

  useEffect(() => {
    if (activePath) writeViewText(`ui-auto.gen.file.${project.id}`, activePath);
  }, [activePath, project.id]);

  /** 需求框高度也记：拖动过程中不写，松手（或双击回默认）后再落一次 */
  useEffect(() => {
    if (!reqDragging) writeViewText(REQ_HEIGHT_PREF, String(reqHeight));
  }, [reqHeight, reqDragging]);

  /** Tab 切换顺手记住：下次进生成页还停在原来那格 */
  const goTop = useCallback((next: TopTab) => {
    setTopTab(next);
    writeViewText(TOP_PREF, next);
  }, []);

  const goBottom = useCallback(
    (next: BottomTab) => {
      setBottomTab(next);
      writeViewText(BOTTOM_PREF, next);
      // 面板收起时点到 / 自动切到某个 Tab，顺手展开，别让人以为没反应
      if (panelCollapsed) {
        setPanelCollapsed(false);
        writeViewText(PANEL_PREF, String(panelHeight));
      }
    },
    [panelCollapsed, panelHeight],
  );

  /** 展开 / 收起底部面板：收起时把高度让给上半 */
  const togglePanel = useCallback(() => {
    setPanelCollapsed((prev) => {
      const next = !prev;
      writeViewText(PANEL_PREF, next ? 'closed' : String(panelHeight));
      return next;
    });
  }, [panelHeight]);

  const refreshChanges = useCallback(async () => {
    if (!sessionRef.current) {
      setChanges([]);
      setGit(null);
      setDraft(null);
      return;
    }
    setChangesLoading(true);
    try {
      const result = await fetchChanges(sessionRef.current);
      setChanges(result.changes);
      setGit(result.git);
      setDraft(result.draft);
      // 账本变了（写入 / 清理），通知页面其它部分刷新
      if (result.changes.length) notifyWroteFiles(result.changes.length);
    } catch {
      // 变更只是辅助信息，拿不到不打断主流程
    } finally {
      setChangesLoading(false);
    }
  }, []);

  /**
   * 按当前 IR 出整组文件（spec + page object + fixture）。
   * testDir 从建议路径反推，和项目自己的 playwright testDir 保持一致。
   */
  const refreshFiles = useCallback(
    async (ir: UiTestIr | null, tg: UiTestTarget, hintPath = ''): Promise<UiEmitFile[]> => {
      if (!ir?.steps?.length) {
        setFiles([]);
        return [];
      }
      try {
        const testDir = hintPath.includes('/') ? hintPath.replace(/\/[^/]+$/, '') : 'tests';
        const result = await emitGeneration(ir, tg, { testDir });
        setFiles(result.files);
        setActivePath((prev) =>
          result.files.some((file) => file.path === prev) ? prev : (result.files[0]?.path ?? ''),
        );
        return result.files;
      } catch {
        // 出码失败不打断主流程：代码 Tab 会退回只显示主文件
        return [];
      }
    },
    [],
  );

  /** 从会话重新拉 IR 再出码：试跑 / 修复后步骤变了，文件清单要跟着变 */
  const reloadFiles = useCallback(async (): Promise<UiEmitFile[]> => {
    if (!sessionRef.current) return [];
    setReemitting(true);
    try {
      const detail = await fetchGenerationSession(sessionRef.current);
      setCode(detail.code);
      setSuggestedPath(detail.suggestedPath);
      return await refreshFiles(
        detail.session.ir,
        detail.session.target === 'python' ? 'python' : 'ts',
        detail.suggestedPath,
      );
    } catch {
      // 拉不到就保持现有清单
      return [];
    } finally {
      setReemitting(false);
    }
  }, [refreshFiles]);

  // 切项目时把上一次生成的会话捞回来：计划 / 代码 / 草稿 / 变更都恢复
  useEffect(() => {
    let alive = true;
    setSession(null);
    sessionRef.current = '';
    setPlan([]);
    setCode('');
    setVerify(null);
    setAnswer('');
    setActivity([]);
    setChanges([]);
    setGit(null);
    setDraft(null);
    setDebugResult(null);
    setUiUrl('');
    setAccept(null);
    setRestoring(true);
    void fetchGenerationSessions(project.id)
      .then(async (list) => {
        if (!alive) return;
        const latest = list.sessions[0];
        // 新项目还没会话：地址 / 登录态也得重新识别一遍，
        // 不能把上一个项目填的值留在面板上（否则拿 A 的地址和 cookie 跑 B）
        if (!latest) {
          const nextBase = project.baseURL || project.detectedBaseURL || '';
          lastBaseURLRef.current = nextBase;
          setBaseURL(nextBase);
          setDetectedBaseURL(project.detectedBaseURL || '');
          const nextStorage = project.storageState || project.detectedStorageState || '';
          lastStorageRef.current = nextStorage;
          setStorageState(nextStorage);
          setDetectedStorageState(project.detectedStorageState || '');
          return;
        }
        const detail = await fetchGenerationSession(latest.id);
        if (!alive) return;
        setSession(detail.session);
        sessionRef.current = detail.session.id;
        setPlan(normalizePlanActions(detail.session.plan ?? []));
        setCode(detail.code);
        setSuggestedPath(detail.suggestedPath);
        setFiles([]);
        // 记住上次看的文件：捞回会话后优先选中它，别先跳回第一个文件
        setActivePath(readViewText(`ui-auto.gen.file.${project.id}`));
        void refreshFiles(
          detail.session.ir,
          detail.session.target === 'python' ? 'python' : 'ts',
          detail.suggestedPath,
        );
        setTarget(detail.session.target === 'python' ? 'python' : 'ts');
        // 地址 / 登录态以项目配置为准：项目上存过就用项目的（刚在面板里改的不会被
        // 旧会话顶回去）；项目没存过再回落到会话记录 / 这次重新探测到的结果
        const restoredBase =
          project.baseURL || detail.session.baseURL || project.detectedBaseURL || '';
        lastBaseURLRef.current = restoredBase;
        setBaseURL(restoredBase);
        setDetectedBaseURL(project.detectedBaseURL || '');
        const restoredStorage =
          project.storageState || detail.session.storageState || project.detectedStorageState || '';
        lastStorageRef.current = restoredStorage;
        setStorageState(restoredStorage);
        setDetectedStorageState(project.detectedStorageState || '');
        setRequirement((prev) => detail.session.source || prev);
        setDraft(detail.draft ?? null);
        setChanges(detail.changes ?? []);
        if (detail.session.lastVerify) {
          setVerify({
            passed: detail.session.lastVerify.passed,
            exitCode: detail.session.lastVerify.exitCode,
            durationMs: detail.session.lastVerify.durationMs,
            log: detail.session.lastVerify.log,
          });
        }
        // 探索活动也捞回来：上次跑到哪一步、卡在哪个工具，切走再回来还看得到
        if (Array.isArray(detail.session.activity) && detail.session.activity.length) {
          const restored = detail.session.activity.map((item) => {
            activityIdRef.current += 1;
            const status = item.status === 'running' ? 'failed' : item.status;
            return {
              id: activityIdRef.current,
              kind: (item.kind === 'tool' || item.kind === 'error' ? item.kind : 'info') as
                'tool' | 'info' | 'error',
              name: item.name,
              detail: item.detail,
              // 页面关掉时还在跑的工具不可能真的在跑：标成失败，别一直转圈
              status: status as 'running' | 'done' | 'failed',
              at: item.at,
            };
          });
          lastActivityJsonRef.current = JSON.stringify(
            restored.map(({ kind, name, detail, status, at }) => ({
              kind,
              name,
              detail,
              status,
              at,
            })),
          );
          setActivity(restored);
        }
        if (detail.session.savedPath) goTop('changes');
        setNotice('已载入上次生成的草稿');
        await refreshChanges();
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setRestoring(false);
      });
    return () => {
      alive = false;
    };
  }, [project.id, refreshChanges, refreshFiles, goTop]);

  // 目标语言必须落在项目允许的范围里：pytest / 纯 .py 仓库不能出 TypeScript
  useEffect(() => {
    const { options, fallback } = projectTargets(project.framework, project.specFiles ?? []);
    if (!options.some((option) => option.value === target)) setTarget(fallback);
  }, [project.framework, project.specFiles, target]);

  useEffect(() => {
    activityRef.current?.scrollTo({ top: activityRef.current.scrollHeight });
  }, [activity]);

  // 离开生成页：中止这一轮、结束调试进程与浏览器，别在后台空转
  useEffect(
    () => () => {
      gateRef.current?.release();
      abortRef.current?.abort();
      if (planSaveRef.current) window.clearTimeout(planSaveRef.current);
      if (sessionRef.current) {
        void stopDebug(sessionRef.current).catch(() => undefined);
        void closeBrowser(sessionRef.current).catch(() => undefined);
      }
    },
    [],
  );

  // 控制台 / 网络按需拉取，不轮询
  useEffect(() => {
    if (!session?.id) return;
    const sessionId = session.id;
    if (bottomTab === 'console') {
      void fetchConsole(sessionId)
        .then((result) => setConsoleLines(result.messages ?? []))
        .catch(() => setConsoleLines([]));
    } else if (bottomTab === 'network') {
      void fetchNetwork(sessionId)
        .then((result) => setNetRows(result.requests ?? []))
        .catch(() => setNetRows([]));
    }
  }, [bottomTab, session?.id]);

  const busy = phase !== 'idle';
  /** 停止只在真的在跑浏览器 / 试跑时才有意义：规划阶段不显示（否则「生成步骤」时旁边凭空冒一个停止） */
  const canStop = phase === 'exploring' || phase === 'verifying' || phase === 'repairing';
  /** 探索前必须已有计划：没步骤就置灰，不让人跳过计划直接乱点 */
  const exploreDisabled = busy || !requirement.trim() || !plan.length;
  /**
   * 出码前置：必须真的探索成功过一轮（拿到步骤 IR 且会话状态已推进）。
   * 只生成步骤不够——那时 IR 还是空的，旧会话里残留的 IR 也不能当作这次的产出。
   */
  const explored =
    session?.status === 'explored' ||
    session?.status === 'verified' ||
    session?.status === 'written' ||
    session?.status === 'failed';
  const emitDisabled = busy || !explored || !session?.ir?.steps?.length;

  const toolContext = useCallback(
    () => ({
      sessionId: sessionRef.current,
      target,
      onPlan: (next: UiPlanStep[]) => setPlan((prev) => mergeServerPlan(prev, next)),
      onShot: (url: string) => setShot(url),
      onCode: (nextCode: string, path: string) => {
        setCode(nextCode);
        setSuggestedPath(path);
      },
      onIr: (ir: UiTestIr) => {
        pushActivity({
          kind: 'info',
          name: '提交步骤',
          detail: `${ir.title} · ${ir.steps.length} 步`,
          status: 'done',
        });
      },
    }),
    [pushActivity, target],
  );

  const runAgentTurn = useCallback(
    async (messages: ChatMessage[], signal: AbortSignal) => {
      if (!settings) {
        openSettings('model');
        throw new Error('请先配置模型');
      }
      const ctx = toolContext();
      for await (const chunk of streamChatWithTools(settings, messages, signal, {
        tools: UI_AUTO_AGENT_TOOLS,
        maxToolRounds: 40,
        runTool: async (name, args) => {
          // 「手动登录」：停在下一个工具调用前，用户处理完验证码 / 2FA 再放行
          if (gateRef.current) await gateRef.current.promise;
          const out = await runUiAutoAgentTool(name, args, ctx);
          // 浏览器被用户关掉：这一轮已经没有意义了。抛出去结束整轮，
          // 不要把错误喂回模型 —— 否则它会一路 ui_browser_open 重试到轮次上限。
          if (isBrowserClosedOutput(out)) {
            for (const id of runningToolsRef.current.splice(0)) {
              setActivity((prev) =>
                prev.map((item) => (item.id === id ? { ...item, status: 'failed' } : item)),
              );
            }
            throw new Error(BROWSER_CLOSED_MESSAGE);
          }
          return out;
        },
      })) {
        if (chunk.type === 'tool') {
          if (chunk.status === 'running') {
            const id = pushActivity({
              kind: 'tool',
              name: chunk.name,
              detail: maskArgs(chunk.name, chunk.args ?? ''),
              status: 'running',
            });
            runningToolsRef.current.push(id);
          } else {
            const id = runningToolsRef.current.pop();
            setActivity((prev) =>
              prev.map((item) =>
                item.id === id
                  ? { ...item, status: 'done', detail: (chunk.result ?? '').slice(0, 240) }
                  : item,
              ),
            );
          }
        } else if (chunk.type === 'content') {
          setAnswer((prev) => prev + chunk.delta);
        }
      }
    },
    [pushActivity, settings, toolContext],
  );

  /**
   * 建 / 复用会话；不启动浏览器，规划阶段也能先落盘。
   * reset 表示「这一轮从头开始」：服务端会清掉上一轮的 IR / 试跑结果 / 活动日志，
   * 本地也把对应的代码、文件清单、试跑面板一起清空，免得旧内容被当成这次的产出。
   */
  const ensureSession = useCallback(
    async (reset = false) => {
      const created = await prepareGeneration({
        projectId: project.id,
        sessionId: sessionRef.current || undefined,
        title: requirement.trim().split(/\r?\n/)[0]?.slice(0, 60) || '未命名流程',
        target,
        baseURL,
        storageState,
        source: requirement.trim(),
        headed,
        reset,
        plan: planRef.current.length ? planRef.current : undefined,
      });
      sessionRef.current = created.session.id;
      setSession(created.session);
      setSuggestedPath(created.suggestedPath);
      setDraft(created.draft);
      if (reset) {
        setCode('');
        setFiles([]);
        setVerify(null);
        setChanges([]);
        setDebugResult(null);
        setAccept(null);
      }
      if (created.session.storageState) setStorageState(created.session.storageState);
      return created;
    },
    [baseURL, headed, project.id, requirement, storageState, target],
  );

  const planSteps = useCallback(
    async (text: string, signal: AbortSignal): Promise<UiPlanStep[]> => {
      if (!settings) {
        openSettings('model');
        throw new Error('请先配置模型');
      }
      const ctx = toolContext();
      // 每次规划前取一次提示词管理里的版本（平台以提示词管理为准）
      const promptNow = await loadPrompt();
      const messages: ChatMessage[] = [
        { role: 'system', content: buildUiPlanSystemPrompt(project, target, promptNow.plan) },
        { role: 'user', content: buildUiPlanUserPrompt(text, baseURL, target) },
      ];
      for await (const chunk of streamChatWithTools(settings, messages, signal, {
        tools: UI_AUTO_PLAN_TOOLS,
        maxToolRounds: 2,
        runTool: async (name, args) => runUiAutoAgentTool(name, args, ctx),
      })) {
        if (chunk.type === 'tool' && chunk.status === 'running') {
          pushActivity({
            kind: 'info',
            name: '规划步骤',
            detail: '只做测试设计，不打开浏览器',
            status: 'done',
          });
        } else if (chunk.type === 'content') {
          setAnswer((prev) => prev + chunk.delta);
        }
      }
      const detail = await fetchGenerationSession(sessionRef.current);
      const next = normalizePlanActions(detail.session.plan ?? []);
      setPlan(next);
      return next;
    },
    [baseURL, loadPrompt, project, pushActivity, settings, target, toolContext],
  );

  const onPlanSteps = useCallback(async () => {
    const text = requirement.trim();
    if (!text || busy) return;
    if (!settings) {
      setError('还没有配置模型，请先在设置里填好 API Key');
      openSettings('model');
      return;
    }
    // 平台提示词以「提示词管理」为准：读不到先拦下来，别用兜底文案悄悄跑
    if (!(await requirePrompt())) return;
    writeViewJson(REQ_TEXT_PREF, text);
    writeViewText('ui-auto.baseurl', baseURL);
    writeViewText(storagePrefKey, storageState);
    writeViewText('ui-auto.headed', headed ? '1' : '0');

    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setNotice('');
    setAnswer('');
    setPhase('planning');
    try {
      await ensureSession(true);
      const steps = await planSteps(text, controller.signal);
      setNotice(
        steps.length
          ? `已生成 ${steps.length} 步计划，可以手动调整后再探索`
          : '没有得到步骤，补充需求后再试',
      );
    } catch (err) {
      if (controller.signal.aborted) setNotice('已停止');
      else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        onError?.(message);
        pushActivity({ kind: 'error', name: '规划失败', detail: message, status: 'failed' });
      }
    } finally {
      abortRef.current = null;
      setPhase('idle');
    }
  }, [
    baseURL,
    busy,
    ensureSession,
    headed,
    onError,
    planSteps,
    pushActivity,
    requirePrompt,
    requirement,
    settings,
    storageState,
  ]);

  const runVerifyLoop = useCallback(
    async (messages: ChatMessage[], signal: AbortSignal) => {
      let base = messages;
      for (let attempt = 0; attempt <= MAX_REPAIR_ROUNDS; attempt += 1) {
        setRound(attempt);
        setPhase('verifying');
        goBottom('run');
        const activityId = pushActivity({
          kind: 'info',
          name: attempt ? `第 ${attempt} 次修复后试跑` : '试跑',
          detail: '写进 .lantern-ai 草稿并执行，失败保留现场',
          status: 'running',
        });
        const result = await verifyGeneration(sessionRef.current);
        setVerify(result);
        setDebugResult(null);
        if (typeof result.code === 'string') setCode(result.code);
        setActivity((prev) =>
          prev.map((item) =>
            item.id === activityId
              ? {
                  ...item,
                  status: result.passed ? 'done' : 'failed',
                  detail: result.passed
                    ? `通过 · ${Math.round((result.durationMs ?? 0) / 100) / 10}s`
                    : (result.log ?? result.error ?? '').slice(-800),
                }
              : item,
          ),
        );
        void refreshChanges();
        void reloadFiles();
        if (result.passed) {
          pushActivity({
            kind: 'info',
            name: '试跑通过',
            detail: `${Math.round((result.durationMs ?? 0) / 100) / 10}s · 草稿在 ${result.draftPath ?? ''}`,
            status: 'done',
          });
          setNotice('试跑通过，可以打开草稿 / trace 调试，确认后写入项目');
          setSession((prev) => (prev ? { ...prev, status: 'verified' } : prev));
          setPhase('idle');
          return true;
        }
        if (attempt === MAX_REPAIR_ROUNDS) break;
        setPhase('repairing');
        base = [
          ...base,
          {
            role: 'user',
            content: [
              `第 ${attempt + 1} 次试跑失败（exitCode=${result.exitCode ?? '?'}）。日志尾部：`,
              '```',
              (result.log ?? result.error ?? '').slice(-3500),
              '```',
              '请先调用 ui_test_get_steps 看当前步骤，只修改步骤 IR（定位器 / 等待 / 断言），再 ui_test_verify 重跑。',
              '如果是页面行为本身不符合需求，不要为了跑绿改断言，直接在回答里说明疑似缺陷。',
            ].join('\n'),
          },
        ];
        await runAgentTurn(base, signal);
      }
      setNotice(`自动修复 ${MAX_REPAIR_ROUNDS} 轮仍未通过，请看试跑日志 / 打开 trace`);
      setPhase('idle');
      return false;
    },
    [goBottom, pushActivity, refreshChanges, reloadFiles, runAgentTurn],
  );

  const onGenerate = useCallback(async () => {
    const text = requirement.trim();
    if (!text || busy) return;
    if (!settings) {
      setError('还没有配置模型，请先在设置里填好 API Key');
      openSettings('model');
      return;
    }
    // 同「生成步骤」：先确认提示词管理里那份文件可用
    if (!(await requirePrompt())) return;
    writeViewJson(REQ_TEXT_PREF, text);
    writeViewText('ui-auto.baseurl', baseURL);
    writeViewText(storagePrefKey, storageState);
    writeViewText('ui-auto.headed', headed ? '1' : '0');

    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setNotice('');
    setCode('');
    setVerify(null);
    setShot('');
    // 活动日志不清空：它是按时间累积的运行记录，清不清由「清除活动日志」决定
    setRound(0);
    setFiles([]);
    setConflicts([]);
    setAccept(null);
    setDebugResult(null);
    setUiUrl('');
    // 探索说明接在规划说明后面：规划阶段那段「## 测试思路」别因为点了开始探索就消失
    setAnswer((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n---\n\n` : prev));
    // 探索期间看活动流；代码页只在用户点「生成代码」时进入
    goTop('activity');
    setPhase('exploring');
    let startedId = '';

    try {
      const started = await ensureSession(true);
      startedId = started.session.id;
      pushActivity({
        kind: 'info',
        name: '探索开始',
        detail: `${headed ? '有头' : '无头'}浏览器 · ${project.name}`,
        status: 'done',
      });

      // 没有计划就先规划一遍：用户直接点「开始探索」也能跑
      let activePlan = plan;
      if (!activePlan.length) {
        pushActivity({
          kind: 'info',
          name: '先规划步骤',
          detail: '还没有计划，先做一次测试设计',
          status: 'done',
        });
        activePlan = await planSteps(text, controller.signal);
      }
      if (!activePlan.length) {
        setNotice('没有得到步骤计划，请补充需求后重试');
        setPhase('idle');
        return;
      }
      // 客户端这份就是用户看到的计划，直接落盘（不合并，删掉的步骤别被复活）
      await saveGeneration({ sessionId: started.session.id, plan: activePlan });

      // 探索前再取一次：规划阶段用户可能刚改过提示词
      const promptNow = await loadPrompt();
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: buildUiAgentSystemPrompt(
            project,
            target,
            activePlan,
            promptNow.agent,
            promptNow.code,
          ),
        },
        { role: 'user', content: buildUiAgentUserPrompt(text, baseURL, target, activePlan) },
      ];
      await runAgentTurn(messages, controller.signal);
      const detail = await fetchGenerationSession(started.session.id);
      if (detail.code) {
        setCode(detail.code);
        setSuggestedPath(detail.suggestedPath);
      }
      setPlan((prev) => mergeServerPlan(prev, detail.session.plan ?? []));
      const steps = detail.session.ir?.steps?.length ?? 0;
      if (!steps) {
        pushActivity({
          kind: 'error',
          name: '没有提交步骤',
          detail: '探索结束了，但这轮没有可用的步骤 IR，代码与试跑保持为空',
          status: 'failed',
        });
        setNotice('AI 没有提交步骤，请补充需求后重试');
        await saveGeneration({ sessionId: started.session.id, status: 'draft' }).catch(
          () => undefined,
        );
        return;
      }
      // 探索结束 = 拿到步骤 IR，接着按 IR 出码；试跑是下一步手动动作，不再自动跑
      const emittedFiles = await refreshFiles(detail.session.ir, target, detail.suggestedPath);
      pushActivity({
        kind: 'info',
        name: '生成代码',
        detail: emittedFiles.length
          ? `按步骤出了 ${emittedFiles.length} 个文件（用例 / 页面对象 / 登录态）`
          : '步骤已就绪，代码页可点「重新出码」',
        status: 'done',
      });
      // 落一个明确状态：下次打开是「已探索」，不再显示成探索中
      await saveGeneration({ sessionId: started.session.id, status: 'explored' }).catch(
        () => undefined,
      );
      // 会话里的 IR / 草稿要同步回本地：否则「生成代码」「试跑」还按旧状态判成不可用
      setSession({ ...detail.session, status: 'explored' });
      setDraft(detail.draft ?? null);
      setChanges(detail.changes ?? []);
      setNotice('探索完成，可以点「生成代码」出码；出码后会进入代码页');
    } catch (err) {
      if (controller.signal.aborted) {
        setNotice('已停止');
      } else if (err instanceof Error && err.message === BROWSER_CLOSED_MESSAGE) {
        // 用户自己关掉了浏览器：这是主动结束，不弹红色错误；会话回草稿，日志留痕
        setNotice('浏览器已关闭，这一轮探索结束；重新点「开始探索」会新开一个浏览器');
        pushActivity({
          kind: 'error',
          name: '浏览器已关闭',
          detail: '窗口被关闭，AI 停止操作；已提交的步骤与计划保留',
          status: 'failed',
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        onError?.(message);
        pushActivity({ kind: 'error', name: '生成中断', detail: message, status: 'failed' });
      }
      // 中断 / 失败都回到草稿：别让会话永远停在「探索中」
      if (startedId) {
        await saveGeneration({ sessionId: startedId, status: 'draft' }).catch(() => undefined);
      }
    } finally {
      gateRef.current?.release();
      gateRef.current = null;
      setPaused(false);
      abortRef.current = null;
      setPhase('idle');
      void refreshChanges();
    }
  }, [
    baseURL,
    busy,
    ensureSession,
    goTop,
    headed,
    loadPrompt,
    onError,
    plan,
    planSteps,
    project,
    pushActivity,
    refreshChanges,
    refreshFiles,
    requirePrompt,
    requirement,
    runAgentTurn,
    settings,
    storageState,
    target,
  ]);

  const onStop = useCallback(() => {
    gateRef.current?.release();
    gateRef.current = null;
    setPaused(false);
    abortRef.current?.abort();
    if (sessionRef.current) {
      void stopDebug(sessionRef.current).catch(() => undefined);
      void closeBrowser(sessionRef.current).catch(() => undefined);
    }
  }, []);

  /** 手动登录：第一次点暂停在下一个工具调用前，第二次点放行 */
  const onTogglePause = useCallback(() => {
    if (gateRef.current) {
      gateRef.current.release();
      gateRef.current = null;
      setPaused(false);
      pushActivity({
        kind: 'info',
        name: '继续探索',
        detail: '已手动完成登录 / 验证码',
        status: 'done',
      });
      return;
    }
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gateRef.current = { promise, release };
    setPaused(true);
    pushActivity({
      kind: 'info',
      name: '暂停',
      detail: '请在打开的浏览器窗口里完成登录，完成后点「我已登录，继续」',
      status: 'running',
    });
  }, [pushActivity]);

  /** 记住上一次落盘的步骤数：增 / 删视为结构变化，不用等防抖 */
  const savedPlanLenRef = useRef(plan.length);
  useEffect(() => {
    savedPlanLenRef.current = plan.length;
  }, [plan.length]);

  /**
   * 计划改动：本地立即生效。
   * - 改文字：400ms 防抖，别每敲一个字写一次盘
   * - 增 / 删 / 排序：立刻落盘。之前删完马上刷新会被 400ms 防抖吞掉，
   *   重新进页面又按服务端旧计划恢复，看起来就像「删了又自己回来」
   */
  const onPlanChange = useCallback((next: UiPlanStep[]) => {
    setPlan(next);
    if (!sessionRef.current) return;
    const structural = next.length !== savedPlanLenRef.current;
    savedPlanLenRef.current = next.length;
    if (structural) {
      // 刷新缓存里是上一版计划：不清掉的话刷新会先闪一版「已经删掉的步骤」
      clearHydrateCache('ui-auto');
    }
    const push = () => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      setPlanSaving(true);
      void saveGeneration({
        sessionId,
        plan: next,
        // 用户亲手删到空是合法的；其它路径的空计划由服务端挡掉
        allowEmptyPlan: true,
      })
        .catch(() => undefined)
        .finally(() => setPlanSaving(false));
    };
    if (planSaveRef.current) window.clearTimeout(planSaveRef.current);
    if (structural) {
      push();
      return;
    }
    planSaveRef.current = window.setTimeout(push, 400);
  }, []);

  /** 待写入清单：出码失败时退回「只有主文件」也能写 */
  const writeFiles = useMemo<UiEmitFile[]>(() => {
    if (files.length) return files;
    if (!code) return [];
    return [
      {
        path:
          suggestedPath ||
          (target === 'python' ? 'tests/test_ai_generated.py' : 'tests/ai-generated.spec.ts'),
        content: code,
        language: target,
        role: 'spec',
      },
    ];
  }, [code, files, suggestedPath, target]);

  const activeFile = useMemo(
    () => writeFiles.find((file) => file.path === activePath) ?? writeFiles[0] ?? null,
    [activePath, writeFiles],
  );

  const onEditFilePath = useCallback((from: string, to: string) => {
    setFiles((prev) => prev.map((file) => (file.path === from ? { ...file, path: to } : file)));
    setActivePath(to);
  }, []);

  const onWrite = useCallback(async () => {
    if (!sessionRef.current || !writeFiles.length) return;
    setError('');
    setConflicts([]);
    try {
      const result = await writeGeneration({
        sessionId: sessionRef.current,
        files: writeFiles.map((file) => ({
          path: file.path,
          content: file.content,
          role: file.role,
        })),
        force,
      });
      if (!result.ok) {
        setError(result.error ?? '写入失败');
        setConflicts((result.conflicts ?? []).map((item) => item.path));
        return;
      }
      const count = result.savedPaths?.length ?? result.paths?.length ?? 1;
      const merged = result.summary?.merged ?? 0;
      const created = result.summary?.created ?? 0;
      const unchanged = result.summary?.unchanged ?? 0;
      const detail = [
        created ? `新建 ${created}` : '',
        merged ? `合并 ${merged}` : '',
        unchanged ? `无变化 ${unchanged}` : '',
      ]
        .filter(Boolean)
        .join('、');
      setNotice(
        `已写入 ${count} 个文件${detail ? `（${detail}）` : ''}${
          result.path ? `，主用例 ${result.path}` : ''
        }，可以按项目配置验收`,
      );
      setSession((prev) =>
        prev
          ? { ...prev, status: 'written', savedPath: result.path, savedPaths: result.savedPaths }
          : prev,
      );
      setForce(false);
      await refreshChanges();
      goTop('changes');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [force, goTop, refreshChanges, writeFiles]);

  const onAccept = useCallback(async () => {
    if (!sessionRef.current || accepting) return;
    setAccepting(true);
    setError('');
    setAccept(null);
    try {
      const result = await runProjectFile(
        sessionRef.current,
        session?.savedPath ||
          writeFiles.find((file) => file.role === 'spec')?.path ||
          suggestedPath,
      );
      setAccept(result);
      pushActivity({
        kind: 'info',
        name: '按项目配置验收',
        detail: result.ok
          ? result.passed
            ? '通过'
            : result.excluded
              ? '被 testMatch 排除，没跑起来'
              : `失败（exit ${result.exitCode ?? '?'}）`
          : (result.error ?? '失败'),
        status: result.ok && result.passed ? 'done' : 'failed',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccepting(false);
    }
  }, [accepting, pushActivity, session?.savedPath, suggestedPath, writeFiles]);

  /**
   * 试跑：在 .lantern-ai 草稿里跑当前步骤。
   * 失败了让模型修步骤（最多 MAX_REPAIR_ROUNDS 轮）；没配模型就只跑一次、把日志留给用户。
   */
  const onVerify = useCallback(async () => {
    if (!sessionRef.current || phase !== 'idle') return;
    if (!session?.ir?.steps?.length) {
      setError('还没有步骤，先「开始探索」把流程跑一遍');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    try {
      if (!settings) {
        setPhase('verifying');
        goBottom('run');
        const activityId = pushActivity({
          kind: 'info',
          name: '试跑',
          detail: '在 .lantern-ai 草稿里执行（未配置模型，不做自动修复）',
          status: 'running',
        });
        const result = await verifyGeneration(sessionRef.current);
        setVerify(result);
        setDebugResult(null);
        if (typeof result.code === 'string') setCode(result.code);
        setActivity((prev) =>
          prev.map((item) =>
            item.id === activityId
              ? {
                  ...item,
                  status: result.passed ? 'done' : 'failed',
                  detail: result.passed
                    ? `通过 · ${Math.round((result.durationMs ?? 0) / 100) / 10}s`
                    : (result.log ?? result.error ?? '').slice(-800),
                }
              : item,
          ),
        );
        setNotice(result.passed ? '试跑通过' : '试跑失败，草稿与 trace 已保留');
        await refreshChanges();
        await reloadFiles();
        return;
      }
      // 有模型：跑一遍，失败时按日志改步骤再跑，最多 3 轮
      const promptNow = await loadPrompt();
      const base: ChatMessage[] = [
        {
          role: 'system',
          content: buildUiAgentSystemPrompt(project, target, plan, promptNow.agent, promptNow.code),
        },
        {
          role: 'user',
          content: buildUiAgentUserPrompt(
            requirement.trim() || session?.source || '',
            baseURL,
            target,
            plan,
          ),
        },
      ];
      await runVerifyLoop(base, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) setNotice('已停止');
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
      setPhase('idle');
      // 试跑结果由服务端落盘（verified / failed），把本地状态对齐，别一直显示「已探索」
      const id = sessionRef.current;
      if (id) {
        void fetchGenerationSession(id)
          .then((detail) => setSession(detail.session))
          .catch(() => undefined);
      }
    }
  }, [
    baseURL,
    goBottom,
    loadPrompt,
    phase,
    plan,
    project,
    pushActivity,
    refreshChanges,
    reloadFiles,
    requirement,
    runVerifyLoop,
    session?.ir?.steps?.length,
    session?.source,
    settings,
    target,
  ]);

  const onDebug = useCallback(
    async (mode: 'headed' | 'ui') => {
      if (!sessionRef.current || debugBusy) return;
      setDebugBusy(true);
      setError('');
      try {
        const result = await debugGeneration(sessionRef.current, mode);
        setDebugResult(result);
        if (result.url) setUiUrl(result.url);
        if (!result.ok) setError(result.error ?? '调试启动失败');
        else if (mode === 'headed' && typeof result.tracePath === 'string' && result.tracePath) {
          setDraft((prev) => (prev ? { ...prev, tracePath: result.tracePath ?? '' } : prev));
        }
        pushActivity({
          kind: 'info',
          name: mode === 'ui' ? 'Playwright UI' : '调试运行',
          detail: result.ok
            ? result.url || `exit ${result.exitCode ?? '?'} · ${result.tracePath || '无 trace'}`
            : (result.error ?? '失败'),
          status: result.ok && result.passed !== false ? 'done' : 'failed',
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDebugBusy(false);
      }
    },
    [debugBusy, pushActivity],
  );

  const onStopUi = useCallback(async () => {
    if (!sessionRef.current) return;
    await stopDebug(sessionRef.current).catch(() => undefined);
    setUiUrl('');
    setDebugResult(null);
  }, []);

  /** 生成代码：按当前步骤重新出码并切到代码 Tab（探索完也会自动出一次，这里用于手动重出） */
  const onEmitCode = useCallback(async () => {
    if (busy || !sessionRef.current) return;
    setError('');
    const filesNow = await reloadFiles();
    goTop('code');
    setNotice(
      filesNow.length
        ? `已生成 ${filesNow.length} 个文件，确认后到「试跑」里执行`
        : '当前没有可出码的步骤，先「开始探索」把流程跑一遍',
    );
  }, [busy, goTop, reloadFiles]);

  const onReveal = useCallback(async (path: string) => {
    if (!sessionRef.current) return;
    try {
      await revealPath({ sessionId: sessionRef.current, path });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onClean = useCallback(async () => {
    if (!sessionRef.current) return;
    setDebugBusy(true);
    try {
      const result = await cleanDraft(sessionRef.current);
      setDraft(result.draft);
      setDebugResult(null);
      setVerify(null);
      setUiUrl('');
      setNotice('草稿已清理');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDebugBusy(false);
    }
  }, []);

  const onSwitchTarget = useCallback(
    async (next: UiTestTarget) => {
      setTarget(next);
      writeViewText(TARGET_PREF, next);
      if (!sessionRef.current) return;
      try {
        const saved = await saveGeneration({ sessionId: sessionRef.current, target: next });
        setCode(saved.code);
        setSuggestedPath(saved.suggestedPath);
        await refreshFiles(session?.ir ?? null, next, saved.suggestedPath);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshFiles, session?.ir],
  );

  const onCopy = useCallback(() => {
    const text = activeFile?.content ?? code;
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => setNotice('已复制当前文件'))
      .catch(() => setError('复制失败，请手动选中'));
  }, [activeFile?.content, code]);

  const phaseText = useMemo(() => {
    if (paused) return '已暂停：请在浏览器窗口里完成登录，然后点「我已登录，继续」';
    if (phase === 'planning') return 'AI 正在拆解步骤计划…';
    if (phase === 'exploring') return 'AI 正在操作浏览器…';
    if (phase === 'verifying') return '正在草稿里试跑生成的脚本…';
    if (phase === 'repairing') return `试跑失败，正在修复（第 ${round} 轮）…`;
    return '';
  }, [paused, phase, round]);

  /** 哪个动作正在跑：只给对应按钮加转圈，别让三个按钮一起闪成禁用态 */
  const planRunning = phase === 'planning';
  const emitRunning = reemitting;

  const statusText = session
    ? session.status === 'verified'
      ? '试跑通过'
      : session.status === 'written'
        ? '已写入项目'
        : session.status === 'explored'
          ? '已探索'
          : session.status === 'failed'
            ? '试跑失败'
            : '草稿'
    : '';
  const tracePath = debugResult?.tracePath || draft?.tracePath || verify?.tracePath || '';
  const draftPath = debugResult?.draftPath || verify?.draftPath || '';
  /** 有 IR 就能生成草稿并调试，不必等第一次试跑 */
  const canDebug = Boolean(draft?.hasSteps || (session?.ir?.steps?.length ?? 0));

  return (
    // 捞草稿期间挂 busy：有刷新缓存时让缓存继续占位，别先闪一版默认内容
    <div
      className="flex min-h-0 flex-1 overflow-hidden bg-stone-50/40"
      aria-busy={restoring ? 'true' : undefined}
    >
      {/* 左：需求 + 步骤计划占满整列全高 */}
      <aside
        className="flex min-h-0 min-w-0 shrink-0 flex-col gap-2 overflow-hidden bg-white px-2.5 py-2"
        style={{ width: sideWidth }}
      >
        {/* 需求框高度是「上限」：空间不够时先让这一格收窄，步骤计划不会被挤没 */}
        <div className="flex min-h-[104px] shrink flex-col">
          <div className="mb-1 flex items-center">
            <label htmlFor="ui-gen-req" className="text-xs font-medium text-stone-600">
              需求 / 步骤
            </label>
          </div>
          {/* 高度由下方把手控制：包一层定高 + overflow-hidden，textarea 永远不会压到下面的控件 */}
          <div
            className={`min-h-0 flex-1 overflow-hidden rounded-lg border border-stone-200 bg-white transition-colors focus-within:border-[#3370ff] ${
              reqDragging ? '' : 'transition-[height] duration-150'
            }`}
            style={{ flexBasis: reqHeight }}
          >
            <textarea
              id="ui-gen-req"
              className="block h-full w-full resize-none bg-transparent px-2.5 py-2 text-xs leading-relaxed text-stone-700 outline-none"
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              placeholder="例：登录后进入商品列表，把第一个商品加入购物车，断言购物车出现该商品"
              spellCheck={false}
            />
          </div>
          {/* 拖动改高度：只在这条 8px 的把手上响应，不挡文字选择 */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整需求框高度"
            title="拖动调整高度，双击恢复默认"
            className="group mt-1 flex h-2 cursor-row-resize touch-none items-center justify-center"
            onPointerDown={(event) => {
              reqDragRef.current = { startY: event.clientY, startHeight: reqHeight };
              setReqDragging(true);
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = reqDragRef.current;
              if (!drag) return;
              const max = Math.max(
                REQ_MIN,
                Math.min(REQ_MAX, Math.round(window.innerHeight * 0.45)),
              );
              setReqHeight(
                Math.min(max, Math.max(REQ_MIN, drag.startHeight + (event.clientY - drag.startY))),
              );
            }}
            onPointerUp={(event) => {
              if (!reqDragRef.current) return;
              reqDragRef.current = null;
              setReqDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onDoubleClick={() => setReqHeight(DEFAULT_REQ)}
            onPointerCancel={() => {
              reqDragRef.current = null;
              setReqDragging(false);
            }}
          >
            <span
              className={`h-[3px] w-8 rounded-full transition-colors ${
                reqDragging ? 'bg-[#4176e6]/70' : 'bg-stone-200 group-hover:bg-[#4176e6]/50'
              }`}
            />
          </div>
        </div>

        {/* 语言 / 浏览器：和页面其它下拉统一用组件，别混原生 select */}
        <div className="grid shrink-0 grid-cols-2 gap-2">
          <div className="min-w-0">
            <span className="mb-1 block text-[11px] text-stone-500">目标语言</span>
            <SelectDropdown
              options={targetChoices.options}
              value={target}
              onChange={(next) => void onSwitchTarget(next)}
              compact
              ariaLabel="目标语言"
              className="w-full"
            />
          </div>
          <div className="min-w-0">
            <span className="mb-1 block text-[11px] text-stone-500">浏览器</span>
            <SelectDropdown
              options={HEADED_OPTIONS}
              value={headed ? '1' : '0'}
              onChange={(next) => setHeaded(next === '1')}
              compact
              ariaLabel="浏览器"
              className="w-full"
            />
          </div>
        </div>

        <details
          className="shrink-0 rounded-lg border border-stone-200 px-2 py-1.5"
          open={addrOpen}
          onToggle={(event) => setAddrOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer list-none text-[11px] text-stone-500">
            地址与登录态
          </summary>
          <div className="mt-2 space-y-2">
            <input
              id="ui-gen-base"
              className={`${INPUT} font-mono`}
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              placeholder="http://localhost:5173"
              spellCheck={false}
              aria-label="起始地址"
            />
            {/* 地址按项目记住：项目配置里读到的（playwright use.baseURL / .env）和当前不一致时
                给一个一键回填，省得每次手敲；有 /admin 这类路由后缀也能被记下来 */}
            {detectedBaseURL ? (
              <p className="text-[10px] leading-4 text-stone-400">
                项目配置里读到：
                <button
                  type="button"
                  className="ml-1 font-mono text-[#3370ff] hover:underline"
                  onClick={() => setBaseURL(detectedBaseURL)}
                  disabled={baseURL === detectedBaseURL}
                >
                  {detectedBaseURL}
                </button>
              </p>
            ) : null}
            <input
              id="ui-gen-storage"
              className={`${INPUT} font-mono`}
              value={storageState}
              onChange={(event) => setStorageState(event.target.value)}
              placeholder="登录态文件，留空自动检测；填 - 不用"
              spellCheck={false}
              aria-label="登录态文件"
            />
            {/* 登录态也按项目识别：探测到的文件名字不一致时给一键回填；
                一个都没找到就说明白「这次是未登录身份跑」，别让人以为已经登录了 */}
            {detectedStorageState ? (
              <p className="text-[10px] leading-4 text-stone-400">
                项目里找到：
                <button
                  type="button"
                  className="ml-1 font-mono text-[#3370ff] hover:underline"
                  onClick={() => setStorageState(detectedStorageState)}
                  disabled={storageState === detectedStorageState}
                >
                  {detectedStorageState}
                </button>
              </p>
            ) : storageState === '-' ? (
              <p className="text-[10px] leading-4 text-stone-400">按未登录身份跑，不加载 cookie</p>
            ) : storageState ? (
              <p className="text-[10px] leading-4 text-stone-400">
                项目里没找到这个文件，跑之前会再确认一次；找不到就按未登录身份跑
              </p>
            ) : (
              <p className="text-[10px] leading-4 text-stone-400">
                项目里没找到登录态文件：会以未登录身份打开，探索中可以点「手动登录」
              </p>
            )}
          </div>
        </details>

        {/*
          动作条固定两段：左边「生成步骤 / 生成代码」分段按钮，右边主操作。
          运行中主操作原地变「停止」，不额外插按钮 —— 之前点一下整行会换行、
          兄弟按钮跟着位移，看着像"抖了一下"。「手动登录」挪到下面的状态行，
          只在真开着浏览器时才出现，不再挤占这条动作条。
        */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="inline-flex h-8 items-center rounded-lg border border-stone-200 bg-white p-0.5">
            <button
              type="button"
              className={planRunning ? SEG_RUNNING : SEG_BTN}
              onClick={() => void onPlanSteps()}
              disabled={busy || !requirement.trim()}
              aria-busy={planRunning || undefined}
            >
              {planRunning ? <Spinner /> : <Icon name="steps" />}
              <span className="min-w-[52px] text-center">
                {planRunning ? '规划中…' : '生成步骤'}
              </span>
            </button>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-stone-200" aria-hidden="true" />
            <button
              type="button"
              className={emitRunning ? SEG_RUNNING : SEG_BTN}
              onClick={() => void onEmitCode()}
              disabled={emitDisabled}
              aria-busy={emitRunning || undefined}
            >
              {emitRunning ? <Spinner /> : <Icon name="code" />}
              <span className="min-w-[52px] text-center">
                {emitRunning ? '出码中…' : '生成代码'}
              </span>
            </button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/*
              主按钮原地切换：只在真的在跑浏览器 / 试跑时变「停止」。
              这样「生成步骤」阶段不会冒出停止按钮，宽度也不变（同一 min-w），
              不用额外塞一个按钮把 300 多 px 的动作条挤爆。
            */}
            <button
              type="button"
              className={`${canStop ? BTN_STOP : BTN_PRIMARY} min-w-[104px] justify-center`}
              onClick={() => (canStop ? onStop() : void onGenerate())}
              disabled={!canStop && exploreDisabled}
              aria-busy={canStop || undefined}
            >
              {canStop ? (
                <>
                  <Spinner />
                  停止
                </>
              ) : (
                <>
                  <Icon name="play" />
                  开始探索
                </>
              )}
            </button>
          </div>
        </div>

        {!plan.length && !busy && !restoring ? (
          <p className="shrink-0 text-[11px] leading-relaxed text-stone-400">
            先「生成步骤」，确认计划后就能开始探索
          </p>
        ) : null}
        {/* 状态 / 错误 / 提示都收在一个限高滚动块里：长错误日志再多也不会把步骤计划挤出视口 */}
        <div className="max-h-[96px] shrink-0 space-y-1 overflow-y-auto">
          {phaseText || planSaving || (phase === 'exploring' && headed) ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {phaseText ? <p className="text-[11px] text-[#4176e6]">{phaseText}</p> : null}
              {planSaving ? <p className="text-[10px] text-stone-400">保存中…</p> : null}
              {/* 手动登录只在真开着浏览器时才有意义：规划阶段没有窗口可以操作。
                  放在状态行里（不再占动作条），点它不会挤动右侧按钮。 */}
              {phase === 'exploring' && headed ? (
                <button
                  type="button"
                  className="text-[11px] font-medium text-[#4176e6] underline-offset-2 hover:underline"
                  onClick={onTogglePause}
                >
                  {paused ? '我已登录，继续' : '手动登录'}
                </button>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed break-words text-red-600">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-[11px] leading-relaxed break-words text-emerald-700">
              {notice}
            </p>
          ) : null}
        </div>

        {/* 步骤计划保底高度：上面各种状态行再长，也至少留这么多给计划本身 */}
        <div className="flex min-h-[150px] min-w-0 flex-1 flex-col">
          {restoring ? (
            <StepsSkeleton />
          ) : (
            <UiAutoSteps plan={plan} disabled={busy} onChange={onPlanChange} />
          )}
        </div>
      </aside>

      {/* 左右宽度可拖：需求区 300–560px */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左栏宽度"
        className="w-1 shrink-0 cursor-col-resize touch-none bg-stone-200/70 transition-colors hover:bg-[#4176e6]/40"
        onPointerDown={(event) => {
          sideDragRef.current = { startX: event.clientX, startWidth: sideWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = sideDragRef.current;
          if (!drag) return;
          setSideWidth(
            Math.min(SIDE_MAX, Math.max(SIDE_MIN, drag.startWidth + (event.clientX - drag.startX))),
          );
        }}
        onPointerUp={(event) => {
          if (!sideDragRef.current) return;
          sideDragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          writeViewText(SIDE_PREF, String(sideWidth));
        }}
        onPointerCancel={() => {
          sideDragRef.current = null;
        }}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 上：探索活动 / 代码 / 变更 + 最近一步截图 */}
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stone-100 px-3">
            {TOP_TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  topTab === item.value
                    ? 'bg-[#f2f6ff] text-[#3370ff]'
                    : 'text-stone-500 hover:bg-stone-50'
                }`}
                onClick={() => goTop(item.value)}
              >
                {item.value === 'changes' && changes.length
                  ? `${item.label} ${changes.length}`
                  : item.label}
              </button>
            ))}
            <div className="ml-auto flex min-w-0 shrink items-center gap-2">
              {/* 活动日志默认一直累积（含上一轮），怕撑内存就手动清一次 */}
              {topTab === 'activity' && activity.length ? (
                <button
                  type="button"
                  className="shrink-0 text-[10px] text-stone-400 transition-colors hover:text-red-500"
                  onClick={() => {
                    setActivity([]);
                    // 服务端默认按时间合并，显式清空要单独标一下，否则下次保存又长回来
                    if (sessionRef.current) {
                      void saveGeneration({
                        sessionId: sessionRef.current,
                        activity: [],
                        replaceActivity: true,
                      }).catch(() => undefined);
                    }
                  }}
                >
                  清除活动日志
                </button>
              ) : null}
              {session ? (
                <span className="flex min-w-0 items-center gap-1 text-[10px] text-stone-400">
                  <span className="shrink-0">会话</span>
                  <span className="truncate font-mono">{session.id}</span>
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {topTab === 'activity' ? (
              <div ref={activityRef} className="min-h-0 flex-1 overflow-auto px-3 py-2">
                {restoring ? (
                  <PaneSkeleton rows={4} />
                ) : (
                  <>
                    {activity.length === 0 ? (
                      <p className="py-6 text-center text-xs leading-relaxed text-stone-400">
                        生成时这里会显示每一步操作与探测结果
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {activity.map((item) => (
                          <li key={item.id} className="text-[11px] leading-relaxed">
                            <div className="flex items-start gap-1.5">
                              <span
                                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                                  item.status === 'running'
                                    ? 'animate-pulse bg-[#4176e6]'
                                    : item.status === 'failed'
                                      ? 'bg-red-500'
                                      : 'bg-emerald-500'
                                }`}
                              />
                              <div className="min-w-0 flex-1">
                                <span className="font-mono text-stone-700">{item.name}</span>
                                {item.detail ? (
                                  <pre className="mt-0.5 max-h-24 overflow-hidden whitespace-pre-wrap break-all text-[11px] text-stone-400">
                                    {item.detail}
                                  </pre>
                                ) : null}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {answer ? (
                      <div
                        className="chat-md prose prose-sm prose-stone mt-3 max-w-none border-t border-stone-100 pt-2 text-stone-600"
                        style={{ fontSize: 11, lineHeight: 1.7 }}
                        onClick={(event) => {
                          // 代码块的「复制」按钮由 renderMarkdown 生成，这里做事件委托
                          const target = event.target as HTMLElement;
                          if (!target.closest('[data-copy-code]')) return;
                          const code = target.closest('.code-block')?.querySelector('code');
                          if (!code) return;
                          void navigator.clipboard?.writeText(code.textContent ?? '').then(
                            () => showToast('已复制', 'success'),
                            () => showToast('复制失败', 'error'),
                          );
                        }}
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(answer) }}
                      />
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            {topTab === 'code' ? (
              restoring ? (
                <PaneSkeleton rows={5} />
              ) : writeFiles.length ? (
                <div className="flex min-h-0 flex-1">
                  {/* 文件清单：主用例 / 页面对象 / 登录态 */}
                  <div className="flex w-56 shrink-0 flex-col border-r border-stone-100">
                    <div className="flex shrink-0 items-center gap-2 border-b border-stone-100 px-2.5 py-1.5">
                      <span className="text-[11px] font-medium text-stone-600">
                        待写入 {writeFiles.length} 个文件
                      </span>
                      <button
                        type="button"
                        className="ml-auto rounded px-1 text-[11px] text-stone-400 hover:bg-stone-50 hover:text-stone-600"
                        onClick={() => void reloadFiles()}
                        disabled={!session?.ir || reemitting}
                      >
                        {reemitting ? '出码中…' : '重新出码'}
                      </button>
                    </div>
                    <ul className="min-h-0 flex-1 overflow-auto p-1">
                      {writeFiles.map((file) => {
                        const active = activeFile?.path === file.path;
                        return (
                          <li key={file.path}>
                            <button
                              type="button"
                              className={`flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors ${
                                active ? 'bg-[#f2f6ff]' : 'hover:bg-stone-50'
                              }`}
                              onClick={() => setActivePath(file.path)}
                            >
                              <span
                                className={`mt-0.5 shrink-0 rounded px-1 py-px text-[10px] leading-4 ${roleMeta(file.role).className}`}
                              >
                                {roleMeta(file.role).label}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-mono text-[11px] text-stone-700">
                                  {baseName(file.path)}
                                </span>
                                <span className="block truncate font-mono text-[10px] leading-4 text-stone-400">
                                  {dirName(file.path)}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="shrink-0 space-y-1.5 border-t border-stone-100 px-2.5 py-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-stone-500">
                        <input
                          type="checkbox"
                          checked={force}
                          onChange={(event) => setForce(event.target.checked)}
                        />
                        整文件覆盖（默认与已有文件合并）
                      </label>
                      <button
                        type="button"
                        className={`${BTN_PRIMARY} w-full justify-center`}
                        onClick={() => void onWrite()}
                        disabled={busy || !writeFiles.length}
                      >
                        写入 {writeFiles.length} 个文件
                      </button>
                    </div>
                  </div>

                  {/* 预览：路径可改，内容只读（写入前确认用） */}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex shrink-0 items-center gap-2 border-b border-stone-100 px-3 py-1.5">
                      <span className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500">
                        {target === 'python' ? 'pytest' : 'Playwright Test'}
                      </span>
                      <input
                        className={`${INPUT} min-w-[180px] flex-1 font-mono`}
                        value={activeFile?.path ?? ''}
                        onChange={(event) => {
                          if (activeFile) onEditFilePath(activeFile.path, event.target.value);
                        }}
                        placeholder={suggestedPath || 'tests/xxx.spec.ts'}
                        spellCheck={false}
                        aria-label="写入路径"
                      />
                      <button type="button" className={BTN_GHOST} onClick={onCopy}>
                        复制
                      </button>
                      <OpenWithMenu
                        compact
                        disabled={!activeFile || !session?.savedPaths?.length}
                        onOpen={(app) => {
                          if (activeFile) {
                            void revealPath({
                              sessionId: sessionRef.current,
                              path: activeFile.path,
                              app: app?.id,
                            }).catch((err) =>
                              setError(err instanceof Error ? err.message : String(err)),
                            );
                          }
                        }}
                      />
                    </div>
                    {conflicts.length ? (
                      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-100 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
                        <span className="min-w-0 flex-1 truncate">
                          这些文件已存在：{conflicts.join('、')}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded border border-amber-300 px-1.5 py-0.5 text-amber-800 hover:bg-amber-100"
                          onClick={() => {
                            setForce(true);
                            setConflicts([]);
                          }}
                        >
                          勾选覆盖
                        </button>
                      </div>
                    ) : null}
                    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre px-3 py-2 font-mono text-[11px] leading-relaxed text-stone-700">
                      {activeFile?.content || '生成后这里显示要写入的文件'}
                    </pre>
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-xs leading-relaxed text-stone-400">
                  生成步骤并试跑后，这里会列出要写入项目的 spec、页面对象与登录态文件
                </div>
              )
            ) : null}

            {topTab === 'changes' ? (
              restoring ? (
                <PaneSkeleton rows={4} />
              ) : (
                <UiAutoChanges
                  changes={changes}
                  git={git}
                  draft={draft}
                  loading={changesLoading}
                  onReveal={(path) => void onReveal(path)}
                  onRefresh={() => void refreshChanges()}
                />
              )
            ) : null}
          </div>

          {shot && topTab === 'activity' ? (
            <div className="shrink-0 border-t border-stone-100 p-2">
              <img
                src={shot}
                alt="最近一步截图"
                className="max-h-52 w-full rounded-md border border-stone-100 object-contain"
              />
            </div>
          ) : null}
        </section>

        {/* 下：控制台 / 网络 / 试跑，可拖高、可一路拖到收起（只剩 Tab 行） */}
        <section
          className={`relative flex shrink-0 flex-col overflow-hidden border-t border-stone-200 bg-white ${
            panelDragging ? '' : 'transition-[height] duration-200 ease-out'
          }`}
          style={{ height: panelCollapsed ? COLLAPSED_PANEL : panelHeight }}
        >
          {panelCollapsed ? null : (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="调整底部面板高度"
              className="h-1 shrink-0 cursor-row-resize touch-none bg-stone-100 transition-colors hover:bg-[#4176e6]/40"
              onPointerDown={(event) => {
                dragRef.current = { startY: event.clientY, startHeight: panelHeight };
                setPanelDragging(true);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag) return;
                const max = Math.max(PANEL_MIN, Math.round(window.innerHeight * 0.65));
                // 下限放到收起高度：拖着就能一路缩到只剩 Tab 行
                setPanelHeight(
                  Math.min(
                    max,
                    Math.max(COLLAPSED_PANEL, drag.startHeight + (drag.startY - event.clientY)),
                  ),
                );
              }}
              onPointerUp={(event) => {
                const drag = dragRef.current;
                if (!drag) return;
                dragRef.current = null;
                setPanelDragging(false);
                event.currentTarget.releasePointerCapture(event.pointerId);
                const max = Math.max(PANEL_MIN, Math.round(window.innerHeight * 0.65));
                const settled = Math.min(
                  max,
                  Math.max(COLLAPSED_PANEL, drag.startHeight + (drag.startY - event.clientY)),
                );
                if (settled <= PANEL_COLLAPSE_AT) {
                  // 拖到贴底：收成 Tab 行，并记住拖动前的高度，下次展开回到原位
                  setPanelHeight(Math.max(PANEL_MIN, drag.startHeight));
                  setPanelCollapsed(true);
                  writeViewText(PANEL_PREF, 'closed');
                  return;
                }
                // 不再往回弹：拖多低就留多低（只要没进收起区）
                setPanelHeight(settled);
                writeViewText(PANEL_PREF, String(settled));
              }}
              onPointerCancel={() => {
                dragRef.current = null;
                setPanelDragging(false);
              }}
            />
          )}
          <div className="relative flex h-9 shrink-0 items-center gap-1 border-b border-stone-100 px-2">
            {BOTTOM_TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  bottomTab === item.value
                    ? 'bg-[#f2f6ff] text-[#3370ff]'
                    : 'text-stone-500 hover:bg-stone-50'
                }`}
                onClick={() => goBottom(item.value)}
              >
                {item.label}
              </button>
            ))}
            <span className="ml-2 min-w-0 truncate text-[10px] text-stone-400">{statusText}</span>
            {/* 展开 / 收起：放在 Tab 行正中；点击区做成一条宽胶囊，不再只有一个图标那么大 */}
            <button
              type="button"
              aria-label={panelCollapsed ? '展开底部面板' : '收起底部面板'}
              aria-expanded={!panelCollapsed}
              className="group absolute left-1/2 top-1/2 flex h-6 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 focus-visible:ring-2 focus-visible:ring-[#4176e6]/30 focus-visible:outline-none"
              onClick={togglePanel}
            >
              <svg
                viewBox="0 0 24 24"
                className={`h-4 w-4 transition-transform duration-200 ${
                  panelCollapsed ? 'rotate-180' : ''
                }`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </div>

          {panelCollapsed ? null : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {bottomTab === 'console' ? (
                <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
                  {consoleLines.length ? (
                    <ul className="space-y-1 font-mono text-[11px]">
                      {consoleLines.slice(-80).map((line, index) => (
                        <li
                          key={index}
                          className={line.type === 'error' ? 'text-red-600' : 'text-stone-600'}
                        >
                          <span className="mr-1 text-stone-400">[{line.type}]</span>
                          {line.text}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-6 text-center text-xs text-stone-400">暂无控制台错误 / 警告</p>
                  )}
                </div>
              ) : null}

              {bottomTab === 'network' ? (
                <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
                  {netRows.length ? (
                    <ul className="space-y-1 font-mono text-[11px]">
                      {netRows.slice(-80).map((row, index) => (
                        <li key={index} className="text-stone-600">
                          <span className="mr-1 text-red-500">{row.status}</span>
                          <span className="mr-1 text-stone-400">{row.method}</span>
                          <span className="break-all">{row.url}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-6 text-center text-xs text-stone-400">暂无失败请求</p>
                  )}
                </div>
              ) : null}

              {bottomTab === 'run' ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-100 px-3 py-1.5">
                    <span className="text-[11px] text-stone-500">最近一次试跑</span>
                    <span
                      className={`text-[11px] font-medium ${
                        verify
                          ? verify.passed
                            ? 'text-emerald-600'
                            : 'text-red-600'
                          : 'text-stone-400'
                      }`}
                    >
                      {verify
                        ? verify.passed
                          ? '通过'
                          : `失败（exit ${verify.exitCode ?? '?'}）`
                        : '未试跑'}
                    </span>
                    <span className="text-[11px] tabular-nums text-stone-400">
                      耗时 {Math.round((verify?.durationMs ?? 0) / 100) / 10}s
                      {verify?.timedOut ? ' · 超时' : ''}
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={BTN_PRIMARY}
                        onClick={() => void onVerify()}
                        disabled={busy || !canDebug}
                      >
                        {phase === 'verifying' ? '试跑中…' : verify ? '重新试跑' : '试跑'}
                      </button>
                      <button
                        type="button"
                        className={BTN_GHOST}
                        onClick={() => void onDebug('headed')}
                        disabled={debugBusy || !canDebug}
                      >
                        调试运行
                      </button>
                      <button
                        type="button"
                        className={BTN_GHOST}
                        onClick={() => void onDebug('ui')}
                        disabled={debugBusy || !canDebug || target === 'python'}
                      >
                        Playwright UI
                      </button>
                      {uiUrl ? (
                        <>
                          <a className={BTN_LINK} href={uiUrl} target="_blank" rel="noreferrer">
                            打开 {uiUrl}
                          </a>
                          <button
                            type="button"
                            className={BTN_LINK}
                            onClick={() => void onStopUi()}
                          >
                            结束 UI
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-1">
                    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-stone-50/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-stone-700">
                      {verify?.log ||
                        (verify
                          ? '试跑没有输出'
                          : '试跑后这里显示日志；失败时草稿与 trace 会保留，方便回看现场。')}
                    </pre>

                    <div className="w-64 shrink-0 space-y-2 overflow-auto border-l border-stone-100 p-2">
                      <div>
                        <p className="text-[11px] text-stone-500">草稿工作区</p>
                        <p className="mt-1 break-all font-mono text-[10px] leading-4 text-stone-500">
                          {draft?.draftRoot || '还没有草稿，试跑后生成'}
                        </p>
                        <p className="break-all font-mono text-[10px] leading-4 text-stone-400">
                          {draftPath ? `用例：${draftPath}` : ''}
                        </p>
                        <p className="break-all font-mono text-[10px] leading-4 text-stone-400">
                          {tracePath ? `trace：${tracePath}` : ''}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <button
                            type="button"
                            className={BTN_LINK}
                            onClick={() => void onReveal(draftPath || draft?.draftDir || '')}
                            disabled={!draftPath && !draft?.draftDir}
                          >
                            打开草稿
                          </button>
                          <button
                            type="button"
                            className={BTN_LINK}
                            onClick={() => void onReveal(draft?.draftRoot ?? '')}
                            disabled={!draft?.exists}
                          >
                            打开目录
                          </button>
                          <button
                            type="button"
                            className={BTN_LINK}
                            onClick={() => void onReveal(tracePath)}
                            disabled={!tracePath}
                          >
                            打开 trace
                          </button>
                          <button
                            type="button"
                            className={`${BTN_LINK} text-stone-400`}
                            onClick={() => void onClean()}
                            disabled={debugBusy || !draft?.exists}
                          >
                            清理草稿
                          </button>
                        </div>
                      </div>

                      <details
                        className="rounded-lg border border-stone-200 px-2 py-1.5"
                        open={acceptOpen}
                        onToggle={(event) => setAcceptOpen(event.currentTarget.open)}
                      >
                        <summary className="cursor-pointer list-none text-[11px] text-stone-500">
                          写入后验收
                        </summary>
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <p className="text-[10px] leading-4 text-stone-400">
                            用项目自己的配置跑正式文件
                          </p>
                          <button
                            type="button"
                            className={BTN_GHOST}
                            onClick={() => void onAccept()}
                            disabled={
                              accepting ||
                              !(
                                session?.savedPath ||
                                writeFiles.find((file) => file.role === 'spec')?.path
                              )
                            }
                          >
                            {accepting ? '验收中…' : '开始验收'}
                          </button>
                        </div>
                        {accept ? (
                          <div className="mt-1.5">
                            <p
                              className={`text-[11px] font-medium ${
                                accept.passed ? 'text-emerald-600' : 'text-red-600'
                              }`}
                            >
                              {accept.ok
                                ? accept.passed
                                  ? '验收通过'
                                  : accept.excluded
                                    ? '没被项目配置识别为用例'
                                    : `失败（exit ${accept.exitCode ?? '?'}）`
                                : (accept.error ?? '失败')}
                            </p>
                            {accept.note ? (
                              <p className="mt-0.5 text-[11px] leading-4 text-amber-600">
                                {accept.note}
                              </p>
                            ) : null}
                            {accept.log ? (
                              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-2 font-mono text-[10px] leading-4 text-stone-600">
                                {accept.log}
                              </pre>
                            ) : null}
                          </div>
                        ) : null}
                      </details>

                      {debugResult ? (
                        <div className="rounded-lg border border-stone-200 px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] text-stone-500">
                              {debugResult.mode === 'ui' ? 'Playwright UI' : '调试运行'}
                            </span>
                            <span
                              className={`text-[11px] ${
                                debugResult.ok && debugResult.passed !== false
                                  ? 'text-emerald-600'
                                  : 'text-red-600'
                              }`}
                            >
                              {debugResult.ok
                                ? debugResult.mode === 'ui'
                                  ? debugResult.ready
                                    ? '已启动'
                                    : '启动较慢'
                                  : debugResult.passed
                                    ? '通过'
                                    : `失败（exit ${debugResult.exitCode ?? '?'}）`
                                : (debugResult.error ?? '失败')}
                            </span>
                          </div>
                          {debugResult.url ? (
                            <p className="mt-1 break-all font-mono text-[10px] text-stone-500">
                              {debugResult.url}
                            </p>
                          ) : null}
                          {debugResult.log ? (
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-2 font-mono text-[10px] leading-4 text-stone-600">
                              {debugResult.log}
                            </pre>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** 骨架屏：首屏 / 切项目恢复草稿时占住高度，避免空态与列表来回抖 */
function PaneSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-3 animate-pulse rounded bg-stone-100"
          style={{ width: `${Math.max(40, 92 - index * 14)}%` }}
        />
      ))}
    </div>
  );
}

function StepsSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-16 animate-pulse rounded-lg bg-stone-50" />
      ))}
    </div>
  );
}

/** 动作按钮里的小转圈：与按钮同高，尺寸固定，不改变按钮宽度 */
function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 动作按钮图标：统一 1.6 线宽、14px，和文字基线对齐。
 * 只用这三个动作需要的图形，不做通用图标库。
 */
function Icon({ name }: { name: 'steps' | 'code' | 'play' }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'h-3.5 w-3.5 shrink-0',
  };
  if (name === 'play') {
    // 实心三角：主按钮上比描边线更醒目
    return (
      <svg {...common} fill="currentColor" stroke="none">
        <path d="M8 5.5v13l11-6.5Z" />
      </svg>
    );
  }
  if (name === 'code') {
    return (
      <svg {...common}>
        <path d="m9 8-4 4 4 4" />
        <path d="m15 8 4 4-4 4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 7h10" />
      <path d="M4 12h7" />
      <path d="M4 17h10" />
      <path d="M17 12h3" />
      <path d="m18 10 2 2-2 2" />
    </svg>
  );
}
