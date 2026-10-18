/**
 * 工作汇报「上次看的是哪个 Tab」：日报 / 周报 / 月报的记忆。
 *
 * 跟每页条数一样存在 localStorage，并按数据空间分键（`spaceScopedKey`），
 * 刷新、重开页面、切换空间后再回来都能回到上次看的那个 Tab。
 * localStorage 属不可信输入，读回时必须校验是不是三个合法值之一。
 */
import { REPORT_KIND_LABEL, type ReportKind } from './report-prompt';
import { spaceScopedKey } from './space-scope';

const STORAGE_KEY = 'tw.reports.kind.v1';

const KINDS = Object.keys(REPORT_KIND_LABEL) as ReportKind[];

/** 是否为合法的汇报类型 */
export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && (KINDS as string[]).includes(value);
}

/** 读取上次停留的 Tab；缺失 / 非法 / 存储不可用时回退到日报 */
export function readReportKind(fallback: ReportKind = 'day'): ReportKind {
  try {
    const raw = localStorage.getItem(spaceScopedKey(STORAGE_KEY));
    return isReportKind(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

/** 记住当前 Tab；写入失败静默（隐私模式等不影响使用） */
export function writeReportKind(kind: ReportKind): void {
  if (!isReportKind(kind)) return;
  try {
    localStorage.setItem(spaceScopedKey(STORAGE_KEY), kind);
  } catch {
    // 忽略：写不进去就只在本次会话生效
  }
}
