import type { UiPlanStep, UiTestTarget } from './ui-auto-agent';

export const CASE_AUTOMATION_API = '/__tb_case_automation';

export type CaseAutomationDecision = 'automatable' | 'needs_manual' | 'not_automatable';
export type CaseExecutionMode = 'auto' | 'manual';
export type CaseScopeAction = 'keep' | 'move_to_api' | 'move_to_perf' | 'retire';

export interface CaseAutomationAssessmentItem {
  sourceCaseId: string;
  sourceCaseNo: string;
  sourceTitle: string;
  decision: CaseAutomationDecision;
  executionMode: CaseExecutionMode;
  scopeAction: CaseScopeAction;
  manualReason: string;
  flowRequired: boolean;
  stability: 'stable' | 'relationship' | 'exploratory';
  gateEligible: boolean;
  requiredRoles: Array<{ roleId: string; roleName: string; reason: string }>;
  reason: string;
  risks: string[];
  automationCases: Array<{
    automationCaseId: string;
    title: string;
    precondition: string;
    steps: string[];
    expected: string;
    priority: string;
    tag: string;
    flowOnly: boolean;
    automationTag: string;
    actorRoleId: string;
    requiredRoleIds: string[];
    plan: UiPlanStep[];
    projectId: string;
    projectName: string;
    framework: string;
    iteration: string;
    iterationFile: string;
  }>;
}

export interface CaseAutomationFlowCase {
  flowCaseId: string;
  automationCaseId: string;
  title: string;
  kind: 'smoke' | 'regression';
  status: 'draft' | 'connected' | 'running' | 'passed' | 'failed' | 'stale' | 'needs_role';
  businessSystemId: string;
  businessFlowId: string;
  sourceAutomationCaseIds: string[];
  sourceFunctionalCaseIds: string[];
  requiredRoles: Array<{ roleId: string; roleName: string }>;
  checkpoints: Array<{
    id: string;
    title: string;
    actorRoleId: string;
    automationCaseId: string;
    expected: string;
    status?: 'pending' | 'passed' | 'failed' | 'blocked' | 'not_reached' | 'skipped';
    actual?: string;
    error?: string;
    failureCategory?: string;
    durationMs?: number;
  }>;
  checkpointResults?: CaseAutomationFlowCase['checkpoints'];
  failureSummary?: string;
  failureCategory?: string;
  latestRunId: string;
  reportUrl: string;
  actualResult: string;
  pathConditions: string[];
  sharedDataKeys: string[];
  cleanup: string[];
  gateEligible: boolean;
  projectId: string;
  projectName: string;
  iteration: string;
  iterationFile: string;
  scriptPath?: string;
  uiSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaseAutomationFlowDraft {
  flowCaseId: string;
  title: string;
  kind: 'smoke' | 'regression';
  sourceAutomationCaseIds: string[];
  requiredRoles: Array<{ roleId: string; roleName: string }>;
  missingRoles: string[];
  checkpoints: CaseAutomationFlowCase['checkpoints'];
  gateEligible: boolean;
  uiSessionId: string;
  scriptPath?: string;
  automationFile?: string;
  codePreview?: string;
  mapPatch?: {
    systemId: string;
    flowId: string;
    flowCreated?: boolean;
    created?: boolean;
    addedFunctionIds?: string[];
    createdDirectories?: Array<{
      id: string;
      name: string;
      parentId: string;
      menuPath: string[];
    }>;
    addedFunctions?: Array<{ id: string; name: string; directoryId: string }>;
    addedStepTitles?: string[];
    revisionBefore?: number;
    revisionAfter?: number;
    persisted?: boolean;
  };
}

export interface CaseAutomationAssessment {
  id: string;
  sourcePath: string;
  sourceFileHash: string;
  projectId: string;
  projectName: string;
  framework: string;
  iteration: string;
  iterationFile: string;
  cases: CaseAutomationAssessmentItem[];
}

export interface CaseAutomationIterationInfo {
  project: { id: string; name: string; framework: string; kind: string; baseURL: string };
  testDir: string;
  iterationDir: string;
  files: Array<{ name: string; value: string }>;
  suggestedIteration?: string;
}

export interface CaseAutomationBatch {
  id: string;
  status: string;
  env: string;
  error?: string;
  automationCaseIds: string[];
  items: Array<{
    automationCaseId: string;
    status: string;
    runId?: string;
    error?: string;
    reportUrl?: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${CASE_AUTOMATION_API}${route}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; ok?: boolean };
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

export async function fetchCaseAutomationIterations(
  projectId: string,
  casePath = '',
): Promise<CaseAutomationIterationInfo> {
  return request(
    `/iterations?projectId=${encodeURIComponent(projectId)}&casePath=${encodeURIComponent(casePath)}`,
  );
}

export async function getCaseAutomationSource(casePath: string) {
  return (
    await request<{
      document: import('./case-execution').CaseExecutionDocument;
    }>(`/cases?path=${encodeURIComponent(casePath)}`)
  ).document;
}

export async function getCaseAutomationSelection(casePath: string): Promise<{
  projectId: string;
  iteration: string;
} | null> {
  return (
    await request<{ selection: { projectId: string; iteration: string } | null }>(
      `/selection?casePath=${encodeURIComponent(casePath)}`,
    )
  ).selection;
}

export async function fetchCaseAutomationSummaries(
  paths: string[],
): Promise<
  Record<string, { status: string; total: number; passed: number; failed: number } | null>
> {
  if (!paths.length) return {};
  return (
    await request<{
      summaries: Record<
        string,
        { status: string; total: number; passed: number; failed: number } | null
      >;
    }>('/summaries', { method: 'POST', body: JSON.stringify({ paths }) })
  ).summaries;
}

export async function assessCaseAutomation(params: {
  casePath: string;
  caseIds: string[];
  projectId: string;
  iteration: string;
}): Promise<{ assessment: CaseAutomationAssessment }> {
  return request('/assess', { method: 'POST', body: JSON.stringify(params) });
}

export async function applyCaseAutomation(params: {
  assessmentId: string;
  selectedSourceCaseIds: string[];
  selectedAutomationCaseIds: string[];
}): Promise<{
  ok: boolean;
  automationFile: string;
  fileHash: string;
  createdSessions: number;
  links?: Array<{ automationCaseId: string; title: string }>;
}> {
  return request('/apply', { method: 'POST', body: JSON.stringify(params) });
}

export async function createCaseAutomationFlow(params: {
  casePath: string;
  automationCaseIds: string[];
  title: string;
  kind: 'smoke' | 'regression';
  projectId: string;
  iteration: string;
  businessSystemId?: string;
  businessFlowId?: string;
  autoSupplementBusinessMap?: boolean;
  expectedBusinessMapRevision?: number;
  roleStorageStates?: Record<string, string>;
}): Promise<{ flow: CaseAutomationFlowCase; draft: CaseAutomationFlowDraft }> {
  return request('/flows', { method: 'POST', body: JSON.stringify(params) });
}

export async function previewCaseAutomationFlow(
  params: Omit<Parameters<typeof createCaseAutomationFlow>[0], never>,
): Promise<CaseAutomationFlowDraft> {
  return request('/flows/preview', { method: 'POST', body: JSON.stringify(params) });
}

export async function fetchCaseAutomationFlows(casePath = ''): Promise<{
  flows: CaseAutomationFlowCase[];
}> {
  return request(`/flows?casePath=${encodeURIComponent(casePath)}`);
}

export async function startCaseAutomationBatch(params: {
  automationCaseIds: string[];
  env?: string;
}): Promise<{ batch: CaseAutomationBatch }> {
  return request('/runs', { method: 'POST', body: JSON.stringify(params) });
}

export async function getCaseAutomationBatch(id: string): Promise<{ batch: CaseAutomationBatch }> {
  return request(`/runs/${encodeURIComponent(id)}`);
}

export async function stopCaseAutomationBatch(id: string): Promise<{ batch: CaseAutomationBatch }> {
  return request(`/runs/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' });
}

export type { UiPlanStep, UiTestTarget };
