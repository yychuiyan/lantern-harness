/**
 * 工作台里 AI 识别到「新增待办」时的自动填充规则（与「+ → 待办」的手动表单区分）。
 *
 * - 待办：状态固定「进行中」，开始 / 截止日期都取当天；
 * - 所属任务：默认挂到「日常待办」；任务管理里没有就按固定字段补一条
 *   （进行中 / 重要不紧急 / 当年第一天 ~ 当年最后一天）；
 * - 模型已经明确指定了任务（taskId 或任务名）时尊重它，不再套「日常待办」。
 *
 * 这里只放可单测的纯逻辑与两个异步入口，界面在 CreateConfirmCard 的 quick 模式。
 */
import { createTasks, listTasks, type TaskItem } from './tasks';
import { todayIso } from './todos';

/** 默认归入的任务名；任务管理里按名称精确匹配 */
export const ROUTINE_TASK_TITLE = '日常待办';

/** 新建「日常待办」时用的固定字段 */
export interface RoutineTaskFields {
  title: string;
  status: 'in_progress';
  priority: 'important';
  startDate: string;
  dueDate: string;
}

/** 待办草稿里与自动填充相关的最小字段集（与 CreateDraftItem 结构兼容） */
export interface QuickTodoDraft {
  title: string;
  status: string;
  priority: string;
  taskId: string;
  linkedTask: string;
  startDate: string;
  dueDate: string;
  note: string;
}

/**
 * 「日常待办」任务的字段：进行中 + 重要不紧急 + 当年第一天到当年最后一天。
 * 年份取 today 的前四位，跨年后再记待办会自然落到新一年。
 */
export function routineTaskFields(today: string = todayIso()): RoutineTaskFields {
  const year = /^\d{4}/.test(today) ? today.slice(0, 4) : String(new Date().getFullYear());
  return {
    title: ROUTINE_TASK_TITLE,
    status: 'in_progress',
    priority: 'important',
    startDate: `${year}-01-01`,
    dueDate: `${year}-12-31`,
  };
}

/**
 * 从任务列表里挑一个可用的「日常待办」：
 * 优先进行中，其次其它未关闭 / 未取消的同名任务；只有已关闭 / 已取消时返回 null，
 * 由调用方新建一条（不擅自改回用户已经关掉的任务）。
 */
export function pickRoutineTask(tasks: readonly TaskItem[]): TaskItem | null {
  const same = tasks.filter((task) => task.title.trim() === ROUTINE_TASK_TITLE);
  const open = same.filter((task) => task.status !== 'closed' && task.status !== 'cancelled');
  return open.find((task) => task.status === 'in_progress') ?? open[0] ?? null;
}

/** 按 id 或名称找 AI 指定的任务（名称精确匹配，多个同名取未关闭的第一个） */
export function findTaskByHint(
  tasks: readonly TaskItem[],
  hint: { taskId?: string; linkedTask?: string },
): TaskItem | null {
  const id = hint.taskId?.trim();
  if (id) {
    const byId = tasks.find((task) => task.id === id);
    if (byId) return byId;
  }
  const title = hint.linkedTask?.trim();
  if (!title) return null;
  const same = tasks.filter((task) => task.title.trim() === title);
  return (
    same.find((task) => task.status !== 'closed' && task.status !== 'cancelled') ?? same[0] ?? null
  );
}

/**
 * 快卡的日期区间：默认当天，模型给了合法日期就按它的。
 * - 只给截止日期：开始日取「今天与截止日中较早的那个」，不会倒挂；
 * - 只给开始日期：截止日 = 开始日（单日待办）；
 * - 两者都给但截止早于开始：把截止拉到开始日。
 */
export function quickTodoDates(
  startDate: string,
  dueDate: string,
  today: string = todayIso(),
): { startDate: string; dueDate: string } {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const hasStart = valid(startDate);
  const hasDue = valid(dueDate);
  const start = hasStart ? startDate : hasDue && dueDate < today ? dueDate : today;
  const due = hasDue ? (dueDate < start ? start : dueDate) : start;
  return { startDate: start, dueDate: due };
}

export interface QuickTodoPlan<T extends QuickTodoDraft> {
  items: T[];
  /** 任务服务是否可用；不可用时卡片不展示「所属任务」，也不自动建任务 */
  tasksAvailable: boolean;
  /** 确认后会新建「日常待办」任务（卡片上给一句提示） */
  willCreateRoutine: boolean;
}

/**
 * 打开确认卡片前的准备：状态固定「进行中」、日期缺省取当天，并解析所属任务。
 * 只读任务列表，不写任何数据 —— 用户取消时不能留下一条空任务。
 */
export async function planQuickTodo<T extends QuickTodoDraft>(
  items: T[],
  today: string = todayIso(),
): Promise<QuickTodoPlan<T>> {
  let tasks: TaskItem[] = [];
  let tasksAvailable = true;
  try {
    tasks = await listTasks();
  } catch {
    tasksAvailable = false;
  }

  const routine = tasksAvailable ? pickRoutineTask(tasks) : null;
  const next = items.map((item) => {
    // 状态固定进行中；日期按 quickTodoDates 归一成合法区间
    const out = {
      ...item,
      status: 'in_progress',
      ...quickTodoDates(item.startDate, item.dueDate, today),
    } as T;
    if (!tasksAvailable) return { ...out, taskId: '', linkedTask: '' } as T;
    const hinted = findTaskByHint(tasks, item);
    if (hinted) return { ...out, taskId: hinted.id, linkedTask: hinted.title } as T;
    // 模型给了一个任务名但任务管理里没有：不凭空建任务，只保留这段文字说明
    if (item.linkedTask.trim()) return { ...out, taskId: '' } as T;
    return {
      ...out,
      taskId: routine?.id ?? '',
      linkedTask: routine?.title ?? ROUTINE_TASK_TITLE,
    } as T;
  });
  const willCreateRoutine =
    !routine &&
    tasksAvailable &&
    next.some((item) => !item.taskId.trim() && item.linkedTask.trim() === ROUTINE_TASK_TITLE);
  return { items: next, tasksAvailable, willCreateRoutine };
}

/**
 * 确认之后：把需要「日常待办」的待办补上 taskId。
 * 任务不存在时才创建（字段见 routineTaskFields）；其余待办原样返回。
 */
export async function attachQuickTodoTasks<T extends QuickTodoDraft>(items: T[]): Promise<T[]> {
  const needsRoutine = items.some(
    (item) => !item.taskId.trim() && item.linkedTask.trim() === ROUTINE_TASK_TITLE,
  );
  if (!needsRoutine) return items;

  const tasks = await listTasks();
  let found = pickRoutineTask(tasks);
  if (!found) {
    const [created] = await createTasks([routineTaskFields()], { mode: 'ai' });
    found = created ?? null;
  }
  const routine = found;
  if (!routine) throw new Error('创建「日常待办」任务失败');

  return items.map((item) =>
    !item.taskId.trim() && item.linkedTask.trim() === ROUTINE_TASK_TITLE
      ? ({
          ...item,
          taskId: routine.id,
          linkedTask: routine.title,
          // 紧急程度跟随所属任务，顺手写成「日常待办」的紧急程度，关掉任务插件时也一致
          priority: routine.priority,
        } as T)
      : item,
  );
}
