---
name: automation-flow
description: 将已探索的原子 UI 自动化用例编排为冒烟与回归流程，处理多角色登录态、跨角色业务数据、检查点、业务地图补全和流程结果回写。
---

# 冒烟与回归流程编排

## 目标

把测试资产分成两条独立生产线：

1. 原子自动化证明单条功能结果；
2. 冒烟/回归流程证明多步骤、多角色或跨页面业务链路可走通。

流程通过只回写流程与检查点；不得批量把来源功能用例标为通过。

## 何时建流程

- 冒烟：最少检查点覆盖最关键业务闭环。
- 回归：覆盖变更影响范围内的完整链路和关键分支。
- 单功能独立验证不需要流程。
- 跨角色交接、跨页面状态、后序依赖前序业务编号、链路不可分割时必须建流程。

## 执行顺序

- 至少选择两条已接入且有步骤 IR 的原子用例。
- `flowOnly=true` 的原子块可以进入流程，但不能单独运行。
- 按真实业务顺序编排，允许上下调整；不按文件顺序机械拼接。
- 排除过期、缺角色、定位不稳定或不可执行的原子用例。

## 角色和数据

- 每个角色独立 Browser Context 和 storageState。
- 只保存环境变量名和登录态路径，不保存账号密码。
- 首版脚本直接消费 storageState；仅登记账号/密码环境变量不会让运行器自动透明登录。
- 缺角色登录态时生成前置阻断，并列出待补角色。
- 业务编号等数据通过 `flowData` 从上游 `captureAs` 传到下游 `valueFrom`。
- 生成前按执行顺序校验 `valueFrom`；缺少前序 `captureAs` 时必须阻断，不能生成会在运行时才报错的脚本。

## 检查点

每个检查点记录标题、角色、来源原子用例和可观察预期。运行结果为 `pending / passed / failed / blocked / not_reached / skipped`。

失败分类至少覆盖：

- environment
- login
- missing_role
- role_permission_mismatch
- role_session_expired
- locator
- test_data
- assertion
- dependency

失败后的后续检查点标 `not_reached`，不能默认通过。

## 业务地图

- 只追加缺失目录、功能和流程步骤。
- 不覆盖人工锁定字段，不移动或重命名已有内容。
- 写入前预览补丁；写入必须携带最新 revision，冲突时整批中止。

## 脚本与回写

- 首版只生成 Playwright + TypeScript。
- 流程含相对地址时，每个角色 Context 必须继承项目 baseURL；项目未配置 baseURL 时在生成前阻断。
- 使用 `test.step` 表达检查点。
- 合并到目标 iteration 文件时只替换当前 `flowCaseId` 的测试块。
- 通过 `lantern_case_automation_flow_preview` 预览，用户明确确认后再调用 `lantern_case_automation_flow_create`。
