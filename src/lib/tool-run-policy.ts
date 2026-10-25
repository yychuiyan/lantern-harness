/**
 * 轻量工具执行边界：默认超时 + withToolTimeout。
 * 不做多后端 executor / OS 沙箱；写闸仍由 access + planGatesWrites 负责。
 */

export function defaultTimeoutMs(toolName: string): number {
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

export async function withToolTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = 'tool',
): Promise<T> {
  const ms = Math.max(1_000, Math.min(600_000, Number(timeoutMs) || 60_000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 包装 runTool：按工具名套默认超时 */
export function wrapRunTool(
  runTool: (name: string, argsJson: string) => Promise<string>,
): (name: string, argsJson: string) => Promise<string> {
  return async (name, argsJson) => {
    try {
      return await withToolTimeout(runTool(name, argsJson), defaultTimeoutMs(name), name || 'tool');
    } catch (e) {
      return JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
}
