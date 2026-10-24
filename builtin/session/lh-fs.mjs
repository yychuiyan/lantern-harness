/**
 * 本地文件 Runner（仅 `astro dev`）：
 * - 工作区根可配置（默认 = 项目根），存 `.local/workspace.json`
 * - readonly / readwrite：相对「当前工作区」
 * - full：另允许本机绝对路径
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  FS_GLOB_MAX,
  FS_GREP_MAX,
  FS_MAX_READ_BYTES,
  FS_MAX_WRITE_BYTES,
  FS_SKIP_DIRS,
  getFsObservationPolicy,
} from './fs-observation-policy.mjs';
import { convertOfficeToPdf, probeOfficeToPdf } from './office-to-pdf.mjs';
import { listWorkspaceSkills, loadWorkspaceSkill } from './skill-fs.mjs';
import { getDataRoot } from './space-context.mjs';
import { LOCAL_REL, resolveContentRoot } from './space-layout.mjs';
import { loadWorkspaceDependencies } from './workspace-deps.mjs';

const execFileAsync = promisify(execFile);

/** 系统原生选文件夹（对齐 dsh directoryPicker.pick / Electron showOpenDialog） */
export async function nativePickDirectory() {
  const result = await pickDirectoryResult();
  return result.path ?? null;
}

/**
 * 带原因的选目录：`{ path }` 选中、`{ canceled: true }` 用户取消、`{ error }` 弹不出来。
 * 区分这三种情况，前端才能提示「系统选目录不可用，请手动填路径」而不是静默无反应。
 */
export async function pickDirectoryResult(prompt = '选择工作区文件夹') {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'osascript',
        [
          '-e',
          `try\nPOSIX path of (choose folder with prompt "${prompt}")\non error number -128\nreturn ""\nend try`,
        ],
        { timeout: 180_000, maxBuffer: 1024 * 1024 },
      );
      const p = String(stdout || '')
        .trim()
        .replace(/\/$/, '');
      return p ? { path: p } : { canceled: true };
    } catch (err) {
      return {
        error: `无法打开系统选目录窗口：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (process.platform === 'linux') {
    let lastError = '';
    for (const cmd of [
      ['zenity', ['--file-selection', '--directory', `--title=${prompt}`]],
      ['kdialog', ['--getexistingdirectory', os.homedir()]],
    ]) {
      try {
        const { stdout } = await execFileAsync(cmd[0], cmd[1], {
          timeout: 180_000,
          maxBuffer: 1024 * 1024,
        });
        const p = String(stdout || '').trim();
        if (p) return { path: p };
        return { canceled: true };
      } catch (err) {
        const code = err && typeof err === 'object' ? err.code : '';
        // 用户取消（zenity 退出码 1）与工具不存在要区别对待
        if (code === 1) return { canceled: true };
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return { error: `没有可用的系统选目录工具（zenity / kdialog）：${lastError}` };
  }
  if (process.platform === 'win32') {
    try {
      const script =
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
        `$d.Description = '${prompt}'; ` +
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }";
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
      });
      const p = String(stdout || '').trim();
      return p ? { path: p } : { canceled: true };
    } catch (err) {
      return {
        error: `无法打开系统选目录窗口：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { error: `当前系统（${process.platform}）不支持原生选目录，请手动填写路径` };
}

const PREFIX = '/__tb_fs';
const MAX_READ = FS_MAX_READ_BYTES;
const MAX_WRITE = FS_MAX_WRITE_BYTES;
const MAX_LIST = 500;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeAccess(raw) {
  const v = String(raw ?? 'readonly');
  if (v === 'readwrite' || v === 'full') return v;
  return 'readonly';
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function workspaceFile(projectRoot) {
  return path.join(projectRoot, LOCAL_REL, 'workspaces.json');
}

function legacyWorkspaceFile(projectRoot) {
  return path.join(projectRoot, LOCAL_REL, 'workspace.json');
}

function folderName(abs) {
  const parts = abs.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || abs;
}

function newWorkspaceId() {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 空间的上级目录（仓库根、空间池）不能当工作区：升级前曾把仓库加成「ai-testbench」 */
function isAncestorPath(maybeAncestor, dir) {
  const a = path.resolve(maybeAncestor);
  const d = path.resolve(dir);
  return d !== a && d.startsWith(a + path.sep);
}

/**
 * 本机装的是哪份 harness（仓库根 / 安装包根）。
 *
 * 插件开发要改的就是这里的源码，但它通常是空间目录的上级，被 `isAncestorPath` 一刀切禁掉，
 * 导致「工作区内修改」根本写不到 `src/`、`lh-plugins/`。这里单独放行包根，其它上级目录仍禁止。
 */
const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function isHarnessRoot(abs) {
  const a = path.resolve(String(abs ?? ''));
  if (a !== HARNESS_ROOT) return false;
  // 只认真正的包根：缺 package.json 时（裁剪过的安装目录）不当工作区
  return fs.existsSync(path.join(a, 'package.json'));
}

function ensureWorkspaceRegistry(projectRoot) {
  const rootAbs = path.resolve(projectRoot);
  const fp = workspaceFile(projectRoot);
  let items = [];
  let active = rootAbs;
  /** 活动目录临时借用 harness 包根（插件开发）：不进 items，侧栏也就不会多出一条工作区 */
  let activeHarness = false;

  try {
    if (fs.existsSync(fp)) {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (Array.isArray(raw.items)) {
        items = raw.items
          .map((it) => ({
            id: String(it.id || ''),
            path: path.resolve(String(it.path || '')),
            name: String(it.name || folderName(String(it.path || ''))),
            addedAt: Number(it.addedAt) || Date.now(),
          }))
          .filter(
            (it) =>
              it.id && it.path && fs.existsSync(it.path) && fs.statSync(it.path).isDirectory(),
          );
      }
      if (raw.activeHarness === true) activeHarness = true;
      if (raw.active) active = path.resolve(String(raw.active));
    } else if (fs.existsSync(legacyWorkspaceFile(projectRoot))) {
      const legacy = JSON.parse(fs.readFileSync(legacyWorkspaceFile(projectRoot), 'utf8'));
      const p = String(legacy.path || '').trim();
      if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        active = path.resolve(p);
        items = [
          {
            id: `ws_${Date.now().toString(36)}`,
            path: active,
            name: folderName(active),
            addedAt: Date.now(),
          },
        ];
      }
    }
  } catch {
    // ignore
  }

  let dirty = false;
  // 包根只在插件开发期间临时当工作区，永远不写进列表：
  // 以前 select 一次仓库根，侧栏就多出一条「ai-testbench」工作区
  const withoutHarness = items.filter((it) => !isHarnessRoot(it.path));
  if (withoutHarness.length !== items.length) {
    items = withoutHarness;
    dirty = true;
  }
  // 其它上级目录（空间池、仓库上一级）继续剔除
  const kept = items.filter((it) => it.path === rootAbs || !isAncestorPath(it.path, rootAbs));
  if (kept.length !== items.length) {
    items = kept;
    dirty = true;
  }
  // 空间根必须是唯一的 ws_project；升级前仓库路径也曾用这个 id，会在侧栏出现两个「默认工作区」
  for (const it of items) {
    if (it.path === rootAbs) {
      if (it.id !== 'ws_project') {
        it.id = 'ws_project';
        dirty = true;
      }
    } else if (it.id === 'ws_project') {
      it.id = newWorkspaceId();
      dirty = true;
    }
  }
  if (!items.some((it) => it.path === rootAbs)) {
    items.unshift({
      id: 'ws_project',
      path: rootAbs,
      name: folderName(rootAbs),
      addedAt: 0,
    });
    dirty = true;
  }
  if (activeHarness && !isHarnessRoot(HARNESS_ROOT)) {
    // 包根不可用（安装目录被裁剪）时退回空间目录，别把 active 指到一个不存在的路径
    activeHarness = false;
    dirty = true;
  }
  if (activeHarness) {
    active = HARNESS_ROOT;
  } else if (!items.some((it) => it.path === active)) {
    active = rootAbs;
    dirty = true;
  }
  const reg = { active, items, projectRoot: rootAbs, activeHarness };
  if (dirty && fs.existsSync(fp)) saveWorkspaceRegistry(projectRoot, reg);
  return reg;
}

function saveWorkspaceRegistry(projectRoot, reg) {
  const fp = workspaceFile(projectRoot);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    JSON.stringify(
      {
        active: reg.active,
        // 只有「临时借用包根」时才为 true；写在清单里，重启后仍能还原
        activeHarness: reg.activeHarness === true,
        items: reg.items,
        updatedAt: Date.now(),
      },
      null,
      2,
    ),
    'utf8',
  );
}

function readWorkspace(projectRoot) {
  return ensureWorkspaceRegistry(projectRoot).active;
}

function isSystemSensitive(abs) {
  const n = abs.replace(/\\/g, '/').toLowerCase();
  const home = os.homedir().replace(/\\/g, '/').toLowerCase();
  const prefixes = [
    '/system',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/private/etc',
    '/library/extensions',
    '/dev',
    '/proc',
    '/windows',
    '/program files',
  ];
  if (prefixes.some((p) => n === p || n.startsWith(`${p}/`))) return true;
  if (n.startsWith(`${home}/`) || n === home) return false;
  return false;
}

/**
 * 内容目录若被拖进导航分组（如「工作管理/工作汇报」），相对路径仍写「工作汇报/…」时，
 * 转到分组内的真实目录，避免在空间根再铺一份空壳导致列表读不到。
 * @returns {{ abs: string, display: string } | null}
 */
function remapGroupedContentPath(workspaceRoot, cleanedRel) {
  const parts = String(cleanedRel || '')
    .split('/')
    .filter(Boolean);
  if (!parts.length) return null;
  const leaf = parts[0];
  if (leaf.startsWith('.')) return null;
  let resolved;
  try {
    resolved = resolveContentRoot(workspaceRoot, leaf);
  } catch {
    return null;
  }
  const plain = path.join(path.resolve(workspaceRoot), leaf);
  if (!resolved?.abs || path.resolve(resolved.abs) === path.resolve(plain)) return null;
  // 分组内已有该目录，或 resolve 明确标了 grouped
  let exists = false;
  try {
    exists = fs.statSync(resolved.abs).isDirectory();
  } catch {
    exists = false;
  }
  if (!resolved.grouped && !exists) return null;
  const abs = parts.length > 1 ? path.join(resolved.abs, ...parts.slice(1)) : resolved.abs;
  const display = path.relative(path.resolve(workspaceRoot), abs).split(path.sep).join('/') || '.';
  return { abs, display };
}

/**
 * @returns {{ abs: string, display: string, inWorkspace: boolean }}
 */
function resolvePath(workspaceRoot, input, access) {
  let raw = String(input ?? '').trim() || '.';
  if (raw.includes('\0')) throw new Error('invalid path');
  raw = expandHome(raw);
  const ws = path.resolve(workspaceRoot);

  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    if (isSystemSensitive(abs)) throw new Error('禁止访问系统敏感目录');
    // 绝对路径落在工作区内：任何档位都可（按工作区相对展示）
    if (abs === ws || abs.startsWith(ws + path.sep)) {
      const display = path.relative(ws, abs).split(path.sep).join('/') || '.';
      return { abs, display, inWorkspace: true };
    }
    if (access !== 'full') {
      throw new Error('该路径不在当前工作区内。请先设置工作区，或切换到「完全权限」使用绝对路径。');
    }
    return { abs, display: abs, inWorkspace: false };
  }

  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const remapped = remapGroupedContentPath(ws, cleaned);
  if (remapped) {
    if (remapped.abs !== ws && !remapped.abs.startsWith(ws + path.sep)) {
      throw new Error('路径超出当前工作区');
    }
    return { abs: remapped.abs, display: remapped.display, inWorkspace: true };
  }
  const abs = path.resolve(ws, cleaned);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    throw new Error('路径超出当前工作区');
  }
  const display = path.relative(ws, abs).split(path.sep).join('/') || '.';
  return { abs, display, inWorkspace: true };
}

function isBlockedWrite(display, access, inWorkspace) {
  const p = display.replace(/\\/g, '/').toLowerCase();
  if (p === '.git' || p.includes('/.git/') || p.endsWith('/.git')) return true;
  if (access === 'full') return false;
  if (!inWorkspace) return true;
  if (p === 'node_modules' || p.startsWith('node_modules/')) return true;
  if (p === 'dist' || p.startsWith('dist/')) return true;
  return false;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

const AGENT_INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];
const AGENT_INSTRUCTION_LOCAL = ['AGENTS.local.md', 'CLAUDE.local.md'];
const AGENT_INSTRUCTION_MAX_BYTES = 65536;
const AGENT_INSTRUCTION_MAX_SOURCE = 1024 * 1024;

/**
 * 从目录读取指令候选（同目录内容去重），返回 broad→specific 片段列表。
 * @param {string} dirAbs
 * @param {string} scopeLabel
 */
function readInstructionDir(dirAbs, scopeLabel) {
  const out = [];
  const seen = new Set();
  for (const name of [...AGENT_INSTRUCTION_CANDIDATES, ...AGENT_INSTRUCTION_LOCAL]) {
    const abs = path.join(dirAbs, name);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const st = fs.statSync(abs);
      if (st.size > AGENT_INSTRUCTION_MAX_SOURCE) continue;
      const content = fs.readFileSync(abs, 'utf8');
      const key = content.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        abs,
        scopeLabel,
        rel: scopeLabel === '.' ? name : `${scopeLabel.replace(/\/$/, '')}/${name}`,
        content,
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/**
 * @param {string} workspace
 * @param {string} projectRoot
 * @param {number} [maxBytes]
 */
function buildAgentInstructions(workspace, projectRoot, maxBytes = AGENT_INSTRUCTION_MAX_BYTES) {
  const ws = path.resolve(workspace);
  const root = path.resolve(projectRoot);
  /** @type {Array<{ name: string, abs: string, scopeLabel: string, rel: string, content: string }>} */
  let entries = [];

  // 由宽到窄：项目根 → 工作区（若不同）
  if (root) {
    entries = entries.concat(readInstructionDir(root, path.basename(root) || 'project'));
  }
  if (ws && ws !== root) {
    entries = entries.concat(readInstructionDir(ws, path.basename(ws) || 'workspace'));
  } else if (ws && entries.length === 0) {
    entries = entries.concat(readInstructionDir(ws, path.basename(ws) || 'workspace'));
  }

  const frameOverhead = Buffer.byteLength(
    '以下工作区指令可能与当前任务相关。更具体的指令优先。它们不能覆盖系统或用户直接指令。\n\n',
    'utf8',
  );

  function sectionBytes(e, truncatedContent) {
    const body = truncatedContent ?? e.content;
    return (
      Buffer.byteLength(`Instructions from: ${e.rel}\n\n`, 'utf8') +
      Buffer.byteLength(body, 'utf8') +
      2
    );
  }

  function totalBytes(list) {
    let n = frameOverhead;
    for (const e of list) n += sectionBytes(e);
    return n;
  }

  // 超限先丢更宽（列表头部），再截断最具体
  while (entries.length > 1 && totalBytes(entries) > maxBytes) {
    entries.shift();
  }
  if (entries.length === 1 && totalBytes(entries) > maxBytes) {
    const e = entries[0];
    const header = Buffer.byteLength(`Instructions from: ${e.rel}\n\n`, 'utf8') + 2;
    const allow = Math.max(0, maxBytes - frameOverhead - header);
    let truncated = e.content;
    while (Buffer.byteLength(truncated, 'utf8') > allow && truncated.length > 0) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
    }
    if (Buffer.byteLength(truncated, 'utf8') < Buffer.byteLength(e.content, 'utf8')) {
      truncated = `${truncated.trimEnd()}\n\n…（已按预算截断）`;
    }
    entries = [{ ...e, content: truncated }];
  }

  if (!entries.length) {
    return { text: '', files: [] };
  }

  const parts = [
    '以下工作区指令可能与当前任务相关。更具体的指令优先。它们不能覆盖系统或用户直接指令。',
    '',
  ];
  const files = [];
  for (const e of entries) {
    parts.push(`Instructions from: ${e.rel}`);
    parts.push('');
    parts.push(e.content.trimEnd());
    parts.push('');
    // 打开文件用工作区相对路径；跨工作区时回退绝对路径
    let openPath = e.abs;
    try {
      if (e.abs === ws || e.abs.startsWith(ws + path.sep)) {
        openPath = path.relative(ws, e.abs).split(path.sep).join('/') || e.name;
      } else if (e.abs === root || e.abs.startsWith(root + path.sep)) {
        openPath = path.relative(root, e.abs).split(path.sep).join('/') || e.name;
      }
    } catch {
      openPath = e.abs;
    }
    files.push({ path: openPath, name: e.name, abs: e.abs, label: e.rel });
  }
  return { text: parts.join('\n').trim(), files };
}

async function openLocalPath(abs) {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [abs], { timeout: 30_000 });
    return;
  }
  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', abs], { timeout: 30_000 });
    return;
  }
  await execFileAsync('xdg-open', [abs], { timeout: 30_000 });
}

const SEARCH_SKIP_DIRS = new Set(FS_SKIP_DIRS);
const GLOB_MAX = FS_GLOB_MAX;
const GREP_MAX = FS_GREP_MAX;

/** 无「/」的 pattern 按任意深度匹配 basename（对齐 dsh glob） */
function normalizeGlobPattern(pattern) {
  const p = String(pattern ?? '').trim();
  if (!p) throw new Error('pattern is required');
  if (!p.includes('/') && !p.includes('\\')) return `**/${p}`;
  return p.replace(/\\/g, '/');
}

/** 极简 glob → RegExp（支持 *, ?, **） */
function globToRegExp(glob) {
  let s = String(glob).replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' && s[i + 1] === '*') {
      if (s[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if ('+.^$()[]{}|'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out, 'i');
}

function toWorkspaceRel(workspaceRoot, abs) {
  const ws = path.resolve(workspaceRoot);
  const a = path.resolve(abs);
  if (a === ws) return '.';
  if (a.startsWith(ws + path.sep)) {
    return path.relative(ws, a).split(path.sep).join('/');
  }
  return a;
}

/**
 * @returns {Promise<{ paths: string[], truncated: boolean, total: number, engine: string }>}
 */
async function runFsGlob(workspaceRoot, searchRootAbs, pattern) {
  const norm = normalizeGlobPattern(pattern);
  const re = globToRegExp(norm);
  const hits = [];

  // 优先 ripgrep --files
  try {
    const args = ['--files', '--hidden', '--glob', '!**/node_modules/**', '--glob', '!**/.git/**'];
    // rg -g 用原始用户 pattern；无斜杠时 rg 会按任意深度 basename 匹配
    args.push('--glob', String(pattern).trim());
    const { stdout } = await execFileAsync('rg', args, {
      cwd: searchRootAbs,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const withMtime = [];
    for (const rel of lines) {
      const abs = path.resolve(searchRootAbs, rel);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        withMtime.push({ abs, mtime: st.mtimeMs });
      } catch {
        // skip
      }
    }
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const total = withMtime.length;
    for (const it of withMtime.slice(0, GLOB_MAX)) {
      hits.push(toWorkspaceRel(workspaceRoot, it.abs));
    }
    return { paths: hits, truncated: total > GLOB_MAX, total, engine: 'rg' };
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 1) {
      return { paths: [], truncated: false, total: 0, engine: 'rg' };
    }
    // fallback walk
  }

  const stack = [searchRootAbs];
  const withMtime = [];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SEARCH_SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const relFromSearch = path.relative(searchRootAbs, abs).split(path.sep).join('/');
      const relFromWs = toWorkspaceRel(workspaceRoot, abs);
      if (re.test(relFromSearch) || re.test(relFromWs) || re.test(name)) {
        withMtime.push({ abs, mtime: st.mtimeMs });
      }
    }
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const total = withMtime.length;
  for (const it of withMtime.slice(0, GLOB_MAX)) {
    hits.push(toWorkspaceRel(workspaceRoot, it.abs));
  }
  return { paths: hits, truncated: total > GLOB_MAX, total, engine: 'node' };
}

/**
 * @returns {Promise<{ matches: Array<{ path: string, line: number, text: string }>, truncated: boolean, total: number, engine: string }>}
 */
async function runFsGrep(workspaceRoot, searchRootAbs, pattern, include) {
  const pat = String(pattern ?? '');
  if (!pat) throw new Error('pattern is required');
  const matches = [];

  try {
    const args = [
      '-n',
      '--no-heading',
      '--hidden',
      '--glob',
      '!**/node_modules/**',
      '--glob',
      '!**/.git/**',
    ];
    if (include && String(include).trim()) {
      args.push('--glob', String(include).trim());
    }
    args.push('--', pat, '.');
    const { stdout } = await execFileAsync('rg', args, {
      cwd: searchRootAbs,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 45_000,
    });
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .filter(Boolean);
    let total = 0;
    for (const line of lines) {
      // path:line:text
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      total += 1;
      if (matches.length >= GREP_MAX) continue;
      const abs = path.resolve(searchRootAbs, m[1]);
      matches.push({
        path: toWorkspaceRel(workspaceRoot, abs),
        line: Number(m[2]),
        text: m[3],
      });
    }
    return {
      matches,
      truncated: total > GREP_MAX,
      total,
      engine: 'rg',
    };
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 1) {
      return { matches: [], truncated: false, total: 0, engine: 'rg' };
    }
    // fallback
  }

  let re;
  try {
    re = new RegExp(pat, 'm');
  } catch {
    throw new Error(`invalid regex: ${pat}`);
  }
  const includeRe =
    include && String(include).trim() ? globToRegExp(normalizeGlobPattern(include)) : null;
  const stack = [searchRootAbs];
  let total = 0;
  const searchIsFile = fs.existsSync(searchRootAbs) && fs.statSync(searchRootAbs).isFile();
  if (searchIsFile) {
    collectGrepFile(searchRootAbs);
  } else {
    while (stack.length) {
      const dir = stack.pop();
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (SEARCH_SKIP_DIRS.has(name)) continue;
        const abs = path.join(dir, name);
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(abs);
          continue;
        }
        if (!st.isFile()) continue;
        if (st.size > MAX_READ) continue;
        const base = name;
        const rel = path.relative(searchRootAbs, abs).split(path.sep).join('/');
        if (includeRe && !includeRe.test(rel) && !includeRe.test(base)) continue;
        collectGrepFile(abs);
      }
    }
  }

  function collectGrepFile(abs) {
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      return;
    }
    if (looksBinary(buf)) return;
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    const rel = toWorkspaceRel(workspaceRoot, abs);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total += 1;
      if (matches.length < GREP_MAX) {
        matches.push({ path: rel, line: i + 1, text: lines[i] });
      }
    }
  }

  return { matches, truncated: total > GREP_MAX, total, engine: 'node' };
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhFsPlugin() {
  return {
    name: 'lh-fs',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(PREFIX)) return next();
        // 数据根惰性读取：切换数据空间后无需重启即可生效
        const projectRoot = getDataRoot();

        try {
          const workspace = readWorkspace(projectRoot);

          if (url === `${PREFIX}/health` && req.method === 'GET') {
            const obs = getFsObservationPolicy();
            return sendJson(res, 200, {
              ok: true,
              mode: 'workspace',
              projectRoot,
              harnessRoot: isHarnessRoot(HARNESS_ROOT) ? HARNESS_ROOT : '',
              workspace,
              home: os.homedir(),
              maxReadBytes: MAX_READ,
              maxWriteBytes: MAX_WRITE,
              observation: obs,
            });
          }

          if (url === `${PREFIX}/workspace-dependencies` && req.method === 'GET') {
            const tools = await loadWorkspaceDependencies();
            return sendJson(res, 200, {
              ok: true,
              count: tools.length,
              tools,
              platform: process.platform,
            });
          }

          if (url === `${PREFIX}/office-to-pdf` && req.method === 'GET') {
            const probe = await probeOfficeToPdf();
            return sendJson(res, 200, { ok: true, ...probe });
          }

          if (url === `${PREFIX}/agent-instructions` && req.method === 'GET') {
            const packed = buildAgentInstructions(workspace, projectRoot);
            return sendJson(res, 200, {
              ok: true,
              text: packed.text,
              files: packed.files.map((f) => ({
                path: f.path,
                name: f.name,
                abs: f.abs,
                label: f.label,
              })),
              workspace,
              projectRoot,
              maxBytes: AGENT_INSTRUCTION_MAX_BYTES,
            });
          }

          if (url === `${PREFIX}/skills` && req.method === 'GET') {
            const skills = listWorkspaceSkills(workspace, projectRoot);
            return sendJson(res, 200, { ok: true, count: skills.length, skills });
          }

          if (url === `${PREFIX}/workspace` && req.method === 'GET') {
            const reg = ensureWorkspaceRegistry(projectRoot);
            return sendJson(res, 200, {
              workspace: reg.active,
              projectRoot: reg.projectRoot,
              harnessRoot: isHarnessRoot(HARNESS_ROOT) ? HARNESS_ROOT : '',
              activeHarness: reg.activeHarness === true,
              isProject: reg.active === reg.projectRoot,
              items: reg.items,
            });
          }

          if (url === `${PREFIX}/pick-directory` && req.method === 'POST') {
            const picked = await nativePickDirectory();
            if (!picked) {
              return sendJson(res, 200, { ok: true, canceled: true, path: null });
            }
            const abs = path.resolve(picked);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
              return sendJson(res, 400, { error: '所选路径不是文件夹', path: abs });
            }
            if (isSystemSensitive(abs)) {
              return sendJson(res, 403, { error: '禁止将该目录设为工作区' });
            }
            return sendJson(res, 200, { ok: true, canceled: false, path: abs });
          }

          const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
          const access = normalizeAccess(body.access);

          if (url === `${PREFIX}/workspace` && req.method === 'POST') {
            const reg = ensureWorkspaceRegistry(projectRoot);
            const action = String(body.action || 'select');

            if (action === 'add' || action === 'select') {
              let raw = String(body.path ?? '').trim();
              if (!raw && action === 'select') {
                reg.active = reg.projectRoot;
                reg.activeHarness = false;
                saveWorkspaceRegistry(projectRoot, reg);
                return sendJson(res, 200, {
                  ok: true,
                  workspace: reg.active,
                  projectRoot: reg.projectRoot,
                  harnessRoot: isHarnessRoot(HARNESS_ROOT) ? HARNESS_ROOT : '',
                  activeHarness: false,
                  isProject: true,
                  items: reg.items,
                });
              }
              raw = expandHome(raw);
              const abs = path.resolve(raw);
              if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
                return sendJson(res, 400, { error: '目录不存在或不是文件夹', path: abs });
              }
              if (isSystemSensitive(abs)) {
                return sendJson(res, 403, { error: '禁止将该目录设为工作区' });
              }
              if (isAncestorPath(abs, projectRoot) && !isHarnessRoot(abs)) {
                return sendJson(res, 400, { error: '不能把当前空间的上级目录设为工作区' });
              }
              let item = reg.items.find((it) => it.path === abs);
              if (isHarnessRoot(abs)) {
                // 插件开发：只临时占用包根当工作区，不往侧栏列表里加条目
                reg.active = abs;
                reg.activeHarness = true;
                saveWorkspaceRegistry(projectRoot, reg);
                return sendJson(res, 200, {
                  ok: true,
                  workspace: reg.active,
                  projectRoot: reg.projectRoot,
                  harnessRoot: HARNESS_ROOT,
                  activeHarness: true,
                  isProject: false,
                  items: reg.items,
                });
              }
              if (!item) {
                item = {
                  id: newWorkspaceId(),
                  path: abs,
                  name: folderName(abs),
                  addedAt: Date.now(),
                };
                reg.items.push(item);
              }
              if (action === 'select' || action === 'add') reg.active = abs;
              reg.activeHarness = false;
              saveWorkspaceRegistry(projectRoot, reg);
              return sendJson(res, 200, {
                ok: true,
                workspace: reg.active,
                projectRoot: reg.projectRoot,
                harnessRoot: isHarnessRoot(HARNESS_ROOT) ? HARNESS_ROOT : '',
                activeHarness: false,
                isProject: reg.active === reg.projectRoot,
                items: reg.items,
              });
            }

            if (action === 'remove') {
              const id = String(body.id || '');
              const target = reg.items.find((it) => it.id === id || it.path === body.path);
              if (!target) return sendJson(res, 404, { error: '工作区不存在' });
              if (target.path === reg.projectRoot) {
                return sendJson(res, 400, { error: '不能移除项目根工作区' });
              }
              reg.items = reg.items.filter((it) => it.id !== target.id);
              if (reg.active === target.path) {
                reg.active = reg.projectRoot;
                reg.activeHarness = false;
              }
              saveWorkspaceRegistry(projectRoot, reg);
              return sendJson(res, 200, {
                ok: true,
                workspace: reg.active,
                projectRoot: reg.projectRoot,
                harnessRoot: isHarnessRoot(HARNESS_ROOT) ? HARNESS_ROOT : '',
                activeHarness: reg.activeHarness === true,
                isProject: reg.active === reg.projectRoot,
                items: reg.items,
              });
            }

            if (action === 'rename') {
              const id = String(body.id || '');
              const name = String(body.name || '').trim();
              if (!name) return sendJson(res, 400, { error: '名称不能为空' });
              const target = reg.items.find((it) => it.id === id || it.path === body.path);
              if (!target) return sendJson(res, 404, { error: '工作区不存在' });
              target.name = name.slice(0, 80);
              saveWorkspaceRegistry(projectRoot, reg);
              return sendJson(res, 200, {
                ok: true,
                workspace: reg.active,
                projectRoot: reg.projectRoot,
                harnessRoot: isHarnessRoot(HARNESS_ROOT) ? HARNESS_ROOT : '',
                activeHarness: reg.activeHarness === true,
                isProject: reg.active === reg.projectRoot,
                items: reg.items,
              });
            }

            return sendJson(res, 400, { error: 'unknown action' });
          }

          if (url === `${PREFIX}/list` && req.method === 'POST') {
            const { abs, display } = resolvePath(workspace, body.path || '.', access);
            if (!fs.existsSync(abs))
              return sendJson(res, 404, { error: 'not found', path: display });
            const st = fs.statSync(abs);
            if (!st.isDirectory()) {
              return sendJson(res, 400, { error: 'not a directory', path: display });
            }
            const names = fs.readdirSync(abs);
            const entries = [];
            for (const name of names.slice(0, MAX_LIST)) {
              try {
                const child = path.join(abs, name);
                const cst = fs.statSync(child);
                const childDisplay =
                  display === '.' ? name : `${display.replace(/\/$/, '')}/${name}`;
                entries.push({
                  name,
                  type: cst.isDirectory() ? 'dir' : 'file',
                  path: childDisplay,
                  size: cst.isFile() ? cst.size : undefined,
                });
              } catch {
                // skip
              }
            }
            entries.sort((a, b) => {
              if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
              return a.name.localeCompare(b.name, 'zh');
            });
            return sendJson(res, 200, {
              path: display,
              workspace,
              entries,
              truncated: names.length > MAX_LIST,
              total: names.length,
            });
          }

          if (url === `${PREFIX}/read` && req.method === 'POST') {
            const { abs, display } = resolvePath(workspace, body.path, access);
            if (!fs.existsSync(abs))
              return sendJson(res, 404, { error: 'not found', path: display });
            const st = fs.statSync(abs);
            if (!st.isFile()) return sendJson(res, 400, { error: 'not a file', path: display });
            if (st.size > MAX_READ) {
              return sendJson(res, 413, {
                error: `文件过大（>${MAX_READ} bytes）`,
                path: display,
                size: st.size,
              });
            }
            const buf = fs.readFileSync(abs);
            if (looksBinary(buf)) {
              return sendJson(res, 200, {
                path: display,
                size: st.size,
                encoding: 'binary',
                note: '二进制文件未返回正文；可用「+ → 文件」上传解析',
              });
            }
            return sendJson(res, 200, {
              path: display,
              size: st.size,
              encoding: 'utf-8',
              content: buf.toString('utf8'),
            });
          }

          if (url === `${PREFIX}/write` && req.method === 'POST') {
            if (access === 'readonly') {
              return sendJson(res, 403, { error: '当前为「仅可查看」，禁止写入。' });
            }
            const { abs, display, inWorkspace } = resolvePath(workspace, body.path, access);
            if (isBlockedWrite(display, access, inWorkspace)) {
              return sendJson(res, 403, { error: `权限「${access}」禁止写入：${display}` });
            }
            const content = String(body.content ?? '');
            const bytes = Buffer.byteLength(content, 'utf8');
            if (bytes > MAX_WRITE) {
              return sendJson(res, 413, { error: `写入内容过大（>${MAX_WRITE} bytes）` });
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, 'utf8');
            return sendJson(res, 200, { ok: true, path: display, size: bytes });
          }

          if (url === `${PREFIX}/mkdir` && req.method === 'POST') {
            if (access === 'readonly') {
              return sendJson(res, 403, { error: '当前为「仅可查看」，禁止创建目录。' });
            }
            const { abs, display, inWorkspace } = resolvePath(workspace, body.path, access);
            if (isBlockedWrite(display, access, inWorkspace)) {
              return sendJson(res, 403, { error: `权限禁止创建：${display}` });
            }
            fs.mkdirSync(abs, { recursive: true });
            return sendJson(res, 200, { ok: true, path: display });
          }

          if (url === `${PREFIX}/agent-instructions` && req.method === 'POST') {
            const maxBytes = Number(body.maxBytes);
            const packed = buildAgentInstructions(
              workspace,
              projectRoot,
              Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : AGENT_INSTRUCTION_MAX_BYTES,
            );
            return sendJson(res, 200, {
              ok: true,
              text: packed.text,
              files: packed.files.map((f) => ({ path: f.path, name: f.name })),
              workspace,
              projectRoot,
              maxBytes:
                Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : AGENT_INSTRUCTION_MAX_BYTES,
            });
          }

          if (url === `${PREFIX}/skill-load` && req.method === 'POST') {
            const name = String(body.name ?? body.path ?? body.id ?? '').trim();
            return sendJson(res, 200, loadWorkspaceSkill(workspace, name, projectRoot));
          }

          if (url === `${PREFIX}/office-to-pdf` && req.method === 'POST') {
            if (access === 'readonly') {
              return sendJson(res, 403, { error: '当前为「仅可查看」，禁止转换生成 PDF。' });
            }
            const { abs, display, inWorkspace } = resolvePath(workspace, body.path, access);
            if (isBlockedWrite(display, access, inWorkspace)) {
              return sendJson(res, 403, { error: `权限禁止写入：${display}` });
            }
            let outDirAbs = '';
            if (body.outDir) {
              const out = resolvePath(workspace, body.outDir, access);
              outDirAbs = out.abs;
            } else {
              outDirAbs = path.dirname(abs);
            }
            const result = await convertOfficeToPdf(abs, outDirAbs);
            if (!result.ok) return sendJson(res, 200, result);
            return sendJson(res, 200, {
              ok: true,
              input: display,
              output: toWorkspaceRel(workspace, result.output),
              bytes: result.bytes,
              binary: result.binary,
              fallback: result.fallback === true,
              note: result.note,
            });
          }

          if (url === `${PREFIX}/stat` && req.method === 'POST') {
            const { abs, display } = resolvePath(workspace, body.path, access);
            if (!fs.existsSync(abs)) {
              return sendJson(res, 404, { error: 'not found', path: display });
            }
            const st = fs.statSync(abs);
            if (!st.isFile()) {
              return sendJson(res, 400, { error: 'not a file', path: display });
            }
            return sendJson(res, 200, {
              ok: true,
              path: display,
              name: path.basename(abs),
              size: st.size,
              abs,
            });
          }

          if (url === `${PREFIX}/open` && req.method === 'POST') {
            const ws = path.resolve(workspace);
            const root = path.resolve(projectRoot);
            const raw = String(body.path ?? '').trim();
            const absHint = String(body.abs ?? '').trim();
            /** @type {string[]} */
            const candidates = [];
            const pushCand = (p) => {
              if (!p || typeof p !== 'string') return;
              const a = path.resolve(expandHome(p));
              if (!candidates.includes(a)) candidates.push(a);
            };
            if (absHint) pushCand(absHint);
            if (raw) {
              if (path.isAbsolute(raw) || raw.startsWith('~/') || raw.startsWith('~\\')) {
                pushCand(raw);
              }
              try {
                pushCand(resolvePath(ws, raw, access).abs);
              } catch {
                // ignore
              }
              try {
                pushCand(resolvePath(root, raw, 'full').abs);
              } catch {
                // ignore
              }
              // 兼容误带目录名：ai-testbench/AGENTS.md → AGENTS.md
              const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
              const wsBase = path.basename(ws);
              const rootBase = path.basename(root);
              for (const base of [wsBase, rootBase]) {
                if (base && cleaned.startsWith(`${base}/`)) {
                  const stripped = cleaned.slice(base.length + 1);
                  try {
                    pushCand(resolvePath(ws, stripped, access).abs);
                  } catch {
                    // ignore
                  }
                  try {
                    pushCand(resolvePath(root, stripped, 'full').abs);
                  } catch {
                    // ignore
                  }
                }
              }
              // 仅文件名时在工作区 / 项目根各试一次
              if (!cleaned.includes('/')) {
                pushCand(path.join(ws, cleaned));
                pushCand(path.join(root, cleaned));
              }
            }

            let hit = '';
            for (const abs of candidates) {
              if (!abs || isSystemSensitive(abs)) continue;
              const underWs = abs === ws || abs.startsWith(ws + path.sep);
              const underRoot = abs === root || abs.startsWith(root + path.sep);
              if (!underWs && !underRoot && access !== 'full') continue;
              if (fs.existsSync(abs)) {
                hit = abs;
                break;
              }
            }
            if (!hit) {
              return sendJson(res, 404, {
                error: 'not found',
                path: raw || absHint || '',
              });
            }
            const st = fs.statSync(hit);
            if (!st.isFile() && !st.isDirectory()) {
              return sendJson(res, 400, { error: '无法打开该路径', path: hit });
            }
            await openLocalPath(hit);
            const display =
              hit === ws || hit.startsWith(ws + path.sep)
                ? path.relative(ws, hit).split(path.sep).join('/') || '.'
                : hit;
            return sendJson(res, 200, { ok: true, path: display, abs: hit });
          }

          if (url === `${PREFIX}/glob` && req.method === 'POST') {
            const pattern = String(body.pattern ?? '').trim();
            if (!pattern) return sendJson(res, 400, { error: 'pattern is required' });
            const { abs, display } = resolvePath(workspace, body.path || '.', access);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
              return sendJson(res, 400, {
                error: 'search path must be a directory',
                path: display,
              });
            }
            const result = await runFsGlob(workspace, abs, pattern);
            return sendJson(res, 200, {
              ok: true,
              pattern,
              path: display,
              paths: result.paths,
              truncated: result.truncated,
              total: result.total,
              engine: result.engine,
              max: GLOB_MAX,
            });
          }

          if (url === `${PREFIX}/grep` && req.method === 'POST') {
            const pattern = String(body.pattern ?? '');
            if (!pattern) return sendJson(res, 400, { error: 'pattern is required' });
            const { abs, display } = resolvePath(workspace, body.path || '.', access);
            if (!fs.existsSync(abs)) {
              return sendJson(res, 404, { error: 'not found', path: display });
            }
            const result = await runFsGrep(workspace, abs, pattern, body.include);
            return sendJson(res, 200, {
              ok: true,
              pattern,
              path: display,
              include: body.include ? String(body.include) : undefined,
              matches: result.matches,
              truncated: result.truncated,
              total: result.total,
              engine: result.engine,
              max: GREP_MAX,
            });
          }

          return sendJson(res, 404, { error: 'not found' });
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
