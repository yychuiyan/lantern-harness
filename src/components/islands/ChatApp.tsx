import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { t } from '../../lib/i18n';
import {
  loadSettings,
  onSettingsChanged,
  openSettings,
  patchSettings,
  applyGeneralPrefs,
  hydrateAppConfig,
  loadAccessLevel,
  loadGeneralPrefs,
  onGeneralPrefsChanged,
  type AccessLevel,
  type BusySendBehavior,
  type GeneralPrefs,
  type LLMSettings,
  type ReasoningEffort,
} from '../../lib/settings';
import {
  streamChatWithTools,
  fetchModels,
  MODEL_CONTEXT_WINDOW,
  sanitizeAssistantContent,
  type ChatMessage,
  type ContentPart,
  type ToolDef,
  type UsageInfo,
} from '../../lib/llm';
import {
  getSessionRun,
  listSessionRuns,
  sessionRunsAvailable,
  startSessionRun,
  stopSessionRun,
  watchSessionRun,
  type ServerRunEvent,
} from '../../lib/session-runs-client';
import {
  firstUserText,
  generateSessionTitleLlm,
  shouldGenerateLlmTitle,
} from '../../lib/session-title-llm';
import { computeSessionStats, formatSessionStats } from '../../lib/session-stats';
import { getCachedProjection } from '../../lib/session-projection-cache';
import {
  appendDeepseekSessionLogClient,
  buildDeepseekTurnMessages,
} from '../../lib/session-log-deepseek';
import { buildTurnOutline } from '../../lib/session-turn-outline';
import { resolveSubagentSettings } from '../../lib/subagent-model';
import {
  OFFICE_TO_PDF_HINT,
  OFFICE_TO_PDF_TOOL,
  runOfficeToPdfTool,
} from '../../lib/office-to-pdf-tools';
import {
  WORKSPACE_DEPS_HINT,
  WORKSPACE_DEPS_TOOL,
  runWorkspaceDepsTool,
} from '../../lib/workspace-deps-tools';
import { offloadStaleImages } from '../../lib/image-offload';
import { renderMarkdown } from '../../lib/markdown-client';
import {
  archiveSession,
  bindSessionWorkspace,
  createSession,
  deleteSession,
  flushSessionStore,
  hydrateSessionStore,
  isEphemeralEmptySession,
  loadRailOpen,
  loadSessionStore,
  pinSession,
  renameSession,
  saveRailOpen,
  saveSessionStore,
  sortSessionsInGroup,
  switchSession,
  unbindSessionsFromWorkspace,
  appendSessionMessage,
  fetchSessionStoreFromFile,
  mergeScheduleMessagesFromRemote,
  updateActiveMessages,
  updateActiveSessionMeta,
  updateSessionMessages,
  updateSessionMeta,
  settleRunningActivitySteps,
  settleStoreRunningSteps,
  type ChatSession,
  type SessionStore,
} from '../../lib/sessions';
import { sessionHandoffKey } from '../../lib/open-docs-in-session';
import { caseGenConfigLabel, type CaseGenPluginConfig } from '../../lib/case-gen-config';
import {
  buildCaseGenSystemPrompt,
  formatCaseGenProgress,
  tryFinishCaseGenFromAssistant,
} from '../../lib/case-gen-run';
import { promptGenConfigLabel, type PromptGenPluginConfig } from '../../lib/prompt-gen-config';
import {
  buildPromptGenSystemPrompt,
  formatPromptGenProgress,
  tryFinishPromptGenFromAssistant,
} from '../../lib/prompt-gen-run';
import {
  knowledgeGenConfigLabel,
  type KnowledgeGenPluginConfig,
} from '../../lib/knowledge-gen-config';
import {
  buildKnowledgeGenSystemPrompt,
  formatKnowledgeGenProgress,
  tryFinishKnowledgeGenFromAssistant,
} from '../../lib/knowledge-gen-run';
import { buildPluginDevSystemPrompt, type PluginDevPluginConfig } from '../../lib/plugin-dev';
import {
  AGENT_INSTRUCTIONS_HINT_PREFIX,
  FS_SYSTEM_HINT,
  PRESENT_TOOL,
  WORKING_DIRECTORY_TOOLS,
  addWorkspace,
  fetchAgentInstructions,
  fetchFsHealth,
  fetchWorkspace,
  fsToolsForAccess,
  listWorkspaceFlat,
  openFsPath,
  pickDirectory,
  removeWorkspace,
  renameWorkspace,
  runFsTool,
  runPresentTool,
  runWorkingDirectoryTool,
  selectWorkspace,
  shortWorkspaceLabel,
  workspaceDisplayName,
  type FsHealth,
  type PresentFile,
  type WorkspaceFlatEntry,
  type WorkspaceInfo,
  type WorkspaceItem,
} from '../../lib/fs-tools';
import { SKILL_SYSTEM_HINT, SKILL_TOOLS, runSkillTool } from '../../lib/skill-tools';
import {
  PM_BUG_SYSTEM_HINT,
  PM_BUG_TOOLS,
  PM_ITERATION_SYSTEM_HINT,
  PM_ITERATION_TOOLS,
  PM_PROJECT_SYSTEM_HINT,
  PM_PROJECT_TOOLS,
  PM_REQUIREMENT_SYSTEM_HINT,
  PM_REQUIREMENT_TOOLS,
  runPmTool,
} from '../../lib/pm-tools';
import { TODO_SYSTEM_HINT, TODO_TOOLS, runTodoTool } from '../../lib/todo-tools';
import { attachQuickTodoTasks, planQuickTodo } from '../../lib/todo-quick';
import { TASK_SYSTEM_HINT, TASK_TOOLS, parseTaskAddItems, runTaskTool } from '../../lib/task-tools';
import { createTodos as createTodosApi } from '../../lib/todos';
import { createTasks as createTasksApi } from '../../lib/tasks';
import { querySessions, querySessionsViaApi } from '../../lib/session-query';
import {
  WORKSPACE_CHANGES_HINT,
  WORKSPACE_CHANGES_TOOLS,
  parseFsMutationSuccess,
  recordWorkspaceChange,
  runWorkspaceChangesTool,
} from '../../lib/workspace-changes';
import { formatTimeContext } from '../../lib/session-context';
import {
  ASK_USER_QUESTION_TOOL,
  SESSION_INTERACT_HINT,
  TODO_WRITE_TOOL,
  formatAskAnswersText,
  normalizeTodos,
  parseAskSelection,
  parseAskUserArgs,
  resolveAskAnswer,
  type AskUserAnswer,
  type AskUserDraft,
  type AskUserQuestion,
  type TodoItem,
} from '../../lib/session-interact';
import {
  PLAN_MODE_HINT_APPROVED,
  PLAN_MODE_HINT_PLANNING,
  SUBMIT_PLAN_TOOL,
  parseSubmitPlanArgs,
  type PlanPhase,
  type PlanProposal,
} from '../../lib/session-plan';
import {
  compactMessageList,
  isCompactCommand,
  needsAutoCompact,
  type CompactableMessage,
} from '../../lib/session-compact';
import {
  GOAL_SYSTEM_HINT,
  GOAL_TOOLS,
  activeGoalText,
  formatGoalForModel,
  isGoalCommand,
  normalizeGoal,
  parseGoalCommand,
  type SessionGoal,
} from '../../lib/session-goal';
import {
  DEFAULT_GOAL_DRIVER_MAX_ROUNDS,
  goalDriverContinueText,
  isGoalDriverMessage,
  shouldDriveGoalRound,
} from '../../lib/session-goal-driver';
import { exportSessionDownload } from '../../lib/session-export';
import {
  SCHEDULE_SYSTEM_HINT,
  SCHEDULE_TOOLS,
  claimDueSchedulesAsync,
  reminderMessageContent,
  runScheduleTool,
} from '../../lib/session-schedule';
import { SUBAGENT_SYSTEM_HINT, SUBAGENT_TOOLS, runSubagentTool } from '../../lib/session-subagent';
import { WORKFLOW_SYSTEM_HINT, WORKFLOW_TOOLS, runWorkflowTool } from '../../lib/session-workflow';
import {
  MEMORY_TOOLS,
  MEMORY_SYSTEM_HINT,
  MEMORY_KEEP_RECENT,
  deleteSessionMemory,
  fetchMemoryHealth,
  maybeCaptureMemory,
  recallMemory,
  runMemoryTool,
  type MemoryHealth,
} from '../../lib/memory';
import {
  loadPluginEnabled,
  onPluginEnabledChanged,
  pluginDisabledMessage,
  PLUGIN_CATALOG,
  type PluginId,
} from '../../lib/plugins';
import { docRootLabel, docRootLabelPath } from '../../lib/doc-roots';
import { KB_SYSTEM_HINT, KB_TOOLS, runKnowledgeTool } from '../../lib/knowledge-tools';
import { CHAT_SYSTEM_PROMPT_FILE, DEFAULT_CHAT_SYSTEM_PROMPT } from '../../lib/prompts-meta';
import {
  fetchReportPrompt,
  syncReportPrompt,
  REPORT_KIND_LABEL,
  type ReportKind,
} from '../../lib/report-prompt';
import { readViewPref, writeViewPref } from '../../lib/view-prefs';
import { fetchDocsHealth, openDocsFile, readDocsText } from '../../lib/project-docs';
import {
  fetchWebHealth,
  WEB_SYSTEM_HINT,
  WEB_TOOLS,
  runWebTool,
  webToolDetail,
  type WebHealth,
} from '../../lib/web-tools';
import {
  BASH_SESSION_TOOLS,
  BASH_SYSTEM_HINT,
  BASH_TOOL,
  JOB_TOOLS,
  PWSH_SESSION_TOOLS,
  PWSH_SYSTEM_HINT,
  PWSH_TOOL,
  fetchBashHealth,
  fetchPwshHealth,
  runBashSessionTool,
  runBashTool,
  runJobTool,
  runPwshSessionTool,
  runPwshTool,
  type BashHealth,
  type PwshHealth,
} from '../../lib/bash-tools';
import { formatSlashBadge, matchSlashQuery, type SlashDocItem } from '../../lib/slash-docs-shared';
import {
  ATTACH_ACCEPT_EXTS,
  FILE_MAX_BYTES,
  FILE_MAX_COUNT,
  readLocalAttachFile,
} from '../../lib/attach-read';
import {
  basenamePath,
  extractClipboardFilePaths,
  looksLikeBareFilename,
  resolveNameToPasteDocRef,
  resolvePathToPasteDocRef,
  type PasteCatalogEntry,
} from '../../lib/composer-paste';
import CaseGenPanel from './CaseGenPanel';
import PromptGenPanel from './PromptGenPanel';
import KnowledgeGenPanel from './KnowledgeGenPanel';
import ConfirmDialog from './ConfirmDialog';
import MemoryPane from './MemoryPane';
import TodoPane from './TodoPane';
import NamePromptDialog from './NamePromptDialog';
import PluginsPage from './PluginsPage';
import { showToast } from './Toast';
import CreateConfirmCard, {
  blankCreateDraft,
  draftToCreateArgs,
  normalizeCreateDraft,
  type CreateDraftItem,
  type CreateKind,
} from './CreateConfirmCard';

export type SlashDoc = SlashDocItem;

/** 「@」/管理页打开的文档引用（项目文档 → kb_read；工作区 → fs_read） */
interface DocRef {
  collection: 'knowledge' | 'templates' | 'workspace' | 'prompts' | 'cases';
  id: string;
  title: string;
  category: string;
  path: string;
  format: string;
}

function buildPluginMessages(
  systemPrompt: string,
  allApiMessages: ChatMessage[],
  opts: {
    memory: boolean;
    knowledge: boolean;
    fs: boolean;
    web: boolean;
    bash: boolean;
    pwsh: boolean;
    interact: boolean;
    todos: boolean;
    tasks: boolean;
    projects: boolean;
    iterations: boolean;
    pmRequirements: boolean;
    bugs: boolean;
    planPhase: PlanPhase;
    goalEnabled: boolean;
    goal: SessionGoal | null;
    scheduleEnabled: boolean;
    subagentEnabled: boolean;
    workflowEnabled: boolean;
  },
): ChatMessage[] {
  let system = systemPrompt;
  if (opts.knowledge) system = `${system}\n\n${KB_SYSTEM_HINT}`;
  if (opts.fs) {
    system = `${system}\n\n${FS_SYSTEM_HINT}\n\n${SKILL_SYSTEM_HINT}\n\n${WORKSPACE_CHANGES_HINT}\n\n${WORKSPACE_DEPS_HINT}\n\n${OFFICE_TO_PDF_HINT}`;
  }
  if (opts.bash) system = `${system}\n\n${BASH_SYSTEM_HINT}`;
  if (opts.pwsh) system = `${system}\n\n${PWSH_SYSTEM_HINT}`;
  if (opts.web) system = `${system}\n\n${WEB_SYSTEM_HINT}`;
  if (opts.memory) system = `${system}\n\n${MEMORY_SYSTEM_HINT}`;
  if (opts.interact) system = `${system}\n\n${SESSION_INTERACT_HINT}`;
  if (opts.todos) system = `${system}\n\n${TODO_SYSTEM_HINT}`;
  if (opts.tasks) system = `${system}\n\n${TASK_SYSTEM_HINT}`;
  if (opts.projects) system = `${system}\n\n${PM_PROJECT_SYSTEM_HINT}`;
  if (opts.iterations) system = `${system}\n\n${PM_ITERATION_SYSTEM_HINT}`;
  if (opts.pmRequirements) system = `${system}\n\n${PM_REQUIREMENT_SYSTEM_HINT}`;
  if (opts.bugs) system = `${system}\n\n${PM_BUG_SYSTEM_HINT}`;
  if (opts.planPhase === 'planning') system = `${system}\n\n${PLAN_MODE_HINT_PLANNING}`;
  if (opts.planPhase === 'approved') system = `${system}\n\n${PLAN_MODE_HINT_APPROVED}`;
  if (opts.goalEnabled) {
    system = `${system}\n\n${GOAL_SYSTEM_HINT}`;
    const g = activeGoalText(opts.goal);
    if (g) system = `${system}\n\n【当前会话目标】${g}`;
  }
  if (opts.scheduleEnabled) system = `${system}\n\n${SCHEDULE_SYSTEM_HINT}`;
  if (opts.subagentEnabled) system = `${system}\n\n${SUBAGENT_SYSTEM_HINT}`;
  if (opts.workflowEnabled) system = `${system}\n\n${WORKFLOW_SYSTEM_HINT}`;
  const recent = opts.memory ? allApiMessages.slice(-MEMORY_KEEP_RECENT) : allApiMessages;
  return [{ role: 'system', content: system }, ...recent];
}

/** 末尾单独「/」：唤起已启用的面板型插件 */
function getPluginSlashState(text: string): { from: number } | null {
  if (!/(?:^|[\s\n])\/$/.test(text)) return null;
  const from = text.lastIndexOf('/');
  return from < 0 ? null : { from };
}

/** 「@」引用文档：支持 @ 后跟搜索关键字 */
function getAtMentionState(text: string): { from: number; query: string } | null {
  const m = /(?:^|[\s\n])@([^\s@]*)$/.exec(text);
  if (!m) return null;
  const from = text.lastIndexOf('@');
  if (from < 0) return null;
  return { from, query: m[1] ?? '' };
}

/**
 * 选项标题尾部的「（推荐）」只影响展示：去掉后缀、改用徽标标出，
 * 回答仍回传模型给的原始 label（与 dsh 的 parseRecommendedLabel 一致）。
 */
function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:[(（](?:recommended|推荐)[)）])\s*$/i;
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false };
}

const FALLBACK_SYSTEM_PROMPT = DEFAULT_CHAT_SYSTEM_PROMPT;

/** 附加到消息的文本文件（读入内容随消息发送给模型） */
interface Attachment {
  name: string;
  size: number;
  content: string;
  /** 若能解析到工作区/库内路径则展示在胶囊上 */
  path?: string;
}

/** 粘贴 / 选取的图片（data URL，本地会话可整图保存） */
interface ImageAtt {
  id: string;
  name: string;
  size: number;
  mime: string;
  dataUrl: string;
}

/** 本地消息：展示用 content 恒为 string；发 API 时再组多模态 */
interface LocalMessage extends Omit<ChatMessage, 'content'> {
  content: string;
  reasoning?: string;
  /** 原始 reasoning_content（未 sanitize），下一轮 API 必须原样回传 */
  reasoningApi?: string;
  /** 思考耗时（秒）：首个 reasoning chunk 到首个正文 chunk 的间隔 */
  reasoningDuration?: number;
  /** 思考块展开状态，默认收起 */
  reasoningOpen?: boolean;
  /** 主机/会话定时提醒 id（去重） */
  scheduleId?: string;
  /** 消息时间（ms）：用户为发送时刻，助手为完成时刻 */
  time?: number;
  usage?: UsageInfo;
  /** 输出速度（tokens/s）：completion_tokens / 首 token 到结束的时长 */
  tps?: number;
  /** 请求发出到首个流式 chunk 的耗时（ms） */
  ttftMs?: number;
  /** 请求发出到流结束的壁钟耗时（ms） */
  llmMs?: number;
  /** 本轮工具调用累计耗时（ms） */
  toolMs?: number;
  /** 本轮使用的模型 id（切换模型后历史轮次仍显示当时模型） */
  model?: string;
  attachments?: Attachment[];
  /** 「/」文档引用 */
  refs?: DocRef[];
  images?: ImageAtt[];
  /** 用例生成插件入库的文件（展示卡片，双击本地打开） */
  caseFile?: { path: string; name: string; count: number };
  /** 提示词 / 知识库等入库文件（展示卡片，点击本地打开） */
  docsFile?: {
    root: 'prompts' | 'knowledge';
    path: string;
    name: string;
    /** 副标题补充，如分类 */
    note?: string;
  };
  /** present 工具声明的工作区交付文件 */
  presentFiles?: PresentFile[];
  /** dsh 风格工具步骤时间线 */
  activitySteps?: ActivityStep[];
  activityOpen?: boolean;
  /** 本轮状态：服务端续跑 / 手动停止（对齐 dsh「已停止」） */
  turnStatus?: 'running' | 'stopped' | 'completed';
}

/** 对齐 dsh 执行轨迹：思考 / 网页 / 本地文件等 */
interface ActivityStep {
  id: string;
  kind: 'thinking' | 'web_search' | 'web_fetch' | 'fs' | 'kb' | 'memory' | 'tool';
  title: string;
  detail?: string;
  status: 'running' | 'done' | 'error';
}

const REF_MAX_COUNT = 5;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

/** 工作台 Tab：对话 | 回合 | 待办 | 记忆（选择记在浏览器本地） */
type ChatTab = 'dialog' | 'thread' | 'todos' | 'memory';
const CHAT_TAB_VALUES = ['dialog', 'thread', 'todos', 'memory'] as const;
const CHAT_TAB_PREF = 'chat.tab';

/** 文本侧正文：引用路径 + 文本附件；图片走多模态字段 */
function toApiText(m: LocalMessage): string {
  const parts: string[] = [];
  if (m.content) parts.push(m.content);
  if (m.refs?.length) {
    const projectRefs = m.refs.filter((r) => r.collection !== 'workspace');
    const wsRefs = m.refs.filter((r) => r.collection === 'workspace');
    if (projectRefs.length) {
      const kbRefs = projectRefs.filter(
        (r) => r.collection === 'knowledge' || r.collection === 'templates',
      );
      const otherRefs = projectRefs.filter(
        (r) => r.collection === 'prompts' || r.collection === 'cases',
      );
      if (kbRefs.length) {
        const lines = kbRefs.map(
          (r) => `- ${r.path} 《${r.title}》（${r.category} · ${formatSlashBadge(r.format)}）`,
        );
        parts.push(`引用项目文档（请使用 kb_read 读取）：\n${lines.join('\n')}`);
      }
      if (otherRefs.length) {
        const lines = otherRefs.map(
          (r) => `- ${r.collection}/${r.path} 《${r.title}》（${r.category}）`,
        );
        parts.push(`引用管理文档（路径已给出，正文可能已在上文）：\n${lines.join('\n')}`);
      }
    }
    if (wsRefs.length) {
      const lines = wsRefs.map(
        (r) => `- ${r.path} 《${r.title}》（${r.format === 'dir' ? '文件夹' : '文件'}）`,
      );
      parts.push(`引用工作区路径（请使用 fs_list / fs_read）：\n${lines.join('\n')}`);
    }
  }
  if (m.attachments?.length) {
    parts.push(
      m.attachments
        .map((a) => `附件《${a.name}》：\n\`\`\`\`\n${a.content}\n\`\`\`\``)
        .join('\n\n'),
    );
  }
  return parts.join('\n\n');
}

/** 组装发给模型的 content（有图则为多模态数组） */
function toApiMessageContent(m: LocalMessage): ChatMessage['content'] {
  const text = toApiText(m);
  if (!m.images?.length) return text;
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  else parts.push({ type: 'text', text: '请查看图片。' });
  for (const img of m.images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  }
  return parts;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

async function fileToImageAtt(file: File): Promise<ImageAtt> {
  if (!IMAGE_MIME.includes(file.type) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
    throw new Error(`${file.name || '图片'}：不支持的格式`);
  }
  if (file.size > FILE_MAX_BYTES) {
    throw new Error(`${file.name || '图片'}：超过 ${Math.round(FILE_MAX_BYTES / 1024 / 1024)} MB`);
  }
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl.startsWith('data:image/')) throw new Error('无法识别为图片');
  return {
    id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: file.name || `paste-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`,
    size: file.size,
    mime: file.type || 'image/png',
    dataUrl,
  };
}

function composerFileCount(atts: Attachment[], imgs: ImageAtt[]): number {
  return atts.length + imgs.length;
}

/** 推理等级（DeepSeek reasoning_effort 有效值 low/high/max） */
const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string; desc: string }> = [
  { value: 'low', label: 'Low', desc: '响应更快，适合简单问答' },
  { value: 'high', label: 'High', desc: '质量与速度均衡（默认）' },
  { value: 'max', label: 'Max', desc: '最深推理，适合复杂分析' },
];

/** 访问权限（对齐 dsh；需 npm run dev 本地 Runner） */
const ACCESS_OPTIONS: Array<{ value: AccessLevel; label: string }> = [
  { value: 'readonly', label: '仅可查看' },
  { value: 'readwrite', label: '工作区内修改' },
  { value: 'full', label: '完全权限' },
];

function toolKindLabel(name: string): string {
  if (name === 'present') return '交付文件';
  if (name === 'todo_write') return '待办';
  if (name.startsWith('todo_')) return '待办事项';
  if (name === 'ask_user_question') return '向用户提问';
  if (name === 'bash') return 'Bash';
  if (name === 'pwsh') return 'PowerShell';
  if (name.startsWith('bash_session_') || name.startsWith('pwsh_session_')) return '持久终端';
  if (name.startsWith('working_directory_')) return '工作目录';
  if (name.startsWith('skill_')) return 'Skill';
  if (name.startsWith('workspace_changes_')) return '工作区变更';
  if (name === 'load_workspace_dependencies') return '工作区依赖';
  if (name === 'office_to_pdf') return 'Office转PDF';
  if (name === 'submit_plan') return '提交计划';
  if (name.startsWith('goal_')) return '会话目标';
  if (name.startsWith('schedule_')) return '定时提醒';
  if (
    name === 'list_agents' ||
    name === 'spawn_subagent' ||
    name === 'fork_subagent' ||
    name.startsWith('subagent_')
  ) {
    return '子代理';
  }
  if (name === 'workflow') return '工作流';
  if (name === 'job_list') return '任务列表';
  if (name === 'job_output') return '任务输出';
  if (name === 'job_kill') return '终止任务';
  if (name === 'web_search') return t('tool.kind.webSearch');
  if (name === 'web_fetch') return t('tool.kind.webFetch');
  if (name.startsWith('kb_')) return t('tool.kind.kb');
  if (name.startsWith('fs_')) return t('tool.kind.fs');
  if (name.startsWith('memory_')) return t('tool.kind.memory');
  return name;
}

/** 把服务端/LLM 原始错误收成可读文案 */
function formatChatError(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '请求失败';
  if (/service_unavailable|too busy|瞬时繁忙|服务繁忙/i.test(s)) {
    return '模型服务瞬时繁忙，请稍后重试';
  }
  try {
    const j = JSON.parse(s) as { error?: unknown; message?: string };
    const err = (j?.error ?? j) as { message?: string; code?: string; type?: string };
    if (err && typeof err === 'object') {
      const blob = `${err.message || ''} ${err.code || ''} ${err.type || ''}`;
      if (/service_unavailable|too busy/i.test(blob)) {
        return '模型服务瞬时繁忙，请稍后重试';
      }
      if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
    }
  } catch {
    // ignore
  }
  return s.length > 280 ? `${s.slice(0, 280)}…` : s;
}

function activityKindForTool(name: string): ActivityStep['kind'] {
  if (name === 'present') return 'fs';
  if (
    name === 'todo_write' ||
    name.startsWith('todo_') ||
    name === 'ask_user_question' ||
    name === 'bash' ||
    name === 'pwsh' ||
    name.startsWith('bash_session_') ||
    name.startsWith('pwsh_session_') ||
    name.startsWith('working_directory_') ||
    name.startsWith('skill_') ||
    name.startsWith('workspace_changes_') ||
    name === 'load_workspace_dependencies' ||
    name === 'office_to_pdf' ||
    name === 'submit_plan' ||
    name.startsWith('goal_') ||
    name.startsWith('schedule_') ||
    name === 'list_agents' ||
    name === 'spawn_subagent' ||
    name === 'fork_subagent' ||
    name.startsWith('subagent_') ||
    name === 'workflow' ||
    name.startsWith('job_')
  ) {
    return 'tool';
  }
  if (name === 'web_search') return 'web_search';
  if (name === 'web_fetch') return 'web_fetch';
  if (name.startsWith('fs_')) return 'fs';
  if (name.startsWith('kb_')) return 'kb';
  if (name.startsWith('memory_')) return 'memory';
  return 'tool';
}

/** dsh 风格分析进度行图标 */
function ActivityStepIcon({
  kind,
  status,
}: {
  kind: ActivityStep['kind'];
  status: ActivityStep['status'];
}) {
  const cls =
    status === 'error'
      ? 'w-3.5 h-3.5 shrink-0 text-red-500'
      : status === 'running'
        ? 'w-3.5 h-3.5 shrink-0 text-stone-500'
        : 'w-3.5 h-3.5 shrink-0 text-stone-400';
  if (status === 'running' && kind === 'thinking') {
    return (
      <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-purple-400 border-t-transparent animate-spin" />
    );
  }
  if (kind === 'thinking') {
    return (
      <Svg className={cls}>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </Svg>
    );
  }
  if (kind === 'web_search' || kind === 'web_fetch') {
    return (
      <Svg className={cls}>
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </Svg>
    );
  }
  if (kind === 'fs' || kind === 'kb') {
    return (
      <Svg className={cls}>
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      </Svg>
    );
  }
  if (kind === 'memory') {
    return (
      <Svg className={cls}>
        <path d="M12 2a4 4 0 0 1 4 4v2h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2V6a4 4 0 0 1 4-4Z" />
      </Svg>
    );
  }
  return (
    <Svg className={cls}>
      <path d="m12 3 1.9 5.8H20l-4.9 3.6 1.9 5.8L12 14.6 7.1 18.2l1.9-5.8L4 8.8h6.1Z" />
    </Svg>
  );
}

function toolArgsDetail(name: string, argsJson?: string): string {
  if (!argsJson) return '';
  if (name.startsWith('web_')) return webToolDetail(name, argsJson);
  if (name === 'present') {
    try {
      const a = JSON.parse(argsJson) as { files?: Array<{ path?: string }> };
      const paths = (a.files ?? []).map((f) => f.path).filter(Boolean);
      return paths.slice(0, 3).join(', ') + (paths.length > 3 ? '…' : '');
    } catch {
      return '';
    }
  }
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    if (name === 'submit_plan') {
      const title = typeof a.title === 'string' ? a.title.trim() : '';
      return title.length > 60 ? `${title.slice(0, 60)}…` : title;
    }
    if (name === 'bash' || name === 'pwsh') {
      const cmd = typeof a.command === 'string' ? a.command.trim() : '';
      const bg = a.background === true ? ' [bg]' : '';
      const base = cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
      return `${base}${bg}`;
    }
    if (name.startsWith('bash_session_') || name.startsWith('pwsh_session_')) {
      const sid = typeof a.sessionId === 'string' ? a.sessionId.trim() : '';
      const cmd = typeof a.command === 'string' ? a.command.trim() : '';
      const short = cmd.length > 48 ? `${cmd.slice(0, 48)}…` : cmd;
      return [sid, short].filter(Boolean).join(' · ');
    }
    if (name.startsWith('working_directory_')) {
      const p = typeof a.path === 'string' ? a.path.trim() : '';
      const id = typeof a.id === 'string' ? a.id.trim() : '';
      return [id, p].filter(Boolean).join(' · ');
    }
    if (name.startsWith('skill_')) {
      const n = typeof a.name === 'string' ? a.name.trim() : '';
      const p = typeof a.path === 'string' ? a.path.trim() : '';
      return [n, p].filter(Boolean).join(' · ');
    }
    if (name.startsWith('workspace_changes_')) {
      return '';
    }
    if (name.startsWith('job_')) {
      const id = typeof a.jobId === 'string' ? a.jobId.trim() : '';
      return id;
    }
    if (name.startsWith('schedule_')) {
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      const id = typeof a.id === 'string' ? a.id.trim() : '';
      const due = typeof a.dueAt === 'string' ? a.dueAt.trim() : '';
      const delay =
        typeof a.delayMinutes === 'number' && Number.isFinite(a.delayMinutes)
          ? `+${a.delayMinutes}m`
          : '';
      return [text, id, due || delay].filter(Boolean).join(' · ');
    }
    if (
      name === 'list_agents' ||
      name === 'spawn_subagent' ||
      name === 'fork_subagent' ||
      name.startsWith('subagent_')
    ) {
      const agent = typeof a.agent === 'string' ? a.agent.trim() : '';
      const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
      const id = typeof a.id === 'string' ? a.id.trim() : '';
      const short = prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt;
      return [name === 'fork_subagent' ? 'fork' : '', agent, id, short].filter(Boolean).join(' · ');
    }
    if (name === 'workflow') {
      const meta = a.meta as { name?: unknown } | undefined;
      const wn = typeof meta?.name === 'string' ? meta.name.trim() : '';
      return wn || 'workflow';
    }
    if (name === 'fs_glob' || name === 'fs_grep') {
      const pat = typeof a.pattern === 'string' ? a.pattern.trim() : '';
      const p = typeof a.path === 'string' ? a.path.trim() : '';
      return [pat, p].filter(Boolean).join(' @ ') || pat;
    }
    if (typeof a.path === 'string' && a.path.trim()) return a.path.trim();
    if (typeof a.query === 'string' && a.query.trim()) return a.query.trim();
  } catch {
    // ignore
  }
  return '';
}

/** 思考中：取最近一段首行作摘要（仿 dsh ReasoningRow） */
function latestParagraphFirstLine(text: string): string {
  let summary = '';
  let paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  for (;;) {
    const next = separator.exec(text);
    const paragraphEnd = next === null ? text.length : next.index + next[0].indexOf('\n');
    const newline = text.indexOf('\n', paragraphStart);
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== '') summary = candidate;
    }
    if (next === null) return summary;
    paragraphStart = next.index + next[0].length;
  }
}

/** 按「工作步骤展示」偏好生成工具提示 */
function toolStepHint(
  detail: GeneralPrefs['toolStepDetail'],
  kind: string,
  name: string,
  status: 'running' | 'done',
): string | null {
  if (detail === 'concise') {
    return status === 'running' ? t('tool.running') : null;
  }
  if (detail === 'standard') {
    return status === 'running' ? t('tool.callingKind', { kind }) : t('tool.doneKind', { kind });
  }
  if (detail === 'detailed') {
    return status === 'running'
      ? t('tool.callingNamed', { kind, name })
      : t('tool.doneNamed', { kind, name });
  }
  // full：完成态也保留，文案更完整
  return status === 'running'
    ? t('tool.callingFull', { kind, name })
    : t('tool.doneFull', { kind, name });
}

function Svg({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ChevronIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
const ChevronRightIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);
const CheckIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
const CopyIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Svg>
);
const DatabaseIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v14a9 3 0 0 0 18 0V5" />
    <path d="M3 12a9 3 0 0 0 18 0" />
  </Svg>
);
const GaugeIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <path d="m12 14 4-4" />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </Svg>
);
const FileIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </Svg>
);
const PaperclipIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <path d="m16.5 9.4-7.07 7.07a3 3 0 0 1-4.24-4.24l7.07-7.07a2 2 0 1 1 2.83 2.83L8.02 14.1a1 1 0 0 1-1.41-1.41l7.07-7.07" />
  </Svg>
);
/** 发送：向上箭头（圆钮内光学居中） */
const SendIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </Svg>
);
const FolderIcon = ({ className = '', open = false }: { className?: string; open?: boolean }) => (
  <Svg className={className}>
    {open ? (
      <>
        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6A2 2 0 0 1 18.45 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.69.9H18a2 2 0 0 1 2 2v2" />
      </>
    ) : (
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9l-.81-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    )}
  </Svg>
);
/** dsh 风格展开三角：默认朝右，展开旋转 90° 朝下 */
const TriangleChevron = ({
  className = '',
  open = false,
}: {
  className?: string;
  open?: boolean;
}) => (
  <svg
    className={`${className} tw-arrow ${open ? 'is-open' : ''}`}
    viewBox="0 0 12 12"
    fill="currentColor"
    aria-hidden
  >
    <path d="M4.2 2.4a.75.75 0 0 1 1.2-.57l4.2 3.35a.75.75 0 0 1 0 1.14l-4.2 3.35A.75.75 0 0 1 4.2 9.1V2.9Z" />
  </svg>
);
const SearchIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);
const PlusSquareIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M12 8v8" />
    <path d="M8 12h8" />
  </Svg>
);
const PinIcon = ({ className = '', filled = false }: { className?: string; filled?: boolean }) => (
  <Svg className={className}>
    {filled ? (
      <path
        fill="currentColor"
        stroke="none"
        d="M12 2a3 3 0 0 1 3 3v3.5l2.5 2.5V13h-3.5V20l-1.5 2-1.5-2v-7H7.5v-2L10 8.5V5a3 3 0 0 1 3-3Z"
      />
    ) : (
      <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2z" />
    )}
  </Svg>
);
const EllipsisIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
  </Svg>
);
const ArchiveBoxIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Z" />
    <path d="M8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3" />
    <path d="M10 12h4" />
  </Svg>
);
const PluginIcon = ({ className = '' }: { className?: string }) => (
  <Svg className={className}>
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </Svg>
);
/** dsh 风格相对时间：19天 / 1个月 */
function relTimeLabel(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}个月`;
  return `${Math.floor(mon / 12)}年`;
}

function relTimePreviewLabel(ts: number): string {
  const base = relTimeLabel(ts);
  if (base === '刚刚') return '刚刚';
  if (base.endsWith('前')) return base;
  return `${base}前`;
}

/** 会话行：悬停滚动长标题 + 右侧预览（标题/时间/状态） */
function WorkspaceMoreMenu({
  open,
  onToggle,
  onRename,
  onDelete,
}: {
  open: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete?: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-label="更多"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="w-6 h-6 flex items-center justify-center rounded text-(--tw-label-tertiary) hover:text-(--tw-label-primary) hover:bg-(--tw-session-hover-bg)"
      >
        <EllipsisIcon className="w-3.5 h-3.5" />
      </button>
      <RailMenuPortal open={open} anchorRef={btnRef} dataAttr="data-ws-menu">
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-50"
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
        >
          <Svg className="w-3.5 h-3.5">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </Svg>
          重命名
        </button>
        {onDelete ? (
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-red-600 hover:bg-red-50"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Svg className="w-3.5 h-3.5">
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14H6L5 6" />
            </Svg>
            删除工作区
          </button>
        ) : null}
      </RailMenuPortal>
    </div>
  );
}

/** 侧栏「…」菜单：portal 到 body，避免被 overflow 裁切 */
function RailMenuPortal({
  open,
  anchorRef,
  dataAttr,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  dataAttr: 'data-session-menu' | 'data-ws-menu';
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const menuW = 160;
      const openUp = r.bottom + 200 > window.innerHeight - 8;
      // dsh：菜单锚在按钮左缘下方，向右展开（可跨出侧栏）
      const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
      setPos({
        top: openUp ? r.top - 4 : r.bottom + 4,
        left,
        openUp,
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchorRef]);

  if (!open || !pos || typeof document === 'undefined') return null;

  const attrs = { [dataAttr]: '' } as Record<string, string>;
  return createPortal(
    <div
      {...attrs}
      className="tw-popover tw-popover-anim z-80 w-40 rounded-xl border border-stone-200 py-1 shadow-lg"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        transform: pos.openUp ? 'translateY(-100%)' : undefined,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function SessionRailRow({
  s,
  nested = false,
  active,
  menuOpen,
  busy,
  onOpen,
  onRename,
  onToggleMenu,
  onTogglePin,
  onToggleArchive,
  onExport,
  onRemove,
  onRestore,
}: {
  s: ChatSession;
  nested?: boolean;
  active: boolean;
  menuOpen: boolean;
  busy: boolean;
  onOpen: () => void;
  onRename: () => void;
  onToggleMenu: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onExport: () => void;
  onRemove: () => void;
  onRestore?: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const titleInnerRef = useRef<HTMLSpanElement>(null);
  const previewEnterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [overflow, setOverflow] = useState(false);
  /** 悬停标题满 1s 后显示预览气泡 */
  const [showPreview, setShowPreview] = useState(false);
  const [previewPos, setPreviewPos] = useState<{ top: number; left: number } | null>(null);

  function clearPreviewEnter() {
    if (previewEnterTimer.current != null) {
      clearTimeout(previewEnterTimer.current);
      previewEnterTimer.current = null;
    }
  }
  function clearPreviewLeave() {
    if (previewLeaveTimer.current != null) {
      clearTimeout(previewLeaveTimer.current);
      previewLeaveTimer.current = null;
    }
  }
  function schedulePreviewLeave() {
    clearPreviewLeave();
    previewLeaveTimer.current = setTimeout(() => {
      setShowPreview(false);
      clearPreviewEnter();
    }, 180);
  }
  function schedulePreviewEnter() {
    clearPreviewLeave();
    clearPreviewEnter();
    previewEnterTimer.current = setTimeout(() => setShowPreview(true), 1000);
  }

  /** 预览气泡展示完整会话标题（不截断，与侧栏那行一致） */
  const previewFullTitle = s.title.trim() || '新对话';

  useLayoutEffect(() => {
    const btn = titleBtnRef.current;
    const inner = titleInnerRef.current;
    if (!btn || !inner) return;
    const measure = () => {
      // 临时取消省略限制，量真实文案宽度
      inner.style.maxWidth = 'none';
      inner.style.overflow = 'visible';
      inner.style.display = 'inline-block';
      const full = inner.scrollWidth;
      inner.style.maxWidth = '';
      inner.style.overflow = '';
      inner.style.display = '';
      const view = btn.clientWidth;
      const overflowing = full > view + 1;
      setOverflow(overflowing);
      if (overflowing) {
        inner.style.setProperty('--tw-marquee-shift', `${Math.min(0, view - full - 28)}px`);
      } else {
        inner.style.removeProperty('--tw-marquee-shift');
      }
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(btn);
    return () => ro?.disconnect();
  }, [s.title]);

  useLayoutEffect(() => {
    if (!showPreview || menuOpen) {
      setPreviewPos(null);
      return;
    }
    const place = () => {
      const el = rowRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPreviewPos({ top: r.top + r.height / 2, left: r.right + 8 });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [showPreview, menuOpen, s.title]);

  useEffect(() => {
    if (menuOpen) {
      clearPreviewEnter();
      clearPreviewLeave();
      setShowPreview(false);
    }
  }, [menuOpen]);

  const statusLabel = busy ? '生成中' : '空闲';
  const dimmed = Boolean(s.archived || s.deleted);

  return (
    <div
      ref={rowRef}
      className={`tw-session-row relative ${nested ? 'is-nested' : ''} ${
        active ? 'is-selected' : ''
      } ${menuOpen ? 'is-menu-open' : ''} ${busy ? 'is-busy' : ''} ${dimmed ? 'opacity-50' : ''}`}
      onMouseLeave={() => {
        clearPreviewEnter();
        schedulePreviewLeave();
      }}
    >
      {busy ? (
        <span className="tw-session-busy-slot" data-hint="生成中" aria-label="生成中">
          <span className="tw-session-busy-dot" aria-hidden />
        </span>
      ) : null}
      {s.pinned && !dimmed ? (
        <span className="tw-slot" aria-hidden>
          <PinIcon filled className="tw-pin-indicator w-3 h-3" />
        </span>
      ) : null}
      <button
        ref={titleBtnRef}
        type="button"
        onClick={onOpen}
        onDoubleClick={onRename}
        onMouseEnter={() => schedulePreviewEnter()}
        onMouseLeave={() => {
          clearPreviewEnter();
          schedulePreviewLeave();
        }}
        className={`tw-session-title text-left outline-none focus:outline-none focus-visible:outline-none ${
          overflow ? 'is-overflow' : ''
        }`}
      >
        <span ref={titleInnerRef} className="tw-session-title-inner">
          {s.title}
        </span>
      </button>
      <span className="tw-session-time pr-1">{relTimeLabel(s.updatedAt)}</span>
      <div
        data-session-menu=""
        className="tw-row-actions items-center gap-0.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative">
          <button
            ref={menuBtnRef}
            type="button"
            aria-label="更多"
            onClick={onToggleMenu}
            className="tw-session-action-btn w-6 h-6 flex items-center justify-center rounded"
          >
            <EllipsisIcon className="w-3.5 h-3.5" />
          </button>
          <RailMenuPortal open={menuOpen} anchorRef={menuBtnRef} dataAttr="data-session-menu">
            {s.deleted ? (
              <>
                {onRestore ? (
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-50"
                    onClick={onRestore}
                  >
                    恢复会话
                  </button>
                ) : null}
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-red-600 hover:bg-red-50"
                  onClick={onRemove}
                >
                  永久删除
                </button>
              </>
            ) : (
              <>
                {!s.archived && (
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-50"
                    onClick={onTogglePin}
                  >
                    <PinIcon filled={Boolean(s.pinned)} className="w-3.5 h-3.5" />
                    {s.pinned ? '取消置顶' : '置顶会话'}
                  </button>
                )}
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-50"
                  onClick={onRename}
                >
                  <Svg className="w-3.5 h-3.5">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </Svg>
                  重命名
                </button>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-50"
                  onClick={onToggleArchive}
                >
                  <ArchiveBoxIcon className="w-3.5 h-3.5" />
                  {s.archived ? '取消归档' : '归档会话'}
                </button>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-50"
                  onClick={onExport}
                >
                  <Svg className="w-3.5 h-3.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" x2="12" y1="15" y2="3" />
                  </Svg>
                  导出会话
                </button>
                {/* 仅已归档可删，且为永久删除 */}
                {s.archived ? (
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-red-600 hover:bg-red-50"
                    onClick={onRemove}
                  >
                    <Svg className="w-3.5 h-3.5">
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M19 6l-1 14H6L5 6" />
                    </Svg>
                    永久删除
                  </button>
                ) : null}
              </>
            )}
          </RailMenuPortal>
        </div>
        {!s.deleted && (
          <button
            type="button"
            aria-label={s.archived ? '取消归档' : '归档会话'}
            data-hint={s.archived ? '取消归档' : '归档会话'}
            onClick={onToggleArchive}
            className="tw-session-action-btn w-6 h-6 flex items-center justify-center rounded"
          >
            <ArchiveBoxIcon className="w-3.5 h-3.5" />
          </button>
        )}
        {!s.archived && !s.deleted && (
          <button
            type="button"
            data-hint={s.pinned ? '取消置顶' : '置顶'}
            onClick={onTogglePin}
            className="tw-session-action-btn w-6 h-6 flex items-center justify-center rounded"
          >
            <PinIcon filled={Boolean(s.pinned)} className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {showPreview && !menuOpen && previewPos && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="tw-session-preview"
              role="tooltip"
              style={{
                position: 'fixed',
                top: previewPos.top,
                left: previewPos.left,
                transform: 'translateY(-50%)',
              }}
              onMouseEnter={() => {
                clearPreviewEnter();
                clearPreviewLeave();
                setShowPreview(true);
              }}
              onMouseLeave={() => schedulePreviewLeave()}
            >
              <div className="tw-session-preview-title">{previewFullTitle}</div>
              <div className="tw-session-preview-meta">{relTimePreviewLabel(s.updatedAt)}</div>
              <div className={`tw-session-preview-status ${busy ? 'is-busy' : ''}`}>
                {statusLabel}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
const SHIELD_PATH =
  'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z';
function ShieldIcon({ level, className = '' }: { level: AccessLevel; className?: string }) {
  return (
    <Svg className={className}>
      <path d={SHIELD_PATH} />
      {level === 'readonly' && <path d="m9 12 2 2 4-4" />}
      {level === 'readwrite' && (
        <>
          <path d="M9 10h6" />
          <path d="M9 14h3" />
        </>
      )}
      {level === 'full' && (
        <>
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </>
      )}
    </Svg>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtExactTokens(n: number): string {
  return `${n.toLocaleString('en-US')} tok`;
}

/** 紧凑时长：不足 1 分钟用秒，否则「X 分 Y 秒」 */
function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10} 秒`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`;
}

function fmtPct(n: number): string {
  if (n >= 99.95) return '100';
  if (n >= 10) return String(Math.round(n));
  return n.toFixed(1);
}

/** 粗估中文为主文本的 token 数（API 不披露上下文分段时，仅用于占用条示意） */
function estimateTokens(text: string): number {
  let n = 0;
  for (const ch of text) n += /[\u4e00-\u9fff]/.test(ch) ? 1 : 0.25;
  return Math.max(1, Math.round(n));
}

function uncachedOf(u: UsageInfo): number {
  if (u.uncachedTokens != null) return u.uncachedTokens;
  if (u.cachedTokens != null) return Math.max(0, u.promptTokens - u.cachedTokens);
  return u.promptTokens;
}

/** 输出 token：优先 completion；缺失时用 total − prompt 兜底（缓存命中回合常见） */
function completionTokensOf(u: UsageInfo | undefined | null): number {
  if (!u) return 0;
  if (typeof u.completionTokens === 'number' && u.completionTokens > 0) return u.completionTokens;
  if (typeof u.totalTokens === 'number' && typeof u.promptTokens === 'number') {
    return Math.max(0, u.totalTokens - u.promptTokens);
  }
  return typeof u.completionTokens === 'number' ? Math.max(0, u.completionTokens) : 0;
}

function cacheHitPct(cached: number, prompt: number): number | null {
  if (prompt <= 0) return null;
  return (cached / prompt) * 100;
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** 消息时间：当天显示 HH:mm，跨天显示 M/D HH:mm */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * 复制按钮（dsh MessageIconActions）：
 * 点击复制 → 对勾停留 1 秒切回；成功窗口内不重复触发。
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  async function onCopy() {
    if (copied) return;
    if (!(await copyText(text))) return;
    setCopied(true);
    timerRef.current = window.setTimeout(() => setCopied(false), 1000);
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? '已复制' : '复制'}
      className="tw-icon-btn tw-msg-action-btn inline-flex items-center justify-center rounded-md transition-colors"
    >
      {copied ? (
        <CheckIcon className="w-3.5 h-3.5 text-emerald-600" />
      ) : (
        <CopyIcon className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

/** 上下文占用环 */
function Ring({ pct }: { pct: number }) {
  return (
    <svg className="w-3.5 h-3.5 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="none" stroke="var(--color-stone-200)" strokeWidth="3" />
      <circle
        cx="10"
        cy="10"
        r="8"
        fill="none"
        stroke="#4176e6"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${(Math.max(pct, 1) / 100) * 50.27} 50.27`}
      />
    </svg>
  );
}

/**
 * 统计弹层座位（dsh useStatDialog 精简版）：
 * 触发器上方锚定、视口夹紧、点击外部 / Escape 关闭。
 */
function useStatDialog() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = rootRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const gap = 8;
      const margin = 12;
      let left = a.left + a.width / 2 - p.width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin));
      let top = a.top - p.height - gap;
      if (top < margin) top = a.bottom + gap;
      setPos({ position: 'fixed', left, top, visibility: 'visible' });
    };
    // 先隐藏测量再定位，避免首帧闪在 (0,0)
    setPos({ position: 'fixed', left: 0, top: 0, visibility: 'hidden' });
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick, true);
    };
  }, [open]);

  return { open, setOpen, rootRef, panelRef, pos };
}

function StatDialog({
  title,
  titleValue,
  icon,
  children,
}: {
  title: string;
  titleValue?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="tw-popover w-[min(320px,calc(100vw-24px))] rounded-2xl border border-stone-200 p-3.5 shadow-xl text-left">
      <div className="flex items-center gap-2 text-[13px]">
        {icon}
        <span className="tw-popover-title font-medium text-stone-800">{title}</span>
        {titleValue !== undefined && (
          <span className="tw-popover-muted ml-auto text-stone-500 tabular-nums">{titleValue}</span>
        )}
      </div>
      <div className="mt-2.5 mb-2.5 border-t border-stone-100" />
      {children}
    </div>
  );
}

function StatRows({ rows }: { rows: Array<{ label: string; value: string; hide?: boolean }> }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-[13px]">
      {rows
        .filter((r) => !r.hide)
        .map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-stone-500">{r.label}</dt>
            <dd className="text-stone-800 tabular-nums text-right">{r.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** 可点击统计触发器：pill=状态栏胶囊；ghost=消息行轻量文字（对齐 dsh 用量样式） */
function DialogPill({
  label,
  icon,
  ariaLabel,
  title,
  titleValue,
  children,
  variant = 'pill',
}: {
  label: ReactNode;
  icon: ReactNode;
  ariaLabel: string;
  title: string;
  titleValue?: string;
  children: ReactNode;
  variant?: 'pill' | 'ghost';
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog();
  const btnCls =
    variant === 'ghost'
      ? `tw-msg-action-meta inline-flex items-center gap-1 tabular-nums transition-colors ${
          open ? 'text-stone-600' : 'text-stone-400 hover:text-stone-600'
        }`
      : `inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full transition-colors ${
          open ? 'bg-stone-200/70 text-stone-600' : 'hover:bg-stone-200/60 hover:text-stone-600'
        }`;
  return (
    <span ref={rootRef} className="relative inline-flex items-center">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(!open)}
        className={btnCls}
      >
        {icon}
        <span className="leading-none">{label}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={title}
            style={pos ?? { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }}
            className="z-80"
          >
            <StatDialog title={title} titleValue={titleValue} icon={icon}>
              {children}
            </StatDialog>
          </div>,
          document.body,
        )}
    </span>
  );
}

/** 「回合」Tab：列表可展开完整正文（不含思考） */
function ThreadOutlinePane({
  messages,
  busy,
  onRestoreCheckpoint,
}: {
  messages: LocalMessage[];
  busy?: boolean;
  /** 截断到该轮末并续写 */
  onRestoreCheckpoint?: (endMessageIndex: number, turnIndex: number) => void;
}) {
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set());
  const items = useMemo(
    () =>
      buildTurnOutline(
        messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : toApiText(m),
          time: m.time,
        })),
      ),
    [messages],
  );

  function toggle(index: number) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  if (!items.length) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-stone-400">
        暂无回合（还没有用户/助手对话）
      </div>
    );
  }

  return (
    <ol className="list-none m-0 p-0 w-full max-w-[min(64rem,100%)] mx-auto space-y-2">
      {items.map((it) => {
        const open = openIds.has(it.index);
        const restoreReady = Boolean(it.assistantText);
        return (
          <li
            key={it.index}
            className={`rounded-xl border bg-white shadow-sm overflow-hidden ${
              open ? 'border-[#4176e6]/35' : 'border-stone-200'
            }`}
          >
            <div className="flex items-start gap-1 px-3 py-2.5">
              <button
                type="button"
                onClick={() => toggle(it.index)}
                aria-expanded={open}
                className="min-w-0 flex-1 text-left hover:bg-stone-50/80 rounded-lg -mx-1 px-1 py-0.5 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-medium text-stone-400 tabular-nums">
                    第 {it.index} 轮
                  </span>
                  <ChevronIcon
                    className={`w-3.5 h-3.5 text-stone-400 ml-auto shrink-0 transition-transform ${
                      open ? 'rotate-180' : ''
                    }`}
                  />
                </div>
                {!open ? (
                  <div className="space-y-1 text-[13px] leading-5">
                    <p className="m-0 text-stone-800 truncate">
                      <span className="text-stone-400 mr-1.5">用户</span>
                      {it.userPreview}
                    </p>
                    <p className="m-0 text-stone-600 truncate">
                      <span className="text-stone-400 mr-1.5">助手</span>
                      {it.assistantPreview || '（待回复）'}
                    </p>
                  </div>
                ) : null}
              </button>
              {onRestoreCheckpoint ? (
                <button
                  type="button"
                  disabled={busy || !restoreReady}
                  data-hint={
                    !restoreReady
                      ? '待本轮助手回复完成后可从此处继续'
                      : '截断到本轮末，填入续写并发送'
                  }
                  className="shrink-0 mt-0.5 text-[11px] text-[#4176e6] hover:underline disabled:opacity-40 disabled:no-underline px-1 whitespace-nowrap"
                  onClick={() => onRestoreCheckpoint(it.endMessageIndex, it.index)}
                >
                  从此处继续
                </button>
              ) : null}
            </div>
            {open ? (
              <div className="px-3 pb-3 space-y-2.5 text-[13px] leading-5 border-t border-stone-100 pt-2.5">
                <div>
                  <div className="text-[11px] font-medium text-stone-400 mb-0.5">用户</div>
                  <div className="whitespace-pre-wrap break-words text-stone-800">
                    {it.userText || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-medium text-stone-400 mb-0.5">助手</div>
                  {it.assistantText ? (
                    <div
                      className="chat-md prose prose-sm prose-stone max-w-none tw-chat-text"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(it.assistantText) }}
                    />
                  ) : (
                    <div className="text-stone-400">（待回复）</div>
                  )}
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 输入框下方状态栏（dsh StatsPills）：三枚胶囊均可点击查看详情。
 * 数据全部来自本会话真实请求用量 / 计时，不是写死常量。
 */
function StatusBar({
  messages,
  model,
  systemPromptTokens,
}: {
  messages: LocalMessage[];
  model: string | undefined;
  systemPromptTokens: number;
}) {
  const answered = messages.filter((m) => m.role === 'assistant' && m.usage);
  if (!answered.length) return null;
  const last = answered[answered.length - 1];
  const turns = messages.filter((m) => m.role === 'user').length;
  // 「步」= 助手完成轮次（有用量的回答），对齐 dsh steps
  const steps = answered.length;
  const total = answered.reduce((s, m) => s + (m.usage?.totalTokens ?? 0), 0);
  const promptSum = answered.reduce((s, m) => s + (m.usage?.promptTokens ?? 0), 0);
  const cachedSum = answered.reduce((s, m) => s + (m.usage?.cachedTokens ?? 0), 0);
  const uncachedSum = answered.reduce((s, m) => s + (m.usage ? uncachedOf(m.usage) : 0), 0);
  const cacheWriteSum = answered.reduce((s, m) => s + (m.usage?.cacheWriteTokens ?? 0), 0);
  const outputSum = answered.reduce((s, m) => s + completionTokensOf(m.usage), 0);
  const cacheKnown = answered.some((m) => m.usage?.cachedTokens != null);
  const hit = cacheKnown ? cacheHitPct(cachedSum, promptSum) : null;
  const llmMs = answered.reduce((s, m) => s + (m.llmMs ?? 0), 0);
  const toolMs = answered.reduce((s, m) => s + (m.toolMs ?? 0), 0);
  const ttftList = answered.map((m) => m.ttftMs).filter((n): n is number => n != null && n > 0);
  const avgTtft = ttftList.length ? ttftList.reduce((a, b) => a + b, 0) / ttftList.length : 0;
  // 会话输出速度：优先用解码时长加权；否则用各轮 tps 均值
  const decodeMs = answered.reduce((s, m) => {
    if (m.llmMs == null || m.ttftMs == null) return s;
    return s + Math.max(0, m.llmMs - m.ttftMs);
  }, 0);
  const tpsSamples = answered.map((m) => m.tps).filter((n): n is number => n != null && n > 0);
  const avgTps = tpsSamples.length
    ? tpsSamples.reduce((a, b) => a + b, 0) / tpsSamples.length
    : undefined;
  const sessionTps =
    decodeMs > 200 && outputSum > 0
      ? outputSum / (decodeMs / 1000)
      : (avgTps ?? (last.tps && last.tps > 0 ? last.tps : undefined));
  const windowSize = model ? MODEL_CONTEXT_WINDOW[model] : undefined;
  const ctxTokens = last.usage?.promptTokens ?? 0;
  const pct = windowSize ? Math.min(100, (ctxTokens / windowSize) * 100) : undefined;
  const sysTokens = Math.min(systemPromptTokens, ctxTokens);
  const convTokens = Math.max(0, ctxTokens - sysTokens);

  return (
    <div className="flex items-center justify-center gap-1 pt-2 text-xs text-stone-400 tabular-nums select-none">
      <DialogPill
        icon={<GaugeIcon className="w-3.5 h-3.5" />}
        label={
          <>
            {turns} 轮 {steps} 步{sessionTps ? ` · ${Math.round(sessionTps)} tok/s` : ''}
          </>
        }
        ariaLabel="会话统计"
        title="会话统计"
      >
        <StatRows
          rows={[
            { label: '模型用时', value: llmMs > 0 ? fmtDuration(llmMs) : '—' },
            { label: '工具调用用时', value: toolMs > 0 ? fmtDuration(toolMs) : '—' },
            {
              label: '首 token 平均 (TTFT)',
              value: ttftList.length ? fmtDuration(avgTtft) : '—',
            },
            {
              label: '输出速度 (TPS)',
              value: sessionTps ? `${Math.round(sessionTps)} tok/s` : '—',
            },
          ]}
        />
      </DialogPill>

      <DialogPill
        icon={<DatabaseIcon className="w-3.5 h-3.5" />}
        label={
          <>
            {fmtTokens(total)} tok
            {hit != null ? ` · 缓存命中 ${fmtPct(hit)}%` : ''}
          </>
        }
        ariaLabel="Token 用量"
        title="Token 用量"
        titleValue={fmtExactTokens(total)}
      >
        <StatRows
          rows={[
            { label: '缓存命中', value: hit != null ? `${fmtPct(hit)}%` : '—', hide: hit == null },
            { label: '未缓存输入', value: fmtExactTokens(uncachedSum) },
            { label: '缓存读取', value: fmtExactTokens(cachedSum), hide: !cacheKnown },
            { label: '缓存写入', value: fmtExactTokens(cacheWriteSum), hide: cacheWriteSum <= 0 },
            { label: '输出', value: fmtExactTokens(outputSum) },
          ]}
        />
      </DialogPill>

      {pct !== undefined && windowSize && (
        <DialogPill
          icon={<Ring pct={pct} />}
          label={`${fmtPct(pct)}%`}
          ariaLabel="上下文占用"
          title={`上下文已用 ${fmtPct(pct)}%`}
          titleValue={`~${fmtTokens(ctxTokens)} / ${fmtTokens(windowSize)}`}
        >
          <div className="h-2 rounded-full bg-stone-100 overflow-hidden flex mb-3">
            <span
              className="h-full bg-stone-400"
              style={{ width: `${(sysTokens / windowSize) * 100}%` }}
              data-hint="系统提示词"
            />
            <span
              className="h-full bg-[#4176e6]"
              style={{ width: `${(convTokens / windowSize) * 100}%` }}
              data-hint="对话消息"
            />
          </div>
          <StatRows
            rows={[
              { label: '系统提示词', value: `~${fmtTokens(sysTokens)}` },
              { label: '对话消息', value: `~${fmtTokens(convTokens)}` },
            ]}
          />
          <p className="mt-2.5 text-[11px] leading-4 text-stone-400">
            分段为示意估算（API 不返回上下文拆分）；总量以最近一轮 prompt_tokens 为准。
          </p>
        </DialogPill>
      )}
    </div>
  );
}

/** 助手消息行「用量」胶囊：点击查看本轮明细（dsh TurnUsagePanel） */
function TurnUsageButton({ usage, model }: { usage: UsageInfo; model: string | undefined }) {
  const hit =
    usage.cachedTokens != null ? cacheHitPct(usage.cachedTokens, usage.promptTokens) : null;
  return (
    <DialogPill
      variant="ghost"
      icon={<DatabaseIcon className="w-3.5 h-3.5 shrink-0" />}
      label={<>用量 {fmtTokens(usage.totalTokens)} tok</>}
      ariaLabel="本轮用量"
      title="本轮用量"
      titleValue={fmtExactTokens(usage.totalTokens)}
    >
      <StatRows
        rows={[
          { label: '提供方 / 模型', value: model ?? '—', hide: !model },
          { label: '缓存命中', value: hit != null ? `${fmtPct(hit)}%` : '—', hide: hit == null },
          { label: '未缓存输入', value: fmtExactTokens(uncachedOf(usage)) },
          {
            label: '缓存读取',
            value: fmtExactTokens(usage.cachedTokens ?? 0),
            hide: usage.cachedTokens == null,
          },
          {
            label: '缓存写入',
            value: fmtExactTokens(usage.cacheWriteTokens ?? 0),
            hide: !(usage.cacheWriteTokens && usage.cacheWriteTokens > 0),
          },
          { label: '输出', value: fmtExactTokens(usage.completionTokens) },
        ]}
      />
    </DialogPill>
  );
}

/**
 * 模型 + 推理等级合并菜单（dsh composer 右侧形态）：
 * 一级两行「模型 / 推理等级」；打开时主动 GET /models 刷新列表，避免只显示当前一项。
 */
function ModelEffortMenu({ settings }: { settings: LLMSettings | null }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<'model' | 'effort' | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsStatus, setModelsStatus] = useState<'idle' | 'loading' | 'ok' | 'fail'>('idle');
  const rootRef = useRef<HTMLDivElement>(null);
  const fetchSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setSub(null);
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 菜单打开即拉取 / 刷新可用模型（缓存命中时先展示缓存，后台再校验）
  useEffect(() => {
    if (!open || !settings) return;
    const cached = settings.availableModels?.length ? settings.availableModels : [settings.model];
    setModels(cached);
    setModelsStatus(settings.availableModels?.length ? 'ok' : 'loading');
    const seq = ++fetchSeq.current;
    fetchModels(settings.baseURL, settings.apiKey)
      .then((ids) => {
        if (seq !== fetchSeq.current) return;
        const list = ids.length ? ids : [settings.model];
        setModels(list);
        setModelsStatus('ok');
        // 写回 localStorage，供下次打开与设置页共用
        if (ids.length) patchSettings({ availableModels: ids });
      })
      .catch(() => {
        if (seq !== fetchSeq.current) return;
        setModelsStatus(cached.length > 1 ? 'ok' : 'fail');
      });
  }, [open, settings]);

  if (!settings) {
    return (
      <button
        type="button"
        onClick={() => openSettings('model')}
        className="flex items-center gap-1 h-7 shrink-0 pl-2 pr-1 text-[13px] leading-5 font-medium text-stone-500 rounded-md hover:bg-stone-100 transition-colors"
      >
        <span className="whitespace-nowrap">配置模型</span>
        <ChevronIcon className="w-3.5 h-3.5 shrink-0 text-stone-400" />
      </button>
    );
  }

  const effort = settings.reasoningEffort ?? 'high';
  const effortLabel = EFFORT_OPTIONS.find((o) => o.value === effort)?.label ?? 'High';

  function pick(patch: Partial<LLMSettings>) {
    patchSettings(patch);
    setOpen(false);
    setSub(null);
  }

  const rowCls = (active: boolean) =>
    `w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-[13px] transition-colors ${
      active ? 'bg-stone-100' : 'hover:bg-stone-100'
    }`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setSub(null);
        }}
        className={`tw-composer-bar-model group flex items-center gap-1 h-7 shrink-0 pl-2 pr-1 text-[13px] leading-5 font-medium rounded-md outline-none focus:outline-none focus-visible:outline-none transition-colors ${
          open ? 'bg-stone-100' : 'hover:bg-stone-100'
        }`}
        title={`${settings.model} · ${effortLabel}`}
        aria-label={`模型 ${settings.model}，推理 ${effortLabel}`}
      >
        <span className="tw-composer-bar-model-name max-w-40 truncate text-stone-600">
          {settings.model}
        </span>
        <span className="tw-composer-bar-effort whitespace-nowrap text-stone-400">
          {effortLabel}
        </span>
        <ChevronIcon
          className={`w-3.5 h-3.5 shrink-0 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="tw-popover tw-popover-anim absolute bottom-full right-0 mb-2 w-64 rounded-xl border border-stone-200 p-1 shadow-xl z-50">
          <button
            type="button"
            onMouseEnter={() => setSub('model')}
            onClick={() => setSub('model')}
            className={rowCls(sub === 'model')}
          >
            <span className="text-stone-700">模型</span>
            <span className="ml-auto max-w-32 truncate text-stone-400">{settings.model}</span>
            <ChevronRightIcon className="w-3.5 h-3.5 text-stone-400" />
          </button>
          <button
            type="button"
            onMouseEnter={() => setSub('effort')}
            onClick={() => setSub('effort')}
            className={rowCls(sub === 'effort')}
          >
            <span className="text-stone-700">推理等级</span>
            <span className="ml-auto text-stone-400">{effortLabel}</span>
            <ChevronRightIcon className="w-3.5 h-3.5 text-stone-400" />
          </button>

          {sub === 'model' && (
            <div className="tw-popover tw-popover-anim absolute right-full bottom-0 mr-1.5 w-64 max-h-72 overflow-y-auto rounded-xl border border-stone-200 p-1 shadow-xl">
              {modelsStatus === 'loading' && models.length <= 1 && (
                <div className="px-3 py-2 text-xs text-stone-400">正在识别可用模型…</div>
              )}
              {models.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => pick({ model: id })}
                  className={rowCls(false)}
                >
                  <span
                    className={`flex-1 truncate ${id === settings.model ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
                  >
                    {id}
                  </span>
                  {id === settings.model && <CheckIcon className="w-3.5 h-3.5 text-[#4176e6]" />}
                </button>
              ))}
              <div className="mt-1 border-t border-stone-100 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setSub(null);
                    openSettings('model');
                  }}
                  className="w-full px-3 py-1.5 rounded-lg text-left text-xs text-stone-400 hover:bg-stone-100"
                >
                  {modelsStatus === 'fail'
                    ? '识别失败，打开设置检查…'
                    : models.length > 1
                      ? '打开设置 · 模型…'
                      : '打开设置识别可用模型…'}
                </button>
              </div>
            </div>
          )}

          {sub === 'effort' && (
            <div className="tw-popover tw-popover-anim absolute right-full bottom-0 mr-1.5 w-60 rounded-xl border border-stone-200 p-1 shadow-xl">
              {EFFORT_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => pick({ reasoningEffort: o.value })}
                  className="w-full px-3 py-2 rounded-lg text-left hover:bg-stone-100 transition-colors"
                >
                  <div className="flex items-center gap-2 text-[13px]">
                    <span
                      className={`flex-1 ${effort === o.value ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
                    >
                      {o.label}
                    </span>
                    {effort === o.value && <CheckIcon className="w-3.5 h-3.5 text-[#4176e6]" />}
                  </div>
                  <div className="mt-0.5 text-xs text-stone-400">{o.desc}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 首帧快照：直接拿 localStorage 镜像渲染，避免刷新时先闪一下「新对话」空态
 * （岛屿是 client:only，服务端不输出，等 hydrate 完成才 setStore，
 * 那之前渲染的是 store=null 的空会话），hydrate 完成后会被权威数据覆盖。
 * 与侧栏 SpaceSwitcher 的 sessionStorage 缓存同一思路。
 *
 * 注意：loadSessionStore() 在无镜像时会现造一个空 store，
 * 每次调用 id 都不同，所以这里必须缓存并复用同一份。
 */
let bootSnapshot: { store: SessionStore; messages: LocalMessage[] } | null = null;
function readBootSnapshot(): { store: SessionStore; messages: LocalMessage[] } {
  if (!bootSnapshot) {
    const s = loadSessionStore();
    const active = s.sessions.find((x) => x.id === s.activeId);
    bootSnapshot = { store: s, messages: (active?.messages as LocalMessage[]) ?? [] };
  }
  return bootSnapshot;
}

export default function ChatApp({ slashDocs = [] }: { slashDocs?: SlashDoc[] }) {
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [ready, setReady] = useState(false);
  const [store, setStore] = useState<SessionStore | null>(() => readBootSnapshot().store);
  const [messages, setMessages] = useState<LocalMessage[]>(() => readBootSnapshot().messages);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [images, setImages] = useState<ImageAtt[]>([]);
  const [docRefs, setDocRefs] = useState<DocRef[]>([]);
  const [systemPrompt, setSystemPrompt] = useState(FALLBACK_SYSTEM_PROMPT);
  const [caseGenPanelOpen, setCaseGenPanelOpen] = useState(false);
  const [caseGenConfig, setCaseGenConfig] = useState<CaseGenPluginConfig | null>(null);
  const caseGenConfigRef = useRef<CaseGenPluginConfig | null>(null);
  caseGenConfigRef.current = caseGenConfig;
  /** 需求分析「用选中故事生成用例」带过来的预选（打开抽屉时消费一次） */
  const [caseGenPreset, setCaseGenPreset] = useState<{
    docId: string;
    storyIds: string[];
  } | null>(null);
  const [promptGenPanelOpen, setPromptGenPanelOpen] = useState(false);
  const [promptGenConfig, setPromptGenConfig] = useState<PromptGenPluginConfig | null>(null);
  const promptGenConfigRef = useRef<PromptGenPluginConfig | null>(null);
  promptGenConfigRef.current = promptGenConfig;
  const [knowledgeGenPanelOpen, setKnowledgeGenPanelOpen] = useState(false);
  const [knowledgeGenConfig, setKnowledgeGenConfig] = useState<KnowledgeGenPluginConfig | null>(
    null,
  );
  const knowledgeGenConfigRef = useRef<KnowledgeGenPluginConfig | null>(null);
  knowledgeGenConfigRef.current = knowledgeGenConfig;
  const [pluginDevConfig, setPluginDevConfig] = useState<PluginDevPluginConfig | null>(null);
  const pluginDevConfigRef = useRef<PluginDevPluginConfig | null>(null);
  pluginDevConfigRef.current = pluginDevConfig;
  /**
   * 激活插件开发胶囊时被提到「工作区内修改」之前的权限。
   * 只用于「点了胶囊又取消、还没开始开发」的场景：恢复用户原来的「仅可查看」。
   */
  const pluginDevPrevAccessRef = useRef<AccessLevel | null>(null);
  /** 从管理页「在会话中打开」带入：`root:path`，用于滚动定位到对应文件卡 */
  const [pendingFocusDoc, setPendingFocusDoc] = useState<string | null>(null);
  const [pluginIndex, setPluginIndex] = useState(0);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  /** 永久删除确认（仅已归档） */
  const [purgeSessionId, setPurgeSessionId] = useState<string | null>(null);
  const [wsMenuId, setWsMenuId] = useState<string | null>(null);
  const [wsDeleteTarget, setWsDeleteTarget] = useState<WorkspaceItem | null>(null);
  const [wsRenameId, setWsRenameId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  /** 侧栏「生成中」：按会话标记，切换会话不中断后台回合 */
  const [busySessionIds, setBusySessionIds] = useState<string[]>([]);
  const [error, setErrorState] = useState<string | null>(null);
  /** error=警告红；ok=信息绿（如会话统计） */
  const [errorTone, setErrorTone] = useState<'error' | 'ok'>('error');
  function setError(text: string | null, tone: 'error' | 'ok' = 'error') {
    setErrorTone(tone);
    setErrorState(text);
  }
  const [access, setAccess] = useState<AccessLevel>('readonly');
  const [showJump, setShowJump] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  /** 插件开关（localStorage） */
  const [pluginOn, setPluginOn] = useState<Record<PluginId, boolean>>(() => loadPluginEnabled());
  /** 工作汇报插件注入的提示词正文（来自当前空间 提示词管理/工作汇报提示词.md） */
  const [reportPrompt, setReportPrompt] = useState('');
  /** 本地记忆中间件是否可用（仅 npm run dev） */
  const [memoryHealth, setMemoryHealth] = useState<MemoryHealth | null>(null);
  /** 本地工作区文件 Runner（仅 npm run dev） */
  const [fsHealth, setFsHealth] = useState<FsHealth | null>(null);
  /** null=探测中，避免刷新时先闪「未就绪」 */
  const [fsProbed, setFsProbed] = useState(false);
  const [bashHealth, setBashHealth] = useState<BashHealth | null>(null);
  const [pwshHealth, setPwshHealth] = useState<PwshHealth | null>(null);
  const [webHealth, setWebHealth] = useState<WebHealth | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [wsBusy, setWsBusy] = useState(false);
  /** 工作区树：展开的文件夹 path、搜索、添加输入框 */
  const [wsExpanded, setWsExpanded] = useState<Record<string, boolean>>({});
  const [wsQuery, setWsQuery] = useState('');
  const [wsSearchOpen, setWsSearchOpen] = useState(false);
  /** 会话行「…」菜单当前打开的 session id */
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  /** 对话工作台内 Tab：对话 | 回合 | 待办 | 记忆（选择会记住，刷新后仍停在原 Tab） */
  const [chatTab, setChatTab] = useState<ChatTab>(() =>
    readViewPref<ChatTab>(CHAT_TAB_PREF, CHAT_TAB_VALUES, 'dialog'),
  );
  const [generalPrefs, setGeneralPrefs] = useState<GeneralPrefs>(() =>
    typeof window === 'undefined'
      ? {
          language: 'zh-CN',
          appearance: 'system',
          sessionFontSize: 14,
          toolStepDetail: 'standard',
          busySendBehavior: 'queue',
          subagentModel: '',
        }
      : loadGeneralPrefs(),
  );
  const [toolBusy, setToolBusy] = useState(false);
  const [toolHint, setToolHint] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** 点击别处后暂时隐藏 @ / 插件菜单（输入变化后恢复） */
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [pluginMenuDismissed, setPluginMenuDismissed] = useState(false);
  /** 「+」添加面板（浮在输入框上方，对齐 dsh） */
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  /** 添加面板内「扩展插件」分组展开 */
  const [addPluginsExpanded, setAddPluginsExpanded] = useState(true);
  /** 繁忙时排队（dsh QueueDock：展示 + 上一轮结束后自动续发） */
  const [sendQueue, setSendQueue] = useState<
    Array<{
      id: string;
      content: string;
      files: Attachment[];
      refs: DocRef[];
      imgs: ImageAtt[];
    }>
  >([]);
  /** 「@」工作区文件缓存 */
  const [wsAtEntries, setWsAtEntries] = useState<WorkspaceFlatEntry[]>([]);
  const memoryLive = Boolean(pluginOn.memory && memoryHealth?.ok);
  const knowledgeOn = Boolean(pluginOn.knowledge);
  /** 网页能力已升格为会话内置，不再走扩展插件开关 */
  const webLive = Boolean(webHealth?.ok);
  const fsLive = Boolean(fsHealth?.ok);
  const fsOffline = fsProbed && !fsLive;
  const bashLive = Boolean(bashHealth?.ok);
  const pwshLive = Boolean(pwshHealth?.ok && pwshHealth.available);
  const abortRef = useRef<AbortController | null>(null);
  /** 进行中的回合（按会话）；切会话不 abort，便于后台继续 */
  const liveRunsRef = useRef<Map<string, { abort: AbortController; messages: LocalMessage[] }>>(
    new Map(),
  );
  const runSessionIdRef = useRef<string | null>(null);
  /** 服务端 SSE 取消 */
  const sseUnsubRef = useRef<Map<string, () => void>>(new Map());
  /** 工具 running→done 计时（sessionId:stepId → startMs） */
  const toolTimingRef = useRef<Map<string, number>>(new Map());
  /** 服务端回合首 token / 起点（executeSend 写入，SSE 事件读取） */
  const turnTimingRef = useRef<Map<string, { start: number; firstToken?: number }>>(new Map());
  /** time-context 上次完整注入时间（节流 10 分钟） */
  const timeInjectAtRef = useRef<number | null>(null);
  const streamingRef = useRef(false);
  /** ask_user_question：等待用户作答 */
  const askUserWaitRef = useRef<{
    resolve: (s: string) => void;
    reject: (e: Error) => void;
  } | null>(null);
  const planWaitRef = useRef<{
    resolve: (s: string) => void;
    reject: (e: Error) => void;
  } | null>(null);
  const [sessionTodos, setSessionTodos] = useState<TodoItem[]>([]);
  const [sessionGoal, setSessionGoal] = useState<SessionGoal | null>(null);
  const sessionGoalRef = useRef<SessionGoal | null>(null);
  /** 当前活跃目标驱动周期内已自动续轮次数 */
  const goalDriverRoundsRef = useRef(0);
  /** 已用 LLM 起过标题的会话，避免重复请求 */
  const llmTitledSessionIdsRef = useRef(new Set<string>());
  const [planPhase, setPlanPhase] = useState<PlanPhase>('off');
  /** 输入区模式胶囊：目标设定 / 计划模式 / 插件开发 / 汇报生成（中文标签 + 可关闭） */
  const [composerChip, setComposerChip] = useState<
    null | 'goal' | 'plan' | 'pluginDev' | 'reports'
  >(null);
  /** 汇报生成胶囊的类型：生成日报 / 生成周报 / 生成月报 */
  const [reportChipKind, setReportChipKind] = useState<ReportKind>('day');
  const [planProposal, setPlanProposal] = useState<PlanProposal | null>(null);
  const [askUserPrompt, setAskUserPrompt] = useState<AskUserQuestion[] | null>(null);
  const [askUserDraft, setAskUserDraft] = useState<Record<string, AskUserDraft>>({});
  /** 提问卡片当前步（0 起）：一次只展示一道题，与 dsh 的提问 composer 一致 */
  const [askUserStep, setAskUserStep] = useState(0);
  const [askUserMinimized, setAskUserMinimized] = useState(false);
  /** 卡片内的即时提示（未作答 / 未填回答），不走全局错误条 */
  const [askUserFeedback, setAskUserFeedback] = useState<string | null>(null);
  /** 存在跳过时先停在确认视图：说明跳过原因后才回传，避免模型盲目按默认执行 */
  const [askSkipConfirm, setAskSkipConfirm] = useState(false);
  const [askSkipReason, setAskSkipReason] = useState('');
  /** AI 新增待办 / 任务前的确认卡片：打开期间对应的工具调用挂起等待 */
  const [createConfirm, setCreateConfirm] = useState<{
    kind: CreateKind;
    items: CreateDraftItem[];
    /** true = 「+」菜单里手动新增（不经过模型，确认后直接落库） */
    manual?: boolean;
    /** true = AI 识别到的待办：只改名称，其余字段自动填好 */
    quick?: boolean;
    /** 快卡底部的补充说明 */
    quickNote?: string;
  } | null>(null);
  /** 卡片正在播退场动画：DOM 还在，但已不可交互 */
  const [createClosing, setCreateClosing] = useState(false);
  const createConfirmWaitRef = useRef<((items: CreateDraftItem[] | null) => void) | null>(null);
  const createCloseTimerRef = useRef<number | null>(null);

  function clearCreateCloseTimer() {
    if (createCloseTimerRef.current !== null) {
      window.clearTimeout(createCloseTimerRef.current);
      createCloseTimerRef.current = null;
    }
  }

  /** 打开前复位：上一次的退场动画还没播完时直接接上新卡片 */
  function resetCreateCardAnim() {
    clearCreateCloseTimer();
    setCreateClosing(false);
  }

  function askCreateConfirm(
    kind: CreateKind,
    items: CreateDraftItem[],
    opts: { quick?: boolean; quickNote?: string } = {},
  ): Promise<CreateDraftItem[] | null> {
    return new Promise((resolve) => {
      // 理论上同一会话不会并发两次；真遇到时先放掉旧的，避免工具调用永远悬着
      createConfirmWaitRef.current?.(null);
      createConfirmWaitRef.current = resolve;
      resetCreateCardAnim();
      setCreateConfirm({ kind, items, quick: opts.quick, quickNote: opts.quickNote });
    });
  }

  /**
   * 关闭确认卡片：先播 160ms 退场动画再卸载。
   * items 为 null（取消 / 点卡片外面）时不写任何数据。
   */
  function settleCreateConfirm(items: CreateDraftItem[] | null) {
    const resolve = createConfirmWaitRef.current;
    createConfirmWaitRef.current = null;
    setCreateClosing(true);
    clearCreateCloseTimer();
    createCloseTimerRef.current = window.setTimeout(() => {
      createCloseTimerRef.current = null;
      setCreateConfirm(null);
      setCreateClosing(false);
    }, 160);
    resolve?.(items);
  }

  /** 供「点卡片外面自动取消」的监听使用，避免 effect 依赖函数导致反复绑定 */
  const cancelCreateCardRef = useRef<() => void>(() => {});
  cancelCreateCardRef.current = () => settleCreateConfirm(null);

  // 点卡片外的任意位置（含切到别的页面）→ 播放退场动画并取消，不写入待办 / 任务
  useEffect(() => {
    if (!createConfirm || createClosing) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      // 下拉菜单 / 日历是 portal 到 body 的，仍算「在卡片里操作」
      if (target.closest('.tw-create-card')) return;
      if (target.closest('[data-headlessui-portal]') || target.closest('.tw-select-menu')) return;
      if (target.closest('.tw-date-panel')) return;
      cancelCreateCardRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [createConfirm, createClosing]);

  /** 「+」→ 待办 / 任务：手动新增，直接弹同一张确认卡片 */
  function openManualCreate(kind: CreateKind) {
    setAddMenuOpen(false);
    // 兜底：对应插件已关闭时不弹卡片（菜单入口本身也会隐藏）
    if (!pluginOn[kind === 'todo' ? 'todos' : 'tasks']) return;
    resetCreateCardAnim();
    setCreateConfirm({
      kind,
      manual: true,
      items: [blankCreateDraft(kind)],
    });
  }

  async function submitManualCreate(kind: CreateKind, items: CreateDraftItem[]) {
    const noun = kind === 'todo' ? '待办' : '任务';
    try {
      if (kind === 'todo') {
        await createTodosApi(
          items.map((item) => ({
            title: item.title.trim(),
            status: item.status as 'pending' | 'in_progress' | 'done' | 'cancelled',
            priority: item.priority as '' | 'urgent_important' | 'important' | 'urgent' | 'normal',
            taskId: item.taskId,
            linkedTask: item.linkedTask,
            startDate: item.startDate,
            dueDate: item.dueDate,
            note: item.note,
          })),
          { mode: 'manual' },
        );
      } else {
        await createTasksApi(
          items.map((item) => ({
            title: item.title.trim(),
            status: item.status as 'pool' | 'in_progress' | 'done' | 'closed' | 'cancelled',
            priority: item.priority as '' | 'urgent_important' | 'important' | 'urgent' | 'normal',
            startDate: item.startDate,
            dueDate: item.dueDate,
            note: item.note,
          })),
          { mode: 'manual' },
        );
      }
      setError(
        `已新增 ${items.length} 条${noun}，可在侧栏「${noun === '待办' ? '待办事项' : '任务管理'}」查看。`,
        'ok',
      );
    } catch (e) {
      setErrorTone('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // 会话切走 / 组件卸载时放掉挂起的确认，别让工具调用一直悬着
  useEffect(
    () => () => {
      createConfirmWaitRef.current?.(null);
      createConfirmWaitRef.current = null;
      if (createCloseTimerRef.current !== null) {
        window.clearTimeout(createCloseTimerRef.current);
        createCloseTimerRef.current = null;
      }
    },
    [],
  );
  type PendingSend = {
    id: string;
    content: string;
    files: Attachment[];
    refs: DocRef[];
    imgs: ImageAtt[];
  };
  const sendQueueRef = useRef<PendingSend[]>([]);
  const interruptPayloadRef = useRef<PendingSend | null>(null);

  function syncSendQueue(next: PendingSend[]) {
    sendQueueRef.current = next;
    setSendQueue(next);
  }

  function queueTitle(p: PendingSend): string {
    const t = p.content.trim().replace(/\s+/g, ' ');
    if (t) return t.length > 28 ? `${t.slice(0, 28)}…` : t;
    const n = p.files.length + p.imgs.length + p.refs.length;
    return n > 0 ? `附件 ${n} 项` : '（空消息）';
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const pluginMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  /** 各会话输入草稿（切换会话时保留） */
  const composerDraftsRef = useRef<
    Record<
      string,
      { input: string; attachments: Attachment[]; images: ImageAtt[]; docRefs: DocRef[] }
    >
  >({});
  const base = import.meta.env.BASE_URL || '/';

  const hasWorkspace = Boolean(fsLive && workspaceInfo?.workspace);
  const atState = getAtMentionState(input);
  const atProjectDocs = (() => {
    if (!atState || !knowledgeOn) return [] as SlashDoc[];
    const q = atState.query.toLowerCase();
    const list = !q ? slashDocs : slashDocs.filter((d) => matchSlashQuery(d, q));
    return list.slice(0, 10);
  })();
  const atWorkspaceDocs = (() => {
    if (!atState || !hasWorkspace) return [] as SlashDoc[];
    const q = atState.query.toLowerCase();
    const mapped: SlashDoc[] = wsAtEntries.map((e) => ({
      collection: 'workspace' as const,
      id: `ws:${e.path}`,
      title: e.name,
      category: shortWorkspaceLabel(workspaceInfo?.workspace, workspaceInfo?.projectRoot),
      description: e.path,
      format: e.type === 'dir' ? 'dir' : 'file',
      path: e.path,
    }));
    const list = !q
      ? mapped
      : mapped.filter(
          (d) =>
            matchSlashQuery(d, q) ||
            d.path.toLowerCase().includes(q) ||
            d.title.toLowerCase().includes(q),
        );
    return list.slice(0, 10);
  })();
  /** 扁平列表供键盘上下键；带 section 标记供渲染分割线 */
  const atFlatItems = [
    ...atProjectDocs.map((d) => ({ section: 'project' as const, doc: d })),
    ...atWorkspaceDocs.map((d) => ({ section: 'workspace' as const, doc: d })),
  ];
  const atOpen = Boolean(atState && !mentionDismissed);

  const pluginSlashState = getPluginSlashState(input);
  const pluginMenuItems = PLUGIN_CATALOG.filter((p) => p.hasPanel && pluginOn[p.id]);
  const pluginMenuOpen = Boolean(
    pluginSlashState && !pluginMenuDismissed && !atOpen && pluginMenuItems.length > 0,
  );
  /** 滚动跟随意图（dsh ScrollFollow 核心）：仅贴底时跟随新内容，用户上滚即脱离 */
  const followRef = useRef(true);
  /** 「回到底部」平滑滚动进行中：动画途中的滚动事件不改变跟随意图 */
  const jumpingRef = useRef(false);
  /** 会话库最新快照：写回消息时避免闭包过期 */
  const storeRef = useRef<SessionStore | null>(null);
  const workspaceInfoRef = useRef<WorkspaceInfo | null>(null);
  const messagesRef = useRef<LocalMessage[]>([]);
  messagesRef.current = messages;
  workspaceInfoRef.current = workspaceInfo;

  function commitStore(next: SessionStore) {
    storeRef.current = next;
    setStore(next);
    saveSessionStore(next);
  }

  const activeSession = store?.sessions.find((s) => s.id === store.activeId);
  const activeSessionId = activeSession?.id;
  const activeSessionAccess = activeSession?.access;
  /**
   * 当前会话的访问权限 = 会话自身记录，未记录（旧存档）则回落到设置页的默认值。
   * 依赖只取「会话 id + 该会话的权限」：设置页改默认值不应改写已有会话。
   */
  useEffect(() => {
    if (!activeSessionId) return;
    setAccess(activeSessionAccess ?? loadAccessLevel());
  }, [activeSessionId, activeSessionAccess]);

  useEffect(() => {
    let cancelled = false;
    const offSettings = onSettingsChanged(() => setSettings(loadSettings()));
    const offPlugins = onPluginEnabledChanged((map) => setPluginOn(map));
    const offGeneral = onGeneralPrefsChanged((p) => {
      setGeneralPrefs(p);
      applyGeneralPrefs(p);
    });

    void (async () => {
      await hydrateAppConfig();
      if (cancelled) return;
      const g = loadGeneralPrefs();
      setGeneralPrefs(g);
      applyGeneralPrefs(g);
      setSettings(loadSettings());
      setAccess(loadAccessLevel());
      setPluginOn(loadPluginEnabled());
      setRailOpen(loadRailOpen());

      const params = new URLSearchParams(window.location.search);
      const sid = params.get('session');
      const loaded = await hydrateSessionStore({ preferSessionId: sid });
      if (cancelled) return;
      let store = loaded;
      // 「在会话中打开」跳转：若写盘竞态丢掉新会话，从 sessionStorage 手递恢复
      if (sid && !store.sessions.some((s) => s.id === sid)) {
        try {
          const raw = sessionStorage.getItem(sessionHandoffKey(sid));
          if (raw) {
            const parsed = JSON.parse(raw) as { session?: ChatSession };
            const orphan = parsed?.session;
            if (orphan && orphan.id === sid) {
              store = {
                ...store,
                sessions: [orphan, ...store.sessions.filter((s) => s.id !== sid)],
                activeId: sid,
              };
              await flushSessionStore(store);
            }
          }
        } catch {
          // ignore
        }
      }
      if (sid) {
        try {
          sessionStorage.removeItem(sessionHandoffKey(sid));
        } catch {
          // ignore
        }
      }
      const focusRoot = params.get('focusRoot');
      const focusPathRaw = params.get('focusPath');
      const attachRootRaw = params.get('attachRoot');
      const attachPathRaw = params.get('attachPath');
      const attachNameRaw = params.get('attachName');
      let focusKey: string | null = null;
      if (focusRoot && focusPathRaw) {
        try {
          const path = decodeURIComponent(focusPathRaw).replace(/\\/g, '/').replace(/^\/+/, '');
          focusKey = `${focusRoot}:${path}`;
        } catch {
          focusKey = `${focusRoot}:${focusPathRaw}`;
        }
      }
      if (sid && store.sessions.some((s) => s.id === sid)) {
        store = switchSession(store, sid);
        saveSessionStore(store);
      }
      if (focusKey) setPendingFocusDoc(focusKey);
      // 管理页打开：作曲区挂 Cursor 式路径 chip
      if (attachRootRaw && attachPathRaw) {
        const root = attachRootRaw as DocRef['collection'];
        if (
          root === 'cases' ||
          root === 'prompts' ||
          root === 'knowledge' ||
          root === 'templates'
        ) {
          let path = attachPathRaw;
          let name = attachNameRaw || '';
          try {
            path = decodeURIComponent(attachPathRaw).replace(/\\/g, '/').replace(/^\/+/, '');
            if (attachNameRaw) name = decodeURIComponent(attachNameRaw);
          } catch {
            // keep raw
          }
          if (!name) name = path.split('/').pop() || path;
          const ext = (name.split('.').pop() || 'md').toLowerCase();
          const category =
            root === 'cases'
              ? '用例'
              : root === 'prompts'
                ? '提示词'
                : root === 'knowledge'
                  ? '知识库'
                  : '模板';
          setDocRefs([
            {
              collection: root,
              id: `${root}:${path}`,
              title: name,
              category,
              path,
              format: ext,
            },
          ]);
        }
      }
      // 工作汇报页「去工作台写汇报」：先读参数，等会话恢复完再挂胶囊（避免被插件开发会话覆盖）
      const reportParam = params.get('report');
      // 清掉 query，避免刷新反复切会话 / 重复滚动
      try {
        const u = new URL(window.location.href);
        u.searchParams.delete('report');
        u.searchParams.delete('session');
        u.searchParams.delete('focusRoot');
        u.searchParams.delete('focusPath');
        u.searchParams.delete('attachRoot');
        u.searchParams.delete('attachPath');
        u.searchParams.delete('attachName');
        window.history.replaceState({}, '', u.pathname + u.search + u.hash);
      } catch {
        // ignore
      }
      // 服务端仍在跑的会话不要结算步骤；其余残留 running 标 done
      let serverBusyIds: string[] = [];
      try {
        serverBusyIds = (await listSessionRuns()).map((r) => r.sessionId);
      } catch {
        serverBusyIds = [];
      }
      const busySet = new Set(serverBusyIds);
      if (busySet.size) {
        store = {
          ...store,
          sessions: store.sessions.map((s) => {
            if (busySet.has(s.id)) return s;
            const msgs = settleRunningActivitySteps(s.messages);
            return msgs === s.messages ? s : { ...s, messages: msgs };
          }),
        };
      } else {
        store = settleStoreRunningSteps(store);
      }
      // 权限按会话固化：旧存档没有 access 字段，用当前设置页默认值补齐并落盘。
      // 补齐后这些会话就与「默认权限」解耦，之后改设置不再回头改写它们。
      const fallbackAccess = loadAccessLevel();
      if (store.sessions.some((s) => !s.access)) {
        store = {
          ...store,
          sessions: store.sessions.map((s) => (s.access ? s : { ...s, access: fallbackAccess })),
        };
      }
      storeRef.current = store;
      setStore(store);
      saveSessionStore(store);
      const active = store.sessions.find((s) => s.id === store.activeId);
      setMessages((active?.messages as LocalMessage[]) ?? []);
      setCaseGenConfig(active?.caseGen?.active ? active.caseGen : null);
      setPromptGenConfig(active?.promptGen?.active ? active.promptGen : null);
      setKnowledgeGenConfig(active?.knowledgeGen?.active ? active.knowledgeGen : null);
      setPluginDevConfig(active?.pluginDev?.active ? active.pluginDev : null);
      // 权限以会话自身记录为准（上面已回填旧存档默认值）；这里显式同步，
      // 否则挂载时先写入的默认权限会盖掉会话里存的「工作区内修改」
      setAccess(active?.access ?? fallbackAccess);
      if (active?.pluginDev?.active) {
        setComposerChip('pluginDev');
        // 插件开发会话必须是可写：旧存档若是「仅可查看」，恢复时同步提权
        if (active.access !== 'readwrite' && active.access !== 'full') {
          setAccess('readwrite');
          const bumped: SessionStore = {
            ...store,
            sessions: store.sessions.map((s) =>
              s.id === store.activeId ? { ...s, access: 'readwrite' as const } : s,
            ),
          };
          storeRef.current = bumped;
          setStore(bumped);
          saveSessionStore(bumped);
        }
      }
      setSessionTodos(normalizeTodos(active?.todos));
      {
        const g = normalizeGoal(active?.goal);
        sessionGoalRef.current = g;
        setSessionGoal(g);
      }
      // 工作汇报页「去工作台写汇报」：按当前 Tab 挂上「生成日报/周报/月报」胶囊
      if (
        (reportParam === 'day' || reportParam === 'week' || reportParam === 'month') &&
        loadPluginEnabled().reports
      ) {
        activateReportChip(reportParam);
      }
      if (active?.workspacePath) {
        setWsExpanded((prev) => ({ ...prev, [active.workspacePath!]: true }));
      }
      // Tab 首帧已从浏览器记忆恢复；空会话没有 Tab 栏，回落「对话」避免停在切不回去的页面
      if (!((active?.messages as LocalMessage[]) ?? []).length) setChatTab('dialog');
      setBusySessionIds(serverBusyIds);
      setReady(true);
      // 重连放在 ready 之后下一帧，避免闭包未就绪
      if (serverBusyIds.length) {
        queueMicrotask(() => {
          for (const id of serverBusyIds) {
            setSessionBusy(id, true);
            if (id === storeRef.current?.activeId) {
              streamingRef.current = true;
              setStreaming(true);
              attachServerRun(id, 0);
            }
          }
        });
      }

      try {
        const u = new URL(window.location.href);
        const pluginQ = u.searchParams.get('plugin');
        if (
          pluginQ === 'promptGen' ||
          pluginQ === 'knowledgeGen' ||
          pluginQ === 'caseGen' ||
          pluginQ === 'pluginDev'
        ) {
          const id = pluginQ as PluginId;
          if (loadPluginEnabled()[id]) {
            if (id === 'pluginDev') {
              // 胶囊型入口：不建会话、不预填抽屉，直接激活输入区胶囊
              activatePluginDevChip();
            } else {
              // 库页「生成*」跳入：先落一个空「新对话」，确认配置复用该会话
              const cur = storeRef.current?.sessions.find(
                (x) => x.id === storeRef.current?.activeId,
              );
              const needFresh =
                !cur ||
                cur.archived ||
                cur.deleted ||
                (Array.isArray(cur.messages) && cur.messages.length > 0) ||
                Boolean(cur.caseGen?.active || cur.promptGen?.active || cur.knowledgeGen?.active);
              if (needFresh && storeRef.current) {
                const leavingId = storeRef.current.activeId;
                const base = pruneEphemeralSession(leavingId) ?? storeRef.current;
                const ws = workspaceInfo?.workspace?.trim() || undefined;
                const next = createSession(base, { workspacePath: ws, access: loadAccessLevel() });
                storeRef.current = next;
                setStore(next);
                saveSessionStore(next);
                setMessages([]);
                setCaseGenConfig(null);
                setPromptGenConfig(null);
                setKnowledgeGenConfig(null);
                setSessionTodos([]);
                sessionGoalRef.current = null;
                setSessionGoal(null);
                setPlanPhase('off');
              }
              if (id === 'promptGen') setPromptGenPanelOpen(true);
              else if (id === 'knowledgeGen') setKnowledgeGenPanelOpen(true);
              else {
                // 需求分析「用选中故事生成用例」：?plugin=caseGen&reqDoc=<id>&stories=US-001,US-002
                const reqDoc = u.searchParams.get('reqDoc');
                if (reqDoc) {
                  setCaseGenPreset({
                    docId: reqDoc,
                    storyIds: (u.searchParams.get('stories') ?? '')
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  });
                  u.searchParams.delete('reqDoc');
                  u.searchParams.delete('stories');
                }
                setCaseGenPanelOpen(true);
              }
            }
          } else {
            setError(pluginDisabledMessage(id));
          }
          u.searchParams.delete('plugin');
          window.history.replaceState({}, '', u.pathname + u.search + u.hash);
        }
      } catch {
        // ignore
      }

      // 系统提示词以「提示词管理/默认提示词.md」为准：读不到就 toast 说明，别静默用兜底
      void (async () => {
        try {
          if (!(await fetchDocsHealth('prompts'))) {
            showToast('提示词管理服务未就绪，系统提示词暂时用内置兜底。', 'error');
            return;
          }
          const r = await readDocsText('prompts', CHAT_SYSTEM_PROMPT_FILE);
          const text = r.content.trim();
          if (text) setSystemPrompt(text);
          else
            showToast(
              `「提示词管理/${CHAT_SYSTEM_PROMPT_FILE}」是空的，系统提示词暂时用内置兜底。`,
              'error',
            );
        } catch {
          // 回退 FALLBACK_SYSTEM_PROMPT
          showToast(
            `没有读到「提示词管理/${CHAT_SYSTEM_PROMPT_FILE}」，系统提示词暂时用内置兜底。`,
            'error',
          );
        }
      })();
      void fetchMemoryHealth().then((m) => setMemoryHealth(m));
      void fetchFsHealth().then((h) => {
        setFsHealth(h);
        setFsProbed(true);
      });
      void fetchBashHealth().then((h) => setBashHealth(h));
      void fetchPwshHealth().then((h) => setPwshHealth(h));
      void fetchWebHealth().then((h) => setWebHealth(h));
      void fetchWorkspace().then((w) => {
        setWorkspaceInfo(w);
        if (w?.workspace) {
          setWsExpanded((prev) => ({ ...prev, [w.workspace]: true }));
        }
      });
    })();

    return () => {
      cancelled = true;
      offSettings();
      offPlugins();
      offGeneral();
    };
    // 只在挂载时初始化一次：内部引用的 activatePluginDevChip / attachServerRun /
    // workspaceInfo 都是首帧之后的回调入口，纳入依赖会重新拉取一遍并覆盖用户已切换的状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 记忆插件关闭后隐藏入口，并退出记忆页 */
  useEffect(() => {
    if (!pluginOn.memory && chatTab === 'memory') setChatTab('dialog');
  }, [pluginOn.memory, chatTab]);

  /** 待办插件关闭后同样退出待办页 */
  useEffect(() => {
    if (!pluginOn.todos && chatTab === 'todos') setChatTab('dialog');
  }, [pluginOn.todos, chatTab]);

  /** Tab 选择记到浏览器本地：刷新 / 重新进入页面后回到上次停留的 Tab */
  useEffect(() => {
    writeViewPref(CHAT_TAB_PREF, chatTab);
  }, [chatTab]);

  /** 工作汇报插件：先幂等补齐提示词文件，再把正文用于系统提示词注入 */
  useEffect(() => {
    if (!pluginOn.reports) {
      setReportPrompt('');
      return;
    }
    let alive = true;
    void (async () => {
      try {
        await syncReportPrompt(true);
        const text = await fetchReportPrompt();
        if (alive) setReportPrompt(text);
        if (!text) {
          showToast(
            '工作汇报提示词没读到（提示词管理里为空或缺失），汇报不会注入提示词。',
            'error',
          );
        }
      } catch (e) {
        // 本地服务未就绪：不注入；提示词管理里仍可查看/修改
        const detail = e instanceof Error ? e.message : String(e);
        showToast(`读取工作汇报提示词失败：${detail}`, 'error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [pluginOn.reports]);

  /** tool-schedule：轮询到期提醒；主机在线时 claim 会写入 sessions.json */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const deliver = async () => {
      if (!storeRef.current) return;
      const due = await claimDueSchedulesAsync();
      if (cancelled || !storeRef.current) return;
      let next = storeRef.current;
      let activeTouched = false;
      for (const r of due) {
        const sess = next.sessions.find((s) => s.id === r.sessionId);
        const msgs = (sess?.messages as LocalMessage[] | undefined) ?? [];
        const marker = `<!--tb-schedule:${r.id}-->`;
        const exists = msgs.some(
          (m) =>
            m.scheduleId === r.id || (typeof m.content === 'string' && m.content.includes(marker)),
        );
        if (!exists) {
          const msg: LocalMessage = {
            role: 'assistant',
            content: reminderMessageContent(r.text, r.id),
            time: Date.now(),
            scheduleId: r.id,
          };
          next = appendSessionMessage(next, r.sessionId, msg);
          if (r.sessionId === next.activeId) activeTouched = true;
        }
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification('Lantern Harness 定时提醒', { body: r.text });
          }
        } catch {
          // ignore
        }
      }
      const remote = await fetchSessionStoreFromFile();
      if (cancelled || !storeRef.current) return;
      if (remote) {
        const merged = mergeScheduleMessagesFromRemote(next, remote);
        if (merged !== next) {
          next = merged;
          if (next.activeId) activeTouched = true;
        }
      }
      if (next !== storeRef.current || due.length) {
        commitStore(next);
      }
      if (activeTouched) {
        const active = next.sessions.find((s) => s.id === next.activeId);
        setMessages((active?.messages as LocalMessage[]) ?? []);
      }
    };
    void deliver();
    const timer = window.setInterval(() => {
      void deliver();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ready]);

  /** 当前会话切换时，输入栏 / FS 跟会话归属工作区对齐 */
  useEffect(() => {
    if (!ready || !fsLive || !workspaceInfo) return;
    const s = store?.sessions.find((x) => x.id === store.activeId);
    void syncFsWorkspaceForSession(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随会话与工作区列表变化同步
  }, [ready, fsLive, store?.activeId, workspaceInfo?.items]);

  /** Shift：取消非输入框聚焦（去掉会话行蓝框等） */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || el === document.body) return;
      if (
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'INPUT' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      ) {
        return;
      }
      el.blur();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    setMentionIndex(0);
    setMentionDismissed(false);
  }, [atState?.query, atState?.from]);

  useEffect(() => {
    setPluginMenuDismissed(false);
    setPluginIndex(0);
  }, [pluginSlashState?.from]);

  useEffect(() => {
    setPluginIndex((i) => (pluginMenuItems.length ? Math.min(i, pluginMenuItems.length - 1) : 0));
  }, [pluginMenuItems.length]);

  /** 「@」打开时拉取工作区浅层列表 */
  useEffect(() => {
    if (!atOpen || !hasWorkspace) {
      if (!hasWorkspace) setWsAtEntries([]);
      return;
    }
    let cancelled = false;
    void listWorkspaceFlat(access, { maxDepth: 3, maxEntries: 80 }).then((list) => {
      if (!cancelled) setWsAtEntries(list);
    });
    return () => {
      cancelled = true;
    };
  }, [atOpen, hasWorkspace, access, workspaceInfo?.workspace]);

  /** 键盘选中项滚入 @ 弹窗可视区 */
  useEffect(() => {
    if (!atOpen) return;
    const root = mentionListRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-mention-index="${mentionIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [mentionIndex, atOpen, atFlatItems.length]);

  useEffect(() => {
    if (!pluginMenuOpen) return;
    const root = pluginMenuRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-plugin-index="${pluginIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [pluginIndex, pluginMenuOpen, pluginMenuItems.length]);

  /** 点击检索列表与输入框以外：关闭 @ / 插件 / 添加浮层 */
  useEffect(() => {
    if (!atOpen && !pluginMenuOpen && !addMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (mentionListRef.current?.contains(t)) return;
      if (pluginMenuRef.current?.contains(t)) return;
      if (addMenuRef.current?.contains(t)) return;
      if (textareaRef.current?.contains(t)) return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-add-menu-btn]')) return;
      setMentionDismissed(true);
      setPluginMenuDismissed(true);
      setAddMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [atOpen, pluginMenuOpen, addMenuOpen]);

  /** 会话统计等绿色提示条：点击外部收起 */
  useEffect(() => {
    if (!error || errorTone !== 'ok') return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (noticeRef.current?.contains(t)) return;
      setError(null);
    }
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [error, errorTone]);

  /** 点击会话/工作区菜单以外：关闭「…」菜单 */
  useEffect(() => {
    if (!sessionMenuId && !wsMenuId) return;
    function onPointerDown(e: PointerEvent) {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[data-session-menu]')) return;
      if (el?.closest?.('[data-ws-menu]')) return;
      setSessionMenuId(null);
      setWsMenuId(null);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [sessionMenuId, wsMenuId]);

  function refreshPluginRuntime() {
    void fetchMemoryHealth().then((m) => setMemoryHealth(m));
    void fetchFsHealth().then((h) => {
      setFsHealth(h);
      setFsProbed(true);
    });
    void fetchBashHealth().then((h) => setBashHealth(h));
    void fetchPwshHealth().then((h) => setPwshHealth(h));
    void fetchWebHealth().then((h) => setWebHealth(h));
    void fetchWorkspace().then((w) => setWorkspaceInfo(w));
  }

  function syncWorkspaceInfo(info: WorkspaceInfo) {
    setWorkspaceInfo(info);
    setWsExpanded((prev) => ({ ...prev, [info.workspace]: true }));
  }

  async function applyWorkspace(path: string, mode: 'select' | 'add' = 'select') {
    if (!fsLive || wsBusy) return;
    setWsBusy(true);
    setError(null);
    try {
      const info = mode === 'add' ? await addWorkspace(path) : await selectWorkspace(path);
      syncWorkspaceInfo(info);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWsBusy(false);
    }
  }

  /**
   * 会话在侧栏的「有效工作区」：有合法归属用归属路径，否则用项目根
   * （与 sessionsForWorkspace 挂靠规则一致）。
   */
  function effectiveWorkspacePathForSession(session: ChatSession | undefined): string | null {
    const info = workspaceInfoRef.current;
    if (!info) return null;
    const bound = session?.workspacePath?.trim();
    // 插件开发会话归属 harness 包根：它不在工作区列表里（只临时占用），也要认
    if (bound && (bound === info.harnessRoot || info.items.some((i) => i.path === bound))) {
      return bound;
    }
    return info.projectRoot?.trim() || null;
  }

  /**
   * 切换会话时：把 FS / 输入栏 picker 对齐到该会话的有效工作区。
   * 手动改过 picker 后不要在发送时再调这个（发送以 picker 当前值为准）。
   */
  async function syncFsWorkspaceForSession(session: ChatSession | undefined) {
    if (!fsLive || wsBusy) return;
    const target = effectiveWorkspacePathForSession(session);
    if (!target) return;
    const info = workspaceInfoRef.current;
    if (!info || target === info.workspace) return;
    setWsBusy(true);
    try {
      const next = await selectWorkspace(target);
      syncWorkspaceInfo(next);
    } catch {
      // 静默，不打断对话
    } finally {
      setWsBusy(false);
    }
  }

  /** dsh 输入栏 picker：切换当前工作区；无归属的空会话顺带归入该工作区 */
  async function pickComposerWorkspace(item: WorkspaceItem) {
    if (!fsLive || wsBusy) return;
    await applyWorkspace(item.path, 'select');
    const cur = storeRef.current;
    if (!cur) return;
    const s = cur.sessions.find((x) => x.id === cur.activeId);
    if (!s || s.workspacePath) return;
    const msgs = (s.messages as LocalMessage[] | undefined) ?? [];
    if (msgs.length > 0) return;
    commitStore(bindSessionWorkspace(cur, s.id, item.path));
    setWsExpanded((prev) => ({ ...prev, [item.path]: true }));
  }

  /** dsh：原生选文件夹 → create workspace */
  async function addWorkspaceByPicker() {
    if (!fsLive || wsBusy) return;
    setWsBusy(true);
    setError(null);
    try {
      const path = await pickDirectory();
      if (!path) return;
      const info = await addWorkspace(path);
      syncWorkspaceInfo(info);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWsBusy(false);
    }
  }

  async function confirmDropWorkspace() {
    const item = wsDeleteTarget;
    if (!item || !fsLive || wsBusy) return;
    if (item.id === 'ws_project') {
      setWsDeleteTarget(null);
      return;
    }
    setWsDeleteTarget(null);
    setWsMenuId(null);
    setWsBusy(true);
    setError(null);
    try {
      if (storeRef.current) {
        commitStore(unbindSessionsFromWorkspace(storeRef.current, item.path));
      }
      const info = await removeWorkspace(item.id);
      syncWorkspaceInfo(info);
      if (info.projectRoot) {
        setWsExpanded((prev) => ({ ...prev, [info.projectRoot]: true }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWsBusy(false);
    }
  }

  function requestDropWorkspace(item: WorkspaceItem) {
    if (!fsLive || wsBusy || item.id === 'ws_project') return;
    setSessionMenuId(null);
    setWsMenuId(null);
    setWsDeleteTarget(item);
  }

  async function confirmRenameWorkspace(name: string) {
    const id = wsRenameId;
    setWsRenameId(null);
    if (!id || !fsLive) return;
    setWsBusy(true);
    setError(null);
    try {
      const info = await renameWorkspace(id, name);
      syncWorkspaceInfo(info);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWsBusy(false);
    }
  }

  /** 离开空会话时丢弃（无消息且输入区无草稿）；不进已删除 */
  function pruneEphemeralSession(id: string | undefined | null): SessionStore | null {
    if (!id || !storeRef.current) return storeRef.current;
    const s = storeRef.current.sessions.find((x) => x.id === id);
    if (!s || !isEphemeralEmptySession(s)) return storeRef.current;
    const draft = composerDraftsRef.current[id];
    if (
      draft &&
      (Boolean(draft.input?.trim()) ||
        (draft.attachments?.length ?? 0) > 0 ||
        (draft.images?.length ?? 0) > 0 ||
        (draft.docRefs?.length ?? 0) > 0)
    ) {
      return storeRef.current;
    }
    delete composerDraftsRef.current[id];
    const next = deleteSession(storeRef.current, id);
    return next;
  }

  function pickAtDoc(doc: SlashDoc) {
    if (!atState) return;
    if (doc.collection !== 'workspace' && !knowledgeOn) {
      setError(pluginDisabledMessage('knowledge'));
      return;
    }
    if (docRefs.length >= REF_MAX_COUNT) {
      setError(`最多引用 ${REF_MAX_COUNT} 篇文档`);
      return;
    }
    setError(null);
    setDocRefs((prev) => {
      if (prev.some((r) => r.collection === doc.collection && r.path === doc.path)) return prev;
      return [
        ...prev,
        {
          collection: doc.collection,
          id: doc.id,
          title: doc.title,
          category: doc.category,
          path: doc.path,
          format: doc.format,
        },
      ].slice(0, REF_MAX_COUNT);
    });
    setInput(input.slice(0, atState.from).replace(/\s+$/, ''));
    setMentionDismissed(true);
    textareaRef.current?.focus();
  }

  function clearPluginSlashTrigger() {
    if (!pluginSlashState) return;
    setInput(input.slice(0, pluginSlashState.from).replace(/\s+$/, ''));
    setPluginMenuDismissed(true);
  }

  function openPluginPanel(id: PluginId): boolean {
    if (!pluginOn[id]) {
      setError(pluginDisabledMessage(id));
      return false;
    }
    setError(null);
    if (id === 'caseGen') {
      setCaseGenPanelOpen(true);
      return true;
    }
    if (id === 'promptGen') {
      setPromptGenPanelOpen(true);
      return true;
    }
    if (id === 'knowledgeGen') {
      setKnowledgeGenPanelOpen(true);
      return true;
    }
    if (id === 'pluginDev') {
      activatePluginDevChip();
      return true;
    }
    if (id === 'memory') {
      setChatTab('memory');
      return true;
    }
    if (id === 'knowledge') {
      const base = input.replace(/\s+$/, '');
      setInput(base ? `${base} @` : '@');
      setMentionDismissed(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return true;
    }
    return false;
  }

  function pickPluginMenu(id: PluginId) {
    clearPluginSlashTrigger();
    openPluginPanel(id);
  }

  /** 滚动采样：距底 48px 内视为贴底（dsh nearBottom 阈值策略） */
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.clientHeight - el.scrollTop <= 48;
    if (jumpingRef.current) {
      if (!near) return;
      jumpingRef.current = false;
    }
    followRef.current = near;
    setShowJump(!near);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    jumpingRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  useEffect(() => {
    if (!ready || !storeRef.current) return;
    const active = storeRef.current.sessions.find((s) => s.id === storeRef.current!.activeId);
    const prev = (active?.messages as unknown[]) ?? [];
    // 切会话只是把已存消息灌进 state：内容未变则不碰 updatedAt，避免侧栏重排
    const changed = JSON.stringify(prev) !== JSON.stringify(messages);
    const next = updateActiveMessages(storeRef.current, messages, {
      touchUpdatedAt: changed,
    });
    storeRef.current = next;
    setStore(next);
    saveSessionStore(next);
    // 跟随态才自动滚底；用户上滚阅读历史时不打扰
    if (followRef.current && !jumpingRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages, ready]);

  // 离开页面前落盘即可；服务端回合继续跑，勿把 running 步骤结算成 done
  useEffect(() => {
    const flush = () => {
      if (!storeRef.current) return;
      saveSessionStore(storeRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  // 输入框随内容自动长高（上限 280px，超出内部滚动）
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [input]);

  // 管理页「在会话中打开」：滚到对应入库文件卡并短暂高亮
  useEffect(() => {
    if (!ready || !pendingFocusDoc || !messages.length) return;
    const key = pendingFocusDoc;
    const t = window.setTimeout(() => {
      const root = scrollRef.current ?? document;
      const el = root.querySelector(`[data-focus-doc="${CSS.escape(key)}"]`);
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-[#4176e6]', 'ring-offset-2');
        window.setTimeout(() => {
          el.classList.remove('ring-2', 'ring-[#4176e6]', 'ring-offset-2');
        }, 2400);
      }
      setPendingFocusDoc(null);
    }, 80);
    return () => window.clearTimeout(t);
  }, [ready, pendingFocusDoc, messages]);

  function setSessionBusy(sessionId: string, busy: boolean) {
    setBusySessionIds((prev) => {
      const has = prev.includes(sessionId);
      if (busy && !has) return [...prev, sessionId];
      if (!busy && has) return prev.filter((id) => id !== sessionId);
      return prev;
    });
    if (storeRef.current?.activeId === sessionId) {
      streamingRef.current = busy;
      setStreaming(busy);
    }
  }

  function abortSessionRun(sessionId: string | null | undefined) {
    if (!sessionId) return;
    liveRunsRef.current.get(sessionId)?.abort.abort();
    sseUnsubRef.current.get(sessionId)?.();
    sseUnsubRef.current.delete(sessionId);
    void stopSessionRun(sessionId);
  }

  function applyServerRunEvent(sessionId: string, ev: ServerRunEvent) {
    if (ev.type === 'reasoning' && ev.delta) {
      applySessionMessages(sessionId, (prev) => {
        const last = prev[prev.length - 1];
        if (last?.role !== 'assistant') return prev;
        const reasoning = sanitizeAssistantContent((last.reasoning ?? '') + ev.delta);
        const steps = [...(last.activitySteps ?? [])];
        const thinkIdx = steps.findIndex((s) => s.kind === 'thinking');
        const detail = latestParagraphFirstLine(reasoning).replaceAll('**', '').slice(0, 80);
        const thinkStep: ActivityStep = {
          id: 'thinking',
          kind: 'thinking',
          title: '思考',
          detail: detail || undefined,
          status: 'running',
        };
        if (thinkIdx >= 0) steps[thinkIdx] = { ...steps[thinkIdx], ...thinkStep };
        else steps.unshift(thinkStep);
        const copy = prev.slice();
        const timing = turnTimingRef.current.get(sessionId);
        let ttftMs = last.ttftMs;
        if (timing && timing.firstToken == null) {
          timing.firstToken = Date.now();
          ttftMs = Math.max(0, timing.firstToken - timing.start);
        }
        copy[copy.length - 1] = {
          ...last,
          reasoning,
          activitySteps: steps,
          turnStatus: 'running',
          ttftMs,
        };
        return copy;
      });
      return;
    }
    if (ev.type === 'content' && ev.delta) {
      applySessionMessages(sessionId, (prev) => {
        const last = prev[prev.length - 1];
        if (last?.role !== 'assistant') return prev;
        const steps = (last.activitySteps ?? []).map((s) =>
          s.kind === 'thinking' && s.status === 'running' ? { ...s, status: 'done' as const } : s,
        );
        const copy = prev.slice();
        const timing = turnTimingRef.current.get(sessionId);
        let ttftMs = last.ttftMs;
        if (timing && timing.firstToken == null) {
          timing.firstToken = Date.now();
          ttftMs = Math.max(0, timing.firstToken - timing.start);
        }
        copy[copy.length - 1] = {
          ...last,
          // 二次闸门：吃掉空格变体 `< | | DSML | |` 等泄漏
          content: sanitizeAssistantContent((last.content ?? '') + ev.delta!),
          activitySteps: steps,
          turnStatus: 'running',
          ttftMs,
        };
        return copy;
      });
      return;
    }
    if (ev.type === 'tool' && ev.name) {
      const kind = toolKindLabel(ev.name);
      const detail = toolArgsDetail(ev.name, ev.args);
      const stepId = `tool_${ev.name}_${ev.args?.slice(0, 24) ?? ''}`;
      noteToolTiming(sessionId, stepId, ev.status);
      const toolFailed =
        ev.status === 'done' &&
        typeof ev.result === 'string' &&
        /^\s*\{\s*"error"\s*:/.test(ev.result);
      applySessionMessages(sessionId, (prev) => {
        const last = prev[prev.length - 1];
        if (last?.role !== 'assistant') return prev;
        const steps = [...(last.activitySteps ?? [])];
        const idx = steps.findIndex(
          (s) =>
            s.id === stepId || (s.detail === detail && s.title === kind && s.status === 'running'),
        );
        const next: ActivityStep = {
          id: stepId,
          kind: activityKindForTool(ev.name!),
          title: kind,
          detail: detail || undefined,
          status: ev.status === 'running' ? 'running' : toolFailed ? 'error' : 'done',
        };
        if (idx >= 0) steps[idx] = { ...steps[idx], ...next };
        else steps.push(next);
        const copy = prev.slice();
        copy[copy.length - 1] = { ...last, activitySteps: steps, turnStatus: 'running' };
        return copy;
      });
      if (storeRef.current?.activeId === sessionId) {
        setToolHint(
          toolStepHint(
            loadGeneralPrefs().toolStepDetail,
            kind,
            ev.name,
            ev.status === 'running' ? 'running' : 'done',
          ),
        );
      }
      return;
    }
    if (ev.type === 'usage' && ev.usage) {
      applySessionMessages(sessionId, (prev) => {
        const last = prev[prev.length - 1];
        if (last?.role !== 'assistant') return prev;
        const copy = prev.slice();
        copy[copy.length - 1] = { ...last, usage: ev.usage as UsageInfo };
        return copy;
      });
      return;
    }
    if (ev.type === 'status') {
      const st = ev.status;
      if (st === 'completed' || st === 'stopped' || st === 'error') {
        applySessionMessages(sessionId, (prev) => {
          const last = prev[prev.length - 1];
          if (last?.role !== 'assistant') return prev;
          const fromServer = ev.assistant;
          const copy = prev.slice();
          const serverToolMs =
            typeof fromServer?.toolMs === 'number' ? fromServer.toolMs : undefined;
          const serverLlmMs = typeof fromServer?.llmMs === 'number' ? fromServer.llmMs : undefined;
          const serverTtftMs =
            typeof fromServer?.ttftMs === 'number' ? fromServer.ttftMs : undefined;
          const serverTps = typeof fromServer?.tps === 'number' ? fromServer.tps : undefined;
          copy[copy.length - 1] = {
            ...last,
            content: typeof fromServer?.content === 'string' ? fromServer.content : last.content,
            reasoning:
              typeof fromServer?.reasoning === 'string' ? fromServer.reasoning : last.reasoning,
            reasoningApi:
              typeof fromServer?.reasoningApi === 'string'
                ? fromServer.reasoningApi
                : last.reasoningApi,
            activitySteps: (
              (fromServer?.activitySteps as ActivityStep[] | undefined) ??
              last.activitySteps ??
              []
            ).map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s)),
            turnStatus: st === 'completed' ? 'completed' : 'stopped',
            time: Date.now(),
            usage: (fromServer?.usage as UsageInfo | undefined) ?? last.usage,
            model: typeof fromServer?.model === 'string' ? fromServer.model : last.model,
            toolMs: serverToolMs != null ? Math.max(serverToolMs, last.toolMs ?? 0) : last.toolMs,
            llmMs: serverLlmMs ?? last.llmMs,
            ttftMs: serverTtftMs ?? last.ttftMs,
            tps: serverTps ?? last.tps,
          };
          return copy;
        });
        if (st === 'error' && ev.error && storeRef.current?.activeId === sessionId) {
          setError(formatChatError(ev.error));
        }
        // 订阅生命周期由 watchSessionRun / executeSend 管理，这里只结算 UI 状态
        liveRunsRef.current.delete(sessionId);
        if (runSessionIdRef.current === sessionId) runSessionIdRef.current = null;
        setSessionBusy(sessionId, false);
        if (storeRef.current?.activeId === sessionId) setToolHint(null);
      }
    }
  }

  function attachServerRun(sessionId: string, afterSeq = 0) {
    sseUnsubRef.current.get(sessionId)?.();
    setSessionBusy(sessionId, true);
    void (async () => {
      // 先拉快照覆盖本地，再从 seq 之后订阅，避免重放增量叠字
      const snap = await getSessionRun(sessionId);
      let fromSeq = afterSeq;
      if (snap?.ok && snap.assistant) {
        fromSeq = Math.max(fromSeq, snap.seq ?? 0);
        applySessionMessages(sessionId, (prev) => {
          const last = prev[prev.length - 1];
          const base =
            last?.role === 'assistant'
              ? last
              : ({ role: 'assistant', content: '', turnStatus: 'running' } as LocalMessage);
          const sa = snap.assistant as LocalMessage & {
            llmMs?: number;
            ttftMs?: number;
            toolMs?: number;
            tps?: number;
            usage?: UsageInfo;
            model?: string;
          };
          const nextMsg: LocalMessage = {
            ...base,
            content: typeof sa?.content === 'string' ? sa.content : base.content,
            reasoning: typeof sa?.reasoning === 'string' ? sa.reasoning : base.reasoning,
            reasoningApi:
              typeof (sa as { reasoningApi?: string })?.reasoningApi === 'string'
                ? (sa as { reasoningApi?: string }).reasoningApi
                : base.reasoningApi,
            activitySteps: (sa?.activitySteps as ActivityStep[] | undefined) ?? base.activitySteps,
            turnStatus:
              snap.status === 'completed'
                ? 'completed'
                : snap.status === 'stopped' || snap.status === 'error'
                  ? 'stopped'
                  : 'running',
            usage: sa?.usage ?? base.usage,
            model: typeof sa?.model === 'string' ? sa.model : base.model,
            llmMs: typeof sa?.llmMs === 'number' ? sa.llmMs : base.llmMs,
            ttftMs: typeof sa?.ttftMs === 'number' ? sa.ttftMs : base.ttftMs,
            toolMs:
              typeof sa?.toolMs === 'number' ? Math.max(sa.toolMs, base.toolMs ?? 0) : base.toolMs,
            tps: typeof sa?.tps === 'number' ? sa.tps : base.tps,
          };
          if (last?.role === 'assistant') {
            const copy = prev.slice();
            copy[copy.length - 1] = nextMsg;
            return copy;
          }
          return [...prev, nextMsg];
        });
        if (snap.status && snap.status !== 'running' && snap.status !== 'waiting_user') {
          setSessionBusy(sessionId, false);
          return;
        }
      }
      const unsub = watchSessionRun(sessionId, fromSeq, {
        onEvent: (ev) => applyServerRunEvent(sessionId, ev),
        onGaveUp: (err) => {
          if (storeRef.current?.activeId === sessionId) {
            setError(err.message || '与服务端回合断开');
          }
          setSessionBusy(sessionId, false);
        },
      });
      sseUnsubRef.current.set(sessionId, unsub);
    })();
  }

  /** 把消息写入指定会话（后台回合也走这里）；当前会话同步 React state */
  function applySessionMessages(
    sessionId: string,
    next: LocalMessage[] | ((prev: LocalMessage[]) => LocalMessage[]),
    opts?: { touchUpdatedAt?: boolean },
  ) {
    const run = liveRunsRef.current.get(sessionId);
    const fromStore =
      (storeRef.current?.sessions.find((s) => s.id === sessionId)?.messages as
        LocalMessage[] | undefined) ?? [];
    const prev =
      run?.messages ?? (storeRef.current?.activeId === sessionId ? messagesRef.current : fromStore);
    const msgs = typeof next === 'function' ? next(prev) : next;
    if (run) run.messages = msgs;
    if (storeRef.current?.activeId === sessionId) {
      messagesRef.current = msgs;
      setMessages(msgs);
    }
    if (storeRef.current) {
      commitStore(
        updateSessionMessages(storeRef.current, sessionId, msgs, {
          touchUpdatedAt: opts?.touchUpdatedAt !== false,
        }),
      );
    }
  }

  function updateLastAssistant(fn: (m: LocalMessage) => LocalMessage) {
    const sid = runSessionIdRef.current ?? storeRef.current?.activeId;
    if (!sid) return;
    applySessionMessages(sid, (prev) => {
      const last = prev[prev.length - 1];
      if (last?.role !== 'assistant') return prev;
      const copy = prev.slice();
      copy[copy.length - 1] = fn(last);
      return copy;
    });
  }

  function noteToolTiming(
    sessionId: string,
    stepId: string,
    status: 'running' | 'done' | string | undefined,
  ) {
    const key = `${sessionId}:${stepId}`;
    if (status === 'running') {
      toolTimingRef.current.set(key, Date.now());
      return;
    }
    if (status !== 'done' && status !== 'error') return;
    const t0 = toolTimingRef.current.get(key);
    toolTimingRef.current.delete(key);
    if (t0 == null) return;
    const dt = Math.max(0, Date.now() - t0);
    applySessionMessages(sessionId, (prev) => {
      const last = prev[prev.length - 1];
      if (last?.role !== 'assistant') return prev;
      const copy = prev.slice();
      copy[copy.length - 1] = { ...last, toolMs: (last.toolMs ?? 0) + dt };
      return copy;
    });
  }

  async function addImages(files: File[]) {
    if (!files.length) return;
    const accepted: ImageAtt[] = [];
    const rejected: string[] = [];
    const used = composerFileCount(attachments, images);
    for (const f of files) {
      if (used + accepted.length >= FILE_MAX_COUNT) {
        rejected.push(`${f.name || '图片'}（最多 ${FILE_MAX_COUNT} 个文件）`);
        continue;
      }
      try {
        accepted.push(await fileToImageAtt(f));
      } catch (e) {
        rejected.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (accepted.length) {
      setImages((prev) => [...prev, ...accepted].slice(0, FILE_MAX_COUNT));
    }
    setError(rejected.length ? `以下图片未添加：${rejected.join('、')}` : null);
  }

  function clearComposer() {
    setInput('');
    setAttachments([]);
    setImages([]);
    setDocRefs([]);
    setMentionDismissed(false);
    setPluginMenuDismissed(false);
  }

  function dismissComposerChip() {
    if (composerChip === 'plan') {
      settlePlanCanceled();
      setPlanPhase('off');
    }
    if (composerChip === 'pluginDev') {
      setPluginDevConfig(null);
      pluginDevConfigRef.current = null;
      if (storeRef.current) {
        commitStore(updateActiveSessionMeta(storeRef.current, { pluginDev: undefined }));
      }
      // 只在「激活时被提权、还没开始开发」的情况下还原原权限
      const prev = pluginDevPrevAccessRef.current;
      pluginDevPrevAccessRef.current = null;
      if (prev === 'readonly') {
        setAccess('readonly');
        if (storeRef.current) {
          commitStore(updateActiveSessionMeta(storeRef.current, { access: 'readonly' }));
        }
      }
    }
    setComposerChip(null);
  }

  function activateGoalChip() {
    setComposerChip('goal');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function activatePlanChip() {
    setPlanPhase((cur) => (cur === 'off' ? 'planning' : cur));
    setComposerChip('plan');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  /** 与「计划」同款胶囊：不弹抽屉，直接在主输入框描述插件需求 */
  function activatePluginDevChip() {
    if (!fsLive) {
      setError('本地文件服务未就绪：插件开发需要读写项目源码');
      return;
    }
    setComposerChip('pluginDev');
    // 插件开发必须能改源码：激活时就把权限提到可写，别让底栏还显示「仅可查看」
    // （只在 readonly 时提升；用户原本选的是「完全权限」就保持不动）
    if (access === 'readonly') {
      pluginDevPrevAccessRef.current = 'readonly';
      setAccess('readwrite');
      if (storeRef.current) {
        commitStore(updateActiveSessionMeta(storeRef.current, { access: 'readwrite' }));
      }
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  /** 汇报生成胶囊：从工作汇报页「去工作台写汇报」带过来，发送即按当前提示词写一份 */
  function activateReportChip(kind: ReportKind) {
    setReportChipKind(kind);
    setComposerChip('reports');
    // 页面刚挂载时 textarea 可能还没渲染出来，稍等一帧再聚焦
    window.setTimeout(() => textareaRef.current?.focus(), 400);
  }

  function toCompactable(list: LocalMessage[]): CompactableMessage[] {
    return list
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
        reasoning: m.reasoning,
      }));
  }

  async function runSessionCompact(opts: { force: boolean; signal?: AbortSignal }) {
    if (!settings) {
      openSettings('model');
      return false;
    }
    const src = toCompactable(messagesRef.current);
    if (src.length < 4) {
      setError('对话轮次较少，无需压缩');
      return false;
    }
    setToolHint('正在压缩上下文…');
    try {
      const { messages: compacted, compacted: did } = await compactMessageList(settings, src, {
        force: opts.force,
        signal: opts.signal,
      });
      if (!did) {
        setToolHint(null);
        setError('当前上下文未超过阈值，未压缩');
        return false;
      }
      const now = Date.now();
      const nextLocal: LocalMessage[] = compacted.map((m, i) => ({
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        time: now + i,
      }));
      messagesRef.current = nextLocal;
      setMessages(nextLocal);
      if (storeRef.current) {
        commitStore(updateActiveMessages(storeRef.current, nextLocal, { touchUpdatedAt: true }));
      }
      setToolHint(null);
      return true;
    } catch (e) {
      setToolHint(null);
      if (e instanceof DOMException && e.name === 'AbortError') return false;
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function send(text?: string, opts?: { forceBusy?: BusySendBehavior }) {
    const fromComposer = text === undefined;
    // 汇报胶囊激活时，输入框留空直接回车/点发送也算「生成日报/周报/月报」
    const reportAsk =
      fromComposer && composerChip === 'reports' ? `生成${REPORT_KIND_LABEL[reportChipKind]}` : '';
    const content = (text ?? input).trim() || reportAsk;
    const files = fromComposer ? attachments : [];
    const refs = fromComposer ? docRefs : [];
    const imgs = fromComposer ? images : [];
    if (!content && !files.length && !refs.length && !imgs.length) return;
    if (!settings) {
      openSettings('model');
      return;
    }
    // 汇报胶囊是一次性的：发出这条请求后就收起，后续对话不再自动补「生成X报」
    if (fromComposer && composerChip === 'reports') setComposerChip(null);

    // command-compact：/compact 手动压缩（与 compaction-basic 同管线）
    if (isCompactCommand(content) && !files.length && !refs.length && !imgs.length) {
      if (streamingRef.current) {
        setError('请等待当前回复结束后再压缩');
        return;
      }
      if (fromComposer) clearComposer();
      const ok = await runSessionCompact({ force: true });
      if (ok) setError(null);
      return;
    }

    // 目标胶囊：输入正文后发送即设定会话目标
    if (
      composerChip === 'goal' &&
      content &&
      !files.length &&
      !refs.length &&
      !imgs.length &&
      !isGoalCommand(content) &&
      !isCompactCommand(content)
    ) {
      if (fromComposer) clearComposer();
      const nextGoal: SessionGoal = {
        text: content.slice(0, 500),
        status: 'active',
        updatedAt: Date.now(),
      };
      sessionGoalRef.current = nextGoal;
      setSessionGoal(nextGoal);
      goalDriverRoundsRef.current = 0;
      if (storeRef.current) {
        commitStore(updateActiveSessionMeta(storeRef.current, { goal: nextGoal }));
      }
      setComposerChip(null);
      setError(`已设定目标：${nextGoal.text}`);
      return;
    }

    // command-goal：/goal [set …|clear|done]
    if (isGoalCommand(content) && !files.length && !refs.length && !imgs.length) {
      const cmd = parseGoalCommand(content);
      if (fromComposer) clearComposer();
      if (!cmd) return;
      if (cmd.kind === 'show') {
        const g = sessionGoal;
        setError(
          g && g.status !== 'cleared'
            ? `当前目标（${g.status}）：${g.text}`
            : '当前无会话目标。可用 /goal set <内容> 设定',
        );
        return;
      }
      if (cmd.kind === 'clear') {
        sessionGoalRef.current = null;
        setSessionGoal(null);
        goalDriverRoundsRef.current = 0;
        if (storeRef.current) {
          commitStore(updateActiveSessionMeta(storeRef.current, { goal: undefined }));
        }
        setError('已清除会话目标');
        return;
      }
      if (cmd.kind === 'done') {
        if (!sessionGoal?.text) {
          setError('当前无目标可标记完成');
          return;
        }
        const nextGoal: SessionGoal = {
          ...sessionGoal,
          status: 'done',
          updatedAt: Date.now(),
        };
        sessionGoalRef.current = nextGoal;
        setSessionGoal(nextGoal);
        goalDriverRoundsRef.current = 0;
        if (storeRef.current) {
          commitStore(updateActiveSessionMeta(storeRef.current, { goal: nextGoal }));
        }
        setError(`已标记目标完成：${nextGoal.text}`);
        return;
      }
      if (cmd.kind === 'set' && cmd.text) {
        const nextGoal: SessionGoal = {
          text: cmd.text.slice(0, 500),
          status: 'active',
          updatedAt: Date.now(),
        };
        sessionGoalRef.current = nextGoal;
        setSessionGoal(nextGoal);
        goalDriverRoundsRef.current = 0;
        if (storeRef.current) {
          commitStore(updateActiveSessionMeta(storeRef.current, { goal: nextGoal }));
        }
        setError(`已设定目标：${nextGoal.text}`);
        return;
      }
      return;
    }

    // 插件开发胶囊：首条消息就是需求，进入固定提示词会话（项目根 + 读写）
    if (composerChip === 'pluginDev' && content && !files.length && !refs.length && !imgs.length) {
      if (streamingRef.current) {
        setError('请等待当前回复结束后再开始插件开发');
        return;
      }
      await enterPluginDevMode(content);
    }

    const prepared: PendingSend = {
      id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      content,
      files: [...files],
      refs: [...refs],
      imgs: [...imgs],
    };

    if (streamingRef.current) {
      const primary = loadGeneralPrefs().busySendBehavior ?? 'queue';
      const action = opts?.forceBusy ?? primary;
      if (action === 'queue') {
        syncSendQueue([...sendQueueRef.current, prepared]);
        if (fromComposer) clearComposer();
        return;
      }
      // 插话：中断当前轮，结束后立刻发这条，其后仍按队列自主续发
      interruptPayloadRef.current = prepared;
      if (fromComposer) clearComposer();
      abortSessionRun(storeRef.current?.activeId);
      return;
    }

    await executeSend(prepared);
  }

  async function executeSend(prepared: PendingSend) {
    const sid = storeRef.current?.activeId;
    if (!settings || !sid || liveRunsRef.current.has(sid)) return;
    const { content, files, refs, imgs } = prepared;
    // 人类新发言（非 driver 续轮）重置目标驱动计数
    if (!isGoalDriverMessage(content)) {
      goalDriverRoundsRef.current = 0;
    }
    setError(null);
    const now = Date.now();
    const userMsg: LocalMessage = { role: 'user', content, time: now };
    if (files.length) userMsg.attachments = files;
    if (refs.length) userMsg.refs = refs;
    if (imgs.length) userMsg.images = imgs;
    // 同步裁掉「中断后仍为空」的助手气泡，避免排队/插话叠一条空消息
    // 注意：勿命名为 base，会遮蔽外层 BASE_URL，导致 kb_* 工具 opts.base.endsWith 报错
    let hist = messagesRef.current;
    const last = hist[hist.length - 1];
    if (last?.role === 'assistant' && !last.content && !last.reasoning) {
      hist = hist.slice(0, -1);
    }
    let next: LocalMessage[] = [...hist, userMsg];

    // compaction-basic：上下文过大时自动压缩（保留最近轮次 + 摘要）
    if (needsAutoCompact(toCompactable(next), settings.model)) {
      setToolHint('上下文较长，正在压缩…');
      try {
        const { messages: compacted, compacted: did } = await compactMessageList(
          settings,
          toCompactable(next),
          { force: false, signal: undefined },
        );
        if (did) {
          const t0 = Date.now();
          next = compacted.map((m, i) => ({
            role: m.role,
            content: m.content,
            reasoning: m.reasoning,
            time: t0 + i,
          }));
          // 确保最新用户消息仍在末尾（compact 已含 recent+user）
          messagesRef.current = next;
          setMessages(next);
          if (storeRef.current) {
            commitStore(updateActiveMessages(storeRef.current, next, { touchUpdatedAt: true }));
          }
        }
      } catch {
        // 压缩失败不阻断发送
      }
      setToolHint(null);
    }

    const withAssistant: LocalMessage[] = [
      ...next,
      { role: 'assistant', content: '', time: now, turnStatus: 'running' },
    ];
    messagesRef.current = withAssistant;
    setMessages(withAssistant);
    clearComposer();
    const ctrl = new AbortController();
    runSessionIdRef.current = sid;
    liveRunsRef.current.set(sid, { abort: ctrl, messages: withAssistant });
    abortRef.current = ctrl;
    setSessionBusy(sid, true);
    followRef.current = true; // 发送新消息：强制回到跟随态
    setShowJump(false);

    // role+content；有图时 content 为多模态数组；助手思考内容须按 DeepSeek 要求回传
    const apiMessages: ChatMessage[] = offloadStaleImages(
      next.map((m) => {
        const msg: ChatMessage = {
          role: m.role,
          content: toApiMessageContent(m),
        };
        const reasoningEcho = (m.reasoningApi ?? m.reasoning)?.trim();
        if (m.role === 'assistant' && reasoningEcho) {
          msg.reasoning_content = reasoningEcho;
        }
        return msg;
      }),
      { keepRecentImageMessages: 1 },
    );
    const useMemory = memoryLive;
    const useKnowledge = knowledgeOn;
    const useFs = fsLive;
    const useWeb = webLive;
    const useTodos = Boolean(pluginOn.todos);
    const useTasks = Boolean(pluginOn.tasks);
    const useProjects = Boolean(pluginOn.projects);
    const useIterations = Boolean(pluginOn.iterations);
    const usePmRequirements = Boolean(pluginOn.pmRequirements);
    const useBugs = Boolean(pluginOn.bugs);
    const planGatesWrites = planPhase === 'planning';
    const pluginDevCfg =
      pluginOn.pluginDev && pluginDevConfigRef.current?.active ? pluginDevConfigRef.current : null;
    // 插件开发要改项目源码：不受计划门禁限制，至少「工作区内修改」；用户原本选「完全权限」则保留
    const effectiveAccess = pluginDevCfg
      ? access === 'full'
        ? 'full'
        : 'readwrite'
      : planGatesWrites
        ? 'readonly'
        : access;
    const useBash = bashLive && effectiveAccess !== 'readonly';
    const usePwsh = pwshLive && effectiveAccess !== 'readonly';
    // 输入以 picker / FS 当前工作区为准（可手动切到会话归属以外的目录）
    const effectiveFsRoot = workspaceInfoRef.current?.workspace?.trim() || '';
    const fsHintExtra = effectiveFsRoot ? `\n当前工作区：${effectiveFsRoot}` : '';
    const promptCfg =
      pluginOn.promptGen && promptGenConfigRef.current?.active ? promptGenConfigRef.current : null;
    const knowledgeGenCfg =
      !promptCfg && pluginOn.knowledgeGen && knowledgeGenConfigRef.current?.active
        ? knowledgeGenConfigRef.current
        : null;
    const caseCfg =
      !promptCfg && !knowledgeGenCfg && pluginOn.caseGen && caseGenConfigRef.current?.active
        ? caseGenConfigRef.current
        : null;
    const structuredPlugin = Boolean(promptCfg || knowledgeGenCfg || caseCfg);
    const memCwd = effectiveFsRoot;
    // 普通对话用当前空间「默认提示词.md」；生成用例 / 提示词 / 知识库插件开启时改用插件所选提示词
    let baseSystem = systemPrompt;
    if (pluginDevCfg) {
      // 插件开发：固定提示词（不跟随空间默认提示词），但保留文件 / 终端 / 提问等工具
      baseSystem = buildPluginDevSystemPrompt(
        pluginDevCfg,
        workspaceInfoRef.current?.harnessRoot ||
          workspaceInfoRef.current?.projectRoot ||
          effectiveFsRoot,
      );
    } else if (promptCfg) {
      baseSystem = buildPromptGenSystemPrompt(promptCfg);
    } else if (knowledgeGenCfg) {
      baseSystem = buildKnowledgeGenSystemPrompt(knowledgeGenCfg);
    } else if (caseCfg) {
      if (!caseCfg.promptBody?.trim()) {
        setError('生成测试用例已启用，但未选择提示词。请打开插件重新「确认」。');
        liveRunsRef.current.delete(sid);
        runSessionIdRef.current = null;
        abortRef.current = null;
        setSessionBusy(sid, false);
        setMessages((prev) =>
          prev[prev.length - 1]?.role === 'assistant' && !prev[prev.length - 1]?.content
            ? prev.slice(0, -1)
            : prev,
        );
        return;
      }
      try {
        baseSystem = buildCaseGenSystemPrompt(
          caseCfg,
          caseCfg.docTitle ||
            caseCfg.reqPath
              ?.split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '') ||
            '',
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        liveRunsRef.current.delete(sid);
        runSessionIdRef.current = null;
        abortRef.current = null;
        setSessionBusy(sid, false);
        return;
      }
    }
    // 会话注入：time-context（纯前端）+ agent-instructions（本地 fs）
    if (!structuredPlugin) {
      // 工作汇报插件：提示词正文追加到系统提示词（插件开发有自己的固定提示词，不叠加）
      let reportText = reportPrompt;
      if (!pluginDevCfg && !reportText.trim() && pluginOn.reports) {
        // 首条消息可能赶在页面加载提示词之前：发送时再补一次
        try {
          await syncReportPrompt(true);
          reportText = await fetchReportPrompt();
        } catch {
          // 本地服务未就绪：不注入
        }
      }
      if (!pluginDevCfg && reportText.trim()) {
        baseSystem = `${baseSystem}\n\n${reportText.trim()}`;
      }
      const prevUser = [...next]
        .reverse()
        .find((m) => m.role === 'user' && m !== next[next.length - 1]);
      const lastUserAt =
        prevUser?.time ?? [...next].reverse().find((m) => m.role === 'user')?.time ?? null;
      const timeCtx = formatTimeContext({
        lastUserMessageAt: lastUserAt,
        lastInjectAt: timeInjectAtRef.current,
      });
      if (timeCtx.injected) timeInjectAtRef.current = timeCtx.at;
      baseSystem = `${baseSystem}\n\n${timeCtx.text}`;

      if (useFs) {
        try {
          const instr = await fetchAgentInstructions();
          if (instr?.text) {
            baseSystem = `${baseSystem}\n\n${AGENT_INSTRUCTIONS_HINT_PREFIX}\n\n${instr.text}`;
          }
        } catch {
          // 静默跳过
        }
      }
    }

    let payload = buildPluginMessages(baseSystem, apiMessages, {
      memory: useMemory && !structuredPlugin,
      knowledge: useKnowledge && !structuredPlugin,
      fs: useFs && !structuredPlugin,
      web: useWeb && !structuredPlugin,
      bash: useBash && !structuredPlugin,
      pwsh: usePwsh && !structuredPlugin,
      interact: !structuredPlugin,
      todos: useTodos && !structuredPlugin,
      tasks: useTasks && !structuredPlugin,
      projects: useProjects && !structuredPlugin,
      iterations: useIterations && !structuredPlugin,
      pmRequirements: usePmRequirements && !structuredPlugin,
      bugs: useBugs && !structuredPlugin,
      planPhase: structuredPlugin || pluginDevCfg ? 'off' : planPhase,
      goalEnabled: !structuredPlugin,
      goal: sessionGoal,
      scheduleEnabled: !structuredPlugin,
      subagentEnabled: !structuredPlugin,
      workflowEnabled: !structuredPlugin,
    }).map((m, i) =>
      i === 0 && m.role === 'system' && useFs && fsHintExtra && !structuredPlugin
        ? { ...m, content: `${typeof m.content === 'string' ? m.content : ''}${fsHintExtra}` }
        : m,
    );

    // 五轨快照注入：超时/失败则跳过，不阻塞发送（结构化插件模式跳过）
    // FS 工作区已由会话切换同步或输入栏手动选择决定，发送时不再拉回会话归属
    if (useMemory && !structuredPlugin && !pluginDevCfg) {
      setToolHint('记忆注入中…');
      const { context } = await recallMemory(content, { cwd: memCwd });
      if (context && payload[0]?.role === 'system') {
        const sys = typeof payload[0].content === 'string' ? payload[0].content : '';
        payload = [{ ...payload[0], content: `${sys}\n\n${context}` }, ...payload.slice(1)];
      }
      setToolHint(null);
    }

    const tools: ToolDef[] = [];
    if (!structuredPlugin) {
      if (useKnowledge) tools.push(...(KB_TOOLS as unknown as ToolDef[]));
      if (useFs) {
        tools.push(...(fsToolsForAccess(effectiveAccess) as unknown as ToolDef[]));
        tools.push(...(WORKING_DIRECTORY_TOOLS as unknown as ToolDef[]));
        tools.push(...(SKILL_TOOLS as unknown as ToolDef[]));
        tools.push(...(WORKSPACE_CHANGES_TOOLS as unknown as ToolDef[]));
        tools.push(WORKSPACE_DEPS_TOOL as unknown as ToolDef);
        if (!planGatesWrites) {
          tools.push(OFFICE_TO_PDF_TOOL as unknown as ToolDef);
          tools.push(PRESENT_TOOL as unknown as ToolDef);
        }
      }
      if (useBash) {
        tools.push(BASH_TOOL as unknown as ToolDef);
        tools.push(...(BASH_SESSION_TOOLS as unknown as ToolDef[]));
      }
      if (usePwsh) {
        tools.push(PWSH_TOOL as unknown as ToolDef);
        tools.push(...(PWSH_SESSION_TOOLS as unknown as ToolDef[]));
      }
      if (useBash || usePwsh) tools.push(...(JOB_TOOLS as unknown as ToolDef[]));
      if (useWeb) tools.push(...(WEB_TOOLS as unknown as ToolDef[]));
      if (useMemory) tools.push(...(MEMORY_TOOLS as unknown as ToolDef[]));
      tools.push(TODO_WRITE_TOOL as unknown as ToolDef);
      if (useTodos) tools.push(...(TODO_TOOLS as unknown as ToolDef[]));
      if (useTasks) tools.push(...(TASK_TOOLS as unknown as ToolDef[]));
      if (useProjects) tools.push(...(PM_PROJECT_TOOLS as unknown as ToolDef[]));
      if (useIterations) tools.push(...(PM_ITERATION_TOOLS as unknown as ToolDef[]));
      if (usePmRequirements) tools.push(...(PM_REQUIREMENT_TOOLS as unknown as ToolDef[]));
      if (useBugs) tools.push(...(PM_BUG_TOOLS as unknown as ToolDef[]));
      tools.push(ASK_USER_QUESTION_TOOL as unknown as ToolDef);
      tools.push(...(GOAL_TOOLS as unknown as ToolDef[]));
      tools.push(...(SCHEDULE_TOOLS as unknown as ToolDef[]));
      tools.push(...(SUBAGENT_TOOLS as unknown as ToolDef[]));
      tools.push(...(WORKFLOW_TOOLS as unknown as ToolDef[]));
      if (planPhase === 'planning' || planPhase === 'approved') {
        tools.push(SUBMIT_PLAN_TOOL as unknown as ToolDef);
      }
    }

    const requestStartTs = Date.now();
    let firstTokenTs = 0;
    turnTimingRef.current.set(sid, { start: requestStartTs });
    let reasoningStartTs = 0;
    let reasoningSettled = false;
    /** 原始思考缓冲：sanitize 后再写入 UI，避免 DSML 半截/整段泄漏 */
    let reasoningRaw = '';
    let turnOk = false;
    let progressTimer: number | undefined;
    const structuredGen = Boolean(promptCfg || knowledgeGenCfg || caseCfg);
    function structuredProgress(elapsedSec: number) {
      if (promptCfg) return formatPromptGenProgress(elapsedSec);
      if (knowledgeGenCfg) return formatKnowledgeGenProgress(elapsedSec);
      return formatCaseGenProgress(elapsedSec);
    }
    function structuredToolHint() {
      if (promptCfg) return '正在编写提示词…';
      if (knowledgeGenCfg) return '正在编写知识库…';
      return '正在编写用例…';
    }
    // 须在 try 外声明，finally 要据此判断是否误标 stopped
    let usedServerRun = false;
    try {
      let caseRaw = '';
      let promptRaw = '';
      let knowledgeGenRaw = '';
      if (structuredGen) {
        setToolHint(structuredToolHint());
        const paint = () => {
          const elapsed = Math.max(0, Math.floor((Date.now() - requestStartTs) / 1000));
          updateLastAssistant((m) => ({ ...m, content: structuredProgress(elapsed) }));
        };
        paint();
        progressTimer = window.setInterval(paint, 1000);
      }

      // 待办 / 任务写入要先弹可编辑的确认卡片；项目管理的四组工具依赖浏览器侧的本地接口
      // （相对路径 /__tb_pm），服务端回合没有这些通道，统一改走浏览器流
      const needsClientConfirm =
        useTodos || useTasks || useProjects || useIterations || usePmRequirements || useBugs;
      // 服务端回合：刷新/切页可重连；结构化生成与插件开发仍走浏览器流（后者要用 ask_user_question 确认）
      if (
        !needsClientConfirm &&
        !structuredGen &&
        !pluginDevCfg &&
        (await sessionRunsAvailable(ctrl.signal))
      ) {
        const serverTools = tools.filter((t) => {
          const n = t.function?.name ?? '';
          if (!n) return false;
          if (n === 'ask_user_question' || n === 'submit_plan' || n === 'workflow') return false;
          if (n === 'spawn_subagent' || n === 'fork_subagent' || n === 'list_agents') return false;
          if (n.startsWith('subagent_')) return false;
          return true;
        });
        const started = await startSessionRun({
          sessionId: sid,
          messages: payload,
          settings: {
            baseURL: settings.baseURL,
            apiKey: settings.apiKey,
            model: settings.model,
            reasoningEffort: settings.reasoningEffort,
          },
          tools: serverTools,
          thinking: true,
          workspace: effectiveFsRoot || '',
          access: effectiveAccess,
          // 不传 maxToolRounds：服务端默认 DEFAULT_TOOL_ROUNDS（100），
          // 插件开发与普通会话一致，避免调研到一半被收口
        });
        if (started.ok) {
          usedServerRun = true;
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            const onAbort = () => {
              void stopSessionRun(sid);
            };
            ctrl.signal.addEventListener('abort', onAbort);
            sseUnsubRef.current.get(sid)?.();
            const unsub = watchSessionRun(sid, 0, {
              signal: ctrl.signal,
              onEvent: (ev) => applyServerRunEvent(sid, ev),
              onTerminal: (ev) => {
                turnOk = ev.status === 'completed';
                ctrl.signal.removeEventListener('abort', onAbort);
                sseUnsubRef.current.delete(sid);
                finish();
              },
              onGaveUp: (err) => {
                if (storeRef.current?.activeId === sid) {
                  setError(err.message || '与服务端回合断开');
                }
                applySessionMessages(sid, (prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.role !== 'assistant') return prev;
                  const copy = prev.slice();
                  copy[copy.length - 1] = {
                    ...last,
                    turnStatus: 'stopped',
                    activitySteps: (last.activitySteps ?? []).map((s) =>
                      s.status === 'running' ? { ...s, status: 'done' as const } : s,
                    ),
                  };
                  return copy;
                });
                ctrl.signal.removeEventListener('abort', onAbort);
                sseUnsubRef.current.delete(sid);
                finish();
              },
            });
            sseUnsubRef.current.set(sid, () => {
              unsub();
              finish();
            });
          });
        }
      }

      if (usedServerRun) {
        // 服务端路径已消费完 SSE；后面的浏览器流跳过
      } else {
        const stream = streamChatWithTools(settings, payload, ctrl.signal, {
          tools: tools.length ? tools : undefined,
          // 不传 maxToolRounds：走 llm.ts 的 DEFAULT_MAX_TOOL_ROUNDS（100）
          runTool: tools.length
            ? async (name, args) => {
                setToolBusy(true);
                const kind = toolKindLabel(name);
                setToolHint(toolStepHint(loadGeneralPrefs().toolStepDetail, kind, name, 'running'));
                const toolT0 = Date.now();
                try {
                  if (name.startsWith('kb_')) {
                    return await runKnowledgeTool(name, args, { base, docs: slashDocs });
                  }
                  if (name.startsWith('fs_')) {
                    const text = await runFsTool(name, args, effectiveAccess);
                    const mut = parseFsMutationSuccess(name, text);
                    if (mut && storeRef.current) {
                      const cur = storeRef.current.sessions.find((s) => s.id === sid);
                      const nextList = recordWorkspaceChange(cur?.workspaceChanges, mut);
                      commitStore(
                        updateSessionMeta(storeRef.current, sid, { workspaceChanges: nextList }),
                      );
                    }
                    return text;
                  }
                  if (name.startsWith('skill_')) return await runSkillTool(name, args);
                  if (name === 'load_workspace_dependencies') {
                    return await runWorkspaceDepsTool(name);
                  }
                  if (name === 'office_to_pdf') {
                    if (planGatesWrites) {
                      return JSON.stringify({
                        error: '计划模式探查中：请先 submit_plan 并等待批准',
                      });
                    }
                    return await runOfficeToPdfTool(name, args, effectiveAccess);
                  }
                  if (name.startsWith('workspace_changes_')) {
                    const cur = storeRef.current?.sessions.find((s) => s.id === sid);
                    const { text, next } = runWorkspaceChangesTool(name, cur?.workspaceChanges);
                    if (next && storeRef.current) {
                      commitStore(
                        updateSessionMeta(storeRef.current, sid, { workspaceChanges: next }),
                      );
                    }
                    return text;
                  }
                  if (name.startsWith('working_directory_')) {
                    const { text, info } = await runWorkingDirectoryTool(name, args);
                    if (info) {
                      syncWorkspaceInfo(info);
                      if (name === 'working_directory_set' && storeRef.current) {
                        commitStore(
                          updateSessionMeta(storeRef.current, sid, {
                            workspacePath: info.workspace,
                          }),
                        );
                      }
                    }
                    return text;
                  }
                  if (name === 'present') {
                    if (planGatesWrites) {
                      return JSON.stringify({
                        error: '计划模式探查中：请先 submit_plan 并等待批准',
                      });
                    }
                    const raw = await runPresentTool(args, effectiveAccess);
                    try {
                      const parsed = JSON.parse(raw) as {
                        ok?: boolean;
                        files?: PresentFile[];
                      };
                      if (parsed.ok && parsed.files?.length) {
                        updateLastAssistant((m) => {
                          const prev = m.presentFiles ?? [];
                          const byPath = new Map(prev.map((f) => [f.path, f]));
                          for (const f of parsed.files!) byPath.set(f.path, f);
                          return { ...m, presentFiles: [...byPath.values()] };
                        });
                      }
                    } catch {
                      // ignore parse for UI; tool result still returned to model
                    }
                    return raw;
                  }
                  if (name === 'todo_add') {
                    if (planGatesWrites) {
                      return JSON.stringify({
                        error: '计划模式探查中：请先 submit_plan 并等待批准',
                      });
                    }
                    // 写入前先让用户确认。AI 新增走「快卡」：只改名称，
                    // 状态固定进行中、日期取当天、默认挂到「日常待办」；
                    // 与「+ → 待办」那张完整表单区分开。
                    let rawItems: unknown;
                    try {
                      rawItems = (JSON.parse(args || '{}') as { items?: unknown }).items;
                    } catch {
                      rawItems = undefined;
                    }
                    const drafts = normalizeCreateDraft('todo', rawItems);
                    // 没有可用标题就不弹卡：AI 只有在用户明确要求记录待办时才该调用，
                    // 手动新增走「+ → 待办」，不靠这张空白快卡
                    if (!drafts.length) {
                      return JSON.stringify({
                        error:
                          '没有可记录的待办：只有用户明确要求记录待办时才调用 todo_add，并给出待办标题；不要为了弹出卡片而调用工具。',
                      });
                    }
                    const plan = await planQuickTodo(drafts);
                    const confirmed = await askCreateConfirm('todo', plan.items, {
                      quick: true,
                      quickNote: plan.willCreateRoutine
                        ? '确认后会创建任务「日常待办」并关联，状态 / 日期已自动填好'
                        : undefined,
                    });
                    if (!confirmed) {
                      return JSON.stringify({
                        ok: false,
                        cancelled: true,
                        message: '用户取消了新增待办，未写入任何数据。',
                      });
                    }
                    // 确认后才补「日常待办」任务，避免用户取消时留下空任务
                    let ready: CreateDraftItem[];
                    try {
                      ready = await attachQuickTodoTasks(confirmed);
                    } catch (e) {
                      return JSON.stringify({
                        error: `创建所属任务失败：${e instanceof Error ? e.message : String(e)}`,
                      });
                    }
                    args = JSON.stringify({ items: draftToCreateArgs('todo', ready) });
                  }
                  if (name === 'task_add') {
                    if (planGatesWrites) {
                      return JSON.stringify({
                        error: '计划模式探查中：请先 submit_plan 并等待批准',
                      });
                    }
                    const drafts = normalizeCreateDraft('task', parseTaskAddItems(args));
                    if (!drafts.length) drafts.push(blankCreateDraft('task'));
                    const confirmed = await askCreateConfirm('task', drafts);
                    if (!confirmed) {
                      return JSON.stringify({
                        ok: false,
                        cancelled: true,
                        message: '用户取消了新增任务，未写入任何数据。',
                      });
                    }
                    args = JSON.stringify({ items: draftToCreateArgs('task', confirmed) });
                  }
                  if (name.startsWith('task_')) {
                    const result = await runTaskTool(name, args, { sessionId: sid });
                    if (name === 'task_add') {
                      try {
                        const parsed = JSON.parse(result) as { ok?: boolean; count?: number };
                        if (parsed.ok && parsed.count) {
                          setError(
                            `已创建 ${parsed.count} 个任务，可在侧栏「任务管理」查看。`,
                            'ok',
                          );
                        }
                      } catch {
                        // 结果解析失败不影响工具返回
                      }
                    }
                    return result;
                  }
                  if (name.startsWith('todo_') && name !== 'todo_write') {
                    if (planGatesWrites && name !== 'todo_list') {
                      return JSON.stringify({
                        error: '计划模式探查中：请先 submit_plan 并等待批准',
                      });
                    }
                    const result = await runTodoTool(name, args, { sessionId: sid });
                    if (name === 'todo_add') {
                      try {
                        const parsed = JSON.parse(result) as { ok?: boolean; count?: number };
                        if (parsed.ok && parsed.count) {
                          setError(
                            `已记录 ${parsed.count} 条待办，可在侧栏「待办事项」查看。`,
                            'ok',
                          );
                        }
                      } catch {
                        // 结果解析失败不影响工具返回
                      }
                    }
                    return result;
                  }
                  if (name === 'todo_write') {
                    let rawTodos: unknown;
                    try {
                      rawTodos = (JSON.parse(args || '{}') as { todos?: unknown }).todos;
                    } catch {
                      return JSON.stringify({ error: 'invalid JSON arguments' });
                    }
                    const todos = normalizeTodos(rawTodos);
                    if (storeRef.current?.activeId === sid) setSessionTodos(todos);
                    if (storeRef.current) {
                      commitStore(updateSessionMeta(storeRef.current, sid, { todos }));
                    }
                    return JSON.stringify({ ok: true, count: todos.length, todos });
                  }
                  if (name.startsWith('pm_')) {
                    if (planGatesWrites && !name.endsWith('_list')) {
                      return JSON.stringify({
                        error: '计划模式探查中：请先 submit_plan 并等待批准',
                      });
                    }
                    const result = await runPmTool(name, args, { sessionId: sid });
                    if (name.endsWith('_add')) {
                      try {
                        const parsed = JSON.parse(result) as { ok?: boolean; count?: number };
                        if (parsed.ok && parsed.count) {
                          const target = name.startsWith('pm_project_')
                            ? '项目列表'
                            : name.startsWith('pm_iteration_')
                              ? '迭代管理'
                              : name.startsWith('pm_requirement_')
                                ? '需求管理'
                                : '缺陷管理';
                          const noun = name.startsWith('pm_iteration_')
                            ? '迭代'
                            : name.startsWith('pm_requirement_')
                              ? '条需求'
                              : name.startsWith('pm_bug_')
                                ? '条缺陷'
                                : '个项目';
                          setError(
                            `已创建 ${parsed.count} ${noun}，可在侧栏「${target}」查看。`,
                            'ok',
                          );
                        }
                      } catch {
                        // 结果解析失败不影响工具返回
                      }
                    }
                    return result;
                  }
                  if (name.startsWith('goal_')) {
                    if (name === 'goal_get') {
                      const g =
                        storeRef.current?.activeId === sid
                          ? sessionGoalRef.current
                          : normalizeGoal(
                              storeRef.current?.sessions.find((s) => s.id === sid)?.goal,
                            );
                      return formatGoalForModel(g);
                    }
                    if (name === 'goal_set') {
                      let text = '';
                      try {
                        text = String(
                          (JSON.parse(args || '{}') as { text?: unknown }).text ?? '',
                        ).trim();
                      } catch {
                        return JSON.stringify({ error: 'invalid JSON arguments' });
                      }
                      if (!text) return JSON.stringify({ error: 'text is required' });
                      const nextGoal: SessionGoal = {
                        text: text.slice(0, 500),
                        status: 'active',
                        updatedAt: Date.now(),
                      };
                      if (storeRef.current?.activeId === sid) {
                        sessionGoalRef.current = nextGoal;
                        setSessionGoal(nextGoal);
                        goalDriverRoundsRef.current = 0;
                      }
                      if (storeRef.current) {
                        commitStore(updateSessionMeta(storeRef.current, sid, { goal: nextGoal }));
                      }
                      return formatGoalForModel(nextGoal);
                    }
                    if (name === 'goal_done') {
                      const cur =
                        storeRef.current?.activeId === sid
                          ? sessionGoalRef.current
                          : normalizeGoal(
                              storeRef.current?.sessions.find((s) => s.id === sid)?.goal,
                            );
                      if (!cur?.text) {
                        return JSON.stringify({ ok: false, error: 'no goal to complete' });
                      }
                      const nextGoal: SessionGoal = {
                        ...cur,
                        status: 'done',
                        updatedAt: Date.now(),
                      };
                      if (storeRef.current?.activeId === sid) {
                        sessionGoalRef.current = nextGoal;
                        setSessionGoal(nextGoal);
                        goalDriverRoundsRef.current = 0;
                      }
                      if (storeRef.current) {
                        commitStore(updateSessionMeta(storeRef.current, sid, { goal: nextGoal }));
                      }
                      return formatGoalForModel(nextGoal);
                    }
                    if (name === 'goal_clear') {
                      if (storeRef.current?.activeId === sid) {
                        sessionGoalRef.current = null;
                        setSessionGoal(null);
                        goalDriverRoundsRef.current = 0;
                      }
                      if (storeRef.current) {
                        commitStore(updateSessionMeta(storeRef.current, sid, { goal: undefined }));
                      }
                      return JSON.stringify({ ok: true, goal: null });
                    }
                    return JSON.stringify({ error: `unknown tool: ${name}` });
                  }
                  if (name.startsWith('schedule_')) {
                    return await runScheduleTool(name, args, sid);
                  }
                  if (
                    name === 'list_agents' ||
                    name === 'spawn_subagent' ||
                    name === 'fork_subagent' ||
                    name.startsWith('subagent_')
                  ) {
                    return await runSubagentTool(name, args, {
                      settings: resolveSubagentSettings(settings, loadGeneralPrefs().subagentModel),
                      parentSignal: ctrl.signal,
                      access: effectiveAccess,
                      fsEnabled: useFs,
                      webEnabled: useWeb,
                      parentMessages: apiMessages,
                      onHint: (text) => setToolHint(text),
                      runFs: (n, a, acc) => runFsTool(n, a, acc),
                      runWeb: (n, a) => runWebTool(n, a),
                    });
                  }
                  if (name === 'workflow') {
                    return await runWorkflowTool(name, args, {
                      settings,
                      parentSignal: ctrl.signal,
                      access: effectiveAccess,
                      fsEnabled: useFs,
                      webEnabled: useWeb,
                      parentMessages: apiMessages,
                      onHint: (text) => setToolHint(text),
                      runFs: (n, a, acc) => runFsTool(n, a, acc),
                      runWeb: (n, a) => runWebTool(n, a),
                    });
                  }
                  if (name === 'ask_user_question') {
                    const questions = parseAskUserArgs(args);
                    if (!questions.length) {
                      return JSON.stringify({ error: 'questions is required' });
                    }
                    const draft: Record<string, { selected: string[]; text: string }> = {};
                    for (const q of questions) draft[q.id] = { selected: [], text: '' };
                    setAskUserDraft(draft);
                    setAskUserStep(0);
                    setAskUserMinimized(false);
                    setAskUserFeedback(null);
                    setAskSkipConfirm(false);
                    setAskSkipReason('');
                    setAskUserPrompt(questions);
                    return await new Promise<string>((resolve, reject) => {
                      askUserWaitRef.current = { resolve, reject };
                      const ac = abortRef.current;
                      const onAbort = () => {
                        ac?.signal.removeEventListener('abort', onAbort);
                        settleAskUserCanceled();
                      };
                      ac?.signal.addEventListener('abort', onAbort);
                    });
                  }
                  if (name === 'submit_plan') {
                    const plan = parseSubmitPlanArgs(args);
                    if (!plan) {
                      return JSON.stringify({ error: 'title and steps are required' });
                    }
                    setPlanProposal(plan);
                    return await new Promise<string>((resolve, reject) => {
                      planWaitRef.current = { resolve, reject };
                      const ac = abortRef.current;
                      const onAbort = () => {
                        ac?.signal.removeEventListener('abort', onAbort);
                        settlePlanCanceled();
                      };
                      ac?.signal.addEventListener('abort', onAbort);
                    });
                  }
                  if (name === 'bash') return await runBashTool(args, effectiveAccess);
                  if (name === 'pwsh') return await runPwshTool(args, effectiveAccess);
                  if (name.startsWith('bash_session_')) {
                    return await runBashSessionTool(name, args, effectiveAccess);
                  }
                  if (name.startsWith('pwsh_session_')) {
                    return await runPwshSessionTool(name, args, effectiveAccess);
                  }
                  if (name.startsWith('job_')) return await runJobTool(name, args, effectiveAccess);
                  if (name.startsWith('web_')) return await runWebTool(name, args);
                  if (name.startsWith('memory_')) return await runMemoryTool(name, args, memCwd);
                  return JSON.stringify({ error: `unknown tool: ${name}` });
                } finally {
                  const dt = Math.max(0, Date.now() - toolT0);
                  updateLastAssistant((m) => ({ ...m, toolMs: (m.toolMs ?? 0) + dt }));
                  setToolBusy(false);
                  refreshPluginRuntime();
                }
              }
            : undefined,
        });
        for await (const chunk of stream) {
          if (chunk.type === 'tool') {
            const kind = toolKindLabel(chunk.name);
            setToolHint(
              toolStepHint(
                loadGeneralPrefs().toolStepDetail,
                kind,
                chunk.name,
                chunk.status === 'running' ? 'running' : 'done',
              ),
            );
            const detail = toolArgsDetail(chunk.name, chunk.args);
            const stepId = `tool_${chunk.name}_${chunk.args?.slice(0, 24) ?? ''}`;
            const toolFailed =
              chunk.status === 'done' &&
              typeof chunk.result === 'string' &&
              /^\s*\{\s*"error"\s*:/.test(chunk.result);
            updateLastAssistant((m) => {
              const steps = [...(m.activitySteps ?? [])];
              const idx = steps.findIndex(
                (s) =>
                  s.id === stepId ||
                  (s.detail === detail && s.title === kind && s.status === 'running'),
              );
              const next: ActivityStep = {
                id: stepId,
                kind: activityKindForTool(chunk.name),
                title: kind,
                detail: detail || undefined,
                status: chunk.status === 'running' ? 'running' : toolFailed ? 'error' : 'done',
              };
              if (idx >= 0) steps[idx] = { ...steps[idx], ...next };
              else steps.push(next);
              return { ...m, activitySteps: steps };
            });
            continue;
          }
          if (chunk.type === 'usage') {
            const nowTs = Date.now();
            const decodeSecs = firstTokenTs ? (nowTs - firstTokenTs) / 1000 : 0;
            const outTok = completionTokensOf(chunk.usage);
            const tps = decodeSecs > 0.2 && outTok > 0 ? outTok / decodeSecs : undefined;
            updateLastAssistant((m) => ({
              ...m,
              usage: chunk.usage,
              tps,
              model: settings.model,
              ttftMs: firstTokenTs ? firstTokenTs - requestStartTs : m.ttftMs,
              llmMs: nowTs - requestStartTs,
            }));
            continue;
          }
          if (firstTokenTs === 0) {
            firstTokenTs = Date.now();
            updateLastAssistant((m) => ({
              ...m,
              ttftMs: firstTokenTs - requestStartTs,
              model: settings.model,
            }));
          }
          if (chunk.type === 'reasoning_api') {
            updateLastAssistant((last) => ({ ...last, reasoningApi: chunk.content }));
            continue;
          }
          if (chunk.type === 'reasoning' && reasoningStartTs === 0) reasoningStartTs = Date.now();
          // 首个正文 chunk 到达 = 思考结束，结算耗时
          const settle = chunk.type === 'content' && reasoningStartTs > 0 && !reasoningSettled;
          if (settle) reasoningSettled = true;
          if (structuredGen) {
            if (chunk.type === 'content') {
              if (promptCfg) promptRaw += chunk.delta;
              else if (knowledgeGenCfg) knowledgeGenRaw += chunk.delta;
              else caseRaw += chunk.delta;
            }
            const elapsed = Math.max(0, Math.floor((Date.now() - requestStartTs) / 1000));
            const progress = structuredProgress(elapsed);
            if (chunk.type === 'reasoning') {
              reasoningRaw += chunk.delta;
              const safeReasoning = sanitizeAssistantContent(reasoningRaw);
              updateLastAssistant((last) => {
                const nextMsg = {
                  ...last,
                  reasoning: safeReasoning,
                  content: progress,
                };
                if (settle) {
                  nextMsg.reasoningDuration = Math.max(
                    1,
                    Math.round((Date.now() - reasoningStartTs) / 1000),
                  );
                }
                return nextMsg;
              });
            } else if (settle) {
              updateLastAssistant((last) => ({
                ...last,
                content: progress,
                reasoningDuration: Math.max(1, Math.round((Date.now() - reasoningStartTs) / 1000)),
              }));
            }
            continue;
          }
          if (chunk.type === 'reasoning') {
            reasoningRaw += chunk.delta;
          }
          updateLastAssistant((last) => {
            const nextMsg: LocalMessage =
              chunk.type === 'reasoning'
                ? { ...last, reasoning: sanitizeAssistantContent(reasoningRaw) }
                : {
                    ...last,
                    content: sanitizeAssistantContent(last.content + chunk.delta),
                  };
            if (chunk.type === 'reasoning') {
              const steps = [...(nextMsg.activitySteps ?? [])];
              const thinkIdx = steps.findIndex((s) => s.kind === 'thinking');
              const detail = latestParagraphFirstLine(nextMsg.reasoning ?? '')
                .replaceAll('**', '')
                .slice(0, 80);
              const thinkStep: ActivityStep = {
                id: 'thinking',
                kind: 'thinking',
                title: '思考',
                detail: detail || undefined,
                status: 'running',
              };
              if (thinkIdx >= 0) steps[thinkIdx] = { ...steps[thinkIdx], ...thinkStep };
              else steps.unshift(thinkStep);
              nextMsg.activitySteps = steps;
            }
            if (settle) {
              nextMsg.reasoningDuration = Math.max(
                1,
                Math.round((Date.now() - reasoningStartTs) / 1000),
              );
              const steps = [...(nextMsg.activitySteps ?? [])];
              const thinkIdx = steps.findIndex((s) => s.kind === 'thinking');
              if (thinkIdx >= 0) steps[thinkIdx] = { ...steps[thinkIdx], status: 'done' };
              nextMsg.activitySteps = steps;
            }
            return nextMsg;
          });
        }
        turnOk = true;
        // 防空回合：只有思考/工具过程、没有正文时给出明确原因，
        // 否则界面看起来像「自动终止」（工具轮次用尽、输出被截断、连接被掐）
        if (!structuredGen) {
          // messages 在 SessionStore 里是 unknown[]（结构由 LocalMessage 序列化而来），
          // 这里只关心 role / content 两个字段，收窄后再判断
          const msgs = (storeRef.current?.sessions.find((x) => x.id === sid)?.messages ??
            []) as Array<{ role?: string; content?: unknown }>;
          const lastA = [...msgs].reverse().find((m) => m.role === 'assistant');
          if (lastA && typeof lastA.content === 'string' && !lastA.content.trim()) {
            setError('模型本轮没有返回正文（可能工具轮次用尽或输出被截断），请重试或回复「继续」');
          }
        }
        // 流结束：结算思考耗时，并把 thinking 步骤标为 done
        {
          const duration =
            reasoningStartTs > 0 && !reasoningSettled
              ? Math.max(1, Math.round((Date.now() - reasoningStartTs) / 1000))
              : null;
          updateLastAssistant((m) => {
            const steps = (m.activitySteps ?? []).map((s) =>
              s.kind === 'thinking' && s.status === 'running'
                ? { ...s, status: 'done' as const }
                : s,
            );
            const next: LocalMessage = { ...m, activitySteps: steps };
            if (duration != null && m.reasoning && m.reasoningDuration == null) {
              next.reasoningDuration = duration;
            }
            return next;
          });
        }
        if (progressTimer != null) {
          window.clearInterval(progressTimer);
          progressTimer = undefined;
        }
        if (promptCfg) {
          setToolHint('正在质检并入库…');
          const finished = await tryFinishPromptGenFromAssistant(promptRaw, promptCfg);
          updateLastAssistant((m) => ({
            ...m,
            content: finished.summary,
            docsFile: finished.ok
              ? {
                  root: 'prompts',
                  path: finished.path,
                  name: finished.path.split('/').pop() || finished.title || finished.path,
                }
              : undefined,
          }));
          if (finished.ok && storeRef.current) {
            const nextCfg: PromptGenPluginConfig = {
              ...promptCfg,
              linkedPromptPath: finished.path,
            };
            setPromptGenConfig(nextCfg);
            promptGenConfigRef.current = nextCfg;
            commitStore(updateActiveSessionMeta(storeRef.current, { promptGen: nextCfg }));
          }
        } else if (knowledgeGenCfg) {
          setToolHint('正在质检并入库…');
          const finished = await tryFinishKnowledgeGenFromAssistant(
            knowledgeGenRaw,
            knowledgeGenCfg,
          );
          updateLastAssistant((m) => ({
            ...m,
            content: finished.summary,
            docsFile: finished.ok
              ? {
                  root: 'knowledge',
                  path: finished.path,
                  name: finished.path.split('/').pop() || finished.title || finished.path,
                  note: finished.category,
                }
              : undefined,
          }));
          if (finished.ok && storeRef.current) {
            const nextCfg: KnowledgeGenPluginConfig = {
              ...knowledgeGenCfg,
              linkedKnowledgePath: finished.path,
            };
            setKnowledgeGenConfig(nextCfg);
            knowledgeGenConfigRef.current = nextCfg;
            commitStore(updateActiveSessionMeta(storeRef.current, { knowledgeGen: nextCfg }));
          }
        } else if (caseCfg) {
          setToolHint('正在检测覆盖并入库…');
          const hint =
            caseCfg.reqPath
              ?.split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '') || content.slice(0, 24);
          const finished = await tryFinishCaseGenFromAssistant(caseRaw, caseCfg, hint);
          updateLastAssistant((m) => ({
            ...m,
            content: finished.summary,
            caseFile: finished.ok
              ? {
                  path: finished.path,
                  name: finished.path.split('/').pop() || finished.path,
                  count: finished.count,
                }
              : undefined,
          }));
          if (finished.ok && storeRef.current) {
            const nextCfg: CaseGenPluginConfig = {
              ...caseCfg,
              linkedCasePath: finished.path,
            };
            setCaseGenConfig(nextCfg);
            caseGenConfigRef.current = nextCfg;
            commitStore(updateActiveSessionMeta(storeRef.current, { caseGen: nextCfg }));
          }
        }
      } // end browser stream path
      if (usedServerRun && turnOk) {
        updateLastAssistant((m) => ({
          ...m,
          turnStatus: m.turnStatus === 'stopped' ? 'stopped' : 'completed',
          activitySteps: (m.activitySteps ?? []).map((s) =>
            s.status === 'running' ? { ...s, status: 'done' as const } : s,
          ),
        }));
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        if (storeRef.current?.activeId === sid) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
      // 移除未产生内容的空 assistant 消息；否则结算未完成步骤
      applySessionMessages(sid, (prev) => {
        const last = prev[prev.length - 1];
        if (
          last?.role === 'assistant' &&
          !last.content &&
          !last.reasoning &&
          !last.activitySteps?.length
        ) {
          return prev.slice(0, -1);
        }
        if (last?.role !== 'assistant') return prev;
        const copy = prev.slice();
        copy[copy.length - 1] = {
          ...last,
          activitySteps: (last.activitySteps ?? []).map((s) =>
            s.status === 'running' ? { ...s, status: 'done' as const } : s,
          ),
        };
        return copy;
      });
    } finally {
      if (progressTimer != null) {
        window.clearInterval(progressTimer);
        progressTimer = undefined;
      }
      const nowTs = Date.now();
      const timing = turnTimingRef.current.get(sid);
      const resolvedFirst = firstTokenTs || timing?.firstToken || 0;
      updateLastAssistant((m) => {
        const llmMs = m.llmMs ?? nowTs - requestStartTs;
        const ttftMs = m.ttftMs ?? (resolvedFirst ? resolvedFirst - requestStartTs : undefined);
        const decodeSecs = ttftMs != null ? Math.max(0, (llmMs - ttftMs) / 1000) : 0;
        const outTok = completionTokensOf(m.usage);
        const tps = m.tps ?? (decodeSecs > 0.2 && outTok > 0 ? outTok / decodeSecs : undefined);
        return {
          ...m,
          time: nowTs,
          model: m.model ?? settings.model,
          llmMs,
          ttftMs,
          tps,
          turnStatus:
            m.turnStatus === 'stopped' || m.turnStatus === 'completed'
              ? m.turnStatus
              : turnOk
                ? 'completed'
                : // 服务端回合：仅手动 abort 才标 stopped；SSE 抖动不应误杀
                  ctrl.signal.aborted || !usedServerRun
                  ? m.turnStatus === 'running'
                    ? 'stopped'
                    : m.turnStatus
                  : m.turnStatus,
          activitySteps: (m.activitySteps ?? []).map((s) =>
            s.status === 'running' ? { ...s, status: 'done' as const } : s,
          ),
        };
      });
      turnTimingRef.current.delete(sid);
      liveRunsRef.current.delete(sid);
      sseUnsubRef.current.get(sid)?.();
      sseUnsubRef.current.delete(sid);
      if (runSessionIdRef.current === sid) runSessionIdRef.current = null;
      if (abortRef.current === ctrl) abortRef.current = null;
      setSessionBusy(sid, false);
      {
        const detail = loadGeneralPrefs().toolStepDetail;
        // concise/standard：立即清；detailed 稍留；full 多留一会便于阅读
        if (detail === 'full') {
          window.setTimeout(() => setToolHint(null), 2800);
        } else if (detail === 'detailed') {
          window.setTimeout(() => setToolHint(null), 1200);
        } else {
          setToolHint(null);
        }
      }
      // 后台沉淀（不阻塞下一轮）；明确「记住」类话术才写入
      // 服务端回合也可能 memory_suggest，结束后统一刷新待确认角标
      if (turnOk && useMemory) {
        void maybeCaptureMemory(content, memCwd).finally(() => {
          refreshPluginRuntime();
        });
      }

      // session-log-deepseek：本机追加回合 JSONL（含 reasoning_content；失败静默）
      if (turnOk && storeRef.current) {
        const sessMsgs =
          (storeRef.current.sessions.find((x) => x.id === sid)?.messages as LocalMessage[]) ?? [];
        const lastA = [...sessMsgs].reverse().find((m) => m.role === 'assistant');
        const logMsgs = buildDeepseekTurnMessages({
          userContent: content,
          assistantContent: typeof lastA?.content === 'string' ? lastA.content : '',
          reasoning: lastA?.reasoning,
        });
        if (logMsgs.length) {
          void appendDeepseekSessionLogClient({
            sessionId: sid,
            model: lastA?.model ?? settings.model,
            messages: logMsgs,
          });
        }
      }

      // session-title-llm：首轮结束后用 LLM 起短标题（失败静默）
      if (turnOk && settings && !ctrl.signal.aborted && storeRef.current) {
        const sess = storeRef.current.sessions.find((x) => x.id === sid);
        const msgs = (sess?.messages as Array<{ role?: string; content?: unknown }>) ?? [];
        if (
          sess &&
          !llmTitledSessionIdsRef.current.has(sid) &&
          shouldGenerateLlmTitle(sess.title, msgs)
        ) {
          const userText = firstUserText(msgs);
          if (userText) {
            llmTitledSessionIdsRef.current.add(sid);
            void generateSessionTitleLlm(settings, userText).then((title) => {
              if (!title || !storeRef.current) return;
              const cur = storeRef.current.sessions.find((x) => x.id === sid);
              if (
                !cur ||
                !shouldGenerateLlmTitle(
                  cur.title,
                  cur.messages as Array<{ role?: string; content?: unknown }>,
                )
              ) {
                return;
              }
              commitStore(renameSession(storeRef.current, sid, title));
            });
          }
        }
      }

      // dsh：当前轮结束后自主取下一条（仅仍停留在本会话时续发，避免串到其他会话）
      const stillOnRunSession = storeRef.current?.activeId === sid;
      let followUp: PendingSend | null = null;
      if (stillOnRunSession) {
        followUp = interruptPayloadRef.current;
        interruptPayloadRef.current = null;
        if (!followUp && sendQueueRef.current.length) {
          followUp = sendQueueRef.current[0];
          syncSendQueue(sendQueueRef.current.slice(1));
        }
        const goalText = activeGoalText(sessionGoalRef.current);
        if (
          !followUp &&
          !structuredPlugin &&
          shouldDriveGoalRound({
            goalActive: Boolean(goalText),
            turnOk,
            aborted: ctrl.signal.aborted,
            hasFollowUp: false,
            askUserPending: Boolean(askUserWaitRef.current),
            roundsUsed: goalDriverRoundsRef.current,
            maxRounds: DEFAULT_GOAL_DRIVER_MAX_ROUNDS,
          })
        ) {
          const nextRound = goalDriverRoundsRef.current + 1;
          goalDriverRoundsRef.current = nextRound;
          followUp = {
            id: `goal_drv_${Date.now().toString(36)}`,
            content: goalDriverContinueText(goalText!, nextRound, DEFAULT_GOAL_DRIVER_MAX_ROUNDS),
            files: [],
            refs: [],
            imgs: [],
          };
        }
      }
      if (followUp) {
        window.setTimeout(() => {
          void executeSend(followUp!);
        }, 0);
      }
    }
  }

  function stop() {
    // 手动停止：清空插话与排队，不自动续发
    interruptPayloadRef.current = null;
    syncSendQueue([]);
    goalDriverRoundsRef.current = 0;
    const sid = storeRef.current?.activeId;
    if (sid) {
      applySessionMessages(sid, (prev) => {
        const last = prev[prev.length - 1];
        if (last?.role !== 'assistant') return prev;
        const copy = prev.slice();
        copy[copy.length - 1] = {
          ...last,
          turnStatus: 'stopped',
          activitySteps: (last.activitySteps ?? []).map((s) =>
            s.status === 'running' ? { ...s, status: 'done' as const } : s,
          ),
        };
        return copy;
      });
    }
    abortSessionRun(sid);
  }

  function removeQueued(id: string) {
    syncSendQueue(sendQueueRef.current.filter((q) => q.id !== id));
  }

  function editQueued(id: string) {
    const item = sendQueueRef.current.find((q) => q.id === id);
    if (!item) return;
    removeQueued(id);
    setInput(item.content);
    setAttachments(item.files);
    setImages(item.imgs);
    setDocRefs(item.refs);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  /** 插话：打断当前轮，优先发送该条，其余排队仍会在结束后自主续发 */
  function promoteQueued(id: string) {
    const item = sendQueueRef.current.find((q) => q.id === id);
    if (!item) return;
    syncSendQueue(sendQueueRef.current.filter((q) => q.id !== id));
    if (!streamingRef.current) {
      void executeSend(item);
      return;
    }
    interruptPayloadRef.current = item;
    abortSessionRun(storeRef.current?.activeId);
  }

  /** Cmd/Ctrl+Enter：插话发送；其余排队在本轮结束后自主续发 */
  function flushQueueAsInterrupt(extra?: PendingSend) {
    const rest = [...sendQueueRef.current];
    const head = extra ?? rest.shift() ?? null;
    if (!head) return;
    syncSendQueue(rest);
    if (!streamingRef.current) {
      void executeSend(head);
      return;
    }
    interruptPayloadRef.current = head;
    abortSessionRun(storeRef.current?.activeId);
  }

  function toggleReasoning(index: number, e: ReactMouseEvent<HTMLButtonElement>) {
    const willOpen = !(messages[index]?.reasoningOpen ?? false);
    setMessages((prev) =>
      prev.map((m, i) => (i === index ? { ...m, reasoningOpen: !m.reasoningOpen } : m)),
    );
    if (willOpen) {
      const btn = e.currentTarget;
      requestAnimationFrame(() => {
        const body = btn.nextElementSibling;
        (body ?? btn).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }

  function saveComposerDraft(sessionId: string | undefined) {
    if (!sessionId) return;
    const hasContent =
      Boolean(input.trim()) || attachments.length > 0 || images.length > 0 || docRefs.length > 0;
    if (hasContent) {
      composerDraftsRef.current[sessionId] = {
        input,
        attachments,
        images,
        docRefs,
      };
    } else {
      delete composerDraftsRef.current[sessionId];
    }
  }

  function restoreComposerDraft(sessionId: string | undefined) {
    const d = sessionId ? composerDraftsRef.current[sessionId] : undefined;
    setInput(d?.input ?? '');
    setAttachments(d?.attachments ?? []);
    setImages(d?.images ?? []);
    setDocRefs(d?.docRefs ?? []);
  }

  function resetComposer(opts?: { clearDraft?: boolean; abortRun?: boolean }) {
    if (opts?.abortRun !== false) {
      abortSessionRun(storeRef.current?.activeId);
    }
    streamingRef.current = false;
    setStreaming(false);
    setAttachments([]);
    setImages([]);
    setDocRefs([]);
    setInput('');
    setError(null);
    setShowJump(false);
    followRef.current = true;
    if (opts?.clearDraft && storeRef.current?.activeId) {
      delete composerDraftsRef.current[storeRef.current.activeId];
    }
  }

  /** 确认启用插件：空会话则复用并挂配置，否则新建；标题保持「新对话」，首次发送后再更新 */
  function beginPluginSession(
    kind: 'caseGen' | 'promptGen' | 'knowledgeGen',
    cfg: CaseGenPluginConfig | PromptGenPluginConfig | KnowledgeGenPluginConfig,
  ) {
    if (!storeRef.current) return;
    setChatTab('dialog');
    const leavingId = storeRef.current.activeId;
    const leaving = storeRef.current.sessions.find((x) => x.id === leavingId);
    const reuseEmpty =
      Boolean(leaving) &&
      !leaving!.archived &&
      !leaving!.deleted &&
      (!Array.isArray(leaving!.messages) || leaving!.messages.length === 0);

    const patchSession = (s: ChatSession): ChatSession => ({
      ...s,
      // 确认后仍显示「新对话」；有消息提交时由 updateSessionMessages / LLM 起名
      title: s.title?.trim() || '新对话',
      caseGen: kind === 'caseGen' ? (cfg as CaseGenPluginConfig) : undefined,
      promptGen: kind === 'promptGen' ? (cfg as PromptGenPluginConfig) : undefined,
      knowledgeGen: kind === 'knowledgeGen' ? (cfg as KnowledgeGenPluginConfig) : undefined,
      updatedAt: Date.now(),
    });

    let next: SessionStore;
    if (reuseEmpty && leavingId) {
      resetComposer({ clearDraft: true, abortRun: false });
      next = {
        ...storeRef.current,
        activeId: leavingId,
        sessions: storeRef.current.sessions.map((s) => (s.id === leavingId ? patchSession(s) : s)),
      };
    } else {
      saveComposerDraft(leavingId);
      resetComposer({ clearDraft: true, abortRun: false });
      const base = pruneEphemeralSession(leavingId) ?? storeRef.current;
      const ws = workspaceInfo?.workspace?.trim() || undefined;
      next = createSession(base, { workspacePath: ws, access: loadAccessLevel() });
      const activeId = next.activeId;
      next = {
        ...next,
        sessions: next.sessions.map((s) => (s.id === activeId ? patchSession(s) : s)),
      };
    }
    commitStore(next);
    setMessages([]);
    setCaseGenConfig(kind === 'caseGen' ? (cfg as CaseGenPluginConfig) : null);
    caseGenConfigRef.current = kind === 'caseGen' ? (cfg as CaseGenPluginConfig) : null;
    setPromptGenConfig(kind === 'promptGen' ? (cfg as PromptGenPluginConfig) : null);
    promptGenConfigRef.current = kind === 'promptGen' ? (cfg as PromptGenPluginConfig) : null;
    setKnowledgeGenConfig(kind === 'knowledgeGen' ? (cfg as KnowledgeGenPluginConfig) : null);
    knowledgeGenConfigRef.current =
      kind === 'knowledgeGen' ? (cfg as KnowledgeGenPluginConfig) : null;
    const expandPath =
      next.sessions.find((x) => x.id === next.activeId)?.workspacePath ||
      workspaceInfo?.workspace?.trim() ||
      workspaceInfo?.projectRoot;
    if (expandPath) setWsExpanded((prev) => ({ ...prev, [expandPath]: true }));
    void syncFsWorkspaceForSession(next.sessions.find((x) => x.id === next.activeId));
  }

  /**
   * 插件开发胶囊：首条消息即需求。
   * 就地进入插件开发（不动当前会话），并把会话落到 harness 源码根（仓库根 / 安装包根）、读写权限。
   */
  async function enterPluginDevMode(requirement: string) {
    const cur = storeRef.current;
    if (!cur) return;
    const active = cur.sessions.find((x) => x.id === cur.activeId);
    // 插件开发要改的是 harness 源码（仓库根 / 安装包根），不是空间目录；
    // 服务端为包根单独放行，其它上级目录仍不能当工作区
    const devWorkspace =
      workspaceInfoRef.current?.harnessRoot?.trim() ||
      workspaceInfoRef.current?.projectRoot?.trim() ||
      workspaceInfoRef.current?.workspace?.trim();
    const cfg: PluginDevPluginConfig = active?.pluginDev?.active
      ? active.pluginDev
      : { active: true, requirement: requirement.trim(), confirmedAt: Date.now() };

    // 就在当前会话里进入插件开发：不再自动新开会话。
    // 之前「已有消息就 fork 一个干净会话」会让用户在旧会话里补一句话就被换到新会话，
    // 容易误以为输入丢失、还会堆出一串重复会话。
    commitStore(
      updateActiveSessionMeta(cur, {
        pluginDev: cfg,
        // 插件开发至少可写；用户原本选的是「完全权限」就保留
        access: access === 'full' ? 'full' : 'readwrite',
        ...(devWorkspace ? { workspacePath: devWorkspace } : {}),
      }),
    );
    setPluginDevConfig(cfg);
    pluginDevConfigRef.current = cfg;
    // 已经开始开发：这个会话就是要可写，之后取消胶囊不再还原权限
    pluginDevPrevAccessRef.current = null;
    // 计划模式会剥夺写权限，与插件开发冲突
    settlePlanCanceled();
    setPlanPhase('off');
    if (devWorkspace) setWsExpanded((prev) => ({ ...prev, [devWorkspace]: true }));
    // fs 中间件按「当前工作区」解析路径：开发要读写项目根
    if (fsLive && devWorkspace && workspaceInfoRef.current?.workspace !== devWorkspace) {
      try {
        syncWorkspaceInfo(await selectWorkspace(devWorkspace));
      } catch {
        // 切不过去就让模型用当前工作区，不阻塞开发
      }
    }
  }

  function applyCaseGenConfig(cfg: CaseGenPluginConfig | null) {
    if (cfg?.active) {
      beginPluginSession('caseGen', cfg);
      return;
    }
    setCaseGenConfig(null);
    caseGenConfigRef.current = null;
    if (!storeRef.current) return;
    commitStore(updateActiveSessionMeta(storeRef.current, { caseGen: undefined }));
  }

  function applyPromptGenConfig(cfg: PromptGenPluginConfig | null) {
    if (cfg?.active) {
      beginPluginSession('promptGen', cfg);
      return;
    }
    setPromptGenConfig(null);
    promptGenConfigRef.current = null;
    if (!storeRef.current) return;
    commitStore(updateActiveSessionMeta(storeRef.current, { promptGen: undefined }));
  }

  function applyKnowledgeGenConfig(cfg: KnowledgeGenPluginConfig | null) {
    if (cfg?.active) {
      beginPluginSession('knowledgeGen', cfg);
      return;
    }
    setKnowledgeGenConfig(null);
    knowledgeGenConfigRef.current = null;
    if (!storeRef.current) return;
    commitStore(updateActiveSessionMeta(storeRef.current, { knowledgeGen: undefined }));
  }

  function newSession(workspacePath?: string) {
    setPluginsOpen(false);
    if (!storeRef.current) return;
    setChatTab('dialog');
    const leavingId = storeRef.current.activeId;
    saveComposerDraft(leavingId);
    // 新建会话不打断旧会话后台生成
    resetComposer({ clearDraft: true, abortRun: false });
    const base = pruneEphemeralSession(leavingId) ?? storeRef.current;
    // dsh：新会话归入「当前工作区」（显式传入 path 优先，否则用 picker 选中项）
    const ws = workspacePath?.trim() || workspaceInfo?.workspace?.trim() || undefined;
    const next = createSession(base, { workspacePath: ws, access: loadAccessLevel() });
    commitStore(next);
    setMessages([]);
    setCaseGenConfig(null);
    setPromptGenConfig(null);
    setKnowledgeGenConfig(null);
    setPluginDevConfig(null);
    pluginDevConfigRef.current = null;
    setSessionTodos([]);
    sessionGoalRef.current = null;
    setSessionGoal(null);
    goalDriverRoundsRef.current = 0;
    setPlanPhase('off');
    setComposerChip((cur) => (cur === 'pluginDev' ? null : cur));
    settleAskUserCanceled();
    settlePlanCanceled();
    const expandPath = ws || workspaceInfo?.projectRoot;
    if (expandPath) setWsExpanded((prev) => ({ ...prev, [expandPath]: true }));
    void syncFsWorkspaceForSession(next.sessions.find((x) => x.id === next.activeId));
  }

  function settleAskUserCanceled() {
    const wait = askUserWaitRef.current;
    if (!wait) return;
    askUserWaitRef.current = null;
    setAskUserPrompt(null);
    setAskUserDraft({});
    setAskUserStep(0);
    setAskUserMinimized(false);
    setAskUserFeedback(null);
    setAskSkipConfirm(false);
    setAskSkipReason('');
    wait.resolve(JSON.stringify({ canceled: true, error: 'user aborted' }));
  }

  function settlePlanCanceled() {
    const wait = planWaitRef.current;
    if (!wait) return;
    planWaitRef.current = null;
    setPlanProposal(null);
    wait.resolve(JSON.stringify({ approved: false, canceled: true }));
  }

  function approvePlan() {
    const wait = planWaitRef.current;
    if (!wait) return;
    planWaitRef.current = null;
    setPlanProposal(null);
    setPlanPhase('approved');
    wait.resolve(JSON.stringify({ approved: true, message: '用户已批准计划，可以开始实施' }));
  }

  function rejectPlan() {
    const wait = planWaitRef.current;
    if (!wait) return;
    planWaitRef.current = null;
    setPlanProposal(null);
    setPlanPhase('planning');
    wait.resolve(
      JSON.stringify({ approved: false, message: '用户驳回了计划，请修订后再次 submit_plan' }),
    );
  }

  function togglePlanMode() {
    setPlanPhase((cur) => {
      if (cur === 'off') {
        setComposerChip('plan');
        return 'planning';
      }
      settlePlanCanceled();
      setComposerChip((chip) => (chip === 'plan' ? null : chip));
      return 'off';
    });
  }

  /** 当前这步是否已作答（跳过算已处理；选择题看选中项或手写回答） */
  function askDraftAnswered(
    q: AskUserQuestion | undefined,
    draft: AskUserDraft | undefined,
  ): boolean {
    if (!q || !draft) return false;
    if (draft.skipped) return true;
    if (draft.text.trim() !== '') return true;
    return q.options?.length ? draft.selected.length > 0 : false;
  }

  /**
   * 收尾：清卡片状态并回传答案。
   * 只要有题被跳过，就明确告诉模型「这不等于批准实施」，避免它跳过当轮就直接改文件。
   */
  function finishAskUser(
    questions: AskUserQuestion[],
    answers: AskUserAnswer[],
    extra?: Record<string, unknown>,
  ) {
    const wait = askUserWaitRef.current;
    if (!wait) return;
    askUserWaitRef.current = null;
    setAskUserPrompt(null);
    setAskUserDraft({});
    setAskUserStep(0);
    setAskUserMinimized(false);
    setAskUserFeedback(null);
    setAskSkipConfirm(false);
    setAskSkipReason('');
    setError(null);
    const skippedCount = answers.filter((a) => a.skipped).length;
    const skipReason = String(extra?.skipReason ?? '').trim();
    wait.resolve(
      JSON.stringify({
        answers,
        summary: formatAskAnswersText(questions, answers),
        ...(skippedCount
          ? {
              skipped: true,
              approvalRequired: true,
              ...(skipReason ? { skipReason } : {}),
              note:
                '用户跳过了部分或全部问题：跳过的题不算确认，也未批准实施。' +
                (skipReason ? `用户给出的跳过原因：${skipReason}。` : '') +
                '本轮只允许只读调研与文字方案，禁止 fs_write / fs_mkdir / 改配置；' +
                '请先说明采用的默认假设（哪几项按推荐）与准备改动的范围' +
                (skipReason ? '，并针对上述原因给出调整' : '') +
                '，然后等用户明确回复「开始实施」再动手。',
            }
          : {
              note: 'answers 为结构化答案；summary 是同一批答案的中文文本版本，可直接据此继续，无需再次提问。',
            }),
        ...extra,
      }),
    );
  }

  /** 点击选项：单选选中后自动进入下一步，多选停留在本步 */
  function chooseAskOption(q: AskUserQuestion, label: string, checked: boolean) {
    setAskUserDraft((prev) => {
      const cur = prev[q.id] ?? { selected: [], text: '' };
      const selected = q.multi_select
        ? checked
          ? cur.selected.filter((x) => x !== label)
          : [...cur.selected, label]
        : [label];
      return { ...prev, [q.id]: { selected, text: '', skipped: false } };
    });
    setAskUserFeedback(null);
    if (!q.multi_select) {
      setAskUserStep((step) => Math.min(step + 1, (askUserPrompt?.length ?? 1) - 1));
    }
  }

  /** 切换步骤：范围由题数决定，切步时清掉上一步的即时提示 */
  function goAskStep(next: number) {
    const count = askUserPrompt?.length ?? 0;
    if (!count) return;
    setAskUserStep(Math.max(0, Math.min(next, count - 1)));
    setAskUserFeedback(null);
  }

  /** 手写输入：写到草稿里；多选保留已勾选项，单选以文本为准 */
  function updateAskText(q: AskUserQuestion | undefined, text: string) {
    if (!q) return;
    setAskUserDraft((prev) => {
      const cur = prev[q.id] ?? { selected: [], text: '' };
      return {
        ...prev,
        [q.id]: { selected: q.multi_select ? cur.selected : [], text, skipped: false },
      };
    });
    setAskUserFeedback(null);
  }

  /**
   * 文本行回车：纯序号按点选处理，其它当自由回答。
   * 单步确认后前进；最后一题直接提交，不用再点按钮。
   */
  function applyAskTextChoice(q: AskUserQuestion, raw: string) {
    const value = raw.trim();
    const picked = value && q.options?.length ? parseAskSelection(q, value) : null;
    const draft = picked
      ? { selected: picked, text: '', skipped: false }
      : {
          selected: q.multi_select ? (askUserDraft[q.id]?.selected ?? []) : [],
          text: value,
          skipped: false,
        };
    const nextDraft = { ...askUserDraft, [q.id]: draft };
    setAskUserDraft(nextDraft);
    setAskUserFeedback(null);
    if (askLastStep) submitAskUserAnswers(nextDraft);
    else goAskStep(askStepIndex + 1);
  }

  /** 把草稿批成答案；已答的保留，未答的按 skipped 处理 */
  function buildAskAnswers(drafts: Record<string, AskUserDraft>): AskUserAnswer[] {
    return (askUserPrompt ?? []).map((q) => {
      const a = resolveAskAnswer(q, drafts[q.id] ?? { selected: [], text: '' });
      const answered = Boolean(a.skipped || a.text?.trim() || a.selected?.length);
      return answered ? a : { id: q.id, selected: [], skipped: true };
    });
  }

  function submitAskUserAnswers(
    drafts: Record<string, AskUserDraft> = askUserDraft,
    confirmedSkip = false,
  ): boolean {
    const questions = askUserPrompt;
    if (!questions?.length || !askUserWaitRef.current) return false;
    const answers = buildAskAnswers(drafts);
    const missing = answers.findIndex((a) => !a.skipped && !a.text?.trim() && !a.selected?.length);
    if (missing >= 0) {
      // 跳回第一道没答的题，提示留在卡片里，不弹全局错误条
      goAskStep(missing);
      setAskUserFeedback(
        questions[missing]?.options?.length ? '请先选择选项再提交' : '请先填写回答再提交',
      );
      return false;
    }
    // 有跳过就先停一下：让用户说明原因，避免模型盲目按默认执行
    if (!confirmedSkip && answers.some((a) => a.skipped)) {
      setAskSkipConfirm(true);
      setAskUserFeedback(null);
      return false;
    }
    const reason = askSkipReason.trim();
    finishAskUser(questions, answers, reason ? { skipReason: reason } : undefined);
    return true;
  }

  /** 跳过当前这题：记一个 skipped 占位后前进；最后一题则进入提交（含跳过会先确认原因） */
  function skipAskStep() {
    const questions = askUserPrompt;
    const q = askStepQuestion;
    if (!questions?.length || !q) return;
    const nextDraft = { ...askUserDraft, [q.id]: { selected: [], text: '', skipped: true } };
    setAskUserDraft(nextDraft);
    setAskUserFeedback(null);
    if (askLastStep) submitAskUserAnswers(nextDraft);
    else goAskStep(askStepIndex + 1);
  }

  /** 确认跳过：带原因回传，仍然只让模型出方案、不实施 */
  function confirmSkipSubmit() {
    submitAskUserAnswers(askUserDraft, true);
  }

  /** 从跳过确认退回答题：定位到第一道被跳过的题 */
  function backToAnswering() {
    setAskSkipConfirm(false);
    const answers = buildAskAnswers(askUserDraft);
    const skippedIndex = answers.findIndex((a) => a.skipped);
    goAskStep(skippedIndex >= 0 ? skippedIndex : 0);
  }

  function openSession(id: string) {
    setPluginsOpen(false);
    if (!storeRef.current) return;
    setChatTab('dialog');
    setSessionMenuId(null);
    if (id === storeRef.current.activeId) return;
    const leavingId = storeRef.current.activeId;
    saveComposerDraft(leavingId);
    // 切会话不中断后台回合（与 dsh 一致）；仅取消当前会话的人工等待
    settleAskUserCanceled();
    settlePlanCanceled();
    setPlanPhase('off');
    setError(null);
    setShowJump(false);
    followRef.current = true;
    let base = pruneEphemeralSession(leavingId) ?? storeRef.current;
    // 若丢掉的正是目标 id（不应发生），回退
    if (!base.sessions.some((x) => x.id === id)) base = storeRef.current;
    const next = switchSession(base, id);
    const s = next.sessions.find((x) => x.id === id);
    const live = liveRunsRef.current.get(id)?.messages;
    const msgs = live ?? (s?.messages as LocalMessage[]) ?? [];
    messagesRef.current = msgs;
    setMessages(msgs);
    const busy = liveRunsRef.current.has(id) || busySessionIds.includes(id);
    streamingRef.current = busy;
    setStreaming(busy);
    abortRef.current = liveRunsRef.current.get(id)?.abort ?? null;
    if (busy && !sseUnsubRef.current.has(id)) {
      attachServerRun(id, 0);
    }
    setCaseGenConfig(s?.caseGen?.active ? s.caseGen : null);
    setPromptGenConfig(s?.promptGen?.active ? s.promptGen : null);
    setKnowledgeGenConfig(s?.knowledgeGen?.active ? s.knowledgeGen : null);
    setPluginDevConfig(s?.pluginDev?.active ? s.pluginDev : null);
    // 胶囊跟随会话：插件开发会话保持胶囊，其余会话不残留
    setComposerChip((cur) =>
      s?.pluginDev?.active ? 'pluginDev' : cur === 'pluginDev' ? null : cur,
    );
    setSessionTodos(normalizeTodos(s?.todos));
    {
      const g = normalizeGoal(s?.goal);
      sessionGoalRef.current = g;
      setSessionGoal(g);
      goalDriverRoundsRef.current = 0;
    }
    restoreComposerDraft(id);
    commitStore(next);
    void syncFsWorkspaceForSession(s);
  }

  /** 永久删除会话（仅已归档） */
  function purgeSession(id: string) {
    if (!storeRef.current) return;
    setSessionMenuId(null);
    setWsMenuId(null);
    const wasActive = storeRef.current.activeId === id;
    if (wasActive) resetComposer({ clearDraft: true });
    delete composerDraftsRef.current[id];
    const next = deleteSession(storeRef.current, id);
    commitStore(next);
    void deleteSessionMemory(id);
    if (wasActive) {
      const s = next.sessions.find((x) => x.id === next.activeId);
      setMessages((s?.messages as LocalMessage[]) ?? []);
      setCaseGenConfig(s?.caseGen?.active ? s.caseGen : null);
      setPromptGenConfig(s?.promptGen?.active ? s.promptGen : null);
      setKnowledgeGenConfig(s?.knowledgeGen?.active ? s.knowledgeGen : null);
      setPluginDevConfig(s?.pluginDev?.active ? s.pluginDev : null);
      setComposerChip((cur) =>
        s?.pluginDev?.active ? 'pluginDev' : cur === 'pluginDev' ? null : cur,
      );
    }
  }

  function toggleArchive(id: string, archived: boolean) {
    if (!storeRef.current) return;
    setSessionMenuId(null);
    const wasActive = storeRef.current.activeId === id && archived;
    if (wasActive) resetComposer();
    const next = archiveSession(storeRef.current, id, archived);
    commitStore(next);
    if (wasActive) {
      const s = next.sessions.find((x) => x.id === next.activeId);
      setMessages((s?.messages as LocalMessage[]) ?? []);
    }
  }

  function togglePin(id: string) {
    if (!storeRef.current) return;
    const s = storeRef.current.sessions.find((x) => x.id === id);
    if (!s) return;
    setSessionMenuId(null);
    commitStore(pinSession(storeRef.current, id, !s.pinned));
  }

  function renameSessionTitle(id: string) {
    if (!storeRef.current) return;
    if (!storeRef.current.sessions.some((x) => x.id === id)) return;
    setSessionMenuId(null);
    setWsMenuId(null);
    setRenameSessionId(id);
  }

  function showActiveSessionStats() {
    const sid = storeRef.current?.activeId;
    const s = storeRef.current?.sessions.find((x) => x.id === sid);
    if (!s) {
      setError('无活跃会话可统计');
      return;
    }
    const text = getCachedProjection('stats', s.id, s.updatedAt, () =>
      formatSessionStats(computeSessionStats(s)),
    );
    setError(text, 'ok');
  }

  function confirmRenameSession(name: string) {
    if (!storeRef.current || !renameSessionId) return;
    llmTitledSessionIdsRef.current.add(renameSessionId);
    commitStore(renameSession(storeRef.current, renameSessionId, name));
    setRenameSessionId(null);
  }

  function toggleRail() {
    setRailOpen((v) => {
      saveRailOpen(!v);
      return !v;
    });
  }

  /** 「添加文件」：文本 / Excel / Word 转正文附件，图片走多模态 */
  async function onPickFiles(e: ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    e.target.value = '';
    await ingestLocalFiles(list);
  }

  function pasteDocCatalog(): PasteCatalogEntry[] {
    const fromSlash: PasteCatalogEntry[] = slashDocs.map((d) => ({
      collection: d.collection,
      path: d.path,
      title: d.title,
      category: d.category,
      format: String(d.format),
    }));
    const fromWs: PasteCatalogEntry[] = wsAtEntries.map((e) => ({
      collection: 'workspace' as const,
      path: e.path,
      title: e.name,
      category: shortWorkspaceLabel(workspaceInfo?.workspace, workspaceInfo?.projectRoot),
      format: e.type === 'dir' ? 'dir' : 'file',
    }));
    return [...fromSlash, ...fromWs];
  }

  function addPasteDocRefs(refs: DocRef[]) {
    if (!refs.length) return;
    setDocRefs((prev) => {
      const next = [...prev];
      for (const r of refs) {
        if (next.length >= REF_MAX_COUNT) break;
        if (next.some((x) => x.collection === r.collection && x.path === r.path)) continue;
        next.push(r);
      }
      return next;
    });
  }

  async function ingestLocalFiles(list: File[], pathByName?: Map<string, string>) {
    const nextAtt: Attachment[] = [];
    const nextImg: ImageAtt[] = [];
    const rejected: string[] = [];
    let used = composerFileCount(attachments, images);
    for (const f of list) {
      if (used >= FILE_MAX_COUNT) {
        rejected.push(`${f.name}（最多 ${FILE_MAX_COUNT} 个文件）`);
        continue;
      }
      try {
        const read = await readLocalAttachFile(f);
        if (read.kind === 'image') {
          nextImg.push(await fileToImageAtt(read.file));
        } else {
          nextAtt.push({
            name: read.name,
            size: read.size,
            content: read.content,
            path: pathByName?.get(f.name) || pathByName?.get(read.name),
          });
        }
        used += 1;
      } catch (err) {
        rejected.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (nextAtt.length) setAttachments((prev) => [...prev, ...nextAtt]);
    if (nextImg.length) setImages((prev) => [...prev, ...nextImg]);
    setError(rejected.length ? `以下文件未添加：${rejected.join('、')}` : null);
    textareaRef.current?.focus();
  }

  /** 粘贴本地文件 / 路径 → 路径胶囊或附件胶囊（避免只出现纯文本文件名） */
  function onComposerPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const cd = e.clipboardData;
    if (!cd) return;

    const items = Array.from(cd.items ?? []);
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f));
    const otherFiles = items
      .filter((it) => it.kind === 'file' && !it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f));
    // DataTransfer.files 有时比 items 更全（Finder 拖贴）
    for (const f of Array.from(cd.files ?? [])) {
      if (f.type.startsWith('image/')) {
        if (!imageFiles.some((x) => x.name === f.name && x.size === f.size)) imageFiles.push(f);
      } else if (!otherFiles.some((x) => x.name === f.name && x.size === f.size)) {
        otherFiles.push(f);
      }
    }

    const clipPaths = extractClipboardFilePaths(cd);
    const plain = (cd.getData('text/plain') || '').trim();
    const catalog = pasteDocCatalog();
    const wsLabel = shortWorkspaceLabel(workspaceInfo?.workspace, workspaceInfo?.projectRoot);
    const pathOpts = {
      projectRoot: workspaceInfo?.projectRoot,
      workspace: workspaceInfo?.workspace,
      workspaceLabel: wsLabel,
    };

    const resolvedRefs: DocRef[] = [];
    const pathByName = new Map<string, string>();
    for (const p of clipPaths) {
      const ref = resolvePathToPasteDocRef(p, pathOpts);
      if (ref) {
        resolvedRefs.push(ref);
        pathByName.set(basenamePath(p), ref.path);
      } else {
        pathByName.set(basenamePath(p), p);
      }
    }

    // Finder 常见：剪贴板只有文件名文本
    let bareNameRef: DocRef | null = null;
    if (
      !imageFiles.length &&
      !otherFiles.length &&
      !clipPaths.length &&
      looksLikeBareFilename(plain)
    ) {
      bareNameRef = resolveNameToPasteDocRef(plain, catalog);
    }

    // 有 File 时优先用文件名在目录中唯一匹配 → 路径胶囊（不读入正文）
    const fileNameRefs: DocRef[] = [];
    const filesAsAttach: File[] = [];
    for (const f of otherFiles) {
      const byPath = pathByName.get(f.name);
      const ref =
        (byPath ? resolvePathToPasteDocRef(byPath, pathOpts) : null) ||
        resolveNameToPasteDocRef(f.name, catalog);
      if (ref) fileNameRefs.push(ref);
      else filesAsAttach.push(f);
    }

    const willChip =
      resolvedRefs.length > 0 ||
      fileNameRefs.length > 0 ||
      Boolean(bareNameRef) ||
      imageFiles.length > 0 ||
      filesAsAttach.length > 0;
    if (!willChip) return;

    e.preventDefault();
    setError(null);
    addPasteDocRefs([...resolvedRefs, ...fileNameRefs, ...(bareNameRef ? [bareNameRef] : [])]);
    if (imageFiles.length) void addImages(imageFiles);
    if (filesAsAttach.length) void ingestLocalFiles(filesAsAttach, pathByName);
    textareaRef.current?.focus();
  }

  /** 代码块「复制」按钮的事件委托（按钮由 renderMarkdown 生成） */
  function onTranscriptClick(e: ReactMouseEvent<HTMLDivElement>) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
    void copyText(code).then((ok) => {
      if (!ok) return;
      btn.textContent = '已复制';
      window.setTimeout(() => {
        btn.textContent = '复制';
      }, 1000);
    });
  }

  const empty = messages.length === 0;
  const canSend = Boolean(
    input.trim() ||
    attachments.length ||
    docRefs.length ||
    images.length ||
    composerChip === 'reports',
  );
  let lastUserIdx = -1;
  let lastAssistantIdx = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUserIdx = i;
    else if (m.role === 'assistant') lastAssistantIdx = i;
  });
  // dsh 规则：最新的用户/助手消息操作行常显，更早的消息悬停时显示
  const revealCls = (i: number) =>
    i === lastUserIdx || i === lastAssistantIdx
      ? ''
      : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity';
  const accessOpt = ACCESS_OPTIONS.find((o) => o.value === access) ?? ACCESS_OPTIONS[0];
  /** 插件开发胶囊激活时：会话必须是可写，菜单里的「仅可查看」不再可选 */
  const pluginDevChipActive = composerChip === 'pluginDev';
  const activeSessions = (store?.sessions ?? []).filter((s) => !s.archived && !s.deleted);
  const archivedSessionsAll = (store?.sessions ?? []).filter((s) => s.archived && !s.deleted);
  const wsItems = workspaceInfo?.items ?? [];
  const wsPaths = new Set(wsItems.map((it) => it.path));
  const wsActivePath = workspaceInfo?.workspace ?? '';
  const projectRootPath = workspaceInfo?.projectRoot ?? '';
  const activeSess = store?.sessions.find((s) => s.id === store.activeId);
  const activeSessWs = activeSess?.workspacePath;
  const activeSessInProjectRoot = !activeSessWs || !wsPaths.has(activeSessWs);
  /** 输入栏 picker：显示 FS 当前工作区（进会话时已对齐归属；手动切换后跟手动值） */
  const composerWsPath = workspaceInfo?.workspace?.trim() || '';
  const composerWsItem = wsItems.find((it) => it.path === composerWsPath);
  const composerWsLabel = composerWsItem
    ? workspaceDisplayName(composerWsItem, projectRootPath)
    : composerWsPath
      ? shortWorkspaceLabel(composerWsPath, projectRootPath)
      : '工作区';
  const qNorm = wsQuery.trim().toLowerCase();
  /** session-query：先本地 JSON，有服务时用 sqlite FTS 覆盖 */
  const localSessionQueryIds = useMemo(() => {
    if (!qNorm) return null;
    return new Set(
      querySessions(store, wsQuery, { limit: 50, includeArchived: true }).map((h) => h.sessionId),
    );
  }, [qNorm, store, wsQuery]);
  const [sqliteSessionQueryIds, setSqliteSessionQueryIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!qNorm) {
      setSqliteSessionQueryIds(null);
      return;
    }
    let cancelled = false;
    setSqliteSessionQueryIds(null);
    void querySessionsViaApi(wsQuery, { limit: 50, includeArchived: true }).then((r) => {
      if (cancelled || !r?.hits) return;
      setSqliteSessionQueryIds(new Set(r.hits.map((h) => h.sessionId)));
    });
    return () => {
      cancelled = true;
    };
  }, [qNorm, wsQuery]);
  const sessionQueryIds = sqliteSessionQueryIds ?? localSessionQueryIds;
  const archivedSessions = sessionQueryIds
    ? archivedSessionsAll.filter((s) => sessionQueryIds.has(s.id))
    : archivedSessionsAll;
  /** 无归属或路径已不在列表中 → 归入项目根工作区（不再有「未分组」） */
  function sessionsForWorkspace(item: WorkspaceItem): ChatSession[] {
    const isProjectRoot = item.id === 'ws_project' || item.path === projectRootPath;
    return sortSessionsInGroup(
      activeSessions
        .filter((s) => {
          if (s.workspacePath === item.path) return true;
          if (isProjectRoot && (!s.workspacePath || !wsPaths.has(s.workspacePath))) return true;
          return false;
        })
        .filter((s) => !sessionQueryIds || sessionQueryIds.has(s.id)),
    );
  }

  const visibleWsItems = wsItems.filter((it) => {
    if (!qNorm) return true;
    if (it.name.toLowerCase().includes(qNorm) || it.path.toLowerCase().includes(qNorm)) {
      return true;
    }
    return sessionsForWorkspace(it).length > 0;
  });

  function SessionRow({ s, nested = false }: { s: ChatSession; nested?: boolean }) {
    const active = s.id === store?.activeId;
    const menuOpen = sessionMenuId === s.id;
    const busy = busySessionIds.includes(s.id);
    return (
      <SessionRailRow
        s={s}
        nested={nested}
        active={active}
        menuOpen={menuOpen}
        busy={busy}
        onOpen={() => openSession(s.id)}
        onRename={() => renameSessionTitle(s.id)}
        onToggleMenu={() => {
          setWsMenuId(null);
          setSessionMenuId(menuOpen ? null : s.id);
        }}
        onTogglePin={() => togglePin(s.id)}
        onToggleArchive={() => toggleArchive(s.id, !s.archived)}
        onExport={() => {
          setSessionMenuId(null);
          const result = exportSessionDownload(s, 'json');
          setError(result.ok ? `已导出 ${result.filename}` : result.error);
        }}
        onRemove={() => {
          // 先关菜单，避免确认框底下仍挂着「…」弹层
          setSessionMenuId(null);
          setWsMenuId(null);
          setPurgeSessionId(s.id);
        }}
      />
    );
  }

  // 提问卡片：一次只渲染一道题，步数与草稿都按当前题取
  const askStepCount = askUserPrompt?.length ?? 0;
  const askStepIndex = Math.max(0, Math.min(askUserStep, askStepCount - 1));
  const askStepQuestion = askUserPrompt?.[askStepIndex];
  const askStepDraft = (askStepQuestion && askUserDraft[askStepQuestion.id]) || {
    selected: [],
    text: '',
  };
  const askLastStep = askStepIndex >= askStepCount - 1;
  const askStepAnswered = askDraftAnswered(askStepQuestion, askStepDraft);
  /** 跳过确认视图里要列出的题（含题号与题干） */
  const askSkippedItems = (askUserPrompt ?? [])
    .map((q, i) => ({ q, index: i }))
    .filter(({ q }) => askUserDraft[q.id]?.skipped);

  return (
    <div className="tw-app h-full min-h-0 flex overflow-hidden bg-(--tw-surface-page)">
      {/* dsh 风格：工作区树 + 会话挂在文件夹下 */}
      <aside
        className={`tw-session-rail shrink-0 border-r border-(--tw-border) flex flex-col transition-[width] ${
          railOpen ? 'w-64' : 'w-10'
        }`}
      >
        <div
          className={`flex items-center gap-1 ${
            railOpen ? 'px-2.5 pt-2.5' : 'px-1 pt-2 justify-center'
          }`}
        >
          {railOpen && (
            <div className="flex-1 min-w-0 text-[13px] font-medium text-stone-700 truncate px-1">
              {t('chat.workbench', undefined, generalPrefs.language)}
            </div>
          )}
          <button
            type="button"
            aria-label={railOpen ? '收起侧栏' : '展开侧栏'}
            onClick={toggleRail}
            className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg text-stone-500 hover:bg-stone-200/70"
          >
            <Svg className="w-4 h-4">
              {railOpen ? (
                <>
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M9 3v18" />
                </>
              ) : (
                <>
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M15 3v18" />
                </>
              )}
            </Svg>
          </button>
        </div>

        {railOpen ? (
          <div className="px-2.5 pt-2 space-y-1.5">
            <button
              type="button"
              onClick={() => newSession()}
              className="w-full h-9 flex items-center justify-center gap-1.5 text-[13px] font-medium text-stone-700 bg-white rounded-full border border-stone-200/80 shadow-sm hover:bg-stone-50 transition-colors"
            >
              <Svg className="w-3.5 h-3.5">
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </Svg>
              {t('chat.newSession', undefined, generalPrefs.language)}
            </button>
            <button
              type="button"
              data-hint="我的插件"
              onClick={() => setPluginsOpen((v) => !v)}
              className={`tw-rail-plugin-btn w-full h-9 flex items-center justify-center gap-1.5 text-[13px] font-medium rounded-full transition-colors ${
                pluginsOpen ? 'is-active' : ''
              }`}
            >
              <PluginIcon className="w-3.5 h-3.5" />
              插件
            </button>
          </div>
        ) : (
          <div className="px-1 pt-1 flex flex-col gap-1">
            <button
              type="button"
              onClick={() => newSession()}
              data-hint="新会话"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-[#4176e6] hover:bg-white/80"
            >
              <Svg className="w-4 h-4">
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </Svg>
            </button>
            <button
              type="button"
              data-hint="我的插件"
              onClick={() => setPluginsOpen((v) => !v)}
              className={`tw-rail-plugin-btn tw-rail-plugin-btn--icon w-8 h-8 flex items-center justify-center rounded-lg ${
                pluginsOpen ? 'is-active' : ''
              }`}
            >
              <PluginIcon className="w-4 h-4" />
            </button>
          </div>
        )}

        {railOpen && (
          <div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
            <div className="flex items-center gap-1 px-1.5 pb-2">
              <div className="flex-1 text-[12px] font-semibold text-stone-500">
                {t('chat.workspace', undefined, generalPrefs.language)}
              </div>
              <button
                type="button"
                aria-label="搜索"
                onClick={() => {
                  setWsSearchOpen((v) => !v);
                  if (wsSearchOpen) setWsQuery('');
                }}
                className="w-6 h-6 flex items-center justify-center rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200/70"
              >
                <SearchIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                data-hint={fsLive ? '添加工作区（选择本地文件夹）' : '本地文件服务未就绪'}
                disabled={!fsLive || wsBusy}
                onClick={() => void addWorkspaceByPicker()}
                className="w-6 h-6 flex items-center justify-center rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200/70 disabled:opacity-40"
              >
                <PlusSquareIcon className="w-3.5 h-3.5" />
              </button>
            </div>

            {wsSearchOpen && (
              <input
                value={wsQuery}
                onChange={(e) => setWsQuery(e.target.value)}
                placeholder="搜索工作区 / 会话标题 / 消息"
                className="w-full mb-2 px-2.5 py-1.5 text-[12px] rounded-lg border border-stone-200 bg-white text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-1 focus:ring-[#4176e6]/40"
              />
            )}

            {fsOffline && (
              <div className="px-1.5 py-2 text-[11px] text-amber-700/80">
                本地文件服务未就绪，工作区暂不可用
              </div>
            )}

            <div className="space-y-0.5">
              {visibleWsItems.map((item) => {
                const kids = sessionsForWorkspace(item);
                const expanded = Boolean(wsExpanded[item.path] ?? kids.length > 0);
                // 仅当「当前聚焦会话」归属本工作区时才显示文件夹聚焦色（非 FS cwd）
                const isProjectRoot = item.id === 'ws_project' || item.path === projectRootPath;
                const isActiveWs = Boolean(
                  activeSess &&
                  (activeSessInProjectRoot ? isProjectRoot : activeSessWs === item.path),
                );
                const menuOpen = wsMenuId === item.id;
                return (
                  <div key={item.id}>
                    <div
                      className={`tw-project-row group relative ${isActiveWs ? 'is-active' : ''} ${
                        expanded ? 'is-expanded' : ''
                      } ${menuOpen ? 'is-menu-open' : ''}`}
                    >
                      <button
                        type="button"
                        data-hint={item.path}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSessionMenuId(null);
                          setWsMenuId(null);
                          setWsExpanded((prev) => ({ ...prev, [item.path]: !expanded }));
                          if (fsLive && item.path !== wsActivePath) {
                            void applyWorkspace(item.path, 'select');
                          }
                        }}
                        className="flex-1 min-w-0 h-full flex items-center gap-1.5 text-left outline-none focus:outline-none"
                      >
                        <span className="tw-slot tw-folder">
                          <FolderIcon open={expanded} className="w-3.5 h-3.5" />
                        </span>
                        <span className="tw-slot tw-chevron">
                          <TriangleChevron open={expanded} className="w-3 h-3" />
                        </span>
                        <span className="tw-project-title">
                          {workspaceDisplayName(item, projectRootPath)}
                        </span>
                      </button>
                      <div className="tw-ws-actions relative shrink-0" data-ws-menu="">
                        <WorkspaceMoreMenu
                          open={menuOpen}
                          onToggle={() => {
                            setSessionMenuId(null);
                            setWsMenuId(menuOpen ? null : item.id);
                          }}
                          onRename={() => {
                            setSessionMenuId(null);
                            setWsMenuId(null);
                            setWsRenameId(item.id);
                          }}
                          onDelete={
                            item.id !== 'ws_project' ? () => requestDropWorkspace(item) : undefined
                          }
                        />
                        <button
                          type="button"
                          data-hint="在此工作区新建会话"
                          onClick={(e) => {
                            e.stopPropagation();
                            newSession(item.path);
                          }}
                          className="w-6 h-6 flex items-center justify-center rounded text-(--tw-label-tertiary) hover:text-(--tw-label-primary) hover:bg-(--tw-session-hover-bg)"
                        >
                          <Svg className="w-3.5 h-3.5">
                            <path d="M5 12h14" />
                            <path d="M12 5v14" />
                          </Svg>
                        </button>
                      </div>
                    </div>
                    <div className={`tw-collapse ${expanded ? 'is-open' : ''}`}>
                      <div className="tw-collapse-inner space-y-0.5 pb-0.5">
                        {kids.map((s) => (
                          <SessionRow key={s.id} s={s} nested />
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!visibleWsItems.length && fsLive && (
                <div className="px-2 py-3 text-xs text-stone-400">暂无工作区</div>
              )}
            </div>

            {archivedSessions.length > 0 && (
              <div className="mt-3 pt-2 border-t border-stone-200/60">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="w-full flex items-center gap-1 px-1.5 pb-1 text-[11px] text-stone-400 hover:text-stone-600"
                >
                  <ChevronIcon
                    className={`w-3 h-3 transition-transform ${showArchived ? 'rotate-180' : ''}`}
                  />
                  已归档 ({archivedSessions.length})
                </button>
                <div className={`tw-collapse ${showArchived ? 'is-open' : ''}`}>
                  <div className="tw-collapse-inner space-y-0.5">
                    {archivedSessions.map((s) => (
                      <SessionRow key={s.id} s={s} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {railOpen && (wsActivePath || toolBusy || toolHint) && (
          <div className="shrink-0 border-t border-stone-200/60 px-3 py-2 space-y-1">
            {wsActivePath && (
              <div className="tw-rail-workspace-footer" data-hint={wsActivePath}>
                <span className="tw-rail-workspace-label" data-i18n="chat.workspace">
                  工作区
                </span>
                <span className="tw-rail-workspace-name">
                  {shortWorkspaceLabel(wsActivePath, projectRootPath)}
                </span>
              </div>
            )}
            {(toolBusy || toolHint) && (
              <div className="text-[11px] text-(--tw-accent)">
                {toolHint ?? t('tool.running', undefined, generalPrefs.language)}
              </div>
            )}
          </div>
        )}
      </aside>

      <div className={`min-w-0 flex flex-col flex-1 ${pluginsOpen ? 'hidden' : ''}`}>
        {/* 空会话隐藏标题/Tab；有消息时入场 */}
        {!empty ? (
          <div className="shrink-0 border-b border-(--tw-border) bg-(--tw-surface-page)">
            <div className="flex items-center gap-3 px-6 pt-4 pb-2 min-w-0">
              <button
                type="button"
                data-hint="点击重命名"
                onClick={() => {
                  const id = store?.activeId;
                  if (id) renameSessionTitle(id);
                }}
                className="min-w-0 flex-1 text-left text-[18px] leading-7 font-semibold text-(--tw-label-primary) truncate hover:text-[#4176e6] transition-colors"
              >
                {store?.sessions.find((x) => x.id === store.activeId)?.title || '新对话'}
              </button>
            </div>
            <div className="flex items-center gap-6 px-6">
              <button
                type="button"
                onClick={() => setChatTab('dialog')}
                className={`relative h-10 text-sm transition-colors ${
                  chatTab === 'dialog'
                    ? 'text-[#4176e6] font-medium'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                对话
                {chatTab === 'dialog' && (
                  <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-[#4176e6] rounded-full" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setChatTab('thread')}
                className={`relative h-10 text-sm transition-colors ${
                  chatTab === 'thread'
                    ? 'text-[#4176e6] font-medium'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                回合
                {chatTab === 'thread' && (
                  <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-[#4176e6] rounded-full" />
                )}
              </button>
              {pluginOn.memory && (
                <button
                  type="button"
                  onClick={() => setChatTab('memory')}
                  className={`relative h-10 text-sm transition-colors ${
                    chatTab === 'memory'
                      ? 'text-[#4176e6] font-medium'
                      : 'text-stone-500 hover:text-stone-700'
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    记忆
                    {(memoryHealth?.suggestionCount ?? 0) > 0 ? (
                      <span
                        className="min-w-4.5 h-4.5 px-1 inline-flex items-center justify-center rounded-full bg-red-500 text-[10px] font-medium text-white tabular-nums leading-none"
                        data-hint={`${memoryHealth?.suggestionCount} 条待确认`}
                      >
                        {memoryHealth!.suggestionCount! > 99
                          ? '99+'
                          : memoryHealth!.suggestionCount}
                      </span>
                    ) : null}
                  </span>
                  {chatTab === 'memory' && (
                    <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-[#4176e6] rounded-full" />
                  )}
                </button>
              )}
              {pluginOn.todos && (
                <button
                  type="button"
                  onClick={() => setChatTab('todos')}
                  className={`relative h-10 text-sm transition-colors ${
                    chatTab === 'todos'
                      ? 'text-[#4176e6] font-medium'
                      : 'text-stone-500 hover:text-stone-700'
                  }`}
                >
                  待办
                  {chatTab === 'todos' && (
                    <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-[#4176e6] rounded-full" />
                  )}
                </button>
              )}
            </div>
            {sessionGoal && sessionGoal.status !== 'cleared' && chatTab === 'dialog' ? (
              <div className="px-6 pb-2">
                <div className="rounded-xl border border-[#4176e6]/25 bg-[#f5f8ff] px-3 py-2 flex items-start gap-2">
                  <span className="text-[11px] font-medium text-[#4176e6] shrink-0 pt-0.5">
                    目标{sessionGoal.status === 'done' ? '·完成' : ''}
                  </span>
                  <span
                    className={`flex-1 min-w-0 text-[12px] leading-5 ${
                      sessionGoal.status === 'done'
                        ? 'text-stone-400 line-through'
                        : 'text-stone-800'
                    }`}
                  >
                    {sessionGoal.text}
                  </span>
                  <button
                    type="button"
                    data-hint="清除目标"
                    className="text-[11px] text-stone-400 hover:text-stone-600 shrink-0"
                    onClick={() => {
                      sessionGoalRef.current = null;
                      setSessionGoal(null);
                      goalDriverRoundsRef.current = 0;
                      if (storeRef.current) {
                        commitStore(updateActiveSessionMeta(storeRef.current, { goal: undefined }));
                      }
                    }}
                  >
                    清除
                  </button>
                </div>
              </div>
            ) : null}
            {sessionTodos.length > 0 && chatTab === 'dialog' ? (
              <div className="px-6 pb-3">
                <div className="rounded-xl border border-stone-200 bg-white px-3 py-2.5">
                  <div className="text-[11px] font-medium text-stone-500 mb-1.5">
                    待办 · {sessionTodos.filter((x) => x.status === 'completed').length}/
                    {sessionTodos.length}
                  </div>
                  <ul className="space-y-1 max-h-28 overflow-y-auto">
                    {sessionTodos.map((item, idx) => (
                      <li
                        key={`${idx}-${item.content}`}
                        className="flex items-start gap-2 text-[12px] text-stone-700"
                      >
                        <span
                          className={`mt-0.5 w-3.5 h-3.5 rounded-sm border shrink-0 flex items-center justify-center text-[9px] ${
                            item.status === 'completed'
                              ? 'bg-emerald-500 border-emerald-500 text-white'
                              : item.status === 'in_progress'
                                ? 'border-[#4176e6] text-[#4176e6]'
                                : 'border-stone-300 text-transparent'
                          }`}
                          aria-hidden
                        >
                          {item.status === 'completed'
                            ? '✓'
                            : item.status === 'in_progress'
                              ? '…'
                              : ''}
                        </span>
                        <span
                          className={
                            item.status === 'completed' ? 'line-through text-stone-400' : ''
                          }
                        >
                          {item.content}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {chatTab === 'todos' && pluginOn.todos ? (
          <div
            key={`todos-${store?.activeId ?? ''}`}
            className="flex-1 min-h-0 bg-(--tw-surface-page) tw-pane-enter"
          >
            <TodoPane />
          </div>
        ) : chatTab === 'memory' && pluginOn.memory ? (
          <div
            key={`memory-${store?.activeId ?? ''}`}
            className="flex-1 min-h-0 bg-(--tw-surface-page) tw-pane-enter"
          >
            <MemoryPane
              live={memoryLive}
              pluginOn={Boolean(pluginOn.memory)}
              workspacePath={
                store?.sessions.find((s) => s.id === store.activeId)?.workspacePath ||
                workspaceInfo?.projectRoot ||
                ''
              }
            />
          </div>
        ) : chatTab === 'thread' ? (
          <div
            key={`thread-${store?.activeId ?? ''}`}
            className="flex-1 min-h-0 bg-(--tw-surface-page) tw-pane-enter overflow-y-auto px-12 sm:px-16 lg:px-20 py-6"
          >
            <ThreadOutlinePane
              messages={messages}
              busy={Boolean(store?.activeId && busySessionIds.includes(store.activeId))}
              onRestoreCheckpoint={(endMessageIndex, turnIndex) => {
                const sid = storeRef.current?.activeId;
                if (!sid) return;
                if (busySessionIds.includes(sid) || streaming) {
                  setError('请等待当前回复结束后再从此处继续');
                  return;
                }
                const end = Math.max(0, Math.min(endMessageIndex, messagesRef.current.length - 1));
                const next = messagesRef.current.slice(0, end + 1);
                messagesRef.current = next;
                setMessages(next);
                if (storeRef.current) {
                  commitStore(
                    updateActiveMessages(storeRef.current, next, { touchUpdatedAt: true }),
                  );
                }
                const prompt = `请从第 ${turnIndex} 轮继续`;
                setChatTab('dialog');
                setInput(prompt);
                setError(`已回到第 ${turnIndex} 轮，正在继续…`, 'ok');
                window.setTimeout(() => {
                  void send(prompt);
                }, 0);
              }}
            />
          </div>
        ) : (
          <div className={`relative flex-1 min-h-0 flex flex-col${empty ? ' justify-center' : ''}`}>
            {empty ? (
              <div className="shrink-0 flex flex-col items-center text-center px-8 sm:px-10 lg:px-12 pb-8">
                <img
                  src={`${base}brand/brand-mark.png`}
                  alt=""
                  width={64}
                  height={64}
                  className="w-16 h-16 rounded-[14px] object-contain"
                />
                <h2 className="mt-5 text-[22px] leading-8 font-semibold tracking-tight text-stone-800 text-balance">
                  {t('chat.emptyTitle', undefined, generalPrefs.language)}
                </h2>
              </div>
            ) : null}
            {!empty ? (
              <div key={`dialog-${store?.activeId ?? ''}`} className="relative flex-1 min-h-0">
                <div
                  ref={scrollRef}
                  onScroll={handleScroll}
                  className="h-full overflow-y-auto px-8 sm:px-10 lg:px-12 py-6"
                  style={{
                    fontSize: `var(--tw-session-font-size, ${generalPrefs.sessionFontSize}px)`,
                  }}
                >
                  <div
                    className="w-full max-w-[min(64rem,100%)] mx-auto flex flex-col gap-4"
                    onClick={onTranscriptClick}
                  >
                    {messages.map((m, i) =>
                      m.role === 'user' ? (
                        // dsh MessageItem：浅品牌蓝气泡居右，下方「时间 + 复制」
                        <div key={i} className="group flex flex-col items-end gap-1">
                          {m.refs?.length || m.attachments?.length || m.images?.length ? (
                            <div className="flex flex-wrap justify-end gap-1.5 max-w-[82%]">
                              {m.refs?.map((r) => (
                                <span
                                  key={r.path}
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#4176e6] bg-white border border-[#4176e6]/30 rounded-lg"
                                  data-hint={r.path}
                                >
                                  <FileIcon className="w-3.5 h-3.5" />
                                  <span className="text-[10px] text-stone-400 shrink-0">
                                    {formatSlashBadge(r.format)}
                                  </span>
                                  <span className="max-w-40 truncate">{r.title}</span>
                                </span>
                              ))}
                              {m.attachments?.map((a) => (
                                <span
                                  key={a.name}
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-stone-600 bg-white border border-stone-200 rounded-lg"
                                >
                                  <FileIcon className="w-3.5 h-3.5 text-[#4176e6]" />
                                  <span className="max-w-48 truncate">{a.name}</span>
                                  <span className="text-stone-400">{fmtSize(a.size)}</span>
                                </span>
                              ))}
                              {m.images?.map((img) => (
                                <a
                                  key={img.id}
                                  href={img.dataUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block overflow-hidden rounded-lg border border-stone-200 bg-white"
                                  data-hint={img.name}
                                >
                                  <img
                                    src={img.dataUrl}
                                    alt={img.name}
                                    className="max-h-40 max-w-48 object-contain"
                                  />
                                </a>
                              ))}
                            </div>
                          ) : null}
                          {m.content && (
                            <div className="tw-chat-text max-w-[82%] px-4 py-2.5 bg-[#edf3fe] rounded-2xl whitespace-pre-wrap break-words">
                              {m.content}
                            </div>
                          )}
                          <div className={`tw-msg-actions ${revealCls(i)}`}>
                            {m.time != null && (
                              <span className="tw-msg-action-time pr-0.5">{fmtClock(m.time)}</span>
                            )}
                            <CopyButton text={m.content} />
                          </div>
                        </div>
                      ) : (
                        // dsh AssistantMarkdown：助手无气泡、全宽排版，下方「复制 · 用量 · 时间」
                        <div key={i} className="group">
                          {m.turnStatus === 'stopped' ? (
                            <div className="mb-2">
                              <div className="text-[13px] text-stone-500 py-1">已停止</div>
                              <div className="border-t border-stone-200/80" />
                            </div>
                          ) : null}
                          {(() => {
                            // dsh：流式/仍有 running 步骤时始终展示进度；全部结束后才标「思考完成」
                            const allSteps = m.activitySteps ?? [];
                            const stepsRunning = allSteps.some((s) => s.status === 'running');
                            const isLive =
                              i === messages.length - 1 &&
                              m.turnStatus !== 'stopped' &&
                              (streaming || stepsRunning);
                            const waiting = isLive && !m.content;
                            const toolSteps = allSteps.filter((s) => s.kind !== 'thinking');
                            const showThink =
                              waiting ||
                              !!m.reasoning ||
                              toolSteps.length > 0 ||
                              allSteps.length > 0;
                            if (!showThink) return null;
                            const open = m.reasoningOpen ?? false;
                            const showTimeline = isLive || open || stepsRunning;
                            // 时间线已展开时，摘要只在下方「思考」步骤里显示，避免与标题行重复
                            const summary =
                              waiting && !open && !showTimeline && m.reasoning
                                ? latestParagraphFirstLine(m.reasoning).replaceAll('**', '')
                                : '';
                            return (
                              <div className="mb-2">
                                <button
                                  type="button"
                                  onClick={(e) => toggleReasoning(i, e)}
                                  className="flex w-full items-center gap-2 py-1 text-left select-none"
                                >
                                  {waiting || (isLive && !m.content) ? (
                                    <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-purple-400 border-t-transparent animate-spin" />
                                  ) : (
                                    <Svg className="w-3.5 h-3.5 shrink-0 text-stone-400">
                                      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
                                      <path d="M9 18h6" />
                                      <path d="M10 22h4" />
                                    </Svg>
                                  )}
                                  <span
                                    className={`text-[13px] font-medium shrink-0 ${
                                      isLive && !m.content ? 'text-shimmer' : 'text-shimmer-static'
                                    }`}
                                  >
                                    {isLive && !m.content
                                      ? allSteps.some(
                                          (s) => s.kind !== 'thinking' && s.status === 'running',
                                        )
                                        ? '正在分析请求'
                                        : '思考中…'
                                      : isLive
                                        ? '正在生成…'
                                        : m.turnStatus === 'stopped'
                                          ? '已完成分析'
                                          : '思考完成'}
                                  </span>
                                  {!isLive && m.reasoningDuration != null && (
                                    <span className="text-xs text-stone-400 shrink-0">
                                      用时 {m.reasoningDuration}s
                                    </span>
                                  )}
                                  <ChevronIcon
                                    className={`w-3.5 h-3.5 shrink-0 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`}
                                  />
                                  {summary ? (
                                    <span className="flex-1 min-w-0 truncate text-xs text-shimmer-muted think-mask">
                                      {summary}
                                    </span>
                                  ) : null}
                                </button>
                                {showTimeline && allSteps.length > 0 ? (
                                  <ul className="mt-1.5 mb-1 pl-5.5 space-y-1.5">
                                    {allSteps.map((s) => (
                                      <li
                                        key={s.id}
                                        className={`text-[12px] flex items-start gap-2 min-w-0 ${
                                          s.status === 'error'
                                            ? 'text-red-600'
                                            : s.status === 'running'
                                              ? 'text-stone-600'
                                              : 'text-stone-500'
                                        }`}
                                      >
                                        <ActivityStepIcon kind={s.kind} status={s.status} />
                                        <span className="min-w-0 flex-1 leading-5">
                                          <span
                                            className={`font-medium ${
                                              s.status === 'running' ? 'text-shimmer' : ''
                                            }`}
                                          >
                                            {s.title}
                                          </span>
                                          {s.detail ? (
                                            <span className="text-stone-400">
                                              {' · '}
                                              <span
                                                className={
                                                  s.status === 'error'
                                                    ? 'text-red-600'
                                                    : s.status === 'running'
                                                      ? 'text-shimmer-muted'
                                                      : ''
                                                }
                                                data-hint={s.detail}
                                              >
                                                {s.detail.length > 72
                                                  ? `${s.detail.slice(0, 72)}…`
                                                  : s.detail}
                                              </span>
                                            </span>
                                          ) : s.status === 'running' ? (
                                            <span className="text-stone-400 text-shimmer-muted">
                                              {' · '}…
                                            </span>
                                          ) : null}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                                {open && m.reasoning ? (
                                  <div className="mt-1.5 mb-2 pl-5.5 text-[13px] leading-5 text-stone-500 whitespace-pre-wrap max-h-80 overflow-y-auto">
                                    {m.reasoning}
                                  </div>
                                ) : null}
                                {m.turnStatus === 'stopped' ? (
                                  <div className="mt-1.5 pl-5.5">
                                    <span className="tw-turn-stopped-pill">已停止</span>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })()}
                          {m.content ? (
                            <div
                              className="chat-md prose prose-sm prose-stone max-w-none tw-chat-text"
                              dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                            />
                          ) : null}
                          {m.caseFile ? (
                            <button
                              type="button"
                              data-focus-doc={`cases:${m.caseFile.path.replace(/\\/g, '/')}`}
                              data-hint="双击本地打开"
                              onDoubleClick={() => {
                                void openDocsFile('cases', m.caseFile!.path).catch((e) =>
                                  setError(e instanceof Error ? e.message : String(e)),
                                );
                              }}
                              className="mt-3 w-full max-w-md flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-left hover:border-[#4176e6] hover:bg-[#f5f8ff] transition-colors cursor-pointer"
                            >
                              <span className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center text-[10px] font-semibold shrink-0">
                                {m.caseFile.name.split('.').pop()?.toUpperCase() || 'FILE'}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm text-stone-800 truncate">
                                  {m.caseFile.name}
                                </span>
                                <span className="block text-[11px] text-stone-400 truncate">
                                  {docRootLabelPath('cases')}
                                  {m.caseFile.path}
                                  {m.caseFile.count > 0 ? ` · ${m.caseFile.count} 条` : ''}
                                  {' · 双击本地打开'}
                                </span>
                              </span>
                            </button>
                          ) : null}
                          {m.docsFile ? (
                            <button
                              type="button"
                              data-focus-doc={`${m.docsFile.root}:${m.docsFile.path.replace(/\\/g, '/')}`}
                              data-hint="点击本地打开"
                              onClick={() => {
                                void openDocsFile(m.docsFile!.root, m.docsFile!.path).catch((e) =>
                                  setError(e instanceof Error ? e.message : String(e)),
                                );
                              }}
                              className="mt-3 w-full max-w-md flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-left hover:border-[#4176e6] hover:bg-[#f5f8ff] transition-colors cursor-pointer"
                            >
                              <span
                                className={`w-10 h-10 rounded-lg flex items-center justify-center text-[10px] font-semibold shrink-0 ${
                                  m.docsFile.root === 'knowledge'
                                    ? 'bg-amber-50 text-amber-800'
                                    : 'bg-sky-50 text-sky-700'
                                }`}
                              >
                                {m.docsFile.name.split('.').pop()?.toUpperCase() || 'MD'}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm text-stone-800 truncate">
                                  {m.docsFile.name}
                                </span>
                                <span className="block text-[11px] text-stone-400 truncate">
                                  {docRootLabelPath(m.docsFile.root)}
                                  {m.docsFile.path}
                                  {m.docsFile.note ? ` · ${m.docsFile.note}` : ''}
                                  {' · 点击打开'}
                                </span>
                              </span>
                            </button>
                          ) : null}
                          {m.presentFiles?.length
                            ? m.presentFiles.map((pf) => (
                                <button
                                  key={pf.path}
                                  type="button"
                                  data-hint="点击本地打开"
                                  onClick={() => {
                                    void openFsPath(pf.path, access).catch((e) =>
                                      setError(e instanceof Error ? e.message : String(e)),
                                    );
                                  }}
                                  className="mt-3 w-full max-w-md flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-left hover:border-[#4176e6] hover:bg-[#f5f8ff] transition-colors cursor-pointer"
                                >
                                  <span className="w-10 h-10 rounded-lg bg-violet-50 text-violet-700 flex items-center justify-center text-[10px] font-semibold shrink-0">
                                    {pf.name.split('.').pop()?.toUpperCase() || 'FILE'}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block text-sm text-stone-800 truncate">
                                      {pf.name}
                                    </span>
                                    <span className="block text-[11px] text-stone-400 truncate">
                                      {pf.path}
                                      {pf.description ? ` · ${pf.description}` : ''}
                                      {' · 点击打开'}
                                    </span>
                                  </span>
                                </button>
                              ))
                            : null}
                          {m.content && !(i === messages.length - 1 && streaming) ? (
                            <div className={`tw-msg-actions mt-1 ${revealCls(i)}`}>
                              <CopyButton text={m.content} />
                              {m.usage && (
                                <TurnUsageButton
                                  usage={m.usage}
                                  model={m.model ?? settings?.model}
                                />
                              )}
                              {m.time != null && (
                                <span className="tw-msg-action-time">{fmtClock(m.time)}</span>
                              )}
                            </div>
                          ) : null}
                        </div>
                      ),
                    )}
                  </div>
                </div>

                {/* 回到底部（离开贴底位置时出现） */}
                {showJump && (
                  <button
                    type="button"
                    onClick={jumpToBottom}
                    aria-label="回到底部"
                    className="absolute bottom-3 right-8 sm:right-10 lg:right-12 w-8 h-8 rounded-full bg-white border border-stone-200 shadow-md flex items-center justify-center text-stone-500 hover:text-stone-800 transition-colors"
                  >
                    <ChevronIcon className="w-4 h-4" />
                  </button>
                )}
              </div>
            ) : null}

            {/* 提示条：错误红 / 信息绿 */}
            {error && (
              <div className="shrink-0 px-8 sm:px-10 lg:px-12 pb-2">
                <div
                  ref={noticeRef}
                  className={`w-full max-w-[min(64rem,100%)] mx-auto flex items-start gap-3 px-4 py-3 rounded-xl text-sm border ${
                    errorTone === 'ok' ? 'tw-notice-anim' : ''
                  } ${
                    errorTone === 'ok'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-red-50 border-red-200 text-red-800'
                  }`}
                >
                  <span
                    className={`mt-0.5 w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold ${
                      errorTone === 'ok'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-red-100 text-red-600'
                    }`}
                  >
                    {errorTone === 'ok' ? 'i' : '!'}
                  </span>
                  <pre className="flex-1 min-w-0 m-0 font-sans text-[13px] leading-5 whitespace-pre-wrap break-words">
                    {error
                      .replace(/\*\*/g, '')
                      .replace(/\s*:\s*\*\*/g, ': ')
                      .trim()}
                  </pre>
                  <button
                    type="button"
                    onClick={() => setError(null)}
                    className={`shrink-0 text-xs ${
                      errorTone === 'ok'
                        ? 'text-emerald-500 hover:text-emerald-700'
                        : 'text-red-400 hover:text-red-600'
                    }`}
                  >
                    关闭
                  </button>
                </div>
              </div>
            )}

            {/* 输入区：dsh composer——白色圆角卡片，左「+ / 权限」，右「模型·推理 / 发送」 */}
            {/* 底部留白按状态栏（缓存命中那行）再往下留一段，避免贴着窗口底 */}
            <div className="shrink-0 px-8 sm:px-10 lg:px-12 pb-5">
              <div className="w-full max-w-[min(64rem,100%)] mx-auto">
                {promptGenConfig?.active && pluginOn.promptGen ? (
                  <div className="mb-2 flex items-center gap-2 px-3 py-2 rounded-xl border border-[#4176e6]/30 bg-[#edf3fe] text-xs text-[#3565c7]">
                    <span className="flex-1 min-w-0 truncate">
                      生成提示词已启用 · {promptGenConfigLabel(promptGenConfig)}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 hover:underline"
                      onClick={() => setPromptGenPanelOpen(true)}
                    >
                      改配置
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-stone-500 hover:text-stone-800"
                      onClick={() => applyPromptGenConfig(null)}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
                {knowledgeGenConfig?.active && pluginOn.knowledgeGen ? (
                  <div className="mb-2 flex items-center gap-2 px-3 py-2 rounded-xl border border-amber-300/60 bg-amber-50 text-xs text-amber-900">
                    <span className="flex-1 min-w-0 truncate">
                      生成知识库已启用 · {knowledgeGenConfigLabel(knowledgeGenConfig)}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 hover:underline"
                      onClick={() => setKnowledgeGenPanelOpen(true)}
                    >
                      改配置
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-stone-500 hover:text-stone-800"
                      onClick={() => applyKnowledgeGenConfig(null)}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
                {caseGenConfig?.active && pluginOn.caseGen ? (
                  <div className="mb-2 flex items-center gap-2 px-3 py-2 rounded-xl border border-[#4176e6]/30 bg-[#edf3fe] text-xs text-[#3565c7]">
                    <span className="flex-1 min-w-0 truncate">
                      生成测试用例已启用 · {caseGenConfigLabel(caseGenConfig)}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 hover:underline"
                      onClick={() => setCaseGenPanelOpen(true)}
                    >
                      改配置
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-stone-500 hover:text-stone-800"
                      onClick={() => applyCaseGenConfig(null)}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
                {/* dsh QueueDock：排队条目可见，当前轮结束后自动续发下一条 */}
                {sendQueue.length > 0 ? (
                  <div className="mb-2 rounded-xl border border-stone-200/80 bg-stone-100/80 overflow-hidden">
                    {sendQueue.map((q) => (
                      <div
                        key={q.id}
                        className="flex items-center gap-2 px-3 py-2 border-b border-stone-200/60 last:border-b-0"
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-stone-400 shrink-0"
                          aria-hidden
                        />
                        <span className="flex-1 min-w-0 truncate text-[13px] text-stone-700">
                          {queueTitle(q)}
                        </span>
                        <button
                          type="button"
                          data-hint="编辑回输入框"
                          onClick={() => editQueued(q.id)}
                          className="tw-icon-btn w-7 h-7 rounded-md flex items-center justify-center outline-none"
                        >
                          <Svg className="w-3.5 h-3.5">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                          </Svg>
                        </button>
                        <button
                          type="button"
                          data-hint="从队列移除"
                          onClick={() => removeQueued(q.id)}
                          className="tw-icon-btn w-7 h-7 rounded-md flex items-center justify-center outline-none"
                        >
                          <Svg className="w-3.5 h-3.5">
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M19 6l-1 14H6L5 6" />
                          </Svg>
                        </button>
                        <button
                          type="button"
                          data-hint="插话立即发送（其后队列仍会续发）"
                          onClick={() => promoteQueued(q.id)}
                          className="tw-icon-btn w-7 h-7 rounded-md flex items-center justify-center outline-none text-[#4176e6]"
                        >
                          <SendIcon className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {planProposal ? (
                  <div className="mb-2 rounded-xl border border-amber-300/60 bg-amber-50/90 px-4 py-3 shadow-sm">
                    <div className="text-[13px] font-medium text-stone-800 mb-1">待批准计划</div>
                    <div className="text-[14px] font-medium text-stone-900">
                      {planProposal.title}
                    </div>
                    {planProposal.summary ? (
                      <p className="mt-1 text-[13px] text-stone-600 leading-5">
                        {planProposal.summary}
                      </p>
                    ) : null}
                    <ol className="mt-2 list-decimal pl-5 space-y-1 text-[13px] text-stone-700">
                      {planProposal.steps.map((s, i) => (
                        <li key={`${i}-${s.slice(0, 24)}`}>{s}</li>
                      ))}
                    </ol>
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="h-8 px-3 rounded-lg border border-stone-200 bg-white text-[12px] text-stone-600 hover:bg-stone-50"
                        onClick={() => rejectPlan()}
                      >
                        驳回
                      </button>
                      <button
                        type="button"
                        className="h-8 px-3 rounded-lg bg-[#4176e6] text-[12px] text-white hover:bg-[#3467d4]"
                        onClick={() => approvePlan()}
                      >
                        批准实施
                      </button>
                    </div>
                  </div>
                ) : null}
                {createConfirm ? (
                  <CreateConfirmCard
                    kind={createConfirm.kind}
                    items={createConfirm.items}
                    manual={createConfirm.manual}
                    quick={createConfirm.quick}
                    quickNote={createConfirm.quickNote}
                    tasksOn={pluginOn.tasks}
                    closing={createClosing}
                    onConfirm={(items) => {
                      if (createConfirm.manual) {
                        settleCreateConfirm(null);
                        void submitManualCreate(createConfirm.kind, items);
                      } else settleCreateConfirm(items);
                    }}
                    onCancel={() => settleCreateConfirm(null)}
                  />
                ) : null}
                {askStepCount > 0 && askStepQuestion ? (
                  <div className="mb-2 flex max-h-[min(60vh,520px)] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_6px_24px_rgba(15,23,42,0.08)]">
                    <div
                      className={`flex shrink-0 justify-between gap-4 px-5 ${
                        askUserMinimized ? 'items-center py-3.5' : 'items-start pt-4'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="mb-1 text-[11px] leading-4 text-stone-400">
                          {askSkipConfirm
                            ? '跳过确认'
                            : askStepQuestion.header || '模型需要你的确认'}
                        </div>
                        <h3 className="text-[15px] leading-5.5 font-medium text-stone-900">
                          {askSkipConfirm
                            ? `确认 ${askSkippedItems.length} 道跳过的题怎么处理`
                            : askStepQuestion.question}
                        </h3>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {askUserMinimized ? (
                          <span className="text-[11px] leading-4 text-stone-400">
                            {askSkipConfirm
                              ? `已跳过 ${askSkippedItems.length} 题`
                              : `第 ${askStepIndex + 1} 步 / 共 ${askStepCount} 步`}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          aria-label={askUserMinimized ? '展开问题' : '收起问题'}
                          onClick={() => setAskUserMinimized((v) => !v)}
                          className="grid h-6 w-6 place-items-center rounded-full text-stone-400 outline-none hover:bg-stone-100 hover:text-stone-600"
                        >
                          <ChevronIcon
                            className={`h-4 w-4 transition-transform ${askUserMinimized ? 'rotate-180' : ''}`}
                          />
                        </button>
                      </div>
                    </div>
                    {askUserMinimized ? null : askSkipConfirm ? (
                      <>
                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-2">
                          <p className="text-[12px] leading-5 text-stone-500">
                            跳过不算确认，本轮不会开始改代码。留下原因后我只出方案，等你回复「开始实施」。
                          </p>
                          <ul className="mt-2 space-y-1 rounded-lg bg-stone-50 px-3 py-2">
                            {askSkippedItems.map(({ q, index }) => (
                              <li key={q.id} className="text-[12px] leading-5 text-stone-600">
                                <span className="text-stone-400">{index + 1}.</span>{' '}
                                {q.header ? `${q.header} / ` : ''}
                                {q.question}
                                <span className="ml-1 text-stone-400">— 已跳过</span>
                              </li>
                            ))}
                          </ul>
                          <textarea
                            autoFocus
                            value={askSkipReason}
                            onChange={(e) => setAskSkipReason(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) {
                                return;
                              }
                              e.preventDefault();
                              confirmSkipSubmit();
                            }}
                            rows={3}
                            className="mt-2 w-full resize-none rounded-lg border border-stone-200 px-2.5 py-2 text-[13px] leading-5 outline-none focus:border-[#4176e6]"
                            placeholder="为什么跳过这几题？例如：先只做评估，方案我稍后定 / 这几项按你推荐的来"
                          />
                        </div>
                        <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-2 pb-3">
                          <button
                            type="button"
                            onClick={() => backToAnswering()}
                            className="h-8 shrink-0 rounded-lg px-2 text-[12px] text-stone-500 outline-none hover:bg-stone-100 hover:text-stone-700"
                          >
                            返回继续回答
                          </button>
                          <button
                            type="button"
                            onClick={() => confirmSkipSubmit()}
                            className="h-8 shrink-0 rounded-lg bg-[#4176e6] px-3.5 text-[12px] font-medium text-white hover:bg-[#3467d4]"
                          >
                            提交并继续
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-1">
                          {askStepQuestion.options?.length ? (
                            <div
                              className="mt-2 flex flex-col gap-0.5"
                              role={askStepQuestion.multi_select ? 'group' : 'radiogroup'}
                            >
                              {askStepQuestion.options.map((opt, i) => {
                                const checked = askStepDraft.selected.includes(opt.label);
                                const display = parseRecommendedLabel(opt.label);
                                return (
                                  <button
                                    key={`${opt.label}-${i}`}
                                    type="button"
                                    role={askStepQuestion.multi_select ? 'checkbox' : 'radio'}
                                    aria-checked={checked}
                                    onClick={() =>
                                      chooseAskOption(askStepQuestion, opt.label, checked)
                                    }
                                    className={`flex w-full shrink-0 items-start gap-2 rounded-lg border px-2 py-2 text-left outline-none transition-colors ${
                                      checked
                                        ? 'border-[#4176e6]/40 bg-[#f2f7ff]'
                                        : 'border-transparent hover:bg-stone-50'
                                    }`}
                                  >
                                    {askStepQuestion.multi_select ? (
                                      <span
                                        aria-hidden="true"
                                        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
                                          checked
                                            ? 'border-[#4176e6] bg-[#4176e6] text-white'
                                            : 'border-stone-300 text-transparent'
                                        }`}
                                      >
                                        <CheckIcon className="h-3 w-3" />
                                      </span>
                                    ) : (
                                      <span
                                        aria-hidden="true"
                                        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md text-[11px] font-medium ${
                                          checked
                                            ? 'bg-[#4176e6] text-white'
                                            : 'bg-stone-100 text-stone-500'
                                        }`}
                                      >
                                        {i + 1}
                                      </span>
                                    )}
                                    <span className="min-w-0 flex-1">
                                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                        <span className="text-[13px] leading-5 font-medium text-stone-800">
                                          {display.label}
                                        </span>
                                        {display.recommended ? (
                                          <span className="rounded bg-[#edf3fe] px-1 text-[10px] leading-4 font-semibold text-[#4176e6]">
                                            推荐
                                          </span>
                                        ) : null}
                                      </span>
                                      {opt.description ? (
                                        <span className="mt-0.5 block text-[12px] leading-4.5 text-stone-400">
                                          {opt.description}
                                        </span>
                                      ) : null}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="px-1.5 py-2">
                              <textarea
                                autoFocus
                                value={askStepDraft.text}
                                onChange={(e) => updateAskText(askStepQuestion, e.target.value)}
                                onKeyDown={(e) => {
                                  if (
                                    e.key !== 'Enter' ||
                                    e.shiftKey ||
                                    e.nativeEvent.isComposing
                                  ) {
                                    return;
                                  }
                                  e.preventDefault();
                                  applyAskTextChoice(askStepQuestion, askStepDraft.text);
                                }}
                                rows={2}
                                className="w-full resize-none rounded-lg border border-stone-200 px-2.5 py-2 text-[13px] leading-5 outline-none focus:border-[#4176e6]"
                                placeholder="输入你的回答…"
                              />
                            </div>
                          )}
                          {askStepQuestion.options?.length ? (
                            <div className="mt-1 px-1.5 pb-1">
                              <div className="flex items-start gap-2 rounded-lg border border-stone-200 px-2 py-1.5 focus-within:border-[#4176e6]">
                                <span
                                  aria-hidden="true"
                                  className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded bg-stone-100 text-[10px] font-medium text-stone-500"
                                >
                                  #
                                </span>
                                <textarea
                                  value={askStepDraft.text}
                                  onChange={(e) => updateAskText(askStepQuestion, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (
                                      e.key !== 'Enter' ||
                                      e.shiftKey ||
                                      e.nativeEvent.isComposing
                                    ) {
                                      return;
                                    }
                                    e.preventDefault();
                                    applyAskTextChoice(askStepQuestion, askStepDraft.text);
                                  }}
                                  rows={1}
                                  className="min-h-5 w-full resize-none bg-transparent text-[13px] leading-5 outline-none"
                                  placeholder={`输入序号选择（如 1${
                                    askStepQuestion.multi_select ? ' 或 1,3' : ''
                                  }），也可直接写你的回答`}
                                />
                              </div>
                            </div>
                          ) : null}
                          <div className="px-2 pb-2 pt-1 text-[11px] leading-4 text-stone-400">
                            {askStepQuestion.options?.length
                              ? '回车确认这一步；跳过的题会在提交前让你说明原因，不会直接开始实施'
                              : '回车确认；跳过的题会在提交前让你说明原因，不会直接开始实施'}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-2 pb-3">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-label="上一步"
                              disabled={askStepIndex === 0}
                              onClick={() => goAskStep(askStepIndex - 1)}
                              className="grid h-6 w-6 place-items-center rounded-full text-stone-400 outline-none hover:bg-stone-100 hover:text-stone-600 disabled:cursor-default disabled:text-stone-200 disabled:hover:bg-transparent"
                            >
                              <ChevronRightIcon className="h-4 w-4 rotate-180" />
                            </button>
                            <span className="px-1 text-[12px] font-medium text-stone-500">
                              第 {askStepIndex + 1} 步 / 共 {askStepCount} 步
                            </span>
                            <button
                              type="button"
                              aria-label="下一步"
                              disabled={askLastStep}
                              onClick={() => goAskStep(askStepIndex + 1)}
                              className="grid h-6 w-6 place-items-center rounded-full text-stone-400 outline-none hover:bg-stone-100 hover:text-stone-600 disabled:cursor-default disabled:text-stone-200 disabled:hover:bg-transparent"
                            >
                              <ChevronRightIcon className="h-4 w-4" />
                            </button>
                          </div>
                          <div className="flex min-w-0 items-center gap-2">
                            {askUserFeedback ? (
                              <span className="truncate text-[11px] text-rose-500">
                                {askUserFeedback}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => skipAskStep()}
                              className="h-8 shrink-0 rounded-lg px-2 text-[12px] text-stone-500 outline-none hover:bg-stone-100 hover:text-stone-700"
                            >
                              跳过
                            </button>
                            <button
                              type="button"
                              disabled={!askStepAnswered}
                              onClick={() =>
                                askLastStep ? submitAskUserAnswers() : goAskStep(askStepIndex + 1)
                              }
                              className="h-8 shrink-0 rounded-lg bg-[#4176e6] px-3.5 text-[12px] font-medium text-white hover:bg-[#3467d4] disabled:cursor-not-allowed disabled:bg-stone-300"
                            >
                              {askLastStep ? '提交回答' : '下一步'}
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
                <div
                  ref={composerRef}
                  className="pt-2 rounded-[20px] bg-white border border-stone-200 shadow-[0_4px_20px_rgba(15,23,42,0.06)] transition-shadow focus-within:shadow-[0_4px_24px_rgba(65,118,230,0.14)]"
                >
                  {(docRefs.length > 0 || attachments.length > 0 || images.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 px-3 pt-0.5 pb-2">
                      {docRefs.map((r) => (
                        <span
                          key={`${r.collection}:${r.path}`}
                          className="flex items-center gap-1.5 pl-2.5 pr-1 py-1 text-xs text-[#4176e6] bg-[#edf3fe] border border-[#4176e6]/25 rounded-lg"
                          data-hint={
                            r.collection === 'workspace' ? r.path : `${r.collection}/${r.path}`
                          }
                        >
                          <FileIcon className="w-3.5 h-3.5" />
                          <span className="text-[10px] text-[#4176e6]/80 shrink-0">
                            {r.collection === 'workspace'
                              ? '工作区'
                              : r.collection === 'prompts' ||
                                  r.collection === 'cases' ||
                                  r.collection === 'knowledge'
                                ? r.category
                                : formatSlashBadge(r.format)}
                          </span>
                          <span className="max-w-48 truncate">{r.title}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setDocRefs((prev) =>
                                prev.filter(
                                  (x) => !(x.collection === r.collection && x.path === r.path),
                                ),
                              )
                            }
                            className="w-5 h-5 flex items-center justify-center rounded text-[#4176e6]/70 hover:text-[#4176e6] hover:bg-white/80"
                          >
                            <Svg className="w-3 h-3">
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </Svg>
                          </button>
                        </span>
                      ))}
                      {attachments.map((a, idx) => (
                        <span
                          key={`${a.name}-${idx}`}
                          className="flex items-center gap-1.5 pl-2.5 pr-1 py-1 text-xs text-[#4176e6] bg-[#edf3fe] border border-[#4176e6]/25 rounded-lg"
                          data-hint={a.path || a.name}
                        >
                          <FileIcon className="w-3.5 h-3.5" />
                          <span className="text-[10px] text-[#4176e6]/80 shrink-0">文件</span>
                          <span className="max-w-48 truncate">{a.name}</span>
                          <button
                            type="button"
                            data-hint="移除"
                            onClick={() =>
                              setAttachments((prev) => prev.filter((_, j) => j !== idx))
                            }
                            className="w-5 h-5 flex items-center justify-center rounded text-[#4176e6]/70 hover:text-[#4176e6] hover:bg-white/80"
                          >
                            <Svg className="w-3 h-3">
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </Svg>
                          </button>
                        </span>
                      ))}
                      {images.map((img) => (
                        <span
                          key={img.id}
                          className="relative group inline-flex rounded-lg border border-stone-200 overflow-hidden bg-stone-50"
                          data-hint={`${img.name} · ${fmtSize(img.size)}`}
                        >
                          <img
                            src={img.dataUrl}
                            alt={img.name}
                            className="h-14 w-14 object-cover"
                          />
                          <button
                            type="button"
                            data-hint="移除图片"
                            onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                            className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded bg-black/55 text-white hover:bg-black/75"
                          >
                            <Svg className="w-3 h-3">
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </Svg>
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    {addMenuOpen && !pluginMenuOpen && !atOpen && (
                      <div
                        ref={addMenuRef}
                        className="tw-composer-menu tw-popover-anim absolute bottom-full left-0 right-0 mb-3 z-40 h-[min(70vh,20rem)] overflow-hidden rounded-xl border border-stone-200 py-2.5 shadow-[0_4px_14px_-4px_rgba(15,23,42,0.08)]"
                      >
                        <div className="tw-dsh-scroll h-full overflow-y-auto overflow-x-hidden">
                          <div className="px-3 pt-0.5 pb-1.5 text-[11px] font-medium text-stone-400 tracking-wide">
                            添加
                          </div>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setAddMenuOpen(false);
                              fileInputRef.current?.click();
                            }}
                            className="tw-composer-menu-item w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg hover:bg-stone-100"
                          >
                            <PaperclipIcon className="w-4 h-4 shrink-0 text-stone-500" />
                            <span className="min-w-0 flex-1 text-[13px] text-stone-800">
                              文件
                              <span className="ml-1.5 text-stone-400 font-normal">file</span>
                            </span>
                            <span className="shrink-0 max-w-[45%] text-right text-[11px] text-stone-400 truncate">
                              添加本地附件
                            </span>
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setAddMenuOpen(false);
                              activateGoalChip();
                            }}
                            className="tw-composer-menu-item w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg hover:bg-stone-100"
                          >
                            <Svg className="w-4 h-4 shrink-0 text-stone-500">
                              <circle cx="12" cy="12" r="10" />
                              <circle cx="12" cy="12" r="6" />
                              <circle cx="12" cy="12" r="2" />
                            </Svg>
                            <span className="min-w-0 flex-1 text-[13px] text-stone-800">
                              目标
                              <span className="ml-1.5 text-stone-400 font-normal">goal</span>
                            </span>
                            <span className="shrink-0 max-w-[45%] text-right text-[11px] text-stone-400 truncate">
                              设置或查看长期任务目标
                            </span>
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setAddMenuOpen(false);
                              if (planPhase === 'off') activatePlanChip();
                              else togglePlanMode();
                            }}
                            className={`tw-composer-menu-item w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg hover:bg-stone-100 ${
                              planPhase === 'planning'
                                ? 'bg-amber-50'
                                : planPhase === 'approved'
                                  ? 'bg-emerald-50'
                                  : ''
                            }`}
                          >
                            <Svg
                              className={`w-4 h-4 shrink-0 ${
                                planPhase === 'planning'
                                  ? 'text-amber-800'
                                  : planPhase === 'approved'
                                    ? 'text-emerald-800'
                                    : 'text-stone-500'
                              }`}
                            >
                              <path d="M8 6h13" />
                              <path d="M8 12h13" />
                              <path d="M8 18h13" />
                              <path d="M3 6h.01" />
                              <path d="M3 12h.01" />
                              <path d="M3 18h.01" />
                            </Svg>
                            <span className="min-w-0 flex-1 text-[13px] text-stone-800">
                              计划
                              <span className="ml-1.5 text-stone-400 font-normal">plan</span>
                            </span>
                            <span className="shrink-0 max-w-[45%] text-right text-[11px] text-stone-400 truncate">
                              进入或退出计划模式
                            </span>
                          </button>

                          {pluginOn.todos || pluginOn.tasks ? (
                            <>
                              {pluginOn.todos ? (
                                <button
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => openManualCreate('todo')}
                                  className="tw-composer-menu-item w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg hover:bg-stone-100"
                                >
                                  <Svg className="w-4 h-4 shrink-0 text-stone-500">
                                    <path d="M8 6h13" />
                                    <path d="M8 12h13" />
                                    <path d="M8 18h13" />
                                    <path d="M3 6h.01" />
                                    <path d="M3 12h.01" />
                                    <path d="M3 18h.01" />
                                  </Svg>
                                  <span className="min-w-0 flex-1 text-[13px] text-stone-800">
                                    待办
                                    <span className="ml-1.5 text-stone-400 font-normal">todo</span>
                                  </span>
                                  <span className="shrink-0 max-w-[45%] text-right text-[11px] text-stone-400 truncate">
                                    手动添加一条待办
                                  </span>
                                </button>
                              ) : null}
                              {pluginOn.tasks ? (
                                <button
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => openManualCreate('task')}
                                  className="tw-composer-menu-item w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg hover:bg-stone-100"
                                >
                                  <Svg className="w-4 h-4 shrink-0 text-stone-500">
                                    <path d="M9 5h10" />
                                    <path d="M9 12h10" />
                                    <path d="M9 19h10" />
                                    <path d="M4 5h.01" />
                                    <path d="M4 12h.01" />
                                    <path d="M4 19h.01" />
                                  </Svg>
                                  <span className="min-w-0 flex-1 text-[13px] text-stone-800">
                                    任务
                                    <span className="ml-1.5 text-stone-400 font-normal">task</span>
                                  </span>
                                  <span className="shrink-0 max-w-[45%] text-right text-[11px] text-stone-400 truncate">
                                    手动添加一个任务
                                  </span>
                                </button>
                              ) : null}
                            </>
                          ) : null}

                          {pluginMenuItems.length ? (
                            <>
                              <div className="my-1 border-t border-stone-100" />
                              <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => setAddPluginsExpanded((v) => !v)}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-stone-50"
                              >
                                <span className="flex-1 text-[11px] font-medium text-stone-400 tracking-wide">
                                  扩展插件
                                </span>
                                <ChevronIcon
                                  className={`w-3.5 h-3.5 text-stone-400 shrink-0 transition-transform ${
                                    addPluginsExpanded ? 'rotate-180' : ''
                                  }`}
                                />
                              </button>
                              {addPluginsExpanded
                                ? pluginMenuItems.map((p) => {
                                    const en =
                                      p.id === 'caseGen'
                                        ? 'case'
                                        : p.id === 'promptGen'
                                          ? 'prompt'
                                          : p.id === 'knowledgeGen'
                                            ? 'knowledge'
                                            : p.id === 'pluginDev'
                                              ? 'dev'
                                              : '';
                                    const tip =
                                      p.id === 'caseGen'
                                        ? '打开配置后生成用例并写入用例库'
                                        : p.id === 'promptGen'
                                          ? '对话生成提示词并写入提示词库'
                                          : p.id === 'knowledgeGen'
                                            ? '对话生成规范/方法论并写入知识库'
                                            : p.id === 'pluginDev'
                                              ? '输入需求后先评估确认，再开发扩展插件'
                                              : '';
                                    return (
                                      <button
                                        key={p.id}
                                        type="button"
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => {
                                          setAddMenuOpen(false);
                                          pickPluginMenu(p.id);
                                        }}
                                        className="tw-composer-menu-item w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg hover:bg-stone-100"
                                      >
                                        <PluginIcon className="w-4 h-4 shrink-0 text-stone-500" />
                                        <span className="min-w-0 flex-1 text-[13px] text-stone-800">
                                          {p.name}
                                          {en ? (
                                            <span className="ml-1.5 text-stone-400 font-normal">
                                              {en}
                                            </span>
                                          ) : null}
                                        </span>
                                        {tip ? (
                                          <span className="shrink-0 max-w-[45%] text-right text-[11px] text-stone-400 truncate">
                                            {tip}
                                          </span>
                                        ) : null}
                                      </button>
                                    );
                                  })
                                : null}
                            </>
                          ) : null}

                          <div className="my-1 border-t border-stone-100" />
                          <div className="px-3 pt-1 pb-1.5 text-[11px] font-medium text-stone-400 tracking-wide">
                            指令
                          </div>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setAddMenuOpen(false);
                              if (streamingRef.current) {
                                setError('请等待当前回复结束后再压缩');
                                return;
                              }
                              void runSessionCompact({ force: true }).then((ok) => {
                                if (ok) setError('已压缩上下文');
                              });
                            }}
                            className="tw-composer-menu-item w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg hover:bg-stone-100"
                          >
                            <Svg className="w-4 h-4 shrink-0 text-stone-500">
                              <circle cx="12" cy="12" r="9" />
                            </Svg>
                            <span className="min-w-0 flex-1 text-[13px] text-stone-800">
                              压缩
                              <span className="ml-1.5 text-stone-400 font-normal">compact</span>
                            </span>
                            <span className="shrink-0 max-w-[45%] text-right text-[11px] text-stone-400 truncate">
                              压缩以上对话内容
                            </span>
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setAddMenuOpen(false);
                              showActiveSessionStats();
                            }}
                            className="tw-composer-menu-item w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg hover:bg-stone-100"
                          >
                            <Svg className="w-4 h-4 shrink-0 text-stone-500">
                              <path d="M3 3v18h18" />
                              <path d="M7 14v4" />
                              <path d="M12 10v8" />
                              <path d="M17 6v12" />
                            </Svg>
                            <span className="min-w-0 flex-1 text-[13px] text-stone-800">
                              会话统计
                              <span className="ml-1.5 text-stone-400 font-normal">stats</span>
                            </span>
                            <span className="shrink-0 max-w-[45%] text-right text-[11px] text-stone-400 truncate">
                              查看本会话用量摘要
                            </span>
                          </button>
                        </div>
                      </div>
                    )}
                    {pluginMenuOpen && (
                      <div
                        ref={pluginMenuRef}
                        className="tw-composer-menu tw-popover-anim absolute bottom-full left-0 right-0 mb-2 mx-2 z-40 max-h-64 overflow-y-auto rounded-xl border border-stone-200 shadow-xl p-1"
                      >
                        <div className="px-3 py-1.5 text-[11px] text-stone-400">插件</div>
                        {pluginMenuItems.map((p, i) => (
                          <button
                            key={p.id}
                            type="button"
                            data-plugin-index={i}
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setPluginIndex(i)}
                            onClick={() => pickPluginMenu(p.id)}
                            className={`tw-composer-menu-item w-full text-left px-3 py-2 rounded-lg transition-colors ${
                              i === pluginIndex ? 'is-active' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <div className="text-[13px] font-medium text-stone-800 flex-1">
                                {p.name}
                              </div>
                            </div>
                            <div className="mt-0.5 text-xs text-stone-400 line-clamp-2">
                              {p.description}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    {atOpen && (
                      <div
                        ref={mentionListRef}
                        className="tw-composer-menu tw-popover-anim absolute bottom-full left-0 right-0 mb-2 mx-2 z-40 max-h-64 overflow-y-auto rounded-xl border border-stone-200 shadow-xl p-1"
                      >
                        {atFlatItems.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-stone-400 space-y-1">
                            {knowledgeOn ? <p>项目文档：无匹配</p> : null}
                            {hasWorkspace ? (
                              <p>工作区：无匹配</p>
                            ) : (
                              <p>工作区：请先在侧栏添加并选择工作区</p>
                            )}
                            {!knowledgeOn ? (
                              <p>
                                「知识库检索」未启用：启用后才能用 @ 引用
                                {docRootLabel('knowledge')} / {docRootLabel('templates')}文档
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <>
                            {atProjectDocs.length > 0 ? (
                              <div className="px-3 py-1.5 text-[11px] font-medium text-stone-400">
                                项目文档（{docRootLabel('knowledge')} / {docRootLabel('templates')}
                                ）
                              </div>
                            ) : null}
                            {atFlatItems.map((item, i) => {
                              const d = item.doc;
                              const prev = atFlatItems[i - 1];
                              const showWsHeader =
                                item.section === 'workspace' && prev?.section !== 'workspace';
                              return (
                                <div key={`${d.collection}/${d.id}`}>
                                  {showWsHeader ? (
                                    <>
                                      {atProjectDocs.length > 0 ? (
                                        <div
                                          className="my-1 mx-2 border-t border-stone-200"
                                          role="separator"
                                        />
                                      ) : null}
                                      <div className="px-3 py-1.5 text-[11px] font-medium text-stone-400">
                                        工作区
                                      </div>
                                    </>
                                  ) : null}
                                  <button
                                    type="button"
                                    data-mention-index={i}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => pickAtDoc(d)}
                                    className={`tw-composer-menu-item w-full text-left px-3 py-2 rounded-lg transition-colors ${
                                      i === mentionIndex ? 'is-active' : ''
                                    }`}
                                  >
                                    <div className="flex items-center gap-2 text-[13px] text-stone-800">
                                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-500 shrink-0">
                                        {d.collection === 'knowledge'
                                          ? docRootLabel('knowledge')
                                          : d.collection === 'templates'
                                            ? docRootLabel('templates')
                                            : d.format === 'dir'
                                              ? '文件夹'
                                              : '文件'}
                                      </span>
                                      {d.collection !== 'workspace' ? (
                                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-500 shrink-0">
                                          {formatSlashBadge(d.format)}
                                        </span>
                                      ) : null}
                                      <span className="truncate font-medium">{d.title}</span>
                                    </div>
                                    <div className="mt-0.5 pl-0 text-xs text-stone-400 truncate">
                                      {d.collection === 'workspace'
                                        ? d.path
                                        : `${d.category}${d.description ? ` · ${d.description}` : ''}`}
                                    </div>
                                  </button>
                                </div>
                              );
                            })}
                            {!knowledgeOn ? (
                              <>
                                <div
                                  className="my-1 mx-2 border-t border-stone-200"
                                  role="separator"
                                />
                                <p className="px-3 py-1.5 text-[11px] text-stone-400">
                                  「知识库检索」未启用：@ 仅引用工作区文件
                                </p>
                              </>
                            ) : null}
                          </>
                        )}
                      </div>
                    )}
                    <div className="flex items-start gap-2 px-3">
                      {composerChip === 'goal' ? (
                        <span className="tw-composer-mode-chip is-goal" data-hint="会话目标">
                          <Svg className="w-3.5 h-3.5 shrink-0">
                            <circle cx="12" cy="12" r="10" />
                            <circle cx="12" cy="12" r="6" />
                            <circle cx="12" cy="12" r="2" />
                          </Svg>
                          <span>目标</span>
                          <button
                            type="button"
                            aria-label="取消目标输入"
                            onClick={() => setComposerChip(null)}
                          >
                            <Svg className="w-3 h-3">
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </Svg>
                          </button>
                        </span>
                      ) : null}
                      {composerChip === 'plan' ? (
                        <span
                          className={`tw-composer-mode-chip is-plan${planPhase === 'approved' ? ' is-approved' : ''}`}
                          data-hint={
                            planPhase === 'approved' ? '计划模式·已批准' : '计划模式·探查中'
                          }
                        >
                          <Svg className="w-3.5 h-3.5 shrink-0">
                            <path d="M8 6h13" />
                            <path d="M8 12h13" />
                            <path d="M8 18h13" />
                            <path d="M3 6h.01" />
                            <path d="M3 12h.01" />
                            <path d="M3 18h.01" />
                          </Svg>
                          <span>计划</span>
                          <button
                            type="button"
                            aria-label="退出计划模式"
                            onClick={() => dismissComposerChip()}
                          >
                            <Svg className="w-3 h-3">
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </Svg>
                          </button>
                        </span>
                      ) : null}
                      {composerChip === 'pluginDev' ? (
                        <span className="tw-composer-mode-chip is-plugin-dev">
                          <Svg className="w-3.5 h-3.5 shrink-0">
                            <path d="M9 7V3" />
                            <path d="M15 7V3" />
                            <path d="M6 7h12v4a6 6 0 0 1-12 0V7Z" />
                            <path d="M12 17v4" />
                          </Svg>
                          <span>插件开发</span>
                          <button
                            type="button"
                            aria-label="退出插件开发"
                            onClick={() => dismissComposerChip()}
                          >
                            <Svg className="w-3 h-3">
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </Svg>
                          </button>
                        </span>
                      ) : null}
                      {composerChip === 'reports' ? (
                        <span className="tw-composer-mode-chip is-report">
                          <Svg className="w-3.5 h-3.5 shrink-0">
                            <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                            <path d="M5 3h9l5 5v13H5z" />
                            <path d="M8 13h8" />
                            <path d="M8 17h5" />
                          </Svg>
                          <span>生成{REPORT_KIND_LABEL[reportChipKind]}</span>
                          <button
                            type="button"
                            aria-label="取消汇报生成"
                            onClick={() => dismissComposerChip()}
                          >
                            <Svg className="w-3 h-3">
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </Svg>
                          </button>
                        </span>
                      ) : null}
                      <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onPaste={onComposerPaste}
                        onKeyDown={(e) => {
                          if (pluginMenuOpen && pluginMenuItems.length) {
                            if (e.key === 'ArrowDown') {
                              e.preventDefault();
                              setPluginIndex((i) => (i + 1) % pluginMenuItems.length);
                              return;
                            }
                            if (e.key === 'ArrowUp') {
                              e.preventDefault();
                              setPluginIndex(
                                (i) => (i - 1 + pluginMenuItems.length) % pluginMenuItems.length,
                              );
                              return;
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setPluginMenuDismissed(true);
                              if (pluginSlashState) setInput(input.slice(0, pluginSlashState.from));
                              return;
                            }
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              const item = pluginMenuItems[pluginIndex] ?? pluginMenuItems[0];
                              if (item) pickPluginMenu(item.id);
                              return;
                            }
                          }
                          if (atOpen && atFlatItems.length) {
                            if (e.key === 'ArrowDown') {
                              e.preventDefault();
                              setMentionIndex((i) => (i + 1) % atFlatItems.length);
                              return;
                            }
                            if (e.key === 'ArrowUp') {
                              e.preventDefault();
                              setMentionIndex(
                                (i) => (i - 1 + atFlatItems.length) % atFlatItems.length,
                              );
                              return;
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setMentionDismissed(true);
                              if (atState) setInput(input.slice(0, atState.from));
                              return;
                            }
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              const doc = atFlatItems[mentionIndex]?.doc;
                              if (doc) pickAtDoc(doc);
                              return;
                            }
                          }
                          if (e.key === 'Escape' && addMenuOpen) {
                            e.preventDefault();
                            setAddMenuOpen(false);
                            return;
                          }
                          if (e.key === 'Escape' && (atState || pluginSlashState)) {
                            e.preventDefault();
                            setMentionDismissed(true);
                            setPluginMenuDismissed(true);
                            const from = atState?.from ?? pluginSlashState?.from;
                            if (from != null) setInput(input.slice(0, from));
                            return;
                          }
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            const alt = e.metaKey || e.ctrlKey;
                            if (streamingRef.current) {
                              // Cmd/Ctrl+Enter：插话；有队列时带着队列后续自主续发
                              if (alt) {
                                const draft = input.trim();
                                const hasDraft =
                                  Boolean(draft) ||
                                  attachments.length > 0 ||
                                  images.length > 0 ||
                                  docRefs.length > 0;
                                if (hasDraft) {
                                  const extra: PendingSend = {
                                    id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                                    content: draft,
                                    files: [...attachments],
                                    refs: [...docRefs],
                                    imgs: [...images],
                                  };
                                  clearComposer();
                                  flushQueueAsInterrupt(extra);
                                } else if (sendQueueRef.current.length) {
                                  flushQueueAsInterrupt();
                                }
                                return;
                              }
                              const primary = loadGeneralPrefs().busySendBehavior ?? 'queue';
                              void send(undefined, { forceBusy: primary });
                            } else {
                              void send();
                            }
                          }
                        }}
                        rows={1}
                        placeholder={
                          !settings
                            ? '请先配置模型（左下角「设置」→ 模型）'
                            : sendQueue.length > 0 && streaming
                              ? 'Cmd/Ctrl+Enter 插话发送全部排队消息'
                              : !knowledgeOn
                                ? hasWorkspace
                                  ? '请输入内容，或用 @ 引用工作区文件'
                                  : '请输入内容（@ 引用文档需先启用「知识库检索」）'
                                : '请输入内容，或用 @ 引用文档'
                        }
                        className="tw-chat-input block min-w-0 flex-1 min-h-13 pl-0 pr-2 pt-1.5 pb-0.5 bg-transparent resize-none focus:outline-none placeholder:text-(--tw-label-tertiary)"
                      />
                    </div>
                  </div>

                  {/* 始终单行；窄容器下工作区 / 权限文字由 .tw-composer-bar 的 container query 收成图标 */}
                  <div className="tw-composer-bar flex items-center gap-1.5 px-3 pb-3 pt-3">
                    {/* 「+」：打开输入框上方添加面板（对齐 dsh） */}
                    <button
                      type="button"
                      data-add-menu-btn
                      aria-label={
                        planPhase === 'off'
                          ? '添加'
                          : planPhase === 'planning'
                            ? '添加（计划模式·探查中）'
                            : '添加（计划模式·已批准）'
                      }
                      onClick={() => {
                        setAddMenuOpen((v) => !v);
                        setMentionDismissed(true);
                        setPluginMenuDismissed(true);
                      }}
                      className={`tw-icon-btn w-8 h-8 shrink-0 rounded-full flex items-center justify-center outline-none focus:outline-none focus-visible:outline-none transition-colors ${
                        addMenuOpen ? 'bg-(--tw-session-hover-bg)' : ''
                      }`}
                    >
                      <Svg className="w-4 h-4">
                        <path d="M5 12h14" />
                        <path d="M12 5v14" />
                      </Svg>
                    </button>

                    {/* dsh：输入栏工作区 picker（显式当前目录，可切换 / 添加） */}
                    {fsLive && (
                      <Menu>
                        <MenuButton
                          title={composerWsPath ? `工作区：${composerWsPath}` : '选择工作区'}
                          aria-label={composerWsLabel ? `工作区：${composerWsLabel}` : '选择工作区'}
                          disabled={wsBusy}
                          className="tw-composer-bar-ws group flex items-center gap-1 h-7 shrink-0 max-w-[min(40vw,11rem)] pl-1.5 pr-1 text-[13px] leading-5 font-medium text-stone-600 rounded-md outline-none focus:outline-none focus-visible:outline-none hover:bg-stone-100 data-[open]:bg-stone-100 transition-colors disabled:opacity-50"
                        >
                          <FolderIcon className="w-3.5 h-3.5 shrink-0 text-stone-500" />
                          <span className="tw-composer-bar-label truncate">{composerWsLabel}</span>
                          <ChevronIcon className="tw-composer-bar-chevron w-3.5 h-3.5 shrink-0 text-stone-400 transition-transform group-data-[open]:rotate-180" />
                        </MenuButton>
                        <MenuItems
                          transition
                          anchor={{ to: 'top start', gap: 8 }}
                          className="tw-select-menu tw-menu-anim z-50 w-[min(100vw-2rem,16rem)] rounded-xl border border-stone-200 py-1 shadow-xl focus:outline-none"
                        >
                          {(workspaceInfo?.items ?? []).map((item) => {
                            const active = item.path === composerWsPath;
                            return (
                              <MenuItem key={item.id}>
                                <button
                                  type="button"
                                  disabled={wsBusy}
                                  onClick={() => void pickComposerWorkspace(item)}
                                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left data-[focus]:bg-stone-100 disabled:opacity-50"
                                >
                                  <FolderIcon className="w-4 h-4 shrink-0 text-stone-500" />
                                  <span
                                    className={`flex-1 min-w-0 truncate text-[13px] ${
                                      active ? 'text-stone-900 font-medium' : 'text-stone-700'
                                    }`}
                                    data-hint={item.path}
                                  >
                                    {workspaceDisplayName(item, projectRootPath)}
                                  </span>
                                  {active && (
                                    <CheckIcon className="w-3.5 h-3.5 shrink-0 text-[#4176e6]" />
                                  )}
                                </button>
                              </MenuItem>
                            );
                          })}
                          {(workspaceInfo?.items?.length ?? 0) > 0 && (
                            <div className="my-1 border-t border-stone-100" />
                          )}
                          <MenuItem>
                            <button
                              type="button"
                              disabled={wsBusy}
                              onClick={() => void addWorkspaceByPicker()}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] text-stone-700 data-[focus]:bg-stone-100 disabled:opacity-50"
                            >
                              <span className="w-4 h-4 shrink-0 flex items-center justify-center text-stone-500 text-base leading-none">
                                +
                              </span>
                              添加工作区...
                            </button>
                          </MenuItem>
                        </MenuItems>
                      </Menu>
                    )}

                    {/* 访问权限（dsh 左侧权限菜单） */}
                    <Menu>
                      <MenuButton
                        title={`访问权限：${accessOpt.label}`}
                        aria-label={`访问权限：${accessOpt.label}`}
                        className="tw-composer-bar-access group flex items-center gap-1 h-7 shrink-0 max-w-55 pl-2 pr-1 text-[13px] leading-5 font-medium text-stone-600 rounded-md outline-none focus:outline-none focus-visible:outline-none hover:bg-stone-100 data-[open]:bg-stone-100 transition-colors"
                      >
                        <ShieldIcon
                          level={access}
                          className="w-3.5 h-3.5 shrink-0 text-stone-500"
                        />
                        <span className="tw-composer-bar-label truncate">{accessOpt.label}</span>
                        <span
                          className={`ml-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                            fsLive ? 'bg-emerald-500' : 'bg-stone-300'
                          }`}
                          data-hint={fsLive ? 'Runner 在线' : 'Runner 离线'}
                        />
                        <ChevronIcon className="tw-composer-bar-chevron w-3.5 h-3.5 shrink-0 text-stone-400 transition-transform group-data-[open]:rotate-180" />
                      </MenuButton>
                      <MenuItems
                        transition
                        anchor={{ to: 'top start', gap: 8 }}
                        className="tw-select-menu tw-menu-anim z-50 w-56 rounded-xl border border-stone-200 p-1 shadow-xl focus:outline-none"
                      >
                        <div className="px-3 py-1.5 text-[11px] text-stone-400">
                          {fsLive ? '本地文件服务已连接' : '本地文件服务未就绪'}
                        </div>
                        {ACCESS_OPTIONS.map((o) => {
                          // 插件开发要改项目源码：胶囊激活期间不允许降到「仅可查看」
                          const locked = pluginDevChipActive && o.value === 'readonly';
                          return (
                            <MenuItem key={o.value} disabled={locked}>
                              <button
                                type="button"
                                disabled={locked}
                                onClick={() => {
                                  // 只改当前会话：设置页的「权限」是新会话默认值，不参与已有会话
                                  setAccess(o.value);
                                  if (storeRef.current) {
                                    commitStore(
                                      updateActiveSessionMeta(storeRef.current, {
                                        access: o.value,
                                      }),
                                    );
                                  }
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[13px] data-[focus]:bg-stone-100 disabled:cursor-not-allowed"
                              >
                                <ShieldIcon
                                  level={o.value}
                                  className={`w-4 h-4 shrink-0 ${locked ? 'text-stone-300' : 'text-stone-500'}`}
                                />
                                <span
                                  className={`flex-1 ${
                                    locked
                                      ? 'text-stone-400'
                                      : access === o.value
                                        ? 'text-stone-900 font-medium'
                                        : 'text-stone-700'
                                  }`}
                                >
                                  {o.label}
                                </span>
                                {locked ? (
                                  <span className="text-[11px] text-stone-400">
                                    插件开发需要写入
                                  </span>
                                ) : access === o.value ? (
                                  <CheckIcon className="w-3.5 h-3.5 text-[#4176e6]" />
                                ) : null}
                              </button>
                            </MenuItem>
                          );
                        })}
                      </MenuItems>
                    </Menu>

                    <span className="flex-1" />

                    <ModelEffortMenu settings={settings} />

                    {/* 发送 / 停止同一座位：生成中点按停止；空闲点按发送（繁忙续发仍可用 Enter） */}
                    <button
                      type="button"
                      onClick={() => {
                        if (streamingRef.current) {
                          stop();
                          return;
                        }
                        void send();
                      }}
                      disabled={!streaming && !canSend}
                      aria-label={streaming ? '停止生成' : '发送'}
                      className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center outline-none focus:outline-none focus-visible:outline-none transition-colors ${
                        streaming
                          ? 'bg-stone-200 text-stone-700 hover:bg-stone-300'
                          : 'bg-[#4176e6] text-white hover:bg-[#3565c7] disabled:bg-[#a9c3ef] disabled:cursor-not-allowed'
                      }`}
                    >
                      {streaming ? (
                        <span className="w-2.5 h-2.5 bg-current rounded-xs" />
                      ) : (
                        <SendIcon className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <StatusBar
                  messages={messages}
                  model={settings?.model}
                  systemPromptTokens={estimateTokens(systemPrompt)}
                />
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept={[
                  ...ATTACH_ACCEPT_EXTS.map((x) => `.${x}`),
                  'image/*',
                  'text/*',
                  'application/json',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/msword',
                ].join(',')}
                onChange={(e) => void onPickFiles(e)}
              />
            </div>
          </div>
        )}
      </div>
      {pluginsOpen ? (
        <div className="tw-plugins-rail flex-1 min-w-0 min-h-0 self-stretch h-full overflow-hidden flex flex-col">
          <PluginsPage embedded />
        </div>
      ) : null}
      <CaseGenPanel
        open={caseGenPanelOpen}
        initial={caseGenConfig}
        presetStories={caseGenPreset}
        onClose={() => {
          setCaseGenPanelOpen(false);
          setCaseGenPreset(null);
        }}
        onConfirm={(cfg) => applyCaseGenConfig(cfg)}
      />
      <PromptGenPanel
        open={promptGenPanelOpen}
        initial={promptGenConfig}
        onClose={() => setPromptGenPanelOpen(false)}
        onConfirm={(cfg) => applyPromptGenConfig(cfg)}
      />
      <KnowledgeGenPanel
        open={knowledgeGenPanelOpen}
        initial={knowledgeGenConfig}
        onClose={() => setKnowledgeGenPanelOpen(false)}
        onConfirm={(cfg) => applyKnowledgeGenConfig(cfg)}
      />
      <NamePromptDialog
        open={Boolean(renameSessionId)}
        title="重命名会话"
        label="会话名称"
        placeholder="请输入会话名称"
        initialValue={
          renameSessionId
            ? (store?.sessions.find((x) => x.id === renameSessionId)?.title ?? '')
            : ''
        }
        confirmLabel="保存"
        cancelLabel="取消"
        onClose={() => setRenameSessionId(null)}
        onConfirm={confirmRenameSession}
      />
      <NamePromptDialog
        open={Boolean(wsRenameId)}
        title="重命名工作区"
        label="显示名称"
        placeholder="请输入工作区名称"
        initialValue={
          wsRenameId ? (workspaceInfo?.items.find((x) => x.id === wsRenameId)?.name ?? '') : ''
        }
        confirmLabel="保存"
        cancelLabel="取消"
        onClose={() => setWsRenameId(null)}
        onConfirm={(name) => void confirmRenameWorkspace(name)}
      />
      <ConfirmDialog
        open={Boolean(purgeSessionId)}
        title="删除会话"
        message={
          purgeSessionId
            ? `确定永久删除「${store?.sessions.find((x) => x.id === purgeSessionId)?.title ?? '该会话'}」？此操作不可恢复。`
            : ''
        }
        confirmLabel="删除"
        cancelLabel="取消"
        danger="outline"
        onClose={() => setPurgeSessionId(null)}
        onConfirm={() => {
          if (!purgeSessionId) return;
          const id = purgeSessionId;
          setPurgeSessionId(null);
          purgeSession(id);
        }}
      />
      <ConfirmDialog
        open={Boolean(wsDeleteTarget)}
        title="删除工作区"
        message={
          wsDeleteTarget
            ? `将把「${wsDeleteTarget.name}」从工作区列表中移除。文件夹与会话记录会保留，其会话将归入项目根工作区。`
            : ''
        }
        confirmLabel="删除工作区"
        cancelLabel="取消"
        danger="outline"
        onClose={() => setWsDeleteTarget(null)}
        onConfirm={() => void confirmDropWorkspace()}
      />
    </div>
  );
}
