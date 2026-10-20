/**
 * 自动化测试适配器的公共工具：项目探针、JUnit XML 解析、文本小工具。
 *
 * 适配器只依赖这里的纯函数与 `fs`，不依赖插件本体，便于单测。
 */
import fs from 'node:fs';
import path from 'node:path';

export function text(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, max);
}

export function intOr(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** 目录树 / 报告快照里一律跳过的名字（依赖、构建产物、缓存） */
export const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'test-results',
  'playwright-report',
  'blob-report',
  'dist',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.DS_Store',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.gradle',
  '.venv',
  'venv',
]);

/** 快照报告时额外跳过的文件后缀（体积大且对阅读报告没帮助） */
export const SNAPSHOT_SKIP_EXT = new Set(['.webm', '.mp4', '.zip', '.gz', '.tar']);

export function readSmall(abs, max = 256 * 1024) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return '';
    const size = Math.min(stat.size, max);
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(abs, 'r');
    try {
      fs.readSync(fd, buffer, 0, size, 0);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

export function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function normalizeDepName(name) {
  return String(name).trim().toLowerCase().replace(/_/g, '-');
}

/** requirements*.txt / Pipfile / pyproject.toml 里能认出来的 Python 依赖名 */
export function collectPythonDeps(dir) {
  const deps = new Set();
  const addLine = (line) => {
    const clean = line.split('#')[0].trim();
    if (!clean || clean.startsWith('-') || /^[.[]/.test(clean)) return;
    const name = clean.split(/[<>=!~;\s[]/)[0].trim();
    if (name) deps.add(normalizeDepName(name));
  };
  const readReqs = (file) => {
    for (const line of readSmall(file).split(/\r?\n/)) addLine(line);
  };

  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name.endsWith('.txt') && /requirements/i.test(name)) readReqs(path.join(dir, name));
  }
  // requirements/ 子目录里常见的拆分写法
  const nested = path.join(dir, 'requirements');
  if (isDir(nested)) {
    try {
      for (const name of fs.readdirSync(nested)) {
        if (name.endsWith('.txt')) readReqs(path.join(nested, name));
      }
    } catch {
      // ignore
    }
  }

  const pyproject = readSmall(path.join(dir, 'pyproject.toml'));
  if (pyproject) {
    // PEP 621 / dependency-groups 里是带引号的依赖字符串，例如 "pytest>=8.3.0",
    // 允许行尾注释与 extras，只取包名，避免把 markers / 表键当成依赖
    const quotedRe = /"([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~][^"]*)?"/g;
    let match;
    while ((match = quotedRe.exec(pyproject))) {
      const name = normalizeDepName(match[1]);
      // 过滤 ruff 的 "E" / "F" 与纯版本号，减少误报
      if (name.length < 2 || /^\d/.test(name)) continue;
      deps.add(name);
    }

    // Poetry 用表格式依赖（selenium = "^4"），只在 dependencies 段里认
    let inPoetryDeps = false;
    for (const line of pyproject.split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) {
        inPoetryDeps = /^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(header[1]);
        continue;
      }
      if (!inPoetryDeps) continue;
      const kv = /^\s*([A-Za-z0-9_.-]+)\s*=/i.exec(line);
      if (kv) deps.add(normalizeDepName(kv[1]));
    }
  }

  const pipfile = readSmall(path.join(dir, 'Pipfile'));
  if (pipfile) {
    let inPackages = false;
    for (const line of pipfile.split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) {
        inPackages = /^(packages|dev-packages)$/i.test(header[1]);
        continue;
      }
      if (!inPackages) continue;
      const match = /^\s*([A-Za-z0-9_.-]+)\s*=/i.exec(line);
      if (match) deps.add(normalizeDepName(match[1]));
    }
  }
  return deps;
}

/** 目录里是否存在匹配的文件名（最多走 depth 层） */
export function hasFileMatching(dir, pattern, depth = 3, limit = 2000) {
  let seen = 0;
  const walk = (abs, level) => {
    if (level > depth) return false;
    let items;
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const item of items) {
      if (IGNORED_NAMES.has(item.name)) continue;
      seen += 1;
      if (seen > limit) return false;
      if (item.isDirectory()) {
        if (walk(path.join(abs, item.name), level + 1)) return true;
      } else if (pattern.test(item.name)) {
        return true;
      }
    }
    return false;
  };
  return walk(dir, 0);
}

/**
 * 一次性收集识别框架需要的证据，避免每个适配器各扫一遍目录。
 * @param {string} dir
 */
export function buildProbe(dir) {
  const exists = isDir(dir);
  const existsRel = (rel) => Boolean(exists && fs.existsSync(path.join(dir, rel)));
  const readRel = (rel, max) => (exists ? readSmall(path.join(dir, rel), max) : '');

  let pkg = null;
  const pkgText = readRel('package.json');
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      pkg = null;
    }
  }

  const nodeDeps = new Set();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg?.[key] ?? {})) nodeDeps.add(name);
  }

  let packageManager = '';
  if (typeof pkg?.packageManager === 'string' && pkg.packageManager) {
    packageManager = pkg.packageManager.split('@')[0] || '';
  }
  if (!packageManager && existsRel('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (!packageManager && existsRel('yarn.lock')) packageManager = 'yarn';
  else if (!packageManager && existsRel('package-lock.json')) packageManager = 'npm';

  const pythonDeps = exists ? collectPythonDeps(dir) : new Set();
  const hasPythonTests = exists && hasFileMatching(dir, /^(test_.*|.*_test)\.py$/);

  return {
    dir,
    exists,
    existsRel,
    readRel,
    pkg,
    nodeDeps,
    pythonDeps,
    hasPythonTests,
    packageManager,
    hasPom: existsRel('pom.xml'),
    hasGradle: existsRel('build.gradle') || existsRel('build.gradle.kts'),
  };
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(raw))) attrs[match[1]] = decodeXml(match[2]);
  return attrs;
}

export function emptySummary() {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs: 0,
    errors: [],
    failedTests: [],
    projectNames: [],
  };
}

/**
 * 解析 JUnit XML（pytest --junitxml、Maven surefire、Gradle test、mocha junit reporter 通用）。
 * @param {string} xml
 */
export function parseJUnitXml(xml) {
  const summary = emptySummary();
  if (typeof xml !== 'string' || !xml.trim()) return summary;

  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;
  let durationMs = 0;
  let seen = 0;
  while ((match = re.exec(xml))) {
    seen += 1;
    if (seen > 50_000) break;
    const attrs = parseAttrs(match[1]);
    const body = match[2] || '';
    summary.total += 1;

    const seconds = Number(attrs.time);
    if (Number.isFinite(seconds) && seconds > 0) durationMs += seconds * 1000;

    if (/<skipped\b/.test(body)) {
      summary.skipped += 1;
      continue;
    }
    if (/<(failure|error)\b/.test(body)) {
      summary.failed += 1;
      const title = [attrs.classname, attrs.name].filter(Boolean).join(' › ') || '未命名用例';
      if (summary.failedTests.length < 50) {
        summary.failedTests.push({ title, file: attrs.file || '' });
      }
      if (/<error\b/.test(body) && summary.errors.length < 20) {
        const tag = /<(?:failure|error)\b([^>]*)>([\s\S]{0,2000})/.exec(body);
        const message = tag ? text(tag[1].match(/message\s*=\s*"([^"]*)"/)?.[1], 2000) : '';
        const detail = tag ? text(decodeXml(tag[2]).split(/\r?\n/)[0], 2000) : '';
        const value = message || detail;
        if (value) summary.errors.push(value);
      }
      continue;
    }
    summary.passed += 1;
  }
  summary.durationMs = Math.round(durationMs);
  return summary;
}

/** 把多个 JUnit 文件的结果合并成一个汇总（按 testcase 计，不重复） */
export function mergeSummaries(list) {
  const out = emptySummary();
  for (const item of list) {
    if (!item) continue;
    out.total += item.total;
    out.passed += item.passed;
    out.failed += item.failed;
    out.skipped += item.skipped;
    out.flaky += item.flaky;
    out.durationMs += item.durationMs;
    for (const err of item.errors ?? []) {
      if (out.errors.length < 20) out.errors.push(err);
    }
    for (const failed of item.failedTests ?? []) {
      if (out.failedTests.length < 50) out.failedTests.push(failed);
    }
    for (const name of item.projectNames ?? []) {
      if (!out.projectNames.includes(name)) out.projectNames.push(name);
    }
  }
  return out;
}

/** 列出目录里符合条件的文件（新→旧），供解析报告 / 结果用 */
export function listFiles(dir, { pattern, minMtime = 0, maxDepth = 4, limit = 200 } = {}) {
  const out = [];
  const walk = (abs, level) => {
    if (level > maxDepth || out.length >= limit) return;
    let items;
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= limit) return;
      if (IGNORED_NAMES.has(item.name)) continue;
      const child = path.join(abs, item.name);
      if (item.isDirectory()) {
        walk(child, level + 1);
        continue;
      }
      if (pattern && !pattern.test(item.name)) continue;
      let stat;
      try {
        stat = fs.statSync(child);
      } catch {
        continue;
      }
      if (stat.mtimeMs < minMtime) continue;
      out.push({ abs: child, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
