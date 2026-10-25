/**
 * 会话压缩管线（compaction-basic + command-compact 共用）：
 * 估算体量 → 摘要较早消息 → 保留最近若干轮。
 */
import type { ChatMessage } from './llm';
import { MODEL_CONTEXT_WINDOW, completePlain } from './llm';
import type { LLMSettings } from './settings';

/** 无窗口信息时的字符阈值（约 20k tokens） */
export const AUTO_COMPACT_CHARS = 80_000;
/** 自动压缩：约占模型窗口的比例（按 chars≈tokens*4） */
export const AUTO_COMPACT_WINDOW_RATIO = 0.28;
/** 压缩后保留的最近消息条数（user/assistant） */
export const KEEP_RECENT_MESSAGES = 8;

export interface CompactableMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
}

export function messageTextLen(m: CompactableMessage): number {
  return (m.content?.length ?? 0) + (m.reasoning?.length ?? 0);
}

export function estimateMessagesChars(messages: CompactableMessage[]): number {
  return messages.reduce((n, m) => n + messageTextLen(m), 0);
}

export function autoCompactThresholdChars(model?: string, contextWindowOverride?: number): number {
  const window =
    typeof contextWindowOverride === 'number' && contextWindowOverride > 0
      ? contextWindowOverride
      : model
        ? MODEL_CONTEXT_WINDOW[model]
        : undefined;
  if (window && window > 0) {
    return Math.max(24_000, Math.floor(window * 4 * AUTO_COMPACT_WINDOW_RATIO));
  }
  return AUTO_COMPACT_CHARS;
}

export function needsAutoCompact(
  messages: CompactableMessage[],
  model?: string,
  contextWindowOverride?: number,
): boolean {
  return estimateMessagesChars(messages) >= autoCompactThresholdChars(model, contextWindowOverride);
}

function flattenForSummary(messages: CompactableMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const body = (m.content || '').trim();
      const think = m.reasoning?.trim() ? `\n[thinking]\n${m.reasoning.trim().slice(0, 1200)}` : '';
      return `${role}:\n${body.slice(0, 6000)}${think}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 60_000);
}

export async function summarizeOlderMessages(
  settings: LLMSettings,
  older: CompactableMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const transcript = flattenForSummary(older);
  if (!transcript.trim()) return '';
  const prompt: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是会话压缩助手。将对话历史压缩为简洁中文摘要，保留：目标、关键决策、文件路径、未完成事项、约束。' +
        '不要编造；不要输出寒暄；用条目或短段落，控制在 800 字以内。',
    },
    {
      role: 'user',
      content: `请压缩下列对话历史：\n\n${transcript}`,
    },
  ];
  const text = (await completePlain(settings, prompt, signal)).trim();
  return text || '（摘要为空）';
}

/**
 * 压缩：摘要 older，再拼 recent。
 * 返回可写回会话的 user/assistant 列表（首条为摘要块）。
 */
export async function compactMessageList(
  settings: LLMSettings,
  messages: CompactableMessage[],
  opts?: {
    keepRecent?: number;
    signal?: AbortSignal;
    force?: boolean;
    contextWindow?: number;
  },
): Promise<{ messages: CompactableMessage[]; summary: string; compacted: boolean }> {
  const keep = Math.max(2, opts?.keepRecent ?? KEEP_RECENT_MESSAGES);
  if (messages.length <= keep + 1) {
    return { messages, summary: '', compacted: false };
  }
  if (!opts?.force && !needsAutoCompact(messages, settings.model, opts?.contextWindow)) {
    return { messages, summary: '', compacted: false };
  }

  const older = messages.slice(0, -keep);
  const recent = messages.slice(-keep);
  const summary = await summarizeOlderMessages(settings, older, opts?.signal);
  const nowBlock: CompactableMessage[] = [
    {
      role: 'user',
      content: `【会话摘要 · 较早消息已压缩】\n${summary}`,
    },
    {
      role: 'assistant',
      content: '已记录摘要。后续回复将基于摘要与最近对话继续。',
    },
  ];
  return { messages: [...nowBlock, ...recent], summary, compacted: true };
}

/** 识别手动 /compact 命令（整行） */
export function isCompactCommand(text: string): boolean {
  return /^\/compact(?:\s|$)/i.test(text.trim());
}
