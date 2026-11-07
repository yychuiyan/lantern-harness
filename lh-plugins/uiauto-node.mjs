/**
 * Node 版本：读项目约定的版本（`.nvmrc` / `package.json` 的 engines），
 * 再扫本机 nvm / fnm / volta 里已装好的版本。
 *
 * 只做两件事：把「项目要哪个 Node」查出来、把跑用例时的 PATH 指到那个 Node 的 bin。
 * 不去改用户 shell 的版本——`nvm use` 是 shell 函数，子进程里切了也不影响用户的终端；
 * 想在本机终端手动切，面板给出可复制的命令即可。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findExecutable } from './uiauto-pm.mjs';

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/i;

/** `22` / `v22.23.0` / `22.23.0-linux-x64` → `[22, 23, 0]`；认不出返回 null */
export function parseNodeVersion(raw) {
  const matched = VERSION_RE.exec(String(raw ?? '').trim());
  if (!matched) return null;
  return [Number(matched[1]), Number(matched[2] ?? 0), Number(matched[3] ?? 0)];
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 版本是否满足要求。支持 `.nvmrc` 里常见的写法：
 * 精确 `22.23.0`、前缀 `22` / `22.23`、范围 `>=20 <23`、`^22.23.0`、`~22.23.0`、`lts/*`。
 */
export function satisfiesNode(version, requirement) {
  const target = parseNodeVersion(version);
  if (!target) return false;
  const req = String(requirement ?? '').trim();
  if (!req || req === '*' || /^(node|lts|lts\/\*|lts-\*|latest)$/i.test(req)) return true;
  // 空格分隔的多段（`>=20 <23`）逐段都要满足
  const parts = req.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.every((part) => satisfiesNode(version, part));

  const matched = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(req);
  if (!matched) return false;
  const operator = matched[1] ?? '';
  const raw = matched[2].trim();
  const wanted = parseNodeVersion(raw);
  if (!wanted) return false;

  switch (operator) {
    case '>=':
      return compareVersion(target, wanted) >= 0;
    case '<=':
      return compareVersion(target, wanted) <= 0;
    case '>':
      return compareVersion(target, wanted) > 0;
    case '<':
      return compareVersion(target, wanted) < 0;
    case '=':
      return compareVersion(target, wanted) === 0;
    case '^': {
      // ^22.23.0 → >=22.23.0 <23.0.0
      const upper = wanted[0] === 0 ? [0, wanted[1] + 1, 0] : [wanted[0] + 1, 0, 0];
      return compareVersion(target, wanted) >= 0 && compareVersion(target, upper) < 0;
    }
    case '~': {
      // ~22.23.0 → >=22.23.0 <22.24.0
      const upper = [wanted[0], wanted[1] + 1, 0];
      return compareVersion(target, wanted) >= 0 && compareVersion(target, upper) < 0;
    }
    default: {
      // 没写运算符：精确 / 前缀匹配（`22` 只比 major，`22.23` 比到 minor）
      const digits = String(raw)
        .replace(/^v/i, '')
        .split('.')
        .filter((part) => part !== '');
      if (digits.length >= 3) return compareVersion(target, wanted) === 0;
      return digits.every((part, index) => target[index] === wanted[index]);
    }
  }
}

/** 读目录下已装的版本；读不到就当没装 */
function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 本机各版本管理器里装好的 Node。
 * 返回 `[{ manager, version, binDir }]`，`binDir` 含 `node` 可执行文件。
 */
export function listNodeInstallations() {
  const home = os.homedir();
  const out = [];
  const seen = new Set();

  const add = (manager, versionsDir, binRel) => {
    for (const name of safeList(versionsDir)) {
      const parsed = parseNodeVersion(name);
      if (!parsed) continue;
      const base = path.join(versionsDir, name);
      // nvm 是 `v22.23.0/bin`；fnm 是 `v22.23.0/installation/bin`；Windows 上可执行文件直接在版本目录
      const candidates = [path.join(base, binRel), base].filter(Boolean);
      const binDir = candidates.find((dir) => {
        try {
          return fs.existsSync(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'));
        } catch {
          return false;
        }
      });
      if (!binDir) continue;
      const key = `${binDir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ manager, version: parsed.join('.'), binDir });
    }
  };

  const nvmRoots = [process.env.NVM_DIR, path.join(home, '.nvm')].filter(Boolean);
  for (const root of nvmRoots) add('nvm', path.join(root, 'versions', 'node'), 'bin');

  const fnmRoots =
    process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'fnm')]
      : process.platform === 'win32'
        ? [path.join(process.env.APPDATA ?? '', 'fnm')]
        : [path.join(home, '.local', 'share', 'fnm')];
  for (const root of fnmRoots) {
    if (!root) continue;
    add('fnm', path.join(root, 'node-versions'), path.join('installation', 'bin'));
  }

  add('volta', path.join(home, '.volta', 'tools', 'image', 'node'), 'bin');

  return out.sort((a, b) => {
    const left = parseNodeVersion(a.version);
    const right = parseNodeVersion(b.version);
    return compareVersion(right, left);
  });
}

/** 项目声明的 Node：`.nvmrc` 优先，其次 `.node-version`（fnm / asdf 也认这个），最后 engines */
export function readNodeRequirement(dir) {
  const root = path.resolve(dir);
  const readFirstLine = (name) => {
    try {
      const first = fs.readFileSync(path.join(root, name), 'utf8').split(/\r?\n/)[0] ?? '';
      return first.trim().replace(/^v/i, '');
    } catch {
      return '';
    }
  };
  const nvmrc = readFirstLine('.nvmrc');
  const nodeVersion = nvmrc ? '' : readFirstLine('.node-version');
  let engines = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    engines = String(pkg?.engines?.node ?? '').trim();
  } catch {
    engines = '';
  }
  return { nvmrc, nodeVersion, engines, required: nvmrc || nodeVersion || engines };
}

/**
 * 面板用的状态：项目要哪个版本、本机跑的是哪个、哪个已装版本能满足。
 * `matched` 就是跑用例时会用的那个 Node（bin 目录）。
 */
export function nodeStatus(dir) {
  const requirement = readNodeRequirement(dir);
  const running = process.versions.node;
  const installations = listNodeInstallations();
  const match = requirement.required
    ? (installations.find((item) => satisfiesNode(item.version, requirement.required)) ?? null)
    : null;
  return {
    ...requirement,
    running,
    runningSatisfies: requirement.required ? satisfiesNode(running, requirement.required) : true,
    matched: match,
    installations,
    // 装过版本的版本管理器（拿它决定面板上的手动切换命令该怎么写）
    managers: [...new Set(installations.map((item) => item.manager))],
    // 本机装了哪些能装 Node 的版本管理器（nvm / fnm / volta）；没装任何版本时 managers 是空的，
    // 但它决定了「能不能一键装」——两者不是一回事，别混着判断
    installers: nodeInstallers().map((item) => item.manager),
  };
}

/** 跑用例时的 PATH 前缀：项目要求的版本装了，就用它，别用面板启动时那个 Node */
export function projectNodeBinDir(dir) {
  try {
    return nodeStatus(dir).matched?.binDir ?? '';
  } catch {
    return '';
  }
}

/** 给 spawn 的 env 挂上项目 Node（只改 PATH，不动用户其它变量） */
export function withProjectNode(env, dir) {
  if (!dir) return env;
  const binDir = projectNodeBinDir(dir);
  if (!binDir) return env;
  const current = env.PATH ?? env.Path ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const parts = current ? current.split(sep) : [];
  if (parts[0] === binDir) return env;
  return {
    ...env,
    PATH: [binDir, ...parts.filter((part) => part && part !== binDir)].join(sep),
  };
}

/* ────────────────────── 安装缺失版本 ────────────────────── */

/** 安装时只接受具体版本（`22` / `22.23.0`）：范围没法直接装，得先让人选具体版本 */
export function concreteNodeVersion(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^[v^~=\s]+/i, '');
  if (!/^\d+(\.\d+){0,2}$/.test(text)) return '';
  return text;
}

function firstExisting(files) {
  for (const file of files) {
    if (!file) continue;
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      // 没权限就当没有
    }
  }
  return '';
}

/**
 * 本机装了哪个版本管理器（能装 Node 的那些）。
 * nvm 是 shell 函数而不是可执行文件，只能靠 `nvm.sh` 判断，执行时要在 bash 里 source。
 */
export function nodeInstallers(options = {}) {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const found = [];

  const nvmSh = firstExisting([
    env.NVM_DIR ? path.join(env.NVM_DIR, 'nvm.sh') : '',
    path.join(home, '.nvm', 'nvm.sh'),
  ]);
  if (nvmSh) found.push({ manager: 'nvm', kind: 'nvm', nvmSh });

  const fnm = findExecutable('fnm', { env });
  if (fnm) found.push({ manager: 'fnm', kind: 'bin', bin: fnm });

  const volta = findExecutable('volta', { env });
  if (volta) found.push({ manager: 'volta', kind: 'bin', bin: volta });

  return found;
}

/**
 * 装一个 Node 版本要执行的命令。
 *
 * 多个管理器都装了时按 nvm → fnm → volta 选：nvm 装出来的版本归 nvm 管，
 * 面板扫描（`listNodeInstallations`）默认也先去 nvm 目录找，装完就能立刻用上。
 *
 * @returns {{ manager: string, command: string, file: string, args: string[] } | { error: string }}
 */
export function nodeInstallPlan(version, options = {}) {
  const target = concreteNodeVersion(version);
  if (!target) {
    return { error: '安装需要具体版本号（例如 22.23.0），范围写法请先选定一个版本' };
  }
  const [installer] = nodeInstallers(options);
  if (!installer) {
    return { error: '本机没有 nvm / fnm / volta，先装其中一个版本管理器，或手动安装该 Node 版本' };
  }
  if (installer.kind === 'nvm') {
    // nvm 是函数：必须进 bash 里 source 之后再调用
    return {
      manager: 'nvm',
      command: `nvm install ${target}`,
      file: process.platform === 'win32' ? 'bash.exe' : '/bin/bash',
      args: ['-c', `source "${installer.nvmSh}" && nvm install ${target}`],
    };
  }
  if (installer.manager === 'volta') {
    return {
      manager: 'volta',
      command: `volta install node@${target}`,
      file: installer.bin,
      args: ['install', `node@${target}`],
    };
  }
  return {
    manager: 'fnm',
    command: `fnm install ${target}`,
    file: installer.bin,
    args: ['install', target],
  };
}

/** 写 `.nvmrc`：只接受具体版本号（`22` / `22.23.0`），空串表示删掉这个文件 */
export function writeNvmrc(dir, version) {
  const raw = String(version ?? '')
    .trim()
    .replace(/^v/i, '');
  const file = path.join(path.resolve(dir), '.nvmrc');
  if (!raw) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 本来就没有
    }
    return { version: '', file };
  }
  if (!/^\d+(\.\d+){0,2}$/.test(raw)) {
    throw new Error('Node 版本只能是 22 或 22.23.0 这种写法');
  }
  fs.writeFileSync(file, `${raw}\n`, 'utf8');
  return { version: raw, file };
}
