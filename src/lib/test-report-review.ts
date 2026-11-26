import type { TestReportKind } from './test-reports';

const API = '/__tb_test_report_review';

export interface TestReportStats {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  pending: number;
  executed: number;
  defects: number;
  passRate: number | null;
}

export interface TestReportCaseSource {
  path: string;
  fileHash: string;
  parseError: string;
  caseCount: number;
  headers: string[];
  cases: Array<{
    no: string;
    title: string;
    module: string;
    priority: string;
    status: string;
    actual: string;
    defectNo: string;
  }>;
}

export interface TestReportContext {
  kind: TestReportKind;
  label: string;
  sourceRevision: string;
  revision: string;
  reportPath: string;
  reportExists: boolean;
  reportHash: string;
  reportText: string;
  from: string;
  to: string;
  stats: TestReportStats;
  documents: TestReportCaseSource[];
  testStats: Array<{ id: string; date: string; dimension: string; count: number }>;
  caseExec: Array<{
    id: string;
    date: string;
    project: string;
    total: number;
    pending: number;
    executed: number;
  }>;
  gaps: string[];
  sources: {
    reports: string;
    cases: string[];
    testStats: string;
    caseExec: string;
  };
}

export interface TestReportDraft {
  draftId: string;
  revision: string;
  expiresAt: string;
  reportPath: string;
  stats: TestReportStats;
  gaps: string[];
  preview: string;
  warnings: string[];
  message: string;
}

export interface TestReportApplyReceipt {
  receipt: string;
  reportPath: string;
  reportHash: string;
  created: boolean;
  stats: TestReportStats;
  gaps: string[];
  appliedAt: string;
}

async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchTestReportReviewHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export function fetchTestReportContext(input: {
  kind: TestReportKind;
  reportPath?: string;
  casePaths?: string[];
  from?: string;
  to?: string;
  title?: string;
}): Promise<TestReportContext> {
  return request('/context', input);
}

export function createTestReportDraft(input: {
  kind: TestReportKind;
  reportPath: string;
  casePaths: string[];
  from?: string;
  to?: string;
  body: string;
  declaredStats?: TestReportStats;
  expectedSourceRevision: string;
}): Promise<TestReportDraft> {
  return request('/draft', input);
}

export function applyTestReportDraft(
  draftId: string,
  expectedRevision: string,
): Promise<TestReportApplyReceipt> {
  return request('/apply', { draftId, expectedRevision });
}

export async function discardTestReportDraft(draftId: string): Promise<void> {
  await request(`/draft/${encodeURIComponent(draftId)}`, undefined, 'DELETE');
}
