import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  caseExecCounts,
  caseExecPercent,
  caseExecRemaining,
  filterCaseExec,
  formatCaseExecPercent,
  normalizeCaseExecItem,
  sortCaseExec,
  type CaseExecItem,
} from './case-exec';

function item(over: Partial<CaseExecItem> = {}): CaseExecItem {
  return {
    id: 'ce_1',
    date: '2026-08-21',
    project: '运营系统v1.9.0',
    startDate: '2026-08-21',
    endDate: '2026-08-21',
    total: 339,
    pending: 125,
    executed: 214,
    draft: false,
    source: 'manual',
    sessionId: '',
    createdAt: '2026-08-21T08:00:00.000Z',
    updatedAt: '2026-08-21T08:00:00.000Z',
    ...over,
  };
}

describe('用例执行统计：派生列', () => {
  it('当前剩余用例 = 用例总数 − 已执行用例', () => {
    assert.equal(caseExecRemaining(item()), 125);
    assert.equal(caseExecRemaining(item({ total: 100, executed: 130 })), 0);
  });

  it('执行比例与截图一致（保留两位小数）', () => {
    assert.equal(formatCaseExecPercent(item({ total: 255, executed: 68 })), '26.67%');
    assert.equal(formatCaseExecPercent(item({ total: 255, executed: 255 })), '100.00%');
    assert.equal(formatCaseExecPercent(item({ total: 208, executed: 177 })), '85.10%');
    assert.equal(formatCaseExecPercent(item({ total: 0, executed: 0 })), '0.00%');
    assert.equal(caseExecPercent(item({ total: 100, executed: 130 })), 100);
  });
});

describe('用例执行统计：解析 / 排序 / 统计', () => {
  it('缺项目名称的记录直接丢弃', () => {
    assert.equal(normalizeCaseExecItem({ total: 10 }), null);
  });

  it('带 draft 标记的空占位行保留（新增行要能落库）', () => {
    const parsed = normalizeCaseExecItem({ draft: true, project: '', total: 0 });
    assert.ok(parsed);
    assert.equal(parsed.draft, true);
    assert.equal(parsed.project, '');
  });

  it('数字字段归一到非负整数', () => {
    const parsed = normalizeCaseExecItem({
      project: ' 虹口知识库 ',
      total: '730',
      pending: -2,
      executed: '114.4',
    });
    assert.ok(parsed);
    assert.equal(parsed.project, '虹口知识库');
    assert.equal(parsed.total, 730);
    assert.equal(parsed.pending, 0);
    assert.equal(parsed.executed, 114);
  });

  it('日期倒序，同一天按创建时间倒序（最新记录在最上面）', () => {
    const sorted = sortCaseExec([
      item({ id: 'a', date: '2026-07-20' }),
      item({ id: 'b', date: '2026-08-21', createdAt: '2026-08-21T07:00:00.000Z' }),
      item({ id: 'c', date: '2026-08-21', createdAt: '2026-08-21T09:00:00.000Z' }),
    ]);
    assert.deepEqual(
      sorted.map((x) => x.id),
      ['c', 'b', 'a'],
    );
  });

  it('按项目或日期搜索', () => {
    const list = [
      item({ id: 'a', project: '虹口知识库迁移' }),
      item({ id: 'b', project: '运营系统v1.9.0' }),
    ];
    assert.deepEqual(
      filterCaseExec(list, { keyword: '虹口' }).map((x) => x.id),
      ['a'],
    );
    assert.deepEqual(filterCaseExec(list, { keyword: '2026-08-21' }).length, 2);
  });

  it('页头统计：记录数 / 项目数 / 整体执行率', () => {
    const counts = caseExecCounts([
      item({ project: 'A', total: 100, executed: 25 }),
      item({ project: 'B', total: 300, executed: 75 }),
      item({ project: 'A', total: 100, executed: 100 }),
    ]);
    assert.equal(counts.records, 3);
    assert.equal(counts.projects, 2);
    assert.equal(counts.total, 500);
    assert.equal(counts.executed, 200);
    assert.equal(counts.percent, 40);
  });
});
