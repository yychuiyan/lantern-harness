---
name: case-automation-bridge
description: 将功能测试用例分成自动执行与手动执行，拆解为可执行的原子 UI 自动化用例，标记需要冒烟/回归流程的业务链路，并绑定角色、项目和 iteration 文件。
---

# 功能用例转 UI 自动化

## 适用范围

用于从已评审功能测试用例中提取 UI 自动化范围。功能用例仍是业务事实来源；本技能负责执行方式判断、原子自动化拆分、角色声明和 UI Plan 设计。

## 必做判断

每个来源用例都要明确：

- `executionMode`：`auto` 或 `manual`。
- `scopeAction`：`keep`、`move_to_api`、`move_to_perf` 或 `retire`。
- `flowRequired`：单条独立功能为 `false`；跨角色、跨页面、依赖前序结果或完整业务闭环为 `true`。
- `stability`：`stable`、`relationship` 或 `exploratory`。
- `gateEligible`：只有稳定自动用例、保留在功能范围且有可靠断言时可进入门禁。
- `requiredRoles`：稳定 `roleId`、中文 `roleName` 和用途；账号只引用环境变量。

首版运行器直接消费 `storageState`；`usernameEnv` / `passwordEnv` 只做登录 setup 登记，不会透明登录。storageState 缺失时必须阻断并提示补充。

手动用例仍留在功能用例清单中，写明 `manualReason`；不要生成伪自动化行，也不要删除原用例。

## 原子自动化

1. 一个来源用例可以拆成多条原子用例，每条只验证一个用户可观察结果。
2. P0 不会自动等于 `@smoke`。原子用例默认使用 `@regression` 或 `@edge`；`@smoke` 由独立流程编排产生。
3. 每条原子用例声明 `actorRoleId`、`requiredRoleIds` 和最小 UI Plan。
4. Plan 只允许 goto / click / fill / select / press / hover / expect / expectUrl / wait，至少一个结果断言。
5. 使用用户可见名称，禁止 CSS、XPath、坐标、nth 猜测和真实凭据。
6. 需要跨检查点传业务编号时，上游 `captureAs`，下游 `valueFrom`；只能引用真实前序捕获。
7. 只要 Plan 使用 `valueFrom`，该原子块必须标记 `flowOnly=true`，只能从冒烟/回归流程运行。

## 执行边界

- 接口、Mock、数据库、性能、App 原生操作归专项，不伪装成 UI。
- 只有 `scopeAction=keep` 才生成当前 UI 自动化；`move_to_api`、`move_to_perf`、`retire` 保留分类结论但不生成 `automationCases`。
- 功能测试不得通过模拟接口/服务超时来覆盖 UI 场景；改写为用户可操作的断网、空数据、权限不足或外部渠道不可用。
- 人工验证码、短信、扫码、原生弹窗、支付确认、文件选择器和线下动作默认手动；已有登录态可规避时再评估自动。

## 工具链

- `lantern_case_automation_cases`：读取稳定来源用例。
- `lantern_case_automation_assess`：按批评估与拆分。
- `lantern_case_automation_apply`：只写明确勾选的自动化用例并创建探索会话。
- `lantern_case_automation_flow_preview`：预览冒烟/回归流程、脚本和业务地图补丁。
- `lantern_case_automation_flow_create`：用户确认后写 iteration 文件、流程和地图。

## 禁止

- 不修改原功能用例，不覆盖人工执行结果。
- 不自动开始浏览器探索、写项目或运行脚本。
- 流程结果不能批量回写来源功能用例。
