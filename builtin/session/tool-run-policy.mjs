/**
 * 与 src/lib/tool-run-policy.ts 语义对齐（服务端 session-runs 用）。
 */

export function defaultTimeoutMs(toolName) {
  const n = String(toolName || '');
  if (n === 'bash' || n === 'pwsh' || n.endsWith('_session_exec')) return 120_000;
  if (n.startsWith('bash_session_') || n.startsWith('pwsh_session_')) return 30_000;
  if (n === 'web_fetch') return 35_000;
  if (n === 'web_search') return 30_000;
  if (n.startsWith('mcp__')) return 60_000;
  if (n.startsWith('fs_') || n.startsWith('kb_') || n.startsWith('memory_')) return 30_000;
  if (n.startsWith('subagent_') || n === 'spawn_subagent' || n === 'fork_subagent') return 300_000;
  return 60_000;
}

export async function withToolTimeout(promise, timeoutMs, label = 'tool') {
  const ms = Math.max(1_000, Math.min(600_000, Number(timeoutMs) || 60_000));
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
