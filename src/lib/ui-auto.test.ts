import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  browserMirrorRetryEnv,
  buildPlaywrightArgs,
  GENERATION_VERSION,
  isBrowserDownloadNetworkError,
  isPathInside,
  normalizeGenerationRecord,
  normalizeRunFile,
  parsePlaywrightReport,
  PLAYWRIGHT_MIRROR_HOST,
  resolveInside,
  setupPlanFor,
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

describe('自动化测试：一键安装的步骤', () => {
  it('没声明包管理器时优先 pnpm，本机没装 pnpm 才用 npm', () => {
    const withPnpm = setupPlanFor(
      { framework: 'playwright', dir: '/p/a' },
      { hasPnpm: () => true, hasYarn: () => false },
    );
    assert.equal(withPnpm.error, '');
    assert.equal(withPnpm.packageManager, 'pnpm');
    assert.deepEqual(
      withPnpm.steps.map((step) => step.command),
      ['pnpm install', 'pnpm exec playwright install chromium'],
    );
    assert.ok(withPnpm.steps.every((step) => step.cwd === '/p/a'));

    const withoutPnpm = setupPlanFor(
      { framework: 'playwright', dir: '/p/a' },
      { hasPnpm: () => false, hasYarn: () => false },
    );
    assert.equal(withoutPnpm.packageManager, 'npm');
    assert.deepEqual(
      withoutPnpm.steps.map((step) => step.command),
      ['npm install', 'npx playwright install chromium'],
    );
  });

  it('跟着项目声明的包管理器换命令', () => {
    assert.deepEqual(
      setupPlanFor(
        { framework: 'playwright', packageManager: 'pnpm' },
        { hasPnpm: () => true },
      ).steps.map((step) => step.command),
      ['pnpm install', 'pnpm exec playwright install chromium'],
    );
    assert.deepEqual(
      setupPlanFor(
        { framework: 'playwright', packageManager: 'yarn' },
        { hasPnpm: () => true, hasYarn: () => true },
      ).steps.map((step) => step.command),
      ['yarn install', 'yarn playwright install chromium'],
    );
    assert.deepEqual(
      setupPlanFor(
        { framework: 'playwright', packageManager: 'npm' },
        { hasPnpm: () => true },
      ).steps.map((step) => step.command),
      ['npm install', 'npx playwright install chromium'],
    );
  });

  it('声明了 pnpm 但本机没装时退回 npm，并说明原因', () => {
    const plan = setupPlanFor(
      { framework: 'playwright', packageManager: 'pnpm' },
      { hasPnpm: () => false },
    );
    assert.equal(plan.packageManager, 'npm');
    assert.deepEqual(
      plan.steps.map((step) => step.command),
      ['npm install', 'npx playwright install chromium'],
    );
    assert.match(plan.note, /没有 pnpm/);
  });

  it('不认识的技术栈不提供一键安装', () => {
    const plan = setupPlanFor({ framework: 'pytest', packageManager: 'npm' });
    assert.deepEqual(plan.steps, []);
    assert.ok(plan.error);
  });
});

describe('自动化测试：内核下载失败的镜像回退', () => {
  const browserStep = { id: 'browser', label: '安装浏览器内核' };

  it('只有「安装浏览器内核」这一步才回退', () => {
    assert.deepEqual(browserMirrorRetryEnv({ id: 'deps' }, false, {}), {});
    assert.deepEqual(browserMirrorRetryEnv(null, false, {}), {});
    assert.deepEqual(browserMirrorRetryEnv(browserStep, false, {}), {
      PLAYWRIGHT_DOWNLOAD_HOST: PLAYWRIGHT_MIRROR_HOST,
    });
  });

  it('每步只重试一次：重试过就不再给镜像', () => {
    assert.deepEqual(browserMirrorRetryEnv(browserStep, true, {}), {});
  });

  it('用户自己设了下载源就不覆盖', () => {
    assert.deepEqual(
      browserMirrorRetryEnv(browserStep, false, { PLAYWRIGHT_DOWNLOAD_HOST: 'https://my.host' }),
      {},
    );
    assert.deepEqual(
      browserMirrorRetryEnv(browserStep, false, { PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: 'https://x' }),
      {},
    );
  });

  it('只把网络类错误认作需要换镜像', () => {
    assert.equal(
      isBrowserDownloadNetworkError(
        "Error: Client network socket disconnected before secure TLS connection was established\ncode: 'ECONNRESET'",
      ),
      true,
    );
    assert.equal(isBrowserDownloadNetworkError('Error: Download failure, code=1'), true);
    assert.equal(isBrowserDownloadNetworkError('fetch failed'), true);
    // 不是网络问题的失败不该再重试一遍（白等一轮）
    assert.equal(
      isBrowserDownloadNetworkError('ERROR: Playwright does not support chromium on x'),
      false,
    );
    assert.equal(isBrowserDownloadNetworkError('ENOSPC: no space left on device'), false);
    assert.equal(isBrowserDownloadNetworkError(''), false);
  });
});

describe('自动化测试：生成过程留档清洗', () => {
  it('补齐默认值并保留检查 / 建议 / 文件清单', () => {
    const record = normalizeGenerationRecord({
      stack: 'playwright',
      name: 'demo',
      dir: '/p/demo',
      files: [{ path: 'package.json', bytes: 12 }],
      totalBytes: 12,
      logs: [{ seq: 1, at: 100, stage: 'skeleton', level: 'info', text: '读骨架' }],
      findings: [
        {
          id: 'm1',
          level: 'warn',
          title: '缺 README',
          detail: '补一份',
          source: 'model',
          patches: [{ action: 'addFile', path: 'README.md', content: 'hi' }],
        },
      ],
      applied: ['m1'],
      promptReady: true,
      ok: true,
    });
    assert.equal(record?.version, GENERATION_VERSION);
    assert.equal(record?.findings[0].patches[0].path, 'README.md');
    // 只存补丁体积，不存整份文件内容
    assert.equal(record?.findings[0].patches[0].bytes, 2);
    assert.equal('content' in (record?.findings[0].patches[0] ?? {}), false);
    assert.deepEqual(record?.applied, ['m1']);
  });

  it('非法输入返回 null', () => {
    assert.equal(normalizeGenerationRecord(null), null);
    assert.equal(normalizeGenerationRecord('nope'), null);
  });

  it('超长日志与文件清单按上限截断', () => {
    const record = normalizeGenerationRecord({
      logs: Array.from({ length: 2500 }, (_, index) => ({
        seq: index,
        at: index,
        stage: 'ai',
        level: 'info',
        text: 'x'.repeat(5000),
      })),
      files: Array.from({ length: 6000 }, (_, index) => ({ path: `f${index}.ts`, bytes: 1 })),
      findings: Array.from({ length: 600 }, (_, index) => ({
        id: `f${index}`,
        level: 'warn',
        title: `问题 ${index}`,
        detail: '',
        source: 'model',
        patches: [],
      })),
      raw: 'y'.repeat(500 * 1024),
    });
    assert.equal(record?.logs.length, 2000);
    assert.equal(record?.logs[0].text.length, 4000);
    assert.equal(record?.files.length, 5000);
    assert.equal(record?.findings.length, 500);
    assert.equal(record?.raw.length, 200 * 1024);
  });

  it('未知来源的建议按平台处理', () => {
    const record = normalizeGenerationRecord({
      findings: [{ id: 'x', level: 'bogus', title: 't', source: 'other' }],
    });
    assert.equal(record?.findings[0].level, 'info');
    assert.equal(record?.findings[0].source, 'platform');
  });
});
