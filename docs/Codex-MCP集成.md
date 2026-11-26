# Codex MCP 集成

`lantern mcp` 将当前 Lantern 空间的能力以 stdio MCP 工具暴露给 MCP 客户端。Codex 是现成接入示例，其他客户端或编排器直接调用同一组结构化工具即可，不需要打开 Lantern 页面点击按钮。

协议本身不限定 Codex。任何支持 stdio MCP 的客户端、模型或编排器都可以调用同一组工具；下文的 Codex 配置、审批和示例是当前最常见的接入方式。

## 能做什么

- 发现并调用当前空间已连接的外接 MCP（包括腾讯文档），复用 Lantern 连接、凭据和远端权限
- 查看当前数据空间与可用技能
- 加载需求分析、原文结构和测试点技能
- 将 Codex 收到的需求文档导入 `需求文档库`
- 读取需求源文并返回拆解所需上下文
- 保存、单条修改和删除用户故事
- 保存故事审查结果和测试点
- 读取业务地图系统、目录、功能和流程，并通过 revision 保护进行增删改
- 启动、停止、恢复和等待业务地图 AI 目录 / 流程识别，并应用等待确认的草案
- 逐条启动、等待、停止和确认 AI 浏览器用例执行，并把结果同步到执行统计
- 读取场景补全结果，预览选中条目的真实行和插入位置，再原子写回并返回逐项回执
- 从真实用例、测试统计和执行统计整理测试报告，校验草稿后原子保存
- 批量审阅 Lantern 自有记忆建议，预览目标轨和重复项后采纳或拒绝
- 按功能、接口、性能、自动化类型生成并分类保存测试用例
- 挂载或生成 UI 自动化项目、安装项目环境
- 将功能用例评估和拆分为自动化用例，绑定 iteration 并生成 UI Plan
- 通过受控浏览器探索定位器、预览和试跑脚本，再合并到项目 iteration 文件
- 正式运行自动化批次、轮询结果、停止运行和返回报告
- 返回 `analysisId`、产物路径和 Lantern 页面链接

首版采用“Codex 推理、Lantern 持久化”的委托分析模式：Codex 读取 Lantern 技能正文和需求内容后生成结构化结果，再由 Lantern 校验、编号和落盘。

导入同名文件时默认保留原文件，并在新文件名后追加导入时间和递增序号；只有显式设置 `overwrite=true` 才会覆盖。

## 工具清单

| 工具                                                                         | 用途                                     | 写入       |
| ---------------------------------------------------------------------------- | ---------------------------------------- | ---------- |
| `lantern_mcp_tools` / `lantern_mcp_call`                                     | 发现并复用当前空间外接 MCP 工具          | 调用可写   |
| `lantern_status` / `lantern_space_list`                                      | 检查服务和活动空间                       | 否         |
| `lantern_requirement_prepare`                                                | 启用需求链路插件、补种并迁移技能         | 是         |
| `lantern_skill_list` / `lantern_skill_load` / `lantern_skill_validate`       | 查看启用技能、加载规则、校验输出         | 否         |
| `lantern_requirement_list` / `lantern_requirement_sources`                   | 浏览需求文档和可分析来源                 | 否         |
| `lantern_requirement_import`                                                 | 将本地需求文档导入 Lantern               | 是         |
| `lantern_requirement_context`                                                | 读取来源正文、分析规则和输出契约         | 否         |
| `lantern_requirement_analysis_list`                                          | 列出已有分析、来源、状态和版本           | 否         |
| `lantern_requirement_analysis_get`                                           | 读取最新分析及 `revision`                | 否         |
| `lantern_requirement_analysis_save`                                          | 新建分析或完整保存拆解结果               | 是         |
| `lantern_requirement_analysis_delete`                                        | 批量删除需求分析记录                     | 是         |
| `lantern_requirement_story_patch`                                            | 增量修改一条用户故事                     | 是         |
| `lantern_requirement_story_delete`                                           | 删除一条故事并清理关联测试点             | 是         |
| `lantern_requirement_review_context`                                         | 读取故事、来源正文和审查规则             | 否         |
| `lantern_requirement_review_save`                                            | 保存故事审查结果                         | 是         |
| `lantern_testpoints_context`                                                 | 读取故事、测试点规则和输出契约           | 否         |
| `lantern_testpoints_save`                                                    | 保存测试点报告                           | 是         |
| `lantern_requirement_breakdown_list`                                         | 浏览和过滤本地需求拆解 XMind             | 否         |
| `lantern_requirement_breakdown_get`                                          | 读取拆解条目和最新 XMind 内容            | 否         |
| `lantern_requirement_breakdown_import`                                       | 导入 Codex 可访问的本地 XMind            | 是         |
| `lantern_requirement_breakdown_backfill_candidates`                          | 查找可补录且未入库的历史分析             | 否         |
| `lantern_requirement_breakdown_record_analysis`                              | 从历史需求分析生成并补录 XMind           | 是         |
| `lantern_requirement_breakdown_retry`                                        | 重新生成缺失的自动 XMind                 | 是         |
| `lantern_requirement_breakdown_update`                                       | 修改显示标题或备注并同步文件名           | 是         |
| `lantern_requirement_breakdown_open`                                         | 用系统默认程序打开本地 XMind             | 否         |
| `lantern_requirement_breakdown_delete`                                       | 删除条目并把文件移入系统废纸篓           | 是         |
| `lantern_business_map_list` / `lantern_business_map_get`                     | 查看业务系统、目录、功能和流程           | 否         |
| `lantern_business_login_status`                                              | 查看登录方式、密码和登录态状态           | 否         |
| `lantern_business_login_start` / `complete` / `cancel`                       | 使用已保存配置验证、完成或取消登录       | 是         |
| `lantern_business_material_list` / `upload` / `delete`                       | 管理业务地图本地识别资料                 | 是         |
| `lantern_business_system_save` / `lantern_business_system_delete`            | 新建、修改、删除业务系统                 | 是         |
| `lantern_business_directory_save` / `lantern_business_directory_delete`      | 新建、修改、删除功能目录                 | 是         |
| `lantern_business_tree_move`                                                 | 移动目录或功能并调整同级顺序             | 是         |
| `lantern_business_function_save` / `lantern_business_function_delete`        | 新建、修改、删除业务功能                 | 是         |
| `lantern_business_flow_save` / `lantern_business_flow_delete`                | 新建、修改、删除业务流程                 | 是         |
| `lantern_business_assistant_get` / `wait` / `context`                        | 查看会话、等待结果或读取调用方兜底上下文 | 否         |
| `lantern_business_assistant_send`                                            | 启动目录或流程识别                       | 是         |
| `lantern_business_assistant_stop` / `lantern_business_assistant_reset`       | 停止或重置 AI 会话                       | 是         |
| `lantern_business_assistant_apply`                                           | 应用等待确认的目录 / 流程草案            | 是         |
| `lantern_case_execution_files` / `lantern_case_execution_cases`              | 列出用例文件、执行列和单条明细           | 否         |
| `lantern_case_execution_login_start` / `complete`                            | 打开登录页并由用户完成手动登录           | 是         |
| `lantern_case_execution_start`                                               | 启动单条用例 AI 浏览器执行               | 是         |
| `lantern_case_execution_get` / `wait`                                        | 读取进度、日志和待确认结果               | 否         |
| `lantern_case_execution_stop`                                                | 停止当前单条执行并保留证据               | 是         |
| `lantern_case_execution_apply`                                               | 人工确认后写回已有执行列                 | 是         |
| `lantern_case_execution_sync_stats`                                          | 预览或明确同步到用例执行统计             | 是         |
| `lantern_case_blindspot_context`                                             | 读取场景补全条目、文件哈希和补全状态     | 否         |
| `lantern_case_blindspot_save`                                                | 按文件哈希保存模型探测到的补全候选       | 是         |
| `lantern_case_blindspot_draft` / `apply`                                     | 预览并确认写回场景补全                   | 是         |
| `lantern_test_report_context`                                                | 读取真实用例、统计、执行记录与报告缺口   | 否         |
| `lantern_test_report_draft` / `apply`                                        | 校验报告草稿并原子写入目标报告           | 是         |
| `lantern_memory_suggestion_context`                                          | 读取 Lantern 记忆建议和 revision         | 否         |
| `lantern_memory_suggestion_draft` / `apply`                                  | 预览并批量采纳或拒绝 Lantern 记忆建议    | 是         |
| `lantern_case_generation_setup`                                              | 显示类型、需求、故事、测试点和上下文配置 | 否         |
| `lantern_case_generation_context` / `validate` / `save`                      | 按类型生成、校验并保存用例文件           | 保存为是   |
| `lantern_uiauto_projects` / `project_mount` / `project_update`               | 查看、挂载或配置现有 UI 自动化项目       | 写为是     |
| `lantern_uiauto_project_scaffold_preview` / `scaffold_create`                | 预览或生成 UI 自动化项目骨架             | 创建为是   |
| `lantern_uiauto_project_setup_start` / `get` / `stop`                        | 安装项目依赖并读取安装进度               | 是         |
| `lantern_case_automation_cases` / `iterations` / `status`                    | 读取功能用例、iteration 和自动化状态     | 否         |
| `lantern_case_automation_assess` / `apply`                                   | 评估功能用例并应用自动化用例与 UI Plan   | 是         |
| `lantern_case_automation_run` / `run_get` / `run_wait` / `run_stop`          | 正式运行、等待和停止自动化批次           | 运行写为是 |
| `lantern_uiauto_agent_session_get` / `open` / `snapshot` / `action` / `wait` | 读取会话并探索目标系统                   | 操作为是   |
| `lantern_uiauto_agent_probe` / `save` / `emit` / `verify` / `write`          | 绑定定位器、预览、试跑并写入项目         | 写为是     |
| `lantern_uiauto_agent_close`                                                 | 关闭探索浏览器并保留会话                 | 是         |

## 需求拆解库

需求拆解库面向实际本地文件：需求分析成功保存原文结构后，Lantern 会在 `需求拆解库/` 根目录生成平铺的 `..._需求拆解.xmind`；Codex 也能直接管理同一份文件，而不是操作浏览器下载或库内快照。列表元数据放在空间隐藏目录，不出现在用户内容目录中。

1. 调用 `lantern_requirement_breakdown_list` 获取库 `revision`，可按标题、文件名、来源、项目、迭代、备注、`generated` / `uploaded` 过滤。
2. 调用 `lantern_requirement_breakdown_get` 读取单条；`includeContent=true` 会解析磁盘上的最新 `content.json`，旧文件回退读取 `content.xml`，因此能看到用户在 XMind 客户端里手工修改后的内容。
3. 导入本地文件用 `lantern_requirement_breakdown_import`，传入 Codex 可访问的 `.xmind` 绝对路径；可选项目、迭代和备注。服务端会校验文件格式与 25MB 上限。
4. 历史分析需要显式补录：先调用 `lantern_requirement_breakdown_backfill_candidates` 查找已包含原文结构且尚未入库的分析，再确认当前 revision，调用 `lantern_requirement_breakdown_record_analysis` 和一组 `analysisIds`。插件首次开启不会自动搬全部历史。
5. `update` 只修改显示标题和备注；标题变化会同步重命名实际文件。`retry` 从原需求分析重新生成文件，`open` 用系统默认程序打开，`delete` 将文件移入系统废纸篓后移除记录。
6. 导入、补录、重新生成、修改、删除都必须携带读取到的最新 `expectedRevision`；冲突返回当前 revision，重新读取后再操作。

需求分析页不再提供一次性「原文 XMind」下载；开启需求拆解库后自动入库。需求拆解库关闭时不会自动生成，但已有文件仍可在开启需求分析之外单独管理。

## 复用 Lantern 外接 MCP

`lantern_mcp_tools` 和 `lantern_mcp_call` 将工作台已有的 `/__tb_mcp/tools`、`/__tb_mcp/call` 提供给 Codex，无需在 Codex 再配置腾讯文档 Token 或其他服务凭据。

1. 调用 `lantern_mcp_tools`，可传 `server: "tencent-docs"` 或 `query` 按工具名、说明过滤。返回真实 `name`、`remoteName`、`inputSchema`、远端 annotations，以及 `connected` 和 `errors`；部分服务连接失败不会隐藏其他可用工具。
2. 按返回的 `inputSchema` 构造参数，通过 `lantern_mcp_call` 传入完整 `name` 和 `arguments`。例如查询其他腾讯文档时，先发现列出子表、字段和记录的工具，再按真实定义传入目标文档 ID；不再局限于缺陷规则配置的目标表。
3. 工具执行时会重新核对当前活动空间的目录，移除的工具或其他空间独有的工具不能继续调用。更改空间或连接配置后重新发现即可，无需逐个注册远端工具。
4. 返回远端原始内容（包括图片、资源）和结构化结果，保留远端错误标志，不自动重试写入。已有 HTTP 服务尚未更新时兼容旧文本结果；要使用完整原始内容透传，需重启更新后的 Lantern 服务。

发现工具只读；通用调用同时支持读写，按可能产生外部写入标注审批，不能统一当作只读。权限仍由当前空间配置的远端服务决定，不支持绕过授权或在调用参数中替换凭据。业务写入还应符合用户授权；提交缺陷优先使用 `lantern_defect_*` 保留草稿校验和回执流程。

更新后重启 `lantern mcp` 并新建 Codex 会话，使两个新入口进入工具列表。已有会话的工具目录不会因为源码更新自动增加入口。

## 业务地图

业务地图 MCP 直接使用 `/__tb_business_map` 的现有 API，不直接修改 JSON：

1. 先调用 `lantern_business_map_list` 获取 `revision`。
2. 调用 `lantern_business_map_get` 读取指定系统；可用 `directoryId`、`functionId`、`flowId` 或 `query` 缩小范围，证据默认省略。
3. 页面识别前用 `lantern_business_login_status` 检查登录配置和登录态；需要验证时调用 `lantern_business_login_start`，用户在打开页面完成验证码 / 扫码后调用 `complete`，放弃时调用 `cancel`。工具不接收密码。
4. 用 `lantern_business_material_list` 查看已上传资料，用 `upload` 传本地绝对路径，用 `delete` 按文件名删除；单文件上限 25MB。
5. 所有写工具必须携带读取到的 `expectedRevision`；地图被页面或其他 Codex 会话修改后返回 `409`，当前 revision 从错误 details 中读取。
6. 目录删除遇到非空目录会返回 `impact`，确认后传 `cascade=true` 再执行。
7. 流程步骤中的 `functionId` 必须引用已有功能；未知或失效关联由 Lantern 服务端校验。

AI 识别工作流：

1. `lantern_business_assistant_send` 启动 `directory` 或 `flow` 阶段，调用后立即返回。
2. `lantern_business_assistant_wait` 轮询至回合结束，或用 `lantern_business_assistant_get` 配合 `afterSeq` 只取新增日志。
3. 草案进入 `awaiting_confirmation` 后，检查 `proposal`。
4. 读取最新地图 revision，再调用 `lantern_business_assistant_apply` 应用草案。
5. 需要中止时调用 `lantern_business_assistant_stop`；需要清空会话时调用 `lantern_business_assistant_reset`。

AI 发送工具从 Lantern 当前模型配置读取 `baseURL/model/apiKey`，不接受、也不会在返回值或日志中暴露 API Key。目录未应用时，服务端拒绝开始流程识别。

生成与用户确认是两条独立链路：`send` / `wait` 只产生草案，不修改正式地图；只有 `apply` 才写入。应用不会整体清空或替换现有地图，未出现在草案中的目录、功能和流程会保留；同名目录 / 功能会合并草案字段，同名流程会更新草案步骤与结果。

调用方模型 / 编排器兜底：

1. 会话以 `error` 或 `interrupted` 结束时，先查看 `session.fallback` 的 `available`、`recommendedAction`、页面数、菜单数、证据数和失败原因。
2. `recommendedAction="client_fallback"`（兼容旧值 `codex_fallback`）时调用 `lantern_business_assistant_context`，读取页面检查点、当前目录/功能/流程和压缩后的页面证据。上下文默认不超过 50000 字符，可按页面限制正文长度。
3. 调用方模型或编排器只依据返回的菜单、页面或用户资料生成资产，再通过 system / directory / function / flow 保存工具写入最新 revision。失败会话没有可应用的草案，不能调用 `assistant_apply`。
4. `recommendedAction="retry_login"` 时必须先重新验证登录态；`fix_capture` 时必须检查入口、权限或采集范围。没有页面或菜单证据时不得生成业务地图内容。
5. 客户端兜底不会绕过 revision、校验或“低置信度/草稿”标记；接管由当前 MCP 会话显式完成，Lantern 服务不需要知道调用方是哪一个模型。

## 串联编排

MCP 工具可以按以下方式组合，不要求固定先后：

- **前置**：调用方准备需求结构、页面计划、字段映射或候选内容，再让 Lantern 校验、执行自动化或保存。
- **后置**：Lantern 先采集页面、运行 AI 或自动化，调用方再复核、去重、补全或归纳，最后由 Lantern 正式写回。
- **往返**：调用方规划 → Lantern 执行 → 调用方复核 → Lantern 再执行或保存，可多次交替。
- **失败接管**：Lantern 自有 AI 先运行；超时、中断或空结果时读取兜底上下文，由调用方继续。
- **多代理**：协调者或子代理可以拆分发现、审查和生成工作，但只能依据真实工具结果和最新 revision 判断已落库。

所有模式都以 Lantern 为执行和持久化边界。调用方不得直接编辑 Lantern JSON，也不得把中间草案、计划或对话内容当成已保存结果。

## 用例生成与 UI 自动化闭环

用例保存通过 `lantern_case_generation_save` 的 `caseType` 选择类型。省略 `folder` 时，功能 / 接口 / 性能 / 自动化分别落到 `用例管理/功能测试/`、`接口测试/`、`性能测试/`、`自动化测试/`；显式传 `folder` 才使用自定义目录。文件会实际落盘，不会只在数据库里生成一条记录。

UI 自动化闭环分为项目、转换、探索、写盘和正式运行五段：

1. `lantern_uiauto_projects` 查找项目。已有目录用 `lantern_uiauto_project_mount` 挂载；没有项目且用户要求自动创建时，先 `lantern_uiauto_project_scaffold_preview`，再 `lantern_uiauto_project_scaffold_create`。
2. `lantern_uiauto_project_setup_start` 安装依赖和浏览器运行时，使用 `setup_get` 轮询日志；失败或阻塞时保留现场。
3. `lantern_case_automation_cases` 读取稳定来源用例 ID，`lantern_case_automation_iterations` 读取项目现有 iteration 和自动建议。
4. `lantern_case_automation_assess` 评估明确选择的功能用例并生成自动化用例和 UI Plan。评估记录写入本机缓存，但正式用例文件和项目尚未修改。
5. 用户确认后 `lantern_case_automation_apply` 写入 `用例管理/自动化测试/` 并创建绑定 `automationCaseId`、目标 iteration 文件和脚本的生成会话。
6. 对返回的 `uiSessionId` 使用 `lantern_uiauto_agent_session_get`；用 `open`、`snapshot`、`action`、`wait`、`probe` 在当前目标系统中探索并绑定定位器。工具只操作目标系统，不点击 Lantern 页面。
7. `lantern_uiauto_agent_save` 保存 Plan / IR，`lantern_uiauto_agent_emit` 预览 spec、page object 和 fixture。`lantern_uiauto_agent_verify` 在隔离草稿中试跑；通过后再用 `lantern_uiauto_agent_write` 合并到项目 iteration 文件。
8. `lantern_case_automation_run` 启动正式批次，使用 `run_wait` / `run_get` 读取逐 automationCaseId 结果。只有全部关联自动化通过，且源用例没有人工结果时，才同步源用例执行结果。

项目骨架创建不会接管任意非空目录；父目录和目标路径由调用方显式提供。`agent_verify` 可能运行较久，Codex 配置建议把 `tool_timeout_sec` 提高到 240。任一 revision、文件哈希或源指纹冲突都必须重新读取，不能重放旧 payload。

## 用例执行

用例执行通过 `/__tb_case_run` 使用同一套执行记录、登录态和写回保护。首版只做单条用例，不自动连续跑整份文件。Codex MCP 完成执行后保留待确认结果，只有用户确认后才调用 `apply`。Lantern 用例执行页面已不再展示 AI 浏览器执行和执行计划入口，该能力仅作为 MCP 兼容链路保留；页面继续支持手工记录、按文件或勾选用例自动化识别评估、已接入自动化运行和统计同步。

1. 调用 `lantern_case_execution_files` 找到 `用例管理/` 下的目标文件，确认 `executable=true`。文件必须已有状态和实际结果列；`.xls` 只可读取，需先另存为 `.xlsx`。
2. 调用 `lantern_case_execution_cases`，按用例编号或标题定位唯一行并取得 `rowIndex`（从 0 开始的用例索引，不是 Excel 工作表行号；必须使用工具返回值）。
3. 使用用户提供的 storageState 路径，或调用 `lantern_case_execution_login_start` 打开登录页，由用户在浏览器中完成登录后再调用 `lantern_case_execution_login_complete`。工具不接收账号密码。
4. 调用 `lantern_case_execution_start` 启动单条执行。随后用 `wait` 按 `afterSeq` 读取新增日志；需要中止时调用 `stop`。
5. 只有页面、截图、控制台或网络证据支持时才能建议「通过」。向用户展示建议状态、实际结果、判定依据、未验证项和证据，并允许改为「待验证 / 通过 / 不通过 / 阻塞 / 跳过」。
6. 用户确认后调用 `lantern_case_execution_apply`。服务端只更新文件已有执行列，不生成备份；文件被外部修改时返回冲突并拒绝旧结果覆盖。
7. 结果为不通过或阻塞时提供缺陷入口；用户要求提交时转入 `lantern-defect-*`，不要自动提交。同步统计先调用 `lantern_case_execution_sync_stats(mode="preview")`，已有同日手工记录时不自动覆盖。

运行记录、事件、日志和截图位于当前空间的 `.lantern/local/case-execution/`。浏览器只访问本次目标站点，模型 API Key 不进入执行记录。仓库标准 Skill 为 `skills/case-execution/SKILL.md`。

## 场景补全

1. `lantern_case_blindspot_context` 按用例文件路径读取当前盲区、`added` 状态、文件哈希和评审报告。
2. 探测或补全完成后调用 `lantern_case_blindspot_save`，携带 `casePath`、`expectedFileHash` 和完整 `blindspot` 报告。补全阶段只能更新 `precondition`、`steps`、`expected`；`id`、`category`、`title`、`why`、`severity`、`priority`、`reqAnchor` 必须保持原值，所有勾选 ID 都要返回。
3. 只把用户明确选择的条目 ID 传给 `lantern_case_blindspot_draft`。草稿返回编号、需求编号、模块、子模块、前置条件、步骤、预期、优先级、状态、引用需求点、插入位置和警告，不修改文件；任一必要字段缺失、归属需求找不到或模块层级无法确定时拒绝生成草稿。
4. 用户核对完整预览后调用 `lantern_case_blindspot_apply`。服务端复核草稿 revision、用例文件哈希和补全结果；任一变化返回 409。
5. 成功回执给出实际写入的条目和编号，随后才把这些条目标为已补全。不要自行更新 JSON 或把未返回的条目算作完成。

## 测试报告

1. `lantern_test_report_context` 读取功能 / 接口 / 性能报告的真实用例、测试统计、用例执行统计、目标报告和缺口，并返回 `sourceRevision`。
2. 调用方生成 Markdown 后，用 `lantern_test_report_draft` 传入相同的 casePaths、日期范围和 `declaredStats`。服务端重新读取来源并校验统计，不一致返回 422。
3. 草稿返回 `draftId`、`revision`、预览和剩余缺口；用户确认后调用 `lantern_test_report_apply`。
4. 应用时再次复核来源 `sourceRevision` 与目标报告哈希，然后原子写入 `.md` / `.txt`。缺失来源必须保留为缺口，不得估算。

## Lantern 记忆建议

`lantern_memory_suggestion_context` 只读取 Lantern 自己的 `SUGGESTIONS.jsonl`，不会访问宿主 Codex 的记忆文件。选择明确 ID 和 `approve` / `reject` 后调用 `draft`，预览目标轨和重复内容；用户确认后再调用 `apply`。默认禁止重复写入，只有调用方显式传 `allowDuplicates=true` 才能越过。写入或拒绝都返回逐项回执。

## 启动方式

如果已有 Lantern 本地服务，直接连接：

```bash
lantern mcp --url http://127.0.0.1:4321
```

通常不需要显式传入地址。Codex 启动 `lantern mcp` 时：

1. 优先连接已运行的本机 Lantern 服务；
2. 若服务未运行，则使用当前数据池根启动一个仅供 MCP 使用的内嵌服务；
3. MCP 进程退出时关闭内嵌服务。

需要指定内嵌服务端口时使用 `lantern mcp --port 54321`。`--url` 与 `--port` 可同时保留在 Codex 配置的 `args` 中。

## Codex 配置

在用户级 `~/.codex/config.toml` 或受信任项目的 `.codex/config.toml` 中增加：

```toml
[mcp_servers.lantern]
command = "lantern"
args = ["mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 240
default_tools_approval_mode = "writes"
```

源码环境尚未安装全局 `lantern` 命令时，可写绝对路径：

```toml
[mcp_servers.lantern]
command = "node"
args = ["/absolute/path/to/lantern-harness/cli/lantern.mjs", "mcp"]
cwd = "/absolute/path/to/lantern-harness"
startup_timeout_sec = 30
tool_timeout_sec = 240
default_tools_approval_mode = "writes"
```

修改配置后新建 Codex 会话，使 MCP 工具重新发现。

`startup_timeout_sec = 30` 给内嵌服务留出冷启动时间；`tool_timeout_sec = 240` 覆盖 UI 自动化草稿试跑、缺陷提交、外接 MCP 调用和业务地图登录等待内部可能使用的长超时。`default_tools_approval_mode = "writes"` 会让非只读工具按 Codex MCP 写入策略请求确认。只写 command / args 也可以启动，但会沿用 Codex 默认的 10 秒启动超时、60 秒工具超时和默认审批模式。

当前开发机的全局 `lantern` 命令可能与源码版本不同。源码联调优先使用上面的绝对路径配置；若使用 `lantern mcp`，先执行 `lantern version`，确认它不低于当前仓库版本。配置修改后只对新建 Codex 会话生效，已经打开且工具调用返回 `unsupported call` 的旧会话需要重开或重启 Codex。

默认生成流程不依赖任何 elicitation 配置，而是在聊天中展示推荐配置和编号选项。只有明确需要 MCP 表单窗口时，才在启动配置中额外加入：

```toml
approval_policy = { granular = { sandbox_approval = true, rules = true, mcp_elicitations = true, request_permissions = true, skill_approval = true } }
```

该配置只在 Codex 启动时读取；修改后必须重启 Codex 并新建会话。

也可以直接让 Codex CLI 写入用户配置：

```bash
codex mcp add lantern -- lantern mcp
```

源码环境对应：

```bash
codex mcp add lantern -- node /absolute/path/to/lantern-harness/cli/lantern.mjs mcp
```

## 安装 Codex Skill

仓库内置接入 Skill：

```text
skills/lantern-workflow/SKILL.md
```

将其复制到 Codex 用户技能目录：

```bash
mkdir -p ~/.agents/skills
cp -R skills/lantern-workflow ~/.agents/skills/
```

Skill 只负责意图路由，不复制 Lantern 的业务规则。真正的需求分析、结构提取和测试点规范仍通过 `lantern_skill_load` 或上下文工具从 Lantern 读取。

## 推荐工作流

### 拆解需求

用户在 Codex 上传需求文档并说“拆解一下这个需求”：

1. `lantern_requirement_prepare`（首次或能力未启用时；重复调用安全）
2. `lantern_requirement_import`
3. `lantern_requirement_context`
4. Codex 按返回的技能与输出契约生成 `outline` 和 `stories`
5. `lantern_requirement_analysis_save`
6. 返回 `analysisId`、故事数量和 Lantern 链接

“拆解需求”只执行到用户故事，不自动生成测试点。

再次拆解已有文档时，`lantern_requirement_context` 会返回 `existingAnalysisRevision`。保存时必须原样传回 `expectedRevision`。

### 完整需求分析

继续执行：

1. `lantern_requirement_review_context`
2. 生成 `check`
3. `lantern_requirement_review_save`
4. `lantern_testpoints_context`
5. 生成 `testPoints`
6. `lantern_testpoints_save`

### 修改已有结果

先调用 `lantern_requirement_analysis_get` 读取最新分析和 `revision`：

- 改一条故事：调用 `lantern_requirement_story_patch`，传 `analysisId`、`storyId`、`expectedRevision` 和只包含变化字段的 `patch`。
- 删除一条故事：调用 `lantern_requirement_story_delete`；引用该故事的测试点会同步移除。
- 修改审查或测试点：重新读取最新 revision 后，用 `lantern_requirement_review_save` 或 `lantern_testpoints_save` 保存完整结构。

不要直接编辑 Lantern JSON 文件。故事修改后如影响行为、验收条件、边界或来源覆盖，应重新审查相关测试点。

## 并发与冲突

Lantern 对需求分析内容计算稳定的 `revision` 指纹。所有修改已有分析的工具都要求 `expectedRevision`，并在服务端写入前做原子比对：

- 页面或另一个 Codex 会话先修改了分析时，旧 revision 的写请求返回 `409`。
- 缺少 revision 时返回 `428`，并附带当前 revision。
- 来源需求文档在拆解后发生变化时，旧 `sourceHash` 的保存请求也会返回 `409`。
- Codex 应重新读取最新内容、复核差异后重新应用意图，不能盲目重发旧 payload。

这保证 Codex 可以直接修改底层业务数据，同时不会静默覆盖 Lantern 页面中的并发编辑，也不会把旧需求正文的拆解结果写进已更新的需求。

## 数据与权限

- 所有正式结果写入当前 Lantern 数据空间。
- 需求文档和测试资产不复制到 Codex 私有存储。
- 技能版本、原文引用、故事编号、测试点排序和字段白名单由 Lantern 处理。
- 已停用技能不会进入需求拆解和测试点上下文；`lantern_skill_list` 默认也只返回启用技能。
- 导入、保存等写入工具带 destructive annotation，Codex 可按 MCP 审批策略提示确认。
- 浏览器只在 Lantern 执行 Web UI 自动化或页面采集时启动；普通业务能力通过 MCP 调用。

## 当前范围

当前覆盖需求文档、需求分析、测试点、需求拆解 XMind、按功能 / 接口 / 性能 / 自动化类型分派的用例生成与审查、UI 自动化项目准备、功能用例转 UI 自动化、受控页面探索与脚本写入、自动化正式运行、单条用例执行与写回、缺陷规则与提交、业务地图读写 / 登录 / 本地资料 / AI 识别，以及当前空间外接 MCP 的通用发现与调用。外接 MCP 与工作台使用同一份连接配置；这不等于将所有内置插件或所有 HTTP API 都当作稳定的 MCP 契约，后续能力仍通过同一 Bridge 模式扩展。

## 缺陷提交

先在 Lantern 的「插件仓库 → 测试技能」开启「缺陷规则」，进入侧栏同名页面，通过「新建规则」独立配置模板，再在提交页选择。当前腾讯文档适配会复用已有 MCP 连接；其他平台接入对应连接器后可使用同一套规则和任务卡。

仓库提供 `skills/lantern-defect-submit/SKILL.md`，可复制到 `~/.agents/skills/lantern-defect-submit/`。已有 Lantern MCP 配置继续使用，新会话重新发现以下工具。

- `lantern_defect_context` 获取当前空间目标、模板、规则当前迭代、字段、可选值、字段默认值和 revision。当前迭代会自动映射到目标「迭代版本」字段。
- `lantern_defect_draft_save` 传 contextRevision 和以字段 ID 为键的 values 保存草稿；未传字段自动套用规则默认值，返回预览、missing、id 和 revision。图片字段传已上传到目标平台后取得的 image ID 数组；附件字段只有在连接器支持上传和回写时填写，否则留空。
- `lantern_defect_submit` 在用户明确要求最终提交（如「提个缺陷」「提交缺陷」）或确认草稿后，传草稿 id 和 revision 提交；「生成缺陷」「先做草稿」「预览」不触发提交。
- `lantern_defect_receipt` 查询同一草稿回执，必要时回读远端记录。
- `lantern_defect_drafts` 列出当前空间的缺陷草稿和提交状态，防止重复生成或遗漏待核验记录。

选项和关联记录使用上下文中的 ID。只在 status 为 submitted 时报告成功，pending 继续核验。用户要求提缺陷时，保存草稿后直接提交同一版本；只有明确要求生成草稿或先预览时才停在保存与预览。

整理「重现步骤」时，账号密码、登录账号、权限和特定数据准备等前置内容统一放到末尾「前置条件：」小节，按 `1.`、`2.` 编号；没有前置条件时不添加，不能编造账号密码。

缺陷模板独立管理。用 `lantern_defect_templates` 列出模板，用 `lantern_defect_template_select` 按 id 选择模板并取得最新上下文。需要由 Codex 维护规则时，先用 `lantern_defect_rule_inspect` 读取目标子表和字段，再用 `lantern_defect_rule_save` 保存字段映射、规则、默认值和迭代；用 `lantern_defect_rule_delete` 删除规则。

缺陷提交页面仅展示所选模板信息。点击「提交」携带模板快照到我的工作台任务卡，输入缺陷描述或更新要求后，由 AI 根据 `platform` 选择与目标平台匹配的连接器，定位、新建或更新缺陷并回读核验。腾讯文档、JIRA、禅道等都只是入口，不能默认走腾讯文档。模板在独立页面管理。

缺陷规则现使用 `/defect-rules/` 卡片管理页，新建和编辑在右侧面板进行。支持链接识别与手动字段，每个字段保存 rule 填写口径、defaultValue 独立默认值、required 和 source 来源。rule 是必须执行的判断或生成口径，严重程度、优先级等字段只要规则提供标准，就应根据事实判断并说明依据；defaultValue 只作缺省兜底。通用规则引用其他文档、知识库页面或目标平台记录时，AI 先读取并核对其中的项目、测试分项目、经办人和迭代映射，再填写对应字段。`POST /rules/save` 保存规则，允许手动规则暂不配置链接。旧 /templates API 和历史模板数据继续兼容。

## 用例生成、执行计划与验收

1. 开启用例生成、用例管理与需要的执行 / 审查插件。用户只说“生成测试用例”时，先调用 `lantern_case_generation_setup`，默认 `presentation=chat`：Lantern 扫描需求分析、需求文档、模板、XMind、业务地图和已知故事 / 测试点，返回推荐配置与候选列表。Codex 在聊天中按组列出当前空间真实的需求名称、类型名称、对应模板名称、输出格式（Excel / CSV / Markdown）、XMind 和全部业务系统名称及编号，标明推荐值并等待用户确认。可以回复“需求选 1，类型选 2”或“按推荐配置生成”；客户端只使用返回的真实 ID，不编造候选。已明确提供的故事和测试点范围会保留，显式选择文档时不会自动绑定其他分析。
2. 用户确认推荐后，把 `recommended` 整理成配置传给 `lantern_case_generation_context`，包括 `caseType`、`analysisId`/`sourcePath`、故事与测试点范围、`templateId`、XMind 和 `businessSystemIds`。只有用户明确要求结构化窗口时才传 `presentation=form`；此时 `action=accept` 会直接返回 `config`，取消或降级则必须停止或改回聊天确认。
   - 窗口返回 `decline` / `cancel` 只表示配置未确认，不能推断用户手动取消；结果带 `requiresConfirmation=true`、候选、推荐配置与原因提示，不返回可执行的 `config`。检查客户端表单能力和 `mcp_elicitations` 审批设置（`never` 策略可能阻止窗口），重新打开或聊天确认后才能继续。窗口不支持或调用异常时的 `fallback` 同样不能自动确认推荐值。
   - 分析记录的旧来源路径不存在时，仅对唯一同名文档使用新路径并返回 `warnings`，不改写分析记录；找不到或存在多个同名文件时，setup 仍返回故事 / 测试点与警告，context 和 save 保留严格的来源及基线校验。显式选择的文档路径失效时直接报错，不替换为其他文档。
   - 支持 `presentation=browser`，直接返回 Lantern 浏览器配置窗口链接 `/cases/configure/`；原生表单不可用或未确认时也提供该链接。窗口复用工作台配置抽屉，需求文档与用户故事二选一，可选择故事、测试点、模板、格式、XMind 和多个业务系统。用户确认后，客户端携带返回的 `setupId` 再次调用 `lantern_case_generation_setup`，仅 `action=accept` 的 `config` 可用于生成。窗口只保存选择，不生成用例；配置绑定当前空间，30 分钟过期或服务重启后失效，可在页面重新创建。 原生窗口的 `decline` / `cancel` 仍保留原动作，浏览器链接只是可选替代，不能推断用户已确认。
3. Codex 按返回的 `template.headers` / `headers` 生成 rows，使用 `lantern_case_generation_validate` 检查字段与所选 RO / US / TP 引用。`headers` 会按当前空间技能补齐独立的“引用需求点”列；`需求编号`填写需求文档根需求 `XQ-…`，没有根需求编号时写“无”；同一根需求下的多条测试点用例允许重复该编号。`引用需求点`保留真实 `RO-id 标题或摘录；TP-xxx`。`模块`取需求拆解 XMind 的一级系统章节，`子模块`取对应二级需求名称，不从标题关键词自造系统名；例如 `质检系统 → 投诉系统需求 → XQ-…` 必须写模块“质检系统”、子模块“投诉系统需求”。用例顺序按需求文档条目排列，同一条目内再按测试点清单顺序。功能测试先做范围准入：接口 / Mock / 报文 / 状态码 / 接口超时等转接口测试，压测 / 并发指标 / QPS / TPS / 大数据量等转性能测试；只有断网、空数据、权限不足、外部渠道不可用等用户可操作、可观察的降级场景才保留为功能用例。接口用例按端点、鉴权、参数、状态码和响应契约设计；性能用例按负载、并发、持续时间、阈值、监控和恢复设计；两者与功能用例共用同一套生成、校验和保存契约。
4. `lantern_case_generation_save` 传 rows、headers、title、format（xlsx/csv/md）、`caseType`、所选故事与测试点，同时携带 context 返回的 expectedRevision、expectedSourceFileHash。保存前会再次规范化需求编号、引用列和行顺序；省略 `folder` 时自动进入类型目录。需求变化返回冲突，新文件具备执行列与稳定用例 ID。Excel 输出冻结首行表头，为长文本启用自动换行、数据行使用自适应行高，并为“优先级”“用例状态”“实际结果”写入下拉校验；表头使用正常字色与较高行高，不使用黑底。覆盖率以真实引用计算，不采信模型自报。旧会话缺基线时应重新确认生成配置。
5. `lantern_case_review_context` 读取文件与当前空间审查技能；生成报告后 `lantern_case_review_save` 携带 expectedFileHash 保存到同一审查记录。
6. `lantern_case_execution_prepare_columns` 为旧文件预览缺列；`lantern_case_baseline_link` 为文件预览关联需求分析。两者均先 mode=preview，由用户确认后 mode=apply 携带返回哈希 / revision。关联新基线保留历史结果，但需人工复核才能计入通过。
7. 用户明确提供批量范围时，`lantern_case_execution_plan_create` 传真实 caseIds、expectedFileHash、engine、环境 name/build（可带 role/dataNote）。browser 使用目标 url、可选 storageStatePath 和 allowedOrigins；目标 origin 自动授权，allowedOrigins 只放明确需要的登录 origin。脚本跳转、弹窗和服务端重定向的每一跳都受同一授权边界约束，越界会在请求发出前失败并记录目标地址。automation 使用已有 projectId、指定 file、taskId，可带 setupTaskId/cleanupTaskId。不会创建即执行；使用 plan_start 显式启动，plan_get / plans 查看，plan_stop 停止。核验后用 plan_result 传 planId、caseId、最新 expectedFileHash、status、actualResult 写回，结果继承该计划环境。中断后仅继续未完成项；旧需求基线或用例变更需重建计划。
8. 单条 start 不自动写状态，AI 无有效页面观察或步骤证据时不得建议通过。用户验证后 apply，executor 默认「人工验证」；文件有其他手动字段修改时传最新 expectedFileHash，用例行为或需求基线变化仍拒绝旧结果。
9. `lantern_case_acceptance` 读取确定性设计、执行和通过覆盖与准出阻塞；多个环境应传报告提供的 environmentKey 隔离。报告不自动审批发布、不处理缺陷关闭，也不包含性能测试。

多缺陷链接由页面详情的多个输入框维护，以换行兼容存储到缺陷地址字段，不新增缺陷状态同步或自动关闭流程。

## 通用测试统计

1. `lantern_test_stats_list` 查询当前空间，可传 from、to（YYYY-MM-DD，含边界）、dimension、query、includeDrafts。返回真实记录 ID、维度列表、revision、按维度与日期汇总；默认不包含空占位草稿。
2. `lantern_test_stats_create` 传 expectedRevision 和 items，每条必须有明确 date、单元素 dimensions、count（0 到 9999999 的整数）；不会根据执行日志猜统计数量。
3. `lantern_test_stats_update` 传真实 id、expectedRevision 与需要修改的字段；缺省字段保持不变。`lantern_test_stats_delete` 只删除明确指定的 ids。
4. 维度管理使用 `lantern_test_stats_dimension_create(name)`、`rename(from,to)`、`delete(name)`，同样传 expectedRevision；新增不产生假记录，重命名同步关联数据，被引用维度拒绝删除。
5. 每次成功写入会返回新 revision。与页面或其他会话冲突、或在查询后切换空间，会返回 409；先重新读取再决定后续操作，避免覆盖或重复新增。统计合计保持页面口径，不代表需求覆盖率、执行通过率或发布准出结论。

新工具注册在更新后的 `lantern mcp` 中，已有 Codex 会话需重新发现工具（通常新建会话）。安装方式和依赖没有变化。

## 测试闭环与能力边界

Codex 可依次完成需求导入与分析、需求结构拆解、用户故事和故事审查、测试点、功能 / 接口 / 性能 / 自动化用例生成及用例评审、执行与结果确认、缺陷提交以及测试统计。各步骤需读取当前空间技能与最新数据版本，再校验并保存；对话中生成内容并不等于已入库。需求变更后应重新检查引用、用例覆盖、评审和执行基线，不能沿用旧通过记录作为新版本验收结论。

功能测试支持在页面手工选择执行结果，也可明确要求 Codex 使用浏览器执行并提供证据，确认后写回。页面缺陷信息由用户维护，支持一个用例填写多个链接；提交缺陷需明确指令，取得回执后再核对关联，不自动推进缺陷状态。

自动化闭环可创建或挂载 UI 项目，评估功能用例、生成 UI Plan 和脚本、草稿验证、写入 iteration、正式运行并读取报告。当前完整出码链路为 Playwright + TypeScript；API / App 执行需要对应项目、运行环境与工具，不能仅凭存在用例文件认定已经完成测试。性能执行本轮不纳入。

用例执行统计与通用测试统计各自维护数据：前者先预览再同步实际执行数量，后者按用户指定维度记录工作量。数量汇总不能代替需求覆盖率、执行通过率或验收结论。执行中发现平台能力缺口，可按明确需求补充功能，并在修复后回到原用例复测；外部业务系统的问题按缺陷处理。
