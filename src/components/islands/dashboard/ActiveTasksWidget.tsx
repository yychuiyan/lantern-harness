/** 进行中任务：表格展示（任务描述 / 状态 / 紧急程度 / 起止日期）+ 分页 */
import { useState, type ReactNode } from 'react';

import { activeTasks as pickActiveTasks, pageSlice } from '../../../lib/dashboard';
import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL, type TaskItem } from '../../../lib/tasks';
import { todayIso } from '../../../lib/todos';
import {
  DashboardCard,
  Empty,
  IconTasks,
  Pager,
  PluginOff,
  PriorityPill,
  SourceError,
  StatusPill,
  TD,
  TH,
  TruncatedText,
} from './DashboardCard';
import { dateLabel } from './format';

export function ActiveTasksWidget(props: { tasks: TaskItem[]; enabled: boolean; error?: string }) {
  const { tasks, enabled, error } = props;
  const today = todayIso();
  const [page, setPage] = useState(1);
  const paged = pageSlice(pickActiveTasks(tasks), page, 5);

  let body: ReactNode;
  if (!enabled) {
    body = <PluginOff name="任务管理" detail="启用后这里会显示进行中的任务" />;
  } else if (error) {
    body = <SourceError message={error} />;
  } else if (!paged.total) {
    body = <Empty>没有进行中的任务</Empty>;
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="tw-dash-scroll min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[440px] table-fixed border-collapse text-[12px]">
            <colgroup>
              <col />
              <col style={{ width: 80 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 84 }} />
              <col style={{ width: 84 }} />
            </colgroup>
            <thead>
              <tr>
                <th className={TH}>任务描述</th>
                <th className={TH}>任务状态</th>
                <th className={TH}>重要紧急程度</th>
                <th className={TH}>开始日期</th>
                <th className={TH}>结束日期</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((item) => {
                const overdue = Boolean(item.dueDate) && item.dueDate < today;
                return (
                  <tr
                    key={item.id}
                    className="border-b border-stone-100 transition-colors last:border-0 hover:bg-stone-50"
                  >
                    <td className={TD}>
                      <TruncatedText text={item.title} className="text-stone-700" />
                    </td>
                    <td className={TD}>
                      <StatusPill status={item.status} label={TASK_STATUS_LABEL[item.status]} />
                    </td>
                    <td className={TD}>
                      <PriorityPill
                        priority={item.priority}
                        label={item.priority ? TASK_PRIORITY_LABEL[item.priority] : '—'}
                      />
                    </td>
                    <td
                      className={`${TD} whitespace-nowrap text-[11px] text-stone-400 tabular-nums`}
                    >
                      {dateLabel(item.startDate)}
                    </td>
                    <td
                      className={`${TD} whitespace-nowrap text-[11px] tabular-nums ${
                        overdue ? 'text-[#c02a26]' : 'text-stone-400'
                      }`}
                    >
                      {dateLabel(item.dueDate)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager page={paged.page} pages={paged.pages} total={paged.total} onPage={setPage} />
      </div>
    );
  }

  return (
    <DashboardCard
      title="进行中任务列表"
      icon={<IconTasks />}
      tone="indigo"
      href="tasks/"
      action="打开任务"
    >
      {body}
    </DashboardCard>
  );
}
