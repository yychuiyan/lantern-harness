/**
 * 工作台「待办」Tab：把当前空间的待办摊在会话右侧（对话 / 回合 / 待办 / 记忆）。
 *
 * 每行只读展示：名称、紧急程度、截止日期、剩余天数、所属任务；点左侧圆圈可勾完成。
 * 字段编辑、批量删除、关联任务这些重操作仍然回到 /todos/ 页面。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  effectiveTodoStatus,
  listTodos,
  TODO_PRIORITY_LABEL,
  TODO_STATUS_LABEL,
  todoRemainingDays,
  updateTodo,
  type TodoItem,
} from '../../lib/todos';

const base = import.meta.env.BASE_URL;

type Filter = 'all' | 'open' | 'done';

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部待办' },
  { id: 'open', label: '未完成' },
  { id: 'done', label: '已完成' },
];

/** 优先级圆点：与待办页的色系保持一致 */
const PRIORITY_DOT: Record<string, string> = {
  urgent_important: 'bg-red-500',
  important: 'bg-amber-500',
  urgent: 'bg-orange-500',
  normal: 'bg-stone-300',
};

const PRIORITY_TEXT: Record<string, string> = {
  urgent_important: 'text-red-600',
  important: 'text-amber-600',
  urgent: 'text-orange-600',
  normal: 'text-stone-500',
};

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 2026-10-19 → 2026/10/19；非法值返回空串 */
function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return '';
  return `${match[1]}/${match[2]}/${match[3]}`;
}

/**
 * 截止日期与剩余天数：
 * 剩余天数按 逾期 N 天 / 今天截止 / N 天，颜色跟随紧迫度；已完成 / 已取消只看状态。
 */
function dueMeta(item: TodoItem, today: string): { due: string; remain: string; tone: string } {
  const due = formatDate(item.dueDate);
  const finished = item.status === 'done' || item.status === 'cancelled';
  const remainDays = todoRemainingDays(item, today);
  let remain = '';
  let tone = 'text-stone-500';
  if (finished) {
    remain = TODO_STATUS_LABEL[item.status];
  } else if (remainDays === null) {
    remain = '未设置截止';
    tone = 'text-stone-400';
  } else if (remainDays < 0) {
    remain = `逾期 ${Math.abs(remainDays)} 天`;
    tone = 'text-red-600';
  } else if (remainDays === 0) {
    remain = '今天截止';
    tone = 'text-[#4176e6]';
  } else {
    remain = `剩余 ${remainDays} 天`;
  }
  return { due, remain, tone: finished ? 'text-stone-400' : tone };
}

interface Bucket {
  key: string;
  label: string;
  items: TodoItem[];
  tone?: string;
}

function doneList(items: TodoItem[]): TodoItem[] {
  return [...items]
    .filter((x) => x.status === 'done' || x.status === 'cancelled')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 30);
}

/**
 * 分桶：逾期 → 今天截止 → 接下来 → 没有截止日期 → 已完成。
 * 「全部待办」= 今日 + 其他 + 已完成（已完成只列最近 30 条）；
 * 「未完成」只是把最后一桶去掉；「已完成」只留最后一桶。
 */
function buildBuckets(items: TodoItem[], filter: Filter, today: string): Bucket[] {
  if (filter === 'done') {
    return [{ key: 'done', label: '已完成 / 已取消', items: doneList(items) }];
  }

  const open = items.filter((x) => {
    const st = effectiveTodoStatus(x, today);
    return st !== 'done' && st !== 'cancelled';
  });

  const overdue: TodoItem[] = [];
  const todayItems: TodoItem[] = [];
  const later: TodoItem[] = [];
  const undated: TodoItem[] = [];
  for (const item of open) {
    const remain = todoRemainingDays(item, today);
    if (remain === null) undated.push(item);
    else if (remain < 0) overdue.push(item);
    else if (remain === 0) todayItems.push(item);
    else later.push(item);
  }

  const buckets: Bucket[] = [
    { key: 'overdue', label: '已逾期', items: overdue, tone: 'text-red-600' },
    { key: 'today', label: '今天截止', items: todayItems, tone: 'text-[#4176e6]' },
    { key: 'later', label: '接下来', items: later },
    { key: 'undated', label: '没有截止日期', items: undated },
  ];
  if (filter === 'all') {
    buckets.push({ key: 'done', label: '已完成 / 已取消', items: doneList(items) });
  }
  return buckets.filter((b) => b.items.length > 0);
}

export default function TodoPane(props: { live?: boolean }) {
  const [items, setItems] = useState<TodoItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  /** 正在切换状态的 id：避免重复点按 */
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const list = await listTodos();
      setItems(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // AI 在会话里写待办时这里跟着刷新；停在 Tab 上不用手动刷
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const today = todayIso();
  const buckets = useMemo(
    () => (items ? buildBuckets(items, filter, today) : []),
    [items, filter, today],
  );

  const counts = useMemo(() => {
    const list = items ?? [];
    let overdue = 0;
    let dueToday = 0;
    let open = 0;
    for (const item of list) {
      const st = effectiveTodoStatus(item, today);
      if (st === 'done' || st === 'cancelled') continue;
      open += 1;
      const remain = todoRemainingDays(item, today);
      if (remain !== null && remain < 0) overdue += 1;
      else if (remain === 0) dueToday += 1;
    }
    return { overdue, dueToday, open };
  }, [items, today]);

  async function toggleDone(item: TodoItem) {
    if (pending[item.id]) return;
    const nextStatus = item.status === 'done' ? 'pending' : 'done';
    setPending((prev) => ({ ...prev, [item.id]: true }));
    // 先本地翻转，点完立刻有反馈；失败再回滚
    setItems((prev) =>
      prev ? prev.map((x) => (x.id === item.id ? { ...x, status: nextStatus } : x)) : prev,
    );
    try {
      await updateTodo(item.id, { status: nextStatus });
      setError(null);
    } catch (e) {
      setItems((prev) =>
        prev ? prev.map((x) => (x.id === item.id ? { ...x, status: item.status } : x)) : prev,
      );
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  }

  if (props.live === false) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <p className="text-sm text-stone-600">待办事项需要本地服务</p>
        <p className="mt-1 text-xs text-stone-400">
          当前未就绪（仅 npm run dev / 本地一体服务可用）
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-stone-200/80">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`h-7 px-2.5 text-xs rounded-md ${
              filter === f.id ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
            }`}
          >
            {f.label}
            {f.id === 'all' && counts.dueToday + counts.overdue > 0 ? (
              <span className="ml-1 tabular-nums">{counts.dueToday + counts.overdue}</span>
            ) : null}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-stone-400 tabular-nums">
          未完成 {counts.open}
          {counts.overdue ? ` · 逾期 ${counts.overdue}` : ''}
        </span>
        <a href={`${base}todos/`} className="text-[11px] text-[#4176e6] hover:underline shrink-0">
          打开待办页 →
        </a>
      </div>

      {error ? (
        <div className="mx-4 mt-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
          {error}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {items === null ? (
          <div className="h-full flex items-center justify-center">
            <span className="tw-lib-spin" aria-hidden="true" />
          </div>
        ) : buckets.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <p className="text-sm text-stone-500">
              {filter === 'all'
                ? '当前空间还没有待办'
                : filter === 'done'
                  ? '还没有已完成的待办'
                  : '当前没有未完成的待办'}
            </p>
            <a href={`${base}todos/`} className="mt-2 text-xs text-[#4176e6] hover:underline">
              去待办页新增 →
            </a>
          </div>
        ) : (
          <div className="space-y-4 max-w-3xl">
            {buckets.map((bucket) => (
              <section key={bucket.key}>
                <h3
                  className={`mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium ${bucket.tone ?? 'text-stone-500'}`}
                >
                  {bucket.label}
                  <span className="text-stone-400 tabular-nums">{bucket.items.length}</span>
                </h3>
                <ul className="list-none m-0 p-0 space-y-1">
                  {bucket.items.map((item) => {
                    const done = item.status === 'done' || item.status === 'cancelled';
                    const due = dueMeta(item, today);
                    return (
                      <li
                        key={item.id}
                        className="group flex items-start gap-2 rounded-lg border border-stone-200 bg-white px-2.5 py-2 hover:border-stone-300"
                      >
                        <button
                          type="button"
                          onClick={() => void toggleDone(item)}
                          aria-label={done ? `恢复 ${item.title}` : `完成 ${item.title}`}
                          aria-pressed={done}
                          className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors ${
                            done
                              ? 'border-[#4176e6] bg-[#4176e6] text-white'
                              : 'border-stone-300 text-transparent hover:border-[#4176e6]'
                          }`}
                        >
                          <svg
                            viewBox="0 0 20 20"
                            width="10"
                            height="10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="m4 10 4 4 8-9" />
                          </svg>
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${
                                done ? 'text-stone-400 line-through' : 'text-stone-800'
                              }`}
                            >
                              {item.title}
                            </span>
                            {done ? (
                              <span className="shrink-0 text-[11px] text-stone-400">
                                {TODO_STATUS_LABEL[item.status]}
                              </span>
                            ) : item.priority ? (
                              <span
                                className={`flex shrink-0 items-center gap-1 text-[11px] ${PRIORITY_TEXT[item.priority] ?? 'text-stone-400'}`}
                              >
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[item.priority] ?? 'bg-stone-300'}`}
                                />
                                {TODO_PRIORITY_LABEL[item.priority]}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4">
                            <span className="shrink-0 text-stone-400 tabular-nums">
                              {due.due ? `截止 ${due.due}` : '无截止日期'}
                            </span>
                            <span className="shrink-0 text-stone-300">·</span>
                            <span className={`shrink-0 tabular-nums ${due.tone}`}>
                              {due.remain}
                            </span>
                            {item.linkedTask ? (
                              <>
                                <span className="shrink-0 text-stone-300">·</span>
                                <span
                                  className={`min-w-0 truncate ${done ? 'text-stone-400' : 'text-stone-500'}`}
                                >
                                  任务 {item.linkedTask}
                                </span>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
