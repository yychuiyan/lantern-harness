import {
  BUSINESS_MAP_API,
  BusinessMapApiError,
  normalizeStore,
  type BusinessEvidence,
  type BusinessMapStore,
} from './business-map';

export type AssistantPhase = 'directory' | 'flow';
export type AssistantStatus =
  'idle' | 'running' | 'awaiting_confirmation' | 'stopped' | 'error' | 'interrupted';

export interface BusinessAssistantMenuEntry {
  label: string;
  path: string[];
  depth: number;
  order: number;
}

export interface AssistantProgress {
  stage: string;
  label: string;
  current: number;
  total: number;
  percent: number;
  indeterminate?: boolean;
  startedAt?: string;
  elapsedSeconds?: number;
}

export interface AssistantFallback {
  available: boolean;
  recommendedAction: 'client_fallback' | 'codex_fallback' | 'retry_login' | 'fix_capture';
  reason: string;
  pageCount: number;
  menuCount: number;
  evidenceCount: number;
  sourceChars: number;
  promptChars: number;
  promptApproxTokens: number;
  model: string;
  issues: string[];
  updatedAt: string;
}

export interface AssistantMessage {
  id: string;
  at: string;
  role: 'user' | 'assistant';
  content: string;
  phase?: AssistantPhase;
  proposalKind?: 'directory' | 'flow';
  applied?: boolean;
}

export interface AssistantEvent {
  id?: string;
  seq: number;
  at?: string;
  type: 'status' | 'tool' | 'page' | 'progress' | 'proposal' | 'warning' | 'error';
  title: string;
  detail?: string;
  status?: string;
  progress?: AssistantProgress;
}

export interface DirectoryProposal {
  kind: 'directory';
  message: string;
  directories: Array<{
    key: string;
    parentKey: string;
    name: string;
    menuPath: string[];
    entryUrl: string;
  }>;
  functions: Array<{
    name: string;
    directoryKey: string;
    purpose: string;
    entry: string;
    menuPath: string[];
    evidence: BusinessEvidence[];
  }>;
  warnings: string[];
}

export interface FlowProposal {
  kind: 'flow';
  message: string;
  flows: Array<{
    name: string;
    result: string;
    steps: Array<{
      n: number;
      title: string;
      role: string;
      system: string;
      functionId: string;
      input: string;
      output: string;
      next: string;
      branch: string;
      branchBroken: boolean;
      manual: boolean;
    }>;
    evidence: BusinessEvidence[];
  }>;
  warnings: string[];
}

export interface AssistantSession {
  version: number;
  systemId: string;
  phase: AssistantPhase;
  status: AssistantStatus;
  runId: string;
  seq: number;
  messages: AssistantMessage[];
  events: AssistantEvent[];
  progress: AssistantProgress;
  proposal: DirectoryProposal | FlowProposal | null;
  fallback: AssistantFallback | null;
  userMenuCatalog: BusinessAssistantMenuEntry[];
  directoryApplied: boolean;
  flowApplied: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessAssistantContext {
  revision: number;
  system: {
    id: string;
    name: string;
    description: string;
    entryUrl: string;
  };
  phase: AssistantPhase;
  sessionStatus: AssistantStatus;
  fallback: AssistantFallback & {
    canGenerateDirectory: boolean;
    canGenerateFlow: boolean;
  };
  checkpoint: {
    scanVersion?: number;
    entryUrl?: string;
    updatedAt?: string;
    issues: string[];
    catalog: Array<Record<string, unknown>>;
    navigation: Array<Record<string, unknown>>;
    userMenuCatalog: BusinessAssistantMenuEntry[];
  };
  current: {
    directories: Array<Record<string, unknown>>;
    functions: Array<Record<string, unknown>>;
    flows: Array<Record<string, unknown>>;
  };
  sources: Array<{
    sourceId: string;
    title: string;
    ref: string;
    content: string;
  }>;
  limits: {
    maxChars: number;
    maxCharsPerPage: number;
    truncated: boolean;
  };
}

export interface BusinessMenuOutline {
  scanVersion?: number;
  entryUrl: string;
  updatedAt: string;
  userMenuCatalog: BusinessAssistantMenuEntry[];
  navigation: Array<{
    label: string;
    path: string[];
    order: number;
  }>;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BUSINESS_MAP_API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok)
    throw new BusinessMapApiError(data.error || `HTTP ${res.status}`, res.status, data.code || '');
  return data;
}

const route = (systemId: string, suffix = '') =>
  `/systems/${encodeURIComponent(systemId)}/assistant${suffix}`;

export async function loadBusinessAssistant(systemId: string): Promise<AssistantSession> {
  const data = await request<{ session: AssistantSession }>(route(systemId));
  return data.session;
}

export async function loadBusinessMenuOutline(systemId: string): Promise<BusinessMenuOutline> {
  const data = await request<BusinessMenuOutline>(route(systemId, '/menu'));
  return {
    scanVersion: data.scanVersion,
    entryUrl: data.entryUrl || '',
    updatedAt: data.updatedAt || '',
    userMenuCatalog: Array.isArray(data.userMenuCatalog) ? data.userMenuCatalog : [],
    navigation: Array.isArray(data.navigation) ? data.navigation : [],
  };
}

export async function loadBusinessAssistantContext(
  systemId: string,
  options: {
    maxChars?: number;
    maxCharsPerPage?: number;
    includeContent?: boolean;
  } = {},
): Promise<BusinessAssistantContext> {
  const query = new URLSearchParams();
  if (options.maxChars !== undefined) query.set('maxChars', String(options.maxChars));
  if (options.maxCharsPerPage !== undefined)
    query.set('maxCharsPerPage', String(options.maxCharsPerPage));
  if (options.includeContent !== undefined)
    query.set('includeContent', String(options.includeContent));
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : '';
  return request<BusinessAssistantContext>(route(systemId, `/context${suffix}`));
}

export async function sendBusinessAssistantMessage(
  systemId: string,
  body: {
    revision: number;
    phase: AssistantPhase;
    message: string;
    refresh?: boolean;
    maxPages?: number;
    settings: {
      baseURL: string;
      apiKey: string;
      model: string;
      reasoningEffort?: string;
    };
  },
): Promise<AssistantSession> {
  const data = await request<{ session: AssistantSession }>(route(systemId, '/messages'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.session;
}

export async function stopBusinessAssistant(systemId: string): Promise<AssistantSession> {
  const data = await request<{ session: AssistantSession }>(route(systemId, '/stop'), {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return data.session;
}

export async function resetBusinessAssistant(systemId: string): Promise<AssistantSession> {
  const data = await request<{ session: AssistantSession }>(route(systemId, '/reset'), {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return data.session;
}

export async function applyBusinessAssistant(
  systemId: string,
  revision: number,
): Promise<{ session: AssistantSession; store: BusinessMapStore }> {
  const data = await request<{
    session: AssistantSession;
    store: BusinessMapStore;
  }>(route(systemId, '/apply'), {
    method: 'POST',
    body: JSON.stringify({ revision }),
  });
  return { session: data.session, store: normalizeStore(data.store) };
}

export function watchBusinessAssistant(
  systemId: string,
  afterSeq: number,
  handlers: {
    onEvent: (event: AssistantEvent) => void;
    onDisconnect?: (error?: Error) => void;
    signal?: AbortSignal;
  },
): () => void {
  const controller = new AbortController();
  const external = handlers.signal;
  let stopped = false;
  let seq = Math.max(0, afterSeq);
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller.abort();
  };
  external?.addEventListener('abort', abort, { once: true });

  const connect = async () => {
    if (stopped || external?.aborted) return;
    try {
      const res = await fetch(
        `${BUSINESS_MAP_API}${route(systemId, '/events')}?after=${encodeURIComponent(seq)}`,
        {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        },
      );
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      retry = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (!stopped && !external?.aborted) {
            timer = setTimeout(() => void connect(), 800);
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          try {
            const event = JSON.parse(trimmed.slice(5).trim()) as AssistantEvent;
            if (Number.isFinite(event.seq)) seq = Math.max(seq, event.seq);
            handlers.onEvent(event);
          } catch {
            // Ignore malformed SSE frames.
          }
        }
      }
    } catch (error) {
      if (stopped || external?.aborted) return;
      retry += 1;
      if (retry >= 8) {
        handlers.onDisconnect?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      handlers.onDisconnect?.(error instanceof Error ? error : new Error(String(error)));
      timer = setTimeout(() => void connect(), Math.min(5000, 500 * retry));
    }
  };
  void connect();
  return abort;
}
