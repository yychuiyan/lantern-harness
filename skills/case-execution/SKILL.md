---
name: case-execution
description: 通过 Lantern 逐条执行已有测试用例、等待 AI 浏览器结果、人工确认后写回用例文件，并在失败或阻塞时衔接缺陷工作流。用于「执行某条用例」「查看执行进度」「确认执行结果」「把结果同步到执行统计」等请求；不用于生成或评审用例。
---

# Lantern 单条用例执行

Lantern 是执行记录、用例文件和确认结果的唯一持久化入口。使用 `lantern_case_execution_*` MCP 工具，不直接编辑 Excel、Markdown、CSV 或隐藏运行记录。

## 开始前

1. 调用 `lantern_case_execution_files`，确认目标文件具备「用例状态」和「实际结果」列。`.xls` 必须先另存为 `.xlsx`，缺少执行列的文件不能执行。
2. 调用 `lantern_case_execution_cases` 读取明细，按用例编号或标题定位唯一一行，并记录 `rowIndex`。
3. 确认测试地址。目标地址必须来自本次用户输入；不要沿用其他任务或空间中的地址。
4. 优先复用用户提供的 storageState 路径，或先检查是否已有保存登录态。需要本人完成验证码、扫码或账号登录时，调用 `lantern_case_execution_login_start`，由用户完成后再调用 `lantern_case_execution_login_complete`；不要在对话中索取或持久化账号密码。

## 执行

1. 每次只对用户指定的一条用例调用 `lantern_case_execution_start`，不要自行连续执行整份文件。
2. 调用后用 `lantern_case_execution_wait` 等待，未结束时继续按 `afterSeq` 读取新增日志和进度；等待期间向用户报告当前阶段、已用时和工具操作数。
3. 只有页面、截图、控制台或网络证据真正支持预期结果时才能建议「通过」。明确与预期不一致为「不通过」；登录失效、验证码、权限、测试数据或系统弹窗导致无法完成时为「阻塞」；用例不适用且理由充分时为「跳过」。
4. 不要替用户确认。向用户展示建议状态、实际结果、判定依据、未验证项和证据；用户可把状态改为「待验证 / 通过 / 不通过 / 阻塞 / 跳过」。
5. 需要停止时调用 `lantern_case_execution_stop`，保留已产生的日志和截图。

## 确认与后续

1. 用户明确确认后调用 `lantern_case_execution_apply`，只写回文件已有的执行列。文件已被外部修改时停止并重新读取，不能覆盖新内容。
2. 结果为「不通过」或「阻塞」时，主动提供创建缺陷入口，但不要在用户未要求时自动提交。用户要求提缺陷时，转入 `lantern-defect-submit`，把用例、目标地址、实际结果和证据作为待核验上下文。
3. 用户要求同步统计时，先调用 `lantern_case_execution_sync_stats` 的 `preview`。已有同日手工统计时不自动覆盖；只有用户明确选择后才使用 `skip` 或 `overwrite`。
4. 执行记录、日志和截图保存在当前空间的 `.lantern/local/case-execution/`。不要把这些内部文件加入 `用例管理/`，也不要把浏览器 Cookie、Token 或 API Key 写入结果。
