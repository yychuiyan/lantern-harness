/**
 * 自动化测试：类型、接口封装与展示工具。
 *
 * 项目目录由服务端只读浏览；运行参数最终由 `lh-plugins/lh-uiauto.mjs` 拼成
 * Playwright CLI 参数，前端只负责收集与展示。
 */
import type { PmTone } from '../components/islands/PmShared';

export const UI_AUTO_API = '/__tb_uiauto';

export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'error' | 'interrupted';

export interface RunArgs {
  file: string;
  grep: string;
  /** Playwright config 里的项目名（setup / chromium-login …）；空串 = 全部项目 */
  project: string;
  headed: boolean;
  workers: number;
  lastFailed: boolean;
}

export interface UiAutoProject {
  id: string;
  name: string;
  dir: string;
  createdAt: string;
  lastRunId: string;
  lastRunAt: string;
  lastStatus: RunStatus | '';
  /** 目录当前是否还在（换机器 / 移动过会变成 false） */
  exists: boolean;
  configFile: string;
  playwrightInstalled: boolean;
  hasDependency: boolean;
  packageManager: string;
  mountable: boolean;
  runningRunId: string;
  /** 项目里筛出的 *.spec / *.test 文件，供「指定文件」下拉使用 */
  specFiles: string[];
  /** 上次运行解析到的 Playwright 项目名，供「项目」下拉使用 */
  projectNames: string[];
}

export interface UiAutoRun {
  id: string;
  projectId: string;
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
  /** 该次运行看到的 Playwright 项目名列表 */
  projectNames: string[];
  reportRel: string;
  resultRel: string;
  logRel: string;
  error: string;
  reportUrl: string;
  logUrl: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
}

export interface TreeResponse {
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export interface FilePreview {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string;
}

export interface RunLogResponse {
  run: UiAutoRun;
  stopping: boolean;
  log: string;
  nextOffset: number;
  reset: boolean;
}

export interface RunOptions {
  file?: string;
  grep?: string;
  project?: string;
  headed?: boolean;
  workers?: number;
  lastFailed?: boolean;
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

/** 运行参数摘要（历史记录里一行展示） */
export function describeRunArgs(args: RunArgs | undefined): string {
  if (!args) return '全量';
  const parts: string[] = [];
  if (args.file) parts.push(args.file);
  if (args.grep) parts.push(`grep: ${args.grep}`);
  if (args.project) parts.push(args.project);
  if (args.headed) parts.push('headed');
  if (args.workers > 0) parts.push(`workers=${args.workers}`);
  if (args.lastFailed) parts.push('--last-failed');
  return parts.length ? parts.join(' · ') : '全量';
}

/** 汇总条文案：总数 / 通过 / 失败 / 跳过，有 flaky 时补一项 */
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

export async function fetchProjects(): Promise<UiAutoProject[]> {
  const json = await request<{ projects: UiAutoProject[] }>('/projects');
  return json.projects;
}

export async function pickProjectDirectory(): Promise<string> {
  const json = await request<{ dir: string }>('/pick-directory', { method: 'POST' });
  return json.dir;
}

export async function addProject(dir: string, name = ''): Promise<UiAutoProject> {
  const json = await request<{ project: UiAutoProject }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ dir, name }),
  });
  return json.project;
}

export async function updateProject(patch: {
  id: string;
  name?: string;
  dir?: string;
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

export async function fetchTree(projectId: string, path = '', depth = 1): Promise<TreeResponse> {
  const query = new URLSearchParams({ projectId, path, depth: String(depth) });
  return request<TreeResponse>(`/tree?${query.toString()}`);
}

export async function fetchFile(projectId: string, path: string): Promise<FilePreview> {
  const query = new URLSearchParams({ projectId, path });
  return request<FilePreview>(`/file?${query.toString()}`);
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
