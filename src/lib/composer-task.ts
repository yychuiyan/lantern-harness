/**
 * 输入区的「任务卡」：一份可以展开预览 / 修改的长要求，按会话放在 sessionStorage。
 *
 * 为什么需要它：从评审抽屉跳过来时，要带给模型的是一长段结构化要求（改哪几条、每条扣分原因、
 * 写回规则）。直接塞进输入框会把作曲区撑满，用户想自己补一句都看不清。
 * 这里只把一段短标题显示成胶囊，正文随消息一起发出去：
 * - 输入框有内容 → 正文接在后面；
 * - 输入框为空 → 正文就是这条消息。
 * 关掉标签页即清，不会串到别的窗口。
 */
export interface ComposerTask {
  id: string;
  /** 胶囊上显示的一行文案 */
  label: string;
  /** 胶囊上的补充说明（条数 / 文件名等） */
  detail?: string;
  /** 完整要求：发送时随消息带上 */
  body: string;
  at: number;
}

const KEY = 'lantern:composer-task';

type TaskMap = Record<string, ComposerTask[]>;

function readMap(): TaskMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TaskMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: TaskMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 隐私模式 / 超额：记不住就算了，不能挡住正常输入
  }
}

/** 某个会话挂着的任务卡（最新的在后） */
export function readComposerTasks(sessionId: string | undefined | null): ComposerTask[] {
  if (!sessionId) return [];
  const list = readMap()[sessionId];
  return Array.isArray(list)
    ? list.filter((t) => t && t.id && typeof t.body === 'string' && t.body.trim())
    : [];
}

export function writeComposerTasks(
  sessionId: string | undefined | null,
  list: ComposerTask[],
): void {
  if (!sessionId) return;
  const map = readMap();
  const clean = list.filter((t) => t.id && t.body.trim());
  if (clean.length) map[sessionId] = clean;
  else delete map[sessionId];
  writeMap(map);
}

/** 新增一张任务卡；同一 id 覆盖，避免重复跳转叠出一堆一样的卡片 */
export function addComposerTask(sessionId: string | undefined | null, task: ComposerTask): void {
  if (!sessionId) return;
  const list = readComposerTasks(sessionId).filter((t) => t.id !== task.id);
  writeComposerTasks(sessionId, [...list, task]);
}

export function removeComposerTask(sessionId: string | undefined | null, id: string): void {
  if (!sessionId) return;
  writeComposerTasks(
    sessionId,
    readComposerTasks(sessionId).filter((t) => t.id !== id),
  );
}

/** 发送时把任务卡正文拼进消息；没有卡片就返回空串 */
export function joinTaskBodies(tasks: readonly ComposerTask[]): string {
  return tasks
    .map((t) => t.body.trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
}
