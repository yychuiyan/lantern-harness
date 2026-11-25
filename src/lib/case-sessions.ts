/**
 * 用例生成会话（与 AI 工作台会话隔离）
 */
import { CASE_TYPE_OPTS, caseTypeMeta, listCaseTypes, type CaseType } from './case-types';
import { spaceScopedKey } from './space-scope';

export type CaseOutputFormat = 'md' | 'xlsx' | 'csv';

export type { CaseType };
export { CASE_TYPE_OPTS, caseTypeMeta, listCaseTypes };

export interface CaseGenResultMeta {
  ok: boolean;
  count: number;
  path?: string;
  /** 重新生成前保留的旧稿备份（相对 cases/） */
  backupPath?: string;
  durationMs?: number;
  finishedAt?: number;
  omissions?: string[];
  error?: string;
}

export interface CaseSessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  time?: number;
  /** 助手消息的结构化结果（界面展示用，不再展示原始 JSON） */
  result?: CaseGenResultMeta;
}

export interface CaseSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  caseType: CaseType;
  outputFormat: CaseOutputFormat;
  reqPaths: string[];
  templateId?: string;
  templateTitle?: string;
  promptPath?: string;
  /** 引用知识库路径（相对 knowledge/） */
  knowledgePaths?: string[];
  linkedCasePath?: string;
  messages: CaseSessionMessage[];
}

export interface CaseSessionStore {
  sessions: CaseSession[];
  activeId: string;
}

const API = '/__tb_case_sessions';
const LS_KEY = 'tw.case.sessions.v1';

let fileMode = false;

function uid(): string {
  return `csess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeCaseType(v: unknown): CaseType {
  if (typeof v === 'string' && v.trim()) {
    const id = v.trim();
    const known = listCaseTypes();
    if (known.some((x) => x.id === id)) return id;
    // 历史或已删类型：仍保留 id，meta 会回退到第一项展示
    return id;
  }
  return listCaseTypes()[0]?.id ?? 'functional';
}

function normalize(raw: Partial<CaseSessionStore> | null | undefined): CaseSessionStore {
  if (!raw || !Array.isArray(raw.sessions)) return { sessions: [], activeId: '' };
  const sessions = (
    raw.sessions.filter((s) => s && typeof s === 'object' && s.id) as CaseSession[]
  ).map((s) => ({
    ...s,
    caseType: normalizeCaseType(s.caseType),
  }));
  let activeId = typeof raw.activeId === 'string' ? raw.activeId : '';
  if (sessions.length && !sessions.some((s) => s.id === activeId)) activeId = sessions[0]!.id;
  if (!sessions.length) activeId = '';
  return { sessions, activeId };
}

function readLs(): CaseSessionStore {
  try {
    const raw = localStorage.getItem(spaceScopedKey(LS_KEY));
    if (!raw) return { sessions: [], activeId: '' };
    return normalize(JSON.parse(raw));
  } catch {
    return { sessions: [], activeId: '' };
  }
}

function writeLs(store: CaseSessionStore) {
  try {
    localStorage.setItem(spaceScopedKey(LS_KEY), JSON.stringify(store));
  } catch {
    // ignore
  }
}

export async function hydrateCaseSessions(): Promise<CaseSessionStore> {
  try {
    const res = await fetch(API, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = (await res.json()) as { store?: Partial<CaseSessionStore> };
      fileMode = true;
      const store = normalize(data.store);
      writeLs(store);
      return store;
    }
  } catch {
    // fallthrough
  }
  fileMode = false;
  return readLs();
}

export function loadCaseSessions(): CaseSessionStore {
  return readLs();
}

async function persist(store: CaseSessionStore) {
  writeLs(store);
  if (!fileMode) return;
  try {
    await fetch(API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store }),
    });
  } catch {
    // keep LS
  }
}

export function saveCaseSessions(store: CaseSessionStore): void {
  writeLs(store);
  void persist(store);
}

export function createCaseSession(input: {
  title?: string;
  caseType: CaseType;
  outputFormat: CaseOutputFormat;
  reqPaths: string[];
  templateId?: string;
  templateTitle?: string;
  promptPath?: string;
  knowledgePaths?: string[];
}): CaseSession {
  const now = Date.now();
  const session: CaseSession = {
    id: uid(),
    title: input.title?.trim() || '用例生成',
    createdAt: now,
    updatedAt: now,
    caseType: input.caseType,
    outputFormat: input.outputFormat,
    reqPaths: input.reqPaths,
    templateId: input.templateId,
    templateTitle: input.templateTitle,
    promptPath: input.promptPath,
    knowledgePaths: input.knowledgePaths?.length ? [...input.knowledgePaths] : undefined,
    messages: [],
  };
  const cur = readLs();
  const next = { sessions: [session, ...cur.sessions], activeId: session.id };
  saveCaseSessions(next);
  return session;
}

export function updateCaseSession(id: string, patch: Partial<CaseSession>): CaseSessionStore {
  const cur = readLs();
  const sessions = cur.sessions.map((s) =>
    s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s,
  );
  const next = { ...cur, sessions };
  saveCaseSessions(next);
  return next;
}

export function findCaseSessionByPath(linkedCasePath: string): CaseSession | undefined {
  return readLs().sessions.find((s) => s.linkedCasePath === linkedCasePath);
}

export function isCaseSessionsFileMode(): boolean {
  return fileMode;
}
