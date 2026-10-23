/**
 * 版本检测 / 一键更新的前端取数。
 *
 * 约定：这里所有请求都可能因为「服务正在重启」而失败，
 * 因此失败一律返回 null 或 `{ ok: false }`，不向上抛——
 * 调用方需要区分「没有新版本」和「暂时连不上」时看 null。
 */

export type UpdateMode = 'npx' | 'global' | 'dev';

export interface UpdateStatus {
  phase: 'installing' | 'restarting' | 'done' | 'failed';
  from: string;
  to: string;
  startedAt: string;
  finishedAt: string;
  error: string;
}

export interface UpdateInfo {
  ok: boolean;
  current: string;
  latest: string;
  hasUpdate: boolean;
  mode: UpdateMode;
  pm: string;
  registry: string;
  checkedAt: string;
  error: string;
  status: UpdateStatus | null;
  logPath: string;
}

const API = '/__tb_update';

/** 取版本信息；离线 / 服务重启中返回 null */
export async function fetchUpdateInfo(refresh = false): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(refresh ? `${API}?refresh=1` : API, {
      signal: AbortSignal.timeout(6000),
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as UpdateInfo;
    if (!data || typeof data.current !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

/** 启动更新；服务会在几百毫秒后停掉，响应本身也会随之断开 */
export async function startUpdate(version?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(API, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' },
      // confirm 是服务端的硬约束：没有它一律拒绝，避免旧页面 / 脚本顺手把服务停掉升级
      body: JSON.stringify(version ? { confirm: true, version } : { confirm: true }),
    });
    // 202：已受理，随后服务会重启
    if (res.status === 202) return { ok: true };
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  } catch (e) {
    // 请求已发出但响应没读到，多半是服务已经开始重启：按成功处理，
    // 由后续轮询确认最终版本；真正失败时状态文件会写 failed。
    return { ok: true, error: e instanceof Error ? e.message : String(e) };
  }
}
