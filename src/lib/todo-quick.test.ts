import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROUTINE_TASK_TITLE,
  findTaskByHint,
  pickRoutineTask,
  routineTaskFields,
} from './todo-quick';
import type { TaskItem, TaskPriority, TaskStatus } from './tasks';

function task(
  id: string,
  title: string,
  status: TaskStatus = 'in_progress',
  priority: TaskPriority = 'important',
): TaskItem {
  return {
    id,
    title,
    status,
    priority,
    startDate: '',
    dueDate: '',
    note: '',
    source: 'manual',
    sessionId: '',
    createdAt: '',
    updatedAt: '',
    doneAt: null,
  };
}

describe('routineTaskFields', () => {
  it('「日常待办」固定为 进行中 / 重要不紧急 / 当年第一天到当年最后一天', () => {
    assert.deepEqual(routineTaskFields('2026-10-19'), {
      title: ROUTINE_TASK_TITLE,
      status: 'in_progress',
      priority: 'important',
      startDate: '2026-01-01',
      dueDate: '2026-12-31',
    });
  });

  it('跨年时按当天所在年份重算', () => {
    assert.equal(routineTaskFields('2027-01-01').startDate, '2027-01-01');
    assert.equal(routineTaskFields('2027-12-31').dueDate, '2027-12-31');
  });

  it('日期不合法时退回当前年份，不产出 NaN', () => {
    const fields = routineTaskFields('unknown');
    assert.match(fields.startDate, /^\d{4}-01-01$/);
    assert.match(fields.dueDate, /^\d{4}-12-31$/);
  });
});

describe('pickRoutineTask', () => {
  it('优先取进行中的「日常待办」', () => {
    const picked = pickRoutineTask([
      task('a', ROUTINE_TASK_TITLE, 'pool'),
      task('b', ROUTINE_TASK_TITLE, 'in_progress'),
      task('c', '别的任务'),
    ]);
    assert.equal(picked?.id, 'b');
  });

  it('没有进行中时取其它未关闭的同名任务', () => {
    const picked = pickRoutineTask([task('a', ROUTINE_TASK_TITLE, 'done')]);
    assert.equal(picked?.id, 'a');
  });

  it('只有已关闭 / 已取消时返回 null，由调用方新建', () => {
    const picked = pickRoutineTask([
      task('a', ROUTINE_TASK_TITLE, 'closed'),
      task('b', ROUTINE_TASK_TITLE, 'cancelled'),
      task('c', '别的任务'),
    ]);
    assert.equal(picked, null);
  });

  it('忽略前后空格，但不会误匹配其它名字', () => {
    assert.equal(pickRoutineTask([task('a', ` ${ROUTINE_TASK_TITLE} `)])?.id, 'a');
    assert.equal(pickRoutineTask([task('a', `${ROUTINE_TASK_TITLE}（旧）`)]), null);
  });
});

describe('findTaskByHint', () => {
  const tasks = [task('a', '登录模块'), task('b', '登录模块', 'closed'), task('c', '日常待办')];

  it('优先按 taskId 精确匹配', () => {
    assert.equal(findTaskByHint(tasks, { taskId: 'b' })?.id, 'b');
  });

  it('只有名称时优先未关闭的同名任务', () => {
    assert.equal(findTaskByHint(tasks, { linkedTask: '登录模块' })?.id, 'a');
  });

  it('任务不存在时返回 null，不臆造任务', () => {
    assert.equal(findTaskByHint(tasks, { taskId: 'zzz', linkedTask: '没有这个任务' }), null);
  });
});
