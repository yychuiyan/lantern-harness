/**
 * Playwright 适配器：JS / TS 项目，跑 `playwright test`。
 *
 * - 报告与项目的 playwright.config 保持一致：不覆盖 outputFolder，
 *   运行结束后由插件把 playwright-report/ 快照到空间目录。
 * - 唯一写进空间的是 JSON reporter 结果（我们自己解析用）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { emptySummary, intOr, parseJUnitXml, readSmall, text } from './shared.mjs';

export const id = 'playwright';
export const label = 'Playwright';
export const kind = 'ui';
export const controls = ['file', 'grep', 'project', 'workers', 'headed', 'lastFailed'];
export const configFiles = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

export function detect(probe) {
  const config = configFiles.find((name) => probe.existsRel(name));
  if (config) return { score: 100, evidence: [config] };
  if (probe.nodeDeps.has('@playwright/test')) {
    return { score: 92, evidence: ['package.json: @playwright/test'] };
  }
  if (probe.nodeDeps.has('playwright')) {
    return { score: 86, evidence: ['package.json: playwright'] };
  }
  return null;
}

function findCommand(dir) {
  const bin = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  const local = path.join(dir, 'node_modules', '.bin', bin);
  if (fs.existsSync(local)) return { command: local, prefix: [] };
  if (fs.existsSync(path.join(dir, 'node_modules', '@playwright', 'test'))) {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      prefix: ['--no-install', 'playwright'],
    };
  }
  return null;
}

export function ready(probe) {
  return Boolean(findCommand(probe.dir));
}

export function readyHint(probe) {
  const runner =
    probe.packageManager === 'pnpm'
      ? 'pnpm install'
      : probe.packageManager === 'yarn'
        ? 'yarn'
        : 'npm install';
  const browsers =
    probe.packageManager === 'pnpm'
      ? 'pnpm exec playwright install'
      : probe.packageManager === 'yarn'
        ? 'yarn playwright install'
        : 'npx playwright install';
  return `未找到 Playwright：请先在 ${probe.dir} 运行「${runner}」，首次使用再运行「${browsers}」。`;
}

/** 拼 Playwright 运行参数（纯函数，便于单测） */
export function buildPlaywrightArgs(options = {}) {
  const args = ['test', '--reporter=list,json,html'];
  const file = text(options.file, 1024);
  if (file) args.push(file.replace(/\\/g, '/'));
  const grep = text(options.grep, 500);
  if (grep) args.push('--grep', grep);
  const project = text(options.project, 100);
  if (project) args.push(`--project=${project}`);
  if (options.headed === true) args.push('--headed');
  const workers = intOr(options.workers, 0, 0, 32);
  if (workers > 0) args.push(`--workers=${workers}`);
  if (options.lastFailed === true) args.push('--last-failed');
  if (options.bail === true) args.push('--max-failures=1');
  return args;
}

export function resolve(ctx) {
  const command = findCommand(ctx.dir);
  if (!command) return { error: readyHint(ctx.probe) };
  const env = { PLAYWRIGHT_JSON_OUTPUT_NAME: ctx.resultAbs };
  // 有些项目的 config 会 import tsconfig-paths/register，它把 `--project` 当成 tsconfig 路径；
  // 预加载守卫只在加载它的瞬间摘掉这两个参数，避免 ENOENT（见 uiauto-argv-guard.cjs）
  if (ctx.args.project && ctx.guardPath && fs.existsSync(ctx.guardPath)) {
    const requireFlag = `--require ${JSON.stringify(ctx.guardPath)}`;
    env.NODE_OPTIONS = process.env.NODE_OPTIONS
      ? `${process.env.NODE_OPTIONS} ${requireFlag}`
      : requireFlag;
  }
  return {
    command: command.command,
    args: [...command.prefix, ...buildPlaywrightArgs(ctx.args)],
    env,
  };
}

/** 解析 Playwright JSON reporter 的结果（纯函数） */
export function parsePlaywrightReport(raw) {
  const empty = emptySummary();
  if (!raw || typeof raw !== 'object') return empty;
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  const projectNames = Array.isArray(raw.config?.projects)
    ? raw.config.projects
        .map((item) => text(item?.name, 100))
        .filter(Boolean)
        .slice(0, 50)
    : [];
  const expected = intOr(stats.expected, 0, 0, 1_000_000);
  const unexpected = intOr(stats.unexpected, 0, 0, 1_000_000);
  const skipped = intOr(stats.skipped, 0, 0, 1_000_000);
  const flaky = intOr(stats.flaky, 0, 0, 1_000_000);
  const errors = Array.isArray(raw.errors)
    ? raw.errors
        .map((item) => text(typeof item === 'string' ? item : item?.message, 2000))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const failedTests = [];
  const walk = (suite, trail) => {
    if (!suite || typeof suite !== 'object') return;
    const file = text(suite.file, 1024);
    const own = text(suite.title, 500);
    const nextTrail = own ? [...trail, own] : trail;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      const tests = Array.isArray(spec?.tests) ? spec.tests : [];
      const bad = tests.some(
        (t) =>
          t?.status === 'unexpected' ||
          t?.status === 'timedOut' ||
          (Array.isArray(t?.results) &&
            t.results.some((r) => r?.status === 'unexpected' || r?.status === 'timedOut')),
      );
      if (!bad) continue;
      failedTests.push({
        title: [...nextTrail, text(spec?.title, 500)].filter(Boolean).join(' › '),
        file,
      });
      if (failedTests.length >= 50) return;
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child, nextTrail);
  };
  for (const suite of Array.isArray(raw.suites) ? raw.suites : []) walk(suite, []);
  return {
    total: expected + unexpected + skipped + flaky,
    passed: expected,
    failed: unexpected,
    skipped,
    flaky,
    durationMs: intOr(stats.duration, 0, 0, Number.MAX_SAFE_INTEGER),
    errors,
    failedTests,
    projectNames,
  };
}

/** 项目里可能的 HTML 报告目录（项目相对路径），运行后取有 index.html 的那个：
 *  先认 config 里显式写的 outputFolder，再退回官方默认目录 */
export function reportDirs(probe) {
  const dirs = new Set(['playwright-report']);
  for (const name of configFiles) {
    const content = probe.readRel(name);
    if (!content) continue;
    const re = /outputFolder\s*:\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = re.exec(content))) {
      const rel = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
      dirs.add(rel);
    }
  }
  return [...dirs];
}

export function parse(ctx) {
  const raw = readSmall(ctx.resultAbs, 32 * 1024 * 1024);
  if (!raw) return emptySummary();
  try {
    return parsePlaywrightReport(JSON.parse(raw));
  } catch {
    return emptySummary();
  }
}

/** 运行失败且解析不到结果时，从日志里给一条可操作的提示 */
export function hintFromLog(log) {
  if (
    /Executable doesn't exist|Please run the following command to download new browsers/i.test(log)
  ) {
    return '缺少浏览器内核：请在项目目录运行 playwright install（或 npx playwright install）后重试。';
  }
  if (/Cannot find module ['"]@playwright\/test['"]/i.test(log)) {
    return '项目里没有安装 @playwright/test：先在项目目录安装依赖再运行。';
  }
  return '';
}

export function describeArgs(args) {
  const parts = [];
  if (args.file) parts.push(args.file);
  if (args.grep) parts.push(`grep: ${args.grep}`);
  if (args.project) parts.push(args.project);
  if (args.headed) parts.push('headed');
  if (args.workers > 0) parts.push(`workers=${args.workers}`);
  if (args.lastFailed) parts.push('--last-failed');
  if (args.bail) parts.push('--max-failures=1');
  return parts.length ? parts.join(' · ') : '全量';
}
