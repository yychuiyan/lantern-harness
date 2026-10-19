/** 仪表盘里的小格式化工具（非组件，放这里避免打断 Fast Refresh） */

/** 2026-10-28 → 2026/10/28；空值显示破折号 */
export function dateLabel(iso: string): string {
  return iso ? iso.split('-').join('/') : '—';
}
