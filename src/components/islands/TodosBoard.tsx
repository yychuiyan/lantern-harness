import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  createTodos,
  deleteTodos,
  effectiveTodoStatus,
  fetchTodosHealth,
  filterTodos,
  isTodoClosed,
  listTodos,
  sortTodos,
  TODO_PRIORITIES,
  TODO_PRIORITY_LABEL,
  TODO_STATUS_LABEL,
  TODO_STATUSES,
  todoCycleDays,
  todoEndDate,
  todoRemainingDays,
  todayIso,
  updateTodo,
  type TodoInput,
  type TodoItem,
  type TodoPatch,
  type TodoPriority,
  type TodoStatus,
} from '../../lib/todos';
import ConfirmDialog from './ConfirmDialog';
import { ColumnResizeHandle, useColumnWidths } from './ColumnResize';
import DatePicker, { formatDateDisplay } from './DatePicker';
import SelectDropdown from './SelectDropdown';
import {
  DRAWER_INPUT,
  DrawerField as FieldRow,
  DrawerPillSelect,
  IconChevron,
  IconDate,
  IconFormula,
  IconStatus,
  IconTask,
  IconText,
} from './DrawerField';
import { listTasks, updateTask, type TaskItem } from '../../lib/tasks';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';

const POLL_MS = 8000;
/** 列表列宽：默认值即设计稿宽度，拖表头右边缘可改，按页面记住 */
const TODO_COLUMNS = [
  { key: 'select', width: 32, min: 28 },
  { key: 'index', width: 36, min: 28 },
  { key: 'title', min: 160 },
  { key: 'status', width: 104, min: 76 },
  { key: 'priority', width: 104, min: 84 },
  { key: 'task', width: 156, min: 96 },
  { key: 'start', width: 108, min: 88 },
  { key: 'due', width: 108, min: 88 },
  { key: 'end', width: 108, min: 88 },
  { key: 'cycle', width: 64, min: 52 },
  { key: 'remain', width: 86, min: 64 },
  { key: 'note', width: 120, min: 80 },
  { key: 'action', width: 80, min: 64 },
] as const;

type GroupBy = 'status' | 'priority' | 'none';
type PriorityFilter = TodoPriority | 'all';
type StatusShown = TodoStatus | 'overdue';

/** 可编辑字段（顺序即提交时的回写顺序）；结束日期由状态派生，不参与提交 */
const FIELDS: readonly (keyof TodoInput)[] = [
  'title',
  'status',
  'priority',
  'linkedTask',
  'startDate',
  'dueDate',
  'note',
];

const STATUS_PILL: Record<StatusShown, string> = {
  in_progress: 'bg-[#3370ff] text-white',
  pending: 'bg-stone-400 text-white',
  done: 'bg-[#34c724] text-white',
  cancelled: 'bg-stone-300 text-stone-600',
  overdue: 'bg-[#f54a45] text-white',
};

const STATUS_CELL: Record<StatusShown, string> = {
  in_progress: 'bg-[#e1eaff] text-[#1f4ec2]',
  pending: 'bg-stone-100 text-stone-600',
  done: 'bg-[#d9f5d2] text-[#1d7a12]',
  cancelled: 'bg-stone-100 text-stone-400',
  overdue: 'bg-[#fee4e3] text-[#c02a26]',
};

const PRIORITY_PILL: Record<TodoPriority, string> = {
  urgent_important: 'bg-[#f54a45] text-white',
  important: 'bg-[#ff8800] text-white',
  urgent: 'bg-[#f7ba1e] text-stone-800',
  normal: 'bg-stone-200 text-stone-600',
  '': 'bg-transparent text-stone-400',
};

/** 抽屉里的紧急程度：跟待办状态的胶囊同一套浅色底，只换色相 */
const PRIORITY_CELL: Record<TodoPriority, string> = {
  urgent_important: 'bg-[#fee4e3] text-[#c02a26]',
  important: 'bg-[#fff1e3] text-[#a85b00]',
  urgent: 'bg-[#fff7d6] text-[#8a6100]',
  normal: 'bg-stone-100 text-stone-600',
  '': 'bg-stone-100 text-stone-500',
};

/** 下拉选项前的颜色点：跟状态 / 紧急程度胶囊同色，替代对钩做区分 */
const STATUS_DOT: Record<TodoStatus, string> = {
  pending: 'bg-stone-400',
  in_progress: 'bg-[#3370ff]',
  done: 'bg-[#34c724]',
  cancelled: 'bg-stone-300',
};

const PRIORITY_DOT: Record<TodoPriority, string> = {
  urgent_important: 'bg-[#f54a45]',
  important: 'bg-[#ff8800]',
  urgent: 'bg-[#f7ba1e]',
  normal: 'bg-stone-300',
  '': 'border border-stone-300 bg-transparent',
};

const GROUP_BY_LABEL: Record<GroupBy, string> = {
  status: '按状态分组',
  priority: '按紧急程度分组',
  none: '不分组',
};

/** 分组方式的记忆键与候选值 */
const GROUP_BY_VALUES = ['status', 'priority', 'none'] as const;
const GROUP_BY_PREF = 'todos.group-by';

const STATUS_ORDER: StatusShown[] = ['in_progress', 'pending', 'overdue', 'done', 'cancelled'];

const STATUS_OPTIONS: { value: TodoStatus; label: string }[] = TODO_STATUSES.map((s) => ({
  value: s,
  label: TODO_STATUS_LABEL[s],
}));
const PRIORITY_OPTIONS: { value: TodoPriority; label: string }[] = [
  { value: '', label: '未设置' },
  ...TODO_PRIORITIES.map((p) => ({ value: p, label: TODO_PRIORITY_LABEL[p] })),
];
const GROUP_BY_OPTIONS = (Object.keys(GROUP_BY_LABEL) as GroupBy[]).map((g) => ({
  value: g,
  label: GROUP_BY_LABEL[g],
}));
const PRIORITY_FILTER_OPTIONS: { value: PriorityFilter; label: string }[] = [
  { value: 'all', label: '全部紧急程度' },
  ...TODO_PRIORITIES.map((p) => ({ value: p, label: TODO_PRIORITY_LABEL[p] })),
];

/** 紧急程度筛选 / 搜索词的记忆键（候选值来自下拉选项） */
const PRIORITY_FILTER_VALUES = PRIORITY_FILTER_OPTIONS.map((o) => o.value);
const PRIORITY_FILTER_PREF = 'todos.priority-filter';
const KEYWORD_PREF = 'todos.search';

interface TodoGroup {
  key: string;
  label: string;
  pill: string;
  items: TodoItem[];
  /** 在该分组里新建时的默认值 */
  newStatus?: TodoStatus;
  newPriority?: TodoPriority;
}

const cellInput =
  'h-8 w-full min-w-0 truncate rounded-md border border-transparent bg-transparent px-1.5 text-sm text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white placeholder:text-stone-300';

function TextCell(props: {
  value: string;
  placeholder?: string;
  muted?: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { value, placeholder, muted, onChange, onCommit, onCancel } = props;
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
          e.currentTarget.blur();
        }
      }}
      className={`${cellInput} ${muted && !value ? 'text-stone-300' : ''}`}
    />
  );
}

/** 表格里的日期格：点一下弹卡片日历，选完直接落库（不显示原生小图标） */
function DateCell(props: { value: string; onChange: (value: string) => void }) {
  return (
    <DatePicker
      value={props.value}
      onChange={props.onChange}
      placeholder="选择日期"
      className="h-8 rounded-md border border-transparent px-1.5 text-sm text-stone-800 tabular-nums transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
    />
  );
}

/** 飞书式表格：按状态 / 紧急程度分组，单元格直接改，分组底部加行 */

/**
 * 记录详情抽屉（右侧滑出）：新建与编辑共用。
 * 字段顺序按用户截图：名称 / 状态 / 任务详情（所属任务、重要紧急程度、结束日期）/
 * 开始日期 / 截止日期 / 待办周期 / 剩余天数 / 备注。后两项是派生值，只读。
 */
function TodoDrawer(props: {
  open: boolean;
  item: TodoItem | null;
  preset?: { status?: TodoStatus; priority?: TodoPriority };
  tasks: TaskItem[];
  /** 任务管理插件是否开启；关闭时「所属任务」只给提示，不给选择 */
  tasksOn: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { open, item, preset, tasks, tasksOn, onClose, onSaved } = props;
  const [draft, setDraft] = useState<TodoInput>({ title: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);

  useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
    setDetailsOpen(true);
    setDraft(
      item
        ? {
            title: item.title,
            status: item.status,
            priority: item.priority,
            linkedTask: item.linkedTask,
            taskId: item.taskId,
            startDate: item.startDate,
            dueDate: item.dueDate,
            note: item.note,
          }
        : {
            title: '',
            status: 'pending',
            priority: '',
            // 新建待办默认就是今天开始、今天截止
            startDate: todayIso(),
            dueDate: todayIso(),
            ...preset,
          },
    );
  }, [open, item, preset]);

  /** 可关联的任务：已关闭的任务不在选择范围内（已关联的旧数据保留原值展示） */
  const taskOptions = [
    { value: '', label: '不关联' },
    ...tasks
      .filter((t) => (t.status !== 'closed' && t.status !== 'cancelled') || t.id === item?.taskId)
      .map((t) => ({ value: t.id, label: t.title })),
  ];

  function patch(next: Partial<TodoInput>) {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  const cycle = todoCycleDays({ startDate: draft.startDate ?? '', dueDate: draft.dueDate ?? '' });
  const remainDays = todoRemainingDays({ dueDate: draft.dueDate ?? '' });
  /** 结束日期只读：结束态显示完成 / 取消当天，未结束显示「待办未完成」 */
  const draftClosed = isTodoClosed((draft.status ?? 'pending') as TodoStatus);
  const endDateText = draftClosed
    ? formatDateDisplay((item && isTodoClosed(item.status) ? item.taskEndDate : '') || todayIso())
    : '';
  const remainText =
    remainDays === null
      ? ''
      : draft.status === 'done'
        ? '已完成'
        : draft.status === 'cancelled'
          ? '已取消'
          : remainDays < 0
            ? `逾期 ${Math.abs(remainDays)} 天`
            : remainDays === 0
              ? '今天截止'
              : `${remainDays} 天`;

  async function save() {
    const title = (draft.title ?? '').trim();
    if (!title) {
      setError('请填写待办名称');
      return;
    }
    if (draft.startDate && draft.dueDate && draft.dueDate < draft.startDate) {
      setError('截止日期不能早于开始日期');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload: TodoInput = { ...draft, title };
      if (item) await updateTodo(item.id, payload);
      else await createTodos([payload], { mode: 'manual' });
      await onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
              {item ? '待办详情' : '新建待办'}
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
            <FieldRow icon={<IconText />} label="待办名称">
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
            </FieldRow>

            <FieldRow icon={<IconStatus />} label="待办状态">
              {/* 整行宽度都可点：触发器铺满到「待办名称」输入框的右边界，胶囊只是里面的样子 */}
              <DrawerPillSelect
                ariaLabel="待办状态"
                menuMinWidth={140}
                options={STATUS_OPTIONS}
                value={draft.status ?? 'pending'}
                onChange={(next) => patch({ status: next as TodoStatus })}
                label={TODO_STATUS_LABEL[draft.status ?? 'pending']}
                pillClassName={STATUS_CELL[draft.status ?? 'pending']}
                optionDotClassName={(value) => STATUS_DOT[value as TodoStatus]}
              />
            </FieldRow>

            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={detailsOpen}
              className="flex w-full items-center gap-2 px-6 py-2 text-left text-sm text-stone-600 hover:bg-stone-50"
            >
              <span className="flex h-4 w-4 items-center justify-center text-stone-400">
                <IconTask />
              </span>
              <span>任务详情</span>
              <span className="text-stone-400">
                <IconChevron open={detailsOpen} />
              </span>
            </button>

            {detailsOpen ? (
              <div className="ml-[42px] border-l border-stone-100 pl-1">
                <FieldRow icon={<IconTask />} label="所属任务">
                  {tasksOn ? (
                    <>
                      <SelectDropdown
                        unstyled
                        showCheck={false}
                        ariaLabel="所属任务"
                        menuMinWidth={220}
                        options={taskOptions}
                        value={draft.taskId ?? ''}
                        onChange={(next) => {
                          const task = tasks.find((t) => t.id === next);
                          patch({ taskId: next, linkedTask: task?.title ?? '' });
                        }}
                        triggerClassName="h-9 w-full rounded-md px-2 text-sm hover:border-stone-200 focus:border-[#3370ff]"
                        renderTrigger={() => (
                          <span
                            className={`truncate ${draft.taskId || draft.linkedTask ? 'text-stone-800' : 'text-stone-400'}`}
                          >
                            {draft.taskId
                              ? (tasks.find((t) => t.id === draft.taskId)?.title ?? '')
                              : draft.linkedTask || '请选择任务'}
                          </span>
                        )}
                      />
                      {tasks.length === 0 ? (
                        <p className="mt-1 px-2 text-xs text-stone-400">
                          任务管理里还没有任务，可到「任务管理」新建后再关联。
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex h-9 items-center rounded-md bg-stone-50 px-2 text-sm text-stone-400">
                      <span className="truncate">
                        {draft.linkedTask
                          ? `${draft.linkedTask}（任务管理插件未启用）`
                          : '任务管理插件未启用，无法关联任务'}
                      </span>
                    </div>
                  )}
                </FieldRow>
                <FieldRow icon={<IconStatus />} label="重要紧急程度">
                  {/* 与待办状态同一套「整行可点 + 胶囊」样式，避免这里是纯文字 */}
                  <DrawerPillSelect
                    ariaLabel="重要紧急程度"
                    menuMinWidth={140}
                    options={PRIORITY_OPTIONS}
                    value={draft.priority ?? ''}
                    onChange={(next) => patch({ priority: next as TodoPriority })}
                    label={draft.priority ? TODO_PRIORITY_LABEL[draft.priority] : '未设置'}
                    pillClassName={PRIORITY_CELL[draft.priority ?? '']}
                    optionDotClassName={(value) => PRIORITY_DOT[value as TodoPriority]}
                  />
                </FieldRow>
                <FieldRow icon={<IconDate />} label="结束日期">
                  <div
                    className="flex h-9 items-center px-2 text-sm tabular-nums"
                    aria-readonly="true"
                  >
                    {endDateText ? (
                      <span className="text-stone-800">{endDateText}</span>
                    ) : (
                      <span className="text-stone-400">待办未完成</span>
                    )}
                    <span className="ml-2 text-[11px] text-stone-400">
                      {draftClosed ? '按完成日期自动记录' : '状态为已完成 / 已取消时自动记录'}
                    </span>
                  </div>
                </FieldRow>
              </div>
            ) : null}

            <FieldRow icon={<IconDate />} label="开始日期">
              <DatePicker
                value={draft.startDate ?? ''}
                onChange={(v) => patch({ startDate: v })}
                className={`${DRAWER_INPUT} tabular-nums`}
              />
            </FieldRow>

            <FieldRow icon={<IconDate />} label="截止日期">
              <DatePicker
                value={draft.dueDate ?? ''}
                onChange={(v) => patch({ dueDate: v })}
                className={`${DRAWER_INPUT} tabular-nums`}
              />
            </FieldRow>

            <FieldRow icon={<IconFormula />} label="待办周期">
              <div className="px-2 pt-1.5 text-sm text-stone-500">
                {cycle === null ? '—' : `${cycle} 天`}
              </div>
            </FieldRow>

            <FieldRow icon={<IconFormula />} label="剩余天数">
              <div className="px-2 pt-1.5 text-sm text-stone-500">{remainText || '—'}</div>
            </FieldRow>

            <FieldRow icon={<IconText />} label="备注">
              <textarea
                value={draft.note ?? ''}
                onChange={(e) => patch({ note: e.target.value })}
                rows={4}
                placeholder="请输入内容"
                className="w-full resize-y rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white placeholder:text-stone-400"
              />
            </FieldRow>

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
              {busy ? '保存中…' : item ? '保存' : '新建'}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
export default function TodosBoard() {
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  const [live, setLive] = useState<boolean | null>(null);
  const [items, setItems] = useState<TodoItem[]>([]);
  /** 任务管理（独立插件）里的任务：作为「所属任务」的选项 */
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  /** 任务管理插件是否开启（关闭时待办里的「所属任务」只给提示） */
  const [tasksOn, setTasksOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [keyword, setKeywordState] = useState(() => readViewText(KEYWORD_PREF));
  const [priority, setPriorityState] = useState<PriorityFilter>(() =>
    readViewPref<PriorityFilter>(PRIORITY_FILTER_PREF, PRIORITY_FILTER_VALUES, 'all'),
  );
  const [groupBy, setGroupByState] = useState<GroupBy>(() =>
    readViewPref<GroupBy>(GROUP_BY_PREF, GROUP_BY_VALUES, 'status'),
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  /** 切分组方式：记住选择，刷新 / 重新进入页面后回到上次的分组 */
  function chooseGroupBy(next: GroupBy) {
    writeViewPref(GROUP_BY_PREF, next);
    setGroupByState(next);
  }

  /** 改紧急程度筛选：记住选择 */
  function choosePriority(next: PriorityFilter) {
    writeViewPref(PRIORITY_FILTER_PREF, next);
    setPriorityState(next);
  }

  /** 改搜索词：边输入边记住，重新进入页面仍按上次的关键词过滤 */
  function chooseKeyword(next: string) {
    writeViewText(KEYWORD_PREF, next);
    setKeywordState(next);
  }

  /** 未提交的单元格改动：id → 字段补丁 */
  const [edits, setEdits] = useState<Record<string, TodoPatch>>({});
  /** 分组内联新增行 */
  const [newRow, setNewRow] = useState<{
    groupKey: string;
    title: string;
    status: TodoStatus;
    priority: TodoPriority;
    taskId: string;
    startDate: string;
    dueDate: string;
    note: string;
    /** 开行时的状态 / 紧急程度：用来判断用户有没有动过，没动过就自动收起 */
    baseStatus: TodoStatus;
    basePriority: TodoPriority;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TodoItem[] | null>(null);
  const [adding, setAdding] = useState(false);
  /** 详情抽屉：null = 关闭；item = null 时是新建 */
  const [drawer, setDrawer] = useState<{
    item: TodoItem | null;
    preset?: { status?: TodoStatus; priority?: TodoPriority };
  } | null>(null);

  const aliveRef = useRef(true);
  /** 已关联任务的状态对齐只做一次（进页面时），轮询不再重复 */
  const reconciledRef = useRef(false);
  /** 单元格聚焦时暂停轮询，避免 AI 写入把正在输入的内容刷掉 */
  const editingRef = useRef(false);

  const cols = useColumnWidths('lh:todos:cols:v1', TODO_COLUMNS);
  const newRowOpen = newRow !== null;
  const newRowRef = useRef(newRow);
  newRowRef.current = newRow;
  /** 提交中标记走 ref：自动保存的调用方可能拿到旧闭包 */
  const addingRef = useRef(false);
  /** 交给 pointerdown 回调用的最新提交函数（函数声明在后面，靠 ref 取当前渲染的那份） */
  const submitNewRowRef = useRef<() => Promise<void>>(async () => {});
  submitNewRowRef.current = submitNewRow;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /**
   * 内联新增行离开时收尾：完全没填内容就收起；填了名称就自动保存（没有单独的保存 / 取消按钮）。
   * 用 pointerdown 而不是 blur：日期卡是 portal 到 body 的，
   * 点它会先让行内失焦，用 blur 会把刚选的日期连同新增行一起吞掉。
   */
  useEffect(() => {
    if (!newRowOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.tw-new-row') || target.closest('.tw-date-panel')) return;
      if (target.closest('.tw-select-menu')) return;
      const row = newRowRef.current;
      if (!row) return;
      // 有名称就当作填完了：离开这一行即自动保存（不再有单独的保存按钮）
      if (row.title.trim()) {
        void submitNewRowRef.current();
        return;
      }
      // 日期现在默认是今天，不能用「有没有值」判断：跟开行时的默认值一致才算没填过
      const today = todayIso();
      const pristine =
        !row.note.trim() &&
        !row.taskId &&
        row.status === row.baseStatus &&
        row.priority === row.basePriority &&
        row.startDate === today &&
        row.dueDate === today;
      if (pristine) setNewRow(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [newRowOpen]);

  const refresh = useCallback(async () => {
    try {
      const [list, taskList] = await Promise.all([
        listTodos(),
        tasksOn ? listTasks().catch(() => [] as TaskItem[]) : Promise.resolve([] as TaskItem[]),
      ]);
      if (!aliveRef.current) return;
      // 已关联的未完成待办：任务池 / 已完成 → 进行中（已关闭的任务不动）。
      // 只在进页面时补一次，避免轮询把用户后来手动改的状态反复刷回去。
      let shownTasks = taskList;
      if (!reconciledRef.current && tasksOn) {
        reconciledRef.current = true;
        const linked = new Set(
          list
            .filter((t) => t.status === 'pending' || t.status === 'in_progress')
            .map((t) => t.taskId)
            .filter(Boolean),
        );
        const needPromote = taskList.filter(
          (t) => linked.has(t.id) && (t.status === 'pool' || t.status === 'done'),
        );
        if (needPromote.length) {
          const promoted = await Promise.all(
            needPromote.map((t) => updateTask(t.id, { status: 'in_progress' }).catch(() => null)),
          );
          const byId = new Map(
            promoted.filter((t): t is TaskItem => Boolean(t)).map((t) => [t.id, t]),
          );
          shownTasks = taskList.map((t) => byId.get(t.id) ?? t);
        }
      }
      setItems(list);
      setTasks(shownTasks);
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tasksOn]);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => {
      setPluginOn(Boolean(map.todos));
      setTasksOn(Boolean(map.tasks));
    });
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('todos'));
      setTasksOn(isPluginEnabled('tasks'));
      setPluginReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchTodosHealth();
      if (!aliveRef.current) return;
      if (!ok) {
        setLive(false);
        return;
      }
      await refresh();
      if (aliveRef.current) setLive(true);
    })();
  }, [pluginReady, pluginOn, refresh]);

  // 工作台 AI 可能在会话里写入待办：停留在本页时定时 + 回到前台时刷新
  useEffect(() => {
    if (live !== true) return;
    const timer = window.setInterval(() => {
      if (!editingRef.current) void refresh();
    }, POLL_MS);
    const onFocus = () => {
      if (!editingRef.current) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [live, refresh]);

  /**
   * 任务管理开启后自动补关联：早期只写了任务名（linkedTask）的待办，
   * 按名称在任务列表里找到同名任务就回写 taskId，之后改名 / 改名任务都能跟着走。
   */
  useEffect(() => {
    if (!tasksOn || live !== true || tasks.length === 0) return;
    const pending = items.filter((x) => !x.taskId && x.linkedTask.trim());
    if (!pending.length) return;
    let cancelled = false;
    void (async () => {
      const linked: TodoItem[] = [];
      for (const todo of pending) {
        const match = tasks.find((x) => x.title.trim() === todo.linkedTask.trim());
        if (!match) continue;
        try {
          linked.push(await updateTodo(todo.id, { taskId: match.id }));
        } catch {
          // 单条自动关联失败不影响其它待办
        }
      }
      if (cancelled || !linked.length) return;
      setItems((prev) => prev.map((x) => linked.find((n) => n.id === x.id) ?? x));
    })();
    return () => {
      cancelled = true;
    };
  }, [tasksOn, live, items, tasks]);

  function patchField(id: string, field: keyof TodoInput, value: string) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  }

  function dropEdits(id: string) {
    setEdits((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  /** 可关联的任务：已关闭的任务不在选择范围内 */
  const taskOptions = useMemo(
    () => [
      { value: '', label: '不关联' },
      ...tasks
        .filter((t) => t.status !== 'closed' && t.status !== 'cancelled')
        .map((t) => ({ value: t.id, label: t.title })),
    ],
    [tasks],
  );

  /** 关联任务优先显示任务标题；老数据只有自由文本时退回原文本 */
  function taskLabelFor(item: Pick<TodoItem, 'taskId' | 'linkedTask'>): string {
    if (item.taskId) return tasks.find((t) => t.id === item.taskId)?.title ?? item.linkedTask;
    return item.linkedTask;
  }

  /** 单元格里「点一下就生效」的字段（状态 / 紧急程度 / 日期 / 所属任务） */
  async function patchItem(id: string, patch: TodoPatch) {
    setItems((prev) => prev.map((x) => (x.id === id ? ({ ...x, ...patch } as TodoItem) : x)));
    try {
      const updated = await updateTodo(id, patch);
      if (!aliveRef.current) return;
      setItems((prev) => prev.map((x) => (x.id === id ? updated : x)));
      setError(null);
      // 关联任务会把任务拉回「进行中」，重新拉一次任务列表
      if (patch.taskId) await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    }
  }

  /** 把某行的改动写回服务端；title 为空或没变化时只清草稿 */
  async function commitRow(id: string) {
    const patch = edits[id];
    const item = items.find((x) => x.id === id);
    if (!patch || !item) return;

    const changed: TodoPatch = {};
    const raw = item as unknown as Record<string, unknown>;
    for (const field of FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (String(raw[field] ?? '') === String(value)) continue;
      (changed as Record<string, unknown>)[field] = value;
    }
    if (!Object.keys(changed).length) {
      dropEdits(id);
      return;
    }
    if (typeof changed.title === 'string' && !changed.title.trim()) {
      setError('待办名称不能为空');
      dropEdits(id);
      return;
    }
    try {
      const updated = await updateTodo(id, changed);
      if (!aliveRef.current) return;
      setItems((prev) => prev.map((x) => (x.id === id ? updated : x)));
      setEdits((prev) => {
        const current = prev[id];
        if (!current) return prev;
        const next = { ...current };
        for (const field of Object.keys(changed)) {
          if (
            String((next as Record<string, unknown>)[field] ?? '') ===
            String((changed as Record<string, unknown>)[field] ?? '')
          ) {
            delete (next as Record<string, unknown>)[field];
          }
        }
        if (!Object.keys(next).length) {
          const rest = { ...prev };
          delete rest[id];
          return rest;
        }
        return { ...prev, [id]: next };
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      dropEdits(id);
    }
  }

  function startNewRow(group: TodoGroup) {
    const status = (group.newStatus ?? 'pending') as TodoStatus;
    const priority = group.newPriority ?? '';
    setNewRow({
      groupKey: group.key,
      title: '',
      status,
      priority,
      taskId: '',
      // 新增行默认今天开始、今天截止
      startDate: todayIso(),
      dueDate: todayIso(),
      note: '',
      baseStatus: status,
      basePriority: priority,
    });
    setCollapsed((prev) => ({ ...prev, [group.key]: false }));
  }

  async function submitNewRow() {
    // 走 ref 取最新的一行：点空白自动保存是从 pointerdown 回调里调用的，
    // 闭包里的 newRow 可能还是上一帧的对象。
    const row = newRowRef.current;
    if (!row || addingRef.current) return;
    const title = row.title.trim();
    if (!title) return;
    addingRef.current = true;
    setAdding(true);
    try {
      const task = tasks.find((t) => t.id === row.taskId);
      await createTodos(
        [
          {
            title,
            status: row.status,
            priority: row.priority,
            taskId: row.taskId,
            linkedTask: task?.title ?? '',
            startDate: row.startDate,
            dueDate: row.dueDate,
            note: row.note,
          },
        ],
        { mode: 'manual' },
      );
      // 期间可能又点开了别的分组的新增行，别把那一行清掉
      if (newRowRef.current === row) setNewRow(null);
      setError(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      addingRef.current = false;
      if (aliveRef.current) setAdding(false);
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusy(true);
    setError(null);
    try {
      await deleteTodos(target.map((x) => x.id));
      setSelected({});
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  const today = todayIso();

  const filtered = useMemo(
    () => filterTodos(items, { status: 'all', priority, keyword, today }),
    [items, priority, keyword, today],
  );
  const sorted = useMemo(() => sortTodos(filtered), [filtered]);

  const groups = useMemo<TodoGroup[]>(() => {
    if (groupBy === 'none') {
      return [
        {
          key: 'all',
          label: '全部待办',
          pill: 'bg-stone-500 text-white',
          items: sorted,
        },
      ];
    }
    if (groupBy === 'priority') {
      const order: TodoPriority[] = [...TODO_PRIORITIES, ''];
      return order.map((p) => ({
        key: `priority:${p || 'none'}`,
        label: p ? TODO_PRIORITY_LABEL[p] : '未设置',
        pill: p ? PRIORITY_PILL[p] : 'bg-stone-300 text-stone-600',
        items: sorted.filter((x) => x.priority === p),
        newPriority: p,
      }));
    }
    return STATUS_ORDER.map((s) => ({
      key: `status:${s}`,
      label: TODO_STATUS_LABEL[s],
      pill: STATUS_PILL[s],
      items: sorted.filter((x) => effectiveTodoStatus(x, today) === s),
      // 「已延期」是系统派生状态，新建时落到「待开始」
      newStatus: (s === 'overdue' ? 'pending' : s) as TodoStatus,
    }));
  }, [groupBy, sorted, today]);

  const visibleGroups = groups.filter(
    (g) => g.items.length > 0 || (newRow?.groupKey === g.key && Boolean(newRow)),
  );

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const counts = useMemo(() => {
    const c = { total: items.length, pending: 0, in_progress: 0, done: 0, overdue: 0 };
    for (const item of items) {
      const st = effectiveTodoStatus(item, today);
      if (st === 'overdue') c.overdue += 1;
      else if (st === 'pending') c.pending += 1;
      else if (st === 'in_progress') c.in_progress += 1;
      else if (st === 'done') c.done += 1;
    }
    return c;
  }, [items, today]);

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
        {pluginDisabledMessage('todos')}
      </div>
    );
  }

  if (live === null) {
    return (
      <div
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white"
        aria-busy="true"
        aria-label="正在连接待办服务"
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
        待办事项需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-stone-100 px-4 py-3">
        <div className="text-sm text-stone-600">
          共 <span className="font-medium text-stone-800">{counts.total}</span> 条
          <span className="text-stone-400">
            {' '}
            · 待开始 {counts.pending} · 进行中 {counts.in_progress} · 已完成 {counts.done}
            {counts.overdue ? ` · 已延期 ${counts.overdue}` : ''}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => chooseKeyword(e.target.value)}
            placeholder="搜索待办…"
            className="h-9 w-52 rounded-lg border border-stone-200 px-3 text-sm text-stone-800 outline-none focus:border-[#3370ff]"
          />
          <SelectDropdown
            flat
            className="w-[132px]"
            ariaLabel="分组方式"
            options={GROUP_BY_OPTIONS}
            value={groupBy}
            onChange={(next) => chooseGroupBy(next)}
          />
          <SelectDropdown
            flat
            className="w-[136px]"
            ariaLabel="紧急程度筛选"
            options={PRIORITY_FILTER_OPTIONS}
            value={priority}
            onChange={(next) => choosePriority(next)}
          />
          <button
            type="button"
            disabled={busy || selectedIds.length === 0}
            onClick={() => setDeleteTarget(items.filter((x) => selected[x.id]))}
            className="h-9 shrink-0 rounded-lg border border-red-200 px-3 text-sm font-medium whitespace-nowrap text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDrawer({ item: null })}
            className="h-9 shrink-0 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            + 新建待办
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

      <div
        className="min-h-0 flex-1 overflow-auto"
        onFocusCapture={() => {
          editingRef.current = true;
        }}
        onBlurCapture={() => {
          // 焦点在单元格之间移动时不解除；真正离开表格才恢复轮询
          window.setTimeout(() => {
            editingRef.current = Boolean(document.activeElement?.closest('.tw-todo-table'));
          }, 0);
        }}
      >
        <table
          className="tw-todo-table w-full table-fixed border-collapse text-sm"
          style={cols.tableStyle}
        >
          <colgroup>
            {TODO_COLUMNS.map((c) => (
              <col
                key={c.key}
                style={cols.widthOf(c.key) ? { width: cols.widthOf(c.key) } : undefined}
              />
            ))}
          </colgroup>
          <thead className="tw-table-head sticky top-0 z-10 text-xs text-stone-500">
            <tr>
              <th className="px-2 py-2 text-left font-medium">
                <input
                  type="checkbox"
                  aria-label="全选可见待办"
                  checked={sorted.length > 0 && sorted.every((x) => selected[x.id])}
                  onChange={(e) => {
                    const value = e.target.checked;
                    setSelected((prev) => {
                      const next = { ...prev };
                      for (const item of sorted) {
                        if (value) next[item.id] = true;
                        else delete next[item.id];
                      }
                      return next;
                    });
                  }}
                />
              </th>
              <th className="px-1 py-2 text-left font-medium" aria-label="行号" />
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                待办名称
                <ColumnResizeHandle {...cols.resizeProps(2)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                待办状态
                <ColumnResizeHandle {...cols.resizeProps(3)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                紧急程度
                <ColumnResizeHandle {...cols.resizeProps(4)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                所属任务
                <ColumnResizeHandle {...cols.resizeProps(5)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                开始日期
                <ColumnResizeHandle {...cols.resizeProps(6)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                截止日期
                <ColumnResizeHandle {...cols.resizeProps(7)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                结束日期
                <ColumnResizeHandle {...cols.resizeProps(8)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                周期
                <ColumnResizeHandle {...cols.resizeProps(9)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                剩余
                <ColumnResizeHandle {...cols.resizeProps(10)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                备注
                <ColumnResizeHandle {...cols.resizeProps(11)} />
              </th>
              <th className="px-1 py-2 text-center font-medium whitespace-nowrap">操作</th>
            </tr>
          </thead>

          {visibleGroups.map((group) => {
            const isCollapsed = collapsed[group.key] === true;
            return (
              <tbody key={group.key}>
                <tr className="border-t border-stone-100 bg-white">
                  <td colSpan={13} className="px-2 py-0 pt-3 pb-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((prev) => ({ ...prev, [group.key]: !isCollapsed }))
                      }
                      className="flex items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-stone-50"
                      aria-expanded={!isCollapsed}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="12"
                        height="12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className={`text-stone-400 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                      <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${group.pill}`}>
                        {group.label}
                      </span>
                      <span className="text-xs text-stone-400 tabular-nums">
                        {group.items.length} 条记录
                      </span>
                    </button>
                  </td>
                </tr>

                {isCollapsed
                  ? null
                  : group.items.map((item, index) => {
                      const draft = edits[item.id] ?? {};
                      const view = { ...item, ...draft } as TodoItem;
                      const shown = effectiveTodoStatus(view, today);
                      const cycle = todoCycleDays(view);
                      const remain = todoRemainingDays(view, today);
                      const remainText =
                        remain === null
                          ? '—'
                          : view.status === 'done'
                            ? '已完成'
                            : view.status === 'cancelled'
                              ? '已取消'
                              : remain < 0
                                ? `逾期 ${Math.abs(remain)} 天`
                                : remain === 0
                                  ? '今天截止'
                                  : `${remain} 天`;
                      return (
                        <tr
                          key={item.id}
                          className="group/row border-t border-stone-100 hover:bg-[#f7f8fa]"
                        >
                          <td className="px-2 py-1 align-middle">
                            <input
                              type="checkbox"
                              aria-label={`选择 ${item.title}`}
                              checked={Boolean(selected[item.id])}
                              onChange={(e) =>
                                setSelected((prev) => {
                                  const next = { ...prev };
                                  if (e.target.checked) next[item.id] = true;
                                  else delete next[item.id];
                                  return next;
                                })
                              }
                            />
                          </td>
                          <td className="px-1 py-1 align-middle text-xs text-stone-400 tabular-nums">
                            {index + 1}
                          </td>
                          <td className="px-1 py-1 align-middle">
                            <div className="flex min-w-0 items-center gap-1">
                              {item.source === 'ai' ? (
                                <span
                                  className="shrink-0 rounded bg-[#e1eaff] px-1 py-px text-[10px] text-[#1f4ec2]"
                                  title="AI 记录"
                                >
                                  AI
                                </span>
                              ) : null}
                              <TextCell
                                value={view.title}
                                placeholder="输入待办名称"
                                onChange={(v) => patchField(item.id, 'title', v)}
                                onCommit={() => void commitRow(item.id)}
                                onCancel={() => dropEdits(item.id)}
                              />
                            </div>
                          </td>
                          <td className="px-1.5 py-1 align-middle">
                            <SelectDropdown
                              unstyled
                              hideChevron
                              showCheck={false}
                              centerContent
                              ariaLabel="待办状态"
                              menuMinWidth={120}
                              options={STATUS_OPTIONS}
                              value={item.status}
                              onChange={(next) => void patchItem(item.id, { status: next })}
                              triggerClassName={`h-7 w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${STATUS_CELL[shown]}`}
                              renderTrigger={() => (
                                <span className="w-full truncate text-center">
                                  {TODO_STATUS_LABEL[item.status]}
                                </span>
                              )}
                              renderOptionPrefix={(o) => (
                                <span className={`h-2 w-2 rounded-full ${STATUS_DOT[o.value]}`} />
                              )}
                            />
                          </td>
                          <td className="px-1.5 py-1 align-middle">
                            <SelectDropdown
                              unstyled
                              hideChevron
                              showCheck={false}
                              centerContent
                              ariaLabel="紧急程度"
                              menuMinWidth={128}
                              options={PRIORITY_OPTIONS}
                              value={item.priority}
                              onChange={(next) => void patchItem(item.id, { priority: next })}
                              triggerClassName={`h-7 w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${PRIORITY_PILL[item.priority]}`}
                              renderTrigger={() => (
                                <span className="w-full truncate text-center">
                                  {item.priority ? TODO_PRIORITY_LABEL[item.priority] : '未设置'}
                                </span>
                              )}
                              renderOptionPrefix={(o) => (
                                <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[o.value]}`} />
                              )}
                            />
                          </td>
                          <td className="px-1 py-1 align-middle">
                            {tasksOn ? (
                              <SelectDropdown
                                unstyled
                                showCheck={false}
                                ariaLabel="所属任务"
                                menuMinWidth={220}
                                options={taskOptions}
                                value={view.taskId}
                                onChange={(next) => {
                                  const task = tasks.find((x) => x.id === next);
                                  void patchItem(item.id, {
                                    taskId: next,
                                    linkedTask: task?.title ?? '',
                                  });
                                }}
                                triggerClassName="h-8 w-full rounded-md px-1.5 text-sm hover:border-stone-200"
                                renderTrigger={() => (
                                  <span
                                    className={`truncate ${taskLabelFor(view) ? 'text-stone-800' : 'text-stone-300'}`}
                                  >
                                    {taskLabelFor(view) || '未关联'}
                                  </span>
                                )}
                              />
                            ) : (
                              <span className="block truncate px-1.5 text-xs text-stone-400">
                                {taskLabelFor(view)
                                  ? `${taskLabelFor(view)} · 插件未启用`
                                  : '任务管理插件未启用'}
                              </span>
                            )}
                          </td>
                          <td className="px-1 py-1 align-middle">
                            <DateCell
                              value={view.startDate}
                              onChange={(v) => void patchItem(item.id, { startDate: v })}
                            />
                          </td>
                          <td className="px-1 py-1 align-middle">
                            <DateCell
                              value={view.dueDate}
                              onChange={(v) => void patchItem(item.id, { dueDate: v })}
                            />
                          </td>
                          <td className="px-2 py-1 align-middle text-xs whitespace-nowrap tabular-nums">
                            {todoEndDate(view) ? (
                              <span className="text-stone-500">
                                {formatDateDisplay(todoEndDate(view))}
                              </span>
                            ) : (
                              <span className="text-stone-400">待办未完成</span>
                            )}
                          </td>
                          <td className="px-2 py-1 align-middle text-xs whitespace-nowrap text-stone-500 tabular-nums">
                            {cycle === null ? '—' : `${cycle} 天`}
                          </td>
                          <td
                            className={`px-2 py-1 align-middle text-xs whitespace-nowrap tabular-nums ${
                              remain !== null &&
                              remain < 0 &&
                              shown !== 'done' &&
                              shown !== 'cancelled'
                                ? 'font-medium text-[#c02a26]'
                                : 'text-stone-500'
                            }`}
                          >
                            {remainText}
                          </td>
                          <td className="px-1 py-1 align-middle">
                            <TextCell
                              value={view.note}
                              placeholder="—"
                              muted
                              onChange={(v) => patchField(item.id, 'note', v)}
                              onCommit={() => void commitRow(item.id)}
                              onCancel={() => dropEdits(item.id)}
                            />
                          </td>
                          <td className="px-1 py-1 text-right align-middle">
                            <div className="flex items-center justify-end gap-0.5">
                              <button
                                type="button"
                                onClick={() => setDrawer({ item })}
                                aria-label={`展开 ${item.title}`}
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
                                onClick={() => setDeleteTarget([item])}
                                aria-label={`删除 ${item.title}`}
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

                {isCollapsed ? null : newRow?.groupKey === group.key ? (
                  <tr className="tw-new-row border-t border-stone-100">
                    <td className="px-2 py-1 align-middle" />
                    <td className="px-1 py-1 align-middle text-xs text-stone-400 tabular-nums">
                      {group.items.length + 1}
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <input
                        autoFocus
                        value={newRow.title}
                        disabled={adding}
                        placeholder="输入待办名称，回车或点空白处保存"
                        onChange={(e) =>
                          setNewRow((prev) => (prev ? { ...prev, title: e.target.value } : prev))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void submitNewRow();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setNewRow(null);
                          }
                        }}
                        className="h-8 w-full truncate rounded-md border border-[#3370ff]/40 bg-white px-2 text-sm text-stone-800 outline-none focus:border-[#3370ff]"
                      />
                    </td>
                    <td className="px-1.5 py-1 align-middle">
                      <SelectDropdown
                        unstyled
                        hideChevron
                        showCheck={false}
                        centerContent
                        ariaLabel="待办状态"
                        menuMinWidth={120}
                        options={STATUS_OPTIONS}
                        value={newRow.status}
                        onChange={(next) =>
                          setNewRow((prev) => (prev ? { ...prev, status: next } : prev))
                        }
                        triggerClassName={`h-7 w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${STATUS_CELL[newRow.status]}`}
                        renderTrigger={() => (
                          <span className="w-full truncate text-center">
                            {TODO_STATUS_LABEL[newRow.status]}
                          </span>
                        )}
                        renderOptionPrefix={(o) => (
                          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[o.value]}`} />
                        )}
                      />
                    </td>
                    <td className="px-1.5 py-1 align-middle">
                      <SelectDropdown
                        unstyled
                        hideChevron
                        showCheck={false}
                        centerContent
                        ariaLabel="紧急程度"
                        menuMinWidth={128}
                        options={PRIORITY_OPTIONS}
                        value={newRow.priority}
                        onChange={(next) =>
                          setNewRow((prev) => (prev ? { ...prev, priority: next } : prev))
                        }
                        triggerClassName={`h-7 w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${PRIORITY_PILL[newRow.priority]}`}
                        renderTrigger={() => (
                          <span className="w-full truncate text-center">
                            {newRow.priority ? TODO_PRIORITY_LABEL[newRow.priority] : '未设置'}
                          </span>
                        )}
                        renderOptionPrefix={(o) => (
                          <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[o.value]}`} />
                        )}
                      />
                    </td>
                    <td className="px-1 py-1 align-middle">
                      {tasksOn ? (
                        <SelectDropdown
                          unstyled
                          showCheck={false}
                          ariaLabel="所属任务"
                          menuMinWidth={220}
                          options={taskOptions}
                          value={newRow.taskId}
                          onChange={(next) =>
                            setNewRow((prev) => (prev ? { ...prev, taskId: next } : prev))
                          }
                          triggerClassName="h-8 w-full rounded-md px-1.5 text-sm hover:border-stone-200"
                          renderTrigger={() => {
                            const task = tasks.find((x) => x.id === newRow.taskId);
                            return (
                              <span
                                className={`truncate ${task ? 'text-stone-800' : 'text-stone-300'}`}
                              >
                                {task?.title || '未关联'}
                              </span>
                            );
                          }}
                        />
                      ) : (
                        <span className="block truncate px-1.5 text-xs text-stone-400">
                          任务管理插件未启用
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <DatePicker
                        value={newRow.startDate}
                        onChange={(v) =>
                          setNewRow((prev) => (prev ? { ...prev, startDate: v } : prev))
                        }
                        placeholder="选择日期"
                        className="h-8 rounded-md border border-transparent px-1.5 text-sm text-stone-800 tabular-nums transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
                      />
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <DatePicker
                        value={newRow.dueDate}
                        onChange={(v) =>
                          setNewRow((prev) => (prev ? { ...prev, dueDate: v } : prev))
                        }
                        placeholder="选择日期"
                        className="h-8 rounded-md border border-transparent px-1.5 text-sm text-stone-800 tabular-nums transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
                      />
                    </td>
                    <td className="px-2 py-1 align-middle text-xs whitespace-nowrap tabular-nums">
                      {isTodoClosed(newRow.status) ? (
                        <span className="text-stone-500">{formatDateDisplay(todayIso())}</span>
                      ) : (
                        <span className="text-stone-400">待办未完成</span>
                      )}
                    </td>
                    <td className="px-2 py-1 align-middle text-xs whitespace-nowrap text-stone-400 tabular-nums">
                      —
                    </td>
                    <td className="px-2 py-1 align-middle text-xs whitespace-nowrap text-stone-400 tabular-nums">
                      —
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <input
                        value={newRow.note}
                        disabled={adding}
                        placeholder="—"
                        onChange={(e) =>
                          setNewRow((prev) => (prev ? { ...prev, note: e.target.value } : prev))
                        }
                        className="h-8 w-full truncate rounded-md border border-transparent bg-transparent px-1.5 text-sm text-stone-800 outline-none transition-colors placeholder:text-stone-300 hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
                      />
                    </td>
                    <td className="px-1 py-1 align-middle" />
                  </tr>
                ) : (
                  <tr className="border-t border-stone-100">
                    <td className="px-2 py-0.5" />
                    <td className="px-1 py-0.5" />
                    <td className="px-1 py-0.5" colSpan={11}>
                      <button
                        type="button"
                        disabled={adding}
                        onClick={() => startNewRow(group)}
                        className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 disabled:opacity-40"
                      >
                        <span className="text-sm leading-none">+</span>
                        新增记录
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}

          {visibleGroups.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={13} className="px-3 py-16 text-center text-sm text-stone-400">
                  {items.length === 0 ? '还没有待办' : '没有匹配的待办，试试调整搜索或筛选'}
                </td>
              </tr>
            </tbody>
          ) : null}
        </table>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-stone-100 px-4 py-2.5 text-xs text-stone-500">
        <span>
          共 {sorted.length} 条{selectedIds.length ? ` · 已选 ${selectedIds.length}` : ''}
        </span>
        <span className="ml-auto text-stone-400">点击单元格直接编辑，回车或点空白处保存</span>
      </div>

      <TodoDrawer
        open={drawer !== null}
        item={drawer?.item ?? null}
        preset={drawer?.preset}
        tasks={tasks}
        tasksOn={tasksOn}
        onClose={() => setDrawer(null)}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        title={deleteTarget && deleteTarget.length > 1 ? '批量删除' : '删除待办'}
        message={
          deleteTarget && deleteTarget.length > 1
            ? `确认删除已选中的 ${deleteTarget.length} 条待办？此操作不可恢复。`
            : `删除「${deleteTarget?.[0]?.title ?? ''}」？此操作不可恢复。`
        }
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
