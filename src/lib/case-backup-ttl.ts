/**
 * 用例写前备份失效清理：旁路 `.bak*` 与评审 backup 目录按 mtime 过期删除。
 * 不解析文件名时间戳（命名不规则），只认修改时间。
 */

/** 默认保留 7 天 */
export const CASE_BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 与用例库 junk 规则一致：`xxx.xlsx.bak-230107`、`xxx.bak` */
export function isCaseBackupFile(name: string): boolean {
  const base = String(name ?? '')
    .split(/[/\\]/)
    .pop();
  if (!base) return false;
  return /\.bak(?:$|[-_.])/i.test(base);
}

export interface BackupCandidate {
  /** 相对或绝对路径（仅透传，删除时用） */
  path: string;
  name?: string;
  /** 修改时间 ms；缺省视为不过期（不删） */
  mtime?: number;
}

/**
 * 从候选里挑出已过期的备份（正式用例文件不会进候选，由调用方过滤）。
 */
export function pickExpiredCaseBackups(
  entries: readonly BackupCandidate[],
  opts?: { now?: number; ttlMs?: number },
): BackupCandidate[] {
  const now = opts?.now ?? Date.now();
  const ttlMs = opts?.ttlMs ?? CASE_BACKUP_TTL_MS;
  const out: BackupCandidate[] = [];
  for (const e of entries) {
    const label = e.name || e.path;
    if (!isCaseBackupFile(label) && !isCaseBackupFile(e.path)) continue;
    const mtime = typeof e.mtime === 'number' ? e.mtime : NaN;
    if (!Number.isFinite(mtime)) continue;
    if (now - mtime >= ttlMs) out.push(e);
  }
  return out;
}

/** 评审 backup 目录内：目录里的文件一律视为备份（不要求 .bak 后缀） */
export function pickExpiredReviewBackupFiles(
  entries: readonly BackupCandidate[],
  opts?: { now?: number; ttlMs?: number },
): BackupCandidate[] {
  const now = opts?.now ?? Date.now();
  const ttlMs = opts?.ttlMs ?? CASE_BACKUP_TTL_MS;
  const out: BackupCandidate[] = [];
  for (const e of entries) {
    const mtime = typeof e.mtime === 'number' ? e.mtime : NaN;
    if (!Number.isFinite(mtime)) continue;
    if (now - mtime >= ttlMs) out.push(e);
  }
  return out;
}

/** 备份过期时刻（mtime + TTL） */
export function backupExpiresAt(mtime: number, ttlMs = CASE_BACKUP_TTL_MS): number {
  return mtime + ttlMs;
}

/**
 * 过期文案：已过期 / 不足 1 小时 / 还有 N 小时 / 还有 N 天
 */
export function backupExpiryLabel(mtime: number, opts?: { now?: number; ttlMs?: number }): string {
  const now = opts?.now ?? Date.now();
  const ttlMs = opts?.ttlMs ?? CASE_BACKUP_TTL_MS;
  if (!Number.isFinite(mtime)) return '—';
  const left = backupExpiresAt(mtime, ttlMs) - now;
  if (left <= 0) return '已过期';
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (left < hour) return '不足 1 小时';
  if (left < day) return `还有 ${Math.ceil(left / hour)} 小时`;
  return `还有 ${Math.ceil(left / day)} 天`;
}
