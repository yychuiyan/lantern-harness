/**
 * AI / 手动新增待办、任务前的确认卡片。
 *
 * 待办分两页：
 *  - 第一页是待办自身字段（名称 / 状态 / 紧急程度 / 开始日期 / 截止日期 / 备注）；
 *  - 第二页只选「所属任务」，并展示该任务自动带出的状态、紧急程度与起止日期
 *    （选中任务时，开始日期 / 截止日期 / 紧急程度会一并带到第一页，仍可再改）。
 * 任务没有「所属任务」，一页填完。
 *
 * 只有点「确认新增」才落库；点「取消」或点卡片外面都直接关闭，不写入任何数据。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import DatePicker from './DatePicker';
import SelectDropdown from './SelectDropdown';
import {
  TODO_PRIORITIES,
  TODO_PRIORITY_LABEL,
  TODO_STATUS_LABEL,
  TODO_STATUSES,
  todayIso,
  type TodoPriority,
  type TodoStatus,
} from '../../lib/todos';
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  listTasks,
  type TaskItem,
  type TaskPriority,
  type TaskStatus,
} from '../../lib/tasks';

export type CreateKind = 'todo' | 'task';

export interface CreateDraftItem {
  title: string;
  status: string;
  priority: string;
  /** 所属任务（仅待办） */
  taskId: string;
  linkedTask: string;
  startDate: string;
  dueDate: string;
  note: string;
}

function blankDraft(kind: CreateKind): CreateDraftItem {
  return {
    title: '',
    status: kind === 'todo' ? 'pending' : 'pool',
    priority: '',
    taskId: '',
    linkedTask: '',
    // 新增默认今天开始、今天截止
    startDate: todayIso(),
    dueDate: todayIso(),
    note: '',
  };
}

export function normalizeCreateDraft(kind: CreateKind, raw: unknown): CreateDraftItem[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: CreateDraftItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) continue;
    const statusList = kind === 'todo' ? TODO_STATUSES : TASK_STATUSES;
    const priorityList = kind === 'todo' ? TODO_PRIORITIES : TASK_PRIORITIES;
    const base = blankDraft(kind);
    out.push({
      ...base,
      title,
      status:
        typeof r.status === 'string' && (statusList as readonly string[]).includes(r.status)
          ? r.status
          : kind === 'todo'
            ? 'pending'
            : 'pool',
      priority:
        typeof r.priority === 'string' && (priorityList as readonly string[]).includes(r.priority)
          ? r.priority
          : '',
      taskId: typeof r.taskId === 'string' ? r.taskId.trim() : '',
      linkedTask: typeof r.linkedTask === 'string' ? r.linkedTask.trim() : '',
      startDate: typeof r.startDate === 'string' ? r.startDate.trim().slice(0, 10) : base.startDate,
      dueDate: typeof r.dueDate === 'string' ? r.dueDate.trim().slice(0, 10) : base.dueDate,
      note: typeof r.note === 'string' ? r.note.trim() : '',
    });
  }
  return out;
}

/** 确认卡片回传给工具的参数（只带模型认识的字段） */
export function draftToCreateArgs(kind: CreateKind, items: CreateDraftItem[]) {
  return items.map((item) => {
    const out: Record<string, unknown> = {
      title: item.title.trim(),
      // 空字符串是「用户主动清空」的语义：带上它才能覆盖 AI 原参数里的旧值
      status: item.status,
      priority: item.priority,
      startDate: item.startDate,
      dueDate: item.dueDate,
      note: item.note,
    };
    if (kind === 'todo') {
      out.taskId = item.taskId;
      out.linkedTask = item.linkedTask;
    }
    return out;
  });
}

const labelCls = 'text-[11px] font-medium text-stone-500';
const fieldCls =
  'h-9 w-full rounded-lg border border-stone-200 px-2.5 text-[13px] text-stone-800 outline-none focus:border-[#4176e6]';

/** 2026-10-19 → 2026/10/19 */
function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return '';
  return `${match[1]}/${match[2]}/${match[3]}`;
}

function ReadonlyRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="shrink-0 text-[11px] text-stone-400">{props.label}</span>
      <span className="min-w-0 truncate text-[12px] text-stone-700">{props.children}</span>
    </div>
  );
}

export default function CreateConfirmCard(props: {
  kind: CreateKind;
  items: CreateDraftItem[];
  /** 任务管理插件是否开启（开启时待办卡片才给「所属任务」） */
  tasksOn?: boolean;
  /** true = 从「+ → 添加」手动打开：主按钮叫「提交」 */
  manual?: boolean;
  /** 退场动画中：保留 DOM，播完由外层卸载 */
  closing?: boolean;
  onConfirm: (items: CreateDraftItem[]) => void;
  onCancel: () => void;
}) {
  const [items, setItems] = useState<CreateDraftItem[]>(() => props.items);
  const [step, setStep] = useState(0);
  const [tasks, setTasks] = useState<TaskItem[]>([]);

  // 换了一条新确认（同一实例被复用）时，让本地草稿回到新数据
  useEffect(() => {
    setItems(props.items);
    setStep(0);
  }, [props.items]);

  const isTodo = props.kind === 'todo';
  const twoPages = isTodo;
  const noun = isTodo ? '待办' : '任务';
  const target = isTodo ? '待办事项' : '任务管理';
  const showTaskField = isTodo && props.tasksOn !== false;

  useEffect(() => {
    if (!showTaskField) return;
    let alive = true;
    void listTasks()
      .then((list) => {
        if (alive) setTasks(list);
      })
      .catch(() => {
        // 任务服务不可用时只隐藏选择，不影响新增待办
      });
    return () => {
      alive = false;
    };
  }, [showTaskField]);

  const statusValues: readonly string[] = isTodo ? TODO_STATUSES : TASK_STATUSES;
  const priorityValues: readonly string[] = isTodo ? TODO_PRIORITIES : TASK_PRIORITIES;
  const statusOptions = useMemo(
    () =>
      statusValues.map((value) => ({
        value,
        label: isTodo
          ? TODO_STATUS_LABEL[value as TodoStatus]
          : TASK_STATUS_LABEL[value as TaskStatus],
      })),
    [isTodo, statusValues],
  );
  const priorityOptions = useMemo(
    () => [
      { value: '', label: '未设置' },
      ...priorityValues.map((value) => ({
        value,
        label: isTodo
          ? TODO_PRIORITY_LABEL[value as TodoPriority]
          : TASK_PRIORITY_LABEL[value as TaskPriority],
      })),
    ],
    [isTodo, priorityValues],
  );
  /** 可关联的任务：已关闭的任务不在选择范围内 */
  const taskOptions = useMemo(
    () => [
      { value: '', label: '不关联' },
      ...tasks.filter((x) => x.status !== 'closed').map((x) => ({ value: x.id, label: x.title })),
    ],
    [tasks],
  );

  function patch(index: number, next: Partial<CreateDraftItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...next } : item)));
  }

  /**
   * 选中所属任务：把任务的开始 / 截止日期带过来（任务没填则保留待办原值），
   * 紧急程度只在待办没设置时带出，避免盖掉用户自己选的。
   */
  function pickTask(index: number, id: string) {
    const item = items[index];
    const task = tasks.find((x) => x.id === id);
    if (!task) {
      patch(index, { taskId: '', linkedTask: '' });
      return;
    }
    patch(index, {
      taskId: task.id,
      linkedTask: task.title,
      startDate: task.startDate || item?.startDate || '',
      dueDate: task.dueDate || item?.dueDate || '',
      priority: item?.priority || task.priority || '',
    });
  }

  function remove(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  const valid = items.length > 0 && items.every((item) => Boolean(item.title.trim()));
  const onSecondStep = twoPages && step >= 1;

  const footerHint = onSecondStep
    ? '所属任务的日期与紧急程度已带到第一页，可回去再调'
    : `确认后才会写入「${target}」`;

  return (
    <div
      className={[
        'tw-create-card tw-create-card-anim mb-2 flex max-h-[min(62vh,560px)] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_6px_24px_rgba(15,23,42,0.08)]',
        props.closing ? 'is-closing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="shrink-0 px-5 pt-4">
        <div className="mb-1 flex items-center gap-2 text-[11px] leading-4 text-stone-400">
          <span>
            新增 {items.length} 条{noun}
          </span>
          {twoPages ? (
            <>
              <span className="text-stone-300">·</span>
              <span className="tabular-nums">第 {step + 1} / 2 步</span>
            </>
          ) : null}
        </div>
        <h3 className="text-[15px] leading-5.5 font-medium text-stone-900">
          {onSecondStep ? '关联任务' : step === 0 ? `确认内容后再添加到${target}` : target}
        </h3>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3">
        <div className="space-y-3">
          {items.map((item, index) => {
            const linked = tasks.find((x) => x.id === item.taskId);
            return (
              <div key={index} className="rounded-xl border border-stone-200 bg-stone-50/40 p-3">
                {onSecondStep ? (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className={labelCls}>所属任务</span>
                      {tasks.length ? (
                        <SelectDropdown
                          flat
                          ariaLabel="所属任务"
                          options={taskOptions}
                          value={item.taskId}
                          onChange={(next) => pickTask(index, next)}
                          className="w-full"
                        />
                      ) : (
                        <span className="flex h-9 items-center rounded-lg border border-stone-200 bg-white px-2 text-[13px] text-stone-400">
                          任务管理里还没有任务，可稍后到任务管理关联
                        </span>
                      )}
                    </label>
                    {linked ? (
                      <div className="mt-2 space-y-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-2">
                        <ReadonlyRow label="任务名称">{linked.title}</ReadonlyRow>
                        <ReadonlyRow label="状态">
                          {TASK_STATUS_LABEL[linked.status] ?? linked.status}
                        </ReadonlyRow>
                        <ReadonlyRow label="紧急程度">
                          {linked.priority ? TASK_PRIORITY_LABEL[linked.priority] : '未设置'}
                        </ReadonlyRow>
                        <ReadonlyRow label="开始日期">
                          {formatDate(linked.startDate) || '未设置'}
                        </ReadonlyRow>
                        <ReadonlyRow label="结束日期">
                          {formatDate(linked.dueDate) || '未设置'}
                        </ReadonlyRow>
                      </div>
                    ) : (
                      <p className="mt-2 text-[11px] leading-4 text-stone-400">
                        选中任务后，它的开始 / 结束日期与紧急程度会自动带到第一页。
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex items-start gap-2">
                      <input
                        value={item.title}
                        onChange={(e) => patch(index, { title: e.target.value })}
                        placeholder={isTodo ? '待办名称' : '任务名称'}
                        className={`${fieldCls} bg-white`}
                        autoFocus={index === 0}
                      />
                      {items.length > 1 ? (
                        <button
                          type="button"
                          onClick={() => remove(index)}
                          aria-label="移除这一条"
                          className="h-9 shrink-0 rounded-lg px-2 text-[12px] text-stone-400 hover:bg-white hover:text-red-600"
                        >
                          移除
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="flex flex-col gap-1">
                        <span className={labelCls}>状态</span>
                        <SelectDropdown
                          flat
                          ariaLabel={isTodo ? '待办状态' : '任务状态'}
                          options={statusOptions}
                          value={item.status}
                          onChange={(next) => patch(index, { status: next })}
                          className="w-full"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className={labelCls}>紧急程度</span>
                        <SelectDropdown
                          flat
                          ariaLabel="紧急程度"
                          options={priorityOptions}
                          value={item.priority}
                          onChange={(next) => patch(index, { priority: next })}
                          className="w-full"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className={labelCls}>开始日期</span>
                        <DatePicker
                          value={item.startDate}
                          onChange={(value) => patch(index, { startDate: value })}
                          placeholder="选择日期"
                          className="h-9 rounded-lg border border-stone-200 bg-white px-2 text-[13px] tabular-nums"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className={labelCls}>截止日期</span>
                        <DatePicker
                          value={item.dueDate}
                          onChange={(value) => patch(index, { dueDate: value })}
                          placeholder="选择日期"
                          className="h-9 rounded-lg border border-stone-200 bg-white px-2 text-[13px] tabular-nums"
                        />
                      </label>
                    </div>
                    <label className="mt-2 flex flex-col gap-1">
                      <span className={labelCls}>备注</span>
                      <input
                        value={item.note}
                        onChange={(e) => patch(index, { note: e.target.value })}
                        placeholder="备注（可选）"
                        className={`${fieldCls} bg-white`}
                      />
                    </label>
                  </>
                )}
              </div>
            );
          })}
          {items.length ? null : (
            <p className="py-4 text-center text-[12px] text-stone-400">
              内容已清空，点「取消」放弃这次新增。
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-stone-100 px-5 py-3">
        <span className="min-w-0 truncate text-[11px] text-stone-400">{footerHint}</span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onSecondStep ? () => setStep(0) : props.onCancel}
            className="h-8 rounded-lg px-3 text-[12px] text-stone-600 outline-none hover:bg-stone-100"
          >
            {onSecondStep ? '上一步' : '取消'}
          </button>
          <button
            type="button"
            disabled={!onSecondStep && !valid}
            onClick={() => {
              if (twoPages && step === 0) setStep(1);
              else props.onConfirm(items);
            }}
            className="h-8 rounded-lg bg-[#4176e6] px-3.5 text-[12px] font-medium text-white hover:bg-[#3467d4] disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {twoPages && step === 0 ? '下一步' : props.manual ? '提交' : '确认新增'}
          </button>
        </div>
      </div>
    </div>
  );
}
