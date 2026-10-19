/**
 * 项目管理工具：让工作台会话直接读写项目 / 迭代 / 需求 / 缺陷。
 *
 * 四组工具分别随对应插件开关注入；名称都带 `pm_` 前缀，避免与
 * 「需求文档库」等既有工具混淆。写操作只接受用户明确要求。
 */
import {
  BUG_SEVERITIES,
  BUG_STATUSES,
  createPmItems,
  deletePmItems,
  fetchPmStore,
  filterBugs,
  filterIterations,
  filterProjects,
  filterRequirements,
  findByName,
  findRequirementByTitle,
  ITERATION_STATUSES,
  iterationOverdueDays,
  iterationProgressPercent,
  projectStats,
  PROJECT_STATUSES,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUSES,
  updatePmItem,
  type BugItem,
  type IterationItem,
  type PmStore,
  type ProjectItem,
  type RequirementItem,
} from './pm';

const DATE_NOTE = '日期一律 YYYY-MM-DD；不确定就不要填，不要凭空猜测。';

const COMMON =
  '写操作只在用户明确要求时执行；改 / 删之前先用 list 拿到真实 id，不要臆造 id。' +
  '参数可以用 id，也可以传名称（project / iteration / requirement），系统先精确再忽略大小写匹配。' +
  DATE_NOTE;

export const PM_PROJECT_SYSTEM_HINT =
  '项目列表工具（空间级，页面在 /pm/projects/）：' +
  COMMON +
  '新建项目只需要 name；归档用 pm_project_update 把 status 改成 archived。' +
  '删除项目会连带删掉它的迭代、需求与缺陷，执行前先向用户确认影响范围。';

export const PM_ITERATION_SYSTEM_HINT =
  '迭代管理工具（空间级，页面在 /pm/iterations/）：' +
  COMMON +
  '迭代必须挂在项目下；endDate 不能早于 startDate。' +
  '进度按日期流逝计算，不要把它当成需求完成度。';

export const PM_REQUIREMENT_SYSTEM_HINT =
  '需求管理工具（空间级，页面在 /pm/requirements/）：' +
  COMMON +
  '需求必须挂在项目下，iterationId 可留空表示未排期；编号 REQ-### 由系统分配，不要自己编。' +
  'acceptanceCriteria 是 [{ text, done }] 数组，仅在用户给出验收标准时填写。';

export const PM_BUG_SYSTEM_HINT =
  '缺陷管理工具（空间级，页面在 /pm/bugs/）：' +
  COMMON +
  '缺陷必须挂在项目下；iterationId / requirementId 可留空，填了就必须属于同一项目。' +
  '编号 BUG-### 由系统分配，不要自己编。';

const LIST_FILTER = {
  project: { type: 'string', description: 'Project name (exact, then case-insensitive).' },
  projectId: { type: 'string', description: 'Project id from pm_project_list. Prefer this.' },
  keyword: { type: 'string', description: 'Match name / description / title.' },
  limit: { type: 'number', description: 'Max rows, default 50.' },
};

export const PM_PROJECT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'pm_project_list',
      description:
        'List projects in the current space with iteration / requirement / bug counts. Use before any project write to get ids.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: [...PROJECT_STATUSES, 'all'] },
          keyword: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pm_project_add',
      description:
        'Create one or more projects. Only when the user explicitly asks. name is required.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                status: { type: 'string', enum: PROJECT_STATUSES },
              },
              required: ['name'],
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
      name: 'pm_project_update',
      description: 'Update one project by id or name. Only pass fields that change.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          project: { type: 'string', description: 'Project name, used when id is omitted.' },
          name: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: PROJECT_STATUSES },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pm_project_delete',
      description:
        'Delete projects by id or name. Also deletes their iterations, requirements and bugs; confirm scope with the user first.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          id: { type: 'string' },
          project: { type: 'string' },
        },
      },
    },
  },
];

export const PM_ITERATION_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'pm_iteration_list',
      description:
        'List iterations, optionally filtered by project / status. Includes date-based progress and overdue days.',
      parameters: {
        type: 'object',
        properties: {
          ...LIST_FILTER,
          status: { type: 'string', enum: [...ITERATION_STATUSES, 'all'] },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pm_iteration_add',
      description: 'Create one or more iterations under a project.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name (exact, then case-insensitive).' },
          projectId: { type: 'string', description: 'Project id. Prefer this.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                startDate: { type: 'string', description: 'YYYY-MM-DD.' },
                endDate: { type: 'string', description: 'YYYY-MM-DD, not before startDate.' },
                status: { type: 'string', enum: ITERATION_STATUSES },
                remark: { type: 'string' },
              },
              required: ['name'],
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
      name: 'pm_iteration_update',
      description:
        'Update one iteration by id or name. Use status "done" when the iteration is closed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          iteration: { type: 'string', description: 'Iteration name, used when id is omitted.' },
          project: { type: 'string' },
          projectId: { type: 'string' },
          name: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          status: { type: 'string', enum: ITERATION_STATUSES },
          remark: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pm_iteration_delete',
      description:
        'Delete iterations by id or name. Requirements and bugs keep existing but lose the iteration link.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          id: { type: 'string' },
          iteration: { type: 'string' },
        },
      },
    },
  },
];

export const PM_REQUIREMENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'pm_requirement_list',
      description:
        'List requirements, optionally filtered by project / iteration / status / priority / keyword.',
      parameters: {
        type: 'object',
        properties: {
          ...LIST_FILTER,
          iteration: { type: 'string' },
          iterationId: { type: 'string' },
          status: { type: 'string', enum: [...REQUIREMENT_STATUSES, 'all'] },
          priority: { type: 'string', enum: [...REQUIREMENT_PRIORITIES, 'all'] },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pm_requirement_add',
      description:
        'Create one or more requirements under a project. The REQ-### code is assigned by the server.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          projectId: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                iterationId: {
                  type: 'string',
                  description: 'Optional; must belong to the project.',
                },
                iteration: { type: 'string', description: 'Iteration name instead of id.' },
                priority: { type: 'string', enum: REQUIREMENT_PRIORITIES },
                status: { type: 'string', enum: REQUIREMENT_STATUSES },
                description: { type: 'string' },
                acceptanceCriteria: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { text: { type: 'string' }, done: { type: 'boolean' } },
                    required: ['text'],
                  },
                },
                githubIssue: { type: 'string' },
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
      name: 'pm_requirement_update',
      description:
        'Update one requirement by id, REQ code or title. Use status "done" when it is completed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          requirement: { type: 'string', description: 'Requirement title or REQ-###.' },
          project: { type: 'string' },
          projectId: { type: 'string' },
          iteration: { type: 'string' },
          iterationId: { type: 'string' },
          title: { type: 'string' },
          priority: { type: 'string', enum: REQUIREMENT_PRIORITIES },
          status: { type: 'string', enum: REQUIREMENT_STATUSES },
          description: { type: 'string' },
          acceptanceCriteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, done: { type: 'boolean' } },
              required: ['text'],
            },
          },
          githubIssue: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pm_requirement_delete',
      description: 'Delete requirements by id, REQ code or title. Linked bugs lose the link.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          id: { type: 'string' },
          requirement: { type: 'string' },
        },
      },
    },
  },
];

export const PM_BUG_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'pm_bug_list',
      description:
        'List bugs, optionally filtered by project / iteration / status / severity / keyword.',
      parameters: {
        type: 'object',
        properties: {
          ...LIST_FILTER,
          iteration: { type: 'string' },
          iterationId: { type: 'string' },
          status: { type: 'string', enum: [...BUG_STATUSES, 'all'] },
          severity: { type: 'string', enum: [...BUG_SEVERITIES, 'all'] },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pm_bug_add',
      description:
        'Create one or more bugs under a project. The BUG-### code is assigned by the server.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          projectId: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                iterationId: { type: 'string' },
                iteration: { type: 'string' },
                requirementId: { type: 'string' },
                requirement: { type: 'string', description: 'Requirement title or REQ-###.' },
                severity: { type: 'string', enum: BUG_SEVERITIES },
                status: { type: 'string', enum: BUG_STATUSES },
                reproduceSteps: { type: 'string' },
                expectedResult: { type: 'string' },
                actualResult: { type: 'string' },
                environment: { type: 'string' },
                githubIssue: { type: 'string' },
                attachment: { type: 'string' },
                remark: { type: 'string' },
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
      name: 'pm_bug_update',
      description:
        'Update one bug by id, BUG code or title. Use status "closed" when it is verified.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          bug: { type: 'string', description: 'Bug title or BUG-###.' },
          project: { type: 'string' },
          projectId: { type: 'string' },
          iteration: { type: 'string' },
          iterationId: { type: 'string' },
          requirement: { type: 'string' },
          requirementId: { type: 'string' },
          title: { type: 'string' },
          severity: { type: 'string', enum: BUG_SEVERITIES },
          status: { type: 'string', enum: BUG_STATUSES },
          reproduceSteps: { type: 'string' },
          expectedResult: { type: 'string' },
          actualResult: { type: 'string' },
          environment: { type: 'string' },
          githubIssue: { type: 'string' },
          attachment: { type: 'string' },
          remark: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pm_bug_delete',
      description: 'Delete bugs by id, BUG code or title.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          id: { type: 'string' },
          bug: { type: 'string' },
        },
      },
    },
  },
];

/* ------------------------------ 解析与执行 ------------------------------ */

/** 工具入参里取出字符串；空串也当作未提供 */
function arg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

function resolveProjectId(store: PmStore, args: Record<string, unknown>): string {
  const id = arg(args, 'projectId');
  if (id) return store.projects.some((p) => p.id === id) ? id : '';
  return findByName(store.projects, arg(args, 'project'));
}

function resolveIterationId(
  store: PmStore,
  projectId: string,
  args: Record<string, unknown>,
): string {
  const id = arg(args, 'iterationId');
  if (id)
    return store.iterations.some((it) => it.id === id && it.projectId === projectId) ? id : '';
  const name = arg(args, 'iteration');
  if (!name) return '';
  const match = store.iterations.find((it) => it.projectId === projectId && it.name === name);
  if (match) return match.id;
  const lower = name.toLowerCase();
  return (
    store.iterations.find((it) => it.projectId === projectId && it.name.toLowerCase() === lower)
      ?.id ?? ''
  );
}

function resolveRequirementId(
  store: PmStore,
  projectId: string,
  args: Record<string, unknown>,
): string {
  const id = arg(args, 'requirementId');
  if (id) {
    return store.requirements.some((rq) => rq.id === id && rq.projectId === projectId) ? id : '';
  }
  const name = arg(args, 'requirement');
  if (!name) return '';
  const scoped = store.requirements.filter((rq) => rq.projectId === projectId);
  return findRequirementByTitle(scoped, name);
}

function resolveItemId<T extends { id: string }>(
  items: T[],
  args: Record<string, unknown>,
  nameKey: string,
  label: string,
  pick: (item: T) => string,
): { id: string; error?: string } {
  const id = arg(args, 'id');
  if (id) {
    return items.some((x) => x.id === id) ? { id } : { id: '', error: `${label}不存在：${id}` };
  }
  const name = arg(args, nameKey);
  if (!name) return { id: '', error: `缺少${label} id 或名称` };
  const target = name.toLowerCase();
  const match =
    items.find((x) => pick(x) === name) ?? items.find((x) => pick(x).toLowerCase() === target);
  return match ? { id: match.id } : { id: '', error: `找不到${label}：${name}` };
}

function pickNonNull(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in args)) continue;
    const v = args[key];
    if (v === undefined || v === null) continue;
    out[key] = v;
  }
  return out;
}

function resolveRequirementTarget(
  store: PmStore,
  args: Record<string, unknown>,
): RequirementItem | null {
  const id = arg(args, 'id');
  if (id) return store.requirements.find((x) => x.id === id) ?? null;
  const key = arg(args, 'requirement');
  if (!key) return null;
  const lower = key.toLowerCase();
  return (
    store.requirements.find((x) => x.autoId.toLowerCase() === lower) ??
    store.requirements.find((x) => x.title === key) ??
    store.requirements.find((x) => x.title.toLowerCase() === lower) ??
    null
  );
}

function resolveBugTarget(store: PmStore, args: Record<string, unknown>): BugItem | null {
  const id = arg(args, 'id');
  if (id) return store.bugs.find((x) => x.id === id) ?? null;
  const key = arg(args, 'bug');
  if (!key) return null;
  const lower = key.toLowerCase();
  return (
    store.bugs.find((x) => x.autoId.toLowerCase() === lower) ??
    store.bugs.find((x) => x.title === key) ??
    store.bugs.find((x) => x.title.toLowerCase() === lower) ??
    null
  );
}

function projectLine(item: ProjectItem, stats: ReturnType<typeof projectStats>): string {
  const s = stats[item.id];
  return `[${item.id}] ${item.name} | 状态=${item.status} | 迭代=${s?.iterations ?? 0} | 需求=${
    s?.requirements ?? 0
  } | 缺陷=${s?.bugs ?? 0}`;
}

function iterationLine(item: IterationItem): string {
  const progress = iterationProgressPercent(item);
  const overdue = iterationOverdueDays(item);
  return (
    `[${item.id}] ${item.name} | 项目=${item.projectId} | ${item.startDate || '—'} → ${
      item.endDate || '—'
    } | 状态=${item.status} | 进度=${progress}%` + (overdue === null ? '' : ` | 逾期${overdue}天`)
  );
}

function requirementLine(item: RequirementItem): string {
  return `[${item.id}] ${item.autoId} ${item.title} | 项目=${item.projectId} | 迭代=${
    item.iterationId || '—'
  } | 优先级=${item.priority} | 状态=${item.status}`;
}

function bugLine(item: BugItem): string {
  return `[${item.id}] ${item.autoId} ${item.title} | 项目=${item.projectId} | 迭代=${
    item.iterationId || '—'
  } | 严重程度=${item.severity} | 状态=${item.status}`;
}

function summaryOf(lines: string[], empty: string): string {
  return lines.length ? lines.map((x, i) => `${i + 1}. ${x}`).join('\n') : empty;
}

/** 集合类写入（可一次多条）：补上 projectId，并把名称形式的 iteration / requirement 换成 id */
function buildItems(
  store: PmStore,
  entity: 'iterations' | 'requirements' | 'bugs',
  projectId: string,
  rawItems: unknown[],
): Record<string, unknown>[] {
  return rawItems.map((raw) => {
    const item = (raw && typeof raw === 'object' ? { ...raw } : {}) as Record<string, unknown>;
    item.projectId = projectId;
    if (entity !== 'iterations') {
      const iterationId = resolveIterationId(store, projectId, item);
      if ('iteration' in item || 'iterationId' in item) item.iterationId = iterationId;
    }
    if (entity === 'bugs') {
      const requirementId = resolveRequirementId(store, projectId, item);
      if ('requirement' in item || 'requirementId' in item) item.requirementId = requirementId;
    }
    delete item.project;
    delete item.iteration;
    delete item.requirement;
    return item;
  });
}

export async function runPmTool(
  name: string,
  argsJson: string,
  // sessionId 交给服务端留痕（当前文件格式不落库，预留给后续审计）
  meta: { sessionId?: string } = {},
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }

  try {
    const store = await fetchPmStore();
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));

    /* ------------------------------ 项目 ------------------------------ */
    if (name === 'pm_project_list') {
      const status = arg(args, 'status');
      const matched = filterProjects(store.projects, {
        status: (status || 'all') as ProjectItem['status'] | 'all',
        keyword: arg(args, 'keyword'),
      }).slice(0, limit);
      const stats = projectStats(store);
      return JSON.stringify({
        ok: true,
        total: store.projects.length,
        count: matched.length,
        items: matched,
        summary: summaryOf(
          matched.map((x) => projectLine(x, stats)),
          '当前没有匹配的项目。',
        ),
      });
    }

    if (name === 'pm_project_add') {
      const rawItems = Array.isArray(args.items) ? args.items : [args];
      const items = rawItems
        .map((raw) => (raw && typeof raw === 'object' ? raw : {}))
        .filter((raw) => typeof (raw as Record<string, unknown>).name === 'string');
      if (!items.length) return JSON.stringify({ error: '项目名称不能为空' });
      const created = await createPmItems<ProjectItem>(
        'projects',
        items as Record<string, unknown>[],
        {
          mode: 'ai',
          sessionId: meta.sessionId,
        },
      );
      return JSON.stringify({
        ok: true,
        count: created.length,
        items: created,
        summary: `已创建 ${created.length} 个项目：\n${summaryOf(
          created.map((x) => projectLine(x, projectStats(store))),
          '',
        )}`,
      });
    }

    if (name === 'pm_project_update') {
      const target = resolveItemId(store.projects, args, 'project', '项目', (x) => x.name);
      if (target.error) return JSON.stringify({ error: target.error });
      const patch = pickNonNull(args, ['name', 'description', 'status']);
      if (!Object.keys(patch).length) return JSON.stringify({ error: '没有可更新的字段' });
      const item = await updatePmItem<ProjectItem>('projects', target.id, patch);
      return JSON.stringify({ ok: true, item, summary: `已更新项目：${item.name}` });
    }

    if (name === 'pm_project_delete') {
      const rawIds = Array.isArray(args.ids) ? args.ids : [arg(args, 'id') || arg(args, 'project')];
      const ids: string[] = [];
      for (const raw of rawIds) {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (!text) continue;
        const found =
          store.projects.find((x) => x.id === text) ?? store.projects.find((x) => x.name === text);
        if (found) ids.push(found.id);
      }
      if (!ids.length) return JSON.stringify({ error: '缺少项目 id 或名称' });
      const result = await deletePmItems('projects', ids);
      return JSON.stringify({
        ok: true,
        ...result,
        summary: `已删除 ${result.removed} 个项目，并连带删除 ${result.cascaded} 条迭代 / 需求 / 缺陷。`,
      });
    }

    /* ------------------------------ 迭代 ------------------------------ */
    if (name === 'pm_iteration_list') {
      const projectId = resolveProjectId(store, args);
      const status = arg(args, 'status');
      const matched = filterIterations(store.iterations, {
        projectId: projectId || 'all',
        status: (status || 'all') as IterationItem['status'] | 'all',
        keyword: arg(args, 'keyword'),
      }).slice(0, limit);
      return JSON.stringify({
        ok: true,
        total: store.iterations.length,
        count: matched.length,
        items: matched,
        summary: summaryOf(matched.map(iterationLine), '当前没有匹配的迭代。'),
      });
    }

    if (name === 'pm_iteration_add') {
      const projectId = resolveProjectId(store, args);
      if (!projectId) return JSON.stringify({ error: '请先指定项目（projectId 或 project 名称）' });
      const rawItems = Array.isArray(args.items) ? args.items : [args];
      const items = buildItems(store, 'iterations', projectId, rawItems);
      if (!items.length) return JSON.stringify({ error: '迭代名称不能为空' });
      const created = await createPmItems<IterationItem>('iterations', items, {
        mode: 'ai',
        sessionId: meta.sessionId,
      });
      return JSON.stringify({
        ok: true,
        count: created.length,
        items: created,
        summary: `已创建 ${created.length} 个迭代：\n${summaryOf(created.map(iterationLine), '')}`,
      });
    }

    if (name === 'pm_iteration_update') {
      const target = resolveItemId(store.iterations, args, 'iteration', '迭代', (x) => x.name);
      if (target.error) return JSON.stringify({ error: target.error });
      const patch = pickNonNull(args, ['name', 'startDate', 'endDate', 'status', 'remark']);
      if ('projectId' in args || 'project' in args) {
        const projectId = resolveProjectId(store, args);
        if (!projectId) return JSON.stringify({ error: '所属项目不存在' });
        patch.projectId = projectId;
      }
      if (!Object.keys(patch).length) return JSON.stringify({ error: '没有可更新的字段' });
      const item = await updatePmItem<IterationItem>('iterations', target.id, patch);
      return JSON.stringify({ ok: true, item, summary: `已更新迭代：${iterationLine(item)}` });
    }

    if (name === 'pm_iteration_delete') {
      const rawIds = Array.isArray(args.ids)
        ? args.ids
        : [arg(args, 'id') || arg(args, 'iteration')];
      const ids: string[] = [];
      for (const raw of rawIds) {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (!text) continue;
        const found =
          store.iterations.find((x) => x.id === text) ??
          store.iterations.find((x) => x.name === text);
        if (found) ids.push(found.id);
      }
      if (!ids.length) return JSON.stringify({ error: '缺少迭代 id 或名称' });
      const result = await deletePmItems('iterations', ids);
      return JSON.stringify({
        ok: true,
        ...result,
        summary: `已删除 ${result.removed} 个迭代；关联需求与缺陷已解除迭代关联。`,
      });
    }

    /* ------------------------------ 需求 ------------------------------ */
    if (name === 'pm_requirement_list') {
      const projectId = resolveProjectId(store, args);
      const iterationId = projectId
        ? resolveIterationId(store, projectId, args)
        : arg(args, 'iterationId') || 'all';
      const status = arg(args, 'status');
      const priority = arg(args, 'priority');
      const matched = filterRequirements(store.requirements, {
        projectId: projectId || 'all',
        iterationId: iterationId || 'all',
        status: (status || 'all') as RequirementItem['status'] | 'all',
        priority: (priority || 'all') as RequirementItem['priority'] | 'all',
        keyword: arg(args, 'keyword'),
      }).slice(0, limit);
      return JSON.stringify({
        ok: true,
        total: store.requirements.length,
        count: matched.length,
        items: matched,
        summary: summaryOf(matched.map(requirementLine), '当前没有匹配的需求。'),
      });
    }

    if (name === 'pm_requirement_add') {
      const projectId = resolveProjectId(store, args);
      if (!projectId) return JSON.stringify({ error: '请先指定项目（projectId 或 project 名称）' });
      const rawItems = Array.isArray(args.items) ? args.items : [args];
      const items = buildItems(store, 'requirements', projectId, rawItems);
      if (!items.length) return JSON.stringify({ error: '需求名称不能为空' });
      const created = await createPmItems<RequirementItem>('requirements', items, {
        mode: 'ai',
        sessionId: meta.sessionId,
      });
      return JSON.stringify({
        ok: true,
        count: created.length,
        items: created,
        summary: `已创建 ${created.length} 条需求：\n${summaryOf(
          created.map(requirementLine),
          '',
        )}`,
      });
    }

    if (name === 'pm_requirement_update') {
      const base = resolveRequirementTarget(store, args);
      if (!base) return JSON.stringify({ error: '找不到需求：请传 id、REQ-### 或标题' });
      const target = { id: base.id };
      const patch = pickNonNull(args, [
        'title',
        'priority',
        'status',
        'description',
        'acceptanceCriteria',
        'githubIssue',
      ]);
      const nextProject =
        'projectId' in args || 'project' in args ? resolveProjectId(store, args) : base.projectId;
      if (!nextProject) return JSON.stringify({ error: '所属项目不存在' });
      if (nextProject !== base.projectId) patch.projectId = nextProject;
      if ('iterationId' in args || 'iteration' in args) {
        patch.iterationId = resolveIterationId(store, nextProject, args);
      }
      if (!Object.keys(patch).length) return JSON.stringify({ error: '没有可更新的字段' });
      const item = await updatePmItem<RequirementItem>('requirements', target.id, patch);
      return JSON.stringify({ ok: true, item, summary: `已更新需求：${requirementLine(item)}` });
    }

    if (name === 'pm_requirement_delete') {
      const rawIds = Array.isArray(args.ids)
        ? args.ids
        : [arg(args, 'id') || arg(args, 'requirement')];
      const ids: string[] = [];
      for (const raw of rawIds) {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (!text) continue;
        const matchedId = findRequirementByTitle(store.requirements, text);
        const found =
          store.requirements.find((x) => x.id === text) ??
          store.requirements.find((x) => x.autoId === text) ??
          store.requirements.find((x) => x.id === matchedId);
        if (found) ids.push(found.id);
      }
      if (!ids.length) return JSON.stringify({ error: '缺少需求 id / 编号 / 名称' });
      const result = await deletePmItems('requirements', ids);
      return JSON.stringify({
        ok: true,
        ...result,
        summary: `已删除 ${result.removed} 条需求；关联缺陷已解除需求关联。`,
      });
    }

    /* ------------------------------ 缺陷 ------------------------------ */
    if (name === 'pm_bug_list') {
      const projectId = resolveProjectId(store, args);
      const iterationId = projectId
        ? resolveIterationId(store, projectId, args)
        : arg(args, 'iterationId') || 'all';
      const status = arg(args, 'status');
      const severity = arg(args, 'severity');
      const matched = filterBugs(store.bugs, {
        projectId: projectId || 'all',
        iterationId: iterationId || 'all',
        status: (status || 'all') as BugItem['status'] | 'all',
        severity: (severity || 'all') as BugItem['severity'] | 'all',
        keyword: arg(args, 'keyword'),
      }).slice(0, limit);
      return JSON.stringify({
        ok: true,
        total: store.bugs.length,
        count: matched.length,
        items: matched,
        summary: summaryOf(matched.map(bugLine), '当前没有匹配的缺陷。'),
      });
    }

    if (name === 'pm_bug_add') {
      const projectId = resolveProjectId(store, args);
      if (!projectId) return JSON.stringify({ error: '请先指定项目（projectId 或 project 名称）' });
      const rawItems = Array.isArray(args.items) ? args.items : [args];
      const items = buildItems(store, 'bugs', projectId, rawItems);
      if (!items.length) return JSON.stringify({ error: '缺陷标题不能为空' });
      const created = await createPmItems<BugItem>('bugs', items, {
        mode: 'ai',
        sessionId: meta.sessionId,
      });
      return JSON.stringify({
        ok: true,
        count: created.length,
        items: created,
        summary: `已创建 ${created.length} 条缺陷：\n${summaryOf(created.map(bugLine), '')}`,
      });
    }

    if (name === 'pm_bug_update') {
      const base = resolveBugTarget(store, args);
      if (!base) return JSON.stringify({ error: '找不到缺陷：请传 id、BUG-### 或标题' });
      const target = { id: base.id };
      const patch = pickNonNull(args, [
        'title',
        'severity',
        'status',
        'reproduceSteps',
        'expectedResult',
        'actualResult',
        'environment',
        'githubIssue',
        'attachment',
        'remark',
      ]);
      const nextProject =
        'projectId' in args || 'project' in args ? resolveProjectId(store, args) : base.projectId;
      if (!nextProject) return JSON.stringify({ error: '所属项目不存在' });
      if (nextProject !== base.projectId) patch.projectId = nextProject;
      if ('iterationId' in args || 'iteration' in args) {
        patch.iterationId = resolveIterationId(store, nextProject, args);
      }
      if ('requirementId' in args || 'requirement' in args) {
        patch.requirementId = resolveRequirementId(store, nextProject, args);
      }
      if (!Object.keys(patch).length) return JSON.stringify({ error: '没有可更新的字段' });
      const item = await updatePmItem<BugItem>('bugs', target.id, patch);
      return JSON.stringify({ ok: true, item, summary: `已更新缺陷：${bugLine(item)}` });
    }

    if (name === 'pm_bug_delete') {
      const rawIds = Array.isArray(args.ids) ? args.ids : [arg(args, 'id') || arg(args, 'bug')];
      const ids: string[] = [];
      for (const raw of rawIds) {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (!text) continue;
        const found =
          store.bugs.find((x) => x.id === text) ??
          store.bugs.find((x) => x.autoId === text) ??
          store.bugs.find((x) => x.title === text) ??
          store.bugs.find((x) => x.title.toLowerCase() === text.toLowerCase());
        if (found) ids.push(found.id);
      }
      if (!ids.length) return JSON.stringify({ error: '缺少缺陷 id / 编号 / 名称' });
      const result = await deletePmItems('bugs', ids);
      return JSON.stringify({ ok: true, ...result, summary: `已删除 ${result.removed} 条缺陷。` });
    }

    return JSON.stringify({ error: `unknown pm tool: ${name}` });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}
