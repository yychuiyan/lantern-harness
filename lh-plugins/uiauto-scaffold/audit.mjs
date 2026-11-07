/**
 * 骨架体检：新建项目前对「要落盘的这套骨架」做确定性检查。
 *
 * 这里只做规则判断，不调模型：模型那一路在 `uiauto-prompt.mjs` 的
 * 「自动化项目提示词」里，输出 findings + patches，由前端应用后再走一遍本文件。
 *
 * 输出两样东西：
 * - `logs`：给「检查」步骤的实时日志（阶段 + 等级 + 一句人话）；
 * - `checks`：问题清单，`level=error` 表示不修就不该生成。
 */

/** 检查阶段：前端按这个顺序分组显示日志 */
export const AUDIT_STAGES = ['skeleton', 'structure', 'render', 'target'];

const now = () => new Date().toISOString();

/** 必需的骨架文件：缺了就不是一个能跑的测试项目 */
const REQUIRED_FILES = ['package.json', 'playwright.config.ts'];

/**
 * 骨架只自带一条框架自检，所以只要求它带 @smoke：
 * 业务用例的分级标签（@regression / @edge）等真的有用例时再检查也不迟。
 */
const REQUIRED_TAGS = ['@smoke'];

/** 硬编码凭据的粗判：赋值语句里直接写 password / token 且看起来像真实值 */
const HARDCODED_SECRET =
  /(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*['"`](?!\$\{|\{\{|process\.env|os\.environ)[^'"`\n]{3,}['"`]/i;

/** 本机绝对地址写死（应走 BASE_URL） */
const HARDCODED_URL = /['"`]https?:\/\/(?!localhost|127\.0\.0\.1)[^'"`\s]+['"`]/;

function fileOf(files, target) {
  return files.find((file) => file.path === target) ?? null;
}

function anyFile(files, predicate) {
  return files.some((file) => predicate(file.path));
}

/** `package.json` 解析失败时返回 null，由调用方记 error */
function parsePackage(files) {
  const file = fileOf(files, 'package.json');
  if (!file) return null;
  try {
    return JSON.parse(file.content);
  } catch {
    return null;
  }
}

/**
 * 体检入口。
 *
 * @param {{
 *   skeleton: { id: string, stack?: string, options: Array<object>, files: Array<object>, layout?: object },
 *   files: Array<{ path: string, content: string }>,
 *   options: string[],
 *   targetDir?: string,
 *   targetProblem?: string,
 *   parentProblem?: string,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   logs: Array<{ at: string, stage: string, level: string, message: string }>,
 *   checks: Array<{ id: string, level: 'error'|'warn'|'info', title: string, detail: string, hint?: string, file?: string }>,
 *   summary: { errors: number, warnings: number, infos: number, files: number, bytes: number }
 * }}
 */
export function auditScaffold(input) {
  const skeleton = input?.skeleton ?? null;
  const files = Array.isArray(input?.files) ? input.files : [];
  const picked = new Set(Array.isArray(input?.options) ? input.options : []);
  const logs = [];
  const checks = [];

  const log = (stage, level, message) => logs.push({ at: now(), stage, level, message });
  const check = (level, id, title, detail, extra = {}) => {
    checks.push({ id, level, title, detail, ...extra });
    log(extra.stage || 'render', level, title);
  };

  log('skeleton', 'info', `使用骨架 ${skeleton?.id || '(未知)'}，${files.length} 个文件`);
  log('structure', 'info', `勾选 ${picked.size} 项附带内容：${[...picked].join(' / ') || '无'}`);

  /* ── 结构：必需文件 ── */
  for (const required of REQUIRED_FILES) {
    if (!fileOf(files, required)) {
      check(
        'error',
        `missing-${required}`,
        `缺少 ${required}`,
        '骨架里没有这个文件，生成出来的项目跑不起来。',
        {
          file: required,
          stage: 'structure',
        },
      );
    }
  }
  if (!anyFile(files, (p) => /^tests\/.*\.spec\.ts$/.test(p))) {
    check(
      'error',
      'missing-specs',
      '没有用例文件',
      '至少需要一个 tests/**/*.spec.ts，否则 `playwright test` 跑不起来。',
      {
        stage: 'structure',
      },
    );
  }
  for (const laidOut of ['pages/BasePage.ts', 'fixtures/test.ts']) {
    if (!fileOf(files, laidOut)) {
      check(
        'warn',
        `missing-${laidOut}`,
        `缺少 ${laidOut}`,
        '页面对象基类 / 测试 fixture 缺失，后续生成的用例没有可复用的底座。',
        {
          file: laidOut,
          stage: 'structure',
        },
      );
    }
  }

  /* ── 渲染结果：package.json / 配置 ── */
  const pkgFile = fileOf(files, 'package.json');
  const pkg = parsePackage(files);
  if (pkgFile && !pkg) {
    check(
      'error',
      'package-json-invalid',
      'package.json 不是合法 JSON',
      '生成出来的项目装不上依赖。',
      {
        file: 'package.json',
        stage: 'render',
      },
    );
  }
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (!deps['@playwright/test']) {
      check(
        'error',
        'package-json-no-playwright',
        'package.json 没有 @playwright/test',
        '缺这个依赖，项目识别不出来也跑不了。',
        {
          file: 'package.json',
          stage: 'render',
        },
      );
    } else {
      log('render', 'info', `依赖就绪：@playwright/test ${deps['@playwright/test']}`);
    }
    const scripts = pkg.scripts ?? {};
    if (!scripts.test) {
      check(
        'warn',
        'package-json-no-test-script',
        'package.json 没有 test 脚本',
        '运行页的「全量运行」靠它，缺了只能手写命令。',
        {
          file: 'package.json',
          stage: 'render',
        },
      );
    }
    if (picked.has('allure') && !scripts['report:allure']) {
      check(
        'error',
        'allure-script-missing',
        '勾了 Allure 但没有 report:allure 脚本',
        '报告没法生成。',
        {
          file: 'package.json',
          stage: 'render',
        },
      );
    }
  }

  const configText = fileOf(files, 'playwright.config.ts')?.content ?? '';
  if (configText) {
    if (!/testDir\s*:/.test(configText)) {
      check(
        'warn',
        'config-no-testdir',
        'playwright.config.ts 没有 testDir',
        '出码器按 testDir 决定用例落点，缺了会退化到默认值。',
        {
          file: 'playwright.config.ts',
          stage: 'render',
        },
      );
    } else {
      log('render', 'info', 'playwright.config.ts 已声明 testDir');
    }
    if (!/dependencies\s*:\s*\[\s*['"]setup['"]/.test(configText)) {
      check(
        'info',
        'config-no-setup-dep',
        '配置里没有 setup 依赖',
        "如果有登录态，建议加 `dependencies: ['setup']` 保证先登录再跑用例。",
        {
          file: 'playwright.config.ts',
          stage: 'render',
        },
      );
    }
  }

  /* ── 标签口径 ── */
  const specText = files
    .filter((file) => /^tests\/.*\.spec\.ts$/.test(file.path))
    .map((file) => file.content)
    .join('\n');
  const missingTags = REQUIRED_TAGS.filter((tag) => !specText.includes(tag));
  if (missingTags.length && specText) {
    check(
      'warn',
      'tags-incomplete',
      `示例用例没覆盖 ${missingTags.join(' / ')}`,
      '默认的框架自检要带 @smoke，否则 test:smoke 门禁跑不到它。',
      {
        stage: 'render',
      },
    );
  } else if (specText) {
    log('render', 'info', '框架自检带 @smoke 标签');
  }

  /* ── 写法红线 ── */
  const networkIdle = files.find((file) =>
    /waitForLoadState\(\s*['"]networkidle['"]\s*\)/.test(file.content),
  );
  if (networkIdle) {
    check(
      'warn',
      'networkidle',
      `${networkIdle.path} 用了 networkidle`,
      '页面永远等不到 networkidle，容易整条用例超时；改用可见元素断言。',
      {
        file: networkIdle.path,
        stage: 'render',
      },
    );
  }
  const secretFile = files.find((file) => HARDCODED_SECRET.test(file.content));
  if (secretFile) {
    check(
      'error',
      'hardcoded-secret',
      `${secretFile.path} 里疑似写死了凭据`,
      '账号密码一律走环境变量，进仓库会泄漏。',
      {
        file: secretFile.path,
        stage: 'render',
      },
    );
  }
  const urlFile = files.find(
    (file) => /^tests\/.*\.spec\.ts$/.test(file.path) && HARDCODED_URL.test(file.content),
  );
  if (urlFile) {
    check(
      'warn',
      'hardcoded-url',
      `${urlFile.path} 里写死了非本地地址`,
      '用例里应该用 BASE_URL，否则换环境就得改代码。',
      {
        file: urlFile.path,
        stage: 'render',
      },
    );
  }

  /* ── 选项与文件一致性 ── */
  const optionChecks = [
    [
      'authState',
      'login-state-missing',
      '勾了登录态示例但没有 auth.setup.ts',
      () => fileOf(files, 'tests/auth.setup.ts'),
    ],
    [
      'husky',
      'husky-missing',
      '勾了提交规范但没有 husky / commitlint 文件',
      () =>
        anyFile(files, (p) => p.startsWith('.husky/')) || fileOf(files, 'commitlint.config.mjs'),
    ],
    [
      'ci',
      'ci-missing',
      '勾了 CI 但没有 workflow 文件',
      () => anyFile(files, (p) => p.startsWith('.github/workflows/') && /\.ya?ml$/.test(p)),
    ],
    [
      'docker',
      'docker-missing',
      '勾了 Docker 但没有 Dockerfile / Jenkinsfile',
      () => anyFile(files, (p) => p === 'Dockerfile' || p === 'Jenkinsfile'),
    ],
    [
      'webServer',
      'webserver-missing',
      '勾了本地自启动但配置里没有 webServer',
      () => /webServer\s*:/.test(fileOf(files, 'playwright.config.ts')?.content ?? ''),
    ],
    [
      'lint',
      'lint-missing',
      '勾了代码规范但没有 ESLint / Prettier 配置',
      () => anyFile(files, (p) => /^eslint\.config\.|^\.prettierrc/.test(p)),
    ],
  ];
  for (const [option, id, title, probe] of optionChecks) {
    if (!picked.has(option)) continue;
    if (!probe()) {
      check('error', id, title, '选项勾了但没产出对应文件，说明骨架里的 when 标记跟选项对不上。', {
        stage: 'render',
      });
    } else {
      log('render', 'info', `${option}：文件齐全`);
    }
  }

  /* ── 目标目录 ── */
  if (input?.parentProblem) {
    check('error', 'parent-dir', '父目录不可用', input.parentProblem, { stage: 'target' });
  }
  if (input?.targetProblem) {
    check('error', 'target-dir', '目标目录不可用', input.targetProblem, { stage: 'target' });
  } else if (input?.targetDir) {
    log('target', 'info', `目标目录可用：${input.targetDir}`);
  }

  const errors = checks.filter((item) => item.level === 'error').length;
  const warnings = checks.filter((item) => item.level === 'warn').length;
  const infos = checks.filter((item) => item.level === 'info').length;
  const bytes = files.reduce(
    (sum, file) => sum + Buffer.byteLength(String(file.content ?? ''), 'utf8'),
    0,
  );

  log('render', errors ? 'error' : 'info', `体检完成：${errors} 个必须处理、${warnings} 个提示`);
  return {
    ok: errors === 0,
    logs,
    checks,
    summary: { errors, warnings, infos, files: files.length, bytes },
  };
}
