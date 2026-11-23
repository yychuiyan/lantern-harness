# Codex MCP 集成

`lantern mcp` 将当前 Lantern 空间的能力以 stdio MCP 工具暴露给 Codex。Codex 直接调用结构化工具，不需要打开 Lantern 页面点击按钮。

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
- 返回 `analysisId`、产物路径和 Lantern 页面链接

首版采用“Codex 推理、Lantern 持久化”的委托分析模式：Codex 读取 Lantern 技能正文和需求内容后生成结构化结果，再由 Lantern 校验、编号和落盘。

导入同名文件时默认保留原文件，并在新文件名后追加导入时间和递增序号；只有显式设置 `overwrite=true` 才会覆盖。

## 工具清单

| 工具                                                                    | 用途                               | 写入     |
| ----------------------------------------------------------------------- | ---------------------------------- | -------- |
| `lantern_mcp_tools` / `lantern_mcp_call`                                | 发现并复用当前空间外接 MCP 工具    | 调用可写 |
| `lantern_status` / `lantern_space_list`                                 | 检查服务和活动空间                 | 否       |
| `lantern_requirement_prepare`                                           | 启用需求链路插件、补种并迁移技能   | 是       |
| `lantern_skill_list` / `lantern_skill_load` / `lantern_skill_validate`  | 查看启用技能、加载规则、校验输出   | 否       |
| `lantern_requirement_list` / `lantern_requirement_sources`              | 浏览需求文档和可分析来源           | 否       |
| `lantern_requirement_import`                                            | 将本地需求文档导入 Lantern         | 是       |
| `lantern_requirement_context`                                           | 读取来源正文、分析规则和输出契约   | 否       |
| `lantern_requirement_analysis_list`                                     | 列出已有分析、来源、状态和版本     | 否       |
| `lantern_requirement_analysis_get`                                      | 读取最新分析及 `revision`          | 否       |
| `lantern_requirement_analysis_save`                                     | 新建分析或完整保存拆解结果         | 是       |
| `lantern_requirement_analysis_delete`                                   | 批量删除需求分析记录               | 是       |
| `lantern_requirement_story_patch`                                       | 增量修改一条用户故事               | 是       |
| `lantern_requirement_story_delete`                                      | 删除一条故事并清理关联测试点       | 是       |
| `lantern_requirement_review_context`                                    | 读取故事、来源正文和审查规则       | 否       |
| `lantern_requirement_review_save`                                       | 保存故事审查结果                   | 是       |
| `lantern_testpoints_context`                                            | 读取故事、测试点规则和输出契约     | 否       |
| `lantern_testpoints_save`                                               | 保存测试点报告                     | 是       |
| `lantern_requirement_breakdown_list`                                    | 浏览和过滤本地需求拆解 XMind       | 否       |
| `lantern_requirement_breakdown_get`                                     | 读取拆解条目和最新 XMind 内容      | 否       |
| `lantern_requirement_breakdown_import`                                  | 导入 Codex 可访问的本地 XMind      | 是       |
| `lantern_requirement_breakdown_backfill_candidates`                     | 查找可补录且未入库的历史分析       | 否       |
| `lantern_requirement_breakdown_record_analysis`                         | 从历史需求分析生成并补录 XMind     | 是       |
| `lantern_requirement_breakdown_retry`                                   | 重新生成缺失的自动 XMind           | 是       |
| `lantern_requirement_breakdown_update`                                  | 修改显示标题或备注并同步文件名     | 是       |
| `lantern_requirement_breakdown_open`                                    | 用系统默认程序打开本地 XMind       | 否       |
| `lantern_requirement_breakdown_delete`                                  | 删除条目并把文件移入系统废纸篓     | 是       |
| `lantern_business_map_list` / `lantern_business_map_get`                | 查看业务系统、目录、功能和流程     | 否       |
| `lantern_business_login_status`                                         | 查看登录方式、密码和登录态状态     | 否       |
| `lantern_business_login_start` / `complete` / `cancel`                  | 使用已保存配置验证、完成或取消登录 | 是       |
| `lantern_business_material_list` / `upload` / `delete`                  | 管理业务地图本地识别资料           | 是       |
| `lantern_business_system_save` / `lantern_business_system_delete`       | 新建、修改、删除业务系统           | 是       |
| `lantern_business_directory_save` / `lantern_business_directory_delete` | 新建、修改、删除功能目录           | 是       |
| `lantern_business_tree_move`                                            | 移动目录或功能并调整同级顺序       | 是       |
| `lantern_business_function_save` / `lantern_business_function_delete`   | 新建、修改、删除业务功能           | 是       |
| `lantern_business_flow_save` / `lantern_business_flow_delete`           | 新建、修改、删除业务流程           | 是       |
| `lantern_business_assistant_get` / `lantern_business_assistant_wait`    | 查看或等待 AI 识别会话             | 否       |
| `lantern_business_assistant_send`                                       | 启动目录或流程识别                 | 是       |
| `lantern_business_assistant_stop` / `lantern_business_assistant_reset`  | 停止或重置 AI 会话                 | 是       |
| `lantern_business_assistant_apply`                                      | 应用等待确认的目录 / 流程草案      | 是       |

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
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
```

源码环境尚未安装全局 `lantern` 命令时，可写绝对路径：

```toml
[mcp_servers.lantern]
command = "node"
args = ["/absolute/path/to/lantern-harness/cli/lantern.mjs", "mcp"]
cwd = "/absolute/path/to/lantern-harness"
startup_timeout_sec = 30
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
```

修改配置后新建 Codex 会话，使 MCP 工具重新发现。

`startup_timeout_sec = 30` 给内嵌服务留出冷启动时间；`tool_timeout_sec = 120` 覆盖缺陷提交、外接 MCP 调用和业务地图登录等待内部可能使用的 90–110 秒超时。`default_tools_approval_mode = "writes"` 会让非只读工具按 Codex MCP 写入策略请求确认。只写 command / args 也可以启动，但会沿用 Codex 默认的 10 秒启动超时、60 秒工具超时和默认审批模式。

当前开发机的全局 `lantern` 命令可能与源码版本不同。源码联调优先使用上面的绝对路径配置；若使用 `lantern mcp`，先执行 `lantern version`，确认它不低于当前仓库版本。配置修改后只对新建 Codex 会话生效，已经打开且工具调用返回 `unsupported call` 的旧会话需要重开或重启 Codex。

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

当前覆盖需求文档、需求分析、测试点、需求拆解 XMind、缺陷规则与提交、业务地图读写 / 登录 / 本地资料 / AI 识别，以及当前空间外接 MCP 的通用发现与调用。外接 MCP 与工作台使用同一份连接配置；这不等于已将全部内置插件或所有 HTTP API 暴露给 Codex。用例生成、用例评审、UI 自动化任务和报告能力继续按同一 Bridge 模式扩展，不需要重写现有 Lantern 插件。

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
