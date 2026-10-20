/**
 * 「打开方式」：探测本机装了什么能打开文件的应用，并按用户选择拉起。
 *
 * 只列真能打开的：先看 /Applications 与 ~/Applications 里的 .app 包，
 * 再补 PATH 里的命令行工具；没装的项不出现，不写死整张表。
 * 图标用 macOS 自带的 qlmanage 从 .app 里抽，缓存到数据空间，避免每次打开都抽。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 已知应用表：bundle 名 / 进程名 / CLI 名。
 * `order` 决定菜单顺序（访达固定第一，终端固定最后）。
 */
const KNOWN_APPS = [
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'editor',
    bundles: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'],
    clis: ['code'],
    order: 10,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    bundles: ['Cursor.app'],
    clis: ['cursor'],
    order: 20,
  },
  {
    id: 'vscodium',
    label: 'VSCodium',
    kind: 'editor',
    bundles: ['VSCodium.app'],
    clis: ['codium'],
    order: 30,
  },
  {
    id: 'xcode',
    label: 'Xcode',
    kind: 'editor',
    bundles: ['Xcode.app'],
    clis: [],
    order: 40,
  },
  {
    id: 'sourcetree',
    label: 'Sourcetree',
    kind: 'editor',
    bundles: ['Sourcetree.app'],
    clis: [],
    order: 50,
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    kind: 'editor',
    bundles: ['WebStorm.app'],
    clis: ['webstorm'],
    order: 60,
  },
  {
    id: 'idea',
    label: 'IntelliJ IDEA',
    kind: 'editor',
    bundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'],
    clis: ['idea'],
    order: 70,
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    kind: 'editor',
    bundles: ['Sublime Text.app'],
    clis: ['subl'],
    order: 80,
  },
  {
    id: 'iterm',
    label: 'iTerm2',
    kind: 'terminal',
    bundles: ['iTerm.app', 'iTerm2.app'],
    clis: [],
    order: 800,
  },
  {
    id: 'terminal',
    label: '终端',
    kind: 'terminal',
    bundles: ['Terminal.app'],
    clis: [],
    order: 900,
  },
];

/** 访达不真实存在于 /Applications，单独处理 */
const FINDER = { id: 'finder', label: '访达', kind: 'finder', order: 0 };

/** 默认打开方式：VS Code 优先，其次任一编辑器，最后访达 */
export const DEFAULT_OPEN_APP = 'vscode';

function appDirs() {
  if (process.platform !== 'darwin') return [];
  return ['/Applications', path.join(os.homedir(), 'Applications')];
}

function findBundle(names) {
  for (const dir of appDirs()) {
    for (const name of names) {
      const abs = path.join(dir, name);
      if (fs.existsSync(abs)) return abs;
    }
  }
  return '';
}

async function findCli(name) {
  const dirs = String(process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  // 版本管理器装的 GUI 编辑器常常不在 GUI 进程的 PATH 里，补几个常见位置
  dirs.push('/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local/bin'));
  for (const dir of dirs) {
    const abs = path.join(dir, name);
    try {
      fs.accessSync(abs, fs.constants.X_OK);
      return abs;
    } catch {
      /* 下一个 */
    }
  }
  return '';
}

/**
 * 本机可用的打开方式。
 * 返回项已排序：访达 → 编辑器（常见度）→ 终端；一个都没有时只留访达（Windows / Linux 留资源管理器）。
 */
export async function listOpenApps() {
  const apps = [];
  if (process.platform === 'darwin') apps.push({ ...FINDER });

  for (const known of KNOWN_APPS) {
    const appPath = findBundle(known.bundles);
    const cli = await findCli(known.clis[0] ?? '');
    if (!appPath && !cli) continue;
    apps.push({
      id: known.id,
      label: known.label,
      kind: known.kind,
      order: known.order,
      appPath,
      cli,
    });
  }

  // 没有任何编辑器时的兜底：系统默认程序也能打开文件
  if (process.platform === 'darwin' && !apps.some((item) => item.kind === 'editor')) {
    apps.push({ id: 'system-default', label: '系统默认程序', kind: 'editor', order: 500 });
  }

  return apps.sort((a, b) => a.order - b.order).map(({ order: _order, ...rest }) => rest);
}

export function defaultOpenApp(apps) {
  const has = (id) => apps.some((item) => item.id === id);
  if (has(DEFAULT_OPEN_APP)) return DEFAULT_OPEN_APP;
  const editor = apps.find((item) => item.kind === 'editor');
  if (editor) return editor.id;
  return apps[0]?.id ?? '';
}

/**
 * 应用图标：优先从 .app 里的 .icns 用系统自带 sips 转 PNG（快且不依赖 QuickLook），
 * 抽不到再退回 qlmanage。缓存文件名带 app 的 mtime，应用升级后会自动重抽。
 */
export async function appIcon(app, cacheDir) {
  if (!app?.appPath || process.platform !== 'darwin') return '';
  let stamp = 0;
  try {
    stamp = Math.floor(fs.statSync(app.appPath).mtimeMs);
  } catch {
    return '';
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${app.id}-${stamp}.png`);
  if (fs.existsSync(file)) return file;
  const tmpDir = path.join(cacheDir, `.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const icns = findIcns(app.appPath);
    if (icns) {
      try {
        await execFileAsync(
          'sips',
          ['-s', 'format', 'png', '-z', '64', '64', icns, '--out', file],
          { timeout: 8000 },
        );
        if (fs.existsSync(file)) {
          pruneOldIcons(cacheDir, app.id, file);
          return file;
        }
      } catch {
        // icns 转不出来就继续试 qlmanage
      }
    }
    await execFileAsync('qlmanage', ['-t', '-s', '64', '-o', tmpDir, app.appPath], {
      timeout: 5000,
    });
    const produced = fs.readdirSync(tmpDir).find((name) => name.toLowerCase().endsWith('.png'));
    if (!produced) return '';
    fs.renameSync(path.join(tmpDir, produced), file);
    pruneOldIcons(cacheDir, app.id, file);
    return file;
  } catch {
    return '';
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** .app/Contents/Resources 里挑一个 .icns：优先与 app 同名的（VS Code 就是 Code.icns） */
function findIcns(appPath) {
  const resources = path.join(appPath, 'Contents', 'Resources');
  let names = [];
  try {
    names = fs.readdirSync(resources).filter((name) => name.toLowerCase().endsWith('.icns'));
  } catch {
    return '';
  }
  if (!names.length) return '';
  const stem = path
    .basename(appPath, '.app')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  const preferred =
    names.find((name) =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .startsWith(stem),
    ) ??
    names.find((name) => /^app\.icns$/i.test(name)) ??
    names[0];
  return path.join(resources, preferred);
}

/** 只留当前这一版图标，避免每次升级攒一堆 */
function pruneOldIcons(cacheDir, appId, keep) {
  try {
    for (const name of fs.readdirSync(cacheDir)) {
      if (
        name.startsWith(`${appId}-`) &&
        name.endsWith('.png') &&
        path.join(cacheDir, name) !== keep
      ) {
        fs.rmSync(path.join(cacheDir, name), { force: true });
      }
    }
  } catch {
    // 清理失败不影响使用
  }
}

/**
 * 用指定应用打开文件或目录。
 * - editor：有 CLI 用 `<cli> -g file:line`（能定位到行），否则 `open -a App file`
 * - finder：`open -R file`（选中文件）/ `open dir`
 * - terminal：`open -a App dir`（在目录里开终端）
 * 全部走 argv，不做字符串拼接。
 */
export async function openWith({ abs, dir, app, line }) {
  const target = abs || dir;
  if (!target) throw new Error('没有可打开的路径');
  const appPath = app?.appPath ?? '';
  const cli = app?.cli ?? '';
  const kind = app?.kind ?? 'system';

  if (kind === 'finder') {
    if (process.platform === 'darwin') {
      const exists = fs.existsSync(target);
      await execFileAsync('open', exists && abs ? ['-R', abs] : [dir || target], {
        timeout: 10000,
      });
      return;
    }
    await openWithSystem(target);
    return;
  }

  if (kind === 'terminal') {
    const where = dir || (abs ? path.dirname(abs) : '');
    if (!where) throw new Error('没有可打开的目录');
    if (process.platform === 'darwin' && appPath) {
      await execFileAsync('open', ['-a', appPath, where], { timeout: 10000 });
      return;
    }
    await openWithSystem(where);
    return;
  }

  // editor：CLI 优先（能带行号），否则交给 open -a
  if (cli) {
    const arg = abs && line ? `${abs}:${line}` : abs || dir;
    await execFileAsync(cli, ['-g', arg], { timeout: 10000 });
    return;
  }
  if (process.platform === 'darwin' && appPath) {
    await execFileAsync('open', ['-a', appPath, abs || dir], { timeout: 10000 });
    return;
  }
  await openWithSystem(abs || dir);
}

async function openWithSystem(target) {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [target], { timeout: 10000 });
    return;
  }
  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', target], { windowsHide: true, timeout: 10000 });
    return;
  }
  await execFileAsync('xdg-open', [target], { timeout: 10000 });
}
