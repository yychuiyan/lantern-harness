/**
 * 任务管理（独立插件）：任务列表 + 待办关联。
 * - 任务本身存 `任务管理/任务.json`；
 * - 待办通过 `taskId` 关联过来，这里按 taskId 汇总「待办数量 / 完成进度」；
 * - 工具栏与表格里的下拉一律用卡片菜单（SelectDropdown），不弹系统原生菜单。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  listTodos,
  TODO_STATUS_LABEL,
  effectiveTodoStatus,
  todayIso,
  updateTodo,
  type TodoItem,
  type TodoStatus,
} from '../../lib/todos';
import {
  createTasks,
  deleteTasks,
  fetchTasksHealth,
  filterTasks,
  listTasks,
  sortTasks,
  taskCounts,
  taskCycleDays,
  taskTodoStats,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  updateTask,
  type TaskInput,
  type TaskItem,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from '../../lib/tasks';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import DatePicker from './DatePicker';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';
import {
  DRAWER_INPUT,
  DrawerField,
  DrawerSelect,
  IconDate,
  IconFormula,
  IconStatus,
  IconText,
} from './DrawerField';
import { ColumnResizeHandle, useColumnWidths } from './ColumnResize';

const POLL_MS = 8000;
/** 列表列宽：默认值即设计稿宽度，拖表头右边缘可改，按页面记住 */
const TASK_COLUMNS = [
  { key: 'title', min: 200 },
  { key: 'status', width: 104, min: 80 },
  { key: 'priority', width: 104, min: 88 },
  { key: 'start', width: 108, min: 88 },
  { key: 'due', width: 108, min: 88 },
  { key: 'cycle', width: 76, min: 60 },
  { key: 'todos', width: 84, min: 68 },
  { key: 'progress', width: 132, min: 104 },
  { key: 'note', width: 140, min: 88 },
  { key: 'action', width: 56, min: 52 },
] as const;

type StatusFilter = TaskStatus | 'all' | 'urgent';

const TASK_STATUS_CELL: Record<TaskStatus, string> = {
  pool: 'bg-stone-100 text-stone-600',
  in_progress: 'bg-[#e1eaff] text-[#1f4ec2]',
  done: 'bg-[#d9f5d2] text-[#1d7a12]',
  closed: 'bg-stone-100 text-stone-400',
  cancelled: 'bg-stone-100 text-stone-400 line-through',
};

const TASK_PRIORITY_PILL: Record<TaskPriority, string> = {
  urgent_important: 'bg-[#f54a45] text-white',
  important: 'bg-[#ff8800] text-white',
  urgent: 'bg-[#f7ba1e] text-stone-800',
  normal: 'bg-stone-200 text-stone-600',
  '': 'bg-transparent text-stone-400',
};

/** 任务详情里「关联待办」的状态胶囊：跟待办页同一套颜色 */
const LINKED_TODO_STATUS: Record<TodoStatus | 'overdue', string> = {
  pending: 'bg-stone-100 text-stone-600',
  in_progress: 'bg-[#e1eaff] text-[#1f4ec2]',
  done: 'bg-[#d9f5d2] text-[#1d7a12]',
  cancelled: 'bg-stone-100 text-stone-400',
  overdue: 'bg-[#fee4e3] text-[#c02a26]',
};

const TASK_STATUS_DOT: Record<TaskStatus, string> = {
  pool: 'bg-stone-400',
  in_progress: 'bg-[#3370ff]',
  done: 'bg-[#34c724]',
  closed: 'bg-stone-300',
  cancelled: 'bg-stone-300',
};

const TASK_PRIORITY_DOT: Record<TaskPriority, string> = {
  urgent_important: 'bg-[#f54a45]',
  important: 'bg-[#ff8800]',
  urgent: 'bg-[#f7ba1e]',
  normal: 'bg-stone-300',
  '': 'border border-stone-300 bg-transparent',
};

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = TASK_STATUSES.map((s) => ({
  value: s,
  label: TASK_STATUS_LABEL[s],
}));

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: '', label: '未设置' },
  ...TASK_PRIORITIES.map((p) => ({ value: p, label: TASK_PRIORITY_LABEL[p] })),
];

const PRIORITY_FILTER_OPTIONS: { value: TaskPriority | 'all'; label: string }[] = [
  { value: 'all', label: '全部优先级' },
  ...TASK_PRIORITIES.map((p) => ({ value: p, label: TASK_PRIORITY_LABEL[p] })),
];

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pool', label: '任务池' },
  { value: 'in_progress', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'closed', label: '已关闭' },
  { value: 'cancelled', label: '已取消' },
];

/** 状态 Tab 的记忆键；只有页面上这 6 个 Tab 会被记住 */
const STATUS_TAB_VALUES = ['all', 'pool', 'in_progress', 'done', 'closed', 'cancelled'] as const;
const STATUS_TAB_PREF = 'tasks.status-tab';
/** 优先级筛选 / 搜索词的记忆键（候选值来自下拉选项） */
const PRIORITY_FILTER_PREF = 'tasks.priority-filter';
const KEYWORD_PREF = 'tasks.search';
const PRIORITY_FILTER_VALUES = PRIORITY_FILTER_OPTIONS.map((o) => o.value);

function StatCard(props: { label: string; value: number; tone?: 'urgent' }) {
  return (
    <div
      data-tone={props.tone}
      className={`tw-stat-card flex min-w-0 flex-col gap-1 rounded-xl border px-4 py-3 ${
        props.tone === 'urgent' ? 'border-red-100 bg-red-50/60' : 'border-stone-200 bg-white'
      }`}
    >
      <span
        className={`text-2xl font-semibold tabular-nums ${
          props.tone === 'urgent' ? 'text-[#c02a26]' : 'text-stone-900'
        }`}
      >
        {props.value}
      </span>
      <span className="truncate text-xs text-stone-500">{props.label}</span>
    </div>
  );
}

function TaskDrawer(props: {
  open: boolean;
  task: TaskItem | null;
  todos: TodoItem[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { open, task, todos, onClose, onSaved } = props;
  const [draft, setDraft] = useState<TaskInput>({ title: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
    setDraft(
      task
        ? {
            title: task.title,
            status: task.status,
            priority: task.priority,
            startDate: task.startDate,
            dueDate: task.dueDate,
            note: task.note,
          }
        : {
            title: '',
            status: 'pool',
            priority: '',
            // 新建任务默认今天开始、今天截止
            startDate: todayIso(),
            dueDate: todayIso(),
          },
    );
  }, [open, task]);

  function patch(next: Partial<TaskInput>) {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  const cycle = taskCycleDays({ startDate: draft.startDate ?? '', dueDate: draft.dueDate ?? '' });
  const linked = task ? todos.filter((t) => t.taskId === task.id) : [];
  const doneCount = linked.filter((t) => t.status === 'done').length;
  const percent = linked.length ? Math.round((doneCount / linked.length) * 100) : 0;

  async function save() {
    const title = (draft.title ?? '').trim();
    if (!title) {
      setError('请填写任务名称');
      return;
    }
    if (draft.startDate && draft.dueDate && draft.dueDate < draft.startDate) {
      setError('截止日期不能早于开始日期');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (task) await updateTask(task.id, draft);
      else await createTasks([{ ...draft, title }], { mode: 'manual' });
      await onSaved();
      showToast(task ? '已保存任务' : '已新建任务', 'success');
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`保存任务失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} transition className="relative z-100">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/25"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex justify-end">
        <DialogPanel
          transition
          className="tw-drawer-panel-anim flex h-full w-full max-w-[520px] flex-col border-l border-stone-200 bg-white shadow-2xl"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-100 px-6 py-4">
            <DialogTitle className="text-base font-semibold text-stone-900">
              {task ? '任务详情' : '新建任务'}
            </DialogTitle>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto py-3">
            <DrawerField icon={<IconText />} label="任务名称">
              <input
                autoFocus
                value={draft.title}
                onChange={(e) => patch({ title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void save();
                  }
                }}
                placeholder="请输入内容"
                className={DRAWER_INPUT}
              />
            </DrawerField>

            {/* 任务状态 / 紧急程度与项目管理抽屉一致：描边下拉 + 选项颜色圆点 */}
            <DrawerField icon={<IconStatus />} label="任务状态">
              <DrawerSelect
                ariaLabel="任务状态"
                menuMinWidth={140}
                options={STATUS_OPTIONS}
                value={draft.status ?? 'pool'}
                onChange={(next) => patch({ status: next as TaskStatus })}
                label={TASK_STATUS_LABEL[draft.status ?? 'pool']}
                optionDotClassName={(value) => TASK_STATUS_DOT[value as TaskStatus]}
              />
            </DrawerField>

            <DrawerField icon={<IconStatus />} label="紧急程度">
              <DrawerSelect
                ariaLabel="紧急程度"
                menuMinWidth={140}
                options={PRIORITY_OPTIONS}
                value={draft.priority ?? ''}
                onChange={(next) => patch({ priority: next as TaskPriority })}
                label={draft.priority ? TASK_PRIORITY_LABEL[draft.priority] : '未设置'}
                optionDotClassName={(value) => TASK_PRIORITY_DOT[value as TaskPriority]}
              />
            </DrawerField>

            <DrawerField icon={<IconDate />} label="开始日期">
              <DatePicker
                value={draft.startDate ?? ''}
                onChange={(v) => patch({ startDate: v })}
                className={`${DRAWER_INPUT} tabular-nums`}
              />
            </DrawerField>

            <DrawerField icon={<IconDate />} label="截止日期">
              <DatePicker
                value={draft.dueDate ?? ''}
                onChange={(v) => patch({ dueDate: v })}
                className={`${DRAWER_INPUT} tabular-nums`}
              />
            </DrawerField>

            <DrawerField icon={<IconFormula />} label="任务周期">
              <div className="px-2 pt-1.5 text-sm text-stone-500">
                {cycle === null ? '—' : `${cycle} 天`}
              </div>
            </DrawerField>

            <DrawerField icon={<IconFormula />} label="待办进度">
              <div className="px-2 pt-1.5 text-sm text-stone-500">
                {linked.length ? `${doneCount}/${linked.length} · ${percent}%` : '还没有关联待办'}
              </div>
            </DrawerField>

            <DrawerField icon={<IconText />} label="备注">
              <textarea
                value={draft.note ?? ''}
                onChange={(e) => patch({ note: e.target.value })}
                rows={4}
                placeholder="请输入内容"
                className="w-full resize-y rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white placeholder:text-stone-400"
              />
            </DrawerField>

            {task && linked.length ? (
              <div className="mx-6 mt-2 rounded-lg border border-stone-100 bg-stone-50/60 px-3 py-2">
                <div className="mb-1.5 text-xs font-medium text-stone-500">关联待办</div>
                <ul className="space-y-1.5">
                  {linked.map((todo) => {
                    const st = effectiveTodoStatus(todo, todayIso());
                    return (
                      <li key={todo.id} className="flex items-center gap-2 text-sm text-stone-700">
                        <span className="min-w-0 flex-1 truncate">{todo.title}</span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${LINKED_TODO_STATUS[st]}`}
                        >
                          {TODO_STATUS_LABEL[st]}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            {error ? (
              <div className="mx-6 mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stone-100 px-6 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-8 rounded-lg border border-stone-200 px-4 text-sm text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-40"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="h-8 rounded-lg bg-[#3370ff] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2b5fd9] disabled:opacity-40"
            >
              {busy ? '保存中…' : task ? '保存' : '新建'}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

export default function TasksBoard() {
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  /** 待办事项插件是否开启：关闭时「待办数量 / 完成进度」两列只给提示 */
  const [todosOn, setTodosOn] = useState(true);
  const [live, setLive] = useState<boolean | null>(null);
  const [items, setItems] = useState<TaskItem[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyword, setKeywordState] = useState(() => readViewText(KEYWORD_PREF));
  const [status, setStatusState] = useState<StatusFilter>(() =>
    readViewPref<StatusFilter>(STATUS_TAB_PREF, STATUS_TAB_VALUES, 'all'),
  );
  const [priority, setPriorityState] = useState<TaskPriority | 'all'>(() =>
    readViewPref<TaskPriority | 'all'>(PRIORITY_FILTER_PREF, PRIORITY_FILTER_VALUES, 'all'),
  );
  const [drawer, setDrawer] = useState<{ task: TaskItem | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskItem | null>(null);

  /** 切状态 Tab：记住选择，刷新 / 重新进入页面后回到这个 Tab */
  function chooseStatus(next: StatusFilter) {
    writeViewPref(STATUS_TAB_PREF, next);
    setStatusState(next);
  }

  /** 改搜索词：边输入边记住，重新进入页面仍按上次的关键词过滤 */
  function chooseKeyword(next: string) {
    writeViewText(KEYWORD_PREF, next);
    setKeywordState(next);
  }

  /** 改优先级筛选：记住选择 */
  function choosePriority(next: TaskPriority | 'all') {
    writeViewPref(PRIORITY_FILTER_PREF, next);
    setPriorityState(next);
  }

  const aliveRef = useRef(true);
  const cols = useColumnWidths('lh:tasks:cols:v1', TASK_COLUMNS);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [taskList, todoList] = await Promise.all([
        listTasks(),
        // 待办插件关闭时不拉待办，两个统计列只显示未启用提示
        todosOn ? listTodos().catch(() => [] as TodoItem[]) : Promise.resolve([] as TodoItem[]),
      ]);
      if (!aliveRef.current) return;
      setItems(taskList);
      setTodos(todoList);
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [todosOn]);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => {
      setPluginOn(Boolean(map.tasks));
      setTodosOn(Boolean(map.todos));
    });
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('tasks'));
      setTodosOn(isPluginEnabled('todos'));
      setPluginReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchTasksHealth();
      if (!aliveRef.current) return;
      if (!ok) {
        setLive(false);
        return;
      }
      await refresh();
      if (aliveRef.current) setLive(true);
    })();
  }, [pluginReady, pluginOn, refresh]);

  useEffect(() => {
    if (live !== true) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [live, refresh]);

  const stats = useMemo(() => taskTodoStats(todos), [todos]);
  const counts = useMemo(() => taskCounts(items), [items]);
  const filtered = useMemo(
    () => filterTasks(items, { status, priority, keyword }),
    [items, status, priority, keyword],
  );
  const sorted = useMemo(() => sortTasks(filtered), [filtered]);

  async function patchTask(id: string, patch: TaskPatch) {
    setItems((prev) => prev.map((x) => (x.id === id ? ({ ...x, ...patch } as TaskItem) : x)));
    try {
      const updated = await updateTask(id, patch);
      if (!aliveRef.current) return;
      setItems((prev) => prev.map((x) => (x.id === id ? updated : x)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusy(true);
    try {
      await deleteTasks([target.id]);
      // 关联待办保留，但解除挂靠：否则「所属任务」会指向一个已不存在的任务
      await Promise.all(
        todos
          .filter((todo) => todo.taskId === target.id)
          .map((todo) => updateTodo(todo.id, { taskId: '', linkedTask: '' }).catch(() => null)),
      );
      await refresh();
      showToast(`已删除任务「${target.title}」`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除任务失败：${msg}`, 'error');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  if (!pluginReady) {
    return (
      <div
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white"
        aria-busy="true"
        aria-label="正在读取插件开关"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <span className="tw-lib-spin" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!pluginOn) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        {pluginDisabledMessage('tasks')}
      </div>
    );
  }

  if (live === null) {
    return (
      <div
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white"
        aria-busy="true"
        aria-label="正在连接任务服务"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <span className="tw-lib-spin" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!live) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        任务管理需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-col gap-4">
      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <StatCard label="全部任务" value={counts.total} />
        <StatCard label="任务池" value={counts.pool} />
        <StatCard label="进行中" value={counts.in_progress} />
        <StatCard label="已完成" value={counts.done} />
        <StatCard label="已关闭" value={counts.closed} />
        <StatCard label="已取消" value={counts.cancelled} />
        <StatCard label="需要紧急" value={counts.urgent} tone="urgent" />
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3">
          <input
            value={keyword}
            onChange={(e) => chooseKeyword(e.target.value)}
            placeholder="搜索任务…"
            className="h-9 w-52 rounded-lg border border-stone-200 px-3 text-sm text-stone-800 outline-none focus:border-[#3370ff]"
          />
          <div className="flex items-center gap-0.5 rounded-lg bg-stone-100/80 p-0.5">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => chooseStatus(tab.value)}
                className={`h-8 rounded-md px-3 text-sm transition-colors ${
                  status === tab.value
                    ? 'bg-white font-medium text-stone-900 shadow-sm'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <SelectDropdown
            flat
            className="w-[136px]"
            ariaLabel="优先级筛选"
            options={PRIORITY_FILTER_OPTIONS}
            value={priority}
            onChange={(next) => choosePriority(next)}
          />
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              aria-label="刷新"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-800"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <path d="M21 4v5h-5" />
              </svg>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDrawer({ task: null })}
              className="h-9 shrink-0 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white transition-colors hover:bg-[#2b5fd9] disabled:opacity-40"
            >
              + 新建任务
            </button>
          </div>
        </div>

        {error ? (
          <div className="mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="关闭"
              className="-mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-red-700/70 hover:bg-red-100 hover:text-red-900"
            >
              ✕
            </button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <table
            className="tw-task-table w-full table-fixed border-collapse text-sm"
            style={cols.tableStyle}
          >
            <colgroup>
              {TASK_COLUMNS.map((c) => (
                <col
                  key={c.key}
                  style={cols.widthOf(c.key) ? { width: cols.widthOf(c.key) } : undefined}
                />
              ))}
            </colgroup>
            <thead className="tw-table-head sticky top-0 z-10 text-xs text-stone-500">
              <tr>
                <th className="relative px-3 py-2 text-left font-medium whitespace-nowrap">
                  任务描述
                  <ColumnResizeHandle {...cols.resizeProps(0)} />
                </th>
                <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                  任务状态
                  <ColumnResizeHandle {...cols.resizeProps(1)} />
                </th>
                <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                  紧急程度
                  <ColumnResizeHandle {...cols.resizeProps(2)} />
                </th>
                <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                  开始日期
                  <ColumnResizeHandle {...cols.resizeProps(3)} />
                </th>
                <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                  截止日期
                  <ColumnResizeHandle {...cols.resizeProps(4)} />
                </th>
                <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                  任务周期
                  <ColumnResizeHandle {...cols.resizeProps(5)} />
                </th>
                <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                  待办数量
                  <ColumnResizeHandle {...cols.resizeProps(6)} />
                </th>
                <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                  完成进度
                  <ColumnResizeHandle {...cols.resizeProps(7)} />
                </th>
                <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                  备注
                  <ColumnResizeHandle {...cols.resizeProps(8)} />
                </th>
                <th className="px-1 py-2 text-center font-medium whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((task) => {
                const cycle = taskCycleDays(task);
                const stat = stats[task.id] ?? { total: 0, done: 0, percent: 0 };
                return (
                  <tr
                    key={task.id}
                    className="group/row border-t border-stone-100 hover:bg-[#f7f8fa]"
                  >
                    <td className="px-3 py-1 align-middle">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {task.source === 'ai' ? (
                          <span className="shrink-0 rounded bg-[#e1eaff] px-1 py-px text-[10px] text-[#1f4ec2]">
                            AI
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setDrawer({ task })}
                          className="min-w-0 truncate rounded-md px-1.5 py-1 text-left text-sm text-stone-800 hover:bg-stone-100"
                        >
                          {task.title}
                        </button>
                      </div>
                    </td>
                    <td className="px-1.5 py-1 align-middle">
                      <SelectDropdown
                        unstyled
                        hideChevron
                        centerContent
                        ariaLabel="任务状态"
                        menuMinWidth={120}
                        options={STATUS_OPTIONS}
                        value={task.status}
                        onChange={(next) => void patchTask(task.id, { status: next })}
                        triggerClassName={`h-7 w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${TASK_STATUS_CELL[task.status]}`}
                        renderTrigger={() => (
                          <span className="w-full truncate text-center">
                            {TASK_STATUS_LABEL[task.status]}
                          </span>
                        )}
                        renderOptionPrefix={(o) => (
                          <span className={`h-2 w-2 rounded-full ${TASK_STATUS_DOT[o.value]}`} />
                        )}
                      />
                    </td>
                    <td className="px-1.5 py-1 align-middle">
                      <SelectDropdown
                        unstyled
                        hideChevron
                        centerContent
                        ariaLabel="紧急程度"
                        menuMinWidth={128}
                        options={PRIORITY_OPTIONS}
                        value={task.priority}
                        onChange={(next) => void patchTask(task.id, { priority: next })}
                        triggerClassName={`h-7 w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${TASK_PRIORITY_PILL[task.priority]}`}
                        renderTrigger={() => (
                          <span className="w-full truncate text-center">
                            {task.priority ? TASK_PRIORITY_LABEL[task.priority] : '未设置'}
                          </span>
                        )}
                        renderOptionPrefix={(o) => (
                          <span className={`h-2 w-2 rounded-full ${TASK_PRIORITY_DOT[o.value]}`} />
                        )}
                      />
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <DatePicker
                        value={task.startDate}
                        onChange={(v) => void patchTask(task.id, { startDate: v })}
                        placeholder="选择日期"
                        className="h-8 rounded-md px-1.5 text-sm tabular-nums"
                      />
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <DatePicker
                        value={task.dueDate}
                        onChange={(v) => void patchTask(task.id, { dueDate: v })}
                        placeholder="选择日期"
                        className="h-8 rounded-md px-1.5 text-sm tabular-nums"
                      />
                    </td>
                    <td className="px-2 py-1 align-middle text-xs whitespace-nowrap text-stone-500 tabular-nums">
                      {cycle === null ? '—' : `${cycle} 天`}
                    </td>
                    <td className="px-2 py-1 align-middle text-xs text-stone-500 tabular-nums">
                      {todosOn ? (
                        stat.total ? (
                          `${stat.total} 条`
                        ) : (
                          '0'
                        )
                      ) : (
                        <span className="whitespace-nowrap text-stone-400">待办事项未启用</span>
                      )}
                    </td>
                    <td className="px-2 py-1 align-middle">
                      {todosOn ? (
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-stone-100">
                            <span
                              className="block h-full rounded-full bg-[#3370ff] transition-[width]"
                              style={{ width: `${stat.percent}%` }}
                            />
                          </span>
                          <span className="w-9 shrink-0 text-right text-xs text-stone-500 tabular-nums">
                            {stat.percent}%
                          </span>
                        </div>
                      ) : (
                        <span className="whitespace-nowrap text-xs text-stone-400">
                          待办事项未启用
                        </span>
                      )}
                    </td>
                    <td className="truncate px-2 py-1 align-middle text-xs text-stone-500">
                      {task.note || '—'}
                    </td>
                    <td className="px-1 py-1 text-right align-middle">
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          type="button"
                          onClick={() => setDrawer({ task })}
                          aria-label={`展开 ${task.title}`}
                          className="rounded p-1 text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-600 focus:text-stone-600"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            width="14"
                            height="14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M14 4h6v6" />
                            <path d="M20 4 13 11" />
                            <path d="M10 20H4v-6" />
                            <path d="M4 20l7-7" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setDeleteTarget(task)}
                          aria-label={`删除 ${task.title}`}
                          className="rounded p-1 text-stone-300 transition-colors hover:bg-red-50 hover:text-red-600 focus:text-red-600 disabled:opacity-40"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            width="14"
                            height="14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M19 6l-1 14H6L5 6" />
                            <path d="M10 11v6M14 11v6" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-16 text-center text-sm text-stone-400">
                    {items.length === 0 ? '还没有任务' : '没有匹配的任务，试试调整搜索或筛选'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-stone-100 px-4 py-2.5 text-xs text-stone-500">
          <span>共 {sorted.length} 条</span>
          <span className="ml-auto text-stone-400">任务下关联的待办可直接在「待办事项」里维护</span>
        </div>
      </div>

      <TaskDrawer
        open={drawer !== null}
        task={drawer?.task ?? null}
        todos={todos}
        onClose={() => setDrawer(null)}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        title="删除任务"
        message={`删除「${deleteTarget?.title ?? ''}」？已关联的待办会保留，但不再挂在该任务下。`}
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
