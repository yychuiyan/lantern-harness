/**
 * 条件化工具注册表：按 access / plan / 插件 / 运行面组装本轮 tools。
 * 对齐 DSH conditional-tools 思想（每步可见集），不上 Cordis。
 */
import type { ToolDef } from './llm';
import type { AccessLevel } from './settings';
import type { PlanPhase } from './session-plan';
import { SUBMIT_PLAN_TOOL } from './session-plan';
import { fsToolsForAccess, WORKING_DIRECTORY_TOOLS, PRESENT_TOOL } from './fs-tools';
import { SKILL_TOOLS } from './skill-tools';
import { WORKSPACE_CHANGES_TOOLS } from './workspace-changes';
import { WORKSPACE_DEPS_TOOL } from './workspace-deps-tools';
import { OFFICE_TO_PDF_TOOL } from './office-to-pdf-tools';
import {
  BASH_TOOL,
  BASH_SESSION_TOOLS,
  PWSH_TOOL,
  PWSH_SESSION_TOOLS,
  JOB_TOOLS,
} from './bash-tools';
import { WEB_TOOLS } from './web-tools';
import { MEMORY_TOOLS } from './memory';
import { KB_TOOLS } from './knowledge-tools';
import { TODO_WRITE_TOOL, ASK_USER_QUESTION_TOOL } from './session-interact';
import { TODO_TOOLS } from './todo-tools';
import { TASK_TOOLS } from './task-tools';
import {
  PM_PROJECT_TOOLS,
  PM_ITERATION_TOOLS,
  PM_REQUIREMENT_TOOLS,
  PM_BUG_TOOLS,
} from './pm-tools';
import { GOAL_TOOLS } from './session-goal';
import { SCHEDULE_TOOLS } from './session-schedule';
import { SUBAGENT_TOOLS } from './session-subagent';
import { WORKFLOW_TOOLS } from './session-workflow';

export interface ChatToolCaps {
  knowledge?: boolean;
  fs?: boolean;
  web?: boolean;
  bash?: boolean;
  pwsh?: boolean;
  memory?: boolean;
  todos?: boolean;
  tasks?: boolean;
  projects?: boolean;
  iterations?: boolean;
  pmRequirements?: boolean;
  bugs?: boolean;
  /** 默认 true；结构化插件模式应关 */
  subagent?: boolean;
  workflow?: boolean;
  interact?: boolean;
  goal?: boolean;
  schedule?: boolean;
  /** 注入 MCP 工具列表时为 true */
  mcp?: boolean;
}

export interface BuildChatToolsInput {
  access: AccessLevel;
  planPhase?: PlanPhase;
  /** planning 时门禁写工具（与 ChatApp planGatesWrites 一致） */
  planGatesWrites?: boolean;
  caps: ChatToolCaps;
  /** 结构化生成等：不挂业务工具 */
  structuredPlugin?: boolean;
  /** 已解析的 MCP ToolDef（caps.mcp 时追加） */
  mcpTools?: readonly ToolDef[];
}

const asTools = (list: unknown): ToolDef[] => list as ToolDef[];

/** 组装浏览器回合可用的工具列表 */
export function buildChatTools(input: BuildChatToolsInput): ToolDef[] {
  if (input.structuredPlugin) return [];

  const caps = input.caps;
  const access = input.access;
  const planGatesWrites = Boolean(input.planGatesWrites);
  const planPhase = input.planPhase ?? 'off';
  const tools: ToolDef[] = [];

  if (caps.knowledge) tools.push(...asTools(KB_TOOLS));
  if (caps.fs) {
    tools.push(...asTools(fsToolsForAccess(access)));
    tools.push(...asTools(WORKING_DIRECTORY_TOOLS));
    tools.push(...asTools(SKILL_TOOLS));
    tools.push(...asTools(WORKSPACE_CHANGES_TOOLS));
    tools.push(WORKSPACE_DEPS_TOOL as unknown as ToolDef);
    if (!planGatesWrites) {
      tools.push(OFFICE_TO_PDF_TOOL as unknown as ToolDef);
      tools.push(PRESENT_TOOL as unknown as ToolDef);
    }
  }
  if (caps.bash && access !== 'readonly') {
    tools.push(BASH_TOOL as unknown as ToolDef);
    tools.push(...asTools(BASH_SESSION_TOOLS));
  }
  if (caps.pwsh && access !== 'readonly') {
    tools.push(PWSH_TOOL as unknown as ToolDef);
    tools.push(...asTools(PWSH_SESSION_TOOLS));
  }
  if ((caps.bash || caps.pwsh) && access !== 'readonly') {
    tools.push(...asTools(JOB_TOOLS));
  }
  if (caps.web) tools.push(...asTools(WEB_TOOLS));
  if (caps.memory) tools.push(...asTools(MEMORY_TOOLS));

  if (caps.interact !== false) {
    tools.push(TODO_WRITE_TOOL as unknown as ToolDef);
  }
  if (caps.todos) tools.push(...asTools(TODO_TOOLS));
  if (caps.tasks) tools.push(...asTools(TASK_TOOLS));
  if (caps.projects) tools.push(...asTools(PM_PROJECT_TOOLS));
  if (caps.iterations) tools.push(...asTools(PM_ITERATION_TOOLS));
  if (caps.pmRequirements) tools.push(...asTools(PM_REQUIREMENT_TOOLS));
  if (caps.bugs) tools.push(...asTools(PM_BUG_TOOLS));
  if (caps.interact !== false) {
    tools.push(ASK_USER_QUESTION_TOOL as unknown as ToolDef);
  }
  if (caps.goal !== false) tools.push(...asTools(GOAL_TOOLS));
  if (caps.schedule !== false) tools.push(...asTools(SCHEDULE_TOOLS));
  if (caps.subagent !== false) tools.push(...asTools(SUBAGENT_TOOLS));
  if (caps.workflow !== false) tools.push(...asTools(WORKFLOW_TOOLS));
  if (caps.mcp !== false && input.mcpTools?.length) {
    tools.push(...input.mcpTools);
  }
  if (planPhase === 'planning' || planPhase === 'approved') {
    tools.push(SUBMIT_PLAN_TOOL as unknown as ToolDef);
  }
  return tools;
}

/** 服务端回合不可交互 / 未实现的工具名 */
export function isServerRunExcludedTool(name: string): boolean {
  if (!name) return true;
  if (name === 'ask_user_question' || name === 'submit_plan' || name === 'workflow') return true;
  if (name === 'spawn_subagent' || name === 'fork_subagent' || name === 'list_agents') return true;
  if (name.startsWith('subagent_')) return true;
  return false;
}

export function filterToolsForServerRun(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter((t) => {
    const n = t.function?.name ?? '';
    return Boolean(n) && !isServerRunExcludedTool(n);
  });
}

export function chatToolsAllow(tools: readonly ToolDef[], name: string): boolean {
  return tools.some((t) => t.function?.name === name);
}
