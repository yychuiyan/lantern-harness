import {
  FUNCTION_FILTERS,
  type BusinessFunctionFilter,
  type BusinessSystemFilter,
  type BusinessSystemSort,
} from './business-map-view';
import { normalizeFlowDiagramZoom, type BusinessFlowLaneMode } from './business-flow-diagram';
import { readViewJson, readViewPref, writeViewJson, writeViewPref } from './view-prefs';

export type BusinessMapMainView = 'functions' | 'flows';
export type BusinessMapDetailTab = 'overview' | 'rules' | 'evidence';
export type BusinessMapMenuKind = 'directory' | 'function';

export interface BusinessMapMemory {
  systemId: string;
  view: BusinessMapMainView;
  systemQuery: string;
  query: string;
  domain: string;
  functionFilter: BusinessFunctionFilter;
  selectedFunctionId: string;
  selectedDirectoryId: string;
  selectedMenuKind: BusinessMapMenuKind;
  selectedFlowId: string;
  selectedStepId: string;
  flowLaneMode: BusinessFlowLaneMode;
  detailTab: BusinessMapDetailTab;
  detailOpen?: boolean;
}

const MEMORY_NAME = 'business-map.navigation';
const SYSTEM_FILTER_NAME = 'business-map.systems.filter';
const SYSTEM_SORT_NAME = 'business-map.systems.sort';
const FLOW_ZOOM_NAME = 'business-map.flow.zoom';

const MAIN_VIEWS: BusinessMapMainView[] = ['functions', 'flows'];
const DETAIL_TABS: BusinessMapDetailTab[] = ['overview', 'rules', 'evidence'];
const MENU_KINDS: BusinessMapMenuKind[] = ['directory', 'function'];
const SYSTEM_FILTERS: BusinessSystemFilter[] = ['all', 'draft', 'published', 'pending'];
const SYSTEM_SORTS: BusinessSystemSort[] = ['created', 'name'];
const FUNCTION_FILTER_VALUES = FUNCTION_FILTERS.map((item) => item.value);
const FLOW_LANE_MODES: BusinessFlowLaneMode[] = ['system', 'role'];

function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 读取上一次业务地图位置；没有记录或记录不是对象时返回 null。 */
export function readBusinessMapMemory(): BusinessMapMemory | null {
  const raw = readViewJson<unknown>(MEMORY_NAME, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    systemId: text(value.systemId),
    view: oneOf(value.view, MAIN_VIEWS, 'functions'),
    systemQuery: text(value.systemQuery),
    query: text(value.query),
    domain: text(value.domain, 100) || '全部',
    functionFilter: oneOf(value.functionFilter, FUNCTION_FILTER_VALUES, 'all'),
    selectedFunctionId: text(value.selectedFunctionId),
    selectedDirectoryId: text(value.selectedDirectoryId),
    selectedMenuKind: oneOf(value.selectedMenuKind, MENU_KINDS, 'directory'),
    selectedFlowId: text(value.selectedFlowId),
    selectedStepId: text(value.selectedStepId),
    flowLaneMode: oneOf(value.flowLaneMode, FLOW_LANE_MODES, 'system'),
    detailTab: oneOf(value.detailTab, DETAIL_TABS, 'overview'),
    ...(typeof value.detailOpen === 'boolean' ? { detailOpen: value.detailOpen } : {}),
  };
}

/** 保存业务地图位置；存储失败时静默，不影响当前操作。 */
export function writeBusinessMapMemory(memory: BusinessMapMemory): void {
  writeViewJson(MEMORY_NAME, memory);
}

export function readBusinessMapSystemFilter(): BusinessSystemFilter {
  return readViewPref(SYSTEM_FILTER_NAME, SYSTEM_FILTERS, 'all');
}

export function writeBusinessMapSystemFilter(value: BusinessSystemFilter): void {
  writeViewPref(SYSTEM_FILTER_NAME, value);
}

export function readBusinessMapSystemSort(): BusinessSystemSort {
  return readViewPref(SYSTEM_SORT_NAME, SYSTEM_SORTS, 'created');
}

export function writeBusinessMapSystemSort(value: BusinessSystemSort): void {
  writeViewPref(SYSTEM_SORT_NAME, value);
}

function readBusinessFlowZoomMap(): Record<string, number> {
  const raw = readViewJson<unknown>(FLOW_ZOOM_NAME, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter((entry): entry is [string, number] => Number.isFinite(Number(entry[1])))
      .map(([flowId, value]) => [flowId, normalizeFlowDiagramZoom(Number(value))]),
  );
}

export function readBusinessFlowZoom(flowId: string): number {
  if (!flowId) return 1;
  return readBusinessFlowZoomMap()[flowId] ?? 1;
}

export function writeBusinessFlowZoom(flowId: string, zoom: number): void {
  if (!flowId || !Number.isFinite(zoom)) return;
  const current = readBusinessFlowZoomMap();
  const next = Object.fromEntries(
    Object.entries({ ...current, [flowId]: normalizeFlowDiagramZoom(zoom) }).slice(-500),
  );
  writeViewJson(FLOW_ZOOM_NAME, next);
}
