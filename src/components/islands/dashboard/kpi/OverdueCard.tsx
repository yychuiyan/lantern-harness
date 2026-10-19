/** 独立卡片 · 已逾期 */
import { dashboardKpis } from '../../../../lib/dashboard';
import type { TodoItem } from '../../../../lib/todos';
import { IconAlert } from '../DashboardCard';
import { MetricCard } from './MetricCard';

export function OverdueCard({ todos, enabled }: { todos: TodoItem[]; enabled: boolean }) {
  const kpis = dashboardKpis(todos, []);
  const overdue = enabled && kpis.overdue > 0;
  return (
    <MetricCard
      label="已逾期"
      tone="red"
      icon={<IconAlert />}
      value={enabled ? kpis.overdue : '—'}
      hint={enabled ? (overdue ? '需要关注' : '一切正常') : '「待办事项」插件未启用'}
      href={enabled ? 'todos/' : undefined}
      danger={overdue}
      disabled={!enabled}
    />
  );
}
