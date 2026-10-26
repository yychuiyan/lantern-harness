import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  daysBetween,
  effectiveTodoStatus,
  filterTodos,
  inferTodoStatusFromDates,
  normalizeTodoInput,
  normalizeTodoItem,
  sortTodos,
  todoCounts,
  todoCycleDays,
  todoEndDate,
  todoRemainingDays,
  type TodoItem,
} from './todos';
import { TODO_SYSTEM_HINT } from './todo-tools';

function item(patch: Partial<TodoItem> = {}): TodoItem {
  return {
    id: patch.id ?? 'td_1',
    title: patch.title ?? '测试待办',
    status: patch.status ?? 'pending',
    statusManual: patch.statusManual ?? false,
    priority: patch.priority ?? '',
    linkedTask: patch.linkedTask ?? '',
    taskId: patch.taskId ?? '',
    startDate: patch.startDate ?? '',
    dueDate: patch.dueDate ?? '',
    taskEndDate: patch.taskEndDate ?? '',
    note: patch.note ?? '',
    source: patch.source ?? 'manual',
    sessionId: patch.sessionId ?? '',
    createdAt: patch.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: patch.updatedAt ?? '2026-01-01T00:00:00.000Z',
    doneAt: patch.doneAt ?? null,
  };
}

describe('待办的派生字段', () => {
  it('待办周期含首尾', () => {
    assert.equal(todoCycleDays({ startDate: '2026-07-07', dueDate: '2026-07-22' }), 16);
    assert.equal(todoCycleDays({ startDate: '2026-07-07', dueDate: '2026-07-07' }), 1);
  });

  it('缺日期或日期非法时返回 null', () => {
    assert.equal(todoCycleDays({ startDate: '', dueDate: '2026-07-22' }), null);
    assert.equal(todoCycleDays({ startDate: '2026-07-07', dueDate: '7/22' }), null);
  });

  it('剩余天数按本地日期算，负数表示逾期', () => {
    assert.equal(todoRemainingDays({ dueDate: '2026-07-23' }, '2026-07-20'), 3);
    assert.equal(todoRemainingDays({ dueDate: '2026-07-18' }, '2026-07-20'), -2);
    assert.equal(daysBetween('2026-07-20', '2026-07-20'), 0);
  });

  it('按起止日期推断状态：未来待开始、今天进行中、过期已延期', () => {
    assert.equal(inferTodoStatusFromDates('2026-07-25', '2026-07-30', '2026-07-20'), 'pending');
    assert.equal(inferTodoStatusFromDates('2026-07-20', '2026-07-30', '2026-07-20'), 'in_progress');
    assert.equal(inferTodoStatusFromDates('2026-07-01', '2026-07-10', '2026-07-20'), 'overdue');
  });

  it('未完成且过期显示为已延期，已完成 / 手锁不受影响', () => {
    assert.equal(
      effectiveTodoStatus(
        { status: 'pending', dueDate: '2026-07-01', startDate: '', statusManual: false },
        '2026-07-20',
      ),
      'overdue',
    );
    assert.equal(
      effectiveTodoStatus(
        { status: 'in_progress', dueDate: '2026-07-01', startDate: '', statusManual: false },
        '2026-07-20',
      ),
      'overdue',
    );
    assert.equal(
      effectiveTodoStatus(
        { status: 'pending', dueDate: '2026-07-01', startDate: '', statusManual: true },
        '2026-07-20',
      ),
      'pending',
    );
    assert.equal(
      effectiveTodoStatus(
        { status: 'done', dueDate: '2026-07-01', startDate: '', statusManual: false },
        '2026-07-20',
      ),
      'done',
    );
    assert.equal(
      effectiveTodoStatus(
        { status: 'cancelled', dueDate: '2026-07-01', startDate: '', statusManual: false },
        '2026-07-20',
      ),
      'cancelled',
    );
  });

  it('结束日期由状态派生：只有已完成 / 已取消有值', () => {
    assert.equal(todoEndDate({ status: 'done', taskEndDate: '2026-07-20' }), '2026-07-20');
    assert.equal(todoEndDate({ status: 'cancelled', taskEndDate: '2026-07-21' }), '2026-07-21');
    assert.equal(todoEndDate({ status: 'pending', taskEndDate: '2026-07-20' }), '');
    assert.equal(todoEndDate({ status: 'in_progress', taskEndDate: '' }), '');
  });

  it('读回来的旧数据会把未结束态残留的结束日期清掉', () => {
    assert.equal(
      normalizeTodoItem({ title: '进行中的待办', status: 'in_progress', taskEndDate: '2026-07-01' })
        ?.taskEndDate,
      '',
    );
    assert.equal(
      normalizeTodoItem({ title: '已完成的待办', status: 'done', taskEndDate: '2026-07-02' })
        ?.taskEndDate,
      '2026-07-02',
    );
  });

  it('过了截止日期仍未结束的旧数据读出来就是「已延期」', () => {
    assert.equal(
      normalizeTodoItem({ title: '逾期', status: 'in_progress', dueDate: '2020-01-01' })?.status,
      'overdue',
    );
    // 已完成的不受截止日期影响
    assert.equal(
      normalizeTodoItem({ title: '已完成', status: 'done', dueDate: '2020-01-01' })?.status,
      'done',
    );
  });
});

describe('待办筛选与排序', () => {
  const list = [
    item({
      id: 'a',
      status: 'done',
      dueDate: '2026-07-10',
      priority: 'normal',
      updatedAt: '2026-07-10T00:00:00.000Z',
    }),
    item({
      id: 'b',
      status: 'pending',
      dueDate: '2026-07-25',
      priority: 'urgent',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }),
    item({
      id: 'c',
      status: 'in_progress',
      dueDate: '2026-07-01',
      priority: 'urgent_important',
      updatedAt: '2026-07-19T00:00:00.000Z',
    }),
    item({
      id: 'd',
      status: 'pending',
      dueDate: '',
      priority: '',
      title: '写周报',
      updatedAt: '2026-07-11T00:00:00.000Z',
    }),
  ];

  it('按状态筛选（含已延期）', () => {
    const overdue = filterTodos(list, { status: 'overdue', today: '2026-07-20' });
    assert.deepEqual(
      overdue.map((x) => x.id),
      ['c'],
    );
    const pending = filterTodos(list, { status: 'pending', today: '2026-07-20' });
    assert.deepEqual(
      pending.map((x) => x.id),
      ['b', 'd'],
    );
  });

  it('按紧急程度与关键词筛选', () => {
    assert.deepEqual(
      filterTodos(list, { priority: 'urgent', today: '2026-07-20' }).map((x) => x.id),
      ['b'],
    );
    assert.deepEqual(
      filterTodos(list, { keyword: '周报', today: '2026-07-20' }).map((x) => x.id),
      ['d'],
    );
  });

  it('按修改时间倒序', () => {
    const sorted = sortTodos(list);
    assert.deepEqual(
      sorted.map((x) => x.id),
      ['c', 'b', 'd', 'a'],
    );
  });

  it('统计包含延期数量', () => {
    const counts = todoCounts(list, '2026-07-20');
    assert.equal(counts.total, 4);
    assert.equal(counts.overdue, 1);
    assert.equal(counts.pending, 2);
    assert.equal(counts.in_progress, 0);
    assert.equal(counts.done, 1);
  });
});

describe('待办入参归一化', () => {
  it('标题为空返回 null', () => {
    assert.equal(normalizeTodoInput({ title: '   ' }), null);
    assert.equal(normalizeTodoInput(null), null);
  });

  it('只保留合法枚举与 YYYY-MM-DD 日期', () => {
    const out = normalizeTodoInput({
      title: ' 提交报告 ',
      status: 'done',
      priority: 'bogus',
      startDate: '2026-07-01',
      dueDate: '7月2日',
      note: 123,
      extra: 'drop',
    });
    assert.deepEqual(out, {
      title: '提交报告',
      status: 'done',
      startDate: '2026-07-01',
      dueDate: '',
      note: '',
    });
  });

  it('读回旧数据时补齐缺省字段', () => {
    const parsed = normalizeTodoItem({ id: 'x', title: '跟进' });
    assert.ok(parsed);
    assert.equal(parsed?.status, 'pending');
    assert.equal(parsed?.priority, '');
    assert.equal(parsed?.source, 'manual');
    assert.equal(parsed?.doneAt, null);
  });
});

describe('AI 新增待办提示', () => {
  it('直接调用工具弹确认卡片，不先用提问卡片逐项追问', () => {
    assert.match(TODO_SYSTEM_HINT, /ask_user_question/);
    assert.match(TODO_SYSTEM_HINT, /确认卡片|快卡/);
  });

  it('只有用户明确要求记录待办时才调用 todo_add，不从闲聊里提炼', () => {
    assert.match(TODO_SYSTEM_HINT, /明确要求/);
    assert.match(TODO_SYSTEM_HINT, /不要调用 todo_add/);
    assert.doesNotMatch(TODO_SYSTEM_HINT, /空数组/);
  });
});
