import type { LLMSettings } from './settings';
import { BUSINESS_MAP_API, BusinessMapApiError } from './business-map';

export interface AnalysisTarget {
  functionId?: string;
  name?: string;
  description?: string;
}
export type AnalysisMode = 'single' | 'multiple' | 'system';
export interface AnalysisConfig {
  scope: { mode: AnalysisMode; targets: AnalysisTarget[] };
  sources: {
    page: { enabled: boolean };
    onlineDoc: { enabled: boolean };
    process: { enabled: boolean };
    doc: { enabled: boolean };
    material: { enabled: boolean };
    code: { enabled: boolean };
  };
  documents: string[];
  onlineDocUrls: string[];
  materials: string[];
  sourceDir: string;
  entryUrl: string;
  pageUrls: string[];
  exclusions: string[];
  runtimeDir: string;
  maxPages: number;
  maxDepth: number;
  timeoutMinutes: number;
  autoDraft: boolean;
}
export interface AnalysisJob {
  skill?: { skillId: string; version: number; hash: string } | null;
  id: string;
  systemId: string;
  status:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'awaiting_input';
  phase: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string;
  config: AnalysisConfig;
  progress: Record<string, number>;
  coverage: {
    pages: number;
    documents: number;
    codeFiles: number;
    onlineDocs?: number;
    materials?: number;
    processes?: number;
    chunks: number;
  };
  issues: string[];
  usage: { totalTokens: number };
  result: {
    autoApplied: Array<{ id: string; signature: string }>;
    pending: number;
    duplicates: number;
    rollback?: { removed: string[]; skipped: string[] };
  };
}
export interface AnalysisDocument {
  id: string;
  library: string;
  path: string;
  supported: boolean;
}
export interface AnalysisMaterial {
  id: string;
  name: string;
  path: string;
  size: number;
  updatedAt: string;
  supported: boolean;
}
async function request<T>(route: string, value?: unknown): Promise<T> {
  const response = await fetch(
    BUSINESS_MAP_API + route,
    value === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new BusinessMapApiError(
      data.error || `HTTP ${response.status}`,
      response.status,
      data.code,
    );
  return data;
}
const route = (systemId: string) => `/systems/${encodeURIComponent(systemId)}/analyses`;
export const listAnalysisDocuments = () => request<{ documents: AnalysisDocument[] }>('/documents');
export const listBusinessMaterials = (systemId: string) =>
  request<{ materials: AnalysisMaterial[] }>(`/systems/${encodeURIComponent(systemId)}/materials`);
export async function uploadBusinessMaterial(
  systemId: string,
  file: File,
): Promise<AnalysisMaterial> {
  const response = await fetch(
    `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/materials?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw new BusinessMapApiError(
      data.error || `HTTP ${response.status}`,
      response.status,
      data.code,
    );
  return data.material as AnalysisMaterial;
}
export const listBusinessAnalyses = (systemId: string) =>
  request<{ jobs: AnalysisJob[] }>(route(systemId));
export const startBusinessAnalysis = (
  systemId: string,
  revision: number,
  config: AnalysisConfig,
  settings: LLMSettings,
) => request<{ job: AnalysisJob }>(route(systemId), { revision, config, settings });
export const commandBusinessAnalysis = (
  systemId: string,
  id: string,
  command: 'cancel' | 'retry' | 'rollback',
  settings?: LLMSettings,
) =>
  request<{ job: AnalysisJob }>(
    `${route(systemId)}/${encodeURIComponent(id)}/${command}`,
    settings ? { settings } : {},
  );
export const analysisRunning = (job?: AnalysisJob | null) =>
  job?.status === 'queued' || job?.status === 'running';
export const ANALYSIS_STATUS: Record<AnalysisJob['status'], string> = {
  queued: '等待执行',
  running: '正在识别',
  succeeded: '识别完成',
  partial: '部分完成',
  failed: '识别失败',
  cancelled: '已取消',
  interrupted: '已中断',
  awaiting_input: '等待更新登录态',
};
