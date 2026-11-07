/**
 * 自动化项目脚手架：可选技术栈注册表。
 *
 * 首期只落地 Playwright + TypeScript（UI）。pytest / Selenium 标记为 planned，
 * 前端灰显「规划中」；后续补齐时只需要新增骨架并把 status 改成 ready，
 * 页面、接口与项目记录都不需要改。
 *
 * `skeleton` 指向空间里的骨架 JSON（`<空间>/.lantern/config/uiauto/skeleton/<id>.json`）：
 * 向导里显示的选项与生成出来的文件都以那份骨架为准，这里只是缺省值与兜底。
 */

export const SCAFFOLD_STACKS = [
  {
    id: 'playwright',
    label: 'Playwright + TypeScript',
    hint: 'UI 自动化，企业级分层（配置 / 页面对象 / fixture / 环境变量 / 多环境 / CI）',
    kind: 'ui',
    language: 'ts',
    status: 'ready',
    /** 空间里的骨架 id 与建完项目后自动关联的提示词 */
    skeleton: 'playwright-ts',
    promptFile: '自动化执行提示词.md',
    /** 可选附加内容：向导里勾选（与骨架 JSON 的 options 保持一致） */
    options: [
      { id: 'authState', label: '登录态示例', hint: 'auth.setup.ts + storageState' },
      { id: 'ci', label: 'GitHub Actions 流水线', hint: '门禁 / 冒烟分片 / 定时回归' },
      { id: 'lint', label: 'ESLint + Prettier', hint: '代码规范与格式化' },
      { id: 'husky', label: '提交规范', hint: 'husky + commitlint + lint-staged' },
      { id: 'allure', label: 'Allure 报告', hint: 'allure-playwright + reports/allure-results' },
      { id: 'docker', label: 'Docker + Jenkinsfile', hint: '容器化与 Jenkins 部署' },
      { id: 'webServer', label: '本地自启动被测系统', hint: 'playwright.config.ts 的 webServer' },
    ],
    defaultOptions: ['authState', 'ci', 'lint'],
  },
  {
    id: 'pytest',
    label: 'pytest（接口 / UI）',
    hint: 'Python 栈，后续版本提供',
    kind: 'api',
    language: 'python',
    status: 'planned',
    skeleton: '',
    promptFile: '',
    options: [],
    defaultOptions: [],
  },
  {
    id: 'selenium',
    label: 'Selenium + Java',
    hint: 'Maven 栈，后续版本提供',
    kind: 'ui',
    language: 'java',
    status: 'planned',
    skeleton: '',
    promptFile: '',
    options: [],
    defaultOptions: [],
  },
];

export function findStack(id) {
  const value = String(id ?? '').trim();
  return SCAFFOLD_STACKS.find((stack) => stack.id === value) ?? null;
}

/**
 * 只把前端需要的字段透出去（不暴露模板实现细节）。
 * 骨架里的选项 / 提示词由 `library.mjs` 的 `applySkeletonToStack` 盖上。
 */
export function listStacks() {
  return SCAFFOLD_STACKS.map((stack) => ({
    id: stack.id,
    label: stack.label,
    hint: stack.hint,
    kind: stack.kind,
    language: stack.language,
    status: stack.status,
    skeleton: stack.skeleton,
    promptFile: stack.promptFile,
    options: stack.options.map((option) => ({ ...option })),
    defaultOptions: [...stack.defaultOptions],
  }));
}
