import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  commandsFor,
  detectPackageManager,
  findExecutable,
  normalizeManagerName,
  resolvePackageManager,
} from '../../lh-plugins/uiauto-pm.mjs';

let dir = '';

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-pm-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function project(name: string, files: string[] = []): string {
  const target = path.join(dir, name);
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(target, file), '');
  return target;
}

const hasPnpm = () => true;
const noPnpm = () => false;

describe('包管理器探测', () => {
  it('lockfile 名字归一化', () => {
    assert.equal(normalizeManagerName('pnpm@10.15.0'), 'pnpm');
    assert.equal(normalizeManagerName('npm'), 'npm');
    assert.equal(normalizeManagerName(' yarn@4 '), 'yarn');
    assert.equal(normalizeManagerName(''), '');
    assert.equal(normalizeManagerName('bun@1.1.0'), '');
  });

  it('锁文件是团队约定，优先于 packageManager 与偏好', () => {
    const pnpmDir = project('lock-pnpm', ['pnpm-lock.yaml']);
    assert.equal(detectPackageManager({ dir: pnpmDir }, { hasPnpm }).manager, 'pnpm');
    assert.equal(
      detectPackageManager({ dir: pnpmDir, declared: 'npm' }, { hasPnpm }).manager,
      'pnpm',
    );

    const npmDir = project('lock-npm', ['package-lock.json']);
    assert.equal(
      detectPackageManager({ dir: npmDir, declared: 'pnpm' }, { hasPnpm }).manager,
      'npm',
    );

    const yarnDir = project('lock-yarn', ['yarn.lock']);
    assert.equal(
      detectPackageManager({ dir: yarnDir }, { hasPnpm, hasYarn: () => true }).manager,
      'yarn',
    );
  });

  it('本机没装 pnpm 时，pnpm 的项目退回 npm 并带说明', () => {
    const pnpmDir = project('lock-pnpm-missing', ['pnpm-lock.yaml']);
    const resolved = detectPackageManager({ dir: pnpmDir }, { hasPnpm: noPnpm });
    assert.equal(resolved.manager, 'npm');
    assert.match(resolved.note, /没有 pnpm/);
  });

  it('没有锁文件时 packageManager 只是偏好，装没装决定最终结果', () => {
    const fresh = project('fresh');
    assert.equal(detectPackageManager({ dir: fresh }, { hasPnpm }).manager, 'pnpm');
    assert.equal(detectPackageManager({ dir: fresh }, { hasPnpm: noPnpm }).manager, 'npm');

    const declared = detectPackageManager({ dir: fresh, declared: 'pnpm@10.15.0' }, { hasPnpm });
    assert.equal(declared.manager, 'pnpm');
    assert.equal(declared.source, 'declared');

    const declaredNoBin = detectPackageManager(
      { dir: fresh, declared: 'pnpm@10.15.0' },
      { hasPnpm: noPnpm },
    );
    assert.equal(declaredNoBin.manager, 'npm');
    assert.match(declaredNoBin.note, /没有 pnpm/);

    assert.equal(detectPackageManager({ dir: fresh, declared: 'npm' }, { hasPnpm }).manager, 'npm');
  });

  it('默认偏好 pnpm，但本机没装就用 npm', () => {
    assert.equal(detectPackageManager({}, { hasPnpm }).source, 'preferred');
    assert.equal(detectPackageManager({}, { hasPnpm: noPnpm }).source, 'preferred-fallback');
    assert.equal(detectPackageManager({}, { hasPnpm: noPnpm }).manager, 'npm');
  });

  it('目录不存在也不抛错', () => {
    const missing = path.join(dir, 'not-exists');
    assert.equal(detectPackageManager({ dir: missing }, { hasPnpm }).manager, 'pnpm');
  });

  it('命令跟着包管理器变，浏览器内核一律只装 chromium', () => {
    assert.deepEqual(
      [commandsFor('pnpm').install, commandsFor('pnpm').browserInstall],
      ['pnpm install', 'pnpm exec playwright install chromium'],
    );
    assert.deepEqual(
      [commandsFor('npm').install, commandsFor('npm').browserInstall],
      ['npm install', 'npx playwright install chromium'],
    );
    assert.deepEqual(
      [commandsFor('yarn').install, commandsFor('yarn').browserInstall],
      ['yarn install', 'yarn playwright install chromium'],
    );
    assert.equal(commandsFor('pnpm').run('test:smoke'), 'pnpm run test:smoke');
    assert.equal(commandsFor('npm').run('test:smoke'), 'npm run test:smoke');
    assert.equal(commandsFor('npm').installCi, 'npm ci');
    assert.equal(commandsFor('pnpm').installCi, 'pnpm install --frozen-lockfile');
  });

  it('resolvePackageManager 一并给出命令', () => {
    const resolved = resolvePackageManager({ declared: 'npm' }, { hasPnpm });
    assert.equal(resolved.manager, 'npm');
    assert.equal(resolved.commands.install, 'npm install');
  });

  it('PATH 里能找到 node（探测本身是可靠的）', () => {
    assert.ok(findExecutable('node'));
    assert.equal(findExecutable('绝对不存在的命令-xyz'), '');
  });
});
