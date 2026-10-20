/**
 * IR → pytest + playwright.sync_api
 *
 * 依赖项目自己的 pytest-playwright（提供 `page` fixture）。
 * 浏览器二进制可以直接复用 Playwright 的全局缓存，不必重新下载。
 */
import { pythonFunctionName, slugify, splitEnvValue } from './ir.mjs';

const q = (value) => JSON.stringify(String(value ?? ''));

const PY_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

function locatorCode(spec, owner = 'page') {
  const base = (() => {
    if (spec.kind === 'testid') return `${owner}.get_by_test_id(${q(spec.value)})`;
    if (spec.kind === 'role') {
      if (!spec.name) return `${owner}.get_by_role(${q(spec.role)})`;
      const exact = spec.exact ? ', exact=True' : '';
      return `${owner}.get_by_role(${q(spec.role)}, name=${q(spec.name)}${exact})`;
    }
    if (spec.kind === 'label') {
      return `${owner}.get_by_label(${q(spec.value)}${spec.exact ? ', exact=True' : ''})`;
    }
    if (spec.kind === 'placeholder') {
      return `${owner}.get_by_placeholder(${q(spec.value)}${spec.exact ? ', exact=True' : ''})`;
    }
    if (spec.kind === 'text') {
      return `${owner}.get_by_text(${q(spec.value)}${spec.exact ? ', exact=True' : ''})`;
    }
    if (spec.kind === 'attr') {
      const body = `[${spec.attr}="${String(spec.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
      return `${owner}.locator(${q(body)})`;
    }
    return `${owner}.locator(${q(spec.value)})`;
  })();
  if (spec.nth == null) return base;
  return spec.nth === 0 ? `${base}.first` : `${base}.nth(${spec.nth})`;
}

function valueCode(value) {
  const env = splitEnvValue(value);
  if (env) return `os.environ.get(${q(env)}, "")`;
  return q(value ?? '');
}

function stepCode(step, index, ir) {
  const target = step.locator ? locatorCode(step.locator) : '';
  const url = (value) =>
    ir.baseURL && String(value ?? '/').startsWith('/')
      ? `BASE_URL + ${q(value ?? '/')}`
      : q(value ?? '/');
  switch (step.action) {
    case 'goto':
      return `    page.goto(${url(step.url)})`;
    case 'click':
      return `    ${target}.click()`;
    case 'fill':
      return `    ${target}.fill(${valueCode(step.value)})`;
    case 'select':
      return `    ${target}.select_option(${valueCode(step.value)})`;
    case 'press':
      return step.locator
        ? `    ${target}.press(${q(step.key ?? 'Enter')})`
        : `    page.keyboard.press(${q(step.key ?? 'Enter')})`;
    case 'hover':
      return `    ${target}.hover()`;
    case 'expect': {
      if (step.text) return `    expect(${target}).to_contain_text(${valueCode(step.text)})`;
      if (step.state === 'hidden') return `    expect(${target}).to_be_hidden()`;
      return `    expect(${target}).to_be_visible()`;
    }
    case 'expectUrl':
      return `    expect(page).to_have_url(${url(step.url)})`;
    case 'wait':
      return `    page.wait_for_timeout(${Number(step.ms) || 500})`;
    case 'screenshot': {
      const name = String(step.value ?? `step-${index + 1}`)
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return `    page.screenshot(path=${q(`reports/ai/${name || `step-${index + 1}`}.png`)}, full_page=True)`;
    }
    default:
      return '';
  }
}

/** 生成 Python 脚本；`ir` 需先过 normalizeIr */
export function renderPython(ir) {
  const title = ir.title || 'AI 生成用例';
  const funcName = PY_KEYWORDS.has(pythonFunctionName(title))
    ? 'test_ai_generated'
    : pythonFunctionName(title);
  const lines = [];
  lines.push('"""');
  lines.push(title);
  if (ir.source) {
    for (const line of String(ir.source).split(/\r?\n/).slice(0, 8)) {
      lines.push(line.trim());
    }
  }
  lines.push('"""');
  lines.push('import os');
  lines.push('');
  lines.push('from playwright.sync_api import Page, expect');
  if (ir.baseURL) {
    lines.push('');
    // 相对路径靠这里拼成完整地址：不依赖项目的 pytest-playwright --base-url 配置
    lines.push(`BASE_URL = os.environ.get("BASE_URL", ${q(ir.baseURL)})`);
  }
  lines.push('');
  lines.push('');
  lines.push(`def ${funcName}(page: Page) -> None:`);
  for (let index = 0; index < ir.steps.length; index += 1) {
    const step = ir.steps[index];
    if (step.note) lines.push(`    # ${step.note.replace(/\s+/g, ' ').slice(0, 160)}`);
    const code = stepCode(step, index, ir);
    if (code) lines.push(code);
  }
  if (!ir.steps.length) lines.push('    pass');
  lines.push('');
  return { code: lines.join('\n'), filename: `${funcName}.py`, language: 'python' };
}

export { slugify, locatorCode, valueCode };
