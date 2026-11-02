/**
 * 工作汇报「本期工作数据」：按日报 / 周报 / 月报区间，从各插件拉记录拼成 markdown，
 * 随「生成X报」那条用户消息带给模型（气泡仍只显示短指令）。
 */
import {
  caseExecBaselines,
  caseExecCumulativeExecuted,
  caseExecPercent,
  caseExecRemaining,
  caseExecResolveExecuted,
  listCaseExec,
  sortCaseExec,
  type CaseExecItem,
} from './case-exec';
import { listTasks, TASK_STATUS_LABEL, type TaskItem } from './tasks';
import { listTestStats, type TestStatsItem } from './test-stats';
import { listTodos, TODO_STATUS_LABEL, type TodoItem } from './todos';
import type { ReportKind } from './report-prompt';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportPeriod {
  from: string;
  to: string;
  /** 与落盘文件名口径一致，如 周报（2026.10.20-2026.10.26） */
  label: string;
}

export interface ReportContextSources {
  todos?: boolean;
  tasks?: boolean;
  testStats?: boolean;
  caseExec?: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(y: number, monthIndex: number, day: number): string {
  return `${y}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

function dotDate(iso: string): string {
  return iso.replace(/-/g, '.');
}

/**
 * 日报 = 当天；周报 = 本周一～周日；月报 = 本自然月（本地时区）。
 * `weekOffset`：周报专用，0 = 本周，-1 = 上一周（用户写明「上一周 / 上周」时传入）。
 */
export function reportPeriod(
  kind: ReportKind,
  now: Date = new Date(),
  opts?: { weekOffset?: number },
): ReportPeriod {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  if (kind === 'day') {
    const s = ymd(y, m, d);
    return { from: s, to: s, label: `日报（${dotDate(s)}）` };
  }
  if (kind === 'month') {
    const last = new Date(y, m + 1, 0).getDate();
    const from = ymd(y, m, 1);
    const to = ymd(y, m, last);
    return { from, to, label: `月报（${y}.${pad2(m + 1)}）` };
  }
  const dow = now.getDay(); // 0=日
  const offsetMon = dow === 0 ? -6 : 1 - dow;
  const weekOffset = opts?.weekOffset ?? 0;
  const mon = new Date(y, m, d + offsetMon + weekOffset * 7);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  const from = ymd(mon.getFullYear(), mon.getMonth(), mon.getDate());
  const to = ymd(sun.getFullYear(), sun.getMonth(), sun.getDate());
  return { from, to, label: `周报（${dotDate(from)}-${dotDate(to)}）` };
}

/** 用户是否点名要「上一周 / 上周」的周报（不影响本周默认） */
export function wantsPreviousWeek(text: string): boolean {
  const t = text.trim();
  return /上一周|上周/.test(t);
}

export function dateInRange(date: string, from: string, to: string): boolean {
  if (!DATE_RE.test(date)) return false;
  return date >= from && date <= to;
}

/** 区间 [start, end]（缺一端时用另一端）与 [from, to] 是否相交 */
export function rangesOverlap(start: string, end: string, from: string, to: string): boolean {
  const a = DATE_RE.test(start) ? start : DATE_RE.test(end) ? end : '';
  const b = DATE_RE.test(end) ? end : DATE_RE.test(start) ? start : '';
  if (!a || !b) return false;
  const lo = a <= b ? a : b;
  const hi = a <= b ? b : a;
  return lo <= to && hi >= from;
}

/**
 * 日报 / 周报 / 月报区间口径（不用修改时间）：
 * - 待办 / 任务：计划起止（开始～截止）与汇报区间相交；无计划日则看创建日
 * - 测试统计：统计日期落入区间
 * - 用例执行：统计日期落入区间，或执行周期（开始～结束）与区间相交
 */
function filterTodos(items: TodoItem[], from: string, to: string): TodoItem[] {
  return items.filter((t) => {
    if (t.startDate || t.dueDate) return rangesOverlap(t.startDate, t.dueDate, from, to);
    return dateInRange((t.createdAt || '').slice(0, 10), from, to);
  });
}

function filterTasks(items: TaskItem[], from: string, to: string): TaskItem[] {
  return items.filter((t) => {
    if (t.startDate || t.dueDate) return rangesOverlap(t.startDate, t.dueDate, from, to);
    return dateInRange((t.createdAt || '').slice(0, 10), from, to);
  });
}

function filterTestStats(items: TestStatsItem[], from: string, to: string): TestStatsItem[] {
  return items.filter((t) => !t.draft && dateInRange(t.date, from, to));
}

export function filterCaseExec(items: CaseExecItem[], from: string, to: string): CaseExecItem[] {
  return items.filter((t) => {
    if (t.draft) return false;
    if (dateInRange(t.date, from, to)) return true;
    const start = t.startDate || t.date;
    const end = t.endDate || t.date;
    return rangesOverlap(start, end, from, to);
  });
}

function sectionTodos(items: TodoItem[]): string[] {
  if (!items.length) return ['### 待办事项', '', '本期无相关记录。', ''];
  const lines = ['### 待办事项', ''];
  for (const t of items) {
    const bits = [
      TODO_STATUS_LABEL[t.status] || t.status,
      t.linkedTask ? `任务：${t.linkedTask}` : '',
      t.startDate || t.dueDate ? `${t.startDate || '—'} ~ ${t.dueDate || '—'}` : '',
    ].filter(Boolean);
    lines.push(`- ${t.title || '（无标题）'}（${bits.join(' · ')}）`);
    if (t.note.trim()) lines.push(`  备注：${t.note.trim()}`);
  }
  lines.push('');
  return lines;
}

function sectionTasks(items: TaskItem[]): string[] {
  if (!items.length) return ['### 任务管理', '', '本期无相关记录。', ''];
  const lines = ['### 任务管理', ''];
  for (const t of items) {
    const bits = [
      TASK_STATUS_LABEL[t.status] || t.status,
      t.startDate || t.dueDate ? `${t.startDate || '—'} ~ ${t.dueDate || '—'}` : '',
    ].filter(Boolean);
    lines.push(`- ${t.title || '（无标题）'}（${bits.join(' · ')}）`);
    if (t.note.trim()) lines.push(`  备注：${t.note.trim()}`);
  }
  lines.push('');
  return lines;
}

function sectionTestStats(items: TestStatsItem[]): string[] {
  if (!items.length) return ['### 测试统计', '', '本期无相关记录。', ''];
  const lines = ['### 测试统计', ''];
  // 同日同维度可能多条：按日期新→旧列出
  const sorted = [...items].sort(
    (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
  );
  for (const t of sorted) {
    const dim = t.dimensions[0] || '（未选维度）';
    lines.push(`- ${t.date} · ${dim}：${t.count}`);
  }
  lines.push('');
  return lines;
}

/**
 * 用例执行：与页面卡头同一口径——分母是项目基线（全量最早一条的用例总数），
 * 分子是累计已执行（基线 − 该行剩余）；按项目汇总后再列本期各统计日。
 * `allForBaseline` 应用未按区间裁过的全量，避免基线行落在区间外时分母被改小。
 */
function sectionCaseExec(items: CaseExecItem[], allForBaseline?: CaseExecItem[]): string[] {
  if (!items.length) return ['### 用例执行统计', '', '本期无相关记录。', ''];
  const lines = ['### 用例执行统计', ''];
  const baselines = caseExecBaselines(allForBaseline?.length ? allForBaseline : items);
  const buckets = new Map<string, CaseExecItem[]>();
  for (const t of items) {
    const key = t.project.trim() || `（无项目:${t.id}）`;
    const list = buckets.get(key);
    if (list) list.push(t);
    else buckets.set(key, [t]);
  }
  const groups = [...buckets.entries()].sort((a, b) => {
    const aDate = sortCaseExec(a[1])[0]?.date ?? '';
    const bDate = sortCaseExec(b[1])[0]?.date ?? '';
    return bDate.localeCompare(aDate);
  });
  for (const [projectKey, bucket] of groups) {
    const sorted = sortCaseExec(bucket);
    const named = sorted[0]?.project.trim() ?? '';
    const label = named || '（无项目）';
    const base = named ? (baselines.get(named) ?? 0) : 0;
    const progressItem = sorted.find((x) => x.total > 0) ?? sorted[0];
    const cumExecuted = progressItem
      ? caseExecCumulativeExecuted(progressItem, base || undefined)
      : 0;
    const pct = progressItem ? caseExecPercent(progressItem, base || undefined).toFixed(2) : '0.00';
    const cycle = sorted.find((x) => x.startDate || x.endDate) ?? sorted[0];
    const span =
      cycle?.startDate || cycle?.endDate
        ? `（周期 ${cycle?.startDate || '—'} ~ ${cycle?.endDate || '—'}）`
        : '';
    const baseLabel = base > 0 ? String(base) : '—';
    lines.push(
      `- **${label}**${span}：基线 ${baseLabel} · 已执行 ${cumExecuted} / ${baseLabel}（${pct}%）`,
    );
    for (const t of sorted) {
      const remain = caseExecRemaining(t);
      const roundExecuted = caseExecResolveExecuted(t);
      const rowCum = caseExecCumulativeExecuted(t, base || undefined);
      const rowPct = caseExecPercent(t, base || undefined).toFixed(2);
      const denom = base > 0 ? base : t.total || '—';
      lines.push(
        `  - ${t.date}：本轮总数 ${t.total} · 待执行 ${t.pending} · 本轮已执行 ${roundExecuted} · 剩余 ${remain} · 累计已执行 ${rowCum} / ${denom}（${rowPct}%）`,
      );
    }
  }
  lines.push('');
  return lines;
}

/** 纯拼装（便于单测）；sections 开关为 false 时整节省略 */
export function formatReportContext(input: {
  period: ReportPeriod;
  todos?: TodoItem[];
  tasks?: TaskItem[];
  testStats?: TestStatsItem[];
  caseExec?: CaseExecItem[];
  /** 用例执行全量（未按区间裁），用于算项目基线；缺省则用 caseExec */
  caseExecAll?: CaseExecItem[];
  include: ReportContextSources;
}): string {
  const { period, include } = input;
  const lines: string[] = [
    '## 本期工作数据',
    '',
    `区间：${period.from} ~ ${period.to}（${period.label}）`,
    '',
    '以下由插件按区间带入，请据此整理汇报；不要编造未出现的数字或事项。',
    '',
  ];
  if (include.todos) lines.push(...sectionTodos(input.todos ?? []));
  if (include.tasks) lines.push(...sectionTasks(input.tasks ?? []));
  if (include.testStats) lines.push(...sectionTestStats(input.testStats ?? []));
  if (include.caseExec) {
    lines.push(...sectionCaseExec(input.caseExec ?? [], input.caseExecAll));
  }
  // 四个来源全关：不注入空壳
  if (!include.todos && !include.tasks && !include.testStats && !include.caseExec) return '';
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * 拉取开启中的插件数据并按区间过滤后拼成 markdown。
 * 任一接口失败静默跳过该源，不阻断发汇报。
 */
export async function buildReportContextBlock(
  kind: ReportKind,
  sources: ReportContextSources,
  now: Date = new Date(),
  opts?: { weekOffset?: number },
): Promise<string> {
  const period = reportPeriod(kind, now, { weekOffset: opts?.weekOffset });
  const include: ReportContextSources = {
    todos: Boolean(sources.todos),
    tasks: Boolean(sources.tasks),
    testStats: Boolean(sources.testStats),
    caseExec: Boolean(sources.caseExec),
  };
  if (!include.todos && !include.tasks && !include.testStats && !include.caseExec) return '';

  const [todos, tasks, testStats, caseExec] = await Promise.all([
    include.todos
      ? listTodos()
          .then((all) => filterTodos(all, period.from, period.to))
          .catch(() => [] as TodoItem[])
      : Promise.resolve(undefined),
    include.tasks
      ? listTasks()
          .then((all) => filterTasks(all, period.from, period.to))
          .catch(() => [] as TaskItem[])
      : Promise.resolve(undefined),
    include.testStats
      ? listTestStats()
          .then((data) => filterTestStats(data.items, period.from, period.to))
          .catch(() => [] as TestStatsItem[])
      : Promise.resolve(undefined),
    include.caseExec
      ? listCaseExec()
          .then((data) => ({
            periodItems: filterCaseExec(data.items, period.from, period.to),
            all: data.items.filter((x) => !x.draft),
          }))
          .catch(() => ({ periodItems: [] as CaseExecItem[], all: [] as CaseExecItem[] }))
      : Promise.resolve(undefined),
  ]);

  return formatReportContext({
    period,
    todos,
    tasks,
    testStats,
    caseExec: caseExec?.periodItems,
    caseExecAll: caseExec?.all,
    include,
  });
}

/** 从用户短指令识别汇报类型（生成日报 / 周报 / 月报） */
export function detectReportKindFromText(text: string): ReportKind | null {
  const t = text.trim();
  // 中文后不能靠 \b：JS 里汉字不算 word char，\b 会匹配失败
  if (t.startsWith('生成日报') || /^生成.*日报/.test(t)) return 'day';
  if (t.startsWith('生成周报') || /^生成.*(上周|上一周)?周报/.test(t)) return 'week';
  if (t.startsWith('生成月报') || /^生成.*月报/.test(t)) return 'month';
  return null;
}
