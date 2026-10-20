/**
 * 管理页「在会话中打开」：有精确关联会话则跳转；否则新建会话，作曲区挂路径卡片（不预填正文）。
 */
import type { DocsRoot } from './project-docs';
import {
  createSession,
  flushSessionStore,
  hydrateSessionStore,
  loadSessionStore,
  type ChatSession,
} from './sessions';
import { hydrateAppConfig, loadAccessLevel } from './settings';
import { readActiveSpaceId } from './space-scope';

export type OpenDocsInSessionRoot = Extract<DocsRoot, 'cases' | 'prompts' | 'knowledge'>;

/** 跳转前写入，供 ChatApp hydrate 在 sessions.json 竞态丢失时恢复 */
export function sessionHandoffKey(sessionId: string): string {
  const space = readActiveSpaceId();
  return space ? `tb:session-handoff:${space}:${sessionId}` : `tb:session-handoff:${sessionId}`;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** 仅认插件入库的 linked*Path，避免按文件名误匹配到无关会话 */
function findExactLinkedSession(
  store: { sessions: ChatSession[] },
  root: OpenDocsInSessionRoot,
  pathNorm: string,
): ChatSession | undefined {
  return store.sessions.find((s) => {
    if (root === 'cases') {
      const lp = s.caseGen?.linkedCasePath;
      return Boolean(lp && normalizePath(lp) === pathNorm);
    }
    const lp =
      root === 'prompts' ? s.promptGen?.linkedPromptPath : s.knowledgeGen?.linkedKnowledgePath;
    return Boolean(lp && normalizePath(lp) === pathNorm);
  });
}

/**
 * 跳转到工作台会话；无关联会话时新建，作曲区挂路径 chip（不读入正文）。
 */
export async function openDocsInChatSession(
  root: OpenDocsInSessionRoot,
  entry: { path: string; name: string },
): Promise<void> {
  const base = import.meta.env.BASE_URL || '/';
  await hydrateSessionStore().catch(() => null);
  // 新会话的权限取设置页的默认值；先把配置读进来，否则会拿到未 hydrate 的空配置
  await hydrateAppConfig().catch(() => null);
  let store = loadSessionStore();
  const pathNorm = normalizePath(entry.path);

  let chat = findExactLinkedSession(store, root, pathNorm);

  if (!chat) {
    store = createSession(store, { access: loadAccessLevel() });
    // 保持默认「新对话」，无消息切走时由 isEphemeralEmptySession 丢弃
    await flushSessionStore(store);
    chat = store.sessions.find((s) => s.id === store.activeId);
  }

  if (!chat) {
    throw new Error('无法创建或定位会话');
  }

  // 兜底：工作台页卸载时的 debounce 写盘可能冲掉新会话，hydrate 时从这里恢复
  try {
    const seeded = store.sessions.find((s) => s.id === chat!.id) ?? chat;
    sessionStorage.setItem(sessionHandoffKey(chat.id), JSON.stringify({ session: seeded }));
  } catch {
    // private mode 等忽略
  }

  const q = new URLSearchParams({
    session: chat.id,
    focusRoot: root,
    focusPath: pathNorm,
    attachRoot: root,
    attachPath: pathNorm,
    attachName: entry.name,
  });
  window.location.href = `${base}workbench/?${q.toString()}`;
}
