export const REQ_BREAKDOWN_API = '/__tb_req_breakdowns';

export type RequirementBreakdownKind = 'generated' | 'uploaded';

export interface RequirementBreakdownEntry {
  id: string;
  title: string;
  project: string;
  iteration: string;
  sourcePath: string;
  sourceTitle: string;
  sourceHash: string;
  fileHash?: string;
  analysisId: string;
  analysisRevision: string;
  sourceExportAt: string;
  kind: RequirementBreakdownKind;
  fileName: string;
  relativePath: string;
  localPath: string;
  size: number;
  mtime: string;
  fileMtime: string;
  exists: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementBreakdownList {
  revision: number;
  entries: RequirementBreakdownEntry[];
}

export interface RequirementBreakdownCandidate {
  analysisId: string;
  title: string;
  sourcePath: string;
  sourceTitle: string;
  sourceExportAt: string;
  updatedAt: string;
  recorded: boolean;
}

export interface RequirementBreakdownContent {
  text: string;
  tree: Array<{ title: string; depth: number }>;
}

interface ApiResult extends Record<string, unknown> {
  ok?: boolean;
  error?: string;
  revision?: number;
  entries?: RequirementBreakdownEntry[];
  entry?: RequirementBreakdownEntry;
  candidates?: RequirementBreakdownCandidate[];
  content?: RequirementBreakdownContent | null;
  created?: RequirementBreakdownEntry[];
  failed?: Array<{ analysisId: string; error: string }>;
}

async function request(path = '', init: RequestInit = {}): Promise<ApiResult> {
  const res = await fetch(`${REQ_BREAKDOWN_API}${path}`, init);
  const data = (await res.json().catch(() => ({}))) as ApiResult;
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export async function fetchRequirementBreakdownHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${REQ_BREAKDOWN_API}?health=1`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listRequirementBreakdowns(): Promise<RequirementBreakdownList> {
  const data = await request('/list');
  return {
    revision: Number(data.revision) || 0,
    entries: data.entries || [],
  };
}

export async function getRequirementBreakdown(
  entryId: string,
  includeContent = false,
): Promise<{
  revision: number;
  entry: RequirementBreakdownEntry;
  content: RequirementBreakdownContent | null;
}> {
  const data = await request(
    `/entries/${encodeURIComponent(entryId)}${includeContent ? '?includeContent=1' : ''}`,
  );
  return {
    revision: Number(data.revision) || 0,
    entry: data.entry as RequirementBreakdownEntry,
    content: data.content || null,
  };
}

export async function openRequirementBreakdown(entryId: string): Promise<void> {
  await request(`/entries/${encodeURIComponent(entryId)}/open`, jsonBody({}));
}

export async function retryRequirementBreakdown(
  entryId: string,
  expectedRevision: number,
): Promise<{ revision: number; entry: RequirementBreakdownEntry }> {
  const data = await request(
    `/entries/${encodeURIComponent(entryId)}/retry`,
    jsonBody({ expectedRevision }),
  );
  return {
    revision: Number(data.revision) || 0,
    entry: data.entry as RequirementBreakdownEntry,
  };
}

export async function updateRequirementBreakdown(
  entryId: string,
  expectedRevision: number,
  patch: { title?: string; note?: string },
): Promise<{ revision: number; entry: RequirementBreakdownEntry }> {
  const data = await request(`/entries/${encodeURIComponent(entryId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision, ...patch }),
  });
  return {
    revision: Number(data.revision) || 0,
    entry: data.entry as RequirementBreakdownEntry,
  };
}

export async function deleteRequirementBreakdown(
  entryId: string,
  expectedRevision: number,
): Promise<number> {
  const data = await request(`/entries/${encodeURIComponent(entryId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision }),
  });
  return Number(data.revision) || 0;
}

export async function importRequirementBreakdown(
  file: File,
  expectedRevision: number,
  extra: { project?: string; iteration?: string; note?: string } = {},
): Promise<{ revision: number; entry: RequirementBreakdownEntry }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1)
    binary += String.fromCharCode(bytes[index]!);
  const data = await request(
    '/import',
    jsonBody({
      name: file.name,
      contentBase64: btoa(binary),
      expectedRevision,
      ...extra,
    }),
  );
  return {
    revision: Number(data.revision) || 0,
    entry: data.entry as RequirementBreakdownEntry,
  };
}

export async function listRequirementBreakdownCandidates(): Promise<{
  revision: number;
  candidates: RequirementBreakdownCandidate[];
}> {
  const data = await request('/backfill');
  return {
    revision: Number(data.revision) || 0,
    candidates: data.candidates || [],
  };
}

export async function backfillRequirementBreakdowns(
  analysisIds: string[],
  expectedRevision: number,
): Promise<{
  revision: number;
  created: RequirementBreakdownEntry[];
  failed: Array<{ analysisId: string; error: string }>;
}> {
  const data = await request('/backfill', jsonBody({ analysisIds, expectedRevision }));
  return {
    revision: Number(data.revision) || 0,
    created: data.created || [],
    failed: data.failed || [],
  };
}
