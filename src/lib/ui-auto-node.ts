/**
 * 项目的 Node 版本：`.nvmrc` 声明的是什么、本机跑的是哪个、装了哪些。
 *
 * 「切换」只写 `.nvmrc`；真正跑用例时由服务端把 PATH 指到对应版本的 bin，
 * 不改用户终端里的 Node（nvm use 是 shell 函数，子进程改不动父 shell）。
 */
import { UI_AUTO_API } from './ui-auto';

export interface NodeInstallation {
  manager: string;
  version: string;
  binDir: string;
}

export interface ProjectNodeStatus {
  /** `.nvmrc` 里的版本；没有就是空串 */
  nvmrc: string;
  /** `.node-version` 里的版本（挂载项目的 fnm / asdf 约定）；没有就是空串 */
  nodeVersion: string;
  /** `package.json` 的 engines.node */
  engines: string;
  /** 实际生效的要求：`.nvmrc` > `.node-version` > engines */
  required: string;
  /** 服务端当前进程的 Node 版本 */
  running: string;
  runningSatisfies: boolean;
  /** 跑用例时会用的那个已装版本；没装到就是 null */
  matched: NodeInstallation | null;
  installations: NodeInstallation[];
  /** 装过版本的管理器（据已装版本推导，可能为空但本机其实装了管理器） */
  managers: string[];
  /** 本机装有的可安装 Node 的版本管理器：nvm / fnm / volta（决定能不能一键装） */
  installers: string[];
  error: string;
}

async function nodeRequest<T>(path: string, init?: RequestInit): Promise<T> {
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

export function fetchProjectNode(projectId: string): Promise<ProjectNodeStatus> {
  const query = new URLSearchParams({ projectId });
  return nodeRequest<ProjectNodeStatus>(`/project/node?${query.toString()}`);
}

/** 改项目 Node：写 `.nvmrc`；传空串删掉该文件（回到 engines 的口径） */
export function saveProjectNode(input: {
  projectId: string;
  version: string;
}): Promise<ProjectNodeStatus> {
  return nodeRequest<ProjectNodeStatus>('/project/node', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 面板里显示用：`22.23.0` → `v22.23.0` */
export function formatNodeVersion(version: string): string {
  const text = String(version ?? '').trim();
  if (!text) return '';
  return /^v/i.test(text) ? text : `v${text}`;
}

/**
 * 从项目声明的版本要求里挑一个能直接安装的具体版本。
 * `22.23.0` / `22` / `^22.23.0` / `~22.23.0` 原样可装；
 * 范围（`>=22.23.0`、`>=20 <23`）取下界——装上它就满足范围；
 * 只有上界（`<23`、`lts/*`）定不出装哪个，返回空串。
 */
export function nodeInstallTarget(requirement: string): string {
  const text = String(requirement ?? '').trim();
  if (!text) return '';
  for (const segment of text.split(/\s+/).filter(Boolean)) {
    const matched = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+(?:\.\d+){0,2})$/.exec(segment);
    if (!matched) continue;
    const operator = matched[1] ?? '';
    // 只有上界时没有「装哪个」的答案，别拿 23 去凑
    if (operator === '<' || operator === '<=') continue;
    return matched[2];
  }
  return '';
}

/**
 * 运行前的 Node 版本提醒：项目声明了版本、本机却没有可用版本、面板自己的 Node 也不满足时返回提示。
 *
 * 这种情况平台会把 PATH 保持原样（没有可插入的版本目录），实际是用面板进程的 Node 在跑，
 * 结果可能因为版本差异不可信；空串表示不用提示。
 */
export function nodeRunWarning(status: ProjectNodeStatus): string {
  if (!status.required) return '';
  if (status.matched) return '';
  if (status.runningSatisfies) return '';
  const installers = status.installers ?? status.managers ?? [];
  return (
    `项目要求 Node ${status.required}，本机没有满足的版本；` +
    `本次会用面板当前的 v${status.running} 运行，结果可能不可信。` +
    (installers.length
      ? `可以先在「项目配置 → Node 版本」里安装 ${nodeInstallTarget(status.required) || '对应版本'} 再运行。`
      : '可以先在「项目配置 → Node 版本」让 AI 装好再运行。')
  );
}

/**
 * 面板底部「需要时手动切换」的提示。
 *
 * `.nvmrc` 只是文本文件，读它不需要任何工具；但终端里想按它切版本，得有对应的版本管理器。
 * 本机没装 nvm 时给出 `nvm use` 是敲不出来的假命令，所以这里按实际检测到的管理器来写：
 * - 有 nvm / fnm → 给对应命令；
 * - 只有 volta → volta 不读 `.nvmrc`，说明要 `volta pin`；
 * - 没装管理器 → 不给命令，说明平台运行时自己找 Node。
 */
export function nodeManualHint(status: ProjectNodeStatus): { command: string; note: string } {
  const version = status.nvmrc ?? '';
  if (!version) return { command: '', note: '' };
  const manager = status.matched?.manager || status.managers?.[0] || '';
  if (manager === 'nvm') return { command: `nvm use ${version}`, note: '' };
  if (manager === 'fnm') return { command: `fnm use ${version}`, note: '' };
  if (manager === 'volta') {
    return {
      command: '',
      note: `volta 不读 .nvmrc：需要固定版本时在项目里执行 volta pin node@${version}。`,
    };
  }
  const installers = status.installers ?? status.managers ?? [];
  return {
    command: '',
    note: installers.length
      ? `本机还没装符合要求的 Node，终端里暂时没有可切换的版本（已装 ${installers.join(' / ')}，可点上面安装）。`
      : '本机没装 nvm / fnm / volta：平台运行时会自己找可用的 Node，终端里没有对应的切换命令。',
  };
}

/* ────────────────── 安装缺失的 Node 版本 ────────────────── */

export type NodeInstallStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped';

export interface NodeInstallState {
  status: NodeInstallStatus;
  /** 正在装 / 刚装完的版本 */
  version: string;
  manager: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  stopping: boolean;
  log: string;
  error: string;
}

/** 后台装一个 Node 版本：nvm / fnm / volta 自动挑一个，日志随时可取 */
export function startNodeInstall(input: {
  projectId: string;
  version: string;
}): Promise<NodeInstallState> {
  return nodeRequest<NodeInstallState>('/project/node/install', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchNodeInstall(projectId: string): Promise<NodeInstallState> {
  const query = new URLSearchParams({ projectId });
  return nodeRequest<NodeInstallState>(`/project/node/install?${query.toString()}`);
}

export function stopNodeInstall(projectId: string): Promise<NodeInstallState> {
  return nodeRequest<NodeInstallState>('/project/node/install/stop', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}
