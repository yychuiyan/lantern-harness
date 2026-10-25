/**
 * 本地 bash / pwsh + jobs + 持久会话（/__tb_bash · /__tb_pwsh）。
 * 软沙箱策略在 Runner 侧执行；持久会话优先 node-pty，否则管道回退。
 */
import type { AccessLevel } from './settings';

const API_BASH = '/__tb_bash';
const API_PWSH = '/__tb_pwsh';

export interface BashHealth {
  ok: boolean;
  mode?: string;
  available?: boolean;
  projectRoot?: string;
  workspace?: string;
  bash?: string;
  timeoutMs?: number;
  maxOut?: number;
  jobs?: boolean;
  jobCount?: number;
  runningJobs?: number;
  sandboxPolicy?: boolean;
  pty?: boolean;
  persistentSessions?: boolean;
  sessionCount?: number;
  sessionMax?: number;
}

export interface PwshHealth {
  ok: boolean;
  mode?: string;
  available?: boolean;
  pwsh?: string | null;
  projectRoot?: string;
  workspace?: string;
  timeoutMs?: number;
  maxOut?: number;
  jobs?: boolean;
  jobCount?: number;
  runningJobs?: number;
  sandboxPolicy?: boolean;
  pty?: boolean;
  persistentSessions?: boolean;
  sessionCount?: number;
  sessionMax?: number;
}

export const BASH_SYSTEM_HINT =
  '你可以使用 bash / jobs / 持久会话工具（需本地服务，且访问权限为「工作区内修改」或「完全权限」）：\n' +
  '- bash：默认同步执行；长任务设 background=true，立即返回 jobId，再用 job_* 查看/终止\n' +
  '- job_list / job_output / job_kill：管理后台任务（bash 与 pwsh 共用）\n' +
  '- bash_session_open / exec / write / signal / read / close / list：跨调用保持 cwd/env 的持久 bash（PTY 或管道回退）\n' +
  '  writewrite：向 stdin 写原始文本（submit 默认 true 追加换行，不等待 prompt）；signal：SIGINT/SIGTERM/SIGTSTP/SIGHUP\n' +
  '- 需要保留目录状态、交互式探索时用持久会话；一次性命令用 bash\n' +
  '- 软沙箱会拒绝明显危险命令（非 OS 隔离）；默认 cwd 为侧栏工作区\n' +
  '- 同步有超时与输出截断；改文件优先用 fs_*';

export const PWSH_SYSTEM_HINT =
  '你可以使用 pwsh 工具（本机已安装 PowerShell 时可用）：\n' +
  '- pwsh：执行 PowerShell 命令（-NoProfile -NonInteractive）；亦可 background=true 挂到同一套 job_*\n' +
  '- pwsh_session_open / exec / write / signal / read / close / list：跨调用保持 cwd/env 的持久 PowerShell（PTY 或管道回退）\n' +
  '  ·write / signal 语义同 bash_session_*\n' +
  '- Windows 优先；macOS/Linux 需安装 PowerShell 7+（pwsh）\n' +
  '- 与 bash 相同的工作区 / 权限 / 软沙箱规则';

export const BASH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'bash',
    description:
      'Run a bash command in the workspace (or workdir). Default: synchronous. Set background=true for long-running jobs (returns jobId; use job_output/job_kill).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to run via bash -lc',
        },
        workdir: {
          type: 'string',
          description:
            'Working directory relative to workspace (or absolute when full access). Default: .',
        },
        background: {
          type: 'boolean',
          description: 'If true, start in background and return jobId immediately.',
        },
      },
      required: ['command'],
    },
  },
};

export const PWSH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'pwsh',
    description:
      'Run a PowerShell command in the workspace (or workdir). Default: synchronous. Set background=true for jobs (same job_* tools as bash).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'PowerShell command / script block text',
        },
        workdir: {
          type: 'string',
          description:
            'Working directory relative to workspace (or absolute when full access). Default: .',
        },
        background: {
          type: 'boolean',
          description: 'If true, start in background and return jobId immediately.',
        },
      },
      required: ['command'],
    },
  },
};

export const JOB_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'job_list',
      description: 'List background bash jobs (id, status, command, exitCode).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'job_output',
      description:
        'Read captured stdout/stderr for a background job. Use offset to poll from a cursor, or tail for the last N characters.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job id from bash(background=true) or job_list' },
          offset: {
            type: 'number',
            description: 'Byte/char offset into combined output for incremental reads',
          },
          tail: {
            type: 'number',
            description: 'If set, return only the last N characters (ignores offset)',
          },
        },
        required: ['jobId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'job_kill',
      description: 'Terminate a running background job (SIGTERM).',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
        },
        required: ['jobId'],
      },
    },
  },
];

export const BASH_SESSION_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'bash_session_open',
      description:
        'Open a persistent bash session (PTY if available, else pipe). State (cwd/env) survives across exec calls.',
      parameters: {
        type: 'object',
        properties: {
          workdir: {
            type: 'string',
            description:
              'Initial working directory relative to workspace (or absolute when full access)',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bash_session_exec',
      description: 'Run a command in an open persistent bash session and wait for the next prompt.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          command: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['sessionId', 'command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bash_session_write',
      description:
        'Write raw text to a persistent bash session stdin without waiting for the prompt. submit=true (default) appends a newline.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          data: { type: 'string', description: 'Text to write to stdin' },
          submit: {
            type: 'boolean',
            description: 'Append newline if missing (default true)',
          },
        },
        required: ['sessionId', 'data'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bash_session_signal',
      description: 'Send a signal to a persistent bash session (SIGINT/SIGTERM/SIGTSTP/SIGHUP).',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          signal: {
            type: 'string',
            description: 'SIGINT (default) | SIGTERM | SIGTSTP | SIGHUP',
          },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bash_session_read',
      description: 'Read scrollback buffer from a persistent bash session.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          offset: { type: 'number' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bash_session_close',
      description: 'Close a persistent bash session.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bash_session_list',
      description: 'List open persistent bash sessions.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const PWSH_SESSION_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'pwsh_session_open',
      description:
        'Open a persistent PowerShell session (PTY if available, else pipe). State survives across exec calls.',
      parameters: {
        type: 'object',
        properties: {
          workdir: {
            type: 'string',
            description:
              'Initial working directory relative to workspace (or absolute when full access)',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pwsh_session_exec',
      description:
        'Run a command in an open persistent PowerShell session and wait for the next prompt.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          command: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['sessionId', 'command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pwsh_session_write',
      description:
        'Write raw text to a persistent PowerShell session stdin without waiting for the prompt.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          data: { type: 'string' },
          submit: { type: 'boolean' },
        },
        required: ['sessionId', 'data'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pwsh_session_signal',
      description: 'Send a signal to a persistent PowerShell session.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          signal: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pwsh_session_read',
      description: 'Read scrollback buffer from a persistent PowerShell session.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          offset: { type: 'number' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pwsh_session_close',
      description: 'Close a persistent PowerShell session.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pwsh_session_list',
      description: 'List open persistent PowerShell sessions.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export async function fetchBashHealth(): Promise<BashHealth | null> {
  try {
    const res = await fetch(`${API_BASH}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()) as BashHealth;
  } catch {
    return null;
  }
}

export async function fetchPwshHealth(): Promise<PwshHealth | null> {
  try {
    const res = await fetch(`${API_PWSH}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()) as PwshHealth;
  } catch {
    return null;
  }
}

function formatBashResult(data: {
  ok?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  timedOut?: boolean;
  error?: string;
  workdir?: string;
  cwd?: string;
  durationMs?: number;
  command?: string;
  background?: boolean;
  jobId?: string;
}): string {
  if (data.background && data.jobId) {
    return [
      'Background job started.',
      `jobId: ${data.jobId}`,
      data.command ? `Command: ${data.command}` : '',
      data.workdir ? `Cwd: ${data.workdir}` : '',
      'Use job_output to read output; job_kill to stop; job_list to list.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (data.error && data.exitCode == null && !data.stdout && !data.stderr) {
    return `Bash failed: ${data.error}`;
  }
  const lines = [
    data.command ? `Command: ${data.command}` : '',
    data.workdir || data.cwd ? `Cwd: ${data.workdir || data.cwd}` : '',
    data.exitCode != null ? `Exit: ${data.exitCode}` : '',
    data.timedOut ? 'Timed out: yes' : '',
    data.truncated ? 'Output truncated: yes' : '',
    data.durationMs != null ? `Duration: ${data.durationMs}ms` : '',
    data.error ? `Error: ${data.error}` : '',
  ].filter(Boolean);
  const out = (data.stdout || '').trimEnd();
  const err = (data.stderr || '').trimEnd();
  return [
    lines.join('\n'),
    out ? `--- stdout ---\n${out}` : '--- stdout ---\n(empty)',
    err ? `--- stderr ---\n${err}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function runShellTool(
  api: string,
  label: string,
  argsJson: string,
  access: AccessLevel,
): Promise<string> {
  if (access === 'readonly') {
    return JSON.stringify({
      error: `${label} 需要「工作区内修改」或「完全权限」`,
    });
  }
  let args: { command?: string; workdir?: string; background?: boolean } = {};
  try {
    args = JSON.parse(argsJson || '{}') as typeof args;
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }
  const command = String(args.command ?? '').trim();
  if (!command) return JSON.stringify({ error: 'command is required' });
  const background = Boolean(args.background);

  try {
    const res = await fetch(`${api}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command,
        workdir: args.workdir,
        access,
        background,
      }),
      signal: AbortSignal.timeout(background ? 15_000 : 130_000),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok && data.error) {
      return formatBashResult({ error: String(data.error), command });
    }
    if (data.background && data.jobId) {
      return formatBashResult({
        background: true,
        jobId: String(data.jobId),
        command: (data.command as string | undefined) || command,
        workdir: data.workdir as string | undefined,
      });
    }
    return formatBashResult({
      ok: Boolean(data.ok),
      exitCode: data.exitCode as number | null | undefined,
      stdout: data.stdout as string | undefined,
      stderr: data.stderr as string | undefined,
      truncated: Boolean(data.truncated),
      timedOut: Boolean(data.timedOut),
      error: data.error ? String(data.error) : undefined,
      workdir: data.workdir as string | undefined,
      cwd: data.cwd as string | undefined,
      durationMs: data.durationMs as number | undefined,
      command: (data.command as string | undefined) || command,
    });
  } catch (e) {
    return `${label} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function runBashTool(argsJson: string, access: AccessLevel): Promise<string> {
  return runShellTool(API_BASH, 'Bash', argsJson, access);
}

export async function runPwshTool(argsJson: string, access: AccessLevel): Promise<string> {
  return runShellTool(API_PWSH, 'Pwsh', argsJson, access);
}

export async function runJobTool(
  name: string,
  argsJson: string,
  access: AccessLevel,
): Promise<string> {
  if (name === 'job_kill' && access === 'readonly') {
    return JSON.stringify({ error: 'job_kill 需要「工作区内修改」或「完全权限」' });
  }
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }

  try {
    if (name === 'job_list') {
      const res = await fetch(`${API_BASH}/jobs`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    if (name === 'job_output') {
      const jobId = String(args.jobId ?? args.id ?? '').trim();
      if (!jobId) return JSON.stringify({ error: 'jobId is required' });
      const res = await fetch(`${API_BASH}/job_output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          offset: args.offset,
          tail: args.tail,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    if (name === 'job_kill') {
      const jobId = String(args.jobId ?? args.id ?? '').trim();
      if (!jobId) return JSON.stringify({ error: 'jobId is required' });
      const res = await fetch(`${API_BASH}/job_kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, access }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    return JSON.stringify({ error: `unknown tool: ${name}` });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function runPersistentSessionTool(
  api: string,
  label: string,
  name: string,
  argsJson: string,
  access: AccessLevel,
): Promise<string> {
  if (access === 'readonly') {
    return JSON.stringify({ error: `${label} 需要「工作区内修改」或「完全权限」` });
  }
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }

  const action = name.replace(/^(bash|pwsh)_session_/, '');

  try {
    if (action === 'list') {
      const res = await fetch(`${api}/session/list`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    if (action === 'open') {
      const res = await fetch(`${api}/session/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access, workdir: args.workdir }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    if (action === 'exec') {
      const sessionId = String(args.sessionId ?? args.id ?? '').trim();
      const command = String(args.command ?? '');
      if (!sessionId) return JSON.stringify({ error: 'sessionId is required' });
      if (!command.trim()) return JSON.stringify({ error: 'command is required' });
      const res = await fetch(`${api}/session/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access,
          sessionId,
          command,
          timeoutMs: args.timeoutMs,
        }),
        signal: AbortSignal.timeout(130_000),
      });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    if (action === 'write') {
      const sessionId = String(args.sessionId ?? args.id ?? '').trim();
      const dataText = String(args.data ?? args.text ?? '');
      if (!sessionId) return JSON.stringify({ error: 'sessionId is required' });
      if (!dataText) return JSON.stringify({ error: 'data is required' });
      const res = await fetch(`${api}/session/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access,
          sessionId,
          data: dataText,
          submit: args.submit,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    if (action === 'signal') {
      const sessionId = String(args.sessionId ?? args.id ?? '').trim();
      if (!sessionId) return JSON.stringify({ error: 'sessionId is required' });
      const res = await fetch(`${api}/session/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access,
          sessionId,
          signal: args.signal,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    if (action === 'read') {
      const sessionId = String(args.sessionId ?? args.id ?? '').trim();
      if (!sessionId) return JSON.stringify({ error: 'sessionId is required' });
      const res = await fetch(`${api}/session/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, offset: args.offset }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    if (action === 'close') {
      const sessionId = String(args.sessionId ?? args.id ?? '').trim();
      if (!sessionId) return JSON.stringify({ error: 'sessionId is required' });
      const res = await fetch(`${api}/session/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, access }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
    return JSON.stringify({ error: `unknown tool: ${name}` });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

export async function runBashSessionTool(
  name: string,
  argsJson: string,
  access: AccessLevel,
): Promise<string> {
  return runPersistentSessionTool(API_BASH, 'bash session', name, argsJson, access);
}

export async function runPwshSessionTool(
  name: string,
  argsJson: string,
  access: AccessLevel,
): Promise<string> {
  return runPersistentSessionTool(API_PWSH, 'pwsh session', name, argsJson, access);
}
