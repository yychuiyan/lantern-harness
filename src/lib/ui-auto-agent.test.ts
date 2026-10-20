import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emitCode } from '../../lh-plugins/uiauto-explorer/emit.mjs';
import { buildCandidateLocators, locatorKey } from '../../lh-plugins/uiauto-explorer/locators.mjs';
import { normalizeIr, pythonFunctionName, slugify } from '../../lh-plugins/uiauto-explorer/ir.mjs';
import { bindPlanStep, normalizePlan } from '../../lh-plugins/uiauto-explorer/plan.mjs';
import { diffText } from '../../lh-plugins/uiauto-explorer/diff.mjs';
import { parseUiAutoPrompt } from '../../lh-plugins/uiauto-prompt.mjs';
import {
  buildUiAgentSystemPrompt,
  buildUiPlanSystemPrompt,
  type UiPlanStep,
} from './ui-auto-agent';

const sample = {
  title: '登录后加购',
  baseURL: 'http://localhost:5173',
  source: '登录后进入商品列表，把第一个商品加入购物车',
  steps: [
    { action: 'goto', url: '/login' },
    { action: 'fill', locator: { kind: 'label', value: '用户名' }, value: '${LANTERN_USER}' },
    { action: 'click', locator: { kind: 'role', role: 'button', name: '登录' } },
    { action: 'expect', locator: { kind: 'text', value: '退出登录' } },
    { action: 'click', note: '缺定位器，应被丢掉' },
    { action: '不存在的动作', locator: { kind: 'text', value: 'x' } },
  ],
};

describe('步骤 IR', () => {
  it('丢掉未知动作与缺定位器的步骤', () => {
    const ir = normalizeIr(sample);
    assert.equal(ir.steps.length, 4);
    assert.deepEqual(
      ir.steps.map((step) => step.action),
      ['goto', 'fill', 'click', 'expect'],
    );
    assert.equal(ir.title, '登录后加购');
  });

  it('拒绝不合法的定位器', () => {
    const ir = normalizeIr({
      steps: [
        { action: 'click', locator: { kind: 'role' } },
        { action: 'click', locator: { kind: 'attr', attr: 'name' } },
        { action: 'click', locator: { kind: 'css', value: '#ok' } },
      ],
    });
    assert.equal(ir.steps.length, 1);
    assert.deepEqual(ir.steps[0].locator, { kind: 'css', value: '#ok' });
  });

  it('占位符默认走环境变量，不写死账号', () => {
    const ir = normalizeIr(sample);
    const code = emitCode(ir, 'ts').code;
    assert.match(code, /process\.env\.LANTERN_USER \?\? ''/);
    assert.doesNotMatch(code, /LANTERN_USER\s*=\s*['"]/);
  });

  it('标题转文件名只留 ASCII，中文标题有兜底', () => {
    assert.equal(slugify('Login Flow'), 'login-flow');
    assert.equal(slugify('登录流程'), 'ai-generated');
  });
});

describe('代码渲染', () => {
  it('TS 优先输出 user-facing locator', () => {
    const result = emitCode(sample, 'ts');
    assert.equal(result.language, 'ts');
    assert.equal(result.filename, 'ai-generated.spec.ts');
    assert.match(result.code, /page\.getByLabel\("用户名", \{ exact: true \}\)/);
    assert.match(result.code, /page\.getByRole\("button", \{ name: "登录", exact: true \}\)/);
    assert.match(
      result.code,
      /await expect\(page\.getByText\("退出登录", \{ exact: true \}\)\)\.toBeVisible\(\)/,
    );
  });

  it('Python 用 pytest + sync_api 的写法', () => {
    const result = emitCode(sample, 'python');
    assert.equal(result.language, 'python');
    assert.match(result.code, /from playwright\.sync_api import Page, expect/);
    assert.match(
      result.code,
      /page\.get_by_label\("用户名", exact=True\)\.fill\(os\.environ\.get\("LANTERN_USER", ""\)\)/,
    );
    assert.match(
      result.code,
      /expect\(page\.get_by_text\("退出登录", exact=True\)\)\.to_be_visible\(\)/,
    );
    assert.equal(result.filename, `${pythonFunctionName('登录后加购')}.py`);
  });

  it('同一份 IR 换语言不需要改步骤', () => {
    const ts = emitCode(sample, 'ts');
    const py = emitCode(sample, 'python');
    assert.equal(ts.ir.steps.length, py.ir.steps.length);
    assert.equal(ts.ir.steps[1].value, py.ir.steps[1].value);
  });

  it('同名元素用 nth 收窄，两种语言一致', () => {
    const ir = normalizeIr({
      title: '删除第一行',
      steps: [
        { action: 'click', locator: { kind: 'role', role: 'button', name: '删除', nth: 0 } },
        { action: 'click', locator: { kind: 'role', role: 'button', name: '删除', nth: 2 } },
      ],
    }) as { steps: Array<{ locator: { nth?: number } }> };
    assert.equal(ir.steps[0].locator.nth, 0);
    const ts = emitCode(ir, 'ts').code;
    assert.match(ts, /getByRole\("button", \{ name: "删除", exact: true \}\)\.first\(\)/);
    assert.match(ts, /getByRole\("button", \{ name: "删除", exact: true \}\)\.nth\(2\)/);
    const py = emitCode(ir, 'python').code;
    assert.match(py, /get_by_role\("button", name="删除", exact=True\)\.first/);
    assert.match(py, /get_by_role\("button", name="删除", exact=True\)\.nth\(2\)/);
  });

  it('baseURL 写进用例，不依赖项目 config', () => {
    const ts = emitCode(sample, 'ts').code;
    assert.match(ts, /test\.use\(\{ baseURL: "http:\/\/localhost:5173" \}\)/);
    const py = emitCode(sample, 'python').code;
    assert.match(py, /BASE_URL = os\.environ\.get\("BASE_URL", "http:\/\/localhost:5173"\)/);
    assert.match(py, /page\.goto\(BASE_URL \+ "\/login"\)/);
    const withAuth = emitCode({ ...sample, storageState: 'auth-admin.json' }, 'ts').code;
    assert.match(withAuth, /storageState: "auth-admin\.json"/);
  });
});

describe('定位器候选', () => {
  const base = {
    tag: 'button',
    role: 'button',
    name: '登录',
    labelText: '',
    placeholder: '',
    ariaLabel: '',
    testId: '',
    id: '',
    nameAttr: '',
    href: '',
    text: '登录',
    cssPath: 'html > body > form > button',
  };

  it('testid 优先于 role', () => {
    const list = buildCandidateLocators({ ...base, testId: 'login-submit' });
    assert.equal(list[0].locator.kind, 'testid');
    assert.equal(list[0].locator.value, 'login-submit');
    assert.ok(list.some((item) => item.locator.kind === 'role'));
  });

  it('css 只在最后兜底', () => {
    const list = buildCandidateLocators(base);
    assert.equal(list[list.length - 1].locator.kind, 'css');
    assert.ok(list[0].score >= 60);
  });

  it('输入框不把 text 当候选（text 是用户输入的值）', () => {
    const list = buildCandidateLocators({
      ...base,
      tag: 'input',
      role: 'textbox',
      name: '用户名',
      text: 'alice',
    });
    assert.ok(!list.some((item) => item.locator.kind === 'text'));
    assert.ok(list.some((item) => item.locator.kind === 'role'));
  });

  it('去重同一候选', () => {
    const list = buildCandidateLocators(base);
    const keys = list.map((item) => locatorKey(item.locator));
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('步骤计划', () => {
  it('丢掉未知动作与缺目标的步骤，并补 id', () => {
    const plan = normalizePlan([
      { action: 'goto', url: '/login' },
      { action: 'dance', target: '跳舞' },
      { action: 'click', target: '  登录   按钮 ' },
      { action: 'click' },
      { action: 'fill', target: '用户名', value: '${USER}' },
    ]) as Array<{ id: string; target?: string; value?: string; status: string }>;
    assert.deepEqual(
      plan.map((step) => step.id),
      ['p1', 'p2', 'p3'],
    );
    assert.equal(plan[1].target, '登录 按钮');
    assert.equal(plan[2].value, '${USER}');
    assert.equal(plan[2].status, 'pending');
  });

  it('id 重复时换新号，最多 40 步', () => {
    const raw = Array.from({ length: 60 }, (_, index) => ({
      id: index < 2 ? 'p1' : undefined,
      action: 'click',
      target: `按钮 ${index}`,
    }));
    const plan = normalizePlan(raw);
    assert.equal(plan.length, 40);
    assert.equal(new Set(plan.map((step) => step.id)).size, 40);
    assert.equal(plan[1].id, 'p2');
  });

  it('探测结果回填到指定步骤', () => {
    const plan = normalizePlan([
      { id: 'p1', action: 'click', target: '登录' },
      { id: 'p2', action: 'expect', target: '欢迎' },
    ]);
    const bound = bindPlanStep(plan, 'p1', {
      recommended: { kind: 'role', role: 'button', name: '登录' },
      confidence: 'high',
    });
    assert.equal(bound[0].status, 'bound');
    assert.deepEqual(bound[0].locator, { kind: 'role', role: 'button', name: '登录' });
    assert.equal(bound[1].status, 'pending');

    const failed = bindPlanStep(plan, 'p2', { recommended: null, warning: '没有唯一候选' });
    assert.equal(failed[1].status, 'failed');
    assert.match(failed[1].warning ?? '', /唯一候选/);
  });
});

describe('文本 diff', () => {
  it('修改一行只产生一个 hunk', () => {
    const result = diffText('a\nb\nc\n', 'a\nB\nc\n');
    assert.equal(result.added, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.hunks.length, 1);
    assert.deepEqual(
      result.hunks[0].lines.map((line) => `${line.type}:${line.text}`),
      ['equal:a', 'del:b', 'add:B', 'equal:c'],
    );
  });

  it('新增文件全是加号，空内容不产生 hunk', () => {
    const created = diffText('', 'one\ntwo\n');
    assert.equal(created.added, 2);
    assert.equal(created.removed, 0);
    assert.deepEqual(
      created.hunks[0].lines.map((line) => line.type),
      ['add', 'add'],
    );

    const same = diffText('same\n', 'same\n');
    assert.equal(same.hunks.length, 0);
    assert.equal(same.added, 0);
  });

  it('超过行数上限时只返回统计', () => {
    const big = Array.from({ length: 600 }, (_, index) => `line ${index}`).join('\n');
    const result = diffText('', big, { maxLines: 100 });
    assert.equal(result.truncated, true);
    assert.equal(result.hunks.length, 0);
    assert.match(result.message ?? '', /只显示增删行数/);
  });

  it('空行与行号按新旧文件分别推进', () => {
    const result = diffText('x\n\ny\n', 'x\n\nz\n');
    const lines = result.hunks[0].lines;
    assert.equal(result.hunks[0].oldStart, 1);
    const del = lines.find((line) => line.type === 'del');
    const add = lines.find((line) => line.type === 'add');
    assert.equal(del?.text, 'y');
    assert.equal(add?.text, 'z');
  });
});

describe('IR 保留计划 id', () => {
  it('planStepId 原样保留，出码时忽略', () => {
    const ir = normalizeIr({
      title: '带计划',
      steps: [
        {
          action: 'click',
          locator: { kind: 'role', role: 'button', name: '登录' },
          planStepId: 'p2',
        },
      ],
    });
    assert.equal(ir.steps[0].planStepId, 'p2');
    const code = emitCode(ir, 'ts').code;
    assert.doesNotMatch(code, /planStepId/);
  });
});

describe('提示词：优先用提示词管理里的版本', () => {
  const project = {
    id: 'p1',
    name: '演示项目',
    dir: '/tmp/demo',
    framework: 'playwright',
  } as Parameters<typeof buildUiPlanSystemPrompt>[0];

  it('没给自定义提示词时只给一份极简兜底', () => {
    const text = buildUiPlanSystemPrompt(project, 'ts');
    assert.match(text, /测试设计师/);
    assert.match(text, /演示项目/);
    // 兜底不复制正式提示词，保持几行以内
    assert.ok(text.split('\n').length <= 6);
  });

  it('给了自定义提示词就整段换成它，并替换占位符', () => {
    const custom = '项目 {{project}} 在 {{dir}}，语言 {{language}}。\n只输出 3 步。';
    const text = buildUiPlanSystemPrompt(project, 'python', custom);
    assert.equal(
      text,
      '项目 演示项目 在 /tmp/demo，语言 Python + pytest + playwright.sync_api。\n只输出 3 步。',
    );
    assert.doesNotMatch(text, /资深测试设计师/);
  });

  it('探索阶段把计划填进 {{plan}}；没有计划时给一句提示', () => {
    const custom = '规则如下。\n{{plan}}\n结束。';
    const withPlan = buildUiAgentSystemPrompt(
      project,
      'ts',
      [{ id: 'p1', action: 'click', target: '登录按钮' } as UiPlanStep],
      custom,
    );
    assert.match(withPlan, /\[p1\] click/);
    const noPlan = buildUiAgentSystemPrompt(project, 'ts', [], custom);
    assert.match(noPlan, /先调用 ui_plan_steps/);
    assert.doesNotMatch(noPlan, /\{\{plan\}\}/);
  });
});

describe('解析 UI 自动化测试提示词文件', () => {
  it('按 ## 规划阶段 / ## 探索阶段 分段，忽略文件头说明', () => {
    const text = [
      '# Playwright提示词',
      '',
      '> 插件维护，别删。',
      '',
      '## 规划阶段',
      '',
      '规划正文 {{project}}',
      '',
      '## 探索阶段',
      '',
      '探索正文',
      '第二行',
    ].join('\n');
    const out = parseUiAutoPrompt(text);
    assert.equal(out.plan, '规划正文 {{project}}');
    assert.equal(out.agent, '探索正文\n第二行');
  });

  it('缺段或空文件返回空段（调用方据此拦下来提示）', () => {
    assert.deepEqual(parseUiAutoPrompt(''), { plan: '', agent: '', code: '' });
    const only = parseUiAutoPrompt('## 探索阶段\n\n只有探索');
    assert.equal(only.plan, '');
    assert.equal(only.agent, '只有探索');
    assert.equal(only.code, '');
  });

  it('「## 生成代码」单独成段，并拼在探索阶段 prompt 后面', () => {
    const text = [
      '## 规划阶段',
      '',
      '规划正文',
      '',
      '## 探索阶段',
      '',
      '探索正文',
      '',
      '## 生成代码',
      '',
      '按项目现有结构与规范写。',
    ].join('\n');
    const out = parseUiAutoPrompt(text);
    assert.equal(out.agent, '探索正文');
    assert.equal(out.code, '按项目现有结构与规范写。');
    assert.equal(parseUiAutoPrompt('## 出码要求\n\n跟随项目风格').code, '跟随项目风格');

    const project = {
      id: 'p1',
      name: '演示项目',
      dir: '/tmp/demo',
      framework: 'playwright',
    } as Parameters<typeof buildUiPlanSystemPrompt>[0];
    const prompt = buildUiAgentSystemPrompt(project, 'ts', [], out.agent, out.code);
    assert.match(prompt, /探索正文/);
    assert.match(prompt, /按项目现有结构与规范写/);
    // 没有生成代码段时只给探索阶段那段
    const noCode = buildUiAgentSystemPrompt(project, 'ts', [], out.agent, '');
    assert.doesNotMatch(noCode, /生成代码/);
  });
});
