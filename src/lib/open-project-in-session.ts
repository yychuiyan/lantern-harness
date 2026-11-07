/**
 * 自动化项目「在会话中打开」：把项目目录注册成工作区，再跳到工作台里的对应会话。
 *
 * 与「文档在会话中打开」的区别：这里绑定的是**工作区归属**（session.workspacePath），
 * 而不是文件 chip。会话归属之后，侧栏分组、输入栏工作区 picker 都会自动对齐到项目目录。
 *
 * 必须先把目录注册进工作区列表：ChatApp 的 `effectiveWorkspacePathForSession` 只认
 * 注册表里的路径，没注册会被 `syncFsWorkspaceForSession` 拉回项目根。
 */
import { addWorkspace } from './fs-tools';
import { sessionHandoffKey } from './open-docs-in-session';
import {
  createSession,
  flushSessionStore,
  hydrateSessionStore,
  isLiveSession,
  loadSessionStore,
  switchSession,
  type ChatSession,
  type SessionStore,
} from './sessions';
import { hydrateAppConfig, loadAccessLevel } from './settings';
import { writeViewPref, writeViewText } from './view-prefs';

/** 目录归一：斜杠统一、去尾部斜杠、去多余空白 */
export function normalizeDirPath(dir: string): string {
  let value = String(dir ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!value) return '';
  // 盘符根目录保留结尾斜杠，避免 `C:` 这种歧义
  if (/^[a-zA-Z]:$/.test(value)) value += '/';
  return value;
}

/** 两个目录是否指向同一处：先精确比，再忽略大小写（macOS 默认卷不区分大小写） */
export function sameDirPath(a: string, b: string): boolean {
  const left = normalizeDirPath(a);
  const right = normalizeDirPath(b);
  if (!left || !right) return false;
  return left === right || left.toLowerCase() === right.toLowerCase();
}

/**
 * 复用同目录的最近一个未归档会话；没有返回 null（调用方新建）。
 * 只认 `workspacePath` 指向同一目录的会话，避免「同父目录的不同项目」串用。
 */
export function pickWorkspaceSession(sessions: ChatSession[], dir: string): ChatSession | null {
  const target = normalizeDirPath(dir);
  if (!target) return null;
  const matched = sessions.filter(
    (s) => isLiveSession(s) && sameDirPath(s.workspacePath ?? '', target),
  );
  if (!matched.length) return null;
  return [...matched].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

export interface OpenProjectInSessionResult {
  sessionId: string;
}

/**
 * 跳到工作台的对应会话（必要时新建），并让该项目目录成为当前工作区。
 * 失败时抛错，由调用方 toast 提示且不跳转。
 */
export async function openProjectInSession(project: {
  id: string;
  name: string;
  dir: string;
}): Promise<OpenProjectInSessionResult> {
  const dir = project.dir?.trim();
  if (!dir) throw new Error('项目目录为空，请重新指定目录');

  // 1) 注册并激活工作区：目录不存在 / 是空间上级目录时服务端会拒绝
  await addWorkspace(dir);

  // 2) 复用同目录已有会话，没有就新建一个归属该目录的空会话
  await hydrateSessionStore().catch(() => null);
  await hydrateAppConfig().catch(() => null);
  let store: SessionStore = loadSessionStore();
  const existing = pickWorkspaceSession(store.sessions, dir);
  if (existing) {
    store = switchSession(store, existing.id);
  } else {
    store = createSession(store, { workspacePath: dir, access: loadAccessLevel() });
    // 保持默认「新对话」；空会话切走时会被当成临时会话清掉，不会堆积
    await flushSessionStore(store);
  }

  const sessionId = store.activeId;
  const chat = store.sessions.find((s) => s.id === sessionId);
  if (!chat) throw new Error('无法创建或定位会话');

  // 兜底：工作台页卸载时的 debounce 写盘可能冲掉新会话，hydrate 时从这里恢复
  try {
    const seeded = store.sessions.find((s) => s.id === chat.id) ?? chat;
    sessionStorage.setItem(sessionHandoffKey(chat.id), JSON.stringify({ session: seeded }));
  } catch {
    // private mode 等忽略
  }

  // 自动化执行页仍按这个 pref 记住「上次选中的项目」
  writeViewText('ui-auto.project', project.id);
  // 工作台若停在「我的插件」覆盖层，打开会话前先关掉
  writeViewPref('plugins.open', '0');

  const base = import.meta.env.BASE_URL || '/';
  const query = new URLSearchParams({ session: sessionId });
  window.location.href = `${base}workbench/?${query.toString()}`;
  return { sessionId };
}
