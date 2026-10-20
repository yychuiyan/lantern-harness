/**
 * pytest 适配器：Python 项目，接口（requests / httpx）与 UI（selenium / playwright）都用它跑。
 *
 * - 解释器按本地虚拟环境 → uv / poetry → python3 的顺序找，不自动安装任何东西。
 * - 结果统一走 `--junitxml`，解析成和 Playwright 相同的汇总结构。
 * - HTML 报告只在项目声明了 pytest-html 时生成，直接写进空间目录（不污染项目）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { intOr, parseJUnitXml, readSmall, text } from './shared.mjs';

export const id = 'pytest';
export const label = 'pytest';
export const controls = ['file', 'grep'];

const UI_DEPS = ['selenium', 'playwright', 'appium-python-client', 'playwright-stealth'];
const API_DEPS = ['requests', 'httpx', 'jsonschema', 'tavern', 'schemathesis'];

function pytestEvidence(probe) {
  const evidence = [];
  if (probe.existsRel('pytest.ini')) evidence.push('pytest.ini');
  if (probe.existsRel('conftest.py')) evidence.push('conftest.py');
  const pyproject = probe.readRel('pyproject.toml');
  if (pyproject && /\[tool\.pytest\.ini_options\]/.test(pyproject)) {
    evidence.push('pyproject.toml: [tool.pytest.ini_options]');
  }
  const setupCfg = probe.readRel('setup.cfg');
  if (setupCfg && /\[tool:pytest\]/.test(setupCfg)) evidence.push('setup.cfg: [tool:pytest]');
  if (probe.pythonDeps.has('pytest')) evidence.push('依赖: pytest');
  return evidence;
}

function detectKind(probe) {
  if (UI_DEPS.some((name) => probe.pythonDeps.has(name))) return 'ui';
  if (API_DEPS.some((name) => probe.pythonDeps.has(name))) return 'api';
  return 'test';
}

export function detect(probe) {
  const evidence = pytestEvidence(probe);
  let score = 0;
  if (probe.existsRel('pytest.ini')) score = 100;
  else if (
    evidence.some((item) => item.startsWith('pyproject.toml') || item.startsWith('setup.cfg'))
  ) {
    score = 96;
  } else if (probe.existsRel('conftest.py')) score = 90;
  else if (probe.pythonDeps.has('pytest')) score = 84;
  else if (probe.hasPythonTests) score = 70;

  // Python + selenium 但没有 pytest 配置：仍然用 pytest 跑（Python 生态最常见），分数压低
  if (!score && probe.pythonDeps.has('selenium')) {
    return { score: 58, evidence: ['依赖: selenium'], kind: 'ui' };
  }
  if (!score) return null;
  if (probe.hasPythonTests) evidence.push('tests: test_*.py');
  return { score, evidence, kind: detectKind(probe) };
}

/** 本地解释器：虚拟环境优先，其次 uv / poetry，最后系统 python3 */
function findInterpreter(dir) {
  const win = process.platform === 'win32';
  const venvCandidates = win
    ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe']
    : ['.venv/bin/python', 'venv/bin/python', '.venv/bin/python3', 'venv/bin/python3'];
  for (const rel of venvCandidates) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) return { command: abs, prefix: ['-m', 'pytest'], source: rel };
  }
  if (fs.existsSync(path.join(dir, 'uv.lock'))) {
    return { command: 'uv', prefix: ['run', 'python', '-m', 'pytest'], source: 'uv.lock' };
  }
  if (fs.existsSync(path.join(dir, 'poetry.lock'))) {
    return { command: 'poetry', prefix: ['run', 'python', '-m', 'pytest'], source: 'poetry.lock' };
  }
  return {
    command: win ? 'python' : 'python3',
    prefix: ['-m', 'pytest'],
    source: win ? 'python' : 'python3',
  };
}

export function ready() {
  return true;
}

export function readyHint(probe) {
  return `未找到 Python 解释器：请在 ${probe.dir} 建一个虚拟环境（python3 -m venv .venv）并安装依赖后再运行。`;
}

export function resolve(ctx) {
  const interpreter = findInterpreter(ctx.dir);
  const args = [...interpreter.prefix, '-q', `--junitxml=${ctx.resultAbs}`];

  const file = text(ctx.args.file, 1024);
  if (file) args.push(file.replace(/\\/g, '/'));

  // pytest 里最贴近「按名字筛」的是 -k 表达式
  const grep = text(ctx.args.grep, 500);
  if (grep) args.push('-k', grep);

  const marker = text(ctx.args.marker, 200);
  if (marker) args.push('-m', marker);

  if (ctx.args.lastFailed === true) args.push('--lf');
  if (ctx.args.bail === true) args.push('-x');

  const maxFail = intOr(ctx.args.maxFail, 0, 0, 10_000);
  if (maxFail > 0) args.push(`--maxfail=${maxFail}`);

  const hasHtml = ctx.probe.pythonDeps.has('pytest-html');
  if (hasHtml) {
    args.push(`--html=${path.join(ctx.reportAbs, 'index.html')}`, '--self-contained-html');
  }

  return { command: interpreter.command, args, env: { PYTHONUNBUFFERED: '1' } };
}

export function parse(ctx) {
  const xml = readSmall(ctx.resultAbs, 32 * 1024 * 1024);
  return xml ? parseJUnitXml(xml) : parseJUnitXml('');
}

export function describeArgs(args) {
  const parts = [];
  if (args.file) parts.push(args.file);
  if (args.grep) parts.push(`-k ${args.grep}`);
  if (args.marker) parts.push(`-m ${args.marker}`);
  if (args.lastFailed) parts.push('--lf');
  if (args.bail) parts.push('-x');
  if (args.maxFail > 0) parts.push(`--maxfail=${args.maxFail}`);
  return parts.length ? parts.join(' · ') : '全量';
}

export function hintFromLog(log) {
  if (/No module named ['"]?pytest/i.test(log)) {
    return '当前 Python 环境没有 pytest：请在项目里安装依赖（pip install -r requirements.txt）后重试。';
  }
  if (/No module named ['"]?allure/i.test(log)) {
    return '缺少 allure-pytest：先在项目里安装该插件，或从 pytest 配置的 addopts 里移除 --alluredir。';
  }
  if (/ERROR: file or directory not found/i.test(log)) {
    return '指定的测试文件不存在：清空「文件」筛选后重试，或先在项目里创建该文件。';
  }
  return '';
}

export function reportDirs() {
  return [];
}
