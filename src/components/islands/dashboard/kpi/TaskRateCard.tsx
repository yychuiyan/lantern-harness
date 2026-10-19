/** 独立卡片 · 任务完成率 */
import { dashboardKpis } from '../../../../lib/dashboard';
import type { TaskItem } from '../../../../lib/tasks';
import { IconTrend } from '../DashboardCard';
import { MetricCard } from './MetricCard';

export function TaskRateCard({ tasks, enabled }: { tasks: TaskItem[]; enabled: boolean }) {
  const kpis = dashboardKpis([], tasks);
  return (
    <MetricCard
      label="任务完成率"
      tone="violet"
      icon={<IconTrend />}
      rate={enabled ? kpis.taskRate : undefined}
      value="—"
      bar="bg-[#34c724]"
      hint={enabled ? `${kpis.taskDone} / ${kpis.taskTotal}` : '「任务管理」插件未启用'}
      href={enabled ? 'tasks/' : undefined}
      disabled={!enabled}
    />
  );
}
