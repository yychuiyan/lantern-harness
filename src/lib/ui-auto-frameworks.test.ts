import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildProbe, detectCandidates } from '../../lh-plugins/uiauto-adapters/index.mjs';
import * as pytestAdapter from '../../lh-plugins/uiauto-adapters/pytest.mjs';
import * as seleniumAdapter from '../../lh-plugins/uiauto-adapters/selenium.mjs';
import {
  emptySummary,
  parseJUnitXml,
  readSmall,
  text,
} from '../../lh-plugins/uiauto-adapters/shared.mjs';
import { snapshotReport } from '../../lh-plugins/uiauto-report.mjs';
import {
  projectPaths,
  sanitizeFolderName,
  uiautoStorePaths,
  uniqueFolder,
} from '../../lh-plugins/lh-uiauto.mjs';
import { describeRunArgs, displayRunCommand, frameworkKindLabel } from './ui-auto';

let tmp = '';

function makeProject(name: string, files: Record<string, string>, dirs: string[] = []): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-uiauto-frameworks-'));
});

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('自动化测试：框架识别', () => {
  it('Playwright：config 文件优先', () => {
    const dir = makeProject('playwright-proj', {
      'playwright.config.ts': 'export default {};\n',
      'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.0.0' } }),
    });
    const candidates = detectCandidates(buildProbe(dir));
    assert.equal(candidates[0].id, 'playwright');
    assert.equal(candidates[0].kind, 'ui');
    assert.ok(candidates[0].evidence.includes('playwright.config.ts'));
  });

  it('pytest：有 pytest 依赖与 test_*.py，识别为接口自动化', () => {
    const dir = makeProject('pytest-api', {
      'requirements.txt': 'pytest==8.0.0\nrequests==2.31.0\n',
      'tests/test_login.py': 'def test_ok():\n    assert True\n',
    });
    const candidates = detectCandidates(buildProbe(dir));
    assert.equal(candidates[0].id, 'pytest');
    assert.equal(candidates[0].kind, 'api');
    assert.ok(candidates[0].score >= 70);
  });

  it('pytest：selenium 依赖识别为 UI 自动化', () => {
    const dir = makeProject('pytest-ui', {
      'requirements.txt': 'pytest\nselenium\n',
      'pytest.ini': '[pytest]\n',
      'test_login.py': 'def test_ok():\n    assert True\n',
    });
    const candidates = detectCandidates(buildProbe(dir));
    assert.equal(candidates[0].id, 'pytest');
    assert.equal(candidates[0].kind, 'ui');
  });

  it('pytest：pyproject 里带行尾注释的依赖也能识别为接口自动化', () => {
    const dir = makeProject('pytest-pyproject', {
      'pyproject.toml': `[project]
name = "demo"
version = "1.0.0"
dependencies = [
    "requests>=2.32.0",           # HTTP 客户端
    "pytest>=8.3.0",              # 测试框架
    "pytest-html>=4.1.1",         # HTML 报告
]

[tool.pytest.ini_options]
minversion = "8.0"
`,
      'tests/test_api.py': 'def test_ok():\n    assert True\n',
    });
    const probe = buildProbe(dir);
    assert.equal(probe.pythonDeps.has('requests'), true);
    assert.equal(probe.pythonDeps.has('pytest-html'), true);
    assert.equal(detectCandidates(probe)[0].kind, 'api');
  });

  it('Selenium：Maven 项目比 pytest 更可信', () => {
    const dir = makeProject('selenium-maven', {
      'pom.xml':
        '<project><dependency><artifactId>selenium-java</artifactId></dependency></project>',
    });
    const candidates = detectCandidates(buildProbe(dir));
    assert.equal(candidates[0].id, 'selenium');
    assert.equal(candidates[0].kind, 'ui');
  });

  it('Selenium：Gradle 项目能识别', () => {
    const dir = makeProject('selenium-gradle', {
      'build.gradle':
        "dependencies { testImplementation 'org.seleniumhq.selenium:selenium-java:4.0.0' }\n",
    });
    const candidates = detectCandidates(buildProbe(dir));
    assert.equal(candidates[0].id, 'selenium');
  });

  it('Selenium：Node 的 selenium-webdriver 也能识别', () => {
    const dir = makeProject('selenium-node', {
      'package.json': JSON.stringify({ devDependencies: { 'selenium-webdriver': '^4.0.0' } }),
    });
    const candidates = detectCandidates(buildProbe(dir));
    assert.equal(candidates[0].id, 'selenium');
  });

  it('空目录识别不到任何框架', () => {
    const dir = makeProject('empty', {});
    assert.deepEqual(detectCandidates(buildProbe(dir)), []);
  });

  it('不存在的目录不报错', () => {
    assert.deepEqual(detectCandidates(buildProbe(path.join(tmp, 'missing'))), []);
    assert.equal(buildProbe(path.join(tmp, 'missing')).exists, false);
  });
});

describe('自动化测试：pytest / Selenium 运行命令', () => {
  it('pytest 带上 --junitxml、-k 与 -m', () => {
    const dir = makeProject('pytest-cmd', {
      'requirements.txt': 'pytest\nrequests\npytest-html\n',
      'tests/test_api.py': 'def test_ok():\n    assert True\n',
    });
    const resolved = pytestAdapter.resolve({
      dir,
      probe: buildProbe(dir),
      args: { file: 'tests/test_api.py', grep: 'login', marker: 'smoke' },
      runId: 'uar_x',
      resultAbs: '/tmp/result.xml',
      resultDirAbs: '/tmp',
      reportAbs: '/tmp/report',
      guardPath: '',
    });
    assert.ok(resolved.args.includes('-m'));
    assert.ok(resolved.args.includes('pytest'));
    assert.ok(resolved.args.includes('--junitxml=/tmp/result.xml'));
    assert.ok(resolved.args.includes('-k'));
    assert.ok(resolved.args.includes('login'));
    assert.ok(resolved.args.includes('tests/test_api.py'));
    assert.ok(resolved.args.includes('--html=/tmp/report/index.html'));
  });

  it('Selenium/Maven 把 surefire 结果写进空间目录，文件名转成类名', () => {
    const dir = makeProject('selenium-cmd', {
      'pom.xml': '<project><artifactId>selenium-java</artifactId></project>',
    });
    const resolved = seleniumAdapter.resolve({
      dir,
      probe: buildProbe(dir),
      args: { file: 'src/test/java/com/foo/LoginTest.java', grep: 'shouldLogin' },
      runId: 'uar_x',
      resultAbs: '/tmp/result.xml',
      resultDirAbs: '/tmp/results',
      reportAbs: '/tmp/report',
      guardPath: '',
    });
    assert.ok(resolved.args.includes('-Dsurefire.reportsDirectory=/tmp/results/uar_x-surefire'));
    assert.ok(resolved.args.includes('-Dtest=LoginTest#shouldLogin'));
  });

  it('Selenium/Gradle 用 --tests 过滤', () => {
    const dir = makeProject('selenium-gradle-cmd', {
      'build.gradle': "dependencies { testImplementation 'selenium-java' }\n",
    });
    const resolved = seleniumAdapter.resolve({
      dir,
      probe: buildProbe(dir),
      args: { file: 'src/test/java/com/foo/LoginTest.java', grep: '' },
      runId: 'uar_x',
      resultAbs: '/tmp/result.xml',
      resultDirAbs: '/tmp/results',
      reportAbs: '/tmp/report',
      guardPath: '',
    });
    assert.ok(resolved.args.includes('test'));
    assert.ok(resolved.args.includes('--tests'));
    assert.ok(resolved.args.includes('LoginTest'));
  });
});

describe('自动化测试：JUnit XML 解析', () => {
  it('统计通过 / 失败 / 跳过并收集失败用例', () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="pytest" tests="3">
    <testcase classname="tests.test_api" name="test_ok" time="0.12" />
    <testcase classname="tests.test_api" name="test_bad" time="0.30">
      <failure message="assert 1 == 2">AssertionError</failure>
    </testcase>
    <testcase classname="tests.test_api" name="test_skip" time="0">
      <skipped message="no env" />
    </testcase>
  </testsuite>
</testsuites>`;
    const summary = parseJUnitXml(xml);
    assert.equal(summary.total, 3);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.durationMs, 420);
    assert.deepEqual(
      summary.failedTests.map((item: { title: string }) => item.title),
      ['tests.test_api › test_bad'],
    );
  });

  it('自闭合 testcase 也计数；空 XML 返回全零', () => {
    const summary = parseJUnitXml('<testsuite><testcase name="a" time="1"/></testsuite>');
    assert.equal(summary.total, 1);
    assert.equal(summary.passed, 1);
    assert.deepEqual(parseJUnitXml(''), emptySummary());
  });
});

describe('自动化测试：空间存储目录', () => {
  it('默认目录名是 自动化测试，并按项目名分目录', () => {
    const root = path.join(tmp, 'space-paths');
    fs.mkdirSync(root, { recursive: true });
    const paths = uiautoStorePaths(root);
    assert.equal(path.basename(paths.dir), '自动化测试');
    assert.equal(path.basename(paths.store), '自动化测试.json');

    const project = { id: 'uia_1', name: '电商后台 / Web', folder: '', dir: '/tmp/proj' };
    const pp = projectPaths(root, project);
    assert.equal(path.basename(pp.dir), '电商后台 Web');
    assert.equal(pp.reportDir, path.join(pp.dir, '报告'));
    assert.equal(pp.resultDir, path.join(pp.dir, '结果'));
    assert.equal(pp.logDir, path.join(pp.dir, '日志'));
  });

  it('项目名里的非法字符被清掉，空名回退成「项目」', () => {
    assert.equal(sanitizeFolderName('a/b:c*d?'), 'a b c d');
    assert.equal(sanitizeFolderName('..'), '项目');
    assert.equal(sanitizeFolderName(''), '项目');
    assert.equal(sanitizeFolderName('.hidden'), 'hidden');
  });

  it('同名项目自动加后缀，避免写进同一个目录', () => {
    const store = { projects: [{ folder: 'demo' }] };
    assert.equal(uniqueFolder(store, 'demo', 'uia_abcdef'), 'demo-abcdef');
    assert.equal(uniqueFolder({ projects: [] }, 'demo', 'uia_abcdef'), 'demo');
  });

  it('旧版 UI自动化 目录会自动改名迁移，数据不丢', () => {
    const root = path.join(tmp, 'space-legacy');
    fs.mkdirSync(path.join(root, 'UI自动化'), { recursive: true });
    fs.writeFileSync(path.join(root, 'UI自动化', 'UI自动化.json'), '{"projects":[],"runs":[]}');
    const paths = uiautoStorePaths(root);
    assert.equal(path.basename(paths.dir), '自动化测试');
    assert.equal(fs.existsSync(path.join(root, 'UI自动化')), false);
    assert.equal(fs.existsSync(path.join(root, '自动化测试', '自动化测试.json')), true);
  });
});

describe('自动化测试：报告快照', () => {
  it('复制最新的 index.html 到空间目录，跳过大视频', () => {
    const project = makeProject(
      'report-proj',
      {
        'playwright-report/index.html': '<html>report</html>',
        'playwright-report/data.json': '{}',
        'playwright-report/video.webm': 'x',
      },
      ['playwright-report'],
    );
    const dest = path.join(tmp, 'snapshot-out');
    const result = snapshotReport({
      projectDir: project,
      candidates: ['playwright-report'],
      destAbs: dest,
    });
    assert.ok(result.files >= 2);
    assert.ok(fs.existsSync(path.join(dest, 'index.html')));
    assert.equal(fs.existsSync(path.join(dest, 'video.webm')), false);
  });

  it('没有报告时不创建入口页', () => {
    const project = makeProject('no-report', { 'readme.md': '# x' });
    const dest = path.join(tmp, 'snapshot-empty');
    const result = snapshotReport({
      projectDir: project,
      candidates: ['playwright-report'],
      destAbs: dest,
    });
    assert.equal(result.files, 0);
    assert.equal(fs.existsSync(path.join(dest, 'index.html')), false);
  });

  it('minMtime 排除上一次运行留下的旧报告', () => {
    const project = makeProject('stale-report', {
      'playwright-report/index.html': '<html>old</html>',
    });
    const dest = path.join(tmp, 'snapshot-stale');
    const result = snapshotReport({
      projectDir: project,
      candidates: ['playwright-report'],
      destAbs: dest,
      minMtime: Date.now() + 10_000,
    });
    assert.equal(result.files, 0);
  });

  it('候选目录不允许跑到项目外', () => {
    const project = makeProject('escape-report', { 'readme.md': '# x' });
    const outside = makeProject('outside-report', { 'index.html': '<html>secret</html>' });
    const dest = path.join(tmp, 'snapshot-escape');
    const result = snapshotReport({
      projectDir: project,
      candidates: [path.relative(project, outside)],
      destAbs: dest,
    });
    assert.equal(result.files, 0);
  });
});

describe('自动化测试：参数摘要与文案', () => {
  const args = {
    file: 'tests/test_api.py',
    grep: 'login',
    project: '',
    headed: false,
    workers: 0,
    lastFailed: false,
    marker: 'smoke',
    maxFail: 3,
  };

  it('pytest 用 -k / -m / --maxfail 展示', () => {
    assert.equal(
      describeRunArgs(args, 'pytest'),
      'tests/test_api.py · -k login · -m smoke · --maxfail=3',
    );
  });

  it('Selenium 只展示文件与筛选词', () => {
    assert.equal(describeRunArgs(args, 'selenium'), 'tests/test_api.py · login');
  });

  it('运行命令去掉可执行文件的绝对路径', () => {
    assert.equal(
      displayRunCommand('/Volumes/yycy/GitHub/x/node_modules/.bin/playwright test --headed'),
      'playwright test --headed',
    );
    assert.equal(
      displayRunCommand('/Volumes/yycy/GitHub/x/.venv/bin/python -m pytest -q'),
      'python -m pytest -q',
    );
    // 带空格的目录被引号包住时也要剥掉整段路径
    assert.equal(
      displayRunCommand('"/Volumes/my dir/a/node_modules/.bin/playwright" test'),
      'playwright test',
    );
    // 本身就是全局命令：原样展示
    assert.equal(
      displayRunCommand('npx --no-install playwright test'),
      'npx --no-install playwright test',
    );
    assert.equal(displayRunCommand(''), '');
  });

  it('Playwright 保持原有摘要', () => {
    assert.equal(describeRunArgs(args, 'playwright'), 'tests/test_api.py · grep: login');
  });

  it('框架类型文案', () => {
    assert.equal(frameworkKindLabel('api'), '接口');
    assert.equal(frameworkKindLabel('ui'), 'UI');
    assert.equal(frameworkKindLabel(''), '');
  });

  it('readSmall / text 的边界', () => {
    const file = path.join(tmp, 'small.txt');
    fs.writeFileSync(file, 'abc');
    assert.equal(readSmall(file), 'abc');
    assert.equal(readSmall(path.join(tmp, 'nope.txt')), '');
    assert.equal(text('  hi  ', 10), 'hi');
    assert.equal(text('abcdef', 3), 'abc');
    assert.equal(text(null, 3), '');
  });
});
