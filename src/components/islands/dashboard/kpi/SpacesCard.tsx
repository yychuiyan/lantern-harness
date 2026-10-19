/**
 * 数据空间：当前账号下一共有几个数据空间，并标出正在使用的那个。
 * 没有本地服务（静态部署）时接口拿不到数据，只显示占位。
 */
import { IconSpaces } from '../DashboardCard';
import { MetricCard } from './MetricCard';

export function SpacesCard({
  total,
  activeName,
}: {
  /** null = 还没拿到 / 接口不可用 */
  total: number | null;
  activeName: string;
}) {
  return (
    <MetricCard
      label="数据空间"
      tone="indigo"
      icon={<IconSpaces />}
      value={total ?? '—'}
      hint={activeName ? `当前：${activeName}` : '本地服务未就绪'}
      disabled={total === null}
      pluginLink={false}
    />
  );
}
