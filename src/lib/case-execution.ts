export { defectLinks } from '../../builtin/case-workflow-contract.mjs';
export const CASE_EXECUTION_API = '/__tb_case_run';

export interface CaseExecutionFile {
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: string;
  caseCount: number;
  executable: boolean;
  missingColumns: string[];
  executionIssue?: string;
  error?: string;
}

export interface CaseExecutionCase {
  rowIndex: number;
  id: string;
  no: string;
  title: string;
  module: string;
  priority: string;
  precondition: string;
  steps: string;
  expected: string;
  status: string;
  actual: string;
  executor: string;
  executedAt: string;
  evidence: string;
  defectNo: string;
  defectTitle: string;
  defectUrl: string;
  storedStatus?: string;
  resultStale?: boolean;
  fields?: Array<{ name: string; value: string }>;
  automation?: {
    status: string;
    total: number;
    passed: number;
    failed: number;
    items: Array<{
      automationCaseId: string;
      title: string;
      status: string;
      projectId: string;
      projectName: string;
      framework: string;
      iteration: string;
      iterationFile: string;
      tag: string;
      scriptPath: string;
      lastRunId: string;
      reportUrl: string;
      logUrl: string;
      error: string;
      updatedAt: string;
    }>;
  };
}

export interface CaseExecutionDocument {
  path: string;
  ext: string;
  fileHash: string;
  headers: string[];
  cases: CaseExecutionCase[];
  columns: {
    expected: string;
    priority: string;
    status: string;
    actual: string;
    executor: string;
    executedAt: string;
    evidence: string;
    defectNo: string;
    defectTitle: string;
    defectUrl: string;
  };
  executable: boolean;
  missingColumns: string[];
  executionIssue?: string;
  statuses: string[];
  provenance?: {
    artifactId: string;
    baselineId?: string;
    analysisId: string;
    analysisRevision: string;
    sourcePath: string;
    stale: boolean;
    tracked: boolean;
    reasons: string[];
  };
}

export interface CaseExecutionEvent {
  id?: string;
  seq: number;
  at?: string;
  type: string;
  title: string;
  detail?: string;
  status?: string;
  url?: string;
}

export interface CaseExecutionResult {
  status: string;
  actualResult: string;
  rationale: string;
  unverified: string[];
  blocker: string;
  stepResults: Array<{
    expected: string;
    actual: string;
    passed: boolean;
    evidence: string;
  }>;
}

export type NormalizedCaseExecutionStatus = '待验证' | '通过' | '不通过' | '阻塞' | '跳过';

export interface CaseExecutionSummary {
  total: number;
  executed: number;
  pending: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  executionRate: number;
}

export function normalizeCaseExecutionStatus(raw: string): NormalizedCaseExecutionStatus {
  const value = raw.trim();
  if (['待验证', '通过', '不通过', '阻塞', '跳过'].includes(value)) {
    return value as NormalizedCaseExecutionStatus;
  }
  if (/^(p|pass|passed|ok|成功|true|1)$/i.test(value)) return '通过';
  if (/^(f|fail|failed|失败|false|0)$/i.test(value)) return '不通过';
  if (/block/i.test(value)) return '阻塞';
  if (/skip|n\/?a/i.test(value)) return '跳过';
  return '待验证';
}

export function summarizeCaseExecution(
  cases: ReadonlyArray<Pick<CaseExecutionCase, 'status'>>,
): CaseExecutionSummary {
  const summary: CaseExecutionSummary = {
    total: cases.length,
    executed: 0,
    pending: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    executionRate: 0,
  };
  for (const item of cases) {
    const status = normalizeCaseExecutionStatus(item.status);
    if (status === '待验证') continue;
    summary.executed += 1;
    if (status === '通过') summary.passed += 1;
    if (status === '不通过') summary.failed += 1;
    if (status === '阻塞') summary.blocked += 1;
    if (status === '跳过') summary.skipped += 1;
  }
  summary.pending = Math.max(0, summary.total - summary.executed);
  summary.executionRate = summary.total ? Math.round((summary.executed / summary.total) * 100) : 0;
  return summary;
}

export interface CaseExecutionRun {
  version: number;
  id: string;
  casePath: string;
  caseId?: string;
  provenance?: { baselineId?: string };
  environment?: { name: string; role: string; build: string; dataNote: string };
  rowIndex: number;
  case: CaseExecutionCase;
  fileHash: string;
  target: { url: string; authPath: string };
  status:
    | 'idle'
    | 'running'
    | 'awaiting_confirmation'
    | 'confirmed'
    | 'stopped'
    | 'error'
    | 'interrupted';
  runId: string;
  seq: number;
  events: CaseExecutionEvent[];
  progress: { label: string; elapsedSeconds: number; toolCount: number };
  result: CaseExecutionResult | null;
  confirmed: {
    status: string;
    actualResult: string;
    at: string;
    backup: string;
    fileHash: string;
  } | null;
  error: string;
  createdAt: string;
  updatedAt: string;
}

interface ApiResult extends Record<string, unknown> {
  ok?: boolean;
  error?: string;
}

async function request<T extends ApiResult = ApiResult>(
  route = '',
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${CASE_EXECUTION_API}${route}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const data = (await response.json().catch(() => ({}))) as T;
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function body(value: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(value) };
}

export async function fetchCaseExecutionHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${CASE_EXECUTION_API}/health?health=1`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function listCaseExecutionFiles(): Promise<CaseExecutionFile[]> {
  return ((await request<{ files?: CaseExecutionFile[] }>('/files')).files || []).filter(Boolean);
}

export async function getCaseExecutionDocument(filePath: string): Promise<CaseExecutionDocument> {
  const data = await request<{ document?: CaseExecutionDocument }>(
    `/cases?path=${encodeURIComponent(filePath)}`,
  );
  if (!data.document) throw new Error('用例文件读取失败');
  return data.document;
}

export async function listCaseExecutionRuns(casePath = ''): Promise<CaseExecutionRun[]> {
  return (
    (await request<{ runs?: CaseExecutionRun[] }>(`/runs?path=${encodeURIComponent(casePath)}`))
      .runs || []
  );
}

export async function getCaseExecutionRun(runId: string): Promise<CaseExecutionRun> {
  const data = await request<{ run?: CaseExecutionRun }>(`/runs/${encodeURIComponent(runId)}`);
  if (!data.run) throw new Error('执行记录不存在');
  return data.run;
}

export async function checkCaseExecutionAuth(url: string): Promise<boolean> {
  return Boolean(
    (await request<{ exists?: boolean }>(`/auth/status?url=${encodeURIComponent(url)}`)).exists,
  );
}

export async function startCaseExecutionLogin(url: string): Promise<{ authId: string }> {
  return request('/auth/start', body({ url }));
}

export async function completeCaseExecutionLogin(): Promise<{ authPath: string }> {
  return request('/auth/complete', body({}));
}

export async function cancelCaseExecutionLogin(): Promise<void> {
  await request('/auth/cancel', body({}));
}

export async function startCaseExecution(params: {
  casePath: string;
  rowIndex: number;
  url: string;
  storageStatePath?: string;
}): Promise<CaseExecutionRun> {
  const data = await request<{ run?: CaseExecutionRun }>('/runs', body(params));
  if (!data.run) throw new Error('用例执行启动失败');
  return data.run;
}

export async function stopCaseExecution(runId: string): Promise<CaseExecutionRun> {
  const data = await request<{ run?: CaseExecutionRun }>(
    `/runs/${encodeURIComponent(runId)}/stop`,
    body({}),
  );
  if (!data.run) throw new Error('停止执行失败');
  return data.run;
}

export async function confirmCaseExecution(
  runId: string,
  values: {
    status: string;
    actualResult: string;
    executor?: string;
    defectNo?: string;
    expectedFileHash?: string;
  },
): Promise<CaseExecutionRun> {
  const data = await request<{ run?: CaseExecutionRun }>(
    `/runs/${encodeURIComponent(runId)}/apply`,
    body(values),
  );
  if (!data.run) throw new Error('结果写入失败');
  return data.run;
}

export async function applyManualCaseExecution(values: {
  casePath: string;
  expectedFileHash: string;
  rowIndex: number;
  status: string;
  actualResult: string;
  executor?: string;
  evidence?: string;
  defectNo?: string;
}): Promise<void> {
  await request('/manual', body(values));
}

export async function updateCaseExecutionFields(values: {
  casePath: string;
  expectedFileHash: string;
  rowIndex: number;
  updates: Array<{ header: string; value: string }>;
}): Promise<{ fileHash: string; backup: string }> {
  const data = await request<{
    applied?: { fileHash?: string; backup?: string };
  }>('/fields', body(values));
  if (!data.applied?.fileHash) throw new Error('字段保存失败');
  return {
    fileHash: data.applied.fileHash,
    backup: data.applied.backup || '',
  };
}

export function watchCaseExecutionRun(
  runId: string,
  after: number,
  onEvent: (event: CaseExecutionEvent) => void,
  onEnd: () => void,
): () => void {
  const source = new EventSource(
    `${CASE_EXECUTION_API}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
  );
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as CaseExecutionEvent);
    } catch {
      // 忽略损坏事件，等待下一条。
    }
  };
  source.onerror = () => {
    source.close();
    onEnd();
  };
  return () => source.close();
}

export async function syncCaseExecutionStats(values: {
  casePath: string;
  project: string;
  date: string;
  mode: 'preview' | 'skip' | 'overwrite';
}): Promise<{
  preview: {
    total: number;
    executed: number;
    pending: number;
    existing: { id: string } | null;
  };
  skipped?: boolean;
  overwritten?: boolean;
}> {
  return request('/stats/sync', body(values));
}
