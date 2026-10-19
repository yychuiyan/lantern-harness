/** 独立卡片 · 进行中任务 */
import { dashboardKpis } from '../../../../lib/dashboard';
import type { TaskItem } from '../../../../lib/tasks';
import { IconTasks } from '../DashboardCard';
import { MetricCard } from './MetricCard';

export function TaskInProgressCard({ tasks, enabled }: { tasks: TaskItem[]; enabled: boolean }) {
  const kpis = dashboardKpis([], tasks);
  return (
    <MetricCard
      label="进行中任务"
      tone="indigo"
      icon={<IconTasks />}
      value={enabled ? kpis.taskInProgress : '—'}
      hint={enabled ? `共 ${kpis.taskTotal} 个任务` : '「任务管理」插件未启用'}
      href={enabled ? 'tasks/' : undefined}
      disabled={!enabled}
    />
  );
}
