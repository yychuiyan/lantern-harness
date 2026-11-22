/**
 * AI 生成工作区：左「需求 / 步骤」；中「对话 → 代码 → 试跑 → 变更」；
 * 右可选项目文件树（可拖宽）；下半日志 / 控制台 / 网络可拖高收起。
 *
 * 生成不是「让模型直接写脚本」，而是让它真的点一遍页面：
 * 规划步骤（人可改）→ 探索（浏览器工具）→ 探测定位器并回填计划 → 提交步骤 IR
 * → 渲染代码（spec + page object + fixture 多文件）→ 在项目内 .lantern-ai 草稿里试跑 / 调试
 * → 确认后一次写入整组文件并验收。
 *
 * 草稿不删：失败现场要能打开看、能重跑、能回放 trace。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

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
  deleteShot,
  emitGeneration,
  fetchChanges,
  parseShotUrl,
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
import { renderMarkdown } from '../../lib/markdown-client';
import { showToast } from './Toast';
import { updateProject, type UiAutoProject } from '../../lib/ui-auto';
import {
  readViewJson,
  readViewText,
  removeViewJson,
  writeViewJson,
  writeViewText,
} from '../../lib/view-prefs';
import { clearHydrateCache } from '../../lib/hydrate-cache';
import {
  displayOrchestrateTitle,
  ensureOrchestrateChatSession,
  filterGenSessionsByWorkbench,
  genSessionHasExecution,
  openWorkbenchSessionUrl,
  syncOrchestrateStatus,
} from '../../lib/ui-auto-orchestrate';
import { readProjectFile, writeProjectFile } from '../../lib/ui-auto-files';
import { hydrateSessionStore, isLiveSession, loadSessionStore } from '../../lib/sessions';
import UiAutoChanges from './UiAutoChanges';
import UiAutoOrchestratePanel, { appendOrchestrateNotice } from './UiAutoOrchestratePanel';
import UiAutoProjectFiles from './UiAutoProjectFiles';
import UiAutoSteps from './UiAutoSteps';
import { PmImagePreview } from './PmShared';
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
  'text-[11px] text-[#4176e6] hover:underline disabled:opacity-40 disabled:no-underline';
const INPUT =
  'h-8 w-full rounded-lg border border-stone-200 bg-white px-2.5 text-xs text-stone-700 outline-none transition-colors focus:border-[#4176e6]';

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
/** 右栏上半阶段轨：对齐主路径 对话 → 代码 → 试跑 → 变更 */
type Stage = 'process' | 'code' | 'verify' | 'changes';
/** 右栏下半：日志 / 控制台 / 网络（可拖高、可收起到只剩 Tab 行） */
type BottomTab = 'log' | 'console' | 'network';

const PANEL_PREF = 'ui-auto.gen.panel';
const PANEL_MIN = 160;
const DEFAULT_PANEL = 260;
const COLLAPSED_PANEL = 36;
/** 往下拖到这个高度以内松手就直接收起：把手能一路拉到只剩 Tab 行 */
const PANEL_COLLAPSE_AT = COLLAPSED_PANEL + 24;
const SIDE_PREF = 'ui-auto.gen.side';
const FILES_WIDTH_PREF = 'ui-auto.gen.fileswidth';
/** 兼容上一版右侧编排栏宽度键 */
const LEGACY_CHAT_WIDTH_PREF = 'ui-auto.gen.chatwidth';
/** 最小宽度要装得下动作条（分段按钮 ~185 + 间距 + 主按钮 104 + 两侧内边距），
    之前 300 在这个极限值下会把「开始探索」挤出右边界 */
const SIDE_MIN = 330;
const SIDE_MAX = 560;
const DEFAULT_SIDE = 380;
const FILES_WIDTH_MIN = 200;
const FILES_WIDTH_MAX = 420;
const DEFAULT_FILES_WIDTH = 240;
const STAGE_PREF = 'ui-auto.gen.stage';
const BOTTOM_PREF = 'ui-auto.gen.bottom';
/** 旧版上半 Tab 偏好，仅用于迁移到阶段轨 */
const LEGACY_TOP_PREF = 'ui-auto.gen.top';
/** 过程页曾用过的内切 Tab，迁到下半时回退读一次 */
const LEGACY_PROCESS_SUB_PREF = 'ui-auto.gen.processsub';
/** 旧「过程内 日志/对话」偏好，迁到下半「日志」时回退读一次 */
const LEGACY_PROCESS_PANE_PREF = 'ui-auto.gen.processpane';
const TARGET_PREF = 'ui-auto.gen.target';
/** 探索活动右侧「最近截图」栏开合 */
const SHOT_PANE_PREF = 'ui-auto.gen.shotpane';
/** 过程截图总开关：关着不调截图工具、也不真截，右侧栏不出 */
const PROCESS_SHOTS_PREF = 'ui-auto.gen.processshots';

const AGENT_TOOLS_NO_SHOT = UI_AUTO_AGENT_TOOLS.filter(
  (tool) => tool.function.name !== 'ui_browser_screenshot',
);
const REQ_MIN = 72;
const REQ_MAX = 420;
/** 需求框默认就是最小高度；拖过高度的会记住，双击把手恢复到这个默认值 */
const DEFAULT_REQ = REQ_MIN;
const REQ_HEIGHT_PREF = 'ui-auto.gen.reqheight';

const STAGES: ReadonlyArray<{ value: Stage; label: string }> = [
  { value: 'process', label: '对话' },
  { value: 'code', label: '代码' },
  { value: 'verify', label: '试跑' },
  { value: 'changes', label: '变更' },
];

const BOTTOM_TABS: ReadonlyArray<{ value: BottomTab; label: string }> = [
  { value: 'log', label: '日志' },
  { value: 'console', label: '控制台' },
  { value: 'network', label: '网络' },
];

function readStagePref(): Stage {
  const raw = readViewText(STAGE_PREF);
  if (raw === 'process' || raw === 'code' || raw === 'verify' || raw === 'changes') return raw;
  const legacy = readViewText(LEGACY_TOP_PREF);
  if (legacy === 'code') return 'code';
  if (legacy === 'changes') return 'changes';
  return 'process';
}

function readBottomTabPref(): BottomTab {
  const raw = readViewText(BOTTOM_PREF);
  if (raw === 'log' || raw === 'console' || raw === 'network') return raw;
  const legacyPane = readViewText(LEGACY_PROCESS_PANE_PREF);
  if (legacyPane === 'log' || legacyPane === 'activity') return 'log';
  const legacy = readViewText(LEGACY_PROCESS_SUB_PREF);
  if (legacy === 'network') return 'network';
  if (legacy === 'activity' || legacy === 'log') return 'log';
  return 'console';
}

/**
 * 需求文本可能超过 readViewText 的 200 字上限，所以用 JSON 偏好存（不截断）。
 * 旧版本存的是纯文本，读回时先试 JSON，再退回纯文本，升级后不至于丢已经写好的需求。
 */
const REQ_TEXT_PREF = 'ui-auto.requirement';

const REQ_MISS = Symbol('req-miss');

function readRequirementText(): string {
  // JSON 存过字符串（含空串）就用它；不要把 localStorage 里字面量 "" 再当纯文本读回来
  const saved = readViewJson<string | typeof REQ_MISS>(REQ_TEXT_PREF, REQ_MISS);
  if (saved !== REQ_MISS && typeof saved === 'string') return saved;
  const legacy = readViewText(REQ_TEXT_PREF, '');
  // 历史 bug：writeViewJson('') 写成了字面量 ""
  if (legacy === '""' || legacy === "''") return '';
  return legacy;
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

/**
 * 运行配置摘要里的 host：能解析 URL 就只显示 hostname:port，
 * 解析失败再截断原串，避免整条 http://… 把标题行撑爆。
 */
function runConfigHost(baseURL: string): string {
  const trimmed = baseURL.trim();
  if (!trimmed) return '未设地址';
  try {
    const url = new URL(trimmed);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
  }
}

/** 标题行摘要：`{语言?} · {有头|无头} · {host}`；单语言不写语言名 */
function runConfigSummary(input: {
  languageLabel?: string;
  headed: boolean;
  baseURL: string;
}): string {
  const parts: string[] = [];
  if (input.languageLabel) parts.push(input.languageLabel);
  parts.push(input.headed ? '有头' : '无头');
  parts.push(runConfigHost(input.baseURL));
  return parts.join(' · ');
}

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

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function shortText(value: unknown, max = 48): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function shortUrl(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text, 'http://local.invalid');
    if (url.hostname === 'local.invalid') return text;
    return url.pathname + url.search || url.href;
  } catch {
    return shortText(text, 56);
  }
}

/** 填写 / 选择的敏感值打码；${ENV} 占位原样保留 */
function maskSecret(value: string): string {
  if (!value || value.startsWith('${')) return value;
  return value.replace(/[\s\S]/g, '•');
}

/** 工具名 → 过程日志主标题 */
const TOOL_LABELS: Record<string, string> = {
  ui_plan_steps: '更新步骤计划',
  ui_browser_open: '打开页面',
  ui_browser_snapshot: '查看页面结构',
  ui_browser_click: '点击',
  ui_browser_fill: '填写',
  ui_browser_select: '下拉选择',
  ui_browser_press: '按键',
  ui_browser_hover: '悬停',
  ui_browser_back: '后退',
  ui_browser_wait: '等待',
  ui_browser_screenshot: '截图',
  ui_browser_console: '读取控制台',
  ui_browser_network: '读取网络',
  ui_locator_probe: '探测定位器',
  ui_test_set_steps: '提交测试步骤',
  ui_test_get_steps: '读取测试步骤',
  ui_test_verify: '试跑验收',
};

function activityToolLabel(name: string): string {
  return TOOL_LABELS[name] || name;
}

function activityDisplayName(item: { kind: string; name: string }): string {
  if (item.kind === 'tool') return activityToolLabel(item.name);
  return item.name;
}

function activityDisplayDetail(item: {
  kind: string;
  name: string;
  detail: string;
  status: string;
}): string {
  if (item.kind !== 'tool') return item.detail;
  const phase = item.status === 'running' ? 'running' : 'done';
  return summarizeToolDetail(item.name, item.detail, phase);
}

/** 截图只进右侧「最近截图」，不进过程日志 */
function isShotToolActivity(item: { kind: string; name: string }): boolean {
  return item.kind === 'tool' && item.name === 'ui_browser_screenshot';
}

/**
 * 开始探索时会在规划说明后插入 `---`：上面留「步骤说明」，
 * 下面过程日志，探索结束的长文小结单独放「探索小结」。
 */
function splitNarrative(answer: string): { plan: string; explore: string } {
  const raw = answer.trim();
  if (!raw) return { plan: '', explore: '' };
  const parts = raw.split(/\n---\n/);
  if (parts.length === 1) return { plan: raw, explore: '' };
  return {
    plan: parts[0].trim(),
    explore: parts.slice(1).join('\n\n---\n\n').trim(),
  };
}

/**
 * 把工具参数 / 结果收成一句中文摘要。
 * 不把 snapshot 大段 DOM 扔进日志——那是给模型看的，人只关心「做了啥、到哪了」。
 */
function summarizeToolDetail(name: string, raw: string, phase: 'running' | 'done'): string {
  if (!raw) return '';
  const data = parseJsonRecord(raw);
  if (!data) return shortText(raw, 160);

  if (typeof data.error === 'string' && data.error.trim()) {
    return shortText(data.error, 160);
  }

  if (phase === 'running') {
    if (name === 'ui_browser_open') return shortText(data.url || '/', 80) || '/';
    if (name === 'ui_browser_click') {
      return shortText(data.note || data.ref, 80);
    }
    if (name === 'ui_browser_fill') {
      const text = typeof data.text === 'string' ? maskSecret(data.text) : '';
      const bits = [shortText(data.note || data.ref, 40), text ? `内容 ${text}` : '']
        .filter(Boolean)
        .join(' · ');
      return bits;
    }
    if (name === 'ui_browser_select') {
      const value = typeof data.value === 'string' ? maskSecret(data.value) : '';
      return [shortText(data.note || data.ref, 40), value ? `选项 ${value}` : '']
        .filter(Boolean)
        .join(' · ');
    }
    if (name === 'ui_browser_press') return shortText(data.key || 'Enter', 24);
    if (name === 'ui_browser_hover') return shortText(data.note || data.ref, 80);
    if (name === 'ui_browser_wait') {
      if (typeof data.text === 'string' && data.text.trim()) {
        return `出现「${shortText(data.text, 40)}」`;
      }
      if (data.ms != null) return `${Number(data.ms) || 0}ms`;
      return '';
    }
    if (name === 'ui_browser_screenshot') return shortText(data.label || '当前页', 40);
    if (name === 'ui_locator_probe') {
      return [shortText(data.ref, 24), data.stepId ? `步骤 ${shortText(data.stepId, 20)}` : '']
        .filter(Boolean)
        .join(' · ');
    }
    if (name === 'ui_plan_steps' || name === 'ui_test_set_steps') {
      const steps = Array.isArray(data.steps) ? data.steps.length : 0;
      const title = shortText(data.title, 40);
      return [title, steps ? `${steps} 步` : ''].filter(Boolean).join(' · ');
    }
    if (name === 'ui_browser_snapshot') {
      return shortText(data.targetRef, 40);
    }
    return '';
  }

  // done：结果摘要
  if (name === 'ui_browser_open' || name === 'ui_browser_snapshot') {
    return [shortText(data.title, 40), shortUrl(data.url)].filter(Boolean).join(' · ');
  }
  if (
    name === 'ui_browser_click' ||
    name === 'ui_browser_fill' ||
    name === 'ui_browser_select' ||
    name === 'ui_browser_hover' ||
    name === 'ui_browser_press' ||
    name === 'ui_browser_back' ||
    name === 'ui_browser_wait'
  ) {
    return [shortText(data.action, 80), shortUrl(data.url)].filter(Boolean).join(' · ');
  }
  if (name === 'ui_browser_screenshot') {
    return shortText(data.note || '已更新右侧截图', 80);
  }
  if (name === 'ui_locator_probe') {
    const element =
      data.element && typeof data.element === 'object'
        ? (data.element as Record<string, unknown>)
        : null;
    const label =
      shortText(element?.name || element?.placeholder || element?.id || element?.tag, 32) ||
      shortText(data.ref, 24);
    const conf = shortText(data.confidence, 12);
    const warn = shortText(data.warning, 48);
    return [label, conf ? `置信度 ${conf}` : '', warn].filter(Boolean).join(' · ');
  }
  if (name === 'ui_plan_steps' || name === 'ui_test_set_steps') {
    const count = data.stepCount ?? (Array.isArray(data.plan) ? data.plan.length : '');
    return [count !== '' ? `${count} 步` : '', shortText(data.note, 80)]
      .filter(Boolean)
      .join(' · ');
  }
  if (name === 'ui_browser_console' || name === 'ui_browser_network') {
    return data.count != null ? `${data.count} 条` : '';
  }
  if (name === 'ui_test_verify') {
    return shortText(data.ok === false ? data.error || '未通过' : data.note || '已完成', 80);
  }
  // 兜底：挑几个常见字段，绝不带 snapshot
  const bits = [
    shortText(data.action, 60),
    shortText(data.title, 40),
    shortUrl(data.url),
    shortText(data.note, 60),
  ].filter(Boolean);
  return bits.join(' · ') || shortText(JSON.stringify(data), 120);
}

/** 按「过程截图」开关追加一句，避免提示词仍写「去截图」但工具已被摘掉 */
function processShotsPromptHint(enabled: boolean): string {
  return enabled
    ? '本轮已开启过程截图：关键节点可调用一次 ui_browser_screenshot；图只显示在面板里给人看，你看不到图片内容。'
    : '本轮已关闭过程截图：不要调用 ui_browser_screenshot；用 ui_browser_snapshot 判断页面结构即可。';
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
    // 带上项目框架：「项目骨架」段里按框架分子段，这里挑当前框架那一份
    return fetchUiAutoPrompt(promptFile, project.framework);
  }, [promptFile, project.framework]);
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
  /** 「运行配置」弹层开合（沿用旧 address 偏好键，升级后不丢状态） */
  const [addrOpen, setAddrOpen] = useState(() => readFlagPref('ui-auto.gen.address', false));
  const envPopRef = useRef<HTMLDivElement | null>(null);
  /** 试跑面板里的「写入后验收」折叠块同样记住展开状态 */
  const [acceptOpen, setAcceptOpen] = useState(() => readFlagPref('ui-auto.gen.accept', false));
  /** 切项目 / 首屏：正在把上次的草稿捞回来，先给骨架屏，别让空态闪一下 */
  const [restoring, setRestoring] = useState(true);

  const [phase, setPhase] = useState<Phase>('idle');
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [session, setSession] = useState<UiGenSession | null>(null);
  /** 工作台编排会话 id（与 uiauto session 双向关联） */
  const [chatSessionId, setChatSessionId] = useState('');
  const [genSessionList, setGenSessionList] = useState<
    Array<Partial<UiGenSession> & { id: string }>
  >([]);
  const [filesPanelOpen, setFilesPanelOpen] = useState(() =>
    readFlagPref('ui-auto.gen.files', true),
  );
  const [treeActivePath, setTreeActivePath] = useState('');
  const [treeFileContent, setTreeFileContent] = useState('');
  const [treeDirty, setTreeDirty] = useState(false);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  /** 探索模式：fresh 清 IR；continue 保留已有步骤 */
  const exploreModeRef = useRef<'fresh' | 'continue'>('fresh');
  const chatSessionIdRef = useRef('');
  const [plan, setPlan] = useState<UiPlanStep[]>([]);
  const [planSaving, setPlanSaving] = useState(false);
  /** 重新出码中：按钮显示进度，避免连点 */
  const [reemitting, setReemitting] = useState(false);
  const [code, setCode] = useState('');
  const [suggestedPath, setSuggestedPath] = useState('');
  /** 待写入的文件清单（spec + page object + fixture），路径可在写前改 */
  const [files, setFiles] = useState<UiEmitFile[]>([]);
  /** 勾选要写入的路径；缺省 true，出码后默认全选 */
  const [selectedWritePaths, setSelectedWritePaths] = useState<Record<string, boolean>>({});
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
  const [filesWidth, setFilesWidth] = useState(() => {
    const raw = Number(readViewText(FILES_WIDTH_PREF) || readViewText(LEGACY_CHAT_WIDTH_PREF));
    if (!Number.isFinite(raw) || raw < FILES_WIDTH_MIN) return DEFAULT_FILES_WIDTH;
    return Math.min(raw, FILES_WIDTH_MAX);
  });
  const filesDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [shot, setShot] = useState('');
  /** 点缩略图才放大；关掉后仍留着右侧小图 */
  const [shotPreviewOpen, setShotPreviewOpen] = useState(false);
  /** 最近截图栏：收起后只留右侧窄条，活动区更宽 */
  const [shotPaneOpen, setShotPaneOpen] = useState(() => readFlagPref(SHOT_PANE_PREF, true));
  const [shotDeleting, setShotDeleting] = useState(false);
  /** 过程截图：默认关——探索不依赖图，需要围观再开 */
  const [processShots, setProcessShots] = useState(() => readFlagPref(PROCESS_SHOTS_PREF, false));
  const processShotsRef = useRef(processShots);
  processShotsRef.current = processShots;
  /** 过程日志正文：默认收起，交互对齐会话「思考」行 */
  const [processLogOpen, setProcessLogOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [verify, setVerify] = useState<UiVerifyResult | null>(null);
  const [round, setRound] = useState(0);
  /** 右栏上半阶段轨 */
  const [stage, setStage] = useState<Stage>(() => readStagePref());
  /** 右栏下半：日志 / 控制台 / 网络 */
  const [bottomTab, setBottomTab] = useState<BottomTab>(() => readBottomTabPref());
  /** 面板高度（含 Tab 行）；收起时只留 Tab 行 */
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
  /** restoreHeight：收起后再拖开又松手收起时，回到上次展开高度，别被 COLLAPSED 盖掉 */
  const dragRef = useRef<{
    startY: number;
    startHeight: number;
    restoreHeight: number;
  } | null>(null);
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
  chatSessionIdRef.current = chatSessionId;
  const activityIdRef = useRef(0);
  const activityRef = useRef<HTMLDivElement | null>(null);
  /** 活动区贴底跟随；用户往上翻后暂停，滚回底部再恢复 */
  const activityStickRef = useRef(true);

  const requirementRef = useRef(requirement);
  requirementRef.current = requirement;

  const bindOrchestrate = useCallback(
    async (uiautoSessionId: string, status?: string, forceNew = false) => {
      if (!uiautoSessionId || !project.dir) return '';
      try {
        const linked = await ensureOrchestrateChatSession({
          projectId: project.id,
          projectName: project.name,
          projectDir: project.dir,
          uiautoSessionId,
          // 用 ref：需求框每敲一字不要重建 bind，避免过程区 ChatApp 跟着抖
          requirement: requirementRef.current,
          status: status || 'draft',
          forceNew,
        });
        setChatSessionId(linked.chatSessionId);
        chatSessionIdRef.current = linked.chatSessionId;
        await saveGeneration({
          sessionId: uiautoSessionId,
          chatSessionId: linked.chatSessionId,
        }).catch(() => undefined);
        return linked.chatSessionId;
      } catch (err) {
        console.warn('[uiauto] bind orchestrate failed', err);
        return '';
      }
    },
    [project.dir, project.id, project.name],
  );

  const refreshVisibleGenSessions = useCallback(async () => {
    await hydrateSessionStore().catch(() => null);
    const list = await fetchGenerationSessions(project.id).catch(() => ({ sessions: [] }));
    const chats = loadSessionStore().sessions;
    const visible = filterGenSessionsByWorkbench(list.sessions, chats);
    setGenSessionList(visible);
    // 当前会话若已在工作台归档/删除，清掉本地选中
    const cur = sessionRef.current;
    if (cur && !visible.some((s) => s.id === cur)) {
      const chatId = chatSessionIdRef.current;
      if (chatId) {
        const chat = chats.find((s) => s.id === chatId);
        if (!chat || !isLiveSession(chat)) {
          sessionRef.current = '';
          setSession(null);
          setChatSessionId('');
          chatSessionIdRef.current = '';
        }
      }
    }
    return visible;
  }, [project.id]);
  const runningToolsRef = useRef<number[]>([]);
  /** 活动区贴底跟随；用户往上翻后暂停，滚回底部再恢复 */
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

  const visibleActivity = useMemo(
    () => activity.filter((item) => !isShotToolActivity(item)),
    [activity],
  );
  const { plan: planNarrative, explore: exploreNarrative } = useMemo(
    () => splitNarrative(answer),
    [answer],
  );
  const processLogLive = phase === 'planning' || phase === 'exploring';
  /** 折叠态一行预览：对齐会话思考行，跑着取最新动作 */
  const processLogPreview = useMemo(() => {
    const last = visibleActivity[visibleActivity.length - 1];
    if (last) {
      const detail = activityDisplayDetail(last);
      const line = detail ? `${activityDisplayName(last)} · ${detail}` : activityDisplayName(last);
      return line.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    if (exploreNarrative.trim()) {
      const line = exploreNarrative.trim().split(/\r?\n/)[0] || '';
      return line.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    if (planNarrative.trim()) {
      const line = planNarrative.trim().split(/\r?\n/)[0] || '';
      return line.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    return '';
  }, [exploreNarrative, planNarrative, visibleActivity]);

  useEffect(() => {
    if (!processLogOpen) return;
    const el = activityRef.current;
    if (!el || !activityStickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleActivity, answer, processLogOpen]);

  const onNarrativeClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.closest('[data-copy-code]')) return;
    const code = target.closest('.code-block')?.querySelector('code');
    if (!code) return;
    void navigator.clipboard?.writeText(code.textContent ?? '').then(
      () => showToast('已复制', 'success'),
      () => showToast('复制失败', 'error'),
    );
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

  /** 规划说明（测试思路等）单独落盘，探索过程追加活动日志时不会冲掉 */
  const narrativeSaveRef = useRef<number | null>(null);
  const lastNarrativeRef = useRef('');
  useEffect(() => {
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    if (answer === lastNarrativeRef.current) return;
    lastNarrativeRef.current = answer;
    if (narrativeSaveRef.current) window.clearTimeout(narrativeSaveRef.current);
    narrativeSaveRef.current = window.setTimeout(() => {
      void saveGeneration({ sessionId, narrative: answer }).catch(() => undefined);
    }, 800);
  }, [answer]);

  /**
   * 生成页里所有可操作项都随手记住（不等「生成步骤」）：需求、地址、登录态、
   * 有头 / 无头、覆盖开关、地址面板展开状态、选中的文件——刷新或切走再回来都还是原样。
   * 需求框防抖写盘：每字同步 localStorage 会拖慢输入，看起来像整页在闪。
   */
  const reqPrefSaveRef = useRef<number | null>(null);
  useEffect(() => {
    if (reqPrefSaveRef.current) window.clearTimeout(reqPrefSaveRef.current);
    reqPrefSaveRef.current = window.setTimeout(() => {
      writeViewJson(REQ_TEXT_PREF, requirement);
    }, 400);
    return () => {
      if (reqPrefSaveRef.current) window.clearTimeout(reqPrefSaveRef.current);
    };
  }, [requirement]);
  // 离开页面时把未到防抖的最后一次需求落盘
  useEffect(
    () => () => {
      writeViewJson(REQ_TEXT_PREF, requirementRef.current);
    },
    [],
  );

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
    writeViewText(SHOT_PANE_PREF, shotPaneOpen ? '1' : '0');
  }, [shotPaneOpen]);

  useEffect(() => {
    writeViewText(PROCESS_SHOTS_PREF, processShots ? '1' : '0');
    if (!processShots) {
      setShot('');
      setShotPreviewOpen(false);
    }
  }, [processShots]);

  useEffect(() => {
    writeViewText('ui-auto.gen.force', force ? '1' : '0');
  }, [force]);

  useEffect(() => {
    writeViewText('ui-auto.gen.address', addrOpen ? '1' : '0');
  }, [addrOpen]);

  // 「运行配置」弹层：点外面 / Esc 收起，别一直挡着步骤
  useEffect(() => {
    if (!addrOpen) return;
    const onPointer = (event: MouseEvent) => {
      const root = envPopRef.current;
      if (!root || root.contains(event.target as Node)) return;
      setAddrOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddrOpen(false);
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
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

  /** 阶段切换顺手记住：下次进生成页还停在原来那格 */
  const goStage = useCallback((next: Stage) => {
    setStage(next);
    writeViewText(STAGE_PREF, next);
  }, []);

  const goBottom = useCallback(
    (next: BottomTab) => {
      setBottomTab(next);
      writeViewText(BOTTOM_PREF, next);
      // 面板收起时点到某个 Tab，顺手展开，别让人以为没反应
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

  const onPanelDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const restoreHeight = Math.max(PANEL_MIN, panelHeight);
      dragRef.current = {
        startY: event.clientY,
        startHeight: panelCollapsed ? COLLAPSED_PANEL : panelHeight,
        restoreHeight,
      };
      if (panelCollapsed) {
        setPanelCollapsed(false);
        setPanelHeight(COLLAPSED_PANEL);
      }
      setPanelDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [panelCollapsed, panelHeight],
  );

  const onPanelDragMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const max = Math.max(PANEL_MIN, Math.round(window.innerHeight * 0.65));
    setPanelHeight(
      Math.min(max, Math.max(COLLAPSED_PANEL, drag.startHeight + (drag.startY - event.clientY))),
    );
  }, []);

  const onPanelDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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
      setPanelHeight(drag.restoreHeight);
      setPanelCollapsed(true);
      writeViewText(PANEL_PREF, 'closed');
      return;
    }
    setPanelHeight(settled);
    setPanelCollapsed(false);
    writeViewText(PANEL_PREF, String(settled));
  }, []);

  const onPanelDragCancel = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanelDragging(false);
    if (drag && panelHeight <= PANEL_COLLAPSE_AT) {
      setPanelHeight(drag.restoreHeight);
      setPanelCollapsed(true);
      writeViewText(PANEL_PREF, 'closed');
    }
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
   * testDir 从建议路径反推；page object / fixture 的落点由服务端按项目实际目录判定
   * （企业级骨架在根级 pages/，老项目在 tests/pages/），所以这里带上 projectId。
   */
  const refreshFiles = useCallback(
    async (ir: UiTestIr | null, tg: UiTestTarget, hintPath = ''): Promise<UiEmitFile[]> => {
      if (!ir?.steps?.length) {
        setFiles([]);
        return [];
      }
      try {
        const testDir = hintPath.includes('/') ? hintPath.replace(/\/[^/]+$/, '') : 'tests';
        const result = await emitGeneration(ir, tg, { testDir, projectId: project.id });
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
    [project.id],
  );

  /** 从会话重新拉 IR 再出码：试跑 / 修复后步骤变了，文件清单要跟着变 */
  const reloadFiles = useCallback(async (): Promise<UiEmitFile[]> => {
    if (!sessionRef.current) return [];
    if (dirtyPaths.size > 0) {
      const ok = window.confirm(
        `有 ${dirtyPaths.size} 个草稿手改未保存到出码结果。继续「重新出码」会用新生成内容覆盖待写入清单（磁盘上已保存的 .lantern-ai 草稿仍在）。是否继续？`,
      );
      if (!ok) return files;
    }
    setReemitting(true);
    try {
      const detail = await fetchGenerationSession(sessionRef.current);
      setCode(detail.code);
      setSuggestedPath(detail.suggestedPath);
      const next = await refreshFiles(
        detail.session.ir,
        detail.session.target === 'python' ? 'python' : 'ts',
        detail.suggestedPath,
      );
      setDirtyPaths(new Set());
      setTreeDirty(false);
      return next;
    } catch {
      // 拉不到就保持现有清单
      return [];
    } finally {
      setReemitting(false);
    }
  }, [dirtyPaths, files, refreshFiles]);

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
    setChatSessionId('');
    chatSessionIdRef.current = '';
    setTreeActivePath('');
    setTreeFileContent('');
    setTreeDirty(false);
    setDirtyPaths(new Set());
    setRestoring(true);
    void refreshVisibleGenSessions()
      .then(async (visible) => {
        if (!alive) return;
        const preferredId = readViewText(`ui-auto.gen.session.${project.id}`);
        const latest = visible.find((s) => s.id === preferredId) || visible[0];
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
        writeViewText(`ui-auto.gen.session.${project.id}`, detail.session.id);
        // 未执行过的草稿：过程区保持空对话，不预先挂编排会话
        if (genSessionHasExecution(detail.session)) {
          void bindOrchestrate(detail.session.id, detail.session.status, false).then(
            () => void refreshVisibleGenSessions(),
          );
        } else {
          setChatSessionId('');
          chatSessionIdRef.current = '';
        }
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
        } else {
          setVerify(null);
        }
        // 本轮控制台 / 网络：关浏览器后仍从会话缓存回看，直到下一轮清空
        setConsoleLines(Array.isArray(detail.session.consoleLog) ? detail.session.consoleLog : []);
        setNetRows(Array.isArray(detail.session.networkLog) ? detail.session.networkLog : []);
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
        if (typeof detail.session.narrative === 'string' && detail.session.narrative.trim()) {
          lastNarrativeRef.current = detail.session.narrative;
          setAnswer(detail.session.narrative);
        }
        if (detail.session.savedPath) goStage('changes');
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
  }, [
    project.id,
    refreshChanges,
    refreshFiles,
    goStage,
    bindOrchestrate,
    refreshVisibleGenSessions,
  ]);

  // 回到页面时同步工作台归档/删除，避免下拉残留
  useEffect(() => {
    const sync = () => {
      void refreshVisibleGenSessions();
    };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    const timer = window.setInterval(sync, 15000);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
      window.clearInterval(timer);
    };
  }, [refreshVisibleGenSessions]);

  useEffect(() => {
    writeViewText('ui-auto.gen.files', filesPanelOpen ? '1' : '0');
  }, [filesPanelOpen]);

  // 目标语言必须落在项目允许的范围里：pytest / 纯 .py 仓库不能出 TypeScript
  useEffect(() => {
    const { options, fallback } = projectTargets(project.framework, project.specFiles ?? []);
    if (!options.some((option) => option.value === target)) setTarget(fallback);
  }, [project.framework, project.specFiles, target]);

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

  // 控制台 / 网络按需拉取：面板展开且切到对应 Tab 时刷；浏览器在就取活数据（并落盘）
  useEffect(() => {
    if (!session?.id || panelCollapsed) return;
    const sessionId = session.id;
    if (bottomTab === 'console') {
      void fetchConsole(sessionId)
        .then((result) => setConsoleLines(result.messages ?? []))
        .catch(() => undefined);
    } else if (bottomTab === 'network') {
      void fetchNetwork(sessionId)
        .then((result) => setNetRows(result.requests ?? []))
        .catch(() => undefined);
    }
  }, [bottomTab, panelCollapsed, session?.id, phase]);

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
      allowScreenshot: processShotsRef.current,
      onPlan: (next: UiPlanStep[]) => setPlan((prev) => mergeServerPlan(prev, next)),
      onShot: (url: string) => {
        if (processShotsRef.current) setShot(url);
      },
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
        // 过程截图关着就不把截图工具交给模型，省缓存也少一轮无关调用
        tools: processShotsRef.current ? UI_AUTO_AGENT_TOOLS : AGENT_TOOLS_NO_SHOT,
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
          // 截图只更新右侧缩略图，不写进过程日志（工具仍执行，onShot 会刷图）
          if (chunk.name === 'ui_browser_screenshot') continue;
          if (chunk.status === 'running') {
            const id = pushActivity({
              kind: 'tool',
              name: chunk.name,
              detail: summarizeToolDetail(chunk.name, chunk.args ?? '', 'running'),
              status: 'running',
            });
            runningToolsRef.current.push(id);
          } else {
            const id = runningToolsRef.current.pop();
            const detail = summarizeToolDetail(chunk.name, chunk.result ?? '', 'done');
            setActivity((prev) =>
              prev.map((item) => (item.id === id ? { ...item, status: 'done', detail } : item)),
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
   * reset 表示「这一轮从头开始」：服务端会清掉上一轮的 IR / 试跑结果（活动日志与规划说明保留），
   * 本地也把对应的代码、文件清单、试跑面板一起清空，免得旧内容被当成这次的产出。
   */
  const ensureSession = useCallback(
    async (
      reset = false,
      opts?: {
        attachOrchestrate?: boolean;
        /** 新会话：不沿用当前需求标题 / 正文 */
        blank?: boolean;
      },
    ) => {
      const sourceText = opts?.blank ? '' : requirement.trim();
      const titleText = opts?.blank
        ? '新会话'
        : sourceText.split(/\r?\n/)[0]?.slice(0, 60) || '未命名流程';
      const created = await prepareGeneration({
        projectId: project.id,
        sessionId: sessionRef.current || undefined,
        title: titleText,
        target,
        baseURL,
        storageState,
        source: sourceText,
        headed,
        reset,
        plan: opts?.blank ? undefined : planRef.current.length ? planRef.current : undefined,
      });
      sessionRef.current = created.session.id;
      setSession(created.session);
      setSuggestedPath(created.suggestedPath);
      setDraft(created.draft);
      writeViewText(`ui-auto.gen.session.${project.id}`, created.session.id);
      // 默认不进编排会话：未执行前过程区空对话；真正跑流程时再 attach
      if (opts?.attachOrchestrate) {
        await bindOrchestrate(created.session.id, created.session.status || 'draft', false);
      }
      void refreshVisibleGenSessions();
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
    [
      baseURL,
      bindOrchestrate,
      headed,
      project.id,
      refreshVisibleGenSessions,
      requirement,
      storageState,
      target,
    ],
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
    lastNarrativeRef.current = '';
    // 新一轮：控制台 / 网络 / 试跑只服务当前轮，开新规划时清掉
    setConsoleLines([]);
    setNetRows([]);
    setVerify(null);
    setPhase('planning');
    // 进「对话」+ 底部「日志」；别停在上次记住的「代码」页
    goStage('process');
    goBottom('log');
    try {
      await ensureSession(true, { attachOrchestrate: true });
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
    goBottom,
    goStage,
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
        goStage('verify');
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
    [goStage, pushActivity, refreshChanges, reloadFiles, runAgentTurn],
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
    setShotPreviewOpen(false);
    // 新一轮探索：控制台 / 网络 / 试跑清空；活动日志与步骤说明保留
    setConsoleLines([]);
    setNetRows([]);
    setRound(0);
    setFiles([]);
    setConflicts([]);
    setAccept(null);
    setDebugResult(null);
    setUiUrl('');
    // 探索说明接在规划说明后面：规划阶段那段「## 测试思路」别因为点了开始探索就消失
    setAnswer((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n---\n\n` : prev));
    // 探索期间看对话 + 底部日志；代码页只在用户点「生成代码」时进入
    goStage('process');
    goBottom('log');
    setPhase('exploring');
    let startedId = '';

    const continueMode = exploreModeRef.current === 'continue';
    exploreModeRef.current = 'fresh';
    try {
      // fresh：清 IR / 试跑；continue：保留已有步骤，从失败步续
      const started = await ensureSession(!continueMode, { attachOrchestrate: true });
      startedId = started.session.id;
      void syncOrchestrateStatus({
        chatSessionId: chatSessionIdRef.current,
        status: 'exploring',
      });
      pushActivity({
        kind: 'info',
        name: continueMode ? '继续探索' : '探索开始',
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

      const failIdx = (() => {
        const failed = activePlan.findIndex((step) => step.status === 'failed');
        if (failed >= 0) return failed;
        return activePlan.findIndex((step) => step.status === 'pending' || !step.locator);
      })();
      const continueHint =
        continueMode && failIdx >= 0
          ? `\n\n【继续探索】请从第 ${failIdx + 1} 步起补齐后续步骤与定位器；已成功绑定的步骤不要推翻重来。`
          : continueMode
            ? '\n\n【继续探索】保留已有 IR，只补齐未完成步骤与定位器。'
            : '';

      // 探索前再取一次：规划阶段用户可能刚改过提示词
      const promptNow = await loadPrompt();
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: [
            buildUiAgentSystemPrompt(
              project,
              target,
              activePlan,
              promptNow.agent,
              promptNow.code,
              promptNow.skeleton,
            ),
            processShotsPromptHint(processShotsRef.current),
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        {
          role: 'user',
          content: `${buildUiAgentUserPrompt(text, baseURL, target, activePlan)}${continueHint}`,
        },
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
      void syncOrchestrateStatus({
        chatSessionId: chatSessionIdRef.current,
        status: 'explored',
      });
      void appendOrchestrateNotice(
        chatSessionIdRef.current,
        `探索完成（${steps} 步）。可点「生成代码」或在编排里说「生成代码」。`,
      );
      setFilesRefreshKey((n) => n + 1);
      // 把本轮控制台 / 网络刷进面板并落盘（关浏览器后还能看）
      void fetchConsole(started.session.id)
        .then((result) => setConsoleLines(result.messages ?? []))
        .catch(() => undefined);
      void fetchNetwork(started.session.id)
        .then((result) => setNetRows(result.requests ?? []))
        .catch(() => undefined);
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
        void fetchConsole(startedId)
          .then((result) => setConsoleLines(result.messages ?? []))
          .catch(() => undefined);
        void fetchNetwork(startedId)
          .then((result) => setNetRows(result.requests ?? []))
          .catch(() => undefined);
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
    goBottom,
    goStage,
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
    const push = (showSaving: boolean) => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      // 改文字静默落盘，不闪「保存中…」；增删改结构才提示
      if (showSaving) setPlanSaving(true);
      void saveGeneration({
        sessionId,
        plan: next,
        // 用户亲手删到空是合法的；其它路径的空计划由服务端挡掉
        allowEmptyPlan: true,
      })
        .catch(() => undefined)
        .finally(() => {
          if (showSaving) setPlanSaving(false);
        });
    };
    if (planSaveRef.current) window.clearTimeout(planSaveRef.current);
    if (structural) {
      push(true);
      return;
    }
    planSaveRef.current = window.setTimeout(() => push(false), 400);
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

  const selectedWriteFiles = useMemo(
    () => writeFiles.filter((file) => selectedWritePaths[file.path] !== false),
    [selectedWritePaths, writeFiles],
  );

  const activeFile = useMemo(
    () => writeFiles.find((file) => file.path === activePath) ?? writeFiles[0] ?? null,
    [activePath, writeFiles],
  );

  // 清单路径变化时：已有路径保留勾选态，新路径默认勾选
  useEffect(() => {
    setSelectedWritePaths((prev) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const file of writeFiles) {
        const value = file.path in prev ? Boolean(prev[file.path]) : true;
        next[file.path] = value;
        if (!(file.path in prev) || prev[file.path] !== value) changed = true;
      }
      if (Object.keys(prev).length !== writeFiles.length) changed = true;
      return changed ? next : prev;
    });
  }, [writeFiles]);

  const onEditFilePath = useCallback((from: string, to: string) => {
    setFiles((prev) => prev.map((file) => (file.path === from ? { ...file, path: to } : file)));
    setSelectedWritePaths((prev) => {
      if (!(from in prev) && !(to in prev)) return prev;
      const next = { ...prev };
      const kept = next[from] !== false;
      delete next[from];
      next[to] = kept;
      return next;
    });
    setActivePath(to);
  }, []);

  const toggleWritePath = useCallback((path: string) => {
    setSelectedWritePaths((prev) => ({
      ...prev,
      [path]: prev[path] === false,
    }));
  }, []);

  /** 从待写入清单去掉指定路径（未落盘，仅清预览） */
  const removeWritePaths = useCallback(
    (paths: string[]) => {
      if (!paths.length) return;
      const drop = new Set(paths);
      if (files.length) {
        setFiles((prev) => prev.filter((file) => !drop.has(file.path)));
      } else if (code) {
        // 出码失败退回的「只有主文件」：移出即清空
        setCode('');
      }
      setSelectedWritePaths((prev) => {
        const next = { ...prev };
        for (const path of paths) delete next[path];
        return next;
      });
      setActivePath((prev) => (drop.has(prev) ? '' : prev));
      setConflicts((prev) => prev.filter((path) => !drop.has(path)));
    },
    [code, files.length],
  );

  const onWrite = useCallback(async () => {
    if (!sessionRef.current || !selectedWriteFiles.length) return;
    setError('');
    setConflicts([]);
    try {
      const result = await writeGeneration({
        sessionId: sessionRef.current,
        files: selectedWriteFiles.map((file) => ({
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
      const written = new Set([
        ...(result.savedPaths ?? []),
        ...(result.paths ?? []),
        ...selectedWriteFiles.map((file) => file.path),
      ]);
      const count = result.savedPaths?.length ?? result.paths?.length ?? selectedWriteFiles.length;
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
      const remaining = writeFiles.filter((file) => !written.has(file.path)).length;
      setNotice(
        `已写入 ${count} 个文件${detail ? `（${detail}）` : ''}${
          result.path ? `，主用例 ${result.path}` : ''
        }${remaining ? `，清单还剩 ${remaining} 个未写` : '，可以按项目配置验收'}`,
      );
      setSession((prev) =>
        prev
          ? { ...prev, status: 'written', savedPath: result.path, savedPaths: result.savedPaths }
          : prev,
      );
      setForce(false);
      // 已写入的从清单拿掉；未勾选的留下
      const left = writeFiles.filter((file) => !written.has(file.path));
      if (files.length) {
        setFiles(left);
      } else {
        setCode('');
      }
      setSelectedWritePaths((prev) => {
        const next = { ...prev };
        for (const path of written) delete next[path];
        return next;
      });
      setActivePath((prev) => (written.has(prev) ? (left[0]?.path ?? '') : prev));
      await refreshChanges();
      if (!remaining) goStage('changes');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [files.length, force, goStage, refreshChanges, selectedWriteFiles, writeFiles]);

  /** 取消选中项的待写入：只清预览清单，不碰磁盘 */
  const onCancelWrite = useCallback(() => {
    const targets = selectedWriteFiles;
    if (!targets.length) return;
    const n = targets.length;
    const ok = window.confirm(
      `确定取消写入已选的 ${n} 个文件？\n只会从待写入清单去掉，不会改动项目里已有文件。`,
    );
    if (!ok) return;
    removeWritePaths(targets.map((file) => file.path));
    setNotice(
      n >= writeFiles.length
        ? '已取消写入，待写入清单已清空'
        : `已取消 ${n} 个文件的写入，清单还剩 ${writeFiles.length - n} 个`,
    );
  }, [removeWritePaths, selectedWriteFiles, writeFiles.length]);

  /** 放弃当前打开的草稿手改，从磁盘重新载入 */
  const onDiscardTreeEdit = useCallback(async () => {
    if (!treeActivePath || !treeDirty) return;
    const res = await readProjectFile(project.id, treeActivePath);
    if (!res.ok) {
      showToast(res.error || '读取失败', 'error');
      return;
    }
    setTreeFileContent(res.content || '');
    setTreeDirty(false);
    setDirtyPaths((prev) => {
      const next = new Set(prev);
      next.delete(treeActivePath);
      return next;
    });
    showToast('已放弃修改', 'success');
  }, [project.id, treeActivePath, treeDirty]);

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
        goStage('verify');
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
          content: [
            buildUiAgentSystemPrompt(
              project,
              target,
              plan,
              promptNow.agent,
              promptNow.code,
              promptNow.skeleton,
            ),
            processShotsPromptHint(processShotsRef.current),
          ]
            .filter(Boolean)
            .join('\n\n'),
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
    goStage,
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
    if (!chatSessionIdRef.current) {
      await bindOrchestrate(sessionRef.current, session?.status || 'explored', false);
    }
    const filesNow = await reloadFiles();
    goStage('code');
    setNotice(
      filesNow.length
        ? `已生成 ${filesNow.length} 个文件，确认后到「试跑」里执行`
        : '当前没有可出码的步骤，先「开始探索」把流程跑一遍',
    );
  }, [bindOrchestrate, busy, goStage, reloadFiles, session?.status]);

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
  /** 环境相对探测值被改过：摘要标黄，提醒不是项目默认那套 */
  const envCustomized = Boolean(
    (detectedBaseURL && baseURL !== detectedBaseURL) ||
    (detectedStorageState
      ? storageState !== detectedStorageState
      : Boolean(storageState && storageState !== '-')),
  );
  const canSwitchTarget = targetChoices.options.length > 1;
  const runConfigLabel = runConfigSummary({
    languageLabel: canSwitchTarget
      ? targetChoices.options.find((option) => option.value === target)?.label || target
      : undefined,
    headed,
    baseURL,
  });
  const canContinueExplore =
    !busy &&
    Boolean(session?.id) &&
    plan.some((step) => step.status === 'failed' || step.status === 'pending' || !step.locator);

  const onContinueExplore = useCallback(() => {
    exploreModeRef.current = 'continue';
    void onGenerate();
  }, [onGenerate]);

  const onSwitchGenSession = useCallback(
    async (nextId: string) => {
      if (!nextId || nextId === sessionRef.current || busy) return;
      writeViewText(`ui-auto.gen.session.${project.id}`, nextId);
      setRestoring(true);
      try {
        const detail = await fetchGenerationSession(nextId);
        sessionRef.current = detail.session.id;
        setSession(detail.session);
        setPlan(normalizePlanActions(detail.session.plan ?? []));
        setCode(detail.code);
        setSuggestedPath(detail.suggestedPath);
        setAnswer(detail.session.narrative || '');
        setDraft(detail.draft ?? null);
        setChanges(detail.changes ?? []);
        setConsoleLines(Array.isArray(detail.session.consoleLog) ? detail.session.consoleLog : []);
        setNetRows(Array.isArray(detail.session.networkLog) ? detail.session.networkLog : []);
        if (genSessionHasExecution(detail.session)) {
          await bindOrchestrate(detail.session.id, detail.session.status);
        } else {
          setChatSessionId('');
          chatSessionIdRef.current = '';
        }
        void refreshFiles(
          detail.session.ir,
          detail.session.target === 'python' ? 'python' : 'ts',
          detail.suggestedPath,
        );
        setFilesRefreshKey((n) => n + 1);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setRestoring(false);
      }
    },
    [bindOrchestrate, busy, project.id, refreshFiles],
  );

  const onOpenTreeFile = useCallback(
    async (relPath: string) => {
      setTreeActivePath(relPath);
      goStage('code');
      const res = await readProjectFile(project.id, relPath);
      if (!res.ok) {
        showToast(res.error || '读取失败', 'error');
        return;
      }
      setTreeFileContent(res.content || '');
      setTreeDirty(false);
      // 若正好是待写入清单里的文件，同步选中
      if (files.some((f) => f.path === relPath || f.suggestedPath === relPath)) {
        setActivePath(relPath);
      }
    },
    [files, goStage, project.id],
  );

  const onSaveTreeFile = useCallback(async () => {
    if (!treeActivePath || !treeDirty) return;
    const isDraft = treeActivePath.split('/')[0] === '.lantern-ai';
    const res = await writeProjectFile({
      projectId: project.id,
      path: treeActivePath,
      content: treeFileContent,
      allow: isDraft ? 'draft' : 'any',
    });
    if (!res.ok) {
      showToast(res.error || '保存失败', 'error');
      return;
    }
    setTreeDirty(false);
    setDirtyPaths((prev) => {
      const next = new Set(prev);
      next.delete(treeActivePath);
      return next;
    });
    showToast('已保存', 'success');
    setFilesRefreshKey((n) => n + 1);
  }, [project.id, treeActivePath, treeDirty, treeFileContent]);

  const statusLabel =
    phase === 'exploring'
      ? '探索中'
      : phase === 'planning'
        ? '规划中'
        : phase === 'verifying' || phase === 'repairing'
          ? '试跑中'
          : session?.status === 'written'
            ? '已写入'
            : session?.status === 'explored'
              ? '已探索'
              : session?.status === 'failed'
                ? '失败'
                : session?.id
                  ? '草稿'
                  : '未开始';

  const sessionOptions = useMemo<SelectOption[]>(() => {
    if (!genSessionList.length) return [{ value: '', label: '暂无会话', muted: true }];
    const opts = genSessionList.map((item) => ({
      value: item.id,
      label: displayOrchestrateTitle(item.title || item.id).slice(0, 40),
    }));
    // 当前选中若不在列表（同步间隙），临时补一项避免下拉空白
    if (session?.id && !opts.some((o) => o.value === session.id)) {
      opts.unshift({
        value: session.id,
        label: displayOrchestrateTitle(session.title || session.id).slice(0, 40),
      });
    }
    return opts;
  }, [genSessionList, session?.id, session?.title]);

  return (
    // 捞草稿期间挂 busy：有刷新缓存时让缓存继续占位，别先闪一版默认内容
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-(--tw-surface-page)"
      aria-busy={restoring ? 'true' : undefined}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-(--tw-border) bg-(--tw-surface-panel) px-2.5 py-1.5">
        <div className="flex min-w-0 max-w-[260px] flex-1 items-center gap-1.5">
          <span className="shrink-0 text-[11px] text-(--tw-label-tertiary)">会话</span>
          <SelectDropdown
            options={sessionOptions}
            value={session?.id || ''}
            onChange={(next) => {
              if (next) void onSwitchGenSession(next);
            }}
            disabled={busy || restoring || !genSessionList.length}
            compact
            ariaLabel="生成会话"
            className="min-w-0 flex-1"
            menuMinWidth={220}
          />
        </div>
        <button
          type="button"
          className="tw-btn tw-btn-ghost tw-btn-sm"
          disabled={busy}
          onClick={() => {
            sessionRef.current = '';
            setSession(null);
            setChatSessionId('');
            chatSessionIdRef.current = '';
            setPlan([]);
            planRef.current = [];
            setAnswer('');
            setActivity([]);
            setFiles([]);
            setConflicts([]);
            setForce(false);
            setActivePath('');
            setTreeActivePath('');
            setTreeFileContent('');
            setTreeDirty(false);
            setDirtyPaths(new Set());
            setRequirement('');
            removeViewJson(REQ_TEXT_PREF);
            // 空白草稿：标题「新会话」，不把上一条需求带过去；过程区保持空对话
            void ensureSession(true, { blank: true });
          }}
        >
          新会话
        </button>
        <span className="rounded-full bg-(--tw-accent-soft) px-2 py-0.5 text-[10px] text-[#4176e6]">
          {statusLabel}
        </span>
        {chatSessionId ? (
          <a
            href={openWorkbenchSessionUrl(chatSessionId)}
            className="text-[11px] text-[#4176e6] hover:underline"
          >
            工作台
          </a>
        ) : null}
        <button
          type="button"
          className={`ml-auto rounded-md px-1.5 py-0.5 text-[11px] ${
            filesPanelOpen ? 'tw-seg-active' : 'tw-seg-idle'
          }`}
          onClick={() => setFilesPanelOpen((v) => !v)}
        >
          文件
        </button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左：需求 + 步骤计划占满整列全高 */}
        <aside
          className="flex min-h-0 min-w-0 shrink-0 flex-col gap-2 overflow-hidden bg-(--tw-surface-panel) px-2.5 py-2"
          style={{ width: sideWidth }}
        >
          {/* 需求框高度是「上限」：空间不够时先让这一格收窄，步骤计划不会被挤没 */}
          <div className="flex min-h-[104px] shrink flex-col">
            {/*
            标题右侧一条「运行配置」摘要：语言 / 浏览器 / 地址都是探索前的旁路配置，
            收进同一弹层，主路径（写需求 → 生成 → 探索）不被三个控件打断。
          */}
            <div className="mb-1 flex min-w-0 items-center gap-1.5">
              <label htmlFor="ui-gen-req" className="shrink-0 text-xs font-medium text-stone-600">
                需求 / 步骤
              </label>
              <div className="relative ml-auto min-w-0" ref={envPopRef}>
                <button
                  type="button"
                  className={`inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[11px] transition-colors ${
                    addrOpen
                      ? 'bg-[#e8f0fe] text-[#3566d0]'
                      : envCustomized
                        ? 'text-amber-800 hover:bg-amber-50'
                        : 'text-stone-500 hover:bg-stone-100'
                  }`}
                  aria-expanded={addrOpen}
                  aria-haspopup="dialog"
                  aria-label={`运行配置：${runConfigLabel}`}
                  onClick={() => setAddrOpen((open) => !open)}
                >
                  <span className="truncate">{runConfigLabel}</span>
                  {envCustomized ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                      aria-label="已改过探测值"
                    />
                  ) : null}
                </button>
                {addrOpen ? (
                  <div
                    role="dialog"
                    aria-label="运行配置"
                    className="absolute right-0 top-[calc(100%+6px)] z-30 w-[min(300px,calc(100vw-48px))] rounded-lg border border-stone-200 bg-white p-3 shadow-[0_8px_24px_rgba(15,23,42,0.12)]"
                  >
                    <div className="space-y-3">
                      <div>
                        <span className="mb-1 block text-[11px] text-stone-500">目标语言</span>
                        {canSwitchTarget ? (
                          <SelectDropdown
                            options={targetChoices.options}
                            value={target}
                            onChange={(next) => void onSwitchTarget(next)}
                            compact
                            ariaLabel="目标语言"
                            className="w-full"
                          />
                        ) : (
                          <p className="px-0.5 text-xs text-stone-400">
                            {targetChoices.options[0]?.label || target}
                          </p>
                        )}
                      </div>
                      <div>
                        <span className="mb-1 block text-[11px] text-stone-500">浏览器</span>
                        <div className="inline-flex h-8 w-full items-center rounded-lg border border-stone-200 bg-white p-0.5">
                          <button
                            type="button"
                            className={`flex-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                              headed ? 'tw-seg-active' : 'tw-seg-idle'
                            }`}
                            onClick={() => setHeaded(true)}
                          >
                            有头
                          </button>
                          <button
                            type="button"
                            className={`flex-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                              !headed ? 'tw-seg-active' : 'tw-seg-idle'
                            }`}
                            onClick={() => setHeaded(false)}
                          >
                            无头
                          </button>
                        </div>
                        <p className="mt-1 text-[10px] leading-4 text-stone-400">
                          {headed ? '开窗口可围观，方便手动登录' : '无界面更快，适合已有登录态'}
                        </p>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <span className="block text-[11px] text-stone-500">过程截图</span>
                          <p className="mt-0.5 text-[10px] leading-4 text-stone-400">
                            探索不依赖图；开了才截并显示在右侧
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={processShots}
                          aria-label="过程截图"
                          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
                            processShots ? 'bg-[#4176e6]' : 'bg-stone-200'
                          }`}
                          onClick={() => setProcessShots((on) => !on)}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                              processShots ? 'translate-x-4' : ''
                            }`}
                          />
                        </button>
                      </div>
                      <div>
                        <span className="mb-1 block text-[11px] text-stone-500">起始地址</span>
                        <input
                          id="ui-gen-base"
                          className={`${INPUT} font-mono`}
                          value={baseURL}
                          onChange={(event) => setBaseURL(event.target.value)}
                          placeholder="http://localhost:5173"
                          spellCheck={false}
                          aria-label="起始地址"
                        />
                        {detectedBaseURL ? (
                          <p className="mt-1 text-[10px] leading-4 text-stone-400">
                            项目配置里读到：
                            <button
                              type="button"
                              className="ml-1 font-mono text-[#4176e6] hover:underline"
                              onClick={() => setBaseURL(detectedBaseURL)}
                              disabled={baseURL === detectedBaseURL}
                            >
                              {detectedBaseURL}
                            </button>
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <span className="mb-1 block text-[11px] text-stone-500">登录态文件</span>
                        <input
                          id="ui-gen-storage"
                          className={`${INPUT} font-mono`}
                          value={storageState}
                          onChange={(event) => setStorageState(event.target.value)}
                          placeholder="留空自动检测；填 - 不用"
                          spellCheck={false}
                          aria-label="登录态文件"
                        />
                        {detectedStorageState ? (
                          <p className="mt-1 text-[10px] leading-4 text-stone-400">
                            项目里找到：
                            <button
                              type="button"
                              className="ml-1 font-mono text-[#4176e6] hover:underline"
                              onClick={() => setStorageState(detectedStorageState)}
                              disabled={storageState === detectedStorageState}
                            >
                              {detectedStorageState}
                            </button>
                          </p>
                        ) : storageState === '-' ? (
                          <p className="mt-1 text-[10px] leading-4 text-stone-400">
                            按未登录身份跑，不加载 cookie
                          </p>
                        ) : storageState ? (
                          <p className="mt-1 text-[10px] leading-4 text-stone-400">
                            项目里没找到这个文件，跑之前会再确认一次；找不到就按未登录身份跑
                          </p>
                        ) : (
                          <p className="mt-1 text-[10px] leading-4 text-stone-400">
                            项目里没找到登录态文件：会以未登录身份打开，探索中可以点「手动登录」
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            {/* 高度由下方把手控制：包一层定高 + overflow-hidden，textarea 永远不会压到下面的控件 */}
            <div
              className={`min-h-0 flex-1 overflow-hidden rounded-lg border border-stone-200 bg-white transition-colors focus-within:border-[#4176e6] ${
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
                  Math.min(
                    max,
                    Math.max(REQ_MIN, drag.startHeight + (event.clientY - drag.startY)),
                  ),
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

          {/* 动作条只留生成分段 + 开始探索；运行配置在标题摘要里 */}
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
            <button
              type="button"
              className={`${canStop ? BTN_STOP : BTN_PRIMARY} ml-auto min-w-[104px] justify-center`}
              onClick={() => {
                if (canStop) {
                  onStop();
                  return;
                }
                if (canContinueExplore) {
                  onContinueExplore();
                  return;
                }
                void onGenerate();
              }}
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
                  {canContinueExplore ? '继续探索' : '开始探索'}
                </>
              )}
            </button>
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
          className="w-1 shrink-0 cursor-col-resize touch-none bg-(--tw-border) transition-colors hover:bg-[#4176e6]/40"
          onPointerDown={(event) => {
            sideDragRef.current = { startX: event.clientX, startWidth: sideWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = sideDragRef.current;
            if (!drag) return;
            setSideWidth(
              Math.min(
                SIDE_MAX,
                Math.max(SIDE_MIN, drag.startWidth + (event.clientX - drag.startX)),
              ),
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
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stone-100 px-3">
              {STAGES.map((item) => {
                const muted =
                  (item.value === 'verify' && !canDebug) ||
                  (item.value === 'code' && !writeFiles.length && !session?.ir?.steps?.length) ||
                  (item.value === 'changes' && !changes.length && !session?.savedPath);
                return (
                  <button
                    key={item.value}
                    type="button"
                    className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                      stage === item.value
                        ? 'tw-seg-active'
                        : muted
                          ? 'tw-seg-idle text-stone-300 hover:text-stone-500'
                          : 'tw-seg-idle'
                    }`}
                    onClick={() => goStage(item.value)}
                  >
                    {item.value === 'changes' && changes.length
                      ? `${item.label} ${changes.length}`
                      : item.value === 'verify' && verify
                        ? verify.passed
                          ? `${item.label} · 通过`
                          : `${item.label} · 失败`
                        : item.label}
                  </button>
                );
              })}
              <div className="ml-auto flex min-w-0 shrink items-center gap-2">
                {statusText ? (
                  <span className="shrink-0 text-[10px] text-stone-400">{statusText}</span>
                ) : null}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {stage === 'process' ? (
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                    {restoring ? (
                      <PaneSkeleton rows={4} />
                    ) : (
                      <UiAutoOrchestratePanel
                        chatSessionId={chatSessionId}
                        projectDir={project.dir}
                        projectName={project.name}
                      />
                    )}
                  </div>
                  {processShots && shot ? (
                    <div className="flex shrink-0 border-l border-stone-100 bg-stone-50/70">
                      {shotPaneOpen ? (
                        <aside className="flex w-[136px] shrink-0 flex-col gap-1.5 overflow-y-auto p-2">
                          <span className="shrink-0 text-[10px] leading-none text-stone-400">
                            最近截图
                          </span>
                          <div className="group relative">
                            <button
                              type="button"
                              onClick={() => setShotPreviewOpen(true)}
                              className="relative block w-full overflow-hidden rounded-md border border-stone-200 bg-white text-left outline-none transition-colors hover:border-[#4176e6]/50 focus-visible:ring-2 focus-visible:ring-[#4176e6]/35"
                            >
                              <img
                                src={shot}
                                alt="最近一步截图"
                                className="max-h-[min(42vh,280px)] w-full object-contain object-top"
                              />
                              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-stone-900/55 to-transparent px-1.5 pb-1 pt-4 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                                点击放大
                              </span>
                            </button>
                            <button
                              type="button"
                              aria-label="删除截图缓存"
                              disabled={shotDeleting}
                              className="absolute top-1 right-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-stone-900/55 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4176e6]/35 disabled:opacity-40"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                const parsed = parseShotUrl(shot);
                                if (!parsed) {
                                  setShot('');
                                  setShotPreviewOpen(false);
                                  return;
                                }
                                setShotDeleting(true);
                                void deleteShot(parsed.sessionId, parsed.file)
                                  .catch(() => undefined)
                                  .finally(() => {
                                    setShot('');
                                    setShotPreviewOpen(false);
                                    setShotDeleting(false);
                                  });
                              }}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                className="h-3 w-3"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                aria-hidden="true"
                              >
                                <path d="M18 6 6 18M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </aside>
                      ) : null}
                      <button
                        type="button"
                        aria-label={shotPaneOpen ? '收起截图栏' : '展开截图栏'}
                        aria-expanded={shotPaneOpen}
                        className="flex w-4 shrink-0 items-center justify-center self-stretch text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#4176e6]/30"
                        onClick={() => setShotPaneOpen((open) => !open)}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className={`h-3.5 w-3.5 transition-transform duration-200 ${
                            shotPaneOpen ? '' : 'rotate-180'
                          }`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="m9 6 6 6-6 6" />
                        </svg>
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {stage === 'code' ? (
                restoring ? (
                  <PaneSkeleton rows={5} />
                ) : treeActivePath &&
                  !writeFiles.some(
                    (f) => f.path === treeActivePath || f.suggestedPath === treeActivePath,
                  ) ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex shrink-0 items-center gap-2 border-b border-stone-100 px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-stone-600">
                        {treeActivePath}
                      </span>
                      {treeActivePath.split('/')[0] === '.lantern-ai' ? (
                        <>
                          <button
                            type="button"
                            className={BTN_GHOST}
                            disabled={!treeDirty}
                            onClick={() => void onDiscardTreeEdit()}
                          >
                            放弃修改
                          </button>
                          <button
                            type="button"
                            className="tw-btn tw-btn-primary tw-btn-sm"
                            disabled={!treeDirty}
                            onClick={() => void onSaveTreeFile()}
                          >
                            保存草稿
                          </button>
                        </>
                      ) : (
                        <span className="text-[10px] text-stone-400">
                          正式文件只读；改动请走写入
                        </span>
                      )}
                    </div>
                    <textarea
                      value={treeFileContent}
                      readOnly={treeActivePath.split('/')[0] !== '.lantern-ai'}
                      onChange={(e) => {
                        if (treeActivePath.split('/')[0] !== '.lantern-ai') return;
                        setTreeFileContent(e.target.value);
                        setTreeDirty(true);
                        setDirtyPaths((prev) => new Set(prev).add(treeActivePath));
                      }}
                      className="min-h-0 flex-1 resize-none border-0 bg-stone-50/50 p-3 font-mono text-[11px] leading-5 text-stone-700 outline-none"
                      spellCheck={false}
                    />
                  </div>
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
                          const checked = selectedWritePaths[file.path] !== false;
                          return (
                            <li key={file.path}>
                              <div
                                className={`flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 transition-colors ${
                                  active ? 'bg-[#e8f0fe]' : 'hover:bg-stone-50'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  className="mt-1 shrink-0"
                                  checked={checked}
                                  onChange={() => toggleWritePath(file.path)}
                                  onClick={(event) => event.stopPropagation()}
                                  aria-label={`选择写入 ${baseName(file.path)}`}
                                />
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
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
                                <button
                                  type="button"
                                  className="mt-0.5 shrink-0 rounded px-1 text-[10px] text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                                  onClick={() => removeWritePaths([file.path])}
                                >
                                  移出
                                </button>
                              </div>
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
                          disabled={busy || !selectedWriteFiles.length}
                        >
                          写入 {selectedWriteFiles.length} 个文件
                        </button>
                        <button
                          type="button"
                          className={`${BTN_BASE} w-full justify-center border border-transparent text-stone-500 hover:border-stone-200 hover:bg-stone-50 hover:text-stone-700 disabled:opacity-40`}
                          onClick={onCancelWrite}
                          disabled={busy || !selectedWriteFiles.length}
                        >
                          取消选中写入
                          {selectedWriteFiles.length ? `（${selectedWriteFiles.length}）` : ''}
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

              {stage === 'changes' ? (
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
              {stage === 'verify' ? (
                canDebug ? (
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
                ) : (
                  <div className="flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-stone-400">
                    先完成探索并提交步骤后，再在这里试跑草稿脚本
                  </div>
                )
              ) : null}
            </div>
          </section>

          {/* 下：日志 / 控制台 / 网络。工具栏左 Tab、正中展开/收起；顶边整条可拖高度 */}
          <section
            className={`relative flex shrink-0 flex-col overflow-hidden border-t border-stone-200 bg-white ${
              panelDragging ? '' : 'transition-[height] duration-200 ease-out'
            }`}
            style={{
              height: panelCollapsed && !panelDragging ? COLLAPSED_PANEL : panelHeight,
            }}
          >
            {/* 顶边拖拽热区：收起时叠在工具栏上，展开时单独占一行细条 */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="拖动调整底部面板高度"
              className={
                panelCollapsed && !panelDragging
                  ? 'absolute inset-x-0 top-0 z-10 h-2 cursor-row-resize touch-none'
                  : 'h-1 shrink-0 cursor-row-resize touch-none bg-stone-100/80 transition-colors hover:bg-[#4176e6]/25'
              }
              onPointerDown={onPanelDragStart}
              onPointerMove={onPanelDragMove}
              onPointerUp={onPanelDragEnd}
              onPointerCancel={onPanelDragCancel}
            />

            <div
              className={`relative flex h-9 shrink-0 items-center px-1.5 ${
                panelCollapsed ? '' : 'border-b border-stone-100'
              }`}
            >
              <div className="flex min-w-0 items-center gap-0.5">
                {BOTTOM_TABS.map((item) => {
                  const count =
                    item.value === 'log'
                      ? visibleActivity.length
                      : item.value === 'console'
                        ? consoleLines.length
                        : item.value === 'network'
                          ? netRows.length
                          : 0;
                  const active = bottomTab === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition-colors ${
                        active ? 'tw-seg-active' : 'tw-seg-idle'
                      }`}
                      onClick={() => goBottom(item.value)}
                    >
                      <span>{item.label}</span>
                      {count ? (
                        <span
                          className={`min-w-[1.1rem] rounded-full px-1 text-center text-[10px] tabular-nums leading-4 ${
                            active
                              ? 'bg-[#4176e6]/12 text-[#4176e6]'
                              : 'bg-stone-100 text-stone-500'
                          }`}
                        >
                          {Math.min(count, 99)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                aria-label={panelCollapsed ? '展开底部面板' : '收起底部面板'}
                aria-expanded={!panelCollapsed}
                className="absolute left-1/2 top-1/2 z-[1] flex h-7 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4176e6]/30"
                onClick={togglePanel}
              >
                <svg
                  viewBox="0 0 24 24"
                  className={`h-3.5 w-3.5 transition-transform duration-200 ${
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
                {bottomTab === 'log' ? (
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-1.5">
                    {restoring ? (
                      <PaneSkeleton rows={4} />
                    ) : !planNarrative && !exploreNarrative && visibleActivity.length === 0 ? (
                      <p className="py-6 text-center text-xs leading-relaxed text-stone-400">
                        生成步骤的说明与过程日志会显示在这里
                      </p>
                    ) : (
                      <>
                        {/* 对齐会话「思考」：默认收起，折叠态一行预览最新动作 */}
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 py-1 text-left select-none"
                          onClick={() => setProcessLogOpen((open) => !open)}
                        >
                          {processLogLive ? (
                            <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-purple-400 border-t-transparent animate-spin" />
                          ) : (
                            <svg
                              viewBox="0 0 24 24"
                              className="h-3.5 w-3.5 shrink-0 text-stone-400"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
                              <path d="M9 18h6" />
                              <path d="M10 22h4" />
                            </svg>
                          )}
                          <span
                            className={`shrink-0 text-[13px] font-medium ${
                              processLogLive ? 'text-shimmer' : 'text-shimmer-static'
                            }`}
                          >
                            {processLogLive
                              ? phase === 'planning'
                                ? '规划中…'
                                : '探索中…'
                              : '过程日志'}
                          </span>
                          <svg
                            viewBox="0 0 24 24"
                            className={`h-3.5 w-3.5 shrink-0 text-stone-400 transition-transform ${
                              processLogOpen ? 'rotate-180' : ''
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
                          {!processLogOpen && processLogPreview ? (
                            <span
                              className={`min-w-0 flex-1 truncate text-[12px] ${
                                processLogLive ? 'text-shimmer-muted' : 'text-stone-400'
                              }`}
                            >
                              {processLogPreview}
                            </span>
                          ) : null}
                        </button>
                        {processLogOpen ? (
                          <div
                            ref={activityRef}
                            className="min-h-0 flex-1 overflow-auto pb-2"
                            onScroll={(event) => {
                              const el = event.currentTarget;
                              activityStickRef.current =
                                el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                            }}
                          >
                            {planNarrative ? (
                              <div className="min-w-0">
                                <p className="mb-1.5 text-[10px] leading-none text-stone-400">
                                  步骤说明
                                </p>
                                <div
                                  className="chat-md prose prose-sm prose-stone max-w-none text-stone-600"
                                  style={{ fontSize: 11, lineHeight: 1.7 }}
                                  onClick={onNarrativeClick}
                                  dangerouslySetInnerHTML={{
                                    __html: renderMarkdown(planNarrative),
                                  }}
                                />
                              </div>
                            ) : null}
                            {visibleActivity.length ? (
                              <div
                                className={
                                  planNarrative ? 'mt-3 border-t border-stone-100 pt-3' : ''
                                }
                              >
                                <ul className="space-y-1.5">
                                  {visibleActivity.map((item) => {
                                    const detail = activityDisplayDetail(item);
                                    return (
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
                                            <span className="text-stone-700">
                                              {activityDisplayName(item)}
                                            </span>
                                            {detail ? (
                                              <p className="mt-0.5 max-h-16 overflow-hidden break-all text-[11px] leading-relaxed text-stone-400">
                                                {detail}
                                              </p>
                                            ) : null}
                                          </div>
                                        </div>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            ) : null}
                            {exploreNarrative ? (
                              <div
                                className={
                                  planNarrative || visibleActivity.length
                                    ? 'mt-3 border-t border-stone-100 pt-3'
                                    : ''
                                }
                              >
                                <p className="mb-1.5 text-[10px] leading-none text-stone-400">
                                  探索小结
                                </p>
                                <div
                                  className="chat-md prose prose-sm prose-stone max-w-none text-stone-600"
                                  style={{ fontSize: 11, lineHeight: 1.7 }}
                                  onClick={onNarrativeClick}
                                  dangerouslySetInnerHTML={{
                                    __html: renderMarkdown(exploreNarrative),
                                  }}
                                />
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}

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
                      <p className="py-6 text-center text-xs text-stone-400">
                        暂无控制台错误 / 警告
                      </p>
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
              </div>
            )}
          </section>
        </div>

        <div
          className="flex shrink-0 overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{ width: filesPanelOpen ? filesWidth + 4 : 0 }}
          aria-hidden={!filesPanelOpen}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文件栏宽度"
            className={`w-1 shrink-0 touch-none bg-(--tw-border) transition-colors hover:bg-[#4176e6]/40 ${
              filesPanelOpen ? 'cursor-col-resize' : 'pointer-events-none'
            }`}
            onPointerDown={(event) => {
              if (!filesPanelOpen) return;
              filesDragRef.current = { startX: event.clientX, startWidth: filesWidth };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = filesDragRef.current;
              if (!drag) return;
              const next = Math.min(
                FILES_WIDTH_MAX,
                Math.max(FILES_WIDTH_MIN, drag.startWidth - (event.clientX - drag.startX)),
              );
              setFilesWidth(next);
              writeViewText(FILES_WIDTH_PREF, String(next));
            }}
            onPointerUp={(event) => {
              filesDragRef.current = null;
              try {
                event.currentTarget.releasePointerCapture(event.pointerId);
              } catch {
                /* ignore */
              }
            }}
            onPointerCancel={() => {
              filesDragRef.current = null;
            }}
          />
          <aside
            className="h-full min-w-0 shrink-0 overflow-hidden border-l border-(--tw-border)"
            style={{ width: filesWidth }}
          >
            <UiAutoProjectFiles
              projectId={project.id}
              activePath={treeActivePath || activePath}
              dirtyPaths={dirtyPaths}
              refreshKey={filesRefreshKey}
              onOpenFile={(path) => void onOpenTreeFile(path)}
            />
          </aside>
        </div>
      </div>

      <PmImagePreview
        file={shotPreviewOpen && shot ? { url: shot, name: '最近一步截图' } : null}
        onClose={() => setShotPreviewOpen(false)}
      />
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
