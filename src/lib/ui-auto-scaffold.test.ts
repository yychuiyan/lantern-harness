import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  detectProject,
  detectScaffoldOptions,
  assertScaffoldTarget,
  existingScaffoldBaseURL,
  planScaffoldUpdate,
  writeScaffoldFiles,
  writeScaffoldUpdate,
} from '../../lh-plugins/lh-uiauto.mjs';
import {
  findStack,
  listStacks,
  normalizeBaseURL,
  normalizeOptions,
  normalizeProjectName,
  parseSkeleton,
  renderFromSkeleton,
  renderScaffold,
} from '../../lh-plugins/uiauto-scaffold/index.mjs';
import {
  ensureSkeletonSeed,
  loadSkeleton,
  skeletonFile,
} from '../../lh-plugins/uiauto-scaffold/library.mjs';
import { builtinSkeletonText } from '../../lh-plugins/uiauto-scaffold/templates/playwright-ts.mjs';

let tmp = '';

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-scaffold-'));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFiles(dir: string, files: Array<{ path: string; content: string }>) {
  for (const file of files) {
    const abs = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.content, 'utf8');
  }
}

function tmpDir(name: string) {
  return fs.mkdtempSync(path.join(tmp, `${name}-`));
}

/** 与 library.mjs 的账本指纹同一算法（用来模拟「这份文件是上次种子写的」） */
function digest(text: string) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/** 一个最小可渲染骨架，用来单独验证模板语法 */
function miniSkeleton(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    id: 'mini',
    stack: 'playwright',
    label: 'Mini',
    kind: 'ui',
    language: 'ts',
    status: 'ready',
    hint: '',
    promptFile: 'Mini提示词.md',
    options: [
      { id: 'ci', label: 'CI', hint: '' },
      { id: 'lint', label: 'Lint', hint: '' },
    ],
    defaultOptions: ['ci'],
    files: [
      { path: 'a.txt', content: 'name={{projectName}} pkg={{packageName}} url={{baseURL}}' },
      { path: 'b.txt', content: 'x{{#if ci}}-ci{{/if}}{{#unless lint}}-nolint{{/unless}}' },
      { path: 'c.txt', content: 'ci-file', when: 'ci' },
      { path: 'd.txt', content: 'no-ci', when: '!ci' },
    ],
    ...overrides,
  };
}

describe('脚手架技术栈注册表', () => {
  it('首期只有 Playwright 可用，其余标为 planned', () => {
    const stacks = listStacks();
    const ready = stacks.filter((stack) => stack.status === 'ready').map((stack) => stack.id);
    assert.deepEqual(ready, ['playwright']);
    assert.equal(findStack('pytest')?.status, 'planned');
    assert.equal(findStack('nope'), null);
  });

  it('选项按注册表顺序返回，未知选项被丢掉', () => {
    const stack = findStack('playwright')!;
    assert.deepEqual(normalizeOptions(stack, ['lint', 'unknown', 'ci']), ['ci', 'lint']);
    assert.deepEqual(normalizeOptions(stack, undefined), []);
  });

  it('注册表里的选项与内置骨架一致（改一处忘了另一处会被这里挡住）', () => {
    const stack = findStack('playwright')!;
    const { skeleton } = loadSkeleton(tmpDir('space'), 'playwright-ts');
    assert.deepEqual(
      stack.options.map((option) => option.id),
      (skeleton.options as Array<{ id: string }>).map((option) => option.id),
    );
    assert.equal(stack.skeleton, 'playwright-ts');
    assert.equal(stack.promptFile, skeleton.promptFile);
  });
});

describe('脚手架输入校验', () => {
  it('项目名去掉路径分隔符并拒绝非法字符', () => {
    assert.equal(normalizeProjectName('web e2e'), 'web e2e');
    assert.equal(normalizeProjectName('web/e2e'), 'web e2e');
    assert.throws(() => normalizeProjectName(''), /项目名/);
    assert.throws(() => normalizeProjectName('....'), /项目名/);
  });

  it('被测地址必须是 http(s)，并去掉结尾斜杠', () => {
    assert.equal(normalizeBaseURL('https://a.example.com//'), 'https://a.example.com');
    assert.equal(normalizeBaseURL(''), '');
    assert.throws(() => normalizeBaseURL('a.example.com'), /http/);
  });

  it('未落地的技术栈直接报错，不产出半套文件', () => {
    assert.throws(() => renderScaffold({ stack: 'pytest', name: 'demo' }), /规划中/);
    assert.throws(() => renderScaffold({ stack: 'nope', name: 'demo' }), /不支持的技术栈/);
  });
});

describe('Playwright 企业级骨架', () => {
  const base = { stack: 'playwright', name: 'web-e2e', options: ['ci', 'lint', 'authState'] };

  it('必备文件齐全且路径都是相对路径', () => {
    const { files } = renderScaffold(base);
    const paths = files.map((file) => file.path);
    for (const required of [
      'package.json',
      'playwright.config.ts',
      'tsconfig.json',
      '.env.example',
      '.env',
      '.env.prod',
      '.gitignore',
      'README.md',
      // 根级布局：页面对象 / 工具 / fixture 不在 tests 里
      'pages/BasePage.ts',
      'pages/LoginPage.ts',
      'utils/config.ts',
      'utils/env-loader.ts',
      'utils/api-auth.ts',
      'utils/logger.ts',
      'utils/data-generator.ts',
      'fixtures/test.ts',
      // 用例按分级目录放；默认只有一条框架自检
      'tests/smoke/framework.spec.ts',
      'tests/regression/.gitkeep',
      'tests/edge/.gitkeep',
      'tests/iteration/.gitkeep',
      'tests/auth.setup.ts',
      '.github/workflows/playwright.yml',
      '.github/workflows/regression.yml',
      'eslint.config.mjs',
      '.prettierrc',
      '.prettierignore',
    ]) {
      assert.ok(paths.includes(required), `缺少 ${required}`);
    }
    // 死数据：账号只能走环境变量，不生成空密码的 json
    assert.ok(!paths.includes('data/test-users.json'));
    // 只保留三个环境位置：模板 example + 共用 .env + prod，不再生成 test 相关文件
    for (const gone of ['.env.test', '.env.test.example', '.env.prod.example']) {
      assert.ok(!paths.includes(gone), `不应再生成 ${gone}`);
    }
    for (const file of paths) {
      assert.ok(!path.isAbsolute(file), `不应是绝对路径：${file}`);
      assert.ok(!file.includes('..'), `不应包含 ..：${file}`);
    }
  });

  it('默认选项就是向导里那三个，且能生成 30 个文件', () => {
    const stack = findStack('playwright')!;
    const { files, options } = renderScaffold({ ...base, options: stack.defaultOptions });
    assert.deepEqual(options, ['authState', 'ci', 'lint']);
    assert.equal(files.length, 30);
    // 默认只带一条框架自检：不要再冒出示例业务用例（会变 skip / 噪音）
    assert.deepEqual(
      files.filter((file) => file.path.endsWith('.spec.ts')).map((file) => file.path),
      ['tests/smoke/framework.spec.ts'],
    );
  });

  it('七个选项全开时可选件都出现，且 package.json 仍是合法 JSON', () => {
    const { files } = renderScaffold({
      ...base,
      options: ['authState', 'ci', 'lint', 'husky', 'allure', 'docker', 'webServer'],
    });
    const paths = files.map((file) => file.path);
    for (const required of [
      'commitlint.config.mjs',
      '.husky/pre-commit',
      '.husky/pre-push',
      '.husky/commit-msg',
      'Dockerfile',
      '.dockerignore',
      'Jenkinsfile',
    ]) {
      assert.ok(paths.includes(required), `缺少 ${required}`);
    }
    assert.equal(files.length, 37);
    const pkg = JSON.parse(files.find((file) => file.path === 'package.json')!.content) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      'lint-staged'?: Record<string, string[]>;
    };
    assert.ok(pkg.scripts['report:allure']);
    assert.ok(pkg.scripts.prepare);
    assert.ok(pkg.devDependencies.husky);
    assert.ok(pkg.devDependencies['allure-playwright']);
    assert.ok(pkg['lint-staged']);
  });

  it('不勾选附带内容时不生成可选文件，但核心文件还在', () => {
    const { files } = renderScaffold({ stack: 'playwright', name: 'web-e2e', options: [] });
    const paths = files.map((file) => file.path);
    assert.ok(!paths.includes('tests/auth.setup.ts'));
    assert.ok(!paths.includes('.github/workflows/playwright.yml'));
    assert.ok(!paths.includes('eslint.config.mjs'));
    assert.ok(!paths.includes('Dockerfile'));
    assert.ok(paths.includes('tests/smoke/framework.spec.ts'));
    assert.ok(paths.includes('pages/BasePage.ts'));
    // 没勾 lint 时 lint-staged 也不能残留（否则 husky 会调不存在的 prettier）
    const pkg = JSON.parse(files.find((file) => file.path === 'package.json')!.content) as Record<
      string,
      unknown
    >;
    assert.equal(pkg['lint-staged'], undefined);
  });

  it('配置：环境变量取地址、报告落 reports/、不按文件名切 testMatch', () => {
    const { files } = renderScaffold(base);
    const config = files.find((file) => file.path === 'playwright.config.ts')!.content;
    assert.match(config, /process\.env\.BASE_URL/);
    assert.match(config, /testDir: '\.\/tests'/);
    assert.match(config, /testMatch: '\*\*\/\*\.spec\.ts'/);
    assert.match(config, /outputFolder: 'reports\/playwright-report'/);
    assert.doesNotMatch(config, /open: 'always'/);
    // 只留一个 chromium project，避免平台写进 tests/ 根目录的用例被静默跳过
    assert.equal(config.match(/name: 'chromium'/g)?.length, 1);
  });

  it('框架自检只在没有业务用例时跑，且能被 check:framework 强制拉起', () => {
    const { files } = renderScaffold(base);
    const config = files.find((file) => file.path === 'playwright.config.ts')!.content;
    assert.match(config, /testIgnore: frameworkCheck \? \[\] : \['\*\*\/framework\.spec\.ts'\]/);
    assert.match(config, /process\.env\.FORCE_FRAMEWORK_CHECK === '1'/);
    assert.match(config, /const hasBusinessSpecs = listSpecs/);
    // 扫描时跳过自检自己，否则「有没有业务用例」永远为真
    assert.match(config, /\(file\) => file !== SELF_CHECK/);

    const pkg = JSON.parse(files.find((file) => file.path === 'package.json')!.content) as {
      scripts: Record<string, string>;
    };
    assert.match(
      pkg.scripts['check:framework'],
      /FORCE_FRAMEWORK_CHECK=1 playwright test tests\/smoke\/framework\.spec\.ts/,
    );
  });

  it('没配账号时不挂 setup，避免两条空跑 skip', () => {
    const { files } = renderScaffold(base);
    const config = files.find((file) => file.path === 'playwright.config.ts')!.content;
    assert.match(config, /const authReady = adminReady \|\| userReady/);
    assert.match(
      config,
      /authReady \? \[\{ name: 'setup', testMatch: \/\.\*\\\.setup\\\.ts\/ \}\] : \[\]/,
    );
    assert.match(
      config,
      /authReady \? \{ dependencies: \['setup'\], grepInvert: \/@user\/ \} : \{\}/,
    );
  });

  it('webServer 只在勾选时出现，命令与 URL 都不写死', () => {
    const off = renderScaffold(base).files.find((file) => file.path === 'playwright.config.ts')!;
    assert.doesNotMatch(off.content, /webServer:/);
    assert.doesNotMatch(off.content, /webServerCommand/);
    const files = renderScaffold({ ...base, options: [...base.options, 'webServer'] }).files;
    const on = files.find((file) => file.path === 'playwright.config.ts')!;
    assert.match(on.content, /webServer: \{/);
    // 测试项目自己没有 dev 脚本：写死 `npm run dev` 只会变成 exited early
    assert.doesNotMatch(on.content, /'npm run dev'/);
    // 没配就不挂 webServer（被测系统手工起着是常态，不该让整套用例跑不起来）
    assert.match(on.content, /process\.env\.CI \|\| !webServerCommand/);
    // 被测系统多为远端服务：只有探活地址落在本机、且没配命令时才提示，避免每次跑都刷一行噪音
    assert.match(on.content, /if \(!webServerCommand && isLocalUrl\(webServerUrl\)\)/);
    assert.doesNotMatch(on.content, /没配 WEB_SERVER_COMMAND，跳过本地自启动/);
    // 探活地址与 BASE_URL 解耦：BASE_URL 指远端时不能拿它当探活目标
    assert.match(on.content, /process\.env\.WEB_SERVER_URL \|\|/);
    assert.match(on.content, /url: webServerUrl/);
    // 文档跟着给：两个变量都要能在 .env 里看见
    const env = files.find((file) => file.path === '.env')!.content;
    assert.match(env, /WEB_SERVER_COMMAND/);
    const example = files.find((file) => file.path === '.env.example')!.content;
    assert.match(example, /WEB_SERVER_URL/);
  });

  it('prod 不会被静默打到本机：env-loader 硬拒缺 BASE_URL / 回环地址', () => {
    const { files } = renderScaffold(base);
    const loader = files.find((file) => file.path === 'utils/env-loader.ts')!.content;
    assert.match(loader, /ENV_NAME === 'prod'/);
    assert.match(loader, /必须显式设置 BASE_URL/);
    assert.match(loader, /LOOPBACK/);
    // 模板里也要给一行注释，避免用户以为会从 .env 自动继承
    const prodEnv = files.find((file) => file.path === '.env.prod')!.content;
    assert.match(prodEnv, /# BASE_URL=/);
    // 兜底地址与 playwright 的 baseURL 一致，不再两处各写一个
    const cfg = files.find((file) => file.path === 'utils/config.ts')!.content;
    assert.match(cfg, /readEnv\('BASE_URL', 'http:\/\/127\.0\.0\.1:3000'\)/);
  });

  it('登录态真正挂到 project 上：admin 是默认身份，@user 交给 chromium-user', () => {
    const config = renderScaffold(base).files.find(
      (file) => file.path === 'playwright.config.ts',
    )!.content;
    // 只生成 storageState 不消费，等于所有业务用例都以匿名身份跑
    assert.match(config, /storageState: '\.auth\/admin\.json'/);
    assert.match(config, /storageState: '\.auth\/user\.json'/);
    assert.match(config, /name: 'chromium-user'/);
    assert.match(config, /grep: \/@user\//);
    // 没配账号时不能挂一个不存在的 .auth 文件（否则 ENOENT）
    assert.match(config, /adminReady \? \{ storageState/);
  });

  it('Node 版本有可执行约束：.nvmrc + engines', () => {
    const { files } = renderScaffold(base);
    const nvmrc = files.find((file) => file.path === '.nvmrc');
    assert.ok(nvmrc, '缺少 .nvmrc');
    assert.equal(nvmrc!.content.trim(), '22.23.0');
    const pkg = JSON.parse(files.find((file) => file.path === 'package.json')!.content) as {
      engines?: { node?: string };
    };
    assert.equal(pkg.engines?.node, '>=22.23.0');
  });

  it('CI 走 scripts/ci.sh：pnpm 优先，没装 pnpm 退回 npm', () => {
    const files = renderScaffold(base).files;
    const workflow = files.find(
      (file) => file.path === '.github/workflows/playwright.yml',
    )!.content;
    const ciScript = files.find((file) => file.path === 'scripts/ci.sh')!.content;
    // 刚生成的项目还没有锁文件：安装步骤必须自己判断，不能直连 pnpm ci / npm ci
    assert.match(workflow, /run: sh scripts\/ci\.sh install/);
    assert.match(workflow, /run: sh scripts\/ci\.sh run typecheck/);
    assert.match(workflow, /node-version-file: \.nvmrc/);
    assert.match(workflow, /PLAYWRIGHT_HTML_REPORT: reports\/playwright-report/);
    assert.match(workflow, /path: reports\/playwright-report/);
    assert.match(ciScript, /pnpm install --frozen-lockfile/);
    assert.match(ciScript, /npm ci/);
    assert.match(ciScript, /ensure_pnpm/);
  });

  it('package.json 的脚本能被 npm 直接跑起来，包名是合法 slug', () => {
    const { files } = renderScaffold({ stack: 'playwright', name: 'web e2e' });
    const pkg = JSON.parse(files.find((file) => file.path === 'package.json')!.content) as {
      name: string;
      type: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.name, 'web-e2e');
    assert.equal(pkg.scripts.test, 'playwright test');
    assert.ok(pkg.scripts['test:smoke'].includes('--grep @smoke'));
    assert.ok(pkg.scripts['test:regression'].includes('@smoke|@regression'));
    assert.ok(pkg.scripts['test:edge'].includes('--grep @edge'));
    assert.ok(pkg.scripts['test:no-flaky'].includes('--grep-invert @flaky'));
    assert.equal(pkg.scripts.typecheck, 'tsc --noEmit');
    assert.ok(pkg.scripts['test:test'].startsWith('cross-env ENV=test'));
    assert.ok(pkg.scripts['test:prod'].startsWith('cross-env ENV=prod'));
    // 常态只有 test / prod 两套：不要再冒出 dev / uat 脚本
    assert.equal(pkg.scripts['test:dev'], undefined);
    assert.equal(pkg.scripts['test:uat'], undefined);
    assert.ok(pkg.devDependencies['@playwright/test']);
    assert.ok(pkg.devDependencies.dotenv);
    assert.ok(pkg.devDependencies['cross-env']);
  });

  it('页面对象不用 networkidle（长轮询页面会一直等不到）', () => {
    const { files } = renderScaffold(base);
    const page = files.find((file) => file.path === 'pages/BasePage.ts')!.content;
    assert.match(page, /waitForLoadState\('load'\)/);
    assert.doesNotMatch(page, /waitForLoadState\('networkidle'\)/);
    const login = files.find((file) => file.path === 'pages/LoginPage.ts')!.content;
    assert.match(login, /getByTestId\('login-username'\)/);
  });

  it('登录态示例先走接口登录，失败再退回 UI', () => {
    const { files } = renderScaffold(base);
    const setup = files.find((file) => file.path === 'tests/auth.setup.ts')!.content;
    assert.match(setup, /tryApiLogin/);
    assert.match(setup, /改用 UI 登录/);
    assert.match(setup, /\.auth\/admin\.json/);
    const api = files.find((file) => file.path === 'utils/api-auth.ts')!.content;
    assert.match(api, /page\.request\.post/);
  });

  it('默认那条框架自检只验证连通性，不碰业务', () => {
    const { files } = renderScaffold(base);
    const spec = files.find((file) => file.path === 'tests/smoke/framework.spec.ts')!.content;
    assert.match(spec, /tag: \['@smoke'\]/);
    assert.match(spec, /page\.goto\('\/'\)/);
    assert.match(spec, /toHaveTitle/);
    // 自检不该依赖账号：没配账号时它也要能跑
    assert.doesNotMatch(spec, /test\.skip/);
    assert.doesNotMatch(spec, /hasAccount/);
  });

  it('填了被测地址就写进 .env.example，环境变量覆盖多环境', () => {
    const { files } = renderScaffold({
      stack: 'playwright',
      name: 'web-e2e',
      baseURL: 'https://demo.example.com/',
    });
    const env = files.find((file) => file.path === '.env.example')!.content;
    assert.match(env, /BASE_URL=https:\/\/demo\.example\.com/);
    // 模板里的 ENV 只是占位：新建环境时按文件名重写
    assert.match(env, /ENV=\n/);
    assert.match(env, /ADMIN_USERNAME=/);
    assert.match(env, /LOGIN_API_PATH/);
    // 接口登录请求体的占位符要留给运行时替换，不能被骨架渲染吃掉
    assert.match(env, /\{\{username\}\}/);
  });

  it('生成的目录能被插件识别为可运行的 Playwright 项目', () => {
    const { files } = renderScaffold({ stack: 'playwright', name: 'web-e2e' });
    const dir = path.join(tmp, 'web-e2e');
    fs.mkdirSync(dir, { recursive: true });
    writeFiles(dir, files);
    const health = detectProject(dir, 'playwright');
    assert.equal(health.exists, true);
    assert.equal(health.framework, 'playwright');
    assert.equal(health.mountable, true);
  });
});

describe('骨架解析与渲染', () => {
  it('占位符：projectName / packageName / baseURL / stack', () => {
    const skeleton = parseSkeleton(miniSkeleton());
    const { files } = renderFromSkeleton(skeleton, {
      projectName: 'Web E2E',
      baseURL: 'https://a.example.com',
      options: ['ci'],
    });
    const a = files.find((file) => file.path === 'a.txt')!.content;
    assert.match(a, /name=Web E2E/);
    assert.match(a, /pkg=web-e2e/);
    assert.match(a, /url=https:\/\/a\.example\.com/);
  });

  it('条件块：选中时保留，未选中时整块删掉', () => {
    const skeleton = parseSkeleton(miniSkeleton());
    const on = renderFromSkeleton(skeleton, { projectName: 'x', options: ['ci', 'lint'] });
    assert.equal(on.files.find((file) => file.path === 'b.txt')!.content, 'x-ci');
    const off = renderFromSkeleton(skeleton, { projectName: 'x', options: [] });
    assert.equal(off.files.find((file) => file.path === 'b.txt')!.content, 'x-nolint');
  });

  it('文件级开关：when 与 !when', () => {
    const skeleton = parseSkeleton(miniSkeleton());
    const on = renderFromSkeleton(skeleton, { projectName: 'x', options: ['ci'] });
    assert.deepEqual(
      on.files.map((file) => file.path),
      ['a.txt', 'b.txt', 'c.txt'],
    );
    const off = renderFromSkeleton(skeleton, { projectName: 'x', options: [] });
    assert.deepEqual(
      off.files.map((file) => file.path),
      ['a.txt', 'b.txt', 'd.txt'],
    );
  });

  it('未知选项被忽略，顺序跟着骨架声明', () => {
    const skeleton = parseSkeleton(miniSkeleton());
    const out = renderFromSkeleton(skeleton, {
      projectName: 'x',
      options: ['lint', 'ci', 'nope'],
    });
    assert.deepEqual(out.options, ['ci', 'lint']);
  });

  it('骨架体积没写 layout 时用默认落点', () => {
    const skeleton = parseSkeleton(miniSkeleton());
    assert.deepEqual(skeleton.layout, {
      testDir: 'tests',
      pagesDir: 'pages',
      fixturesDir: 'fixtures',
      utilsDir: 'utils',
      dataDir: 'data',
    });
  });

  it('when 引用未声明的选项直接报错', () => {
    assert.throws(
      () =>
        parseSkeleton(
          miniSkeleton({
            files: [{ path: 'a.txt', content: 'x', when: 'nope' }],
          }),
        ),
      /未声明的选项/,
    );
  });

  it('条件块引用未声明的选项直接报错', () => {
    assert.throws(
      () =>
        parseSkeleton(
          miniSkeleton({
            files: [{ path: 'a.txt', content: '{{#if nope}}x{{/if}}' }],
          }),
        ),
      /未声明的选项/,
    );
  });

  it('条件块没闭合直接报错', () => {
    assert.throws(
      () =>
        parseSkeleton(
          miniSkeleton({
            files: [{ path: 'a.txt', content: '{{#if ci}}x' }],
          }),
        ),
      /没有配对/,
    );
  });

  it('路径越界 / 绝对路径一律拒绝', () => {
    for (const bad of ['../escape.ts', '/abs.ts', 'a//b.ts', './x.ts', 'C:/x.ts']) {
      assert.throws(
        () => parseSkeleton(miniSkeleton({ files: [{ path: bad, content: 'x' }] })),
        /路径/,
        `${bad} 应该被拒绝`,
      );
    }
  });

  it('过滤后出现重复路径时报错', () => {
    // when 互斥：同一时刻只命中一个，不算重复
    const exclusive = parseSkeleton(
      miniSkeleton({
        files: [
          { path: 'dup.txt', content: 'a', when: 'ci' },
          { path: 'dup.txt', content: 'b', when: '!ci' },
        ],
      }),
    );
    assert.doesNotThrow(() => renderFromSkeleton(exclusive, { projectName: 'x', options: ['ci'] }));
    // 两个都命中才算重复
    const both = parseSkeleton(
      miniSkeleton({
        files: [
          { path: 'dup.txt', content: 'a', when: 'ci' },
          { path: 'dup.txt', content: 'b' },
        ],
      }),
    );
    assert.throws(
      () => renderFromSkeleton(both, { projectName: 'x', options: ['ci'] }),
      /重复文件/,
    );
  });

  it('没有文件 / 空项目名都不产出半套结果', () => {
    assert.throws(() => parseSkeleton(miniSkeleton({ files: [] })), /没有任何文件/);
    const skeleton = parseSkeleton(miniSkeleton());
    assert.throws(() => renderFromSkeleton(skeleton, { projectName: '  ' }), /项目名/);
  });
});

describe('骨架种子与指纹', () => {
  it('空间里没有骨架时按内置版本补一份', () => {
    const space = tmpDir('seed');
    const result = ensureSkeletonSeed(space, 'playwright-ts');
    assert.equal(result.created, true);
    const seeded = JSON.parse(fs.readFileSync(skeletonFile(space, 'playwright-ts'), 'utf8')) as {
      id: string;
      files: unknown[];
    };
    assert.equal(seeded.id, 'playwright-ts');
    assert.ok(seeded.files.length >= 20);
    // 再补一次不重复写
    assert.equal(ensureSkeletonSeed(space, 'playwright-ts').created, false);
  });

  it('用户改过的骨架不会被内置版本覆盖', () => {
    const space = tmpDir('edited');
    ensureSkeletonSeed(space, 'playwright-ts');
    const file = skeletonFile(space, 'playwright-ts');
    const edited = `${fs.readFileSync(file, 'utf8')}\n`.replace('"label"', '"label"  ');
    fs.writeFileSync(file, edited, 'utf8');
    const again = ensureSkeletonSeed(space, 'playwright-ts');
    assert.equal(again.updated, false);
    assert.equal(fs.readFileSync(file, 'utf8'), edited);
  });

  it('没人改过时随内置版本升级', () => {
    const space = tmpDir('upgrade');
    ensureSkeletonSeed(space, 'playwright-ts');
    const file = skeletonFile(space, 'playwright-ts');
    // 模拟「上一次种子写的是旧内容」：文件与账本都指向旧内容
    const oldText = `${JSON.stringify({ id: 'playwright-ts', files: [] }, null, 2)}\n`;
    fs.writeFileSync(file, oldText, 'utf8');
    const ledger = path.join(space, '.lantern', 'local', 'uiauto-skeletons.json');
    fs.writeFileSync(ledger, `${JSON.stringify({ 'playwright-ts': digest(oldText) })}\n`, 'utf8');
    const result = ensureSkeletonSeed(space, 'playwright-ts');
    assert.equal(result.updated, true);
    const upgraded = JSON.parse(fs.readFileSync(file, 'utf8')) as { files: unknown[] };
    assert.ok(upgraded.files.length >= 20);
  });

  it('空间骨架写坏时回退内置版本，并带回原因', () => {
    const space = tmpDir('broken');
    ensureSkeletonSeed(space, 'playwright-ts');
    fs.writeFileSync(skeletonFile(space, 'playwright-ts'), '{ 这不是 JSON', 'utf8');
    const loaded = loadSkeleton(space, 'playwright-ts');
    assert.equal(loaded.source, 'builtin');
    assert.match(loaded.error, /回退内置/);
    assert.ok(loaded.skeleton.files.length >= 20);
  });

  it('空间骨架可以改选项：渲染时按改后的骨架走', () => {
    const space = tmpDir('custom');
    ensureSkeletonSeed(space, 'playwright-ts');
    const file = skeletonFile(space, 'playwright-ts');
    const skeleton = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      options: Array<{ id: string; label: string; hint: string }>;
    };
    skeleton.options.push({ id: 'extra', label: '额外文件', hint: '' });
    fs.writeFileSync(file, `${JSON.stringify(skeleton, null, 2)}\n`, 'utf8');
    const loaded = loadSkeleton(space, 'playwright-ts');
    assert.equal(loaded.source, 'space');
    const { files } = renderScaffold({
      stack: 'playwright',
      name: 'demo',
      skeleton: loaded.skeleton,
      options: ['ci'],
    });
    assert.ok(files.some((item) => item.path === '.github/workflows/playwright.yml'));
  });
});

describe('写盘边界', () => {
  it('目标目录非空直接拒绝，不动已有文件', () => {
    const dir = path.join(tmp, 'occupied');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x', 'utf8');
    assert.throws(() => assertScaffoldTarget(dir), /不是空的/);
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'x');
  });

  it('目标目录不存在时可以写，写出的文件与清单一致', () => {
    const dir = path.join(tmp, 'fresh');
    assert.doesNotThrow(() => assertScaffoldTarget(dir));
    const { files } = renderScaffold({ stack: 'playwright', name: 'fresh' });
    writeScaffoldFiles(dir, files);
    for (const file of files) {
      assert.equal(fs.readFileSync(path.join(dir, file.path), 'utf8'), file.content);
    }
  });

  it('中途失败时按逆序回滚本次新建的文件', () => {
    const dir = path.join(tmp, 'rollback');
    const files = [
      { path: 'a.txt', content: 'a' },
      { path: 'a.txt', content: 'dup' },
    ];
    assert.throws(() => writeScaffoldFiles(dir, files));
    assert.equal(fs.existsSync(dir), false);
  });
});

describe('修改项目：逐文件判断 + 覆盖前备份', () => {
  it('按磁盘现状标 new / same / changed，越界路径直接拒绝', () => {
    const dir = tmpDir('update-plan');
    writeFiles(dir, [
      { path: 'same.txt', content: 'same' },
      { path: 'changed.txt', content: 'old' },
    ]);
    const planned = planScaffoldUpdate(dir, [
      { path: 'same.txt', content: 'same' },
      { path: 'changed.txt', content: 'new' },
      { path: 'nested/new.txt', content: 'new' },
    ]) as Array<{ path: string; status: string }>;
    assert.deepEqual(
      planned.map((file) => [file.path, file.status]),
      [
        ['same.txt', 'same'],
        ['changed.txt', 'changed'],
        ['nested/new.txt', 'new'],
      ],
    );
    assert.throws(() => planScaffoldUpdate(dir, [{ path: '../escape.txt', content: 'x' }]), /越界/);
  });

  it('.env 已有内容时同步只保留不覆盖，缺了才补', () => {
    const dir = tmpDir('update-env');
    const backup = path.join(tmp, 'update-env-backup');
    writeFiles(dir, [{ path: '.env', content: 'ADMIN_PASSWORD=mine\n' }]);
    const planned = planScaffoldUpdate(dir, [
      { path: '.env', content: 'ADMIN_PASSWORD=\n' },
      { path: '.env.example', content: 'A=1\n' },
    ]) as Array<{ path: string; status: string }>;
    assert.deepEqual(
      planned.map((file) => [file.path, file.status]),
      [
        ['.env', 'keep'],
        ['.env.example', 'new'],
      ],
    );
    const stats = writeScaffoldUpdate(dir, planned, backup);
    assert.equal(stats.kept, 1);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'ADMIN_PASSWORD=mine\n');
    assert.equal(fs.existsSync(path.join(backup, '.env')), false);
  });

  it('只写有变化的文件，被覆盖的原文件进备份目录', () => {
    const dir = tmpDir('update-write');
    const backup = path.join(tmp, 'update-backup');
    writeFiles(dir, [
      { path: 'same.txt', content: 'same' },
      { path: 'changed.txt', content: 'old' },
      { path: 'keep-only.txt', content: 'mine' },
    ]);
    const planned = planScaffoldUpdate(dir, [
      { path: 'same.txt', content: 'same' },
      { path: 'changed.txt', content: 'new' },
      { path: 'nested/new.txt', content: 'created' },
    ]);
    const before = fs.statSync(path.join(dir, 'same.txt')).mtimeMs;
    const stats = writeScaffoldUpdate(dir, planned, backup);
    assert.deepEqual(
      { created: stats.created, changed: stats.changed, same: stats.same },
      { created: 1, changed: 1, same: 1 },
    );
    assert.deepEqual(stats.backedUp, ['changed.txt']);
    assert.equal(fs.readFileSync(path.join(dir, 'changed.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(dir, 'nested/new.txt'), 'utf8'), 'created');
    assert.equal(fs.readFileSync(path.join(backup, 'changed.txt'), 'utf8'), 'old');
    // 未变化的文件不重写；用户自己加的文件不动
    assert.equal(fs.statSync(path.join(dir, 'same.txt')).mtimeMs, before);
    assert.equal(fs.readFileSync(path.join(dir, 'keep-only.txt'), 'utf8'), 'mine');
  });

  it('中途失败时从备份还原已覆盖的文件，并删掉本次新建的', () => {
    const dir = tmpDir('update-rollback');
    const backup = path.join(tmp, 'update-rollback-backup');
    writeFiles(dir, [{ path: 'changed.txt', content: 'old' }]);
    // 第二个文件的目标位置先放一个同名目录，写入必然失败
    fs.mkdirSync(path.join(dir, 'nested/new.txt'), { recursive: true });
    assert.throws(() =>
      writeScaffoldUpdate(
        dir,
        [
          { path: 'changed.txt', content: 'new', status: 'changed' },
          { path: 'nested/new.txt', content: 'x', status: 'new' },
        ],
        backup,
      ),
    );
    assert.equal(fs.readFileSync(path.join(dir, 'changed.txt'), 'utf8'), 'old');
  });

  it('修改时沿用现有 .env.example 的 BASE_URL', () => {
    const dir = tmpDir('update-baseurl');
    writeFiles(dir, [{ path: '.env.example', content: 'BASE_URL=https://keep.example.com/\n' }]);
    assert.equal(existingScaffoldBaseURL(dir), 'https://keep.example.com');
    assert.equal(existingScaffoldBaseURL(path.join(tmp, 'nope')), '');
  });

  it('老项目按目录里的文件反推附带内容，再同步时不会丢掉', () => {
    const skeleton = parseSkeleton(builtinSkeletonText('playwright-ts'), {});
    const dir = tmpDir('detect-options');
    // 全选生成一遍，再把「记录」当成不存在（模拟升级前建的项目）
    const { files } = renderScaffold({
      stack: 'playwright',
      name: 'detect-demo',
      baseURL: 'https://detect.example.com',
      options: ['authState', 'ci', 'lint', 'husky', 'allure', 'docker', 'webServer'],
    });
    writeFiles(dir, files);
    assert.deepEqual(detectScaffoldOptions(dir, skeleton), [
      'authState',
      'ci',
      'lint',
      'husky',
      'allure',
      'docker',
      'webServer',
    ]);
  });

  it('空目录反推不出任何附带内容', () => {
    const skeleton = parseSkeleton(builtinSkeletonText('playwright-ts'), {});
    assert.deepEqual(detectScaffoldOptions(tmpDir('detect-empty'), skeleton), []);
  });
});
