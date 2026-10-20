/**
 * IR → Playwright Test（TypeScript）
 */
import { pythonFunctionName, slugify, splitEnvValue } from './ir.mjs';

const q = (value) => JSON.stringify(String(value ?? ''));

function locatorCode(spec, owner = 'page') {
  const base = (() => {
    if (spec.kind === 'testid') return `${owner}.getByTestId(${q(spec.value)})`;
    if (spec.kind === 'role') {
      if (!spec.name) return `${owner}.getByRole(${q(spec.role)})`;
      const exact = spec.exact ? ', exact: true' : '';
      return `${owner}.getByRole(${q(spec.role)}, { name: ${q(spec.name)}${exact} })`;
    }
    if (spec.kind === 'label') {
      return `${owner}.getByLabel(${q(spec.value)}${spec.exact ? ', { exact: true }' : ''})`;
    }
    if (spec.kind === 'placeholder') {
      return `${owner}.getByPlaceholder(${q(spec.value)}${spec.exact ? ', { exact: true }' : ''})`;
    }
    if (spec.kind === 'text') {
      return `${owner}.getByText(${q(spec.value)}${spec.exact ? ', { exact: true }' : ''})`;
    }
    if (spec.kind === 'attr') {
      const body = `[${spec.attr}="${String(spec.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
      return `${owner}.locator(${q(body)})`;
    }
    return `${owner}.locator(${q(spec.value)})`;
  })();
  if (spec.nth == null) return base;
  return spec.nth === 0 ? `${base}.first()` : `${base}.nth(${spec.nth})`;
}

function valueCode(value) {
  const env = splitEnvValue(value);
  if (env) return `process.env.${env} ?? ''`;
  return q(value ?? '');
}

function stepCode(step, index) {
  const target = step.locator ? locatorCode(step.locator) : '';
  switch (step.action) {
    case 'goto':
      return `    await page.goto(${q(step.url ?? '/')});`;
    case 'click':
      return `    await ${target}.click();`;
    case 'fill':
      return `    await ${target}.fill(${valueCode(step.value)});`;
    case 'select':
      return `    await ${target}.selectOption(${valueCode(step.value)});`;
    case 'press':
      return step.locator
        ? `    await ${target}.press(${q(step.key ?? 'Enter')});`
        : `    await page.keyboard.press(${q(step.key ?? 'Enter')});`;
    case 'hover':
      return `    await ${target}.hover();`;
    case 'expect': {
      if (step.text) return `    await expect(${target}).toContainText(${valueCode(step.text)});`;
      if (step.state === 'hidden') return `    await expect(${target}).toBeHidden();`;
      return `    await expect(${target}).toBeVisible();`;
    }
    case 'expectUrl':
      return `    await expect(page).toHaveURL(${valueCode(step.url ?? '/')});`;
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
    default:
      return '';
  }
}

/** 生成 TS 脚本；`ir` 需先过 normalizeIr */
export function renderTs(ir) {
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
  lines.push('');
  const useOptions = [];
  if (ir.baseURL) useOptions.push(`baseURL: ${q(ir.baseURL)}`);
  // 探索时复用了登录态，生成的脚本也要带上，否则写回项目后第一步就卡登录
  if (ir.storageState) useOptions.push(`storageState: ${q(ir.storageState)}`);
  if (useOptions.length) {
    // 不依赖项目 config 有没有配：写死到本文件，换环境改这一行即可
    lines.push(`test.use({ ${useOptions.join(', ')} });`);
    lines.push('');
  }
  lines.push(`test.describe(${q(title)}, () => {`);
  lines.push(`  test(${q(title)}, async ({ page }) => {`);
  if (ir.baseURL) lines.push(`    // baseURL: ${ir.baseURL}`);
  for (let index = 0; index < ir.steps.length; index += 1) {
    const step = ir.steps[index];
    if (step.note) lines.push(`    // ${step.note.replace(/\s+/g, ' ').slice(0, 160)}`);
    const code = stepCode(step, index);
    if (code) lines.push(code);
  }
  lines.push('  });');
  lines.push('});');
  lines.push('');
  return { code: lines.join('\n'), filename: `${slugify(title)}.spec.ts`, language: 'ts' };
}

export { pythonFunctionName, locatorCode, valueCode };
