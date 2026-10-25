/**
 * LLM 瞬时失败重试（llm-retry）：429 / 5xx / 网络错误。
 */

export interface LlmRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export function isRetryableLlmError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';
  if (msg.includes('网络请求失败')) return true;
  if (/failed to fetch/i.test(msg)) return true;
  if (/networkerror|load failed|econnreset|econnrefused/i.test(msg)) return true;
  if (msg.includes('限流')) return true;
  if (msg.includes('繁忙')) return true;
  if (/service_unavailable/i.test(msg)) return true;
  if (/too busy/i.test(msg)) return true;
  if (/\(HTTP (429|502|503|504)\)/.test(msg)) return true;
  if (/请求失败（HTTP (429|502|503|504)）/.test(msg)) return true;
  return false;
}

export function retryDelayMs(attempt: number, baseDelayMs = 400): number {
  const n = Math.max(0, attempt);
  const jitter = Math.floor(Math.random() * 120);
  return Math.min(8_000, baseDelayMs * 2 ** n + jitter);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 对可重试错误最多尝试 maxAttempts 次（含首次） */
export async function withLlmRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: LlmRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3));
  const baseDelayMs = opts.baseDelayMs ?? 400;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (!isRetryableLlmError(e) || attempt >= maxAttempts - 1) throw e;
      await sleep(retryDelayMs(attempt, baseDelayMs), opts.signal);
    }
  }
  throw lastErr;
}
