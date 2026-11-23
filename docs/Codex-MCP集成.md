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
- 返回 `analysisId`、产物路径和 Lantern 页面链接

首版采用“Codex 推理、Lantern 持久化”的委托分析模式：Codex 读取 Lantern 技能正文和需求内容后生成结构化结果，再由 Lantern 校验、编号和落盘。

导入同名文件时默认保留原文件，并在新文件名后追加导入时间和递增序号；只有显式设置 `overwrite=true` 才会覆盖。

## 工具清单

| 工具                                                                   | 用途                             | 写入     |
| ---------------------------------------------------------------------- | -------------------------------- | -------- |
| `lantern_mcp_tools` / `lantern_mcp_call`                               | 发现并复用当前空间外接 MCP 工具  | 调用可写 |
| `lantern_status` / `lantern_space_list`                                | 检查服务和活动空间               | 否       |
| `lantern_requirement_prepare`                                          | 启用需求链路插件、补种并迁移技能 | 是       |
| `lantern_skill_list` / `lantern_skill_load` / `lantern_skill_validate` | 查看启用技能、加载规则、校验输出 | 否       |
| `lantern_requirement_list` / `lantern_requirement_sources`             | 浏览需求文档和可分析来源         | 否       |
| `lantern_requirement_import`                                           | 将本地需求文档导入 Lantern       | 是       |
| `lantern_requirement_context`                                          | 读取来源正文、分析规则和输出契约 | 否       |
| `lantern_requirement_analysis_get`                                     | 读取最新分析及 `revision`        | 否       |
| `lantern_requirement_analysis_save`                                    | 新建分析或完整保存拆解结果       | 是       |
| `lantern_requirement_story_patch`                                      | 增量修改一条用户故事             | 是       |
| `lantern_requirement_story_delete`                                     | 删除一条故事并清理关联测试点     | 是       |
| `lantern_requirement_review_context`                                   | 读取故事、来源正文和审查规则     | 否       |
| `lantern_requirement_review_save`                                      | 保存故事审查结果                 | 是       |
| `lantern_testpoints_context`                                           | 读取故事、测试点规则和输出契约   | 否       |
| `lantern_testpoints_save`                                              | 保存测试点报告                   | 是       |

## 复用 Lantern 外接 MCP

`lantern_mcp_tools` 和 `lantern_mcp_call` 将工作台已有的 `/__tb_mcp/tools`、`/__tb_mcp/call` 提供给 Codex，无需在 Codex 再配置腾讯文档 Token 或其他服务凭据。

1. 调用 `lantern_mcp_tools`，可传 `server: "tencent-docs"` 或 `query` 按工具名、说明过滤。返回真实 `name`、`remoteName`、`inputSchema`、远端 annotations，以及 `connected` 和 `errors`；部分服务连接失败不会隐藏其他可用工具。
2. 按返回的 `inputSchema` 构造参数，通过 `lantern_mcp_call` 传入完整 `name` 和 `arguments`。例如查询其他腾讯文档时，先发现列出子表、字段和记录的工具，再按真实定义传入目标文档 ID；不再局限于缺陷规则配置的目标表。
3. 工具执行时会重新核对当前活动空间的目录，移除的工具或其他空间独有的工具不能继续调用。更改空间或连接配置后重新发现即可，无需逐个注册远端工具。
4. 返回远端原始内容（包括图片、资源）和结构化结果，保留远端错误标志，不自动重试写入。已有 HTTP 服务尚未更新时兼容旧文本结果；要使用完整原始内容透传，需重启更新后的 Lantern 服务。

发现工具只读；通用调用同时支持读写，按可能产生外部写入标注审批，不能统一当作只读。权限仍由当前空间配置的远端服务决定，不支持绕过授权或在调用参数中替换凭据。业务写入还应符合用户授权；提交缺陷优先使用 `lantern_defect_*` 保留草稿校验和回执流程。

更新后重启 `lantern mcp` 并新建 Codex 会话，使两个新入口进入工具列表。已有会话的工具目录不会因为源码更新自动增加入口。

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

当前覆盖需求文档链路、测试点保存、缺陷提交，以及当前空间外接 MCP 的通用发现与调用。外接 MCP 与工作台使用同一份连接配置；这不等于已将全部内置插件或所有 HTTP API 暴露给 Codex。用例生成、UI 自动化任务、业务地图和报告能力继续按同一 Bridge 模式扩展，不需要重写现有 Lantern 插件。

## 缺陷提交

先在 Lantern 的「插件仓库 → 测试技能」开启「缺陷规则」，进入侧栏同名页面，通过「新建规则」独立配置模板，再在提交页选择。当前腾讯文档适配会复用已有 MCP 连接；其他平台接入对应连接器后可使用同一套规则和任务卡。

仓库提供 `skills/lantern-defect-submit/SKILL.md`，可复制到 `~/.agents/skills/lantern-defect-submit/`。已有 Lantern MCP 配置继续使用，新会话重新发现以下工具。

- `lantern_defect_context` 获取当前空间目标、模板、规则当前迭代、字段、可选值、字段默认值和 revision。当前迭代会自动映射到目标「迭代版本」字段。
- `lantern_defect_draft_save` 传 contextRevision 和以字段 ID 为键的 values 保存草稿；未传字段自动套用规则默认值，返回预览、missing、id 和 revision。图片字段传已上传到目标平台后取得的 image ID 数组；附件字段只有在连接器支持上传和回写时填写，否则留空。
- `lantern_defect_submit` 在用户明确要求最终提交（如「提个缺陷」「提交缺陷」）或确认草稿后，传草稿 id 和 revision 提交；「生成缺陷」「先做草稿」「预览」不触发提交。
- `lantern_defect_receipt` 查询同一草稿回执，必要时回读远端记录。

选项和关联记录使用上下文中的 ID。只在 status 为 submitted 时报告成功，pending 继续核验。用户要求提缺陷时，保存草稿后直接提交同一版本；只有明确要求生成草稿或先预览时才停在保存与预览。

整理「重现步骤」时，账号密码、登录账号、权限和特定数据准备等前置内容统一放到末尾「前置条件：」小节，按 `1.`、`2.` 编号；没有前置条件时不添加，不能编造账号密码。

缺陷模板独立管理。用 `lantern_defect_templates` 列出模板，用 `lantern_defect_template_select` 按 id 选择模板并取得最新上下文。

缺陷提交页面仅展示所选模板信息。点击「提交」携带模板快照到我的工作台任务卡，输入缺陷描述或更新要求后，由 AI 根据 `platform` 选择与目标平台匹配的连接器，定位、新建或更新缺陷并回读核验。腾讯文档、JIRA、禅道等都只是入口，不能默认走腾讯文档。模板在独立页面管理。

缺陷规则现使用 `/defect-rules/` 卡片管理页，新建和编辑在右侧面板进行。支持链接识别与手动字段，每个字段保存 rule 填写口径、defaultValue 独立默认值、required 和 source 来源。rule 是必须执行的判断或生成口径，严重程度、优先级等字段只要规则提供标准，就应根据事实判断并说明依据；defaultValue 只作缺省兜底。通用规则引用其他文档、知识库页面或目标平台记录时，AI 先读取并核对其中的项目、测试分项目、经办人和迭代映射，再填写对应字段。`POST /rules/save` 保存规则，允许手动规则暂不配置链接。旧 /templates API 和历史模板数据继续兼容。
