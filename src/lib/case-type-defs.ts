/**
 * 用例类型数据结构与默认种子（无 app-config 依赖，避免循环引用）。
 */
export type CaseType = string;

export interface CaseTypeDef {
  id: string;
  label: string;
  casesFolder: string;
  templateFolder: string;
  /**
   * 该用例类型挂载的生成提示词（提示词管理里的相对路径）。
   * 一个类型只挂一份：换一份会立即顶掉上一份；空着时生成抽屉不允许确认。
   */
  promptPath?: string;
}

/** 与历史会话 id 对齐的默认种子 */
export const DEFAULT_CASE_TYPES: CaseTypeDef[] = [
  {
    id: 'functional',
    label: '功能测试',
    casesFolder: '功能测试',
    templateFolder: '功能测试用例',
  },
  {
    id: 'api',
    label: '接口测试',
    casesFolder: '接口测试',
    templateFolder: '接口测试用例',
  },
  {
    id: 'performance',
    label: '性能测试',
    casesFolder: '性能测试',
    templateFolder: '性能测试用例',
  },
  {
    id: 'automation',
    label: '自动化测试',
    casesFolder: '自动化测试',
    templateFolder: '自动化测试用例',
  },
];

function uid(): string {
  return `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function foldersFromLabel(
  label: string,
): Pick<CaseTypeDef, 'casesFolder' | 'templateFolder'> {
  const name = label.trim() || '未命名类型';
  return { casesFolder: name, templateFolder: `${name}用例` };
}

export function normalizeCaseTypeDef(raw: unknown): CaseTypeDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = String(o.label ?? '').trim();
  if (!label) return null;
  const id = String(o.id ?? '').trim() || uid();
  const folders = foldersFromLabel(label);
  return {
    id,
    label,
    casesFolder:
      typeof o.casesFolder === 'string' && o.casesFolder.trim()
        ? o.casesFolder.trim()
        : folders.casesFolder,
    templateFolder:
      typeof o.templateFolder === 'string' && o.templateFolder.trim()
        ? o.templateFolder.trim()
        : folders.templateFolder,
    ...(typeof o.promptPath === 'string' && o.promptPath.trim()
      ? { promptPath: o.promptPath.trim() }
      : {}),
  };
}

export function normalizeCaseTypes(raw: unknown): CaseTypeDef[] {
  if (!Array.isArray(raw)) return DEFAULT_CASE_TYPES.map((x) => ({ ...x }));
  const out: CaseTypeDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const def = normalizeCaseTypeDef(item);
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    out.push(def);
  }
  return out.length ? out : DEFAULT_CASE_TYPES.map((x) => ({ ...x }));
}

export function newCaseTypeId(): string {
  return uid();
}
