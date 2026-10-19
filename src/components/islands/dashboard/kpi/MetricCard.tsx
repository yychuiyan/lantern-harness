/**
 * 指标卡外壳：画布上每张指标卡都是独立组件，这里只收口视觉。
 * 参考 luckytask「我的工作台」统计卡：浅色图标块 + 大数字，hover 轻抬 + 阴影。
 */
import type { ReactNode } from 'react';

import { base } from '../DashboardCard';

export type MetricTone = 'blue' | 'indigo' | 'violet' | 'emerald' | 'amber' | 'red';

export function MetricCard(props: {
  label: string;
  icon: ReactNode;
  tone: MetricTone;
  /** 数值；与 rate 二选一 */
  value?: number | string;
  /** 百分比指标：显示 xx% + 进度条 */
  rate?: number;
  /** 进度条颜色（Tailwind class） */
  bar?: string;
  /** 数值下方的一行说明 */
  hint?: string;
  href?: string;
  /** 数值标红（例如有逾期时） */
  danger?: boolean;
  /** 来源插件未启用：虚线描边 + 灰色数值 */
  disabled?: boolean;
  /** 未启用时是否显示「去开启」链接（数据空间这类非插件数据不显示） */
  pluginLink?: boolean;
}) {
  const {
    label,
    icon,
    tone,
    value,
    rate,
    bar,
    hint,
    href,
    danger,
    disabled,
    pluginLink = true,
  } = props;

  const body = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="tw-dash-ico" data-tone={tone} aria-hidden="true">
          {icon}
        </span>
        <span className="truncate text-[13px] font-medium text-stone-500">{label}</span>
      </div>
      <div className="mt-3 flex min-h-0 flex-1 flex-col justify-center">
        {/*
          数字 + 说明作为一个整体在剩余高度里居中：卡片拉高时上下一起留白，
          数字与说明仍贴着（间距不变），不会数字顶在标题下、说明掉到卡片底。
        */}
        <div className="min-h-0">
          {rate !== undefined ? (
            <>
              <p className="text-[30px] leading-9 font-semibold tracking-tight text-stone-900 tabular-nums">
                {rate}
                <span className="ml-0.5 text-sm font-normal text-stone-400">%</span>
              </p>
              <div className="tw-dash-track mt-2 h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className={`h-full rounded-full transition-[width] ${bar ?? 'bg-[#3370ff]'}`}
                  style={{ width: `${Math.min(100, Math.max(0, rate))}%` }}
                />
              </div>
            </>
          ) : (
            <p
              className={`text-[30px] leading-9 font-semibold tracking-tight tabular-nums ${
                disabled ? 'text-stone-300' : danger ? 'text-[#c02a26]' : 'text-stone-900'
              }`}
            >
              {value}
            </p>
          )}
        </div>
        {hint ? (
          <p className="shrink-0 truncate pt-1.5 text-[11px] text-stone-400">{hint}</p>
        ) : null}
        {disabled && pluginLink ? (
          <a
            href={`${base}plugins/`}
            className="mt-1 inline-block text-[11px] font-medium text-[#3370ff] hover:underline"
          >
            去开启
          </a>
        ) : null}
      </div>
    </>
  );

  const shell = `tw-metric-card flex h-full min-h-0 flex-col overflow-hidden rounded-2xl p-4 ${
    disabled
      ? 'border border-dashed border-stone-200 bg-transparent'
      : 'tw-dash-surface border border-stone-200 bg-white'
  }`;

  return href ? (
    <a href={`${base}${href}`} data-tone={tone} className={shell}>
      {body}
    </a>
  ) : (
    <div data-tone={tone} className={shell}>
      {body}
    </div>
  );
}
