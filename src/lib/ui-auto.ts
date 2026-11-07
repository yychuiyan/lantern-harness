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
  /** 被忽略（只在运行配置里出现，可以恢复） */
  ignored?: boolean;
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
  /**
   * 被忽略的自动发现任务：不进「运行任务」下拉，
   * 只在运行配置里排在列表最后，点「恢复」放回去。
   */
  ignoredTasks?: RunTask[];
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
  /** 默认环境名（.env.<ENV>）：运行面板下拉的初始值，空串表示 `.env`（各环境共用的兜底） */
  envName?: string;
  /** 项目是否按 `ENV` + `.env.<ENV>` 约定做的（Playwright 项目才可能为真） */
  hasEnvConvention?: boolean;
  /** 项目里已有的环境文件（`''` = 共用的 `.env`） */
  envFiles?: string[];
  /** 项目来源：mount 挂载已有目录 / scaffold 由「新建项目」生成（老数据为 mount） */
  source?: 'mount' | 'scaffold';
  /** 生成项目时用的技术栈与生成时间 */
  scaffold?: { stack: string; at: string; options?: string[] } | null;
  /** 上次骨架同步 / 生成时勾的附带内容（老项目按目录里的文件反推） */
  scaffoldOptions?: string[];
  /** 项目 `.env.example` 里现在的 BASE_URL（骨架同步时回显，留空即沿用） */
  scaffoldBaseURL?: string;
  /** 有没有生成过程留档（新建项目生成过一次才有） */
  hasGenerationRecord?: boolean;
  /** 一键安装：该技术栈是否支持 */
  setupSupported?: boolean;
  /** 一键安装的步骤清单（没跑过也有两行命令可看） */
  setupPlan?: SetupPlanStep[];
  /** 一键安装命中的包管理器（pnpm 优先，本机没装时返回 npm） */
  setupPackageManager?: string;
  /** 包管理器退回 npm 之类的原因，空串表示无需说明 */
  setupNote?: string;
  /** 最近一次安装的结果 */
  setup?: ProjectSetup;
}

/* ── 一键安装依赖（依赖 + Playwright 浏览器内核） ── */

export type SetupStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';
export type SetupStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface SetupPlanStep {
  id: string;
  label: string;
  command: string;
  cwd?: string;
}

export interface SetupStep {
  id: string;
  label: string;
  command: string;
  status: SetupStepStatus;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
}

export interface ProjectSetup {
  status: SetupStatus;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  logRel: string;
  error: string;
  steps: SetupStep[];
}

export interface SetupLogResponse {
  setup: ProjectSetup;
  stopping: boolean;
  log: string;
  nextOffset: number;
  reset: boolean;
}

/* ── 新建项目：企业级基础框架脚手架 ── */

export interface ScaffoldOption {
  id: string;
  label: string;
  hint: string;
}

export interface ScaffoldStack {
  id: string;
  label: string;
  hint: string;
  kind: TestKind | '';
  language: string;
  status: 'ready' | 'planned';
  /** 空间里的骨架 id（改骨架就能改生成结果） */
  skeleton?: string;
  /** 骨架来源：space = 空间里的那份（改过），builtin = 内置种子 */
  skeletonSource?: 'space' | 'builtin' | '';
  /** 建完自动关联的提示词文件 */
  promptFile?: string;
  options: ScaffoldOption[];
  defaultOptions: string[];
}

export interface ScaffoldInput {
  stack: string;
  name: string;
  /** 父目录（绝对路径）；项目会建在 `<父目录>/<项目名>/` */
  parentDir: string;
  /**
   * 已有项目目录（修改项目时用）。
   * 传了就直接在它上面预览 / 检查，不要求目录为空；不传走 `parentDir + name`。
   */
  dir?: string;
  baseURL?: string;
  options?: string[];
  /**
   * 本次生成用的骨架（JSON 文本或对象）。
   * 不传就用空间里那份；传了只影响这一次，不改空间基线。
   */
  skeleton?: string | Record<string, unknown> | null;
  /** 生成过程留档（检查日志 / 建议 / 补丁 / 文件清单），跟项目一起写入 */
  record?: ScaffoldGenerationRecordDraft | null;
}

/** 修改项目：在已有目录上重渲染骨架，逐文件判断新增 / 更新 / 未变 */
export interface ScaffoldUpdateInput {
  projectId: string;
  stack: string;
  name?: string;
  /** 留空沿用现有 .env.example 里的 BASE_URL */
  baseURL?: string;
  options?: string[];
  skeleton?: string | Record<string, unknown> | null;
  record?: ScaffoldGenerationRecordDraft | null;
}

/** 生成过程留档里只记录「补丁会动哪些文件」，不存整份新内容 */
export interface ScaffoldRecordPatch {
  action: string;
  path: string;
  bytes?: number;
}

export interface ScaffoldRecordFinding {
  id: string;
  level: 'error' | 'warn' | 'info';
  title: string;
  detail: string;
  file?: string;
  source: 'platform' | 'model';
  patches: ScaffoldRecordPatch[];
}

export interface ScaffoldGenerationRecordDraft {
  at?: string;
  stack?: string;
  name?: string;
  dir?: string;
  skeleton?: string;
  skeletonSource?: 'space' | 'builtin' | 'custom' | '';
  promptFile?: string;
  layout?: Record<string, string>;
  files: Array<{ path: string; bytes: number }>;
  totalBytes: number;
  logs: Array<{
    seq: number;
    at: number;
    stage: string;
    level: 'info' | 'warn' | 'error';
    text: string;
    detail?: string;
  }>;
  findings: ScaffoldRecordFinding[];
  /** 实际应用到本次骨架的建议 id */
  applied: string[];
  promptReady: boolean;
  ok: boolean;
  error: string;
  raw: string;
  stats: { ms: number; firstTokenMs: number; chars: number; beats: number; model: string } | null;
}

export interface ScaffoldGenerationRecord extends ScaffoldGenerationRecordDraft {
  version: number;
  at: string;
}

export interface ScaffoldPreview {
  dir: string;
  stack: string;
  /** 用的哪份骨架、来自空间还是内置（custom = 本次检查里调过） */
  skeleton?: string;
  skeletonSource?: 'space' | 'builtin' | 'custom';
  /** 生成后自动关联的提示词 */
  promptFile?: string;
  /** 落点（testDir / pagesDir / fixturesDir …），出码器按它写文件 */
  layout?: Record<string, string>;
  /** 修改项目时每个文件带状态：新增 / 内容有变化 / 与磁盘一致 */
  files: Array<{ path: string; bytes: number; status?: ScaffoldFileStatus }>;
  /** 修改项目：变更汇总；新建项目没有这个字段 */
  changes?: { created: number; changed: number; same: number };
  totalBytes: number;
  nextCommands: ScaffoldCommand[];
}

export type ScaffoldFileStatus = 'new' | 'changed' | 'same' | 'keep';

export interface ScaffoldUpdateResult {
  dir: string;
  files: Array<{ path: string; bytes: number; status: ScaffoldFileStatus }>;
  created: number;
  changed: number;
  same: number;
  /** 骨架里有、但本机已有且不覆盖的文件（目前是 `.env`） */
  kept?: number;
  /** 本次被覆盖过的文件相对路径（已备份） */
  backedUp: string[];
  /** 备份目录；没有覆盖任何文件时为空 */
  backupDir: string;
  project: UiAutoProject;
  recordSaved?: boolean;
}

export interface ScaffoldCommand {
  label: string;
  command: string;
  cwd: string;
}

export interface ScaffoldResult {
  dir: string;
  project: UiAutoProject;
  nextCommands: ScaffoldCommand[];
  /** 生成过程留档是否写入成功 */
  recordSaved?: boolean;
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
  /** 这次跑在哪个环境（`.env.<ENV>`）；空串表示 `.env`（各环境共用） */
  envName?: string;
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
  /** Allure 静态报告快照目录（有值才能直接看） */
  allureRel?: string;
  /** 项目里有 Allure 原始结果、可以现生成：界面据此给「生成 Allure 报告」入口 */
  allureResults?: boolean;
  /** 打开 Allure 报告的地址；没有快照时为空串 */
  allureUrl?: string;
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
  /** 目标环境（Playwright 的 `.env.<ENV>`）：作为 ENV 传给子进程 */
  env?: string;
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
 * 目录归一（工作台入口匹配项目用）：斜杠统一、去尾部斜杠与多余空白。
 * 不做大小写折叠，交给调用方先精确比、再忽略大小写比（macOS 默认卷不区分大小写）。
 */
export function normalizeProjectDir(dir: string): string {
  let value = String(dir ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!value) return '';
  if (/^[a-zA-Z]:$/.test(value)) value += '/';
  return value;
}

/** 工作台当前工作区是不是某个自动化项目的目录；匹配不到返回 null（不渲染入口） */
export function matchProjectByDir(projects: UiAutoProject[], dir: string): UiAutoProject | null {
  const target = normalizeProjectDir(dir);
  if (!target) return null;
  const exact = projects.find((project) => normalizeProjectDir(project.dir) === target);
  if (exact) return exact;
  const lower = target.toLowerCase();
  return (
    projects.find((project) => normalizeProjectDir(project.dir).toLowerCase() === lower) ?? null
  );
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

/** 新建项目可用的技术栈（planned 的在向导里灰显） */
export async function fetchScaffoldStacks(): Promise<ScaffoldStack[]> {
  const json = await request<{ stacks?: ScaffoldStack[] }>('/scaffold/stacks');
  return json.stacks ?? [];
}

/** 预览要生成的文件清单：不写盘，只返回路径与大小 */
export async function previewScaffold(input: ScaffoldInput): Promise<ScaffoldPreview> {
  return request<ScaffoldPreview>('/scaffold/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/* ── 新建项目的「检查」步骤：空间骨架原文 + 确定性体检 ── */

/** 空间里当前那份骨架（原文 + 概要），拼 AI prompt 用 */
export interface SpaceSkeleton {
  ok: boolean;
  id: string;
  stack: string;
  source: 'space' | 'builtin' | '';
  /** 跟插件内置版本不一致（用户改过） */
  modified: boolean;
  raw: string;
  layout?: Record<string, string>;
  options: string[];
  defaultOptions: string[];
  files: number;
  promptFile: string;
  error?: string;
}

export interface ScaffoldCheckItem {
  id: string;
  level: 'error' | 'warn' | 'info';
  title: string;
  detail: string;
  file?: string;
}

export interface ScaffoldCheckLog {
  at: string;
  /** skeleton / structure / render / target */
  stage: string;
  level: string;
  message: string;
}

export interface ScaffoldCheckResult {
  ok: boolean;
  dir: string;
  stack: string;
  skeleton: string;
  skeletonSource?: 'space' | 'builtin' | 'custom';
  promptFile?: string;
  layout?: Record<string, string>;
  options: string[];
  logs: ScaffoldCheckLog[];
  checks: ScaffoldCheckItem[];
  summary: { errors: number; warnings: number; infos: number; files: number; bytes: number };
}

/** 读空间骨架原文（没传 stack 时按 playwright） */
export async function fetchSpaceSkeleton(stack = 'playwright'): Promise<SpaceSkeleton> {
  return request<SpaceSkeleton>(`/skeleton?stack=${encodeURIComponent(stack)}`);
}

/** 生成前体检：确定性检查 + 阶段日志；body.skeleton 可选（本次调过的骨架） */
export async function checkScaffold(input: ScaffoldInput): Promise<ScaffoldCheckResult> {
  return request<ScaffoldCheckResult>('/scaffold/check', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 生成骨架并自动挂载成一个项目（目标目录必须不存在或为空） */
export async function createScaffoldProject(input: ScaffoldInput): Promise<ScaffoldResult> {
  return request<ScaffoldResult>('/scaffold', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 修改项目：把骨架重新渲染到已有目录，覆盖前自动备份原文件 */
export async function updateScaffoldProject(
  input: ScaffoldUpdateInput,
): Promise<ScaffoldUpdateResult> {
  return request<ScaffoldUpdateResult>('/scaffold/update', {
    method: 'POST',
    body: JSON.stringify(input),
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
  /** 默认环境名（`.env.<ENV>`）：空串表示 `.env`（各环境共用的兜底） */
  envName?: string;
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

export interface StartRunResult {
  run: UiAutoRun;
  /**
   * 任务命令里自己写死了 `ENV=xxx`：shell 里后设的值会盖掉面板选的环境。
   * 服务端算好了直接回传，界面要显示出来，否则用户以为跑的是选中的那套。
   */
  envWarning: string;
}

export async function startRun(
  projectId: string,
  options: RunOptions = {},
): Promise<StartRunResult> {
  const json = await request<{ run: UiAutoRun; envWarning?: string }>('/run', {
    method: 'POST',
    body: JSON.stringify({ projectId, ...options }),
  });
  return { run: json.run, envWarning: json.envWarning ?? '' };
}

export async function stopRun(runId: string): Promise<void> {
  await request('/stop', { method: 'POST', body: JSON.stringify({ runId }) });
}

export interface AllureGenerateResult {
  ok: boolean;
  code: number;
  command: string;
  log: string;
  run: UiAutoRun;
  error?: string;
}

/** 用本项目的结果目录生成 Allure 静态报告（依赖项目脚本 / 本机 Java） */
export async function generateAllure(runId: string): Promise<AllureGenerateResult> {
  return request<AllureGenerateResult>('/run/allure', {
    method: 'POST',
    body: JSON.stringify({ runId }),
  });
}

export async function fetchRunLog(runId: string, offset = 0): Promise<RunLogResponse> {
  const query = new URLSearchParams({ id: runId, offset: String(offset) });
  return request<RunLogResponse>(`/run?${query.toString()}`);
}

/* ── 一键安装依赖（依赖 + Playwright 浏览器内核） ── */

/** 启动安装：服务端串行跑依赖与浏览器内核，返回第一步的状态 */
export async function startProjectSetup(projectId: string): Promise<{
  setup: ProjectSetup;
  command?: string;
}> {
  return request<{ setup: ProjectSetup; command?: string }>('/project/setup', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

/** 轮询安装日志：跑着用增量，结束后从日志文件尾部补一段（reset=true） */
export async function fetchProjectSetup(projectId: string, offset = 0): Promise<SetupLogResponse> {
  const query = new URLSearchParams({ projectId, offset: String(offset) });
  return request<SetupLogResponse>(`/project/setup?${query.toString()}`);
}

export async function stopProjectSetup(projectId: string): Promise<void> {
  await request('/project/setup/stop', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

/* ── 生成过程留档 ── */

/** 读某次生成的检查日志 / 建议 / 文件清单；没有留档时抛错 */
export async function fetchScaffoldRecord(projectId: string): Promise<ScaffoldGenerationRecord> {
  const json = await request<{ record: ScaffoldGenerationRecord }>(
    `/scaffold/record?projectId=${encodeURIComponent(projectId)}`,
  );
  return json.record;
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
