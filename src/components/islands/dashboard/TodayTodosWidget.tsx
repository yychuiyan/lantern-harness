/** 今日待办：开始 ~ 截止区间包含今天的未完成待办，表格展示 + 分页 */
import { useState, type ReactNode } from 'react';

import { pageSlice, todayTodos as pickTodayTodos } from '../../../lib/dashboard';
import {
  TODO_STATUS_LABEL,
  effectiveTodoStatus,
  todayIso,
  type TodoItem,
} from '../../../lib/todos';
import {
  base,
  DashboardCard,
  IconTodos,
  Pager,
  PluginOff,
  SourceError,
  StatusPill,
  TD,
  TH,
  TruncatedText,
} from './DashboardCard';
import { dateLabel } from './format';

export function TodayTodosWidget(props: {
  todos: TodoItem[];
  enabled: boolean;
  error?: string;
  onToggle: (item: TodoItem) => Promise<void>;
}) {
  const { todos, enabled, error, onToggle } = props;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const today = todayIso();
  const all = pickTodayTodos(todos, today);
  const paged = pageSlice(all, page, 5);

  let body: ReactNode;
  if (!enabled) {
    body = <PluginOff name="待办事项" detail="启用后这里会显示今天进行中的待办" />;
  } else if (error) {
    body = <SourceError message={error} />;
  } else if (!paged.total) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 py-6 text-center">
        <p className="text-sm text-stone-400">今天没有进行中的待办</p>
        <a href={`${base}todos/`} className="text-xs text-stone-400 hover:underline">
          打开待办事项
        </a>
      </div>
    );
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
                <th className={TH}>待办名称</th>
                <th className={TH}>待办状态</th>
                <th className={TH}>所属任务</th>
                <th className={TH}>开始日期</th>
                <th className={TH}>截止日期</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((item) => {
                const busy = busyId === item.id;
                const status = effectiveTodoStatus(item, today);
                return (
                  <tr
                    key={item.id}
                    className="border-b border-stone-100 transition-colors last:border-0 hover:bg-stone-50"
                  >
                    <td className={TD}>
                      <span className="flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`标记完成 ${item.title}`}
                          onClick={() => {
                            setBusyId(item.id);
                            void onToggle(item).finally(() => setBusyId(null));
                          }}
                          className="group/tick flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-stone-300 transition-colors hover:border-[#3370ff] focus-visible:border-[#3370ff] disabled:opacity-40"
                        >
                          {/* 悬停 / 聚焦时在圈里点一个小圆点，而不是把整圈填满 */}
                          <span
                            className={`h-2 w-2 rounded-full bg-[#3370ff] transition-opacity ${
                              busy
                                ? 'animate-pulse opacity-100'
                                : 'opacity-0 group-hover/tick:opacity-100 group-focus-visible/tick:opacity-100'
                            }`}
                          />
                        </button>
                        <TruncatedText text={item.title} className="min-w-0 text-stone-700" />
                      </span>
                    </td>
                    <td className={TD}>
                      <StatusPill status={status} label={TODO_STATUS_LABEL[status]} />
                    </td>
                    <td className={TD}>
                      {item.linkedTask ? (
                        <TruncatedText
                          text={item.linkedTask}
                          className="rounded-md bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500"
                        />
                      ) : (
                        <span className="text-stone-300">—</span>
                      )}
                    </td>
                    <td
                      className={`${TD} whitespace-nowrap text-[11px] text-stone-400 tabular-nums`}
                    >
                      {dateLabel(item.startDate)}
                    </td>
                    <td
                      className={`${TD} whitespace-nowrap text-[11px] tabular-nums ${
                        status === 'overdue' ? 'text-[#c02a26]' : 'text-stone-400'
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
      title="今日待办"
      icon={<IconTodos />}
      tone="blue"
      href="todos/"
      action="打开待办"
    >
      {body}
    </DashboardCard>
  );
}
