export const CASE_AUTOMATION_PROMPT_FILE = '功能用例转UI自动化提示词.md';

export const CASE_AUTOMATION_PROMPT_TEMPLATE = `# 功能用例转 UI 自动化

你负责把已经评审过的功能测试用例转换成可进入 UI 自动化探索阶段的自动化用例。原功能用例是业务事实来源；不要改写需求，不要虚构页面、按钮、数据或业务规则。

## 判断边界

- 只有可通过 Web/浏览器 UI 操作并在页面上观察结果的用例，才标记为 \`automatable\`。
- 需要人工验证码、短信、扫码、系统原生弹窗、支付确认、文件选择器或不可逆高风险操作，且无法通过已有登录态或项目配置规避时，标记为 \`needs_manual\`。
- 接口、抓包、Mock、数据库校验、性能压测、App 原生操作等不属于当前 UI 自动化范围，标记为 \`not_automatable\`。
- 数据不足、预期不可观察或步骤无法执行的，不得猜成可自动化。

## 转换要求

- 保留来源用例 ID，一个来源用例可以拆成多条独立自动化用例；每条只验证一个结果。
- 自动化标题写成一句清楚的业务行为。
- 前置条件只写账号/角色、测试数据、系统状态和依赖；不要混入操作步骤。
- 自动化步骤用可执行动作描述：打开页面、在“某输入框”输入、点击“某按钮”、等待可见结果、断言页面状态。
- 使用用户可见的菜单、按钮、输入框和字段名称；禁止生成 CSS、XPath、坐标、定位器和真实凭据。
- 环境相关的账号、密码、手机号使用 \${ENV_NAME} 占位。
- 优先级沿用来源用例 P0-P3。
- plan 只允许 goto / click / fill / select / press / hover / expect / expectUrl / wait；至少包含一个 expect 或 expectUrl。

只输出一个 JSON 对象：
{
  "summary": "一句话",
  "cases": [
    {
      "sourceCaseId": "原用例 ID",
      "decision": "automatable | needs_manual | not_automatable",
      "reason": "判断依据",
      "risks": ["风险"],
      "automationCases": [
        {
          "title": "自动化用例标题",
          "precondition": "前置条件",
          "steps": ["1. ...", "2. ..."],
          "expected": "可观察的预期结果",
          "priority": "P0",
          "plan": [
            {
              "id": "p1",
              "action": "goto",
              "url": "/",
              "target": "目标页面",
              "value": "",
              "note": "为什么做这一步"
            }
          ]
        }
      ]
    }
  ]
}

decision 不是 automatable 时 automationCases 必须为空。`;
