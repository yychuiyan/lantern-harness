/**
 * 与 src/lib/case-backup-ttl.ts 对齐：评审 backup 目录按 mtime 清理。
 */
import fs from 'node:fs';
import path from 'node:path';

export const CASE_BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 清掉目录内 mtime 超过 TTL 的文件；单文件失败跳过。 */
export function purgeExpiredFilesInDir(dirAbs, opts = {}) {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? CASE_BACKUP_TTL_MS;
  const deleted = [];
  if (!dirAbs || !fs.existsSync(dirAbs)) return deleted;
  let names;
  try {
    names = fs.readdirSync(dirAbs);
  } catch {
    return deleted;
  }
  for (const name of names) {
    const abs = path.join(dirAbs, name);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < ttlMs) continue;
      fs.unlinkSync(abs);
      deleted.push(abs);
    } catch {
      // 单文件跳过
    }
  }
  return deleted;
}
