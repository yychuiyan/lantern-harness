import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CASE_BACKUP_TTL_MS,
  backupExpiresAt,
  backupExpiryLabel,
  isCaseBackupFile,
  pickExpiredCaseBackups,
  pickExpiredReviewBackupFiles,
} from './case-backup-ttl';

describe('isCaseBackupFile', () => {
  it('识别旁路 bak 命名', () => {
    assert.equal(isCaseBackupFile('a.xlsx.bak-fix5-261024-1401'), true);
    assert.equal(isCaseBackupFile('a.xlsx.bak'), true);
    assert.equal(isCaseBackupFile('a.bak-230107'), true);
    assert.equal(isCaseBackupFile('dir/a.xlsx.bak-void90-261024'), true);
  });

  it('正式用例与普通文件不认', () => {
    assert.equal(isCaseBackupFile('政企通_功能测试用例.xlsx'), false);
    assert.equal(isCaseBackupFile('cases.md'), false);
    assert.equal(isCaseBackupFile('backup.xlsx'), false);
  });
});

describe('pickExpiredCaseBackups', () => {
  const now = 1_000_000_000_000;

  it('mtime 超过 TTL 才删', () => {
    const expired = pickExpiredCaseBackups(
      [
        { path: 'a.xlsx.bak-old', name: 'a.xlsx.bak-old', mtime: now - CASE_BACKUP_TTL_MS - 1 },
        { path: 'b.xlsx.bak-new', name: 'b.xlsx.bak-new', mtime: now - 1000 },
        { path: 'c.xlsx', name: 'c.xlsx', mtime: now - CASE_BACKUP_TTL_MS * 10 },
      ],
      { now },
    );
    assert.deepEqual(
      expired.map((e) => e.path),
      ['a.xlsx.bak-old'],
    );
  });

  it('无 mtime 不删', () => {
    assert.deepEqual(
      pickExpiredCaseBackups([{ path: 'a.xlsx.bak', name: 'a.xlsx.bak' }], { now }),
      [],
    );
  });
});

describe('pickExpiredReviewBackupFiles', () => {
  const now = 1_000_000_000_000;

  it('backup 目录内按 mtime，不要求 .bak 后缀', () => {
    const expired = pickExpiredReviewBackupFiles(
      [
        { path: '2026-stamp-cases.xlsx', mtime: now - CASE_BACKUP_TTL_MS - 1 },
        { path: 'fresh.xlsx', mtime: now - 60_000 },
      ],
      { now },
    );
    assert.deepEqual(
      expired.map((e) => e.path),
      ['2026-stamp-cases.xlsx'],
    );
  });
});

describe('backupExpiresAt / backupExpiryLabel', () => {
  const now = 1_000_000_000_000;

  it('过期时刻 = mtime + TTL', () => {
    assert.equal(backupExpiresAt(now - 1000), now - 1000 + CASE_BACKUP_TTL_MS);
  });

  it('文案：已过期 / 还有 N 天 / 还有 N 小时', () => {
    assert.equal(backupExpiryLabel(now - CASE_BACKUP_TTL_MS - 1, { now }), '已过期');
    assert.equal(
      backupExpiryLabel(now - CASE_BACKUP_TTL_MS + 3 * 24 * 60 * 60 * 1000, { now }),
      '还有 3 天',
    );
    assert.equal(
      backupExpiryLabel(now - CASE_BACKUP_TTL_MS + 5 * 60 * 60 * 1000, { now }),
      '还有 5 小时',
    );
    assert.equal(
      backupExpiryLabel(now - CASE_BACKUP_TTL_MS + 30 * 60 * 1000, { now }),
      '不足 1 小时',
    );
  });
});
