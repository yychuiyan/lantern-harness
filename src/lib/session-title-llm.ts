/**
 * session-title-llm：用首条用户消息经 LLM 生成短标题。
 */
import { completePlain, type ChatMessage } from './llm';
import type { LLMSettings } from './settings';
import { titleFromMessages } from './sessions';

export function firstUserText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      const t = m.content.trim();
      if (t) return t;
    }
  }
  return '';
}

/** 仍是默认/截断自动标题时，适合用 LLM 起名 */
export function shouldGenerateLlmTitle(
  currentTitle: string | undefined,
  messages: Array<{ role?: string; content?: unknown }>,
): boolean {
  const title = (currentTitle || '').trim() || '新对话';
  if (
    title === '新对话' ||
    title === '新会话' ||
    title === '新编排' ||
    title === '未命名编排' ||
    /^编排\s+\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/.test(title)
  ) {
    return true;
  }
  const auto = titleFromMessages(messages as Array<{ role?: string; content?: string }>);
  return title === auto;
}

export function sanitizeLlmTitle(raw: string): string {
  let t = String(raw ?? '')
    .trim()
    .replace(/^["「『]+|["」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^标题[:：]\s*/i, '');
  // 去掉模型爱加的句号
  t = t.replace(/[。.!！]+$/g, '').trim();
  if (!t) return '';
  return t.length > 28 ? `${t.slice(0, 28)}…` : t;
}

export async function generateSessionTitleLlm(
  settings: LLMSettings,
  userText: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const text = userText.trim().slice(0, 800);
  if (!text) return null;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你为对话生成侧栏短标题。只输出标题本身：中文优先，不超过 16 个字，无引号、无标点收尾、无解释。',
    },
    {
      role: 'user',
      content: `用户首条消息：\n${text}\n\n请给出标题：`,
    },
  ];
  try {
    const out = await completePlain(settings, messages, signal);
    const title = sanitizeLlmTitle(out);
    return title || null;
  } catch {
    return null;
  }
}
