import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  buildPlaywrightArgs,
  isPathInside,
  normalizeRunFile,
  parsePlaywrightReport,
  resolveInside,
  shouldIgnoreTreeName,
} from '../../lh-plugins/lh-uiauto.mjs';

describe('自动化测试：运行参数拼装', () => {
  it('默认只带三种 reporter', () => {
    assert.deepEqual(buildPlaywrightArgs(), ['test', '--reporter=list,json,html']);
  });

  it('文件 / grep / 项目 / headed / workers / lastFailed 全部追加', () => {
    assert.deepEqual(
      buildPlaywrightArgs({
        file: 'tests/login.spec.ts',
        grep: '登录成功',
        project: 'chromium-login',
        headed: true,
        workers: 4,
        lastFailed: true,
      }),
      [
        'test',
        '--reporter=list,json,html',
        'tests/login.spec.ts',
        '--grep',
        '登录成功',
        '--project=chromium-login',
        '--headed',
        '--workers=4',
        '--last-failed',
      ],
    );
  });

  it('workers=0 表示不传，空文件 / 空 grep 也不产生空参数', () => {
    assert.deepEqual(buildPlaywrightArgs({ file: '  ', grep: '', workers: 0 }), [
      'test',
      '--reporter=list,json,html',
    ]);
  });

  it('反斜杠路径统一成 POSIX', () => {
    assert.deepEqual(buildPlaywrightArgs({ file: 'tests\\login.spec.ts' }), [
      'test',
      '--reporter=list,json,html',
      'tests/login.spec.ts',
    ]);
  });
});

describe('自动化测试：Playwright JSON 结果解析', () => {
  it('统计通过 / 失败 / 跳过 / 不稳定，并收集失败用例与错误', () => {
    const summary = parsePlaywrightReport({
      config: { projects: [{ name: 'setup' }, { name: 'chromium-login' }, { name: '' }] },
      stats: { duration: 12345, expected: 3, unexpected: 1, skipped: 2, flaky: 1 },
      errors: [{ message: 'global setup failed' }],
      suites: [
        {
          title: 'login.spec.ts',
          file: 'tests/login.spec.ts',
          specs: [
            {
              title: '登录成功',
              ok: false,
              tests: [{ status: 'unexpected', results: [{ status: 'unexpected' }] }],
            },
            {
              title: '登录失败',
              ok: true,
              tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
            },
          ],
          suites: [
            {
              title: '子分组',
              file: 'tests/login.spec.ts',
              specs: [
                {
                  title: '超时用例',
                  tests: [{ status: 'timedOut', results: [{ status: 'timedOut' }] }],
                },
              ],
            },
          ],
        },
      ],
    });

    assert.equal(summary.total, 7);
    assert.equal(summary.passed, 3);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.flaky, 1);
    assert.equal(summary.durationMs, 12345);
    assert.deepEqual(summary.errors, ['global setup failed']);
    assert.deepEqual(summary.projectNames, ['setup', 'chromium-login']);
    assert.deepEqual(
      summary.failedTests.map((item: { title: string }) => item.title),
      ['login.spec.ts › 登录成功', 'login.spec.ts › 子分组 › 超时用例'],
    );
    assert.equal(summary.failedTests[0].file, 'tests/login.spec.ts');
  });

  it('空 / 非法输入返回全零', () => {
    for (const value of [null, undefined, 42, 'x', {}]) {
      assert.deepEqual(parsePlaywrightReport(value), {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        flaky: 0,
        durationMs: 0,
        errors: [],
        failedTests: [],
        projectNames: [],
      });
    }
  });
});

describe('自动化测试：路径守卫', () => {
  it('项目内相对路径正常解析', () => {
    assert.equal(resolveInside('/tmp/proj', 'tests/a.spec.ts'), '/tmp/proj/tests/a.spec.ts');
    assert.equal(resolveInside('/tmp/proj', ''), '/tmp/proj');
  });

  it('拒绝 ../、绝对路径与同名前缀目录', () => {
    assert.equal(resolveInside('/tmp/proj', '../secret.txt'), '');
    assert.equal(resolveInside('/tmp/proj', 'tests/../../secret.txt'), '');
    assert.equal(resolveInside('/tmp/proj', '/etc/passwd'), '');
    assert.equal(resolveInside('/tmp/proj', 'C:/Windows/win.ini'), '');
    assert.equal(resolveInside('/tmp/proj', 'a\0b'), '');
    assert.equal(isPathInside('/tmp/proj', '/tmp/proj-other/x'), false);
    assert.equal(isPathInside('/tmp/proj', '/tmp/proj'), true);
  });
});

describe('自动化测试：指定文件与目录忽略规则', () => {
  let tmp = '';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-uiauto-'));
    fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tests', 'login.spec.ts'), 'export {};\n');
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('存在的项目内文件返回相对路径', () => {
    assert.equal(normalizeRunFile(tmp, 'tests/login.spec.ts'), 'tests/login.spec.ts');
    assert.equal(normalizeRunFile(tmp, '.\\tests\\login.spec.ts'), 'tests/login.spec.ts');
  });

  it('越界或不存在的文件返回空', () => {
    assert.equal(normalizeRunFile(tmp, '../outside.spec.ts'), '');
    assert.equal(normalizeRunFile(tmp, 'tests/missing.spec.ts'), '');
    assert.equal(normalizeRunFile(tmp, '/etc/passwd'), '');
  });

  it('依赖 / 构建 / 测试输出目录一律忽略', () => {
    for (const name of [
      'node_modules',
      '.git',
      'test-results',
      'playwright-report',
      'blob-report',
      'dist',
      'coverage',
    ]) {
      assert.equal(shouldIgnoreTreeName(name), true, name);
    }
    for (const name of ['tests', 'src', 'playwright.config.ts']) {
      assert.equal(shouldIgnoreTreeName(name), false, name);
    }
  });
});
