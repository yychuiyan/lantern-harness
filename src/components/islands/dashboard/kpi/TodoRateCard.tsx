/** 独立卡片 · 待办完成率 */
import { dashboardKpis } from '../../../../lib/dashboard';
import type { TodoItem } from '../../../../lib/todos';
import { IconTrend } from '../DashboardCard';
import { MetricCard } from './MetricCard';

export function TodoRateCard({ todos, enabled }: { todos: TodoItem[]; enabled: boolean }) {
  const kpis = dashboardKpis(todos, []);
  return (
    <MetricCard
      label="待办完成率"
      tone="emerald"
      icon={<IconTrend />}
      rate={enabled ? kpis.todoRate : undefined}
      value="—"
      bar="bg-[#3370ff]"
      hint={enabled ? `${kpis.todoDone} / ${kpis.todoTotal}` : '「待办事项」插件未启用'}
      href={enabled ? 'todos/' : undefined}
      disabled={!enabled}
    />
  );
}
