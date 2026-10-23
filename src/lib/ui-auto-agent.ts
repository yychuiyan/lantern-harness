/**
 * AI 生成 UI 自动化脚本：前端接口 + 给模型用的工具定义。
 *
 * 探索在服务端子进程里做（见 lh-plugins/uiauto-explorer），前端只负责：
 * - 把工具调用转成 HTTP 请求
 * - 把活动轨迹与代码预览呈现给用户
 * - 生成后自动试跑、失败时让模型只改步骤 IR
 */
import type { ToolDef } from './llm';
import { UI_AUTO_API, type UiAutoProject } from './ui-auto';

export const UI_AUTO_AGENT_API = `${UI_AUTO_API}/agent`;

export type UiTestTarget = 'ts' | 'python';

export type UiLocatorKind = 'testid' | 'role' | 'label' | 'placeholder' | 'text' | 'attr' | 'css';

export interface UiTestLocator {
  kind: UiLocatorKind;
  role?: string;
  name?: string;
  value?: string;
  attr?: string;
  exact?: boolean;
  /** 同名元素有多个时取第几个（0 = 第一个） */
  nth?: number;
}

export interface UiTestStep {
  action:
    | 'goto'
    | 'click'
    | 'fill'
    | 'select'
    | 'press'
    | 'hover'
    | 'expect'
    | 'expectUrl'
    | 'wait'
    | 'screenshot';
  locator?: UiTestLocator;
  url?: string;
  value?: string;
  key?: string;
  text?: string;
  state?: 'visible' | 'hidden';
  ms?: number;
  note?: string;
  /** 对应左侧计划里的步骤 id，仅用于对齐展示，出码时忽略 */
  planStepId?: string;
}

/* ------------------------------ 计划 ------------------------------ */

export type UiPlanStatus = 'pending' | 'bound' | 'done' | 'failed';

/**
 * 步骤计划：先写「做什么」，定位器由探索时 probe 回填。
 * 这样用户能改顺序 / 描述，模型也不用凭想象编定位器。
 */
export interface UiPlanStep {
  id: string;
  action: UiTestStep['action'];
  target: string;
  value?: string;
  url?: string;
  note?: string;
  status: UiPlanStatus;
  locator?: UiTestLocator;
  warning?: string;
}

/* ------------------------------ 变更 ------------------------------ */

export interface UiChangeHunkLine {
  type: 'equal' | 'add' | 'del';
  text: string;
}

export interface UiChangeHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: UiChangeHunkLine[];
}

export interface UiChangeEntry {
  path: string;
  /** create 新建 / merge 在已有文件里追加 / update 整文件改动 */
  kind: 'create' | 'merge' | 'update';
  at: string;
  added: number;
  removed: number;
  before?: string;
  after?: string;
  hunks?: UiChangeHunk[];
  truncated?: boolean;
  message?: string;
}

export interface UiDraftSummary {
  draftRoot: string;
  draftDir: string;
  artifactDir: string;
  configPath: string;
  exists: boolean;
  hasSteps: boolean;
  tracePath: string;
}

export interface UiGitSummary {
  ok: boolean;
  entries: Array<{ code: string; path: string }>;
  truncated: boolean;
  filtered?: number;
}

export interface UiTestIr {
  title: string;
  target: UiTestTarget;
  baseURL?: string;
  storageState?: string;
  source?: string;
  steps: UiTestStep[];
}

export interface UiGenVerify {
  at: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  log: string;
}

export interface UiGenSession {
  id: string;
  projectId: string;
  title: string;
  target: UiTestTarget;
  baseURL: string;
  storageState: string;
  source: string;
  headed: boolean;
  status: string;
  ir: UiTestIr | null;
  plan?: UiPlanStep[];
  changes?: UiChangeEntry[];
  savedPath?: string;
  /** 批量写入后落盘的全部文件；savedPath 是其中主用例 */
  savedPaths?: string[];
  lastVerify?: UiGenVerify;
  /** 上次探索的活动日志（服务端只留最近 200 条） */
  activity?: Array<{
    kind: string;
    name: string;
    detail: string;
    status: string;
    at?: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface UiSnapshotResult {
  url: string;
  title: string;
  count: number;
  truncated: boolean;
  snapshot: string;
}

export interface UiProbeCandidate {
  locator: UiTestLocator;
  source: string;
  count: number;
  unique: boolean;
  same: boolean;
}

export interface UiProbeResult {
  ref: string;
  element: Record<string, unknown>;
  recommended: UiTestLocator | null;
  confidence: 'high' | 'medium' | 'low';
  fragile?: boolean;
  warning?: string;
  candidates: UiProbeCandidate[];
  /** 带 stepId 探测时，后端回写的整份计划与这一步 */
  plan?: UiPlanStep[] | null;
  planStep?: UiPlanStep | null;
}

export interface UiVerifyResult {
  ok?: boolean;
  error?: string;
  passed?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  command?: string;
  draftPath?: string;
  configPath?: string;
  artifactDir?: string;
  draftRoot?: string;
  tracePath?: string;
  code?: string;
  log?: string;
  suggestedPath?: string;
}

export interface UiWriteResult {
  ok: boolean;
  error?: string;
  exists?: boolean;
  path?: string;
  code?: string;
  filename?: string;
  changes?: UiChangeEntry[];
  suggestedPath?: string;
  /** 本次写入的文件（含 role），批量写入时有多条 */
  files?: Array<{ path: string; kind: 'create' | 'merge' | 'update' | 'unchanged'; role?: string }>;
  paths?: string[];
  savedPaths?: string[];
  /** 写入结果分类：新建 / 合并进已有文件 / 覆盖 / 内容没变 */
  summary?: { created: number; merged: number; updated: number; unchanged: number };
  /** 冲突清单：已存在且没勾覆盖 */
  conflicts?: Array<{ path: string; exists: boolean }>;
}

export interface UiDebugResult {
  ok: boolean;
  error?: string;
  mode?: 'headed' | 'ui';
  passed?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  command?: string;
  log?: string;
  url?: string;
  ready?: boolean;
  note?: string;
  draftPath?: string;
  configPath?: string;
  artifactDir?: string;
  draftRoot?: string;
  tracePath?: string;
}

export interface UiRunFileResult {
  ok: boolean;
  error?: string;
  checked?: boolean;
  passed?: boolean;
  excluded?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  command?: string;
  path?: string;
  log?: string;
  note?: string;
}

export interface UiChangesResult {
  ok: boolean;
  changes: UiChangeEntry[];
  git: UiGitSummary;
  draft: UiDraftSummary;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${UI_AUTO_AGENT_API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message =
      (json && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : '') ||
      text.slice(0, 300) ||
      `请求失败（${res.status}）`;
    throw new Error(message);
  }
  return (json ?? {}) as T;
}

export interface UiPrepareParams {
  projectId: string;
  title: string;
  target: UiTestTarget;
  baseURL: string;
  storageState: string;
  source: string;
  headed: boolean;
  /** 传了就复用这个会话（改计划 / 重新规划都不用新开会话） */
  sessionId?: string;
  plan?: UiPlanStep[];
  /** 重新规划 / 重新探索：清掉上一轮的步骤、试跑结果与活动日志，避免旧内容当新产出 */
  reset?: boolean;
}

/**
 * 建 / 复用生成会话，但不启动浏览器。
 * 规划步骤、手改计划都先落在这上面；真正开始探索时浏览器才拉起。
 */
export async function prepareGeneration(
  params: UiPrepareParams,
): Promise<{ session: UiGenSession; suggestedPath: string; draft: UiDraftSummary }> {
  return request('/prepare', { method: 'POST', body: JSON.stringify(params) });
}

export async function startGeneration(params: {
  projectId: string;
  title: string;
  target: UiTestTarget;
  baseURL: string;
  storageState: string;
  source: string;
  headed: boolean;
}): Promise<{ session: UiGenSession; suggestedPath: string }> {
  return request('/start', { method: 'POST', body: JSON.stringify(params) });
}

export async function openBrowser(sessionId: string, url: string): Promise<UiSnapshotResult> {
  return request('/open', { method: 'POST', body: JSON.stringify({ sessionId, url }) });
}

export async function snapshotPage(
  sessionId: string,
  options: { depth?: number; targetRef?: string } = {},
): Promise<UiSnapshotResult> {
  return request('/snapshot', { method: 'POST', body: JSON.stringify({ sessionId, ...options }) });
}

export async function browserAction(
  sessionId: string,
  params: {
    action: string;
    ref?: string;
    text?: string;
    value?: string;
    key?: string;
    note?: string;
    snapshot?: boolean;
  },
): Promise<UiSnapshotResult & { action: string }> {
  return request('/action', { method: 'POST', body: JSON.stringify({ sessionId, ...params }) });
}

export async function waitForPage(
  sessionId: string,
  options: { text?: string; ms?: number; timeout?: number } = {},
): Promise<UiSnapshotResult & { action: string }> {
  return request('/wait', { method: 'POST', body: JSON.stringify({ sessionId, ...options }) });
}

export async function fetchConsole(
  sessionId: string,
): Promise<{ messages: Array<{ type: string; text: string }> }> {
  return request('/console', { method: 'POST', body: JSON.stringify({ sessionId }) });
}

export async function fetchNetwork(sessionId: string): Promise<{
  requests: Array<{ status: number; url: string; method: string; failure?: string }>;
}> {
  return request('/network', { method: 'POST', body: JSON.stringify({ sessionId }) });
}

export async function probeRef(
  sessionId: string,
  ref: string,
  stepId?: string,
): Promise<UiProbeResult> {
  return request('/probe', {
    method: 'POST',
    body: JSON.stringify({ sessionId, ref, stepId }),
  });
}

export async function takeScreenshot(
  sessionId: string,
  label: string,
): Promise<{ url: string; file: string; bytes: number }> {
  return request('/screenshot', { method: 'POST', body: JSON.stringify({ sessionId, label }) });
}

export async function closeBrowser(sessionId: string): Promise<void> {
  await request('/close', { method: 'POST', body: JSON.stringify({ sessionId }) });
}

export async function saveGeneration(params: {
  sessionId: string;
  title?: string;
  target?: UiTestTarget;
  baseURL?: string;
  source?: string;
  ir?: UiTestIr;
  plan?: UiPlanStep[];
  status?: string;
  /** 探索活动日志：刷新 / 切走再回来还能看到过程 */
  activity?: Array<{ kind: string; name: string; detail: string; status: string; at?: string }>;
  /** 计划按「模型只补定位器、用户内容优先」合并，不整份覆盖 */
  mergePlan?: boolean;
  /** 允许把计划存成空数组（用户把步骤全删了才带）；默认空计划不落盘 */
  allowEmptyPlan?: boolean;
  /** 活动日志整份替换（只有「清除活动日志」用），默认按时间合并追加 */
  replaceActivity?: boolean;
}): Promise<{ session: UiGenSession; code: string; filename: string; suggestedPath: string }> {
  return request('/save', { method: 'POST', body: JSON.stringify(params) });
}

export async function emitGeneration(
  ir: UiTestIr,
  target: UiTestTarget,
  options: { testDir?: string; hasBaseURL?: boolean } = {},
): Promise<{
  code: string;
  filename: string;
  language: string;
  files: UiEmitFile[];
  configPatch: { path: string; reason: string; snippet: string } | null;
}> {
  return request('/emit', { method: 'POST', body: JSON.stringify({ ir, target, ...options }) });
}

export async function verifyGeneration(
  sessionId: string,
  ir?: UiTestIr,
  target?: UiTestTarget,
): Promise<UiVerifyResult> {
  return request('/verify', {
    method: 'POST',
    body: JSON.stringify({ sessionId, ir, target, timeoutMs: 180000 }),
  });
}

export async function writeGeneration(params: {
  sessionId: string;
  /** 不传时后端按会话实时出码（含 page object），写入整组文件 */
  files?: Array<{ path: string; content: string; force?: boolean; role?: string }>;
  /** 兼容旧的单文件写入：等价于 files 只有一条 */
  path?: string;
  force?: boolean;
}): Promise<UiWriteResult> {
  return request('/write', { method: 'POST', body: JSON.stringify(params) });
}

export async function fetchGenerationSessions(
  projectId: string,
): Promise<{ sessions: Array<Partial<UiGenSession> & { id: string }> }> {
  return request(`/sessions?projectId=${encodeURIComponent(projectId)}`);
}

export async function fetchGenerationSession(id: string): Promise<{
  session: UiGenSession;
  code: string;
  filename: string;
  suggestedPath: string;
  exploring: boolean;
  debugging?: boolean;
  changes?: UiChangeEntry[];
  draft?: UiDraftSummary | null;
}> {
  return request(`/session?id=${encodeURIComponent(id)}`);
}

export async function deleteGeneration(id: string): Promise<void> {
  await request(`/session?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 调试运行：headed 跑一遍留 trace；ui 拉起 Playwright UI（长驻，需 stopDebug） */
export async function debugGeneration(
  sessionId: string,
  mode: 'headed' | 'ui',
): Promise<UiDebugResult> {
  return request('/debug', { method: 'POST', body: JSON.stringify({ sessionId, mode }) });
}

export async function stopDebug(sessionId: string): Promise<{ ok: boolean; stopped: boolean }> {
  return request('/debug/stop', { method: 'POST', body: JSON.stringify({ sessionId }) });
}

export async function fetchChanges(sessionId: string): Promise<UiChangesResult> {
  return request(`/changes?sessionId=${encodeURIComponent(sessionId)}`);
}

/** 项目工作区 git 摘要（/agent/changes 会一起返回，前端不再单独拉） */

/** 一条用例拆出的待写入文件 */
export interface UiEmitFile {
  path: string;
  content: string;
  language: string;
  /** spec 主用例 / page 页面对象 / fixture 登录态常量 */
  role: 'spec' | 'page' | 'fixture' | string;
}

/** 在系统文件管理器 / 编辑器里打开项目内路径（空 = 项目根目录） */
export async function revealPath(params: {
  projectId?: string;
  sessionId?: string;
  path?: string;
  /** 打开方式 id（来自 fetchOpenApps 的 apps[].id），缺省用后端默认应用 */
  app?: string;
  line?: number;
}): Promise<{ ok: boolean; path: string; app?: string }> {
  return request('/reveal', { method: 'POST', body: JSON.stringify(params) });
}

/* --------------------------- 打开方式 --------------------------- */

export interface UiOpenApp {
  id: string;
  label: string;
  kind: 'editor' | 'finder' | 'terminal';
  appPath?: string;
  cli?: string;
  /** 后端抽好的应用图标；没有时前端用兜底图标 */
  iconUrl?: string;
}

/** 本机真实装了的应用；同一个进程内只拉一次 */
let openAppsCache: Promise<{ apps: UiOpenApp[]; defaultId: string }> | null = null;

export async function fetchOpenApps(force = false): Promise<{
  apps: UiOpenApp[];
  defaultId: string;
}> {
  if (!openAppsCache || force) {
    openAppsCache = request<{ ok: boolean; apps: UiOpenApp[]; defaultId: string }>('/apps')
      .then((result) => ({ apps: result.apps ?? [], defaultId: result.defaultId ?? '' }))
      .catch((err) => {
        openAppsCache = null;
        throw err;
      });
  }
  return openAppsCache;
}

/** 写入后按项目真实配置再跑一次（验收） */
export async function runProjectFile(sessionId: string, path?: string): Promise<UiRunFileResult> {
  return request('/run-file', {
    method: 'POST',
    body: JSON.stringify({ sessionId, path, timeoutMs: 180000 }),
  });
}

export async function cleanDraft(
  sessionId: string,
): Promise<{ ok: boolean; draft: UiDraftSummary }> {
  return request('/draft/clean', { method: 'POST', body: JSON.stringify({ sessionId }) });
}

/* ------------------------------ 模型工具 ------------------------------ */

const refParam = { type: 'string', description: '快照里的 ref，例如 d1-e12。页面导航后会失效。' };

/**
 * 只做测试设计、不碰浏览器的工具。
 * 计划里只写「动作 + 目标描述」，定位器留给探索时 probe 现场校验。
 */
const PLAN_STEPS_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'ui_plan_steps',
    description:
      '提交整份步骤计划（人可读的动作 + 目标描述，不含定位器）。这一步只做测试设计，不会打开浏览器。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '用例标题，中文即可' },
        steps: {
          type: 'array',
          description: '按执行顺序排列的计划步骤',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'goto',
                  'click',
                  'fill',
                  'select',
                  'press',
                  'hover',
                  'expect',
                  'expectUrl',
                  'wait',
                ],
                description: '测试动作；不要写「截图」——截图是探索时给人看的，不是测试步骤',
              },
              target: {
                type: 'string',
                description: '给人看的目标描述，例如「右上角的登录按钮」「用户名输入框」',
              },
              value: {
                type: 'string',
                description: '输入内容 / 选项；账号密码等占位数据写成 ${ENV_NAME}',
              },
              url: { type: 'string', description: 'goto / expectUrl 的地址，相对路径即可' },
              note: { type: 'string', description: '补充说明，例如断言什么结果' },
            },
            required: ['action', 'target'],
          },
        },
      },
      required: ['steps'],
    },
  },
};

/** 规划步骤时只挂这一个工具，避免模型顺手去开浏览器 */
export const UI_AUTO_PLAN_TOOLS: ToolDef[] = [PLAN_STEPS_TOOL];

export const UI_AUTO_AGENT_TOOLS: ToolDef[] = [
  PLAN_STEPS_TOOL,
  {
    type: 'function',
    function: {
      name: 'ui_browser_open',
      description: '在浏览器里打开一个地址（相对地址会用 baseURL 拼接），返回页面快照。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '绝对地址或 / 开头的相对地址' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_snapshot',
      description: '重新获取当前页面快照。页面变化较大、或 ref 不确定时用。',
      parameters: {
        type: 'object',
        properties: {
          depth: { type: 'number', description: '快照深度，默认 6，越大越啰嗦' },
          targetRef: { type: 'string', description: '只看某个元素的子树' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_click',
      description: '点击一个元素。成功后会自动返回新快照。',
      parameters: {
        type: 'object',
        properties: { ref: refParam, note: { type: 'string', description: '这一步在做什么' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_fill',
      description: '填写输入框（会先清空已有内容）。',
      parameters: {
        type: 'object',
        properties: {
          ref: refParam,
          text: {
            type: 'string',
            description: '要填入的内容；占位数据用 ${ENV_NAME} 表示环境变量',
          },
          note: { type: 'string' },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_select',
      description: '选择下拉框选项（按 value 或可见文本）。',
      parameters: {
        type: 'object',
        properties: { ref: refParam, value: { type: 'string' }, note: { type: 'string' } },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_press',
      description: '按一个键，例如 Enter / Tab / Escape。',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' }, ref: { type: 'string' } },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_hover',
      description: '悬停到元素上（用于展开菜单）。',
      parameters: {
        type: 'object',
        properties: { ref: refParam, note: { type: 'string' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_back',
      description: '浏览器后退一步。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_wait',
      description:
        '等待：给 text 时等到页面出现该文案（比死等毫秒可靠），否则等待指定毫秒。返回等待后的快照。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要等待出现的可见文案' },
          ms: { type: 'number', description: '没有 text 时等待的毫秒数' },
          timeout: { type: 'number', description: '等待 text 的超时毫秒数，默认 15000' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_screenshot',
      description: '截一张当前页面图，给用户看（模型看不到图片内容）。',
      parameters: {
        type: 'object',
        properties: { label: { type: 'string', description: '截图标签，例如 after-login' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_console',
      description: '读取浏览器控制台里的 error / warning / pageerror（排查偶发失败用）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_browser_network',
      description: '读取最近的失败请求（状态码 ≥ 400 或请求失败），用来判断是不是接口挂了。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_locator_probe',
      description:
        '把一个 ref 转成可写进脚本的定位器，并校验唯一性。写步骤之前，对每个要操作的元素都调用一次。',
      parameters: {
        type: 'object',
        properties: {
          ref: refParam,
          stepId: {
            type: 'string',
            description: '可选：左侧计划里的步骤 id（如 p2）。传了会把定位器回填到该步骤。',
          },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_test_set_steps',
      description:
        '提交 / 替换整份测试步骤（IR）。每次提交都会刷新右侧代码预览。先探索、再提交，不要凭想象写定位器。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '用例标题，中文即可' },
          steps: {
            type: 'array',
            description: '按执行顺序排列的步骤',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: [
                    'goto',
                    'click',
                    'fill',
                    'select',
                    'press',
                    'hover',
                    'expect',
                    'expectUrl',
                    'wait',
                    'screenshot',
                  ],
                },
                locator: {
                  type: 'object',
                  description: '定位器。首选 ui_locator_probe 给出的 recommended，不要自己拼长 CSS',
                  properties: {
                    kind: {
                      type: 'string',
                      enum: ['testid', 'role', 'label', 'placeholder', 'text', 'attr', 'css'],
                    },
                    role: { type: 'string' },
                    name: { type: 'string' },
                    value: { type: 'string' },
                    attr: { type: 'string' },
                    exact: { type: 'boolean' },
                    nth: {
                      type: 'number',
                      description:
                        '同名元素有多个时取第几个（0 = 第一个）。用 ui_locator_probe 返回的 nth，不要自己猜',
                    },
                  },
                  required: ['kind'],
                },
                url: { type: 'string' },
                value: { type: 'string', description: '输入内容 / 选项值 / 截图名' },
                key: { type: 'string' },
                text: { type: 'string', description: 'expect 时要断言的文本' },
                state: { type: 'string', enum: ['visible', 'hidden'] },
                ms: { type: 'number' },
                note: { type: 'string' },
                planStepId: {
                  type: 'string',
                  description: '可选：对应左侧计划步骤 id，便于逐条勾掉计划',
                },
              },
              required: ['action'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_test_get_steps',
      description: '读取当前已提交的步骤，改之前先看一眼。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_test_verify',
      description: '在临时目录试跑当前步骤对应的脚本，返回是否通过和日志尾部。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export interface UiAgentToolContext {
  sessionId: string;
  target: UiTestTarget;
  onIr?: (ir: UiTestIr) => void;
  onPlan?: (plan: UiPlanStep[]) => void;
  onShot?: (url: string) => void;
  onCode?: (code: string, suggestedPath: string) => void;
}

/**
 * 浏览器被关掉后的统一口径。
 * 主进程会在用户关窗时把会话收回草稿并扔出这句；Playwright 自己抛的
 * 「Target page, context or browser has been closed」也按同一类处理。
 * 前端看到它必须直接结束这一轮，别再把错误喂回模型让它反复重试。
 */
export const BROWSER_CLOSED_MESSAGE = '浏览器已被关闭，这一轮探索已结束';

/** 工具结果里是否表示「浏览器没了」（只看 error 字段，别被页面快照里的文案误判） */
export function isBrowserClosedOutput(text: string): boolean {
  if (!text || !text.includes('error')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const error = String((parsed as { error?: unknown }).error ?? '');
  return (
    error.includes('浏览器已被关闭') ||
    error.includes('浏览器进程已退出') ||
    error.includes('Target page, context or browser has been closed')
  );
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}…（已截断）` : value;

/** 执行一条模型工具；返回值必须是字符串（写进 role=tool） */
export async function runUiAutoAgentTool(
  name: string,
  argsJson: string,
  ctx: UiAgentToolContext,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: '工具参数不是合法 JSON' });
  }
  const sessionId = ctx.sessionId;
  const str = (key: string) => (typeof args[key] === 'string' ? String(args[key]) : '');

  try {
    if (name === 'ui_plan_steps') {
      const rawSteps = Array.isArray(args.steps) ? args.steps : [];
      if (!rawSteps.length) {
        // 模型偶尔会传空数组：不能把用户已经写好的计划清空
        const current = await fetchGenerationSession(sessionId)
          .then((detail) => detail.session.plan ?? [])
          .catch(() => []);
        return JSON.stringify({
          ok: true,
          stepCount: current.length,
          plan: current.map((step) => ({ id: step.id, action: step.action, target: step.target })),
          note: '没有提交新步骤，计划保持不变。',
        });
      }
      // mergePlan：只补 status / locator，用户手改的动作与目标不被模型覆盖
      const saved = await saveGeneration({
        sessionId,
        title: str('title') || undefined,
        plan: rawSteps as UiPlanStep[],
        mergePlan: true,
      });
      const plan = saved.session.plan ?? [];
      ctx.onPlan?.(plan);
      return JSON.stringify({
        ok: true,
        stepCount: plan.length,
        plan: plan.map((step) => ({ id: step.id, action: step.action, target: step.target })),
        note: '计划已保存，用户可以在左侧调整。接下来开始探索：逐个 probe 并回填定位器。',
      });
    }

    if (name === 'ui_browser_open') {
      const result = await openBrowser(sessionId, str('url'));
      return JSON.stringify({
        url: result.url,
        title: result.title,
        elements: result.count,
        truncated: result.truncated,
        snapshot: clip(result.snapshot, 12000),
      });
    }

    if (name === 'ui_browser_snapshot') {
      const result = await snapshotPage(sessionId, {
        depth: Number(args.depth) || undefined,
        targetRef: str('targetRef') || undefined,
      });
      return JSON.stringify({
        url: result.url,
        title: result.title,
        elements: result.count,
        truncated: result.truncated,
        snapshot: clip(result.snapshot, 12000),
      });
    }

    if (
      name === 'ui_browser_click' ||
      name === 'ui_browser_fill' ||
      name === 'ui_browser_select' ||
      name === 'ui_browser_hover'
    ) {
      const action = name.replace('ui_browser_', '');
      const result = await browserAction(sessionId, {
        action,
        ref: str('ref'),
        text: str('text'),
        value: str('value'),
        note: str('note'),
      });
      return JSON.stringify({
        ok: true,
        action: result.action,
        url: result.url,
        snapshot: clip(result.snapshot, 9000),
      });
    }

    if (name === 'ui_browser_press') {
      const result = await browserAction(sessionId, {
        action: 'press',
        ref: str('ref'),
        key: str('key'),
      });
      return JSON.stringify({ ok: true, url: result.url, snapshot: clip(result.snapshot, 9000) });
    }

    if (name === 'ui_browser_back') {
      const result = await browserAction(sessionId, { action: 'back' });
      return JSON.stringify({ ok: true, url: result.url, snapshot: clip(result.snapshot, 9000) });
    }

    if (name === 'ui_browser_wait') {
      const result = await waitForPage(sessionId, {
        text: str('text') || undefined,
        ms: Number(args.ms) || undefined,
        timeout: Number(args.timeout) || undefined,
      });
      return JSON.stringify({
        ok: true,
        action: result.action,
        url: result.url,
        snapshot: clip(result.snapshot, 9000),
      });
    }

    if (name === 'ui_browser_screenshot') {
      const shot = await takeScreenshot(sessionId, str('label') || 'snapshot');
      ctx.onShot?.(shot.url);
      return JSON.stringify({
        ok: true,
        url: shot.url,
        note: '截图已显示在面板里；你看不到图片内容，需要判断结构请用快照。',
      });
    }

    if (name === 'ui_browser_console') {
      const result = await fetchConsole(sessionId);
      const messages = result.messages ?? [];
      return JSON.stringify(
        messages.length ? { count: messages.length, messages: messages.slice(-20) } : { count: 0 },
      );
    }

    if (name === 'ui_browser_network') {
      const result = await fetchNetwork(sessionId);
      const requests = result.requests ?? [];
      return JSON.stringify(
        requests.length ? { count: requests.length, requests: requests.slice(-20) } : { count: 0 },
      );
    }

    if (name === 'ui_locator_probe') {
      const ref = str('ref');
      if (!ref) return JSON.stringify({ error: '缺少 ref' });
      const stepId = str('stepId');
      const result = await probeRef(sessionId, ref, stepId || undefined);
      if (stepId && result.plan) ctx.onPlan?.(result.plan);
      return JSON.stringify({
        ref: result.ref,
        element: result.element,
        confidence: result.confidence,
        recommended: result.recommended,
        fragile: Boolean(result.fragile),
        warning: result.warning ?? '',
        candidates: result.candidates.slice(0, 3),
        boundStep: result.planStep
          ? { id: result.planStep.id, status: result.planStep.status }
          : undefined,
        note:
          result.confidence === 'high'
            ? '定位器唯一且指向同一元素，可以写进步骤'
            : result.recommended
              ? `能用但不稳：${result.warning || '同名元素较多'}。照抄 recommended（含 nth），并补一条结果断言`
              : '没有唯一候选：换一个更具体的元素，或改成对结果文案的 expect',
      });
    }

    if (name === 'ui_test_set_steps') {
      const rawSteps = Array.isArray(args.steps) ? args.steps : [];
      const ir: UiTestIr = {
        title: str('title') || '未命名流程',
        target: ctx.target,
        steps: rawSteps as UiTestStep[],
      };
      const saved = await saveGeneration({
        sessionId,
        title: ir.title,
        ir,
      });
      // 服务端会丢掉不合法的动作与缺定位器的步骤（不报错），这里一律报「实际保留」的份数：
      // 报提交条数会让模型以为都在，试跑前发现不了脚本少了步骤。
      const kept = saved.session.ir ?? ir;
      const dropped = ir.steps.length - kept.steps.length;
      ctx.onIr?.(kept);
      ctx.onCode?.(saved.code, saved.suggestedPath);
      return JSON.stringify({
        ok: true,
        title: kept.title,
        stepCount: kept.steps.length,
        previewPath: saved.suggestedPath,
        note: dropped
          ? `步骤已保存，但有 ${dropped} 步被丢掉（动作不支持或没带 locator）。用 ui_test_get_steps 核对后重新提交；不要自己试跑，试跑由用户确认代码后手动发起。`
          : '步骤已保存，右侧代码预览已刷新。不要自己试跑：试跑由用户确认代码后手动发起。',
      });
    }

    if (name === 'ui_test_get_steps') {
      const data = await fetchGenerationSession(sessionId);
      return JSON.stringify({
        title: data.session.ir?.title ?? '',
        steps: data.session.ir?.steps ?? [],
        suggestedPath: data.suggestedPath,
      });
    }

    if (name === 'ui_test_verify') {
      const result = await verifyGeneration(sessionId);
      const log = String(result.log ?? '');
      if (typeof result.code === 'string') {
        ctx.onCode?.(result.code, result.suggestedPath ?? '');
      }
      return JSON.stringify({
        passed: Boolean(result.passed),
        exitCode: result.exitCode ?? null,
        timedOut: Boolean(result.timedOut),
        durationMs: result.durationMs ?? 0,
        draftPath: result.draftPath ?? '',
        tracePath: result.tracePath ?? '',
        log: clip(log.slice(-4000), 4000),
        note: result.passed
          ? '试跑通过。草稿留在 .lantern-ai 里，用户可以直接看 trace / 用 Playwright UI 调试，确认后再写入项目。'
          : '试跑失败：只改步骤 IR（定位器 / 等待 / 断言）。草稿和 trace 会保留，用户能打开看现场；如果是功能本身不符合预期，不要为了跑绿改断言。',
      });
    }

    return JSON.stringify({ error: `未知工具：${name}` });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** 计划清单的纯文本版，探索提示词与前端展示共用一套措辞 */
export function formatPlan(plan?: UiPlanStep[]): string {
  if (!plan?.length) return '';
  return plan
    .map((step, index) => {
      const parts = [`${index + 1}. [${step.id}] ${step.action}`];
      if (step.target) parts.push(`目标：${step.target}`);
      if (step.url) parts.push(`url=${step.url}`);
      if (step.value) parts.push(`值=${step.value}`);
      if (step.locator) parts.push(`已绑定 ${formatLocator(step.locator)}`);
      return parts.join(' · ');
    })
    .join('\n');
}

/** 定位器的可读摘要，例如 role=button name="登录" */
export function formatLocator(locator?: UiTestLocator | null): string {
  if (!locator) return '';
  const nth = Number.isInteger(locator.nth) ? ` nth=${locator.nth}` : '';
  if (locator.kind === 'role') {
    return `role=${locator.role ?? ''}${locator.name ? ` name="${locator.name}"` : ''}${nth}`;
  }
  if (locator.kind === 'attr') return `[${locator.attr}="${locator.value ?? ''}"]${nth}`;
  if (locator.kind === 'testid') return `testid=${locator.value ?? ''}${nth}`;
  return `${locator.kind}="${locator.value ?? locator.name ?? ''}"${nth}`;
}

/** 目标语言在提示词里的写法 */
function languageLabel(target: UiTestTarget): string {
  return target === 'python'
    ? 'Python + pytest + playwright.sync_api'
    : 'TypeScript + @playwright/test';
}

/**
 * 用提示词管理里的模板替换占位符。
 * 未替换的占位符原样保留，方便用户看出自己写错了名字。
 */
export function applyPromptVars(
  template: string,
  vars: { project: string; dir: string; language: string; plan: string },
): string {
  return template
    .replaceAll('{{project}}', vars.project)
    .replaceAll('{{dir}}', vars.dir)
    .replaceAll('{{language}}', vars.language)
    .replaceAll('{{plan}}', vars.plan);
}

export function buildUiAgentSystemPrompt(
  project: UiAutoProject,
  target: UiTestTarget,
  plan?: UiPlanStep[],
  custom?: string,
  codeRules?: string,
): string {
  const planText = formatPlan(plan);
  // 提示词管理里有这份提示词就用它（占位符替换后整段作为 system prompt）
  if (custom?.trim()) {
    const main = applyPromptVars(custom.trim(), {
      project: project.name,
      dir: project.dir,
      language: languageLabel(target),
      plan: planText || '如果还没有计划：先调用 ui_plan_steps 列出计划，再开始探索。',
    });
    // 「生成代码」段：出码 / 写入的工程约定，跟着探索阶段一起给模型
    const code = String(codeRules ?? '').trim();
    return code ? `${main}\n\n${code}` : main;
  }
  // 兜底：提示词管理里没有这份文件时才会走到这里，只写最关键的几句
  return [
    '你是 UI 自动化测试工程师：用浏览器把流程点一遍，确认元素能唯一定位，再提交步骤。',
    `项目：${project.name}（${project.dir}），目标语言：${languageLabel(target)}。`,
    'ref 导航后失效要重新 snapshot；每个元素先用 ui_locator_probe 拿唯一定位器，再用 ui_test_set_steps 提交。',
    '探索阶段不要自己试跑；至少一条 expect 断言用户可见的结果；账号等占位值写成 ${ENV_NAME}。',
    planText ? `\n${planText}` : '',
    '最后用中文简短汇报。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 规划阶段：只做测试设计，不打开浏览器 */
export function buildUiPlanSystemPrompt(
  project: UiAutoProject,
  target: UiTestTarget,
  custom?: string,
): string {
  if (custom?.trim()) {
    return applyPromptVars(custom.trim(), {
      project: project.name,
      dir: project.dir,
      language: languageLabel(target),
      plan: '',
    });
  }
  // 兜底：提示词管理里没有这份文件时才会走到这里
  return [
    '你是测试设计师：只把需求拆成「动作 + 目标描述」的步骤计划，不打开浏览器、不写定位器。',
    `项目：${project.name}（${project.dir}），目标语言：${languageLabel(target)}。`,
    '只调用一次 ui_plan_steps；4~12 步，覆盖打开页面、前置、核心操作与至少一条结果断言。',
    '账号密码等写成 ${ENV_NAME}。',
  ].join('\n');
}

export function buildUiPlanUserPrompt(
  requirement: string,
  baseURL: string,
  target: UiTestTarget,
): string {
  return [
    '需求 / 流程：',
    requirement.trim(),
    '',
    baseURL ? `起始地址（baseURL）：${baseURL}` : '起始地址：从需求里判断，用相对路径。',
    `目标语言：${target === 'python' ? 'Python (pytest)' : 'TypeScript'}`,
    '',
    '请给出步骤计划。',
  ].join('\n');
}

export function buildUiAgentUserPrompt(
  requirement: string,
  baseURL: string,
  target: UiTestTarget,
  plan?: UiPlanStep[],
): string {
  return [
    '要自动化的流程 / 需求：',
    requirement.trim(),
    '',
    baseURL ? `起始地址（baseURL）：${baseURL}` : '起始地址：从需求里判断，用相对路径。',
    `目标语言：${target === 'python' ? 'Python (pytest)' : 'TypeScript'}`,
    plan?.length
      ? '\n已确认的步骤计划（按顺序执行，probe 时带上 stepId）：\n' + formatPlan(plan)
      : '',
    '',
    '请开始：打开页面、探索并确认元素、提交步骤。',
  ]
    .filter(Boolean)
    .join('\n');
}
