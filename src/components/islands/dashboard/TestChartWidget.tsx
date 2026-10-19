/** 测试统计：每个维度取最新一天的计数，照飞书柱状图（纵轴刻度 + 网格线 + 柱顶数值） */
import type { ReactNode } from 'react';

import { axisTicks, latestStatsByDimension } from '../../../lib/dashboard';
import type { TestStatsItem } from '../../../lib/test-stats';
import {
  DashboardCard,
  Empty,
  IconChart,
  PluginOff,
  SourceError,
  TruncatedText,
} from './DashboardCard';

export function TestChartWidget(props: {
  items: TestStatsItem[];
  enabled: boolean;
  error?: string;
}) {
  const { items, enabled, error } = props;
  const bars = latestStatsByDimension(items, 10);
  const max = bars.reduce((acc, bar) => Math.max(acc, bar.count), 0);
  const ticks = axisTicks(max, 3);
  const axisMax = ticks[ticks.length - 1] ?? 1;

  let body: ReactNode;
  if (!enabled) {
    body = <PluginOff name="测试统计" detail="启用后这里会按维度显示最新一天的数量" />;
  } else if (error) {
    body = <SourceError message={error} />;
  } else if (!bars.length) {
    body = <Empty>还没有测试统计数据</Empty>;
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 text-[11px] leading-4 text-stone-500">
          <span className="h-2 w-2 rounded-full bg-[#3370ff]" aria-hidden="true" />
          统计数量
        </div>
        <div className="mt-8 flex min-h-0 flex-1 flex-col">
          {/* 绘图区：左侧留出刻度栏；刻度与网格线共用同一套百分比坐标 */}
          <div className="relative min-h-[88px] flex-1">
            <div className="absolute inset-y-0 left-0 w-8" aria-hidden="true">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-1 -translate-y-1/2 text-[10px] leading-none text-stone-400 tabular-nums"
                  style={{ bottom: `${(tick / axisMax) * 100}%` }}
                >
                  {tick}
                </span>
              ))}
            </div>
            <div className="absolute inset-y-0 left-9 right-0">
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute inset-x-0 border-t border-stone-100"
                  style={{ bottom: `${(tick / axisMax) * 100}%` }}
                  aria-hidden="true"
                />
              ))}
              <div className="absolute inset-0 flex items-end gap-1.5">
                {bars.map((bar) => (
                  <div
                    key={bar.dimension}
                    className="flex h-full min-w-0 flex-1 items-end justify-center"
                  >
                    <div
                      className="group/bar relative w-full max-w-8 rounded-t-[3px] bg-[#3370ff]"
                      style={{
                        height: bar.count > 0 ? `${(bar.count / axisMax) * 100}%` : '1px',
                      }}
                    >
                      {/* 数量：照飞书贴在柱顶上方（柱太高时自动让到柱内顶部） */}
                      <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 text-[10px] leading-none text-[#3370ff] tabular-nums">
                        {bar.count}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3 flex shrink-0 gap-1.5 pl-9">
            {bars.map((bar) => (
              <div key={bar.dimension} className="min-w-0 flex-1 text-center">
                <TruncatedText
                  text={bar.dimension}
                  className="text-[10px] leading-4 text-stone-400"
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <DashboardCard
      title="测试统计"
      icon={<IconChart />}
      tone="emerald"
      href="test-stats/"
      action="打开测试统计"
    >
      {body}
    </DashboardCard>
  );
}
