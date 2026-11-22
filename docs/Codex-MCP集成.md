# Codex MCP 集成

`lantern mcp` 将当前 Lantern 空间的能力以 stdio MCP 工具暴露给 Codex。Codex 直接调用结构化工具，不需要打开 Lantern 页面点击按钮。

## 能做什么

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

| 工具                                                                   | 用途                             | 写入 |
| ---------------------------------------------------------------------- | -------------------------------- | ---- |
| `lantern_status` / `lantern_space_list`                                | 检查服务和活动空间               | 否   |
| `lantern_requirement_prepare`                                          | 启用需求链路插件、补种并迁移技能 | 是   |
| `lantern_skill_list` / `lantern_skill_load` / `lantern_skill_validate` | 查看启用技能、加载规则、校验输出 | 否   |
| `lantern_requirement_list` / `lantern_requirement_sources`             | 浏览需求文档和可分析来源         | 否   |
| `lantern_requirement_import`                                           | 将本地需求文档导入 Lantern       | 是   |
| `lantern_requirement_context`                                          | 读取来源正文、分析规则和输出契约 | 否   |
| `lantern_requirement_analysis_get`                                     | 读取最新分析及 `revision`        | 否   |
| `lantern_requirement_analysis_save`                                    | 新建分析或完整保存拆解结果       | 是   |
| `lantern_requirement_story_patch`                                      | 增量修改一条用户故事             | 是   |
| `lantern_requirement_story_delete`                                     | 删除一条故事并清理关联测试点     | 是   |
| `lantern_requirement_review_context`                                   | 读取故事、来源正文和审查规则     | 否   |
| `lantern_requirement_review_save`                                      | 保存故事审查结果                 | 是   |
| `lantern_testpoints_context`                                           | 读取故事、测试点规则和输出契约   | 否   |
| `lantern_testpoints_save`                                              | 保存测试点报告                   | 是   |

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

首版覆盖需求文档链路和测试点保存。用例生成、UI 自动化任务、业务地图和报告能力继续按同一 Bridge 模式扩展，不需要重写现有 Lantern 插件。
