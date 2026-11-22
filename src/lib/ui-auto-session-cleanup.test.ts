/**
 * 生成会话过期清理：不进工作台侧栏的盲盒缓存，到点连截图一起清。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  cleanupStaleSessions,
  deleteGeneratedSession,
  SESSION_TTL_MS,
  sessionFilePath,
  sessionsDir,
} from '../../lh-plugins/uiauto-explorer/sessions.mjs';

const temps: string[] = [];

function tempBase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-session-clean-'));
  temps.push(dir);
  return dir;
}

function writeSession(
  baseDir: string,
  id: string,
  patch: { updatedAt?: string; createdAt?: string; title?: string } = {},
) {
  const dir = sessionsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const record = {
    id,
    projectId: 'pj_test',
    title: patch.title || id,
    status: 'draft',
    createdAt: patch.createdAt || now,
    updatedAt: patch.updatedAt || now,
  };
  fs.writeFileSync(sessionFilePath(baseDir, id), `${JSON.stringify(record, null, 2)}\n`);
  const shots = path.join(dir, id, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, '01-demo.png'), 'fake-png');
  return record;
}

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('cleanupStaleSessions', () => {
  it('只删超过 TTL 的会话，并带走 shots 目录', () => {
    const base = tempBase();
    const now = Date.parse('2026-11-08T01:00:00.000Z');
    writeSession(base, 'gen_old', {
      updatedAt: new Date(now - SESSION_TTL_MS - 60_000).toISOString(),
    });
    writeSession(base, 'gen_new', {
      updatedAt: new Date(now - 60_000).toISOString(),
    });

    const result = cleanupStaleSessions(base, { now, ttlMs: SESSION_TTL_MS });
    assert.deepEqual(result.removed, ['gen_old']);
    assert.equal(fs.existsSync(sessionFilePath(base, 'gen_old')), false);
    assert.equal(fs.existsSync(path.join(sessionsDir(base), 'gen_old')), false);
    assert.equal(fs.existsSync(sessionFilePath(base, 'gen_new')), true);
    assert.equal(
      fs.existsSync(path.join(sessionsDir(base), 'gen_new', 'shots', '01-demo.png')),
      true,
    );
  });

  it('没有对应 JSON 的孤儿 shots 目录也会清', () => {
    const base = tempBase();
    const now = Date.parse('2026-11-08T01:00:00.000Z');
    const orphan = path.join(sessionsDir(base), 'gen_orphan', 'shots');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, '01.png'), 'x');
    // 把目录 mtime 拨到过期前
    const old = (now - SESSION_TTL_MS - 120_000) / 1000;
    fs.utimesSync(path.join(sessionsDir(base), 'gen_orphan'), old, old);
    fs.utimesSync(orphan, old, old);

    const result = cleanupStaleSessions(base, { now, ttlMs: SESSION_TTL_MS });
    assert.ok(result.removed.includes('gen_orphan'));
    assert.equal(fs.existsSync(path.join(sessionsDir(base), 'gen_orphan')), false);
  });

  it('deleteGeneratedSession 同时删 JSON 与 shots', () => {
    const base = tempBase();
    writeSession(base, 'gen_x');
    assert.equal(deleteGeneratedSession(base, 'gen_x'), true);
    assert.equal(fs.existsSync(sessionFilePath(base, 'gen_x')), false);
    assert.equal(fs.existsSync(path.join(sessionsDir(base), 'gen_x')), false);
    assert.equal(deleteGeneratedSession(base, 'gen_missing'), false);
  });
});
