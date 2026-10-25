/**
 * 内置能力目录（来自 temp/dsh能力对照-决策清单.xlsx 主公结论「做」，该目录已 gitignore）。
 * 会话 / 全局：默认内置、无开关；未落地能力展示「规划中」。
 * 扩展插件见 plugins.ts 的 PLUGIN_CATALOG（可开关）。
 */
export interface BuiltinCatalogEntry {
  id: string;
  /** npm 包名（对照 dsh，可空） */
  packageName: string;
  /** 中文作用说明 */
  roleZh: string;
  /** 分类（会话分组 / 全局类别） */
  category: string;
}

/** 已有本机实现的探测键 */
export type BuiltinRuntimeKey = 'web' | 'fs' | 'bash' | 'pwsh' | 'ready' | 'none';

export function builtinRuntimeKey(id: string): BuiltinRuntimeKey {
  if (
    id === 'time-context' ||
    id === 'tool-todo' ||
    id === 'tool-ask-user' ||
    id === 'user-questions' ||
    id === 'plan-mode' ||
    id === 'tool-result-pruner' ||
    id === 'compaction-basic' ||
    id === 'command-compact' ||
    id === 'tool-goal' ||
    id === 'command-goal' ||
    id === 'goal' ||
    id === 'tool-schedule' ||
    id === 'schedule' ||
    id === 'goal-round-driver' ||
    id === 'session-log-download' ||
    id === 'llm-retry' ||
    id === 'session-title-llm' ||
    id === 'session-stats' ||
    id === 'locale' ||
    id === 'config-editor' ||
    id === 'subagent' ||
    id === 'subagent-fork-in-process' ||
    id === 'spill-local' ||
    id === 'spill-policy' ||
    id === 'session-turn-outline' ||
    id === 'image-offload' ||
    id === 'session-persistence-jsonl' ||
    id === 'session-checkpoint-policy' ||
    id === 'session-query-sqlite' ||
    id === 'session-projection-cache' ||
    id === 'storage-domain' ||
    id === 'workspace-changes' ||
    id === 'workspace-dependencies' ||
    id === 'skill-office' ||
    id === 'fs-observation-policy' ||
    id === 'deepseek-llm-api-extensions' ||
    id === 'session-log-deepseek' ||
    id === 'subagent-model-selection-settings' ||
    id === 'authorization' ||
    id === 'modules' ||
    id === 'resources' ||
    id === 'mcp-resources' ||
    id === 'mcp-client' ||
    id === 'ptc-runtime' ||
    id === 'headless-runner' ||
    id === 'headless-startup' ||
    id === 'sdk-jsonrpc-server' ||
    id === 'sdk-app-startup' ||
    id === 'acp' ||
    id === 'acp-app-startup' ||
    id === 'subagent-spawn-in-process' ||
    id === 'llm-pi-ai' ||
    id === 'session-reference' ||
    id === 'tool-subagent' ||
    id === 'tool-subagent-control' ||
    id === 'tool-subagent-list-agents' ||
    id === 'tool-subagent-fork' ||
    id === 'tool-workflow' ||
    id === 'workflow-ptc' ||
    id === 'session-title' ||
    id === 'attachment-local' ||
    id === 'file-upload' ||
    id === 'file-reference-local' ||
    id === 'credentials' ||
    id === 'connection' ||
    id === 'token-meter' ||
    id === 'llm' ||
    id === 'llm-deepseek' ||
    id === 'agent-default-model' ||
    id === 'session' ||
    id === 'sessions' ||
    id === 'session-projection' ||
    id === 'storage' ||
    id === 'storage-json' ||
    id === 'settings' ||
    id === 'commands' ||
    id === 'shortcuts' ||
    id === 'timeout-policy' ||
    id === 'shell-env' ||
    id === 'approval' ||
    id === 'agent' ||
    id === 'system-prompt' ||
    id === 'tools' ||
    id === 'repeat-tool-reminder'
  ) {
    return 'ready';
  }
  if (id === 'tool-web' || id === 'web' || id === 'web-fetch-http' || id === 'web-search-deepseek')
    return 'web';
  if (
    id === 'tool-bash' ||
    id === 'tool-jobs' ||
    id === 'jobs' ||
    id === 'sandbox-policy' ||
    id === 'bash-sandbox' ||
    id === 'sandbox' ||
    id === 'pty' ||
    id === 'terminal-bash' ||
    id === 'persistent-bash' ||
    id === 'subprocess'
  ) {
    return 'bash';
  }
  if (
    id === 'tool-pwsh' ||
    id === 'persistent-pwsh' ||
    id === 'terminal-pwsh' ||
    id === 'pwsh-sandbox'
  )
    return 'pwsh';
  if (
    id === 'tool-fs' ||
    id === 'tool-fs-search' ||
    id === 'tool-skill' ||
    id === 'skill' ||
    id === 'agent-instructions' ||
    id === 'present' ||
    id === 'office-to-pdf' ||
    id === 'filesystem' ||
    id === 'fs-sandbox' ||
    id === 'permission' ||
    id === 'working-directory' ||
    id === 'tool-working-directory' ||
    id === 'workspace'
  ) {
    return 'fs';
  }
  return 'none';
}

export const SESSION_PLUGIN_CATALOG: BuiltinCatalogEntry[] = [
  {
    id: 'agent-instructions',
    packageName: '@deepseek-ai/dsh-agent-instructions',
    roleZh: '加载 AGENTS.md/CLAUDE.md。',
    category: '会话能力',
  },
  {
    id: 'time-context',
    packageName: '@deepseek-ai/dsh-time-context',
    roleZh: '注入当前时间与耗时。',
    category: '会话能力',
  },
  {
    id: 'tool-bash',
    packageName: '@deepseek-ai/dsh-tool-bash',
    roleZh: '模型可调用 bash 在本机执行命令（可后台、可沙箱升级）。',
    category: '会话能力',
  },
  {
    id: 'tool-pwsh',
    packageName: '@deepseek-ai/dsh-tool-pwsh',
    roleZh: '模型可调用 PowerShell（主要面向 Windows）。',
    category: '会话能力',
  },
  {
    id: 'tool-fs',
    packageName: '@deepseek-ai/dsh-tool-fs',
    roleZh: '模型可读/写/编辑工作区文件。',
    category: '会话能力',
  },
  {
    id: 'tool-working-directory',
    packageName: '@deepseek-ai/dsh-tool-working-directory',
    roleZh: '模型可查看/切换会话工作目录。',
    category: '会话能力',
  },
  {
    id: 'tool-fs-search',
    packageName: '@deepseek-ai/dsh-tool-fs-search',
    roleZh: '模型可用 glob / grep 搜索工作区文件（内置 ripgrep）。',
    category: '会话能力',
  },
  {
    id: 'tool-skill',
    packageName: '@deepseek-ai/dsh-tool-skill',
    roleZh: '模型可按需加载工作区 SKILL.md。',
    category: '会话能力',
  },
  {
    id: 'tool-jobs',
    packageName: '@deepseek-ai/dsh-tool-jobs',
    roleZh: '模型可查看/读取输出/终止后台任务（job_list/output/kill）。',
    category: '会话能力',
  },
  {
    id: 'tool-schedule',
    packageName: '@deepseek-ai/dsh-tool-schedule',
    roleZh: '模型可创建/查询/更新/删除定时提醒，到点投递回原会话。',
    category: '会话能力',
  },
  {
    id: 'command-goal',
    packageName: '@deepseek-ai/dsh-command-goal',
    roleZh: '人类管理会话目标的 slash 命令。',
    category: '会话能力',
  },
  {
    id: 'tool-goal',
    packageName: '@deepseek-ai/dsh-tool-goal',
    roleZh: '模型可读写本会话目标，并在执行时做权限校验。',
    category: '会话能力',
  },
  {
    id: 'plan-mode',
    packageName: '@deepseek-ai/dsh-plan-mode',
    roleZh: '计划模式（探查→方案→批准→实施）。',
    category: 'planning',
  },
  {
    id: 'compaction-basic',
    packageName: '@deepseek-ai/dsh-compaction-basic',
    roleZh: '上下文 token 过高时自动摘要压缩，腾出窗口。',
    category: 'compaction',
  },
  {
    id: 'command-compact',
    packageName: '@deepseek-ai/dsh-command-compact',
    roleZh: '人类手动压缩会话的 slash 命令。',
    category: 'compaction',
  },
  {
    id: 'tool-result-pruner',
    packageName: '@deepseek-ai/dsh-compaction-tool-result-pruner',
    roleZh: '裁剪过长的工具返回（头/中/尾保留），省 token。',
    category: 'compaction',
  },
  {
    id: 'tool-subagent-control',
    packageName: '@deepseek-ai/dsh-tool-subagent-control',
    roleZh: '模型可给子代理发消息、中断、列出正在跑的子代理。',
    category: 'delegation',
  },
  {
    id: 'tool-subagent-list-agents',
    packageName: '@deepseek-ai/dsh-tool-subagent-control/list-agents',
    roleZh: '单独暴露 list_agents，列出可用/运行中的子代理。',
    category: 'delegation',
  },
  {
    id: 'tool-subagent',
    packageName: '@deepseek-ai/dsh-tool-subagent',
    roleZh: '模型可派生子代理去执行子任务（spawn）。',
    category: 'delegation',
  },
  {
    id: 'tool-subagent-fork',
    packageName: '@deepseek-ai/dsh-tool-subagent',
    roleZh: '模型可 fork 当前上下文开子代理并行干活。',
    category: 'delegation',
  },
  {
    id: 'workflow-ptc',
    packageName: '@deepseek-ai/dsh-workflow-ptc',
    roleZh: '在沙箱 Node 运行时里跑工作流编排脚本。',
    category: 'delegation',
  },
  {
    id: 'tool-workflow',
    packageName: '@deepseek-ai/dsh-tool-workflow',
    roleZh: '模型可调用 workflow：跑一段编排脚本来协调多步。',
    category: 'delegation',
  },
  {
    id: 'tool-ask-user',
    packageName: '@deepseek-ai/dsh-tool-ask-user',
    roleZh: '模型可向用户提出结构化问题并等待回答。',
    category: '会话能力',
  },
  {
    id: 'tool-todo',
    packageName: '@deepseek-ai/dsh-tool-todo',
    roleZh: '模型可维护本会话待办清单（todo_write）。',
    category: '会话能力',
  },
  {
    id: 'tool-web',
    packageName: '@deepseek-ai/dsh-tool-web',
    roleZh: '模型可网页搜索（web_search）与抓取页面（web_fetch）。',
    category: '会话能力',
  },
  {
    id: 'present',
    packageName: '@deepseek-ai/dsh-tool-present',
    roleZh: '模型可声明「交付了哪些工作区文件」，便于 UI 展示/打开。',
    category: '会话能力',
  },
];

export const GLOBAL_PLUGIN_CATALOG: BuiltinCatalogEntry[] = [
  {
    id: 'attachment-local',
    packageName: '@deepseek-ai/dsh-attachment-local',
    roleZh: '本机附件存储与读取。',
    category: '会话 / 存储',
  },
  {
    id: 'session',
    packageName: '@deepseek-ai/dsh-session',
    roleZh: '事件溯源的会话存储（会话真相源）。',
    category: '会话 / 存储',
  },
  {
    id: 'session-checkpoint-policy',
    packageName: '@deepseek-ai/dsh-session-checkpoint-policy',
    roleZh: '会话检查点策略。',
    category: '会话 / 存储',
  },
  {
    id: 'session-log-deepseek',
    packageName: '@deepseek-ai/dsh-session-log-deepseek',
    roleZh: 'DeepSeek 侧增量无损会话日志请求扩展。',
    category: '会话 / 存储',
  },
  {
    id: 'session-log-download',
    packageName: '@deepseek-ai/dsh-session-log-export',
    roleZh: '导出会话日志。',
    category: '会话 / 存储',
  },
  {
    id: 'session-persistence-jsonl',
    packageName: '@deepseek-ai/dsh-session-persistence-jsonl',
    roleZh: '会话以 JSONL 持久化。',
    category: '会话 / 存储',
  },
  {
    id: 'session-projection',
    packageName: '@deepseek-ai/dsh-session-projection',
    roleZh: '会话投影视图（给 UI/查询用）。',
    category: '会话 / 存储',
  },
  {
    id: 'session-projection-cache',
    packageName: '@deepseek-ai/dsh-session-projection-cache',
    roleZh: '会话投影缓存。',
    category: '会话 / 存储',
  },
  {
    id: 'session-query-sqlite',
    packageName: '@deepseek-ai/dsh-session-query-sqlite',
    roleZh: '会话全文/结构化查询（sqlite）。',
    category: '会话 / 存储',
  },
  {
    id: 'session-reference',
    packageName: '@deepseek-ai/dsh-session-reference',
    roleZh: '会话内引用（消息/文件等）。',
    category: '会话 / 存储',
  },
  {
    id: 'session-stats',
    packageName: '@deepseek-ai/dsh-session-stats',
    roleZh: '会话统计信息。',
    category: '会话 / 存储',
  },
  {
    id: 'session-title',
    packageName: '@deepseek-ai/dsh-session-title',
    roleZh: '会话标题能力。',
    category: '会话 / 存储',
  },
  {
    id: 'session-turn-outline',
    packageName: '@deepseek-ai/dsh-session-turn-outline',
    roleZh: '对话回合摘要。',
    category: '会话 / 存储',
  },
  {
    id: 'sessions',
    packageName: '@deepseek-ai/dsh-session-persistence-jsonl',
    roleZh: '会话 JSONL 持久化后端（与 session-persistence 同类）。',
    category: '会话 / 存储',
  },
  {
    id: 'storage',
    packageName: '@deepseek-ai/dsh-storage',
    roleZh: '通用存储服务。',
    category: '会话 / 存储',
  },
  {
    id: 'storage-domain',
    packageName: '@deepseek-ai/dsh-storage-domain',
    roleZh: '按域划分的存储。',
    category: '会话 / 存储',
  },
  {
    id: 'storage-json',
    packageName: '@deepseek-ai/dsh-storage-json',
    roleZh: 'JSON 文件存储后端。',
    category: '会话 / 存储',
  },
  {
    id: 'command-compact',
    packageName: '@deepseek-ai/dsh-command-compact',
    roleZh: '人类手动压缩会话的 slash 命令。',
    category: '模型面工具/命令',
  },
  {
    id: 'command-goal',
    packageName: '@deepseek-ai/dsh-command-goal',
    roleZh: '人类管理会话目标的 slash 命令。',
    category: '模型面工具/命令',
  },
  {
    id: 'skill-office',
    packageName: '@deepseek-ai/dsh-skill-office',
    roleZh: 'Office（Word/PPT/Excel）相关工作流 Skill。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-bash',
    packageName: '@deepseek-ai/dsh-tool-bash',
    roleZh: '模型可调用 bash 在本机执行命令（可后台、可沙箱升级）。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-fs',
    packageName: '@deepseek-ai/dsh-tool-fs',
    roleZh: '模型可读/写/编辑工作区文件。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-fs-search',
    packageName: '@deepseek-ai/dsh-tool-fs-search',
    roleZh: '模型可用 glob / grep 搜索工作区文件（内置 ripgrep）。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-goal',
    packageName: '@deepseek-ai/dsh-tool-goal',
    roleZh: '模型可读写本会话目标，并在执行时做权限校验。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-jobs',
    packageName: '@deepseek-ai/dsh-tool-jobs',
    roleZh: '模型可查看/读取输出/终止后台任务（job_list/output/kill）。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-pwsh',
    packageName: '@deepseek-ai/dsh-tool-pwsh',
    roleZh: '模型可调用 PowerShell（主要面向 Windows）。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-result-pruner',
    packageName: '@deepseek-ai/dsh-compaction-tool-result-pruner',
    roleZh: '裁剪过长的工具返回（头/中/尾保留），省 token。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-skill',
    packageName: '@deepseek-ai/dsh-tool-skill',
    roleZh: '模型可按需加载某个 Skill，把技能说明拉进上下文。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-subagent',
    packageName: '@deepseek-ai/dsh-tool-subagent',
    roleZh: '模型可派生子代理去执行子任务（spawn）。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-subagent-control',
    packageName: '@deepseek-ai/dsh-tool-subagent-control',
    roleZh: '模型可给子代理发消息、中断、列出正在跑的子代理。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-subagent-fork',
    packageName: '@deepseek-ai/dsh-tool-subagent',
    roleZh: '模型可 fork 当前上下文开子代理并行干活。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-subagent-list-agents',
    packageName: '@deepseek-ai/dsh-tool-subagent-control/list-agents',
    roleZh: '单独暴露 list_agents，列出可用/运行中的子代理。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-todo',
    packageName: '@deepseek-ai/dsh-tool-todo',
    roleZh: '模型可维护本会话待办清单（todo_write）。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-web',
    packageName: '@deepseek-ai/dsh-tool-web',
    roleZh: '模型可网页搜索（web_search）与抓取页面（web_fetch）。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-workflow',
    packageName: '@deepseek-ai/dsh-tool-workflow',
    roleZh: '模型可调用 workflow：跑一段编排脚本来协调多步。',
    category: '模型面工具/命令',
  },
  {
    id: 'tool-working-directory',
    packageName: '@deepseek-ai/dsh-tool-working-directory',
    roleZh: '模型可查看/切换会话工作目录。',
    category: '模型面工具/命令',
  },
  {
    id: 'acp',
    packageName: '@deepseek-ai/dsh-acp',
    roleZh: '通过 JSON-RPC stdio 驱动 Harness Agent 的自动化协议服务（给外部编排用）。',
    category: '其它',
  },
  {
    id: 'acp-app-startup',
    packageName: '@deepseek-ai/dsh-acp-app',
    roleZh: 'ACP 配置包启动：在 base 之上挂 JSON-RPC stdio 与进程生命周期。',
    category: '其它',
  },
  {
    id: 'authorization',
    packageName: '@deepseek-ai/dsh-authorization',
    roleZh: '授权/鉴权服务。',
    category: '其它',
  },
  {
    id: 'commands',
    packageName: '@deepseek-ai/dsh-commands',
    roleZh: '人类 slash 命令注册底座。',
    category: '其它',
  },
  {
    id: 'config-editor',
    packageName: '@deepseek-ai/dsh-config-editor',
    roleZh: '配置编辑能力。',
    category: '其它',
  },
  {
    id: 'connection',
    packageName: '@deepseek-ai/dsh-client-connection',
    roleZh: '客户端与 Host 连接。',
    category: '其它',
  },
  {
    id: 'credentials',
    packageName: '@deepseek-ai/dsh-credentials-local',
    roleZh: '本机凭证存储。',
    category: '其它',
  },
  {
    id: 'file-reference-local',
    packageName: '@deepseek-ai/dsh-file-reference-local',
    roleZh: '本机文件引用解析。',
    category: '其它',
  },
  {
    id: 'file-upload',
    packageName: '@deepseek-ai/dsh-client-file-upload',
    roleZh: '客户端上传文件。',
    category: '其它',
  },
  {
    id: 'filesystem',
    packageName: '@deepseek-ai/dsh-fs-local',
    roleZh: '本机文件系统实现（ctx.fs），供 tool-fs 等读写。',
    category: '其它',
  },
  {
    id: 'fs-observation-policy',
    packageName: '@deepseek-ai/dsh-fs-observation-policy',
    roleZh: '文件系统观察/上报策略。',
    category: '其它',
  },
  {
    id: 'headless-runner',
    packageName: '@deepseek-ai/dsh-headless',
    roleZh: '无 Host/HTTP/浏览器的一键 Agent/Session 运行器（纯 headless）。',
    category: '其它',
  },
  {
    id: 'headless-startup',
    packageName: '@deepseek-ai/dsh-headless/startup',
    roleZh: 'Headless 配置包的启动插件。',
    category: '其它',
  },
  {
    id: 'image-offload',
    packageName: '@deepseek-ai/dsh-compaction-image-offload',
    roleZh: '超预算图片卸载为占位符并重试。',
    category: '其它',
  },
  {
    id: 'locale',
    packageName: '@deepseek-ai/dsh-client-locale',
    roleZh: '界面语言。',
    category: '其它',
  },
  {
    id: 'mcp-resources',
    packageName: '@deepseek-ai/dsh-mcp-resources',
    roleZh: 'MCP 资源对接。',
    category: '其它',
  },
  {
    id: 'mcp-client',
    packageName: '@deepseek-ai/dsh-mcp-client',
    roleZh: '外接 MCP 真客户端（stdio/HTTP → mcp__*__* 工具）。',
    category: '其它',
  },
  {
    id: 'modules',
    packageName: '@deepseek-ai/dsh-client-modules',
    roleZh: '客户端模块加载。',
    category: '其它',
  },
  {
    id: 'office-to-pdf',
    packageName: '@deepseek-ai/dsh-office-to-pdf',
    roleZh: 'Office 转 PDF。',
    category: '其它',
  },
  {
    id: 'pty',
    packageName: '@deepseek-ai/dsh-terminal',
    roleZh: '持久 PTY 会话能力缝：会话 id、后端注册、交互读写与信号。',
    category: '其它',
  },
  {
    id: 'repeat-tool-reminder',
    packageName: '@deepseek-ai/dsh-repeat-tool-reminder',
    roleZh: '重复工具调用时提醒模型。',
    category: '其它',
  },
  {
    id: 'resources',
    packageName: '@deepseek-ai/dsh-client-resources',
    roleZh: '客户端资源。',
    category: '其它',
  },
  {
    id: 'sdk-app-startup',
    packageName: '@deepseek-ai/dsh-sdk-app',
    roleZh: 'SDK 配置包启动：stdio JSON-RPC 服务与进程生命周期。',
    category: '其它',
  },
  {
    id: 'sdk-jsonrpc-server',
    packageName: '@deepseek-ai/dsh-sdk-jsonrpc-server',
    roleZh: '给进程外 SDK 客户端用的 stdio JSON-RPC 服务端。',
    category: '其它',
  },
  {
    id: 'settings',
    packageName: '@deepseek-ai/dsh-settings',
    roleZh: '设置读写与校验。',
    category: '其它',
  },
  {
    id: 'shell-env',
    packageName: '@deepseek-ai/dsh-shell-env',
    roleZh: '注入/管理 shell 环境变量。',
    category: '其它',
  },
  {
    id: 'shortcuts',
    packageName: '@deepseek-ai/dsh-client-shortcuts',
    roleZh: '快捷键注册。',
    category: '其它',
  },
  {
    id: 'timeout-policy',
    packageName: '@deepseek-ai/dsh-tool-call-timeout-policy',
    roleZh: '单次工具调用超时策略。',
    category: '其它',
  },
  {
    id: 'user-questions',
    packageName: '@deepseek-ai/dsh-user-questions',
    roleZh: '用户提问通道（供 ask_user 等使用）。',
    category: '其它',
  },
  {
    id: 'working-directory',
    packageName: '@deepseek-ai/dsh-working-directory',
    roleZh: '会话工作目录状态。',
    category: '其它',
  },
  {
    id: 'workspace',
    packageName: '@deepseek-ai/dsh-workspace',
    roleZh: '工作区抽象（根目录、切换等）。',
    category: '其它',
  },
  {
    id: 'workspace-changes',
    packageName: '@deepseek-ai/dsh-workspace-changes',
    roleZh: '工作区变更追踪。',
    category: '其它',
  },
  {
    id: 'workspace-dependencies',
    packageName: '@deepseek-ai/dsh-tool-workspace-dependencies',
    roleZh: '向模型提供捆绑的 Python/Node/pnpm 依赖绝对路径（load_workspace_dependencies）。',
    category: '其它',
  },
  {
    id: 'compaction-basic',
    packageName: '@deepseek-ai/dsh-compaction-basic',
    roleZh: '上下文 token 过高时自动摘要压缩，腾出窗口。',
    category: '上下文压缩',
  },
  {
    id: 'spill-local',
    packageName: '@deepseek-ai/dsh-spill-local',
    roleZh: '过大内容溢出到本机文件。',
    category: '上下文压缩',
  },
  {
    id: 'spill-policy',
    packageName: '@deepseek-ai/dsh-spill-policy',
    roleZh: '何时溢出、溢出策略。',
    category: '上下文压缩',
  },
  {
    id: 'token-meter',
    packageName: '@deepseek-ai/dsh-token-meter',
    roleZh: '统计上下文 token 用量。',
    category: '上下文压缩',
  },
  {
    id: 'web',
    packageName: '@deepseek-ai/dsh-web',
    roleZh: '网页能力缝（ctx.web）：注册 search/fetch provider。',
    category: '网页能力',
  },
  {
    id: 'web-fetch-http',
    packageName: '@deepseek-ai/dsh-web-fetch-http',
    roleZh: '通用 HTTP 抓取网页正文 provider。',
    category: '网页能力',
  },
  {
    id: 'goal',
    packageName: '@deepseek-ai/dsh-goal',
    roleZh: '本会话目标状态机服务。',
    category: '预设 / 能力服务',
  },
  {
    id: 'goal-round-driver',
    packageName: '@deepseek-ai/dsh-goal-round-driver',
    roleZh: '按目标驱动多轮执行。',
    category: '预设 / 能力服务',
  },
  {
    id: 'plan-mode',
    packageName: '@deepseek-ai/dsh-plan-mode',
    roleZh: '计划模式（探查→方案→批准→实施）。',
    category: '预设 / 能力服务',
  },
  {
    id: 'schedule',
    packageName: '@deepseek-ai/dsh-schedule',
    roleZh: '主机级持久提醒，到点投递原会话。',
    category: '预设 / 能力服务',
  },
  {
    id: 'skill',
    packageName: '@deepseek-ai/dsh-skill',
    roleZh: 'Skill 能力注册底座。',
    category: '预设 / 能力服务',
  },
  {
    id: 'approval',
    packageName: '@deepseek-ai/dsh-user-approval',
    roleZh: '敏感操作需用户批准。',
    category: '执行 / 权限',
  },
  {
    id: 'bash-sandbox',
    packageName: '@deepseek-ai/dsh-bash-sandbox',
    roleZh: 'bash 专用沙箱绑定。',
    category: '执行 / 权限',
  },
  {
    id: 'fs-sandbox',
    packageName: '@deepseek-ai/dsh-fs-sandbox',
    roleZh: '文件系统沙箱。',
    category: '执行 / 权限',
  },
  {
    id: 'jobs',
    packageName: '@deepseek-ai/dsh-jobs-local',
    roleZh: '后台任务注册表（id、归属、轮询、取消）。',
    category: '执行 / 权限',
  },
  {
    id: 'permission',
    packageName: '@deepseek-ai/dsh-permission-presets',
    roleZh: '权限预设（只读/读写等档位）。',
    category: '执行 / 权限',
  },
  {
    id: 'persistent-bash',
    packageName: '@deepseek-ai/dsh-tool-bash-persistent',
    roleZh: '带 PTY 的持久 Bash 工具（跨调用保持 shell 状态）。',
    category: '执行 / 权限',
  },
  {
    id: 'persistent-pwsh',
    packageName: '@deepseek-ai/dsh-tool-pwsh-persistent',
    roleZh: '带 PTY 的持久 PowerShell 工具。',
    category: '执行 / 权限',
  },
  {
    id: 'pwsh-sandbox',
    packageName: '@deepseek-ai/dsh-pwsh-sandbox',
    roleZh: 'pwsh 专用沙箱绑定。',
    category: '执行 / 权限',
  },
  {
    id: 'sandbox',
    packageName: '@deepseek-ai/dsh-sandbox-local',
    roleZh: '本机沙箱执行环境。',
    category: '执行 / 权限',
  },
  {
    id: 'sandbox-policy',
    packageName: '@deepseek-ai/dsh-sandbox-policy',
    roleZh: '沙箱策略（能跑什么、不能跑什么）。',
    category: '执行 / 权限',
  },
  {
    id: 'subprocess',
    packageName: '@deepseek-ai/dsh-subprocess-local',
    roleZh: '本机子进程执行器。',
    category: '执行 / 权限',
  },
  {
    id: 'terminal-bash',
    packageName: '@deepseek-ai/dsh-terminal-bash',
    roleZh: '基于子进程终端原语的持久 bash PTY 后端。',
    category: '执行 / 权限',
  },
  {
    id: 'terminal-pwsh',
    packageName: '@deepseek-ai/dsh-terminal-bash',
    roleZh: '基于子进程终端原语的持久 pwsh PTY 后端。',
    category: '执行 / 权限',
  },
  {
    id: 'ptc-runtime',
    packageName: '@deepseek-ai/dsh-ptc-runtime-node',
    roleZh: 'PTC（工具调用呈现）Node 运行时。',
    category: '子代理 / 工作流',
  },
  {
    id: 'subagent',
    packageName: '@deepseek-ai/dsh-subagent',
    roleZh: '子代理能力底座。',
    category: '子代理 / 工作流',
  },
  {
    id: 'workflow-ptc',
    packageName: '@deepseek-ai/dsh-workflow-ptc',
    roleZh: '在沙箱 Node 运行时里跑工作流编排脚本。',
    category: '子代理 / 工作流',
  },
  {
    id: 'agent',
    packageName: '@deepseek-ai/dsh-agent',
    roleZh: 'Agent 主体：把会话、工具、模型串起来。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'agent-default-model',
    packageName: '@deepseek-ai/dsh-agent-default-model',
    roleZh: '解析/提供默认模型配置。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'agent-instructions',
    packageName: '@deepseek-ai/dsh-agent-instructions',
    roleZh: '加载 AGENTS.md/CLAUDE.md。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'deepseek-llm-api-extensions',
    packageName: '@deepseek-ai/dsh-deepseek-llm-api-extensions',
    roleZh: '给官方 DeepSeek API 适配器登记额外请求字段。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'llm',
    packageName: '@deepseek-ai/dsh-llm',
    roleZh: '厂商无关的 LLM 服务接口（发请求、流式、工具调用等）。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'llm-deepseek',
    packageName: '@deepseek-ai/dsh-llm-deepseek-api-key',
    roleZh: 'DeepSeek API Key 模型适配。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'llm-pi-ai',
    packageName: '@deepseek-ai/dsh-llm-pi-ai',
    roleZh: 'Pi AI 等 LLM 适配。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'llm-retry',
    packageName: '@deepseek-ai/dsh-llm-retry',
    roleZh: 'LLM 调用失败重试策略。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'session-title-llm',
    packageName: '@deepseek-ai/dsh-session-title-first-prompt-llm',
    roleZh: '用首条用户消息经 LLM 自动起会话标题。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'subagent-fork-in-process',
    packageName: '@deepseek-ai/dsh-subagent-fork-in-process',
    roleZh: '进程内 fork 子代理实现。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'subagent-model-selection-settings',
    packageName: '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
    roleZh: '子代理可选模型的设置项。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'subagent-spawn-in-process',
    packageName: '@deepseek-ai/dsh-subagent-spawn-in-process',
    roleZh: '进程内 spawn 子代理实现。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'system-prompt',
    packageName: '@deepseek-ai/dsh-system-prompt',
    roleZh: '系统提示词拼装服务。',
    category: 'LLM / Agent 核心',
  },
  {
    id: 'tools',
    packageName: '@deepseek-ai/dsh-tools',
    roleZh: '工具注册与执行总闸。',
    category: 'LLM / Agent 核心',
  },
];
