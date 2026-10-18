/**
 * 任务管理工具：让工作台会话直接读写空间级任务（与 /tasks/ 页面同一份数据）。
 *
 * 写入前由 ChatApp 弹确认卡片（可改名称 / 状态 / 紧急程度 / 日期 / 备注），
 * 用户确认后才真正落库；取消时返回 cancelled，模型不会误以为已经创建。
 */
import {
  createTasks,
  deleteTasks,
  filterTasks,
  isTaskPriority,
  listTasks,
  normalizeTaskInput,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  taskCycleDays,
  updateTask,
  type TaskItem,
  type TaskPatch,
  type TaskStatus,
} from './tasks';

export const TASK_SYSTEM_HINT =
  '任务管理工具（空间级，跨会话保留，页面在 /tasks/）：\n' +
  '- 用户说「建个任务 / 开个项目任务 / 把这件事拆成任务」时调用 task_add；一次可传多条。\n' +
  '- 不要先用 ask_user_question 逐项追问任务字段。直接调用 task_add，把已知字段填好；系统会弹出与「+ → 任务」完全相同的确认卡片，用户在卡片里补充或修改，点「确认新增」才落库。\n' +
  '- 用户没说任务内容时也直接调用 task_add（items 传空数组或 [{ "title": "" }]），系统会打开空白确认卡片让用户自己填。\n' +
  '- 只查询用 task_list；改状态 / 日期用 task_update；删任务用 task_delete。\n' +
  '- 任务下的待办用 todo_add 的 taskId 关联，任务本身不重复记录待办内容。\n' +
  '- 日期一律 YYYY-MM-DD；不确定就先不填，不要凭空猜测。';

const STATUS_ENUM = [...TASK_STATUSES, 'urgent', 'all'];

function isStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

function line(item: TaskItem): string {
  const cycle = taskCycleDays(item);
  const bits = [
    `[${item.id}] ${item.title}`,
    `状态=${TASK_STATUS_LABEL[item.status]}`,
    item.priority ? `紧急程度=${TASK_PRIORITY_LABEL[item.priority]}` : '',
    item.startDate ? `开始=${item.startDate}` : '',
    item.dueDate ? `截止=${item.dueDate}` : '',
    cycle === null ? '' : `周期=${cycle}天`,
    item.note ? `备注=${item.note}` : '',
  ];
  return bits.filter(Boolean).join(' | ');
}

function summaryOf(items: TaskItem[]): string {
  if (!items.length) return '当前没有匹配的任务。';
  return items.map((item, i) => `${i + 1}. ${line(item)}`).join('\n');
}

export const TASK_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'task_add',
      description:
        'Create one or more long-lived tasks in the current space (visible on the /tasks/ page). Use when the user asks to create a task / project item. This opens the same editable confirm card as the manual + menu, so do not ask the user for the fields first.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description:
              'Tasks to create. Pass an empty array to open a blank confirm card for the user to fill in.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short task title.' },
                status: {
                  type: 'string',
                  enum: TASK_STATUSES,
                  description: 'pool | in_progress | done | closed. Default pool.',
                },
                priority: {
                  type: 'string',
                  enum: TASK_PRIORITIES,
                  description: 'urgent_important | important | urgent | normal. Omit when unclear.',
                },
                startDate: { type: 'string', description: 'YYYY-MM-DD.' },
                dueDate: { type: 'string', description: 'YYYY-MM-DD.' },
                note: { type: 'string', description: 'Extra detail, scope, links.' },
              },
              required: ['title'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task_list',
      description:
        'List tasks of the current space, optionally filtered by status, priority or keyword.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: STATUS_ENUM, description: 'Default all.' },
          priority: {
            type: 'string',
            enum: [...TASK_PRIORITIES, 'all'],
            description: 'Default all.',
          },
          keyword: { type: 'string', description: 'Match title / note.' },
          limit: { type: 'number', description: 'Max rows, default 50.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task_update',
      description: 'Update one task by id. Only pass fields that change.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from task_list / task_add.' },
          title: { type: 'string' },
          status: { type: 'string', enum: TASK_STATUSES },
          priority: { type: 'string', enum: [...TASK_PRIORITIES, ''] },
          startDate: { type: 'string', description: 'YYYY-MM-DD; empty string clears.' },
          dueDate: { type: 'string', description: 'YYYY-MM-DD; empty string clears.' },
          note: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task_delete',
      description: 'Delete one or more tasks by id. Linked todos are kept (only unlinked).',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            description: 'Task ids to delete.',
            items: { type: 'string' },
          },
        },
        required: ['ids'],
      },
    },
  },
];

/** 工具入参 → 批量创建用的字段（过滤空标题） */
export function parseTaskAddItems(argsJson: string): Record<string, unknown>[] {
  try {
    const args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    const raw = Array.isArray(args.items) ? args.items : [args];
    return raw.filter(
      (x): x is Record<string, unknown> =>
        Boolean(x) && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string',
    );
  } catch {
    return [];
  }
}

export async function runTaskTool(
  name: string,
  argsJson: string,
  meta: { sessionId?: string } = {},
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }

  try {
    if (name === 'task_add') {
      const rawItems = Array.isArray(args.items) ? args.items : [args];
      const parsed = rawItems
        .map(normalizeTaskInput)
        .filter((x): x is NonNullable<ReturnType<typeof normalizeTaskInput>> => Boolean(x));
      if (!parsed.length) return JSON.stringify({ error: '任务名称不能为空' });
      const created = await createTasks(parsed, { mode: 'ai', sessionId: meta.sessionId });
      return JSON.stringify({
        ok: true,
        count: created.length,
        items: created,
        summary: `已创建 ${created.length} 个任务：\n${summaryOf(created)}`,
      });
    }

    if (name === 'task_list') {
      const all = await listTasks();
      const statusRaw = args.status;
      const status = isStatus(statusRaw)
        ? statusRaw
        : statusRaw === 'urgent'
          ? ('urgent' as const)
          : ('all' as const);
      const priority =
        typeof args.priority === 'string' &&
        (TASK_PRIORITIES as readonly string[]).includes(args.priority)
          ? (args.priority as TaskItem['priority'])
          : ('all' as const);
      const keyword = typeof args.keyword === 'string' ? args.keyword : '';
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      const matched = filterTasks(all, { status, priority, keyword }).slice(0, limit);
      return JSON.stringify({
        ok: true,
        total: all.length,
        count: matched.length,
        items: matched,
        summary: summaryOf(matched),
      });
    }

    if (name === 'task_update') {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return JSON.stringify({ error: '缺少任务 id' });
      const patch: TaskPatch = {};
      if (typeof args.title === 'string') patch.title = args.title.trim();
      if (isStatus(args.status)) patch.status = args.status;
      if (args.priority === '') patch.priority = '';
      else if (isTaskPriority(args.priority)) patch.priority = args.priority;
      if (typeof args.startDate === 'string') patch.startDate = args.startDate.trim();
      if (typeof args.dueDate === 'string') patch.dueDate = args.dueDate.trim();
      if (typeof args.note === 'string') patch.note = args.note.trim();
      if (!Object.keys(patch).length) return JSON.stringify({ error: '没有可更新的字段' });
      const item = await updateTask(id, patch);
      return JSON.stringify({ ok: true, item, summary: `已更新任务：${line(item)}` });
    }

    if (name === 'task_delete') {
      const ids = (Array.isArray(args.ids) ? args.ids : [args.id])
        .filter((x): x is string => typeof x === 'string' && Boolean(x.trim()))
        .map((x) => x.trim());
      if (!ids.length) return JSON.stringify({ error: '缺少任务 id' });
      const removed = await deleteTasks(ids);
      return JSON.stringify({ ok: true, removed, summary: `已删除 ${removed} 个任务。` });
    }

    return JSON.stringify({ error: `unknown task tool: ${name}` });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}
