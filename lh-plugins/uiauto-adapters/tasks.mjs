/**
 * 「运行任务」发现。
 *
 * 对齐 Jenkins 的参数化构建：项目里本来就声明好的跑法（`package.json` 的 scripts、
 * `Makefile` 的 target、pytest 的 markers、Maven 的 profiles）直接整理成下拉候选，
 * 而不是替用户猜一条命令。纯函数，方便单测。
 *
 * 每个任务统一成：
 * { id, label, display, base, args, hint, kind, failureFlags, custom }
 * - `base` + `args` 拼出实际命令（走 shell 执行）
 * - `failureFlags` 表示这条任务能不能追加「仅上次失败 / 遇到失败即停」
 */
import fs from 'node:fs';
import path from 'node:path';

import { text } from './shared.mjs';

export const MAX_RUN_TASKS = 20;
export const CUSTOM_TASK_LIMIT = 20;

/** 要跑哪些 script：名字像测试的；排除 lint / format / 打开报告这类 */
const NODE_SCRIPT_ALLOW =
  /^(test|tests|e2e|ui|api|smoke|regression|edge|sanity|spec|allure|report)([:._-].*)?$/i;
const NODE_SCRIPT_DENY =
  /(lint|format|prepare|husky|install|build|serve|start|dev|watch|debug|open|show|clean|postinstall|pretest)/i;
/** 交互式命令挂后台会一直不退出，直接跳过 */
const INTERACTIVE = /(--ui\b|--debug\b|--watch\b|show-report|allure open|--headed\b)/;

/** Makefile 里要的目标 / 明显不是测试的目标 */
const MAKE_ALLOW = /(test|spec|smoke|regress|e2e|sanity|unit|contract|integration|api|ui|p0|p1)/i;
const MAKE_DENY =
  /^(all|help|install|build|clean|lint|format|format-check|type|check|deps|lock|docker|dev|run|serve|export|version|pre-commit)$/i;

const PYTEST_TASK_MARKER = /^[\w.:-]+$/;

export function quoteIfNeeded(value) {
  const raw = String(value ?? '');
  return /\s/.test(raw) ? `"${raw.replace(/"/g, '\\"')}"` : raw;
}

/** 包管理器的 `run`：pnpm / yarn / npm，未知按 npm */
export function packageManagerRunner(packageManager) {
  if (packageManager === 'pnpm') return { command: 'pnpm', args: ['run'] };
  if (packageManager === 'yarn') return { command: 'yarn', args: ['run'] };
  return { command: 'npm', args: ['run'] };
}

/** package.json 里哪些 script 值得放出来 */
export function pickRunScripts(scripts) {
  const entries = scripts && typeof scripts === 'object' ? Object.entries(scripts) : [];
  const picked = [];
  for (const [name, body] of entries) {
    if (!NODE_SCRIPT_ALLOW.test(name)) continue;
    if (NODE_SCRIPT_DENY.test(name)) continue;
    if (typeof body !== 'string') continue;
    if (INTERACTIVE.test(body)) continue;
    picked.push({ name, body });
  }
  // test 永远是第一个，其余按名字排序，避免每次刷新顺序都变
  picked.sort((a, b) => {
    if (a.name === 'test') return -1;
    if (b.name === 'test') return 1;
    return a.name.localeCompare(b.name);
  });
  return picked;
}

export function discoverNodeScripts(probe) {
  const runner = packageManagerRunner(probe.packageManager);
  return pickRunScripts(probe.pkg?.scripts).map(({ name, body }) => {
    const isPlaywright = /playwright/i.test(body);
    const label = `${runner.command} run ${name}`;
    return {
      id: `script:${name}`,
      label,
      display: name,
      base: label,
      // npm / pnpm / yarn 都能把 `--` 之后的参数透传给脚本；
      // Playwright 脚本追加 reporters 才拿得到 JSON 汇总
      args: isPlaywright ? ['--', '--reporter=list,json,html'] : [],
      hint: body.trim().slice(0, 120),
      kind: 'script',
      failureFlags: isPlaywright,
      custom: false,
    };
  });
}

/** 解析 Makefile：`target: ## 说明`，只取像测试的目标 */
export function parseMakeTargets(raw) {
  const text_ = String(raw ?? '');
  const out = [];
  const seen = new Set();
  for (const line of text_.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) continue;
    if (!MAKE_ALLOW.test(name) || MAKE_DENY.test(name)) continue;
    seen.add(name);
    const hint = /##\s*(.+)$/.exec(line)?.[1]?.trim() ?? '';
    out.push({ name, hint });
  }
  return out;
}

export function discoverMakeTargets(probe) {
  const makefile = probe.readRel('Makefile', 64 * 1024) || probe.readRel('makefile', 64 * 1024);
  if (!makefile) return [];
  return parseMakeTargets(makefile).map(({ name, hint }) => ({
    id: `make:${name}`,
    label: `make ${name}`,
    display: name,
    base: `make ${name}`,
    args: [],
    hint,
    kind: 'make',
    // make 目标里怎么跑由项目自己决定，不往里追加参数
    failureFlags: false,
    custom: false,
  }));
}

/** pytest markers：`[tool.pytest.ini_options] markers = [...]` 或 pytest.ini 的 `markers =` */
export function parsePytestMarkers({ pyproject = '', ini = '' } = {}) {
  const out = [];
  const seen = new Set();
  const push = (name, hint) => {
    const marker = name.trim();
    if (!marker || seen.has(marker) || !PYTEST_TASK_MARKER.test(marker)) return;
    seen.add(marker);
    out.push({ name: marker, hint: hint.trim().slice(0, 80) });
  };

  // pyproject：markers = ["smoke: 核心主流程", ...]（可能跨行）
  const block = /\[tool\.pytest\.ini_options\]([\s\S]*?)(?:\n\[|$)/.exec(pyproject)?.[1] ?? '';
  const arrayMatch = /markers\s*=\s*\[([\s\S]*?)\]/.exec(block);
  if (arrayMatch) {
    for (const item of arrayMatch[1].matchAll(/["']([^"']+)["']/g)) {
      const [name, ...rest] = item[1].split(':');
      push(name, rest.join(':'));
    }
  }

  // pytest.ini / setup.cfg：markers = 后每行 `name: 说明`
  const iniBlock = /(?:^|\n)markers\s*=\s*\n((?:[ \t]+.+\n?)+)/.exec(ini)?.[1] ?? '';
  for (const line of iniBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, ...rest] = trimmed.split(':');
    push(name, rest.join(':'));
  }
  return out;
}

/**
 * Python 解释器：与 pytest 适配器同一套顺序（虚拟环境 → uv / poetry → python3），
 * 这里单独实现一份，免得 tasks 反向依赖适配器。
 */
export function detectPythonCommand(dir) {
  const win = process.platform === 'win32';
  const venv = win
    ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe']
    : ['.venv/bin/python', 'venv/bin/python', '.venv/bin/python3', 'venv/bin/python3'];
  for (const rel of venv) {
    if (fs.existsSync(path.join(dir, rel))) return `${quoteIfNeeded(rel)} -m pytest`;
  }
  if (fs.existsSync(path.join(dir, 'uv.lock'))) return 'uv run python -m pytest';
  if (fs.existsSync(path.join(dir, 'poetry.lock'))) return 'poetry run python -m pytest';
  return `${win ? 'python' : 'python3'} -m pytest`;
}

export function discoverPytestMarkers(probe) {
  const markers = parsePytestMarkers({
    pyproject: probe.readRel('pyproject.toml', 128 * 1024),
    ini: probe.readRel('pytest.ini', 64 * 1024) || probe.readRel('setup.cfg', 64 * 1024),
  });
  const interpreter = detectPythonCommand(probe.dir);
  return markers.map(({ name, hint }) => ({
    id: `marker:${name}`,
    label: `pytest -m ${name}`,
    display: name,
    base: interpreter,
    args: ['-m', name],
    hint,
    kind: 'pytest',
    failureFlags: true,
    custom: false,
  }));
}

/** Maven profiles：`mvn test -P<id>` */
export function parseMavenProfiles(raw) {
  const out = [];
  const seen = new Set();
  const xml = String(raw ?? '');
  for (const block of xml.matchAll(/<profile>([\s\S]*?)<\/profile>/g)) {
    const id = /<id>\s*([^<]+?)\s*<\/id>/.exec(block[1])?.[1]?.trim();
    if (!id || seen.has(id)) continue;
    // `-P` 只接受简单标识，带空格 / 中文的 profile 名跳过
    if (!/^[\w.-]+$/.test(id)) continue;
    seen.add(id);
    out.push({ id });
  }
  return out;
}

export function discoverMavenTasks(probe) {
  const pom = probe.readRel('pom.xml', 256 * 1024);
  if (!pom) return [];
  const mvn = fs.existsSync(path.join(probe.dir, 'mvnw')) ? './mvnw' : 'mvn';
  return parseMavenProfiles(pom).map(({ id }) => ({
    id: `profile:${id}`,
    label: `${mvn} test -P${id}`,
    display: id,
    base: `${mvn} test`,
    args: [`-P${id}`],
    hint: `Maven profile ${id}`,
    kind: 'maven',
    failureFlags: false,
    custom: false,
  }));
}

/**
 * 一个项目能跑的「任务」清单（不含「全量运行」，那项固定排第一，由调用方补）。
 * @param {object} probe buildProbe 的结果
 * @param {string} framework playwright / pytest / selenium
 */
export function discoverRunTasks(probe, framework) {
  if (!probe?.exists) return [];
  let tasks = [];
  if (framework === 'pytest') {
    tasks = [...discoverMakeTargets(probe), ...discoverPytestMarkers(probe)];
  } else if (framework === 'selenium' && (probe.hasPom || probe.hasGradle)) {
    tasks = discoverMavenTasks(probe);
  } else {
    tasks = discoverNodeScripts(probe);
  }
  // 同一个 label 只留第一条（Makefile 和 marker 常常同名）
  const seen = new Set();
  return tasks
    .filter((task) => {
      if (seen.has(task.label)) return false;
      seen.add(task.label);
      return true;
    })
    .slice(0, MAX_RUN_TASKS);
}

/** 自定义任务：只保留名称 + 命令，走 shell 执行（名称为空时下拉里直接显示命令） */
export function normalizeCustomTasks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, CUSTOM_TASK_LIMIT)) {
    if (!item || typeof item !== 'object') continue;
    const command = text(item.command, 1000).trim();
    if (!command) continue;
    const name = text(item.name, 60).trim();
    const id = text(item.id, 64) || `ut_${out.length}_${Math.random().toString(36).slice(2, 8)}`;
    out.push({ id, name, command });
  }
  return out;
}

/** 自定义任务 → 下拉里的任务（base 就是用户写的命令本身） */
export function customToTasks(customTasks) {
  return normalizeCustomTasks(customTasks).map(({ id, name, command }) => ({
    id,
    // 有名称显示「名称（命令）」，没名称就直接显示命令
    label: name ? `${name}（${command}）` : command,
    display: name || command,
    base: command,
    args: [],
    hint: name ? command : '',
    kind: 'custom',
    failureFlags: false,
    custom: true,
  }));
}

/** 用户对自动发现任务的改动（名称 / 命令），按任务 id 存 */
export function normalizeTaskOverrides(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_RUN_TASKS)) {
    if (!item || typeof item !== 'object') continue;
    const id = text(item.id, 64);
    if (!id || id === 'full') continue;
    out.push({
      id,
      name: text(item.name, 60).trim(),
      command: text(item.command, 1000).trim(),
    });
  }
  return out;
}

/** 隐藏掉的自动发现任务 id（用户在运行配置里删掉的） */
export function normalizeHiddenTaskIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = text(item, 64);
    if (!id || id === 'full' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, MAX_RUN_TASKS);
}

/**
 * 把用户对自动发现任务的改动套上去：
 * - 删掉的直接不返回；
 * - 改过命令的换成原样的 shell 命令，不再追加框架参数（`--lf` 之类塞给自定义命令没意义）；
 * - 改过名称的只换显示名，命令保持原样。
 */
export function applyTaskOverrides(tasks, overrides, hiddenIds) {
  const edits = new Map(normalizeTaskOverrides(overrides).map((item) => [item.id, item]));
  const hidden = new Set(normalizeHiddenTaskIds(hiddenIds));
  const out = [];
  for (const task of tasks) {
    if (hidden.has(task.id)) continue;
    const edit = edits.get(task.id);
    if (!edit) {
      out.push(task);
      continue;
    }
    const command = edit.command || taskCommandLine(task);
    const name = edit.name || task.display || '';
    out.push({
      ...task,
      base: command,
      args: [],
      failureFlags: false,
      display: name,
      label: name ? `${name}（${command}）` : command,
      hint: edit.name ? command : task.hint,
      edited: true,
    });
  }
  return out;
}

/** 任务最终执行的命令行（shell 用） */
export function taskCommandLine(task, flags = {}) {
  const parts = [task.base, ...(task.args ?? [])];
  if (task.failureFlags) {
    if (flags.lastFailed) parts.push(task.kind === 'pytest' ? '--lf' : '--last-failed');
    if (flags.bail) parts.push(task.kind === 'pytest' ? '-x' : '--max-failures=1');
  }
  return parts.filter(Boolean).join(' ');
}

/** 给前端看的任务（去掉执行细节，只留能显示 / 能选的部分） */
export function taskView(task) {
  return {
    id: task.id,
    label: task.label,
    display: task.display,
    hint: task.hint,
    kind: task.kind,
    failureFlags: task.failureFlags,
    custom: task.custom,
    edited: Boolean(task.edited),
    command: taskCommandLine(task),
  };
}
