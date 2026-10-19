/**
 * 待办事项工具：让工作台会话直接读写空间级待办（与 /todos/ 页面同一份数据）。
 * 与 todo_write（会话内进度清单）区分：这里的待办跨会话长期保留。
 */
import {
  createTodos,
  deleteTodos,
  effectiveTodoStatus,
  filterTodos,
  listTodos,
  normalizeTodoInput,
  TODO_PRIORITIES,
  TODO_PRIORITY_LABEL,
  TODO_STATUS_LABEL,
  TODO_STATUSES,
  todoRemainingDays,
  updateTodo,
  type TodoItem,
  type TodoPatch,
  type TodoPriority,
  type TodoStatus,
} from './todos';

export const TODO_SYSTEM_HINT =
  '待办事项工具（空间级，跨会话保留，页面在 /todos/）：\n' +
  '- 用户让你「记一下 / 加个待办 / 跟进 / 周五前完成」时，调用 todo_add 记录；一次可传多条。\n' +
  '- 不要先用 ask_user_question 逐项追问待办字段。直接调用 todo_add，把已知内容填好；系统会弹出「待办快卡」：用户只需确认名称，状态自动为「进行中」、日期自动取当天、所属任务自动挂到「日常待办」（任务管理里没有就按 进行中 / 重要不紧急 / 当年第一天 ~ 当年最后一天 创建），点「确认新增」才落库。\n' +
  '- 用户明确说了要归到某个任务（如「加到登录模块这个任务下」）时，照常在 taskId / linkedTask 里填该任务，系统会保留你的指定，不再套「日常待办」。\n' +
  '- 用户没说待办内容时也直接调用 todo_add（items 传空数组或 [{ "title": "" }]），系统会打开空白快卡让用户自己填名称。\n' +
  '- 用户问「还有哪些待办 / 进度」时用 todo_list；完成后用 todo_update 把 status 改为 done；删掉用 todo_delete。\n' +
  '- 日期一律 YYYY-MM-DD；不确定截止日期就先不填，不要凭空猜测。\n' +
  '- 只记录用户明确要求或明确同意的事项，不要把闲聊、假设写成待办。';

const STATUS_ENUM = [...TODO_STATUSES, 'overdue', 'all'];

export const TODO_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'todo_add',
      description:
        'Create one or more long-lived todos in the current space (visible on the /todos/ page). Use when the user asks to note, follow up, or track something. This opens a compact confirm card where the user only checks the title: status defaults to in_progress, dates default to today, and the todo is attached to the "日常待办" task (auto-created when missing). Pass taskId/linkedTask only when the user explicitly named a task. Do not ask the user for the other fields first.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description:
              'Todos to create. Pass an empty array to open a blank confirm card for the user to fill in.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short imperative title.' },
                status: {
                  type: 'string',
                  enum: TODO_STATUSES,
                  description:
                    'New todos are always saved as in_progress; kept for update compatibility.',
                },
                priority: {
                  type: 'string',
                  enum: TODO_PRIORITIES,
                  description: 'urgent_important | important | urgent | normal. Omit when unclear.',
                },
                linkedTask: { type: 'string', description: 'Related task name / project name.' },
                taskId: {
                  type: 'string',
                  description:
                    'Task id from the 任务管理 plugin (task_add / task_list). Prefer over linkedTask. Omit to use the default 日常待办 task.',
                },
                startDate: {
                  type: 'string',
                  description: 'YYYY-MM-DD. Omit to default to today.',
                },
                dueDate: {
                  type: 'string',
                  description: 'YYYY-MM-DD. Omit to default to today; keep an explicit deadline.',
                },
                note: { type: 'string', description: 'Extra detail, dependencies, links.' },
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
      name: 'todo_list',
      description:
        'List long-lived todos of the current space, optionally filtered by status, priority or keyword.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: STATUS_ENUM, description: 'Default all.' },
          priority: {
            type: 'string',
            enum: [...TODO_PRIORITIES, 'all'],
            description: 'Default all.',
          },
          keyword: { type: 'string', description: 'Match title / linked task / note.' },
          limit: { type: 'number', description: 'Max rows, default 50.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'todo_update',
      description:
        'Update one todo by id. Only pass fields that change; use status "done" when the user finishes it.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Todo id from todo_list / todo_add.' },
          title: { type: 'string' },
          status: { type: 'string', enum: TODO_STATUSES },
          priority: { type: 'string', enum: TODO_PRIORITIES },
          linkedTask: { type: 'string' },
          taskId: { type: 'string', description: 'Task id; empty string unlinks.' },
          startDate: { type: 'string', description: 'YYYY-MM-DD.' },
          dueDate: { type: 'string', description: 'YYYY-MM-DD.' },
          note: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'todo_delete',
      description: 'Delete one or more todos by id.',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            description: 'Todo ids to delete.',
            items: { type: 'string' },
          },
        },
        required: ['ids'],
      },
    },
  },
];

function line(item: TodoItem): string {
  const st = effectiveTodoStatus(item);
  const remain = todoRemainingDays(item);
  const bits = [
    `[${item.id}] ${item.title}`,
    `状态=${TODO_STATUS_LABEL[st]}`,
    item.priority ? `紧急程度=${TODO_PRIORITY_LABEL[item.priority]}` : '',
    item.dueDate ? `截止=${item.dueDate}` : '',
    remain !== null && st !== 'done' && st !== 'cancelled'
      ? remain < 0
        ? `逾期${Math.abs(remain)}天`
        : `剩余${remain}天`
      : '',
    item.linkedTask ? `关联=${item.linkedTask}` : '',
    item.note ? `备注=${item.note}` : '',
  ];
  return bits.filter(Boolean).join(' | ');
}

function summaryOf(items: TodoItem[]): string {
  if (!items.length) return '当前没有匹配的待办。';
  return items.map((item, i) => `${i + 1}. ${line(item)}`).join('\n');
}

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && (TODO_STATUSES as readonly string[]).includes(value);
}

function isPriority(value: unknown): value is TodoPriority {
  return typeof value === 'string' && (TODO_PRIORITIES as readonly string[]).includes(value);
}

function toPatch(raw: Record<string, unknown>): TodoPatch {
  const patch: TodoPatch = {};
  if (typeof raw.title === 'string') patch.title = raw.title.trim();
  if (isStatus(raw.status)) patch.status = raw.status;
  if (isPriority(raw.priority)) patch.priority = raw.priority;
  if (typeof raw.linkedTask === 'string') patch.linkedTask = raw.linkedTask.trim();
  if (typeof raw.taskId === 'string') patch.taskId = raw.taskId.trim();
  if (typeof raw.startDate === 'string') patch.startDate = raw.startDate.trim();
  if (typeof raw.dueDate === 'string') patch.dueDate = raw.dueDate.trim();
  if (typeof raw.note === 'string') patch.note = raw.note.trim();
  return patch;
}

export async function runTodoTool(
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
    if (name === 'todo_add') {
      const rawItems = Array.isArray(args.items) ? args.items : [args];
      const parsed = rawItems
        .map(normalizeTodoInput)
        .filter((x): x is NonNullable<ReturnType<typeof normalizeTodoInput>> => Boolean(x));
      if (!parsed.length) return JSON.stringify({ error: '待办名称不能为空' });
      const created = await createTodos(parsed, { mode: 'ai', sessionId: meta.sessionId });
      return JSON.stringify({
        ok: true,
        count: created.length,
        items: created,
        summary: `已记录 ${created.length} 条待办：\n${summaryOf(created)}`,
      });
    }

    if (name === 'todo_list') {
      const all = await listTodos();
      const statusRaw = args.status;
      const status = isStatus(statusRaw)
        ? statusRaw
        : statusRaw === 'overdue'
          ? ('overdue' as const)
          : ('all' as const);
      const priority = isPriority(args.priority) ? args.priority : ('all' as const);
      const keyword = typeof args.keyword === 'string' ? args.keyword : '';
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      const matched = filterTodos(all, { status, priority, keyword }).slice(0, limit);
      return JSON.stringify({
        ok: true,
        total: all.length,
        count: matched.length,
        items: matched,
        summary: summaryOf(matched),
      });
    }

    if (name === 'todo_update') {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return JSON.stringify({ error: '缺少待办 id' });
      const patch = toPatch(args);
      if (!Object.keys(patch).length) return JSON.stringify({ error: '没有可更新的字段' });
      const item = await updateTodo(id, patch);
      return JSON.stringify({
        ok: true,
        item,
        summary: `已更新待办：${line(item)}`,
      });
    }

    if (name === 'todo_delete') {
      const ids = (Array.isArray(args.ids) ? args.ids : [args.id])
        .filter((x): x is string => typeof x === 'string' && Boolean(x.trim()))
        .map((x) => x.trim());
      if (!ids.length) return JSON.stringify({ error: '缺少待办 id' });
      const removed = await deleteTodos(ids);
      return JSON.stringify({ ok: true, removed, summary: `已删除 ${removed} 条待办。` });
    }

    return JSON.stringify({ error: `unknown todo tool: ${name}` });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}
