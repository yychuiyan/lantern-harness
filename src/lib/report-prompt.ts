/**
 * 工作汇报插件：开关联动当前空间的「提示词 + 汇报文件夹」。
 *
 * - 打开插件：补齐 `提示词管理/工作汇报提示词.md`（已存在不覆盖）；
 *   `工作汇报/日报|周报|月报` 不预建，真正写入汇报文件时才出现；
 * - 关闭插件：只停用，提示词文件保留（重新打开还是原来那份，改过的内容不丢）；
 *   工作台不再注入。
 *
 * 用哪份提示词可以在工作汇报页的下拉框里换，状态存 `.lantern/local/reports.json`。
 */
const API = '/__tb_reports';

/** 与 lh-plugins/lh-reports.mjs 保持一致 */
export const REPORT_PROMPT_FILE = '工作汇报提示词.md';
export const REPORT_ROOT_DIR = '工作汇报';

export type ReportKind = 'day' | 'week' | 'month';

export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  day: '日报',
  week: '周报',
  month: '月报',
};

export interface ReportPromptSync {
  ok: boolean;
  enabled: boolean;
  file?: string;
  created?: boolean;
  removed?: boolean;
  root?: string;
}

export interface ReportState {
  ok: boolean;
  enabled: boolean;
  /** 当前生效的提示词文件名；没有可用文件时为空串 */
  promptFile: string;
  exists: boolean;
}

export interface ReportPromptChoice {
  name: string;
  size: number;
  mtime: number;
  selected: boolean;
}

export interface ReportPromptList {
  ok: boolean;
  promptFile: string;
  items: ReportPromptChoice[];
}

export interface ReportEntry {
  name: string;
  kind: ReportKind;
  size: number;
  /** 文件修改时间（毫秒）：页面上的「生成日期」 */
  generatedAt: number;
  /** 文件读取地址（页面已不再展示，供其它客户端直接取正文） */
  url: string;
}

export interface ReportList {
  ok: boolean;
  kind: ReportKind;
  label: string;
  /** 相对空间的目录，例如「工作汇报/日报」 */
  dir: string;
  items: ReportEntry[];
}

/** 开关联动：enabled=true 缺提示词就补种子（不建汇报目录）；false 只停用、不删文件 */
export async function syncReportPrompt(enabled: boolean): Promise<ReportPromptSync> {
  const res = await fetch(`${API}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`同步工作汇报提示词失败（${res.status}）`);
  return (await res.json()) as ReportPromptSync;
}

/** 读取当前状态（开关 + 生效的提示词） */
export async function fetchReportState(): Promise<ReportState> {
  const res = await fetch(`${API}/state`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`读取工作汇报状态失败（${res.status}）`);
  return (await res.json()) as ReportState;
}

/** 提示词下拉的候选列表 */
export async function listReportPrompts(): Promise<ReportPromptList> {
  const res = await fetch(`${API}/prompts`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`读取提示词列表失败（${res.status}）`);
  return (await res.json()) as ReportPromptList;
}

/** 切换生效的提示词（只改「用哪份」，不动文件内容） */
export async function selectReportPrompt(file: string): Promise<string> {
  const res = await fetch(`${API}/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  if (!res.ok) throw new Error(`切换提示词失败（${res.status}）`);
  const data = (await res.json()) as { promptFile?: string };
  return typeof data.promptFile === 'string' ? data.promptFile : file;
}

/** 读取当前生效的工作汇报提示词正文（不存在时返回空串） */
export async function fetchReportPrompt(): Promise<string> {
  const res = await fetch(`${API}/prompt`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) return '';
  const data = (await res.json()) as { content?: string };
  return typeof data.content === 'string' ? data.content.trim() : '';
}

/** 某一类汇报的列表（目录还没建时返回空列表，不会顺手铺目录） */
export async function listReports(kind: ReportKind): Promise<ReportList> {
  const res = await fetch(`${API}/list?kind=${kind}`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`读取汇报列表失败（${res.status}）`);
  return (await res.json()) as ReportList;
}

/** 用系统默认程序打开这份汇报（点「汇报内容」那一列就走这里） */
export async function openReport(kind: ReportKind, name: string): Promise<void> {
  const res = await fetch(`${API}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, name }),
    signal: AbortSignal.timeout(4000),
  });
  if (res.ok) return;
  let message = `打开失败（${res.status}）`;
  try {
    const data = (await res.json()) as { error?: string };
    const text = (data.error ?? '').trim();
    // 老版本本地服务没有 /open 路由，只回一个裸的 not found；直接展示会让人以为文件丢了
    if (text && /^not found$/i.test(text)) {
      message = '本地服务版本较旧（缺少「打开文件」接口），请重启本地服务后再试';
    } else if (text) {
      message = text;
    }
  } catch {
    // ignore
  }
  throw new Error(message);
}
