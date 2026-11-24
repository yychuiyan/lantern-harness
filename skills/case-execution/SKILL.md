---
name: case-execution
description: 通过 Lantern MCP 逐条执行已有测试用例、等待 AI 浏览器结果、人工确认后写回用例文件，并在失败或阻塞时衔接缺陷工作流。用于 Codex 明确要求执行某条用例、查看 MCP 执行进度、确认写回或同步统计；不用于页面手工记录、UI 自动化评估或脚本运行。
---

# Lantern 单条用例执行

Lantern 是执行记录、用例文件和确认结果的唯一持久化入口。使用 `lantern_case_execution_*` MCP 工具，不直接编辑 Excel、Markdown、CSV 或隐藏运行记录。

## 能力边界

- 本技能只覆盖 Codex MCP 发起的单条 AI 浏览器执行和执行计划。Lantern 用例执行页面已不展示 AI 执行入口。
- 页面的手工记录、执行统计筛选、自动化识别评估和“运行自动化”属于页面交互，不需要调用本技能。
- 自动化评估、生成、脚本探索和正式运行使用 `case-automation-bridge` 与 `lantern_case_automation_*` 工具，不要误用单条浏览器执行工具。

## 开始前

1. 调用 `lantern_case_execution_files`，确认目标文件具备「用例状态」和「实际结果」列。`.xls` 必须先另存为 `.xlsx`，缺少执行列的文件不能执行。
2. 调用 `lantern_case_execution_cases` 读取明细，按用例编号或标题定位唯一一行，并记录 `rowIndex`。
3. 确认测试地址。目标地址必须来自本次用户输入；不要沿用其他任务或空间中的地址。
4. 优先复用用户提供的 storageState 路径。需要本人完成验证码、扫码或账号登录时，调用 `lantern_case_execution_login_start`，由用户完成后再调用 `lantern_case_execution_login_complete`；不要在对话中索取或持久化账号密码。

## 执行

1. 每次只对用户指定的一条用例调用 `lantern_case_execution_start`，不要自行连续执行整份文件。
2. 调用后用 `lantern_case_execution_wait` 等待，未结束时继续按 `afterSeq` 读取新增日志和进度；等待期间向用户报告当前阶段、已用时和工具操作数。
3. 只有页面、截图、控制台或网络证据真正支持预期结果时才能建议「通过」。明确与预期不一致为「不通过」；登录失效、验证码、权限、测试数据或系统弹窗导致无法完成时为「阻塞」；用例不适用且理由充分时为「跳过」。
4. 不要替用户确认。向用户展示建议状态、实际结果、判定依据、未验证项和证据；用户可把状态改为「待验证 / 通过 / 不通过 / 阻塞 / 跳过」。
5. 需要停止时调用 `lantern_case_execution_stop`，保留已产生的日志和截图。
6. 目标地址只能访问本次授权的目标 origin 和明确允许的登录 origin。脚本跳转、弹窗和每次服务端重定向都受同一限制；出现「跨域导航已拦截」时把目标地址写进阻塞原因，不继续尝试绕过。

## 确认与后续

1. 用户明确确认后调用 `lantern_case_execution_apply`，只写回文件已有的执行列。文件已被外部修改时停止并重新读取，不能覆盖新内容。
2. 结果为「不通过」或「阻塞」时，主动提供创建缺陷入口，但不要在用户未要求时自动提交。用户要求提缺陷时，转入 `lantern-defect-submit`，把用例、目标地址、实际结果和证据作为待核验上下文。
3. 用户要求同步统计时，先调用 `lantern_case_execution_sync_stats` 的 `preview`。已有同日手工统计时不自动覆盖；只有用户明确选择后才使用 `skip` 或 `overwrite`。
4. 执行记录、日志和截图保存在当前空间的 `.lantern/local/case-execution/`。不要把这些内部文件加入 `用例管理/`，也不要把浏览器 Cookie、Token 或 API Key 写入结果。

## 基线、生成与计划

- Codex 生成用例使用 `lantern_case_generation_context` 读取当前空间技能和需求基线，生成 rows 后用 `validate` 确定性校验引用与覆盖，再用 `save` 携带原 revision 和 sourceFileHash 入库；源文件变更后必须重新读取。新文件自动具备执行列。
- 已有文件缺执行列时用 `lantern_case_execution_prepare_columns` 先 preview，用户确认后 apply；XLS 仍需另存为 XLSX。
- 用户明确要求批量执行并指定范围时，可创建执行计划；保存 caseIds、环境、角色、构建和数据说明后，显式启动。浏览器串行执行；API / App 使用已有自动化项目与指定测试文件，环境缺失应报告阻塞。准备和清理任务只能使用用户选定的项目任务。性能测试不在本轮能力中。
- 计划停止后不启动新项；重启后显式继续未完成项。计划和单条执行都不会自动选择最终结果。
- 使用稳定 caseId 对应原用例；需求基线或用例步骤变化后不能把旧通过计入新版本验收。基线重新关联须先 preview 并由用户确认，历史运行保留但结果要求人工复核。
- 页面支持维护「缺陷标题」和多个「缺陷信息」地址；本技能的 `lantern_case_execution_apply` 只写回执行状态、实际结果、执行人和 `defectNo`，不要假设 MCP 能直接修改缺陷标题或地址。
- `lantern_case_acceptance` 返回确定性的设计、执行与通过覆盖及未覆盖项；环境不同的结果要分开核验，报告不能当作缺陷关闭或性能验证证明。
