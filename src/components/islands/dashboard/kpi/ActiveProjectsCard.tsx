/**
 * 活跃项目：项目管理里状态为「进行中」的项目数量。
 * 数据来自 `/__tb_pm`，插件关掉或服务未就绪时只显示占位。
 */
import { useMemo } from 'react';

import type { ProjectItem } from '../../../../lib/pm';
import { IconProject } from '../DashboardCard';
import { MetricCard } from './MetricCard';

export function ActiveProjectsCard({
  projects,
  enabled,
  error,
}: {
  projects: ProjectItem[];
  enabled: boolean;
  error?: string;
}) {
  const active = useMemo(
    () => projects.filter((item) => item.status === 'in_progress').length,
    [projects],
  );

  return (
    <MetricCard
      label="活跃项目"
      tone="violet"
      icon={<IconProject />}
      value={enabled && !error ? active : '—'}
      hint={
        !enabled ? '项目列表未开启' : error ? '项目管理服务未就绪' : `共 ${projects.length} 个项目`
      }
      href="pm/projects/"
      disabled={!enabled}
    />
  );
}
