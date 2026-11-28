export const CASE_AUTOMATION_PROMPT_FILE = '功能用例转UI自动化提示词.md';
export const CASE_AUTOMATION_FLOW_PROMPT_FILE = '冒烟与回归流程编排.md';

export const CASE_AUTOMATION_PROMPT_TEMPLATE = `# 功能用例转 UI 自动化

你负责把已经评审过的功能测试用例转换成可进入 UI 自动化探索阶段的自动化用例。原功能用例是业务事实来源；不要改写需求，不要虚构页面、按钮、数据或业务规则。

## 1. 先决定执行方式

每个来源功能用例必须明确：

- \`executionMode: auto\`：可通过浏览器 UI 操作并在页面观察结果。
- \`executionMode: manual\`：仍属于功能测试，但当前无法稳定自动化，例如人工验证码、短信、扫码、系统原生弹窗、支付确认、文件选择器、人工听音、线下操作或不可逆高风险确认。
- \`scopeAction\`：\`keep\`（保留功能手工/自动化执行）、\`move_to_api\`（应转接口）、\`move_to_perf\`（应转性能）、\`retire\`（重复或失效）。
- 只有 \`scopeAction=keep\` 才允许生成当前 UI 自动化用例。\`move_to_api\` / \`move_to_perf\` / \`retire\` 必须保留分类结论，但 \`automationCases\` 为空。

手动和专项用例仍要保留在功能用例清单中，不要生成伪自动化行，也不要从功能测试范围里删除。

## 2. 判断边界

- 只有可通过 Web/浏览器 UI 操作并在页面观察结果的用例，才标记为 \`automatable\`。
- 需要人工输入验证码、短信、扫码、系统原生弹窗、支付确认、文件选择器、人工听音或线下动作，且已有登录态无法规避时，标记为 \`needs_manual\`，并写清 \`manualReason\`。
- 接口、抓包、Mock、数据库断言、性能压测、App 原生操作不属于当前 UI 自动化范围，标记为 \`not_automatable\`；需要转到接口或性能的，用 \`scopeAction\` 明确。
- 功能测试不得通过“模拟接口超时、Mock 服务、断言状态码”等方式伪造 UI 场景。需要模拟异常时，优先写成用户可操作的断网、空数据、权限不足、外部渠道不可用；否则归入对应专项。
- 数据不足、预期不可观察或步骤无法执行的，不得猜成可自动化。

## 3. 原子自动化用例

- 一个来源用例可以拆成多条独立原子自动化用例；每条只验证一个用户可观察结果。
- 优先级沿用来源用例 P0-P3。标签按结果性质使用 \`@regression\` 或 \`@edge\`；不要仅因 P0 就标 \`@smoke\`。\`@smoke\` 只用于跨功能的核心业务链路，由冒烟流程编排产生。
- 每条原子用例必须声明执行角色：
  - \`requiredRoles\`：来源级别列出本用例需要的全部角色，使用稳定的英文 \`roleId\`（如 \`clerk\`、\`auditor\`）和中文 \`roleName\`。
  - \`actorRoleId\` / \`requiredRoleIds\`：自动化用例级别声明实际执行角色。账号密码只引用环境变量，不写真实值。
  - 首版脚本只直接消费 \`storageState\`；\`usernameEnv\` / \`passwordEnv\` 用于登录 setup 登记，不会让运行器透明登录。storageState 缺失时必须阻断并提示用户补充。
- \`stability\`：
  - \`stable\`：核心、独立、可重复；
  - \`relationship\`：依赖前序业务数据或多角色衔接；
  - \`exploratory\`：结果有判断空间或页面仍在变化。
- \`flowRequired\`：只在存在跨角色交接、跨页面业务状态、依赖前序结果、完整业务闭环或单条功能不足以证明链路可走通时为 \`true\`；单条独立功能为 \`false\`。
- \`gateEligible\`：只有 \`executionMode=auto\`、\`stability\` 非 exploratory、\`scopeAction=keep\` 且断言稳定时才为 \`true\`。

### UI Plan 规则

- 只使用 goto / click / fill / select / press / hover / expect / expectUrl / wait。
- 至少包含一个 \`expect\` 或 \`expectUrl\`。
- 使用用户可见的菜单、按钮、输入框和字段名称；禁止 CSS、XPath、坐标、nth 猜测和真实凭据。
- 环境相关账号、密码、手机号使用 \${ENV_NAME} 占位。
- 流程需要传递业务数据时，上游写 \`captureAs\`（如 \`ticketNo\`），下游写 \`valueFrom\`；只能引用前序真实捕获，不能虚构。
- 原子块只要出现 \`valueFrom\`，就必须标记 \`flowOnly: true\`；它只能进入冒烟/回归流程，禁止单独运行。
- 步骤必须能按顺序执行。不要用“见前置条件”“同上”“按业务规则操作”等不可执行描述。

## 4. 人工执行信息

\`executionMode=manual\` 时必须填写：

- \`manualReason\`：具体阻断原因；
- \`precondition\`：人工执行所需账号、角色、数据和环境；
- 可执行的人工步骤和预期仍以原功能用例为准，不改写来源。

## 5. 输出

只输出一个 JSON 对象，不要代码围栏：

{
  "summary": "一句话",
  "cases": [
    {
      "sourceCaseId": "原用例稳定 ID",
      "decision": "automatable | needs_manual | not_automatable",
      "executionMode": "auto | manual",
      "scopeAction": "keep | move_to_api | move_to_perf | retire",
      "manualReason": "",
      "flowRequired": false,
      "stability": "stable | relationship | exploratory",
      "gateEligible": true,
      "requiredRoles": [
        { "roleId": "clerk", "roleName": "受理员", "reason": "创建工单" }
      ],
      "reason": "判断依据",
      "risks": ["风险"],
      "automationCases": [
        {
          "title": "一句清楚的业务行为",
          "precondition": "账号/角色、测试数据和系统状态",
          "steps": ["打开页面", "输入…", "点击…", "看到…"],
          "expected": "页面可观察结果",
          "priority": "P0",
          "tag": "@regression",
          "flowOnly": false,
          "actorRoleId": "clerk",
          "requiredRoleIds": ["clerk"],
          "plan": [
            {
              "id": "p1",
              "action": "goto",
              "url": "/",
              "target": "目标页面",
              "note": "为什么做这一步"
            }
          ]
        }
      ]
    }
  ]
}

不是 \`automatable\`、\`executionMode=manual\` 或 \`scopeAction!=keep\` 时，\`automationCases\` 必须为空。`;

export const CASE_AUTOMATION_FLOW_PROMPT_TEMPLATE = `# 冒烟与回归流程编排

你负责把已经生成并完成探索的原子 UI 自动化用例编排成两条独立生产线：

1. 原子自动化：证明某一条功能用例的结果；
2. 冒烟 / 回归流程：证明多个功能、多个角色或跨页面业务链路能按顺序走通。

流程通过不能批量把来源功能用例标为通过；流程只回写自己的检查点和流程结果。

## 何时需要流程

- 冒烟：最少检查点覆盖最关键业务闭环，回答“系统今天能不能完成主业务”。
- 回归：覆盖变更影响范围内的完整链路和关键分支，回答“改完后原业务是否仍可用”。
- 单条独立功能不需要流程。
- 出现以下任一情况必须建立流程：跨角色交接、跨系统/页面状态传递、后序依赖前序生成的业务编号、多个步骤共同组成不可分割业务结果、单独执行原子块无法证明链路可走通。

## 选择原子用例

- 至少两条已接入且有步骤 IR 的原子用例。
- \`flowOnly=true\` 的原子块可以进入流程，但不能单独运行。
- 优先按业务顺序选择，不按文件顺序机械拼接。
- 排除不稳定、已过期、缺角色登录态或无法独立定位的原子用例。
- 同一原子用例可进入不同冒烟/回归流程，但每次都应产生独立 \`flowCaseId\`。

## 角色与数据

- 每个角色绑定独立 Browser Context 和独立 storageState；不共享 Cookie。
- 账号密码只使用环境变量名，绝不能写入脚本。
- 跨角色业务数据通过 \`flowData\` 传递：上游 \`captureAs\`，下游 \`valueFrom\`。
- 生成前按执行顺序校验 \`valueFrom\`；缺少前序 \`captureAs\` 时必须阻断，不能生成会在运行时才报错的脚本。
- 缺角色、storageState 缺失、角色权限不匹配时必须在生成前阻断，并列出需要用户补充的角色。
- 登录态过期、无权限、缺少测试数据时，检查点标为阻塞，不要误报为产品失败。

## 检查点

每个业务动作组必须形成一个检查点，包含：

- 检查点标题；
- 执行角色；
- 来源原子用例；
- 可观察预期；
- 运行结果：pending / passed / failed / blocked / not_reached / skipped；
- 失败分类：environment / login / missing_role / role_permission_mismatch / role_session_expired / locator / test_data / assertion / dependency。

失败后后续检查点统一标为 not_reached，不能默认通过。

## 业务地图

- 流程能走通但业务地图缺目录、功能或流程步骤时，只追加缺失内容。
- 不覆盖人工锁定字段，不重命名、不移动既有内容。
- 写入必须携带业务地图 revision；冲突时整批中止并重新预览。
- 写入前展示补丁：新增目录、功能、流程步骤。

## 脚本编排

- 当前首版只产出 Playwright + TypeScript。
- 每个角色独立 \`browser.newContext({ storageState })\`。
- 流程含相对地址时，每个角色 Context 必须继承项目 baseURL；项目未配置 baseURL 且步骤使用相对地址时必须在生成前阻断。
- 首版脚本只直接消费 storageState；仅登记账号/密码环境变量不会自动透明登录。
- 使用 \`test.step\` 表达检查点，保证报告能逐项回写。
- 用 \`@smoke\` 或 \`@regression\` 表示流程层级，并额外带稳定 \`@lantern-<flowCaseId>\` 标签。
- 合并到目标 iteration 文件时只替换当前 \`flowCaseId\` 的测试块，保留其他人和其他流程。
- 运行结果只回写流程用例与检查点；来源功能用例仅在各自原子用例全部通过时由原子链路回写。

## 输出

先输出流程草案供用户确认：

{
  "title": "业务流程标题",
  "kind": "smoke | regression",
  "sourceAutomationCaseIds": ["AUTO-..."],
  "requiredRoles": [{ "roleId": "clerk", "roleName": "受理员" }],
  "checkpoints": [
    {
      "title": "检查点标题",
      "actorRoleId": "clerk",
      "automationCaseId": "AUTO-...",
      "expected": "可观察结果"
    }
  ],
  "businessMapPatch": {
    "systemId": "业务系统 ID",
    "flowId": "已有或新建流程 ID",
    "createdDirectories": [],
    "addedFunctions": [],
    "addedStepTitles": []
  },
  "scriptPath": "tests/iteration/v1.0.spec.ts"
}

用户确认网页预览后才允许写入项目、会话和业务地图。`;
