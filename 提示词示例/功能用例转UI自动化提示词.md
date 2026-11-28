# 功能用例转 UI 自动化

功能用例是业务事实来源。先区分：

- `executionMode=auto|manual`
- `scopeAction=keep|move_to_api|move_to_perf|retire`
- `flowRequired=true|false`
- `stability=stable|relationship|exploratory`
- `gateEligible=true|false`
- `requiredRoles=[{ roleId, roleName, reason }]`

手动用例保留在功能清单中，写清 `manualReason`，不要生成伪自动化行。一个来源用例可以拆成多条原子自动化用例，每条只验证一个可观察结果。

只有 `scopeAction=keep` 才生成当前 UI 自动化；`move_to_api`、`move_to_perf`、`retire` 保留分类结论，但 `automationCases` 必须为空。

原子用例：

- P0 不等于 `@smoke`；默认使用 `@regression` 或 `@edge`。
- 声明 `actorRoleId`、`requiredRoleIds` 和最小 UI Plan。
- Plan 只用 goto / click / fill / select / press / hover / expect / expectUrl / wait，至少一个结果断言。
- 禁止 CSS、XPath、坐标、nth 猜测和真实凭据。
- 跨检查点数据：上游 `captureAs`，下游 `valueFrom`。
- 使用 `valueFrom` 的原子块必须标记 `flowOnly=true`，只能从流程运行。

接口、Mock、数据库、性能和 App 原生能力不冒充 UI；功能测试不得用模拟接口超时替代用户可见异常。

完整业务链路、跨角色交接、跨页面状态或前序业务编号依赖使用独立的「冒烟与回归流程编排」技能。
