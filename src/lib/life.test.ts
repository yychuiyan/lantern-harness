import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cycleDays,
  defaultPlanTypeId,
  formatCycleDays,
  krTaskTodoStats,
  objectiveKeyResults,
  objectiveProgress,
  resolvePlanTypeId,
  resolveYearCycleId,
  sortPlanTypes,
  sortYearCycles,
  yearCycleLabel,
  yearCyclesFromPlans,
  type KrTaskItem,
  type KrTodoItem,
  type PlanTypeItem,
  type YearCycleItem,
  type YearPlanItem,
} from './life';

function todo(patch: Partial<KrTodoItem> = {}): KrTodoItem {
  return {
    id: patch.id ?? 'kt_1',
    title: patch.title ?? '待办',
    status: patch.status ?? 'pending',
    krTaskId: patch.krTaskId ?? 'kr_1',
    startDate: patch.startDate ?? '',
    dueDate: patch.dueDate ?? '',
    note: patch.note ?? '',
    createdAt: patch.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: patch.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function task(patch: Partial<KrTaskItem> = {}): KrTaskItem {
  return {
    id: patch.id ?? 'kr_1',
    title: patch.title ?? '任务',
    status: patch.status ?? 'pool',
    priority: patch.priority ?? '',
    planType: patch.planType ?? '',
    objectiveId: patch.objectiveId ?? 'ob_1',
    aiComment: patch.aiComment ?? '',
    note: patch.note ?? '',
    createdAt: patch.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: patch.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('人生管理派生字段', () => {
  it('待办周期含首尾', () => {
    assert.equal(cycleDays('2026-07-07', '2026-07-22'), 16);
    assert.equal(cycleDays('2026-07-07', '2026-07-07'), 1);
    assert.equal(formatCycleDays(16), '16 天');
    assert.equal(cycleDays('', '2026-07-22'), null);
  });

  it('KR 任务进度按已完成待办占比', () => {
    const todos = [
      todo({ id: 'a', status: 'done' }),
      todo({ id: 'b', status: 'in_progress' }),
      todo({ id: 'c', status: 'done', krTaskId: 'kr_other' }),
    ];
    const stats = krTaskTodoStats('kr_1', todos);
    assert.equal(stats.count, 2);
    assert.equal(stats.done, 1);
    assert.equal(stats.progress, 50);
  });

  it('Objective 完成度为关联 KR 进度均值', () => {
    const tasks = [
      task({ id: 'kr_1', objectiveId: 'ob_1' }),
      task({ id: 'kr_2', objectiveId: 'ob_1' }),
      task({ id: 'kr_3', objectiveId: 'ob_other' }),
    ];
    const todos = [
      todo({ id: 'a', krTaskId: 'kr_1', status: 'done' }),
      todo({ id: 'b', krTaskId: 'kr_1', status: 'done' }),
      todo({ id: 'c', krTaskId: 'kr_2', status: 'pending' }),
    ];
    // kr_1 = 100%, kr_2 = 0% → 均值 50
    assert.equal(objectiveProgress('ob_1', tasks, todos), 50);
    assert.deepEqual(objectiveKeyResults('ob_1', tasks), ['任务', '任务']);
  });

  it('年度周期从年度计划去重（收集 id）', () => {
    const plans: YearPlanItem[] = [
      {
        id: 'yp1',
        title: 'a',
        yearCycle: 'yc_2026',
        planType: 'pt_learning',
        status: 'in_progress',
        objectiveIds: [],
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'yp2',
        title: 'b',
        yearCycle: 'yc_2025',
        planType: 'pt_work',
        status: 'done',
        objectiveIds: [],
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'yp3',
        title: 'c',
        yearCycle: 'yc_2026',
        planType: 'pt_family',
        status: 'in_progress',
        objectiveIds: [],
        createdAt: '',
        updatedAt: '',
      },
    ];
    assert.deepEqual(yearCyclesFromPlans(plans), ['yc_2026', 'yc_2025']);
  });

  it('年度周期目录：按修改时间倒序，旧文案映射到 id', () => {
    const cycles: YearCycleItem[] = [
      {
        id: 'yc_a',
        name: '2025年',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'yc_b',
        name: '2026年',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ];
    assert.deepEqual(
      sortYearCycles(cycles).map((t) => t.id),
      ['yc_b', 'yc_a'],
    );
    assert.equal(yearCycleLabel(cycles, 'yc_b'), '2026年');
    assert.equal(resolveYearCycleId('yc_b', cycles), 'yc_b');
    assert.equal(resolveYearCycleId('2025年', cycles), 'yc_a');
    assert.equal(resolveYearCycleId('unknown', cycles), '');
  });

  it('计划类型按修改时间倒序，旧枚举映射到种子 id', () => {
    const types: PlanTypeItem[] = [
      {
        id: 'pt_a',
        name: 'A',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'pt_b',
        name: 'B',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ];
    assert.deepEqual(
      sortPlanTypes(types).map((t) => t.id),
      ['pt_b', 'pt_a'],
    );
    assert.equal(defaultPlanTypeId(types), 'pt_b');
    const ids = new Set(['pt_learning', 'pt_work']);
    assert.equal(resolvePlanTypeId('learning', ids), 'pt_learning');
    assert.equal(resolvePlanTypeId('pt_work', ids), 'pt_work');
    assert.equal(resolvePlanTypeId('unknown', ids), '');
  });
});
