/**
 * 多文件出码 / 批量写入的回归测试。
 *
 * 关注两件容易坏的事：
 * 1. spec 调用的方法必须真的在 page object 里定义（名字对不上等于生成废码）；
 * 2. 批量写入要么整组成功，要么一个都不写（预检冲突时不能留下半套文件）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  emitFiles,
  pageNameFor,
  splitPages,
} from '../../lh-plugins/uiauto-explorer/emit-files.mjs';
import { normalizeIr } from '../../lh-plugins/uiauto-explorer/ir.mjs';
import { writeGeneratedFiles } from '../../lh-plugins/uiauto-explorer/sessions.mjs';

const sample = {
  title: '登录后加购',
  baseURL: 'http://localhost:5173',
  storageState: 'auth-user.json',
  steps: [
    { action: 'goto', url: '/login' },
    { action: 'fill', locator: { kind: 'label', value: '用户名' }, value: '${LANTERN_USER}' },
    { action: 'fill', locator: { kind: 'label', value: '密码' }, value: 'secret' },
    { action: 'click', locator: { kind: 'role', role: 'button', name: 'Login' } },
    { action: 'expectUrl', url: '/products' },
    { action: 'goto', url: '/cart' },
    { action: 'click', locator: { kind: 'role', role: 'button', name: 'Add to cart' } },
    { action: 'expect', locator: { kind: 'text', value: 'Added' }, text: 'Added' },
  ],
};

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-uiauto-files-'));
}

describe('多文件出码', () => {
  it('按 URL 分段生成页面名', () => {
    assert.equal(pageNameFor('/login'), 'LoginPage');
    assert.equal(pageNameFor('/'), 'HomePage');
    assert.equal(pageNameFor('/cart/list?from=home'), 'CartListPage');
    assert.equal(pageNameFor('http://localhost:5173/products'), 'ProductsPage');
  });

  it('把元素操作分到对应页面的 page object', () => {
    const pages = splitPages(normalizeIr(sample));
    assert.deepEqual(
      pages.map((page) => page.name),
      ['LoginPage', 'CartPage'],
    );
    assert.equal(pages[0].methods.length, 3);
    assert.equal(pages[1].methods.length, 2);
  });

  it('TS 输出 spec + 两个页面对象 + 登录态 fixture', () => {
    const result = emitFiles(sample, 'ts', { testDir: 'tests' });
    const paths = result.files.map((file) => file.path);
    assert.deepEqual(paths, [
      'tests/ai-generated.spec.ts',
      'tests/pages/LoginPage.ts',
      'tests/pages/CartPage.ts',
      'tests/fixtures/auth-state.ts',
    ]);
    const spec = result.files.find((file) => file.role === 'spec')?.content ?? '';
    const loginPage =
      result.files.find((file) => file.path.endsWith('LoginPage.ts'))?.content ?? '';
    // spec 里调用的每个方法都必须在该 page object 里定义
    const calls = [...spec.matchAll(/loginPage\.(\w+)\(/g)].map((match) => match[1]);
    assert.ok(calls.length >= 3);
    for (const name of calls) {
      assert.match(loginPage, new RegExp(`async ${name}\\(`));
    }
    assert.match(spec, /new LoginPage\(page\)/);
    assert.match(spec, /storageState: STORAGE_STATE/);
    assert.match(spec, /await page\.goto\("\/login"\)/);
  });

  it('Python 输出 pytest + snake_case 页面对象', () => {
    const result = emitFiles(sample, 'python', { testDir: 'tests' });
    const paths = result.files.map((file) => file.path);
    assert.deepEqual(paths, [
      'tests/test_ai_generated.py',
      'tests/pages/login_page.py',
      'tests/pages/cart_page.py',
    ]);
    const spec = result.files[0].content;
    assert.match(spec, /from pages\.login_page import LoginPage/);
    assert.match(spec, /login_page\.fill_label\(os\.environ\.get\("LANTERN_USER", ""\)\)/);
  });

  it('项目没配 baseURL 时给 config 补丁建议，不直接改项目', () => {
    const result = emitFiles(sample, 'ts', { testDir: 'tests', hasBaseURL: false }) as {
      configPatch: { path: string; snippet: string } | null;
    };
    assert.equal(result.configPatch?.path, 'playwright.config.ts');
    assert.match(result.configPatch?.snippet ?? '', /baseURL/);
    const without = emitFiles(sample, 'ts', { testDir: 'tests', hasBaseURL: true }) as {
      configPatch: { path: string } | null;
    };
    assert.equal(without.configPatch, null);
  });
});

describe('批量写入', () => {
  it('一次写入多个文件并记录变更', () => {
    const dir = tempProject();
    const session = { changes: [] };
    const result = writeGeneratedFiles({
      project: { dir },
      session,
      files: [
        { path: 'tests/a.spec.ts', content: 'a', role: 'spec' },
        { path: 'tests/pages/A.ts', content: 'b', role: 'page' },
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.paths, ['tests/a.spec.ts', 'tests/pages/A.ts']);
    assert.equal(fs.readFileSync(path.join(dir, 'tests/pages/A.ts'), 'utf8'), 'b');
    assert.equal(result.changes.length, 2);
  });

  it('有冲突时整批不写', () => {
    const dir = tempProject();
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), 'old');
    const result = writeGeneratedFiles({
      project: { dir },
      session: { changes: [] },
      files: [
        { path: 'tests/a.spec.ts', content: 'new' },
        { path: 'tests/b.spec.ts', content: 'new' },
      ],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(
      (result.conflicts ?? []).map((item: { path: string }) => item.path),
      ['tests/a.spec.ts'],
    );
    assert.equal(fs.readFileSync(path.join(dir, 'tests/a.spec.ts'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(dir, 'tests/b.spec.ts')), false);
  });

  it('拒绝跳出项目目录的路径', () => {
    const dir = tempProject();
    const result = writeGeneratedFiles({
      project: { dir },
      files: [{ path: '../escape.ts', content: 'x' }],
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error ?? ''), /不合法|项目目录/);
  });
});

describe('写入已存在的文件：默认合并，不整文件覆盖', () => {
  const legacySpec = [
    '/**',
    ' * 老用例集（项目里原有的）',
    ' */',
    "import { test, expect } from '@playwright/test';",
    '',
    'test.describe("老用例", () => {',
    '  test("老用例", async ({ page }) => {',
    '    await page.goto("/");',
    '  });',
    '});',
    '',
  ].join('\n');

  it('spec 追加新用例并补齐 import，老的用例一行不少', () => {
    const dir = tempProject();
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    const specPath = path.join(dir, 'tests/ai-generated.spec.ts');
    fs.writeFileSync(specPath, legacySpec);

    const files = emitFiles(sample, 'ts', { testDir: 'tests' }).files;
    const spec = files.find((file) => file.role === 'spec');
    const result = writeGeneratedFiles({
      project: { dir },
      session: { changes: [] },
      files: [spec],
    });

    assert.equal(result.ok, true);
    const text = fs.readFileSync(specPath, 'utf8');
    // 原有内容保持完整
    assert.match(text, /test\("老用例"/);
    assert.match(text, /await page\.goto\("\/"\);/);
    // 新用例追加在后面
    assert.match(text, /test\("登录后加购"/);
    // 缺的 page object import 补进来了，且 test.use 被提到 import 之后
    assert.match(text, /import \{ LoginPage \} from '\.\/pages\/LoginPage';/);
    assert.ok(text.indexOf('test.use(') < text.indexOf('test.describe("老用例"'));
    assert.equal(result.summary?.merged, 1);
    // 变更账本只记追加，不再算整文件修改
    assert.equal(result.changes[0].kind, 'merge');
  });

  it('page object 只补缺失的方法，已有的方法不动', () => {
    const dir = tempProject();
    fs.mkdirSync(path.join(dir, 'tests/pages'), { recursive: true });
    const pagePath = path.join(dir, 'tests/pages/LoginPage.ts');
    const legacy = [
      "import { expect, type Page } from '@playwright/test';",
      '',
      'export class LoginPage {',
      '  constructor(private readonly page: Page) {}',
      '',
      '  async handWritten() {',
      '    await this.page.click("#hand");',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(pagePath, legacy);

    const page = emitFiles(sample, 'ts', { testDir: 'tests' }).files.find(
      (file) => file.role === 'page' && file.path.endsWith('LoginPage.ts'),
    );
    const result = writeGeneratedFiles({
      project: { dir },
      session: { changes: [] },
      files: [page],
    });

    assert.equal(result.ok, true);
    const text = fs.readFileSync(pagePath, 'utf8');
    assert.match(text, /async handWritten\(/);
    assert.match(text, /async fillLabel\(|async clickLogin\(/);
    // 类只能有一个
    assert.equal(text.match(/export class LoginPage/g)?.length, 1);
  });

  it('同一个用例写两次：第二次判定为无变化，文件不动', () => {
    const dir = tempProject();
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    const specPath = path.join(dir, 'tests/ai-generated.spec.ts');
    fs.writeFileSync(specPath, legacySpec);

    const spec = emitFiles(sample, 'ts', { testDir: 'tests' }).files.find(
      (file) => file.role === 'spec',
    );
    writeGeneratedFiles({ project: { dir }, session: { changes: [] }, files: [spec] });
    const first = fs.readFileSync(specPath, 'utf8');
    const again = writeGeneratedFiles({
      project: { dir },
      session: { changes: [] },
      files: [spec],
    });
    assert.equal(fs.readFileSync(specPath, 'utf8'), first);
    assert.equal(again.summary?.unchanged, 1);
    assert.equal(again.changes.length, 0);
  });

  it('勾选覆盖时仍然整文件替换', () => {
    const dir = tempProject();
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    const specPath = path.join(dir, 'tests/ai-generated.spec.ts');
    fs.writeFileSync(specPath, legacySpec);
    const spec = emitFiles(sample, 'ts', { testDir: 'tests' }).files.find(
      (file) => file.role === 'spec',
    );
    const result = writeGeneratedFiles({
      project: { dir },
      session: { changes: [] },
      files: [spec],
      force: true,
    });
    assert.equal(result.ok, true);
    const text = fs.readFileSync(specPath, 'utf8');
    assert.doesNotMatch(text, /老用例集/);
    assert.match(text, /test\("登录后加购"/);
  });
});
