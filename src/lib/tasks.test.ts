import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterTasks,
  normalizeTaskInput,
  normalizeTaskItem,
  taskCounts,
  taskCycleDays,
  taskTodoStats,
  type TaskItem,
} from './tasks';
import { TASK_SYSTEM_HINT } from './task-tools';

function task(patch: Partial<TaskItem> = {}): TaskItem {
  return {
    id: patch.id ?? 'tk_1',
    title: patch.title ?? '任务',
    status: patch.status ?? 'pool',
    priority: patch.priority ?? '',
    startDate: patch.startDate ?? '',
    dueDate: patch.dueDate ?? '',
    note: patch.note ?? '',
    source: patch.source ?? 'manual',
    sessionId: patch.sessionId ?? '',
    createdAt: patch.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: patch.updatedAt ?? '2026-01-01T00:00:00.000Z',
    doneAt: patch.doneAt ?? null,
  };
}

describe('任务入参归一化', () => {
  it('标题为空返回 null', () => {
    assert.equal(normalizeTaskInput({ title: '   ' }), null);
    assert.equal(normalizeTaskInput(null), null);
  });

  it('只保留合法枚举与 YYYY-MM-DD 日期', () => {
    const out = normalizeTaskInput({
      title: ' 版本发布 ',
      status: 'in_progress',
      priority: 'urgent_important',
      startDate: '2026-10-01',
      dueDate: '2026/10/08',
      note: ' 提前准备 ',
    });
    assert.deepEqual(out, {
      title: '版本发布',
      status: 'in_progress',
      priority: 'urgent_important',
      startDate: '2026-10-01',
      dueDate: '',
      note: '提前准备',
    });
  });

  it('读回的数据缺字段时给默认值', () => {
    const item = normalizeTaskItem({ title: '任务' });
    assert.equal(item?.status, 'pool');
    assert.equal(item?.priority, '');
    assert.equal(item?.doneAt, null);
    assert.match(item?.id ?? '', /^tk_/);
  });
});

describe('任务派生值与筛选', () => {
  const list = [
    task({ id: 'a', title: '发布', status: 'in_progress', priority: 'urgent_important' }),
    task({ id: 'b', title: '整理文档', status: 'pool', priority: 'normal' }),
    task({ id: 'c', title: '回归测试', status: 'done', priority: 'urgent' }),
    task({ id: 'd', title: '归档', status: 'closed', priority: '' }),
  ];

  it('任务周期含首尾', () => {
    assert.equal(taskCycleDays({ startDate: '2026-10-01', dueDate: '2026-10-08' }), 8);
    assert.equal(taskCycleDays({ startDate: '2026-10-01', dueDate: '' }), null);
  });

  it('按状态与紧急程度筛选', () => {
    assert.deepEqual(
      filterTasks(list, { status: 'pool' }).map((x) => x.id),
      ['b'],
    );
    assert.deepEqual(
      filterTasks(list, { status: 'urgent' }).map((x) => x.id),
      ['a', 'c'],
    );
    assert.deepEqual(
      filterTasks(list, { priority: 'normal' }).map((x) => x.id),
      ['b'],
    );
    assert.deepEqual(
      filterTasks(list, { keyword: '回归' }).map((x) => x.id),
      ['c'],
    );
  });

  it('统计包含需要紧急', () => {
    const counts = taskCounts(list);
    assert.equal(counts.total, 4);
    assert.equal(counts.pool, 1);
    assert.equal(counts.in_progress, 1);
    assert.equal(counts.done, 1);
    assert.equal(counts.closed, 1);
    assert.equal(counts.urgent, 2);
  });

  it('按 taskId 汇总待办数量与完成进度', () => {
    const stats = taskTodoStats([
      { taskId: 'a', status: 'done' },
      { taskId: 'a', status: 'pending' },
      { taskId: 'a', status: 'in_progress' },
      { taskId: 'b', status: 'done' },
      { taskId: '', status: 'done' },
    ]);
    assert.deepEqual(stats.a, { total: 3, done: 1, percent: 33 });
    assert.deepEqual(stats.b, { total: 1, done: 1, percent: 100 });
    assert.equal(stats[''], undefined);
  });
});

describe('AI 新增任务提示', () => {
  it('直接调用工具弹确认卡片，不先用提问卡片逐项追问', () => {
    assert.match(TASK_SYSTEM_HINT, /ask_user_question/);
    assert.match(TASK_SYSTEM_HINT, /确认卡片/);
    assert.match(TASK_SYSTEM_HINT, /空数组/);
  });
});
