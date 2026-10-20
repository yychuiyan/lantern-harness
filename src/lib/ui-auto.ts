/**
 * 自动化测试：类型、接口封装与展示工具。
 *
 * 项目目录由服务端只读浏览；运行参数最终由 `lh-plugins/lh-uiauto.mjs` 拼成
 * Playwright CLI 参数，前端只负责收集与展示。
 */
import type { PmTone } from '../components/islands/PmShared';

export const UI_AUTO_API = '/__tb_uiauto';

/** 首期支持的框架：Playwright / pytest / Selenium */
export type FrameworkId = 'playwright' | 'pytest' | 'selenium';

/** 测试类型：UI 自动化 / 接口自动化 / 其它测试 */
export type TestKind = 'ui' | 'api' | 'test';

export interface FrameworkOption {
  id: FrameworkId;
  label: string;
  kind: TestKind;
}

export interface FrameworkCandidate extends FrameworkOption {
  /** 识别得分，越高越可信 */
  score: number;
  /** 命中证据，例如 playwright.config.ts / 依赖: pytest */
  evidence: string[];
  controls: string[];
  /** 运行命令是否就绪（依赖 / 解释器 / 构建工具找得到） */
  ready: boolean;
}

export interface DetectResponse {
  dir: string;
  candidates: FrameworkCandidate[];
  /** 每个框架的就绪提示（命令找不到时可直接复制） */
  hints: Partial<Record<FrameworkId, string>>;
  frameworks: FrameworkOption[];
}

export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'error' | 'interrupted';

export interface RunArgs {
  file: string;
  /** Playwright 是 --grep；pytest 是 -k 表达式；Selenium 是类名 / 方法名 */
  grep: string;
  /** Playwright config 里的项目名（setup / chromium-login …）；空串 = 全部项目 */
  project: string;
  headed: boolean;
  workers: number;
  lastFailed: boolean;
  /** 遇到第一个失败就停 */
  bail?: boolean;
  /** pytest 的 -m 标记表达式 */
  marker: string;
  /** pytest 的 --maxfail */
  maxFail: number;
}

/** 「运行任务」：项目自带脚本 / Makefile 目标 / marker，或用户自己加的命令 */
export type RunTaskKind = 'full' | 'script' | 'make' | 'pytest' | 'maven' | 'custom';

export interface RunTask {
  id: string;
  /** 下拉里显示的文案：命令行或「全量运行」 */
  label: string;
  /** 短名（脚本名 / marker / target） */
  display: string;
  hint: string;
  kind: RunTaskKind;
  /** 能不能追加「仅上次失败 / 遇到失败即停」 */
  failureFlags: boolean;
  /** 用户自己加的（可以在运行配置里删） */
  custom: boolean;
  /** 自动发现的任务被改过名称或命令 */
  edited?: boolean;
  /** 实际执行（或默认执行）的命令行 */
  command: string;
}

/** 运行配置里保存的自定义命令 */
export interface CustomRunTask {
  id: string;
  name: string;
  command: string;
}

/** 对自动发现任务的改动：只存差异，空串表示不覆盖 */
export interface TaskOverride {
  id: string;
  name: string;
  command: string;
}

export interface UiAutoProject {
  id: string;
  name: string;
  dir: string;
  framework: FrameworkId;
  frameworkLabel: string;
  kind: TestKind | '';
  /** 运行方式（Playwright Test / python -m pytest / Maven · mvn test …） */
  runner: string;
  createdAt: string;
  lastRunId: string;
  lastRunAt: string;
  lastStatus: RunStatus | '';
  /** 目录当前是否还在（换机器 / 移动过会变成 false） */
  exists: boolean;
  /** 该框架需要运行的控件（file / grep / project / workers / headed / lastFailed / marker） */
  controls: string[];
  /** 当前框架的运行环境是否就绪 */
  frameworkReady: boolean;
  /** 未就绪时的提示（可直接复制执行的命令） */
  readyHint: string;
  packageManager: string;
  mountable: boolean;
  runningRunId: string;
  /** 当前目录里识别到的框架候选，供「重新识别」使用 */
  candidates: FrameworkCandidate[];
  /** 项目里筛出的测试文件，供「指定文件」下拉使用 */
  specFiles: string[];
  /** 上次运行解析到的 Playwright 项目名，供「项目」下拉使用 */
  projectNames: string[];
  /** 可运行的任务（全量 + 自动发现 + 自定义） */
  runTasks: RunTask[];
  /** 用户自己加的运行命令 */
  customTasks: CustomRunTask[];
  /** 对自动发现任务的改动（只存差异） */
  taskOverrides?: CustomRunTask[];
  /** 被删掉的自动发现任务 id */
  hiddenTasks?: string[];
  /** 被测应用起始地址：用户改过就存下来（含 /admin 这类路由后缀），下次自动带出 */
  baseURL?: string;
  /** 从项目自己的 playwright 配置 / .env 探测到的地址（项目没存过时用它） */
  detectedBaseURL?: string;
  /** 登录态文件（相对项目根）：按项目保存，换项目不会串味 */
  storageState?: string;
  /** 项目里自动探测到的登录态文件（auth-admin.json / .auth/…）；空 = 没找到 */
  detectedStorageState?: string;
  /** 该项目引用的提示词文件名（提示词管理里的 .md）；空 = 插件默认那份 */
  promptFile?: string;
}

export interface UiAutoRun {
  id: string;
  projectId: string;
  /** 运行时使用的框架（历史记录按当时框架展示参数摘要） */
  framework: FrameworkId;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  exitCode: number | null;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  args: RunArgs;
  /** 这次实际执行的命令行 */
  command: string;
  /** 选的是哪条任务（`full` = 框架默认全量） */
  taskId: string;
  taskLabel: string;
  /** 该次运行看到的 Playwright 项目名列表 */
  projectNames: string[];
  reportRel: string;
  resultRel: string;
  logRel: string;
  error: string;
  reportUrl: string;
  logUrl: string;
}

export interface RunLogResponse {
  run: UiAutoRun;
  stopping: boolean;
  log: string;
  nextOffset: number;
  reset: boolean;
}

export interface RunOptions {
  /** 要跑的任务 id（`full` = 框架默认命令） */
  taskId?: string;
  file?: string;
  grep?: string;
  project?: string;
  headed?: boolean;
  workers?: number;
  lastFailed?: boolean;
  bail?: boolean;
  marker?: string;
  maxFail?: number;
}

export interface FrameworkHint {
  id: FrameworkId;
  label: string;
  kind: TestKind;
}

export function frameworkKindLabel(kind: TestKind | ''): string {
  if (kind === 'ui') return 'UI';
  if (kind === 'api') return '接口';
  if (kind === 'test') return '测试';
  return '';
}

export const RUN_STATUS_META: Record<RunStatus, { label: string; tone: PmTone }> = {
  running: { label: '运行中', tone: 'blue' },
  passed: { label: '通过', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'gray' },
  error: { label: '错误', tone: 'red' },
  interrupted: { label: '已中断', tone: 'amber' },
};

export function isTerminalStatus(status: RunStatus): boolean {
  return status !== 'running';
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '—';
  return new Date(time).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 运行参数摘要（历史记录里一行展示）：按运行时的框架渲染，换框架后旧记录不变 */
export function describeRunArgs(
  args: RunArgs | undefined,
  framework: FrameworkId = 'playwright',
): string {
  if (!args) return '全量';
  const parts: string[] = [];
  if (args.file) parts.push(args.file);
  if (args.grep) {
    if (framework === 'pytest') parts.push(`-k ${args.grep}`);
    else if (framework === 'selenium') parts.push(args.grep);
    else parts.push(`grep: ${args.grep}`);
  }
  if (framework === 'pytest') {
    if (args.marker) parts.push(`-m ${args.marker}`);
    if (args.lastFailed) parts.push('--lf');
    if (args.bail) parts.push('-x');
    if (args.maxFail > 0) parts.push(`--maxfail=${args.maxFail}`);
  } else if (framework === 'playwright') {
    if (args.project) parts.push(args.project);
    if (args.headed) parts.push('headed');
    if (args.workers > 0) parts.push(`workers=${args.workers}`);
    if (args.lastFailed) parts.push('--last-failed');
    if (args.bail) parts.push('--max-failures=1');
  }
  return parts.length ? parts.join(' · ') : '全量';
}

/** 汇总条文案：总数 / 通过 / 失败 / 跳过，有 flaky 时补一项 */
/**
 * 运行摘要里展示的命令：绝对路径的可执行文件只留文件名。
 * 例如 `/…/node_modules/.bin/playwright test` → `playwright test`，
 * `/…/.venv/bin/python -m pytest` → `python -m pytest`；避免把本机目录塞满一行。
 * 命令串本身仍按原样记录在记录里，只是展示时收一下。
 */
export function displayRunCommand(command: string): string {
  const raw = (command ?? '').trim();
  if (!raw) return '';
  const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : '';
  let head = raw;
  let rest = '';
  if (quote) {
    const end = raw.indexOf(quote, 1);
    head = end > 0 ? raw.slice(1, end) : raw.slice(1);
    rest = end > 0 ? raw.slice(end + 1).trim() : '';
  } else {
    const space = raw.search(/\s/);
    head = space > 0 ? raw.slice(0, space) : raw;
    rest = space > 0 ? raw.slice(space + 1).trim() : '';
  }
  const exe = /[\\/]/.test(head) ? (head.split(/[\\/]/).pop() ?? head) : head;
  return rest ? `${exe} ${rest}` : exe;
}

export function summarizeRun(run: UiAutoRun): string {
  const parts = [
    `共 ${run.total}`,
    `通过 ${run.passed}`,
    `失败 ${run.failed}`,
    `跳过 ${run.skipped}`,
  ];
  if (run.flaky > 0) parts.push(`不稳定 ${run.flaky}`);
  return parts.join(' · ');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${UI_AUTO_API}${path}`, {
    ...init,
    headers:
      init?.body === undefined
        ? undefined
        : { 'Content-Type': 'application/json', ...init?.headers },
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

export async function fetchUiAutoHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${UI_AUTO_API}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchProjects(): Promise<{
  projects: UiAutoProject[];
  frameworks: FrameworkOption[];
}> {
  const json = await request<{ projects: UiAutoProject[]; frameworks?: FrameworkOption[] }>(
    '/projects',
  );
  return { projects: json.projects, frameworks: json.frameworks ?? [] };
}

/**
 * 各项目挂载的提示词（相对提示词根目录的路径）。
 * 提示词管理用它把实际挂载的提示词标成「引用中」；一个项目只存一份，
 * 项目换掉提示词后列表里自然只剩新的那份。
 * 服务没启动（插件关闭 / 未就绪）时返回 null——调用方应沿用上次结果，
 * 不能当成「没人引用」把删除锁放开。
 */
export async function fetchMountedPromptFiles(): Promise<string[] | null> {
  try {
    const { projects } = await fetchProjects();
    return projects.map((project) => (project.promptFile ?? '').trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** 选完目录先识别：返回按可信度排序的框架候选与就绪提示 */
export async function detectFrameworks(dir: string): Promise<DetectResponse> {
  return request<DetectResponse>('/detect', {
    method: 'POST',
    body: JSON.stringify({ dir }),
  });
}

/**
 * 提示词挂载关系变化的广播事件。
 *
 * 项目的提示词挂载就存在项目记录里（`promptFile`），挂载 / 换一份 / 移出项目都会改动它。
 * 提示词管理页的「引用中」与删除锁定都依赖这份事实，所以改动后广播一次，
 * 让已经挂载的提示词列表即时重算，不用等切页刷新或重启服务。
 */
const PROMPT_MOUNTS_EVENT = 'lantern:uiauto:prompt-mounts';

export function notifyPromptMountsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(PROMPT_MOUNTS_EVENT));
}

/** 订阅挂载关系变化，返回取消订阅函数 */
export function onPromptMountsChanged(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(PROMPT_MOUNTS_EVENT, handler);
  return () => window.removeEventListener(PROMPT_MOUNTS_EVENT, handler);
}

/**
 * 系统原生选目录：取消返回空串；系统弹不出窗口时抛错（由调用方提示手动填路径）。
 */
export async function pickProjectDirectory(): Promise<string> {
  const json = await request<{ dir: string; canceled?: boolean }>('/pick-directory', {
    method: 'POST',
  });
  if (json.canceled) return '';
  return json.dir ?? '';
}

export async function addProject(
  dir: string,
  name = '',
  framework?: FrameworkId,
): Promise<UiAutoProject> {
  const json = await request<{ project: UiAutoProject }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ dir, name, framework }),
  });
  return json.project;
}

export async function updateProject(patch: {
  id: string;
  name?: string;
  dir?: string;
  framework?: FrameworkId;
  customTasks?: Array<{ id?: string; name: string; command: string }>;
  taskOverrides?: Array<{ id: string; name?: string; command?: string }>;
  hiddenTasks?: string[];
  /** 起始地址（含路径后缀）：按项目保存，下次进生成页自动带出来 */
  baseURL?: string;
  /** 该项目引用的提示词文件名；空串表示回到插件默认那份 */
  promptFile?: string;
  /** 登录态文件（相对项目根）；空串表示自动探测，'-' 表示不用登录态 */
  storageState?: string;
}): Promise<UiAutoProject> {
  const json = await request<{ project: UiAutoProject }>('/projects', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return json.project;
}

export async function removeProject(id: string): Promise<void> {
  await request(`/projects?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function startRun(projectId: string, options: RunOptions = {}): Promise<UiAutoRun> {
  const json = await request<{ run: UiAutoRun }>('/run', {
    method: 'POST',
    body: JSON.stringify({ projectId, ...options }),
  });
  return json.run;
}

export async function stopRun(runId: string): Promise<void> {
  await request('/stop', { method: 'POST', body: JSON.stringify({ runId }) });
}

export async function fetchRunLog(runId: string, offset = 0): Promise<RunLogResponse> {
  const query = new URLSearchParams({ id: runId, offset: String(offset) });
  return request<RunLogResponse>(`/run?${query.toString()}`);
}

export async function fetchRuns(projectId: string): Promise<UiAutoRun[]> {
  const json = await request<{ runs: UiAutoRun[] }>(
    `/runs?projectId=${encodeURIComponent(projectId)}`,
  );
  return json.runs;
}

export async function deleteRun(id: string): Promise<void> {
  await request(`/run?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}
