/**
 * 自动化「编排会话」：工作台 ChatSession ↔ uiauto 生成会话双向关联。
 * 消息只存工作台侧；IR/plan/草稿仍在 uiauto sessions JSON。
 */
import { addWorkspace } from './fs-tools';
import {
  createSession,
  flushSessionStore,
  hydrateSessionStore,
  isLiveSession,
  loadSessionStore,
  switchSession,
  updateSessionMeta,
  updateSessionMessages,
  type ChatSession,
  type SessionStore,
  type UiAutoSessionMeta,
} from './sessions';
import { hydrateAppConfig } from './settings';
import { normalizeDirPath, sameDirPath } from './open-project-in-session';

export type { UiAutoSessionMeta };

export type UiAutoOrchestrateStatus =
  'draft' | 'planning' | 'exploring' | 'explored' | 'verifying' | 'failed' | 'written';

export function isUiAutoOrchestrateSession(s: ChatSession | null | undefined): boolean {
  return Boolean(s?.uiAuto?.uiautoSessionId && s?.uiAuto?.projectId);
}

/** 普通「在会话中打开」复用时跳过编排会话，避免抢绑定 */
export function isPlainWorkspaceSession(s: ChatSession): boolean {
  return isLiveSession(s) && !isUiAutoOrchestrateSession(s);
}

export function findOrchestrateSession(
  sessions: ChatSession[],
  opts: { projectId?: string; uiautoSessionId?: string; chatSessionId?: string },
): ChatSession | null {
  const { projectId, uiautoSessionId, chatSessionId } = opts;
  const matched = sessions.filter((s) => {
    if (!isLiveSession(s) || !s.uiAuto) return false;
    if (chatSessionId && s.id === chatSessionId) return true;
    if (uiautoSessionId && s.uiAuto.uiautoSessionId === uiautoSessionId) return true;
    if (projectId && !uiautoSessionId && !chatSessionId && s.uiAuto.projectId === projectId) {
      return true;
    }
    return false;
  });
  if (!matched.length) return null;
  if (uiautoSessionId || chatSessionId) return matched[0];
  return [...matched].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

export function listOrchestrateSessionsForProject(
  sessions: ChatSession[],
  projectId: string,
): ChatSession[] {
  return sessions
    .filter(
      (s) => isLiveSession(s) && s.uiAuto?.projectId === projectId && s.uiAuto?.uiautoSessionId,
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** 生成会话是否已经跑过流程（有计划 / IR / 非草稿状态）——未执行前过程区保持空对话 */
export function genSessionHasExecution(
  session:
    | {
        status?: string;
        plan?: unknown[] | null;
        ir?: { steps?: unknown[] | null } | null;
      }
    | null
    | undefined,
): boolean {
  if (!session) return false;
  const status = String(session.status || 'draft').trim();
  if (status && status !== 'draft') return true;
  if (Array.isArray(session.plan) && session.plan.length > 0) return true;
  if (Array.isArray(session.ir?.steps) && session.ir.steps.length > 0) return true;
  return false;
}

/**
 * 生成页会话下拉：与工作台编排会话对齐。
 * - 有 chatSessionId / 或工作台 uiAuto 反查到关联：仅当对应工作台会话仍存活（未归档/未删）时展示
 * - 从未关联过工作台的旧域会话：仍保留，打开时懒绑定
 */
export function filterGenSessionsByWorkbench<T extends { id: string; chatSessionId?: string }>(
  genSessions: T[],
  chatSessions: ChatSession[],
): T[] {
  const byId = new Map(chatSessions.map((s) => [s.id, s]));
  const linkedByGenId = new Map<string, ChatSession[]>();
  for (const s of chatSessions) {
    const genId = String(s.uiAuto?.uiautoSessionId || '').trim();
    if (!genId) continue;
    const bucket = linkedByGenId.get(genId);
    if (bucket) bucket.push(s);
    else linkedByGenId.set(genId, [s]);
  }
  return genSessions.filter((g) => {
    const chatId = String(g.chatSessionId || '').trim();
    if (chatId) {
      const chat = byId.get(chatId);
      return Boolean(chat && isLiveSession(chat));
    }
    const linked = linkedByGenId.get(g.id);
    if (linked?.length) {
      // 工作台侧已挂过（含已归档）：只看是否还有存活关联
      return linked.some((s) => isLiveSession(s));
    }
    // 从未关联：保留，首次打开会懒绑定
    return true;
  });
}

/** 新建编排时的默认名（列表 / 会话共用） */
export function defaultOrchestrateTitle(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `编排 ${now.getMonth() + 1}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 仍是占位名：可被 LLM / 需求摘要覆盖 */
export function isPlaceholderOrchestrateTitle(title: string | undefined): boolean {
  const t = String(title || '').trim();
  if (!t || t === '新对话' || t === '新会话' || t === '新编排' || t === '未命名编排') return true;
  return /^编排\s+\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/.test(t);
}

/** 编排会话标题：只用需求摘要，不带项目名前缀（侧栏已按工作区分组） */
function titleForOrchestrate(_projectName: string, requirement: string): string {
  const req = requirement.trim().replace(/\s+/g, ' ');
  if (!req) return defaultOrchestrateTitle();
  const head = req.length > 24 ? `${req.slice(0, 24)}…` : req;
  return head.length > 40 ? `${head.slice(0, 39)}…` : head;
}

/** 展示用：去掉历史「项目名 · 」前缀 */
export function displayOrchestrateTitle(title: string): string {
  const raw = String(title || '').trim();
  if (!raw) return '未命名编排';
  const stripped = raw.replace(/^[^·\n]{1,40}\s*·\s+/, '').trim();
  return stripped || raw;
}

/** 编排会话计划写入后通知详情页刷新右侧步骤栏 */
export const UIAUTO_PLAN_UPDATED_EVENT = 'lantern:uiauto-plan-updated';

/** 嵌入编排会话时追加到 system：挡住「直接出码 / 跑测试」，并要求写入步骤栏 */
export const ORCHESTRATE_CHAT_DISCIPLINE = [
  '【脚本编排阶段】',
  '- 当前是「脚本编排」会话：只帮用户把自动化需求拆成步骤（动作 + 目标描述），供左侧步骤栏确认。',
  '- 禁止创建、修改、删除任何测试或源码文件；禁止运行 playwright / pytest / npm test / pnpm test 等命令。',
  '- 禁止打开浏览器或做页面探索、绑定定位器；那是用户点「确认并探索」之后的事。',
  '- 得出或用户确认步骤后，必须调用 ui_plan_steps 把完整计划写入左侧步骤栏；只在回复里列步骤不够。',
  '- 出码由平台完成：用户在会话里发送「生成代码」或「重新出码」即可，你不要手写完整测试代码。',
  '- 用中文简短说明即可。',
].join('\n');

/** 编排会话快捷指令：生成 / 重新出码（ChatApp 拦截后派发） */
export const UIAUTO_ORCHESTRATE_ACTION_EVENT = 'lantern:uiauto-orchestrate-action';

function orchestrateSeedMessage(title: string): string {
  return `已关联编排「${title}」。用一句话说清要测的流程，我会拆成步骤并写入右侧；确认并探索之前不会开浏览器、写代码或跑测试。`;
}

function isOrchestrateSeedContent(content: unknown): boolean {
  const text = String(content ?? '').trim();
  return text.startsWith('已关联自动化编排') || text.startsWith('已关联编排');
}

export interface EnsureOrchestrateResult {
  store: SessionStore;
  chatSessionId: string;
  created: boolean;
}

/**
 * 确保存在与 uiauto 生成会话绑定的工作台会话（workspacePath = 项目目录）。
 * 已有绑定则复用；否则新建并写 uiAuto meta + 占位消息（防被当临时会话清掉）。
 */
export async function ensureOrchestrateChatSession(input: {
  projectId: string;
  projectName: string;
  projectDir: string;
  uiautoSessionId: string;
  requirement?: string;
  status?: string;
  /** 强制新建一条编排（同项目多轮） */
  forceNew?: boolean;
}): Promise<EnsureOrchestrateResult> {
  const dir = normalizeDirPath(input.projectDir);
  if (!dir) throw new Error('项目目录为空');
  if (!input.uiautoSessionId) throw new Error('缺少生成会话 id');

  await addWorkspace(dir);
  await hydrateSessionStore().catch(() => null);
  await hydrateAppConfig().catch(() => null);

  let store = loadSessionStore();
  if (!input.forceNew) {
    const existing = findOrchestrateSession(store.sessions, {
      uiautoSessionId: input.uiautoSessionId,
    });
    if (existing) {
      const fallback = titleForOrchestrate(input.projectName, input.requirement || '');
      const rawTitle = String(existing.title || '').trim();
      const nextTitle = !isPlaceholderOrchestrateTitle(rawTitle)
        ? displayOrchestrateTitle(rawTitle)
        : fallback;
      store = updateSessionMeta(store, existing.id, {
        workspacePath: dir,
        access: 'readwrite',
        uiAuto: {
          projectId: input.projectId,
          projectName: input.projectName,
          uiautoSessionId: input.uiautoSessionId,
          status: input.status || existing.uiAuto?.status,
        },
        title: nextTitle,
      });
      // 仅占位种子、尚未真正对话时，刷新开场文案（去掉旧前缀 / 双探索表述）
      const msgs = Array.isArray(existing.messages) ? existing.messages : [];
      if (
        msgs.length === 1 &&
        isOrchestrateSeedContent((msgs[0] as { content?: string })?.content)
      ) {
        store = updateSessionMessages(
          store,
          existing.id,
          [
            {
              ...(msgs[0] as object),
              role: 'assistant',
              content: orchestrateSeedMessage(nextTitle),
            },
          ],
          { touchTitle: false },
        );
      }
      store = switchSession(store, existing.id);
      await flushSessionStore(store);
      return { store, chatSessionId: existing.id, created: false };
    }
  }

  // 编排阶段默认只读：避免模型直接改项目 / 跑测试；探索出码接通后再放开
  store = createSession(store, { workspacePath: dir, access: 'readonly' });
  const chatSessionId = store.activeId;
  const title = titleForOrchestrate(input.projectName, input.requirement || '');
  store = updateSessionMeta(store, chatSessionId, {
    title,
    access: 'readwrite',
    uiAuto: {
      projectId: input.projectId,
      projectName: input.projectName,
      uiautoSessionId: input.uiautoSessionId,
      status: input.status || 'draft',
    },
  });
  // 占位：避免空会话被当成临时会话清掉
  store = updateSessionMessages(
    store,
    chatSessionId,
    [
      {
        id: `ua_sys_${Date.now().toString(36)}`,
        role: 'assistant',
        content: orchestrateSeedMessage(title),
        createdAt: Date.now(),
      },
    ],
    { touchTitle: false },
  );
  await flushSessionStore(store);
  return { store, chatSessionId, created: true };
}

export async function syncOrchestrateStatus(opts: {
  chatSessionId: string;
  status: string;
}): Promise<void> {
  if (!opts.chatSessionId) return;
  await hydrateSessionStore().catch(() => null);
  let store = loadSessionStore();
  const hit = store.sessions.find((s) => s.id === opts.chatSessionId);
  if (!hit?.uiAuto) return;
  store = updateSessionMeta(
    store,
    opts.chatSessionId,
    {
      uiAuto: { ...hit.uiAuto, status: opts.status },
    },
    { touchUpdatedAt: true },
  );
  await flushSessionStore(store);
}

export function openWorkbenchSessionUrl(chatSessionId: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const query = new URLSearchParams({ session: chatSessionId });
  return `${base}workbench/?${query.toString()}`;
}

export function sameProjectDir(a: string, b: string): boolean {
  return sameDirPath(a, b);
}
