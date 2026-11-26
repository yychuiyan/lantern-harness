/**
 * 跨会话长期记忆（Hermes / dsh-memory-evolve 五轨子集）：
 * - 本地 `.lantern/local/memories/`（仅 npm run dev）
 * - 每回合注入 USER / MEMORY / KEY 快照
 * - 重要写入经 memory_suggest 待确认
 * - project / daily 可直写；scratch 便签
 */
import type { LLMSettings } from './settings';
import type { ChatMessage } from './llm';

const API = '/__tb_memory';

export const MEMORY_KEEP_RECENT = 10;
export const MEMORY_RECALL_TIMEOUT_MS = 3000;
export const MEMORY_CONTEXT_MAX_CHARS = 8000;

export type MemoryTrack = 'user' | 'memory' | 'key' | 'project' | 'daily';

export interface MemoryHealth {
  ok: boolean;
  mode?: string;
  path?: string;
  entryCount?: number;
  suggestionCount?: number;
  /** @deprecated 兼容旧 UI，等同 entryCount */
  entityCount?: number;
  relationCount?: number;
  tracks?: Record<string, number>;
}

export interface MemoryConfig {
  injectMemory: boolean;
  reviewEnabled: boolean;
  reviewInterval: number;
  reviewMode: 'suggest' | 'auto';
  perTurnProjectWrites: boolean;
  perTurnDailyWrites: boolean;
  perTurnKeyWrites: boolean;
  entryDatePrefix: boolean;
}

export interface MemoryEntry {
  index: number;
  text: string;
}

export interface MemoryTrackData {
  entries: MemoryEntry[];
  path?: string | null;
  target?: string;
}

export interface MemorySuggestion {
  id: string;
  time: string;
  cwd?: string | null;
  target: string;
  content: string;
  reason?: string;
  hits?: number;
}

export interface MemorySuggestionReviewContext {
  suggestions: MemorySuggestion[];
  revision: string;
  count: number;
  duplicates: Record<string, string>;
}

export interface MemorySuggestionBatchDraft {
  action: 'approve' | 'reject';
  draftId: string;
  revision: string;
  requiresConfirmation: boolean;
  selected: Array<{
    id: string;
    target: string;
    content: string;
    reason?: string;
    hits?: number;
  }>;
  duplicates: Array<{ id: string; target: string; existing: string }>;
  summary: string;
  message: string;
}

export interface MemorySuggestionBatchReceipt {
  action: 'approve' | 'reject';
  appliedAt: string;
  receipt: string;
  items: Array<{
    id: string;
    target: string;
    content: string;
    status: 'approved' | 'rejected';
  }>;
}

export interface MemorySearchHit {
  target: MemoryTrack | string;
  index: number;
  text: string;
  score?: number;
  /** 兼容旧图谱字段 */
  name?: string;
  entityType?: string;
  observations?: string[];
}

export const MEMORY_SYSTEM_HINT =
  '你可以使用跨会话长期记忆（本机五轨：user / memory / key / project / daily）：\n' +
  '- 系统可能已在 <memory_snapshot> 注入用户档案、全局事实与项目关键记忆；优先参考。\n' +
  '- 查历史进展：memory_search 或 memory_read（project / daily 不自动注入）。\n' +
  '- 用户明确要求记住偏好/全局事实/项目约定：调用 memory_suggest（进待确认，确认后才注入）。\n' +
  '- 回合进展写入：memory_append 到 project 或 daily（无需确认）。\n' +
  '- 不要把寒暄、一次性闲聊写入记忆。';

export const MEMORY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: '在五轨记忆中按关键词搜索条目。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_read',
      description: '读取某一轨的全部条目。target: user|memory|key|project|daily',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['user', 'memory', 'key', 'project', 'daily'],
          },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_suggest',
      description:
        '提议写入用户档案/全局事实/项目关键（user|memory|key）。写入待确认队列，用户采纳后才生效。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['user', 'memory', 'key'] },
          content: { type: 'string', description: '要记住的事实（简洁）' },
          reason: { type: 'string', description: '为何值得记住' },
        },
        required: ['target', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_append',
      description: '向项目日志或每日日志追加进展（直写，无需确认）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['project', 'daily'] },
          content: { type: 'string' },
        },
        required: ['target', 'content'],
      },
    },
  },
] as const;

async function postJson(path: string, body: unknown = {}, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json;
}

export async function isLocalMemoryAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchMemoryHealth(): Promise<MemoryHealth | null> {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()) as MemoryHealth;
  } catch {
    return null;
  }
}

export async function fetchMemoryConfig(): Promise<MemoryConfig | null> {
  try {
    const data = (await getJson('/config')) as { config?: MemoryConfig };
    return data.config ?? null;
  } catch {
    return null;
  }
}

export async function saveMemoryConfig(patch: Partial<MemoryConfig>): Promise<MemoryConfig> {
  const data = (await postJson('/config', patch)) as { config: MemoryConfig };
  return data.config;
}

export async function fetchMemorySnapshot(cwd = ''): Promise<string> {
  try {
    const data = (await postJson(
      '/snapshot',
      { cwd },
      AbortSignal.timeout(MEMORY_RECALL_TIMEOUT_MS),
    )) as { text?: string };
    return typeof data.text === 'string' ? data.text : '';
  } catch {
    return '';
  }
}

export async function fetchMemoryTracks(
  cwd = '',
  target: MemoryTrack | 'all' = 'all',
): Promise<{ tracks: Record<string, MemoryTrackData>; projectId?: string }> {
  const data = (await postJson('/tracks', { cwd, target })) as {
    tracks?: Record<string, MemoryTrackData>;
    entries?: MemoryEntry[];
    path?: string | null;
    target?: string;
    projectId?: string;
  };
  if (target === 'all') {
    return { tracks: data.tracks ?? {}, projectId: data.projectId };
  }
  return {
    tracks: {
      [target]: {
        entries: data.entries ?? [],
        path: data.path,
        target,
      },
    },
    projectId: data.projectId,
  };
}

export async function fetchSuggestions(): Promise<MemorySuggestion[]> {
  const data = (await getJson('/suggestions')) as { suggestions?: MemorySuggestion[] };
  return data.suggestions ?? [];
}

export async function fetchSuggestionReviewContext(): Promise<MemorySuggestionReviewContext> {
  const data = (await getJson('/suggestions/context')) as Partial<MemorySuggestionReviewContext>;
  return {
    suggestions: data.suggestions ?? [],
    revision: data.revision ?? '',
    count: data.count ?? data.suggestions?.length ?? 0,
    duplicates: data.duplicates ?? {},
  };
}

export async function createSuggestionBatchDraft(input: {
  ids: string[];
  action: 'approve' | 'reject';
  expectedRevision: string;
  allowDuplicates?: boolean;
}): Promise<MemorySuggestionBatchDraft> {
  return (await postJson('/suggestions/draft', input)) as MemorySuggestionBatchDraft;
}

export async function applySuggestionBatch(input: {
  ids: string[];
  action: 'approve' | 'reject';
  expectedRevision: string;
  draftId: string;
  allowDuplicates?: boolean;
}): Promise<MemorySuggestionBatchReceipt> {
  return (await postJson('/suggestions/apply', input)) as MemorySuggestionBatchReceipt;
}

export async function approveSuggestion(id: string): Promise<void> {
  await postJson('/suggestions/approve', { id });
}

export async function rejectSuggestion(id: string): Promise<void> {
  await postJson('/suggestions/reject', { id });
}

export async function archiveEntry(target: MemoryTrack, index: number, cwd = ''): Promise<void> {
  await postJson('/archive', { target, index, cwd });
}

/** 硬删除记忆条目（不进归档） */
export async function deleteMemoryEntry(
  target: MemoryTrack,
  index: number,
  cwd = '',
): Promise<void> {
  await postJson('/delete', { target, index, cwd });
}

/** 删除归档条目 */
export async function deleteArchiveEntry(
  target: 'user' | 'memory' | 'key',
  index: number,
  cwd = '',
): Promise<void> {
  await postJson('/archives/delete', { target, index, cwd });
}

export async function fetchArchives(
  target: 'user' | 'memory' | 'key',
  cwd = '',
): Promise<MemoryEntry[]> {
  const data = (await postJson('/archives', { target, cwd })) as { entries?: MemoryEntry[] };
  return data.entries ?? [];
}

export async function promoteArchive(
  target: 'user' | 'memory' | 'key',
  index: number,
  cwd = '',
): Promise<void> {
  await postJson('/promote', { target, index, cwd });
}

export async function manualAddMemory(
  target: 'user' | 'memory' | 'key',
  content: string,
  cwd = '',
): Promise<void> {
  await postJson('/manual-add', { target, content, cwd });
}

export async function fetchScratch(): Promise<string> {
  const data = (await getJson('/scratch')) as { content?: string };
  return data.content ?? '';
}

export async function saveScratch(content: string): Promise<void> {
  await postJson('/scratch', { content });
}

/** @deprecated 图谱已废弃；保留空实现避免旧引用炸掉 */
export interface MemoryGraph {
  entities: Array<{ name: string; entityType: string; observations: string[] }>;
  relations: Array<{ from: string; to: string; relationType: string }>;
  updatedAt?: number;
  version?: number;
}

export async function loadMemoryGraph(): Promise<MemoryGraph | null> {
  return { entities: [], relations: [], updatedAt: Date.now(), version: 3 };
}

export function formatMemoryContext(
  hits: MemorySearchHit[],
  maxChars = MEMORY_CONTEXT_MAX_CHARS,
): string {
  if (!hits.length) return '';
  const lines: string[] = ['<memory_context>', '检索到的相关记忆：'];
  for (const h of hits) {
    lines.push(`- [${h.target}] ${h.text}`);
  }
  lines.push('</memory_context>');
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n…\n</memory_context>`;
  return text;
}

/**
 * 发送前注入五轨快照（替代旧图谱召回）。
 */
export async function recallMemory(
  _query: string,
  opts?: { cwd?: string; timeoutMs?: number; maxChars?: number },
): Promise<{ context: string; hits: MemorySearchHit[] }> {
  const cwd = opts?.cwd ?? '';
  const maxChars = opts?.maxChars ?? MEMORY_CONTEXT_MAX_CHARS;
  try {
    let text = await fetchMemorySnapshot(cwd);
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars - 20)}\n…\n</memory_snapshot>`;
    }
    return { context: text, hits: [] };
  } catch {
    return { context: '', hits: [] };
  }
}

const CAPTURE_RE =
  /记住|记下|别忘了|以后都|请记得|我喜欢|我的偏好|默认用|默认显示|默认城市|约定|不要再|以后默认/;

/** 用户话术明显要求记住时，写入待确认队列（不直接落盘）。 */
export async function maybeCaptureMemory(userText: string, cwd = ''): Promise<boolean> {
  const text = userText.trim();
  if (!text || text.length < 4) return false;
  if (!CAPTURE_RE.test(text)) return false;
  const content = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  try {
    await postJson('/suggest', {
      cwd,
      target: /偏好|喜欢|习惯|称呼|默认/.test(text) ? 'user' : 'memory',
      content,
      reason: '用户话术触发自动沉淀',
    });
    return true;
  } catch {
    return false;
  }
}

export async function runMemoryTool(name: string, argsJson: string, cwd = ''): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }

  try {
    switch (name) {
      case 'memory_search': {
        const data = await postJson('/search', { query: args.query, cwd });
        return JSON.stringify(data);
      }
      case 'memory_read': {
        const data = await postJson('/tracks', { target: args.target, cwd });
        return JSON.stringify(data);
      }
      case 'memory_suggest': {
        const data = await postJson('/suggest', {
          target: args.target,
          content: args.content,
          reason: args.reason,
          cwd,
        });
        return JSON.stringify(data);
      }
      case 'memory_append': {
        const data = await postJson('/append', {
          target: args.target,
          content: args.content,
          cwd,
        });
        return JSON.stringify(data);
      }
      // 旧工具名：降级到 suggest / search，避免旧会话炸掉
      case 'memory_create_entities':
      case 'memory_add_observations': {
        const entities = Array.isArray(args.entities) ? args.entities : [];
        const observations = Array.isArray(args.observations) ? args.observations : [];
        const lines: string[] = [];
        for (const e of entities) {
          const ent = e as { name?: string; observations?: string[] };
          const obs = (ent.observations ?? []).join('；');
          lines.push(obs ? `${ent.name}: ${obs}` : String(ent.name ?? ''));
        }
        for (const o of observations) {
          const item = o as { entityName?: string; contents?: string[] };
          lines.push(`${item.entityName}: ${(item.contents ?? []).join('；')}`);
        }
        const content = lines.filter(Boolean).join('\n');
        if (!content) return JSON.stringify({ error: 'empty' });
        const data = await postJson('/suggest', {
          target: 'memory',
          content,
          reason: '兼容旧工具调用',
          cwd,
        });
        return JSON.stringify(data);
      }
      case 'memory_create_relations':
        return JSON.stringify({ ok: true, skipped: true, note: '五轨模式不使用关系图' });
      case 'memory_open_nodes': {
        const data = await postJson('/search', {
          query: Array.isArray(args.names) ? (args.names as string[]).join(' ') : '',
          cwd,
        });
        return JSON.stringify(data);
      }
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

export function buildMessagesWithMemory(
  systemPrompt: string,
  allApiMessages: ChatMessage[],
  memoryEnabled: boolean,
): ChatMessage[] {
  const system = memoryEnabled ? `${systemPrompt}\n\n${MEMORY_SYSTEM_HINT}` : systemPrompt;
  const recent = memoryEnabled ? allApiMessages.slice(-MEMORY_KEEP_RECENT) : allApiMessages;
  return [{ role: 'system', content: system }, ...recent];
}

export type SessionMemory = never;
export async function loadSessionMemory(_sessionId: string): Promise<null> {
  return null;
}
export async function deleteSessionMemory(_sessionId: string): Promise<void> {}
export async function maybeCompressMemory(
  _settings: LLMSettings,
  _sessionId: string,
  _messages: Array<{ role: string; content: string }>,
  _current: null,
): Promise<null> {
  return null;
}
