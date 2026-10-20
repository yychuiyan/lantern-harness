/**
 * 多文件出码：主用例 + 按页面拆出的 page object（+ 可选的登录态 fixture、config 补丁建议）。
 *
 * 为什么要拆：一条用例往往要同时改 spec、页面对象、fixture。
 * 只写一个文件的话，用户还得手工把重复的定位器抽出去。
 *
 * 约定：
 * - 导航（goto / wait / 截图 / URL 断言）留在 spec 里，元素操作进 page object。
 * - page object 按 goto 的 URL 分段：/login → LoginPage，/ → HomePage。
 * - 定位器文本是中文时方法名退化到角色名（clickButton），重名再加序号。
 */
import { emitCode } from './emit.mjs';
import { locatorCode as tsLocator, valueCode as tsValue } from './emit-ts.mjs';
import { locatorCode as pyLocator, valueCode as pyValue } from './emit-python.mjs';
import { normalizeIr, pythonFunctionName, slugify } from './ir.mjs';

const q = (value) => JSON.stringify(String(value ?? ''));

/** 元素操作（进 page object）；导航类动作留在 spec */
const ELEMENT_ACTIONS = new Set(['click', 'fill', 'select', 'press', 'hover', 'expect']);

function pascal(text) {
  const ascii = String(text ?? '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  if (!ascii) return '';
  return ascii
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function snake(text) {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** `/cart/list?x=1` → `CartListPage`；`/` → `HomePage` */
export function pageNameFor(url) {
  const clean = String(url ?? '')
    .split('#')[0]
    .split('?')[0]
    .replace(/^https?:\/\/[^/]+/i, '');
  const base = pascal(clean);
  return `${base || 'Home'}Page`;
}

const KIND_HINT = {
  testid: 'TestId',
  role: 'Role',
  label: 'Label',
  placeholder: 'Placeholder',
  text: 'Text',
  attr: 'ByAttr',
  css: 'Locator',
};

/** 页面内方法名：优先用定位器文本，退化到角色 / 类型 */
function methodBase(step) {
  const locator = step.locator ?? {};
  const hint =
    pascal(locator.value) ||
    pascal(locator.name) ||
    pascal(locator.role) ||
    pascal(locator.attr) ||
    KIND_HINT[locator.kind] ||
    '';
  const action = step.action;
  const tail = hint || 'Element';
  return `${action}${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
}

function uniqueName(base, used) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}${index}`)) index += 1;
  const next = `${base}${index}`;
  used.add(next);
  return next;
}

/**
 * 把 IR 的步骤分组：每个 goto 开一段，段内元素操作归到该页面的 page object。
 * 第一段没有 goto 时算「首页」。
 */
export function splitPages(ir) {
  const segments = [];
  let current = { url: '', steps: [] };
  for (const step of ir.steps) {
    if (step.action === 'goto') {
      if (current.steps.length || current.url) segments.push(current);
      current = { url: String(step.url ?? '/'), steps: [] };
      continue;
    }
    current.steps.push(step);
  }
  if (current.steps.length || current.url) segments.push(current);
  if (!segments.length) segments.push({ url: '/', steps: [] });

  const pages = [];
  const usedPageNames = new Set();
  for (const segment of segments) {
    const methods = [];
    const used = new Set();
    for (const step of segment.steps) {
      if (!ELEMENT_ACTIONS.has(step.action) || !step.locator) continue;
      methods.push({ step, name: uniqueName(methodBase(step), used) });
    }
    if (!methods.length) continue;
    const name = uniqueName(pageNameFor(segment.url), usedPageNames);
    pages.push({ name, url: segment.url, methods });
  }
  return pages;
}

/** 页面名 → spec 里的变量名：LoginPage → loginPage */
function varName(pageName) {
  return `${pageName.charAt(0).toLowerCase()}${pageName.slice(1)}`;
}

function tsMethod(method, index) {
  const { step, name } = method;
  const target = tsLocator(step.locator, 'this.page');
  const note = step.note ? `  /** ${step.note.replace(/\s+/g, ' ').slice(0, 120)} */\n` : '';
  if (step.action === 'fill') {
    return `${note}  async ${name}(value: string) {\n    await ${target}.fill(value);\n  }`;
  }
  if (step.action === 'select') {
    return `${note}  async ${name}(value: string) {\n    await ${target}.selectOption(value);\n  }`;
  }
  if (step.action === 'press') {
    return `${note}  async ${name}(key = ${q(step.key ?? 'Enter')}) {\n    await ${target}.press(key);\n  }`;
  }
  if (step.action === 'click') {
    return `${note}  async ${name}() {\n    await ${target}.click();\n  }`;
  }
  if (step.action === 'hover') {
    return `${note}  async ${name}() {\n    await ${target}.hover();\n  }`;
  }
  if (step.action === 'expect') {
    if (step.text) {
      return `${note}  async ${name}(text = ${q(step.text)}) {\n    await expect(${target}).toContainText(text);\n  }`;
    }
    if (step.state === 'hidden') {
      return `${note}  async ${name}() {\n    await expect(${target}).toBeHidden();\n  }`;
    }
    return `${note}  async ${name}() {\n    await expect(${target}).toBeVisible();\n  }`;
  }
  return `${note}  async ${name}() {\n    // 第 ${index + 1} 步：${step.action}\n  }`;
}

export function renderTsPage(page) {
  const lines = [];
  lines.push('/**');
  lines.push(` * ${page.name}：${page.url || '/'} 上的元素操作。`);
  lines.push(' */');
  lines.push("import { expect, type Page } from '@playwright/test';");
  lines.push('');
  lines.push(`export class ${page.name} {`);
  lines.push('  constructor(private readonly page: Page) {}');
  for (let index = 0; index < page.methods.length; index += 1) {
    lines.push('');
    lines.push(tsMethod(page.methods[index], index));
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/** spec 里与 page object 无关的步骤：导航 / 等待 / 截图 / URL 断言 */
function specStepLine(step, index) {
  switch (step.action) {
    case 'expectUrl':
      return `    await expect(page).toHaveURL(${tsValue(step.url ?? '/')});`;
    case 'wait':
      return `    await page.waitForTimeout(${Number(step.ms) || 500});`;
    case 'screenshot': {
      const name = String(step.value ?? `step-${index + 1}`)
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return `    await page.screenshot({ path: ${q(
        `reports/ai/${name || `step-${index + 1}`}.png`,
      )}, fullPage: true });`;
    }
    case 'press':
      return `    await page.keyboard.press(${q(step.key ?? 'Enter')});`;
    default:
      return '';
  }
}

/** TS spec：导航留在用例里，元素操作调 page object */
export function renderTsSpec(ir, pages, options = {}) {
  const title = ir.title || 'AI 生成用例';
  const lines = [];
  lines.push('/**');
  lines.push(` * ${title}`);
  if (ir.source) {
    for (const line of String(ir.source).split(/\r?\n/).slice(0, 8)) {
      lines.push(` * ${line.trim()}`);
    }
  }
  lines.push(' */');
  lines.push("import { test, expect } from '@playwright/test';");
  for (const page of pages) {
    lines.push(`import { ${page.name} } from './pages/${page.name}';`);
  }
  if (ir.storageState && options.fixturePath) {
    lines.push(`import { STORAGE_STATE } from '${options.fixtureImport}';`);
  }
  lines.push('');

  const useOptions = [];
  if (ir.baseURL) useOptions.push(`baseURL: ${q(ir.baseURL)}`);
  if (ir.storageState) {
    useOptions.push(`storageState: ${options.fixturePath ? 'STORAGE_STATE' : q(ir.storageState)}`);
  }
  if (useOptions.length) {
    lines.push(`test.use({ ${useOptions.join(', ')} });`);
    lines.push('');
  }

  lines.push(`test.describe(${q(title)}, () => {`);
  lines.push(`  test(${q(title)}, async ({ page }) => {`);
  if (ir.baseURL) lines.push(`    // baseURL: ${ir.baseURL}`);
  for (const page of pages) {
    lines.push(`    const ${varName(page.name)} = new ${page.name}(page);`);
  }

  let pageCursor = 0;
  let current = pages[0] ?? null;
  let methodCursor = 0;
  for (let index = 0; index < ir.steps.length; index += 1) {
    const step = ir.steps[index];
    if (step.note) lines.push(`    // ${step.note.replace(/\s+/g, ' ').slice(0, 160)}`);
    if (step.action === 'goto') {
      const target = pages.find(
        (item, i) => i >= pageCursor && item.url === String(step.url ?? '/'),
      );
      if (target) {
        pageCursor = pages.indexOf(target);
        current = target;
      }
      methodCursor = 0;
      lines.push(`    await page.goto(${q(step.url ?? '/')});`);
      continue;
    }
    if (ELEMENT_ACTIONS.has(step.action) && step.locator) {
      const method = current?.methods[methodCursor];
      methodCursor += 1;
      if (method && current) {
        const call = `${varName(current.name)}.${method.name}`;
        if (step.action === 'fill' || step.action === 'select') {
          lines.push(`    await ${call}(${tsValue(step.value)});`);
        } else if (step.action === 'expect' && step.text) {
          lines.push(`    await ${call}(${tsValue(step.text)});`);
        } else if (step.action === 'press' && step.key) {
          lines.push(`    await ${call}(${q(step.key)});`);
        } else {
          lines.push(`    await ${call}();`);
        }
        continue;
      }
    }
    const line = specStepLine(step, index);
    if (line) lines.push(line);
  }
  lines.push('  });');
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function pyMethod(method, index) {
  const { step } = method;
  const name = snake(method.name);
  const target = pyLocator(step.locator, 'self.page');
  const withValue = step.action === 'fill' || step.action === 'select';
  const signature = `def ${name}(self${withValue ? ', value: str' : ''}) -> None:`;
  const note = step.note ? `    # ${step.note.replace(/\s+/g, ' ').slice(0, 120)}\n` : '';
  if (step.action === 'fill') return `${note}    ${signature}\n        ${target}.fill(value)`;
  if (step.action === 'select') {
    return `${note}    ${signature}\n        ${target}.select_option(value)`;
  }
  if (step.action === 'press') {
    return `${note}    ${signature}\n        ${target}.press(${q(step.key ?? 'Enter')})`;
  }
  if (step.action === 'click') return `${note}    ${signature}\n        ${target}.click()`;
  if (step.action === 'hover') return `${note}    ${signature}\n        ${target}.hover()`;
  if (step.action === 'expect') {
    if (step.text) {
      return `${note}    ${signature}\n        expect(${target}).to_contain_text(${q(step.text)})`;
    }
    if (step.state === 'hidden') {
      return `${note}    ${signature}\n        expect(${target}).to_be_hidden()`;
    }
    return `${note}    ${signature}\n        expect(${target}).to_be_visible()`;
  }
  return `${note}    ${signature}\n        pass  # 第 ${index + 1} 步：${step.action}`;
}

export function renderPyPage(page) {
  const lines = [];
  lines.push('"""');
  lines.push(`${page.name}：${page.url || '/'} 上的元素操作。`);
  lines.push('"""');
  lines.push('from playwright.sync_api import Page, expect');
  lines.push('');
  lines.push('');
  lines.push(`class ${page.name}:`);
  lines.push('    def __init__(self, page: Page) -> None:');
  lines.push('        self.page = page');
  for (let index = 0; index < page.methods.length; index += 1) {
    lines.push('');
    lines.push(pyMethod(page.methods[index], index));
  }
  lines.push('');
  return lines.join('\n');
}

export function renderPySpec(ir, pages) {
  const title = ir.title || 'AI 生成用例';
  const funcName = pythonFunctionName(title);
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
  for (const page of pages) {
    lines.push(`from pages.${snake(page.name)} import ${page.name}`);
  }
  if (ir.baseURL) {
    lines.push('');
    lines.push(`BASE_URL = os.environ.get("BASE_URL", ${q(ir.baseURL)})`);
  }
  lines.push('');
  lines.push('');
  lines.push(`def ${funcName}(page: Page) -> None:`);
  const url = (value) =>
    ir.baseURL && String(value ?? '/').startsWith('/')
      ? `BASE_URL + ${q(value ?? '/')}`
      : q(value ?? '/');

  for (const page of pages) {
    lines.push(`    ${snake(page.name)} = ${page.name}(page)`);
  }
  let pageCursor = 0;
  let current = pages[0] ?? null;
  let methodCursor = 0;
  for (let index = 0; index < ir.steps.length; index += 1) {
    const step = ir.steps[index];
    if (step.note) lines.push(`    # ${step.note.replace(/\s+/g, ' ').slice(0, 160)}`);
    if (step.action === 'goto') {
      const target = pages.find(
        (item, i) => i >= pageCursor && item.url === String(step.url ?? '/'),
      );
      if (target) {
        pageCursor = pages.indexOf(target);
        current = target;
      }
      methodCursor = 0;
      lines.push(`    page.goto(${url(step.url)})`);
      continue;
    }
    if (ELEMENT_ACTIONS.has(step.action) && step.locator) {
      const method = current?.methods[methodCursor];
      methodCursor += 1;
      if (method && current) {
        const call = `${snake(current.name)}.${snake(method.name)}`;
        if (step.action === 'fill' || step.action === 'select') {
          lines.push(`    ${call}(${pyValue(step.value)})`);
        } else {
          lines.push(`    ${call}()`);
        }
        continue;
      }
    }
    if (step.action === 'expectUrl') {
      lines.push(`    expect(page).to_have_url(${url(step.url ?? '/')})`);
    } else if (step.action === 'wait') {
      lines.push(`    page.wait_for_timeout(${Number(step.ms) || 500})`);
    } else if (step.action === 'screenshot') {
      const name = String(step.value ?? `step-${index + 1}`)
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const file = `reports/ai/${name || `step-${index + 1}`}.png`;
      lines.push(`    page.screenshot(path=${q(file)}, full_page=True)`);
    } else if (step.action === 'press') {
      lines.push(`    page.keyboard.press(${q(step.key ?? 'Enter')})`);
    }
  }
  if (!ir.steps.length) lines.push('    pass');
  lines.push('');
  return lines.join('\n');
}

/** TS 登录态常量：让 spec 与项目里其它用例复用同一份 storageState */
function tsFixture(storageState) {
  return [
    '/**',
    ' * 登录态路径。',
    ' */',
    `export const STORAGE_STATE = ${q(storageState)};`,
    '',
  ].join('\n');
}

function normalizeDir(value, fallback) {
  const raw = String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '')
    .trim();
  return raw || fallback;
}

/**
 * 生成一组待写入文件。
 *
 * @returns {{ files: Array<{path:string,content:string,language:string,role:string}>, configPatch: object|null }}
 *   role: 'spec' 主用例 / 'page' 页面对象 / 'fixture' 登录态常量
 */
export function emitFiles(rawIr, target, options = {}) {
  const ir = normalizeIr(rawIr, { target });
  const language = target === 'python' || ir.target === 'python' ? 'python' : 'ts';
  const testDir = normalizeDir(options.testDir, 'tests');
  const single = emitCode(ir, language);
  const pages = splitPages(ir);
  const files = [];

  if (language === 'python') {
    files.push({
      path: `${testDir}/${single.filename}`,
      content: renderPySpec(ir, pages),
      language: 'python',
      role: 'spec',
    });
    for (const page of pages) {
      files.push({
        path: `${testDir}/pages/${snake(page.name).replace(/_page$/, '')}_page.py`,
        content: renderPyPage(page),
        language: 'python',
        role: 'page',
      });
    }
  } else {
    const fixturePath = `${testDir}/fixtures/auth-state.ts`;
    const fixtureImport = './fixtures/auth-state';
    const useFixture = Boolean(ir.storageState) && options.fixture !== false;
    files.push({
      path: `${testDir}/${single.filename}`,
      content: renderTsSpec(ir, pages, {
        fixturePath: useFixture ? fixturePath : '',
        fixtureImport,
      }),
      language: 'ts',
      role: 'spec',
    });
    for (const page of pages) {
      files.push({
        path: `${testDir}/pages/${page.name}.ts`,
        content: renderTsPage(page),
        language: 'ts',
        role: 'page',
      });
    }
    if (useFixture) {
      files.push({
        path: fixturePath,
        content: tsFixture(ir.storageState),
        language: 'ts',
        role: 'fixture',
      });
    }
  }

  // 项目没配 baseURL 时只给建议，不替用户改 config
  let configPatch = null;
  if (ir.baseURL && !options.hasBaseURL) {
    configPatch = {
      path: language === 'python' ? 'pytest.ini' : 'playwright.config.ts',
      reason: '项目配置里没有 baseURL，想全局生效可以补上；用例本身不依赖它',
      snippet:
        language === 'python'
          ? `# pytest.ini\n# addopts = --base-url ${ir.baseURL}`
          : `// playwright.config.ts\nuse: { baseURL: ${q(ir.baseURL)} },`,
    };
  }

  return { files, configPatch };
}

export { slugify, snake };
