/**
 * 用例类型：本机可增删改，存应用配置（.local / localStorage）。
 */
import { flushAppConfig, getCachedAppConfig, updateAppConfig } from './app-config';
import {
  DEFAULT_CASE_TYPES,
  foldersFromLabel,
  newCaseTypeId,
  normalizeCaseTypes,
  type CaseType,
  type CaseTypeDef,
} from './case-type-defs';

export type { CaseType, CaseTypeDef };
export { DEFAULT_CASE_TYPES, foldersFromLabel, normalizeCaseTypes } from './case-type-defs';

/** @deprecated 请用 listCaseTypes() */
export const CASE_TYPE_OPTS = DEFAULT_CASE_TYPES.map((o) => ({
  value: o.id as CaseType,
  label: o.label,
  casesFolder: o.casesFolder,
  templateFolder: o.templateFolder,
}));

export function listCaseTypes(): CaseTypeDef[] {
  const fromCfg = getCachedAppConfig().caseTypes;
  if (fromCfg?.length) return fromCfg.map((x) => ({ ...x }));
  return DEFAULT_CASE_TYPES.map((x) => ({ ...x }));
}

export function caseTypeMeta(t: CaseType): CaseTypeDef {
  const list = listCaseTypes();
  return list.find((o) => o.id === t) ?? list[0] ?? DEFAULT_CASE_TYPES[0]!;
}

export function persistCaseTypes(list: CaseTypeDef[]): CaseTypeDef[] {
  const normalized = normalizeCaseTypes(list);
  updateAppConfig({ caseTypes: normalized });
  void flushAppConfig();
  return normalized;
}

export function addCaseType(label: string): CaseTypeDef {
  const name = label.trim();
  if (!name) throw new Error('类型名称不能为空');
  if (name.length > 40) throw new Error('类型名称过长（最多 40 字）');
  const list = listCaseTypes();
  if (list.some((x) => x.label === name)) throw new Error(`已存在「${name}」`);
  const folders = foldersFromLabel(name);
  const def: CaseTypeDef = { id: newCaseTypeId(), label: name, ...folders };
  persistCaseTypes([...list, def]);
  return def;
}

export function updateCaseType(id: string, label: string): CaseTypeDef {
  const name = label.trim();
  if (!name) throw new Error('类型名称不能为空');
  if (name.length > 40) throw new Error('类型名称过长（最多 40 字）');
  const list = listCaseTypes();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error('类型不存在');
  if (list.some((x) => x.id !== id && x.label === name)) {
    throw new Error(`已存在「${name}」`);
  }
  const folders = foldersFromLabel(name);
  const next = { ...list[idx]!, label: name, ...folders };
  const copy = [...list];
  copy[idx] = next;
  persistCaseTypes(copy);
  return next;
}

export function removeCaseType(id: string): CaseTypeDef[] {
  const list = listCaseTypes();
  if (list.length <= 1) throw new Error('至少保留一个用例类型');
  if (!list.some((x) => x.id === id)) throw new Error('类型不存在');
  return persistCaseTypes(list.filter((x) => x.id !== id));
}
