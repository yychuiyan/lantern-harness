/**
 * 输入框草稿的落盘记忆（按会话 id）。
 *
 * 会话内切换本来就有内存草稿，但「切到提示词管理 / 设置页再回工作台」是一次整页加载，
 * 内存里的东西全没了——用户回来发现刚写了一半的话不见了。
 * 这里把文字草稿顺手记到 sessionStorage：同一标签页内来回切页能拿回来，
 * 关掉标签页就清掉，不会在别的窗口冒出来。
 *
 * 只存文字：附件与图片可能很大（图片是 base64），塞进 5MB 的 sessionStorage
 * 容易撑爆并连带把文字一起写失败，所以那两类仍按会话内存草稿处理。
 */

const KEY = 'lantern:composer-draft';

interface DraftMap {
  [sessionId: string]: { input: string; at: number };
}

function readMap(): DraftMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DraftMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: DraftMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 隐私模式 / 超额：记不住就算了，不能影响输入
  }
}

/** 读回某个会话上次没发出去的文字 */
export function readComposerDraft(sessionId: string | undefined | null): string {
  if (!sessionId) return '';
  return readMap()[sessionId]?.input ?? '';
}

/** 写入 / 清空某个会话的草稿（空串即删除） */
export function writeComposerDraft(sessionId: string | undefined | null, input: string): void {
  if (!sessionId) return;
  const map = readMap();
  const text = input ?? '';
  if (!text.trim()) {
    if (!map[sessionId]) return;
    delete map[sessionId];
  } else {
    map[sessionId] = { input: text, at: Date.now() };
  }
  writeMap(map);
}

/** 丢弃某个会话的草稿（发送成功 / 删除会话时） */
export function dropComposerDraft(sessionId: string | undefined | null): void {
  if (!sessionId) return;
  writeComposerDraft(sessionId, '');
}
