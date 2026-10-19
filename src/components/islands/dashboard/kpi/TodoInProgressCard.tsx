/** 独立卡片 · 进行中待办 */
import { dashboardKpis } from '../../../../lib/dashboard';
import type { TodoItem } from '../../../../lib/todos';
import { IconTodos } from '../DashboardCard';
import { MetricCard } from './MetricCard';

export function TodoInProgressCard({ todos, enabled }: { todos: TodoItem[]; enabled: boolean }) {
  const kpis = dashboardKpis(todos, []);
  return (
    <MetricCard
      label="进行中待办"
      tone="blue"
      icon={<IconTodos />}
      value={enabled ? kpis.todoInProgress : '—'}
      hint={enabled ? `共 ${kpis.todoTotal} 条待办` : '「待办事项」插件未启用'}
      href={enabled ? 'todos/' : undefined}
      disabled={!enabled}
    />
  );
}
