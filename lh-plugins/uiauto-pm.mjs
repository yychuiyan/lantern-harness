/**
 * 包管理器：默认 pnpm，本机没装就退回 npm。
 *
 * 判定顺序（先到先用）：
 * 1. 项目里的锁文件 —— 这是团队已经做出的决定，不猜；
 * 2. `package.json` 的 `packageManager` —— 只是偏好：项目刚生成时还没有锁文件，
 *    写的是 pnpm 但本机没装，就该退回 npm 而不是直接报错；
 * 3. 什么线索都没有 —— 装了 pnpm 用 pnpm，否则 npm。
 *
 * 只做「能不能用」的探测，不替用户装 pnpm：换版本 / 装全局依赖这种事不归平台管。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PACKAGE_MANAGERS = ['pnpm', 'yarn', 'npm'];

/** `pnpm@10.15.0` → `pnpm`；空 / 不认识的返回空串 */
export function normalizeManagerName(raw) {
  const name = String(raw ?? '')
    .trim()
    .split('@')[0]
    .toLowerCase();
  return PACKAGE_MANAGERS.includes(name) ? name : '';
}

function executableFiles(name) {
  if (process.platform !== 'win32') return [name];
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  return [
    name,
    ...exts.map((ext) => `${name}${ext.toLowerCase()}`),
    ...exts.map((ext) => `${name}${ext}`),
  ];
}

function isExecutable(file) {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 在 PATH（以及几个常见的独立安装目录）里找可执行文件。
 * 不走 `spawnSync(name, ['-v'])`：那会在每次探测时起进程，面板刷新时很浪费。
 */
export function findExecutable(name, options = {}) {
  if (!name) return '';
  const env = options.env ?? process.env;
  const sep = path.delimiter;
  const fromEnv = String(env.PATH ?? env.Path ?? '')
    .split(sep)
    .filter(Boolean);
  // pnpm 独立安装（`pnpm setup`）会写自己的目录，GUI 进程不一定读得到 shell rc
  const extra = [
    env.PNPM_HOME,
    path.join(os.homedir(), '.local', 'share', 'pnpm'),
    path.join(os.homedir(), 'Library', 'pnpm'),
    path.join(os.homedir(), '.volta', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter(Boolean);
  const dirs = [...new Set([...fromEnv, ...(options.dirs ?? []), ...extra])];
  const names = executableFiles(name);
  for (const dir of dirs) {
    for (const file of names) {
      const abs = path.join(dir, file);
      if (isExecutable(abs)) return abs;
    }
  }
  return '';
}

let pnpmCache = null;
let pnpmCachedAt = 0;
const PNPM_TTL_MS = 60_000;

/** 本机有没有 pnpm（带 60s 缓存：装完 pnpm 不用重启面板） */
export function pnpmAvailable(options = {}) {
  const now = Date.now();
  if (pnpmCache !== null && now - pnpmCachedAt < PNPM_TTL_MS) return pnpmCache;
  pnpmCache = Boolean(findExecutable('pnpm', options));
  pnpmCachedAt = now;
  return pnpmCache;
}

function existsIn(dir, rel) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, rel));
  } catch {
    return false;
  }
}

/**
 * 决定这个项目该用哪个包管理器。
 * @param {{ dir?: string, declared?: string }} input `declared` 就是 package.json 的 packageManager
 * @param {{ hasPnpm?: () => boolean, hasYarn?: () => boolean }} deps 测试注入用
 * @returns {{ manager: 'pnpm'|'yarn'|'npm', source: string, note: string }}
 */
export function detectPackageManager(input = {}, deps = {}) {
  const hasPnpm = deps.hasPnpm ?? pnpmAvailable;
  const hasYarn = deps.hasYarn ?? (() => Boolean(findExecutable('yarn')));
  const dir = String(input.dir ?? '');
  const declared = normalizeManagerName(input.declared);
  const pick = (manager, source, note = '') => ({ manager, source, note });

  /** 锁文件已经是 pnpm，但本机没装：退回 npm 仍能装（只是会多出一份 package-lock） */
  const withFallback = (manager, source) => {
    if (manager === 'npm') return pick('npm', source);
    if (manager === 'pnpm') {
      return hasPnpm()
        ? pick('pnpm', source)
        : pick('npm', `${source}-fallback`, '本机没有 pnpm，已改用 npm');
    }
    return hasYarn()
      ? pick('yarn', source)
      : pick('npm', `${source}-fallback`, '本机没有 yarn，已改用 npm');
  };

  if (existsIn(dir, 'pnpm-lock.yaml')) return withFallback('pnpm', 'lockfile');
  if (existsIn(dir, 'yarn.lock')) return withFallback('yarn', 'lockfile');
  if (existsIn(dir, 'package-lock.json')) return pick('npm', 'lockfile');

  if (declared && declared !== 'npm') return withFallback(declared, 'declared');
  if (declared === 'npm') return pick('npm', 'declared');

  // 什么都没声明：默认 pnpm，本机没有就用 npm
  return hasPnpm() ? pick('pnpm', 'preferred') : pick('npm', 'preferred-fallback');
}

/** 某个包管理器对应的命令：安装、跑脚本、执行本地 CLI */
export function commandsFor(manager) {
  if (manager === 'pnpm') {
    return {
      name: 'pnpm',
      install: 'pnpm install',
      installCi: 'pnpm install --frozen-lockfile',
      run: (script) => `pnpm run ${script}`,
      exec: (bin, args = []) => `pnpm exec ${[bin, ...args].join(' ')}`,
      browserInstall: 'pnpm exec playwright install chromium',
      lockFile: 'pnpm-lock.yaml',
    };
  }
  if (manager === 'yarn') {
    return {
      name: 'yarn',
      install: 'yarn install',
      installCi: 'yarn install --immutable',
      run: (script) => `yarn run ${script}`,
      exec: (bin, args = []) => `yarn ${[bin, ...args].join(' ')}`,
      browserInstall: 'yarn playwright install chromium',
      lockFile: 'yarn.lock',
    };
  }
  return {
    name: 'npm',
    install: 'npm install',
    installCi: 'npm ci',
    run: (script) => `npm run ${script}`,
    exec: (bin, args = []) => `npx --no-install ${[bin, ...args].join(' ')}`,
    browserInstall: 'npx playwright install chromium',
    lockFile: 'package-lock.json',
  };
}

/** 一键：探测 + 取命令 */
export function resolvePackageManager(input = {}, deps = {}) {
  const resolved = detectPackageManager(input, deps);
  return { ...resolved, commands: commandsFor(resolved.manager) };
}
