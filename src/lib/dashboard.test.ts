import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildHolidayCalendar } from './cn-holidays';
import {
  DASHBOARD_COLS,
  DASHBOARD_MAX_ROWS,
  DASHBOARD_WIDGET_IDS,
  addMonthsIso,
  allDashboardWidgetsLayout,
  axisTicks,
  compactDashboardWidgets,
  dashboardCountdown,
  dashboardKpis,
  dashboardMinCols,
  dashboardMinRows,
  dashboardRect,
  dashboardRowsForHeight,
  defaultDashboardLayout,
  defaultDashboardRect,
  getDashboardWidget,
  latestStatsByDimension,
  layoutTodoMonthWeeks,
  layoutTodoSpans,
  monthRange,
  normalizeDashboardLayout,
  pageSlice,
  parseOffWorkTime,
  placeDashboardWidget,
  restCountdown,
  settleDashboardOverlaps,
  stackedDashboardWidgets,
  todayTodos,
  visibleDashboardWidgets,
  weekRange,
  type DashboardLayout,
  type DashboardRect,
} from './dashboard';
import type { TaskItem } from './tasks';
import type { TestStatsItem } from './test-stats';
import type { TodoItem } from './todos';

const holidays = buildHolidayCalendar(
  JSON.parse(readFileSync(new URL('../../public/cn-holidays.json', import.meta.url), 'utf8')),
);

function todo(over: Partial<TodoItem> = {}): TodoItem {
  return {
    id: over.id ?? 'td_1',
    title: over.title ?? '待办',
    status: over.status ?? 'pending',
    priority: over.priority ?? '',
    linkedTask: '',
    taskId: '',
    startDate: over.startDate ?? '2026-10-01',
    dueDate: over.dueDate ?? '',
    taskEndDate: '',
    note: '',
    source: 'manual',
    sessionId: '',
    createdAt: over.createdAt ?? '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    doneAt: null,
    ...over,
  };
}

function task(over: Partial<TaskItem> = {}): TaskItem {
  return {
    id: over.id ?? 'tk_1',
    title: over.title ?? '任务',
    status: over.status ?? 'pool',
    priority: over.priority ?? '',
    startDate: over.startDate ?? '2026-10-01',
    dueDate: over.dueDate ?? '',
    note: '',
    source: 'manual',
    sessionId: '',
    createdAt: over.createdAt ?? '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    doneAt: null,
    ...over,
  };
}

function stat(over: Partial<TestStatsItem> = {}): TestStatsItem {
  return {
    id: over.id ?? 'ts_1',
    date: over.date ?? '2026-10-10',
    dimensions: over.dimensions ?? ['功能测试用例'],
    count: over.count ?? 1,
    draft: over.draft ?? false,
    source: 'manual',
    sessionId: '',
    createdAt: over.createdAt ?? '2026-10-10T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-10-10T00:00:00.000Z',
    ...over,
  };
}

describe('normalizeDashboardLayout', () => {
  it('缺失 / 非法输入回退默认布局（所有卡片都不显示）', () => {
    for (const raw of [null, undefined, 'nope', 42, []]) {
      assert.deepEqual(normalizeDashboardLayout(raw), defaultDashboardLayout());
      assert.deepEqual(visibleDashboardWidgets(normalizeDashboardLayout(raw)), []);
    }
  });

  it('首次进入时组件全部关闭，等用户自己添加', () => {
    const layout = normalizeDashboardLayout(null);
    assert.equal(layout.hidden.length, DASHBOARD_WIDGET_IDS.length);
    assert.deepEqual(layout.hidden, [...DASHBOARD_WIDGET_IDS]);
    assert.deepEqual(visibleDashboardWidgets(layout), []);
  });

  it('「全部添加」把所有卡片放回画布，坐标互不重叠', () => {
    const layout = allDashboardWidgetsLayout();
    assert.deepEqual(layout.hidden, []);
    const widgets = visibleDashboardWidgets(layout);
    assert.equal(widgets.length, DASHBOARD_WIDGET_IDS.length);
    const seen: DashboardRect[] = [];
    for (const { id, rect } of widgets) {
      assert.deepEqual(rect, defaultDashboardRect(id));
      for (const other of seen) {
        assert.ok(
          rect.x >= other.x + other.w ||
            other.x >= rect.x + rect.w ||
            rect.y >= other.y + other.h ||
            other.y >= rect.y + rect.h,
          `${id} 与已有卡片重叠`,
        );
      }
      seen.push(rect);
    }
  });

  it('「全部添加」保留已经摆好的卡片，只补缺失的', () => {
    const arranged = normalizeDashboardLayout({
      hidden: ['testChart'],
      rects: {
        todoInProgress: { x: 0, y: 0, w: 6, h: 12 },
        countdown: { x: 0, y: 12, w: 6, h: 10 },
      },
    });
    const layout = allDashboardWidgetsLayout(arranged);
    assert.deepEqual(layout.hidden, []);
    assert.deepEqual(layout.rects.todoInProgress, { x: 0, y: 0, w: 6, h: 12 });
    assert.deepEqual(layout.rects.countdown, { x: 0, y: 12, w: 6, h: 10 });
    assert.equal(visibleDashboardWidgets(layout).length, DASHBOARD_WIDGET_IDS.length);
  });

  it('窄屏堆叠按阅读顺序排成一列，高度不重叠', () => {
    const layout = allDashboardWidgetsLayout();
    layout.hidden = ['testChart'];
    const stacked = stackedDashboardWidgets(layout);
    assert.deepEqual(
      stacked.map(({ id }) => id),
      [
        'todoInProgress',
        'taskInProgress',
        'overdue',
        'todoRate',
        'taskRate',
        'activeProjects',
        'spaces',
        'countdown',
        'todayTodos',
        'activeTasks',
        'todoCalendar',
      ],
    );
    let y = 0;
    for (const { id, rect } of stacked) {
      assert.equal(rect.x, 0, `${id} 应该满宽`);
      assert.equal(rect.w, DASHBOARD_COLS, `${id} 应该满宽`);
      assert.equal(rect.y, y, `${id} 应该紧接上一张卡`);
      y += rect.h;
    }
    // 堆叠只是显示用的临时坐标，原布局不能被改掉
    assert.deepEqual(layout.rects.countdown, defaultDashboardRect('countdown'));
  });

  it('坐标保留合法值，未知 id / 重复隐藏项丢弃，缺坐标的卡补到空位', () => {
    const layout = normalizeDashboardLayout({
      hidden: ['testChart', 'ghost', 'testChart'],
      rects: {
        todoInProgress: { x: 2, y: 3, w: 8, h: 10 },
        ghost: { x: 0, y: 0, w: 6, h: 6 },
      },
    });
    assert.deepEqual(layout.hidden, ['testChart']);
    assert.deepEqual(layout.rects.todoInProgress, { x: 2, y: 3, w: 8, h: 10 });
    assert.equal('ghost' in layout.rects, false);
    // 组件目录里还没存过坐标的卡补到空位（新加的卡片不会压住已有卡片）
    for (const id of DASHBOARD_WIDGET_IDS) {
      if (id === 'testChart') continue;
      assert.ok(layout.rects[id], `${id} 应该有坐标`);
    }
  });

  it('越界 / 过小 / 过大的坐标夹回允许范围', () => {
    const layout = normalizeDashboardLayout({
      rects: {
        todoInProgress: { x: 99, y: -3, w: 99, h: 1 },
        countdown: { x: 6, y: 4, w: 3, h: 99999 },
      },
    });
    // 指标卡最少 2 列、最多 12 列，x 夹回 0；高度不低于卡片最小行数
    assert.deepEqual(layout.rects.todoInProgress, {
      x: 0,
      y: 0,
      w: DASHBOARD_COLS,
      h: dashboardMinRows('todoInProgress'),
    });
    // countdown 夹到 3 列后仍与指标卡重叠，加载时自动下移到它下方
    assert.deepEqual(layout.rects.countdown, {
      x: 6,
      y: dashboardMinRows('todoInProgress'),
      w: dashboardMinCols('countdown'),
      h: DASHBOARD_MAX_ROWS,
    });
  });

  it('旧「待办概览」整卡拆成五个独立指标卡', () => {
    const layout = normalizeDashboardLayout({
      hidden: [],
      rects: { kpi: { x: 0, y: 0, w: 12, h: 12 } },
    });
    assert.deepEqual(layout.rects.todoInProgress, { x: 0, y: 0, w: 3, h: 8 });
    assert.deepEqual(layout.rects.todoRate, { x: 9, y: 0, w: 3, h: 8 });
    // 一行放四个，第五个换到下一行
    assert.deepEqual(layout.rects.taskRate, { x: 0, y: 8, w: 3, h: 8 });
    assert.equal('kpi' in layout.rects, false);
  });

  it('原来隐藏了「待办概览」，拆出的五个指标也保持隐藏', () => {
    const layout = normalizeDashboardLayout({
      hidden: ['kpi'],
      rects: { kpi: { x: 0, y: 0, w: 12, h: 12 } },
    });
    const metricIds = [
      'todoInProgress',
      'taskInProgress',
      'overdue',
      'todoRate',
      'taskRate',
    ] as const;
    for (const id of metricIds) {
      assert.ok(layout.hidden.includes(id), `${id} 应该隐藏`);
    }
  });

  it('历史布局里互相压住的卡，读取时自动往下让位', () => {
    const layout = normalizeDashboardLayout({
      rects: {
        todayTodos: { x: 0, y: 0, w: 6, h: 12 },
        testChart: { x: 0, y: 4, w: 6, h: 19 },
        todoCalendar: { x: 0, y: 8, w: 12, h: 36 },
      },
      hidden: [],
    });
    assert.equal(layout.rects.testChart!.y, 12);
    assert.equal(layout.rects.todoCalendar!.y, 31);
    // 再归一化一次不再变化（幂等）
    assert.deepEqual(normalizeDashboardLayout(layout), layout);
  });

  it('旧布局（order / spans / heights）迁移成坐标，隐藏项不占画布', () => {
    const layout = normalizeDashboardLayout({
      order: ['countdown', 'todayTodos', 'activeTasks'],
      hidden: ['todayTodos'],
      spans: { countdown: 'half' },
      heights: { countdown: 300 },
    });
    assert.deepEqual(layout.hidden, ['todayTodos']);
    assert.deepEqual(layout.rects.countdown, {
      x: 0,
      y: 0,
      w: 6,
      h: dashboardRowsForHeight(300),
    });
    assert.deepEqual(layout.rects.activeTasks, { x: 6, y: 0, w: 6, h: 19 });
    assert.equal(layout.rects.todayTodos, undefined);
  });
});

describe('dashboardRect / placeDashboardWidget', () => {
  it('没存过坐标的卡用默认位置', () => {
    const layout = allDashboardWidgetsLayout();
    const empty: DashboardLayout = { hidden: [], rects: {} };
    assert.deepEqual(
      dashboardRect(empty, 'todoInProgress'),
      defaultDashboardRect('todoInProgress'),
    );
    assert.deepEqual(
      dashboardRect(layout, 'todoInProgress'),
      defaultDashboardRect('todoInProgress'),
    );
  });

  it('重新添加时原位空着就放回原位', () => {
    const layout = allDashboardWidgetsLayout();
    const kept = { ...layout.rects.countdown! };
    const next = placeDashboardWidget({ hidden: ['countdown'], rects: layout.rects }, 'countdown');
    assert.deepEqual(next.rects.countdown, kept);
    assert.deepEqual(next.hidden, []);
  });

  it('原位被占时追加到画布最下方', () => {
    const layout = allDashboardWidgetsLayout();
    const next = placeDashboardWidget(
      {
        hidden: ['countdown'],
        // 故意把倒计时的旧位置落在指标卡上
        rects: { ...layout.rects, countdown: { ...layout.rects.todoInProgress! } },
      },
      'countdown',
    );
    const bottom = Math.max(
      ...Object.entries(layout.rects)
        .filter(([id]) => id !== 'countdown')
        .map(([, rect]) => rect!.y + rect!.h),
    );
    assert.deepEqual(next.rects.countdown, {
      x: 0,
      y: bottom,
      w: defaultDashboardRect('countdown').w,
      h: defaultDashboardRect('countdown').h,
    });
  });
});

describe('dashboardMinRows / dashboardRowsForHeight', () => {
  it('行高 20px、卡片上下各留 6px：300px 内容占 16 行', () => {
    assert.equal(dashboardRowsForHeight(300), Math.ceil((300 + 12) / 20));
  });

  it('日历的最小高度高于通用下限', () => {
    assert.ok(dashboardMinRows('todoCalendar') > dashboardMinRows('todoInProgress'));
  });

  it('倒计时最低与指标卡同高（8 行），缩到该高度时数字块自动收一档', () => {
    assert.equal(dashboardMinRows('countdown'), getDashboardWidget('todoRate').h);
    assert.equal(dashboardMinRows('countdown'), 8);
  });
});

describe('settleDashboardOverlaps', () => {
  it('拉高后压到的卡向下让位，下面的卡继续连锁让位', () => {
    const layout: DashboardLayout = {
      // 只留这三张卡，避免默认补位的其他卡片把预期位置带偏
      hidden: DASHBOARD_WIDGET_IDS.filter(
        (id) => !['todayTodos', 'testChart', 'todoCalendar'].includes(id),
      ),
      rects: {
        todayTodos: { x: 0, y: 0, w: 6, h: 20 },
        testChart: { x: 0, y: 12, w: 6, h: 19 },
        todoCalendar: { x: 0, y: 30, w: 12, h: 36 },
      },
    };
    const next = settleDashboardOverlaps(layout, 'todayTodos');
    assert.equal(next.rects.testChart!.y, 20);
    assert.equal(next.rects.todoCalendar!.y, 39);
    // 原布局对象不能被就地修改
    assert.equal(layout.rects.testChart!.y, 12);
    assert.equal(layout.rects.todoCalendar!.y, 30);
  });

  it('隐藏卡即使坐标重叠也不参与收边', () => {
    const layout: DashboardLayout = {
      hidden: ['testChart'],
      rects: {
        todayTodos: { x: 0, y: 0, w: 6, h: 20 },
        testChart: { x: 0, y: 12, w: 6, h: 19 },
      },
    };
    const next = settleDashboardOverlaps(layout, 'todayTodos');
    assert.equal(next.rects.testChart!.y, 12);
  });

  it('改的是隐藏卡时原样返回', () => {
    const layout = allDashboardWidgetsLayout();
    layout.hidden = ['todoInProgress'];
    assert.deepEqual(settleDashboardOverlaps(layout, 'todoInProgress'), layout);
  });

  it('横向压到旁边的卡时，先把它挤到同一行的空位上', () => {
    const layout: DashboardLayout = {
      hidden: DASHBOARD_WIDGET_IDS.filter((id) => !['todayTodos', 'testChart'].includes(id)),
      rects: {
        todayTodos: { x: 0, y: 0, w: 3, h: 12 },
        testChart: { x: 2, y: 0, w: 6, h: 19 },
      },
    };
    const next = settleDashboardOverlaps(layout, 'todayTodos', 'drag');
    assert.deepEqual(next.rects.testChart, { x: 3, y: 0, w: 6, h: 19 });
  });

  it('往上拖时，原本在上面的卡继续往上让，不会被顶到拖动卡下面', () => {
    const layout: DashboardLayout = {
      hidden: DASHBOARD_WIDGET_IDS.filter((id) => !['todayTodos', 'testChart'].includes(id)),
      rects: {
        todayTodos: { x: 0, y: 12, w: 12, h: 10 },
        testChart: { x: 0, y: 8, w: 12, h: 10 },
      },
    };
    const next = settleDashboardOverlaps(layout, 'todayTodos', 'drag', { direction: 'up' });
    // testChart 往上让到 12 - 10 = 2
    assert.deepEqual(next.rects.testChart, { x: 0, y: 2, w: 12, h: 10 });
  });

  it('上方没空位时，往上拖仍按老规矩往下推', () => {
    const layout: DashboardLayout = {
      hidden: DASHBOARD_WIDGET_IDS.filter((id) => !['todayTodos', 'testChart'].includes(id)),
      rects: {
        todayTodos: { x: 0, y: 2, w: 12, h: 10 },
        testChart: { x: 0, y: 0, w: 12, h: 10 },
      },
    };
    const next = settleDashboardOverlaps(layout, 'todayTodos', 'drag', { direction: 'up' });
    assert.deepEqual(next.rects.testChart, { x: 0, y: 12, w: 12, h: 10 });
  });
});

describe('compactDashboardWidgets', () => {
  it('把纵向空档收掉，横向位置与每张卡原来的宽高都不变', () => {
    const layout: DashboardLayout = {
      hidden: [],
      rects: {
        todayTodos: { x: 0, y: 0, w: 6, h: 12 },
        testChart: { x: 6, y: 0, w: 6, h: 19 },
        activeTasks: { x: 0, y: 12, w: 6, h: 19 },
        todoCalendar: { x: 0, y: 40, w: 12, h: 36 },
      },
    };
    const next = compactDashboardWidgets(layout);
    // 指标卡占着第一行，下面的卡只往上顶、不横着挪
    assert.deepEqual(next.rects.todayTodos, { x: 0, y: 8, w: 6, h: 12 });
    assert.deepEqual(next.rects.testChart, { x: 6, y: 8, w: 6, h: 19 });
    assert.deepEqual(next.rects.activeTasks, { x: 0, y: 28, w: 6, h: 19 });
    assert.equal(next.rects.todoCalendar!.y, 47);
    // 再整理一次不再变化
    assert.deepEqual(compactDashboardWidgets(next), next);
  });

  it('隐藏的卡不参与整理，坐标原样保留', () => {
    const layout = allDashboardWidgetsLayout();
    layout.hidden = ['countdown'];
    const before = { ...layout.rects.countdown! };
    const next = compactDashboardWidgets(layout);
    assert.deepEqual(next.rects.countdown, before);
    assert.ok(next.hidden.includes('countdown'));
  });
});

describe('layoutTodoSpans', () => {
  const days = weekRange('2026-10-15'); // 2026-10-12 … 2026-10-18

  it('跨天待办横跨起止日期，而不是只落在截止日', () => {
    const { spans } = layoutTodoSpans(
      [todo({ id: 'a', startDate: '2026-10-13', dueDate: '2026-10-16' })],
      days,
    );
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.start, 1);
    assert.equal(spans[0]!.end, 4);
  });

  it('超出可视范围的部分被裁到首列 / 末列', () => {
    const { spans } = layoutTodoSpans(
      [todo({ id: 'b', startDate: '2026-10-01', dueDate: '2026-10-14' })],
      days,
    );
    assert.equal(spans[0]!.start, 0);
    assert.equal(spans[0]!.end, 2);
  });

  it('完全不在范围内的待办不画', () => {
    const { spans, lanes } = layoutTodoSpans(
      [todo({ id: 'c', startDate: '2026-11-01', dueDate: '2026-11-03' })],
      days,
    );
    assert.deepEqual(spans, []);
    assert.equal(lanes, 0);
  });

  it('同一天开始的两条排到不同泳道，不互相遮住', () => {
    const { spans, lanes } = layoutTodoSpans(
      [
        todo({ id: 'd', startDate: '2026-10-12', dueDate: '2026-10-14' }),
        todo({ id: 'e', startDate: '2026-10-12', dueDate: '2026-10-13' }),
      ],
      days,
    );
    assert.equal(lanes, 2);
    assert.deepEqual(
      spans.map((s) => s.lane),
      [0, 1],
    );
  });

  it('只有开始时间 / 只有截止时间的待办各占一天', () => {
    const { spans } = layoutTodoSpans(
      [
        todo({ id: 'f', startDate: '2026-10-17', dueDate: '' }),
        todo({ id: 'g', startDate: '', dueDate: '2026-10-13' }),
      ],
      days,
    );
    assert.deepEqual(
      spans.map((s) => [s.start, s.end]),
      [
        [1, 1],
        [5, 5],
      ],
    );
  });

  it('已取消的待办不上日历', () => {
    const { spans } = layoutTodoSpans(
      [todo({ id: 'h', startDate: '2026-10-12', dueDate: '2026-10-13', status: 'cancelled' })],
      days,
    );
    assert.deepEqual(spans, []);
  });
});

describe('layoutTodoMonthWeeks', () => {
  const days = monthRange('2026-10-19'); // 2026-09-28 … 2026-11-08，共 6 周

  it('按周切成 6 段，跨天待办在覆盖到的每一周各露一段并裁到周内', () => {
    const weeks = layoutTodoMonthWeeks(
      [todo({ id: 'a', startDate: '2026-10-13', dueDate: '2026-10-20' })],
      days,
    );
    assert.equal(weeks.length, 6);
    const covered = weeks.filter((week) => week.spans.length > 0);
    // 10-13 … 10-18（第 3 周）与 10-19 … 10-20（第 4 周）
    assert.deepEqual(
      covered.map((week) => week.spans.map((s) => [s.start, s.end])),
      [[[1, 6]], [[0, 1]]],
    );
  });

  it('跨周的待办泳道固定：上下顺序不会每周翻一次', () => {
    // 逐周各排一次时，第 4 周两条都被裁成从周一开始，排序退化成「谁更长」，
    // 顺序就和第 3 周相反；整月排完再裁，b 始终在 a 上面
    const weeks = layoutTodoMonthWeeks(
      [
        todo({ id: 'a', startDate: '2026-10-13', dueDate: '2026-10-25' }),
        todo({ id: 'b', startDate: '2026-10-12', dueDate: '2026-10-30' }),
      ],
      days,
    );
    const laneOf = (weekIndex: number, id: string) =>
      weeks[weekIndex]!.spans.find((span) => span.item.id === id)?.lane;
    // 第 3 周（10-12 … 10-18）与第 4 周（10-19 … 10-25）都含这两条
    assert.deepEqual([laneOf(2, 'b'), laneOf(3, 'b')], [0, 0]);
    assert.deepEqual([laneOf(2, 'a'), laneOf(3, 'a')], [1, 1]);
  });
});

describe('dashboardKpis', () => {
  it('统计进行中 / 逾期，完成率排除已取消待办与已关闭任务', () => {
    const todos = [
      todo({ id: 'a', status: 'in_progress', dueDate: '2026-10-20' }),
      todo({ id: 'b', status: 'pending', dueDate: '2026-10-01' }),
      todo({ id: 'c', status: 'done', dueDate: '2026-10-02' }),
      todo({ id: 'd', status: 'cancelled', dueDate: '2026-10-03' }),
    ];
    const tasks = [
      task({ id: 't1', status: 'in_progress' }),
      task({ id: 't2', status: 'done' }),
      task({ id: 't3', status: 'closed' }),
      task({ id: 't4', status: 'pool' }),
    ];
    const kpis = dashboardKpis(todos, tasks, '2026-10-18');
    assert.equal(kpis.todoInProgress, 1);
    assert.equal(kpis.taskInProgress, 1);
    assert.equal(kpis.overdue, 1);
    assert.equal(kpis.todoDone, 1);
    assert.equal(kpis.todoTotal, 3);
    assert.equal(kpis.todoRate, 33);
    assert.equal(kpis.taskDone, 1);
    assert.equal(kpis.taskTotal, 3);
    assert.equal(kpis.taskRate, 33);
  });

  it('分母为 0 时完成率为 0', () => {
    const kpis = dashboardKpis([], [], '2026-10-18');
    assert.equal(kpis.todoRate, 0);
    assert.equal(kpis.taskRate, 0);
    assert.equal(kpis.todoTotal, 0);
    assert.equal(kpis.taskTotal, 0);
  });
});

describe('todayTodos', () => {
  it('开始 ~ 截止区间包含今天，且排除已完成 / 已取消', () => {
    const items = [
      todo({ id: 'today', startDate: '2026-10-18', dueDate: '2026-10-18' }),
      todo({ id: 'spanning', startDate: '2026-10-15', dueDate: '2026-10-21' }),
      todo({ id: 'start-only', startDate: '2026-10-18', dueDate: '' }),
      todo({ id: 'due-only', startDate: '', dueDate: '2026-10-18' }),
      todo({ id: 'done', startDate: '2026-10-15', dueDate: '2026-10-21', status: 'done' }),
      todo({
        id: 'cancelled',
        startDate: '2026-10-15',
        dueDate: '2026-10-21',
        status: 'cancelled',
      }),
      todo({ id: 'future', startDate: '2026-10-19', dueDate: '2026-10-19' }),
      todo({ id: 'past', startDate: '2026-10-10', dueDate: '2026-10-10' }),
    ];
    // past 已过截止日期（已延期），按新规则也要留在今日待办里继续跟进
    assert.deepEqual(
      todayTodos(items, '2026-10-18')
        .map((x) => x.id)
        .sort(),
      ['due-only', 'past', 'spanning', 'start-only', 'today'],
    );
  });

  it('已延期的待办即使区间早已结束也留在今日待办', () => {
    const items = [
      todo({ id: 'overdue', status: 'overdue', startDate: '2026-09-01', dueDate: '2026-09-05' }),
      todo({ id: 'done', status: 'done', startDate: '2026-09-01', dueDate: '2026-09-05' }),
    ];
    assert.deepEqual(
      todayTodos(items, '2026-10-18').map((x) => x.id),
      ['overdue'],
    );
  });

  it('起止填反时按较小值当开始', () => {
    const items = [todo({ startDate: '2026-10-25', dueDate: '2026-10-15' })];
    assert.equal(todayTodos(items, '2026-10-18').length, 1);
  });

  it('起止都为空时不进入今日待办', () => {
    const items = [todo({ startDate: '', dueDate: '' })];
    assert.deepEqual(todayTodos(items, '2026-10-18'), []);
  });
});

describe('weekRange', () => {
  it('始终周一开头，含周日', () => {
    assert.deepEqual(weekRange('2026-10-18'), [
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
  });

  it('跨月边界', () => {
    const days = weekRange('2026-11-01');
    assert.equal(days[0], '2026-10-26');
    assert.equal(days[6], '2026-11-01');
  });

  it('跨年边界', () => {
    const days = weekRange('2027-01-01');
    assert.equal(days[0], '2026-12-28');
    assert.equal(days[6], '2027-01-03');
  });
});

describe('monthRange', () => {
  it('固定 6 行 × 7 列，从周一算起并覆盖整月', () => {
    const days = monthRange('2026-10-18');
    assert.equal(days.length, 42);
    assert.equal(days[0], '2026-09-28');
    assert.equal(days[41], '2026-11-08');
    assert.ok(days.includes('2026-10-01'));
    assert.ok(days.includes('2026-10-31'));
  });

  it('跨年月份', () => {
    const days = monthRange('2027-01-15');
    assert.equal(days[0], '2026-12-28');
    assert.equal(days[6], '2027-01-03');
  });
});

describe('addMonthsIso', () => {
  it('归到目标月 1 号，31 号不会溢出到下下月', () => {
    assert.equal(addMonthsIso('2026-01-31', 1), '2026-02-01');
    assert.equal(addMonthsIso('2026-03-31', -1), '2026-02-01');
    assert.equal(addMonthsIso('2026-12-15', 1), '2027-01-01');
  });
});

describe('restCountdown', () => {
  it('周五 23:59:59 只差 1 秒到周末', () => {
    const cd = restCountdown(new Date(2026, 9, 16, 23, 59, 59), holidays);
    assert.deepEqual(cd, {
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 1,
      resting: false,
      target: '周末',
      targetDate: '2026-10-17',
    });
  });

  it('周六 / 周日当天显示全 0', () => {
    const sat = restCountdown(new Date(2026, 9, 17, 0, 0, 0), holidays);
    const sun = restCountdown(new Date(2026, 9, 18, 15, 30, 0), holidays);
    assert.deepEqual(sat, {
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      resting: true,
      target: '周末',
      targetDate: '2026-10-17',
    });
    assert.deepEqual(sun, { ...sat, targetDate: '2026-10-18' });
  });

  it('调休补班的周六不算休息日，顺延到周日', () => {
    // 2026-10-10（周六）国庆调休上班
    const cd = restCountdown(new Date(2026, 9, 9, 12, 0, 0), holidays);
    assert.equal(cd.resting, false);
    assert.equal(cd.target, '周末');
    assert.equal(cd.targetDate, '2026-10-11');
    assert.deepEqual([cd.days, cd.hours], [1, 12]);
  });

  it('法定假期提前进入倒计时，终点显示节日名', () => {
    // 2026-09-23（周三）距中秋 9-25 还有 2 天
    const cd = restCountdown(new Date(2026, 8, 23, 9, 0, 0), holidays);
    assert.equal(cd.target, '中秋节');
    assert.equal(cd.targetDate, '2026-09-25');
    assert.equal(cd.days, 1);
  });

  it('假期当天显示休息与节日名', () => {
    const cd = restCountdown(new Date(2026, 9, 3, 10, 0, 0), holidays);
    assert.equal(cd.resting, true);
    assert.equal(cd.target, '国庆节');
    assert.equal(cd.targetDate, '2026-10-03');
  });

  it('没给日历时退回只看周末', () => {
    // 2026-10-05 是国庆，但没有日历数据就算工作日
    const cd = restCountdown(new Date(2026, 9, 5, 9, 0, 0));
    assert.equal(cd.target, '周末');
    assert.equal(cd.targetDate, '2026-10-10');
  });
});

describe('dashboardCountdown', () => {
  it('今天结束 = 明天 00:00，倒到当天 24 点', () => {
    const cd = dashboardCountdown(new Date(2026, 9, 19, 22, 0, 0), holidays, 'today');
    assert.equal(cd.title, '距离今天结束');
    assert.equal(cd.targetDate, '2026-10-20');
    assert.deepEqual([cd.days, cd.hours, cd.minutes, cd.seconds], [0, 2, 0, 0]);
    assert.equal(cd.note, '到 2026-10-20 00:00 结束今天');
  });

  it('今年结束 = 次年 1 月 1 日，跨年的天数按自然日算', () => {
    // 2026-12-31 12:00 → 2027-01-01 00:00
    const cd = dashboardCountdown(new Date(2026, 11, 31, 12, 0, 0), holidays, 'year');
    assert.equal(cd.title, '距离今年结束');
    assert.equal(cd.targetDate, '2027-01-01');
    assert.deepEqual([cd.days, cd.hours, cd.minutes], [0, 12, 0]);
    assert.equal(cd.note, '到 2027-01-01 00:00 跨年');
  });

  it('周末沿用休息日规则，标题是「距离周末」；当天休息则显示愉快', () => {
    const friday = dashboardCountdown(new Date(2026, 9, 16, 23, 59, 59), holidays, 'weekend');
    assert.equal(friday.title, '距离周末');
    assert.equal(friday.targetDate, '2026-10-17');
    assert.equal(friday.note, '到 2026-10-17 00:00 开始休息');
    const sat = dashboardCountdown(new Date(2026, 9, 17, 9, 0, 0), holidays, 'weekend');
    assert.equal(sat.title, '周末愉快');
    assert.equal(sat.reached, true);
  });

  it('下班：按设置的时间倒计时，说明里带这个点', () => {
    const cd = dashboardCountdown(new Date(2026, 9, 19, 17, 30, 0), holidays, 'offWork', '18:00');
    assert.equal(cd.title, '距离下班');
    assert.equal(cd.targetDate, '2026-10-19');
    assert.deepEqual([cd.days, cd.hours, cd.minutes, cd.seconds], [0, 0, 30, 0]);
    assert.equal(cd.note, '今天 18:00 下班');
    assert.equal(cd.reached, false);
  });

  it('下班：过了点停在 0，不再跳到明天', () => {
    const cd = dashboardCountdown(new Date(2026, 9, 19, 18, 0, 1), holidays, 'offWork', '18:00');
    assert.equal(cd.title, '已经下班啦');
    assert.deepEqual([cd.days, cd.hours, cd.minutes, cd.seconds], [0, 0, 0, 0]);
    assert.equal(cd.reached, true);
  });

  it('下班时间非法 / 未设置时按默认 18:00 算', () => {
    const now = new Date(2026, 9, 19, 17, 0, 0);
    assert.equal(dashboardCountdown(now, holidays, 'offWork', '').note, '今天 18:00 下班');
    assert.equal(dashboardCountdown(now, holidays, 'offWork', 'oops').note, '今天 18:00 下班');
    const morning = new Date(2026, 9, 19, 8, 0, 0);
    assert.equal(dashboardCountdown(morning, holidays, 'offWork', '9:5').note, '今天 09:05 下班');
  });

  it('周末也能改终点时分：设成 18:00 就是休息日前一天的 18:00（周五下班即周末）', () => {
    // 2026-10-19（周一）18:00 → 下一个休息日是 10-24（周六），终点落在 10-23（周五）18:00
    const monday = dashboardCountdown(
      new Date(2026, 9, 19, 9, 0, 0),
      holidays,
      'weekend',
      '',
      '18:00',
    );
    assert.equal(monday.title, '距离周末');
    assert.equal(monday.targetDate, '2026-10-23');
    assert.equal(monday.note, '到 2026-10-23 18:00 开始休息');
    assert.equal(monday.reached, false);

    // 周五 17:00 → 当天 18:00 只剩 1 小时
    const beforeRest = dashboardCountdown(
      new Date(2026, 9, 16, 17, 0, 0),
      holidays,
      'weekend',
      '18:00',
      '18:00',
    );
    assert.equal(beforeRest.title, '距离周末');
    assert.equal(beforeRest.targetDate, '2026-10-16');
    assert.deepEqual([beforeRest.days, beforeRest.hours], [0, 1]);
    assert.equal(beforeRest.note, '到 2026-10-16 18:00 开始休息');
    assert.equal(beforeRest.reached, false);

    // 周五 18:00 一过就算进入周末，不用等到周六
    const fridayEvening = dashboardCountdown(
      new Date(2026, 9, 16, 18, 0, 1),
      holidays,
      'weekend',
      '18:00',
      '18:00',
    );
    assert.equal(fridayEvening.title, '周末愉快');
    assert.equal(fridayEvening.reached, true);
    assert.deepEqual([fridayEvening.days, fridayEvening.hours], [0, 0]);

    // 休息日当天也是「愉快」，不再等当天 18:00
    const satMorning = dashboardCountdown(
      new Date(2026, 9, 17, 9, 0, 0),
      holidays,
      'weekend',
      '',
      '18:00',
    );
    assert.equal(satMorning.title, '周末愉快');
    assert.equal(satMorning.reached, true);
  });

  it('周末改回 00:00 时终点仍是休息日当天 0 点（周六 0 点 = 周五 24 点）', () => {
    const monday = dashboardCountdown(
      new Date(2026, 9, 19, 9, 0, 0),
      holidays,
      'weekend',
      '',
      '00:00',
    );
    assert.equal(monday.targetDate, '2026-10-24');
    assert.equal(monday.note, '到 2026-10-24 00:00 开始休息');
    const fridayNight = dashboardCountdown(
      new Date(2026, 9, 23, 23, 30, 0),
      holidays,
      'weekend',
      '',
      '00:00',
    );
    assert.equal(fridayNight.title, '距离周末');
    assert.deepEqual([fridayNight.days, fridayNight.hours, fridayNight.minutes], [0, 0, 30]);
  });
});

describe('parseOffWorkTime', () => {
  it('补零并接受宽松写法', () => {
    assert.equal(parseOffWorkTime('9:5'), '09:05');
    assert.equal(parseOffWorkTime('18:00'), '18:00');
    assert.equal(parseOffWorkTime(' 8:30 '), '08:30');
  });

  it('非法输入返回 null', () => {
    for (const raw of ['', '24:00', '12:60', 'abc', '12', null, undefined, 18]) {
      assert.equal(parseOffWorkTime(raw), null);
    }
  });
});

describe('latestStatsByDimension', () => {
  it('同维度取最新日期，同日取最新创建；跳过占位行', () => {
    const bars = latestStatsByDimension([
      stat({ id: 'old', dimensions: ['接口测试用例'], date: '2026-10-01', count: 3 }),
      stat({ id: 'new', dimensions: ['接口测试用例'], date: '2026-10-12', count: 8 }),
      stat({ id: 'same-old', dimensions: ['测试报告'], date: '2026-10-12', count: 1 }),
      stat({
        id: 'same-new',
        dimensions: ['测试报告'],
        date: '2026-10-12',
        count: 5,
        createdAt: '2026-10-12T08:00:00.000Z',
      }),
      stat({ id: 'draft', dimensions: [], draft: true, count: 99 }),
    ]);
    assert.deepEqual(bars, [
      { dimension: '接口测试用例', count: 8, date: '2026-10-12' },
      { dimension: '测试报告', count: 5, date: '2026-10-12' },
    ]);
  });
});

describe('axisTicks', () => {
  it('1060 取 0 / 500 / 1000 / 1500', () => {
    assert.deepEqual(axisTicks(1060, 3), [0, 500, 1000, 1500]);
  });

  it('空数据回退 0 / 1，避免除零', () => {
    assert.deepEqual(axisTicks(0), [0, 1]);
    assert.deepEqual(axisTicks(Number.NaN), [0, 1]);
  });

  it('小数量用整数步长，不出小数刻度', () => {
    assert.deepEqual(axisTicks(4, 3), [0, 2, 4]);
    assert.deepEqual(axisTicks(1, 3), [0, 1]);
  });
});

describe('pageSlice', () => {
  const items = Array.from({ length: 12 }, (_, i) => i + 1);

  it('按页切片并给出总页数', () => {
    const first = pageSlice(items, 1, 5);
    assert.deepEqual(first.items, [1, 2, 3, 4, 5]);
    assert.equal(first.pages, 3);
    assert.equal(first.total, 12);
    assert.deepEqual(pageSlice(items, 3, 5).items, [11, 12]);
  });

  it('页码越界时夹到合法范围', () => {
    assert.equal(pageSlice(items, 99, 5).page, 3);
    assert.equal(pageSlice(items, 0, 5).page, 1);
    assert.equal(pageSlice(items, Number.NaN, 5).page, 1);
  });

  it('空列表仍有一页', () => {
    const empty = pageSlice([], 1, 5);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.pages, 1);
    assert.equal(empty.total, 0);
  });
});
