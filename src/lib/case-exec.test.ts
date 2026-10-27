import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  caseExecBaselines,
  caseExecCounts,
  caseExecCumulativeExecuted,
  caseExecExecuted,
  caseExecPercent,
  caseExecProjectProgress,
  caseExecRemaining,
  caseExecResolveExecuted,
  countCaseExecByProject,
  filterCaseExec,
  formatCaseExecPercent,
  groupCaseExec,
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
    assert.equal(caseExecRemaining(item({ total: 100, pending: 0, executed: 130 })), 0);
  });

  it('已执行用例 = 用例总数 − 待执行用例（填完自动算）', () => {
    assert.equal(caseExecExecuted(339, 125), 214);
    // 待执行超过总数时不会算成负数
    assert.equal(caseExecExecuted(100, 130), 0);
    assert.equal(caseExecExecuted(0, 0), 0);
  });

  it('历史记录只有总数与待执行时，也自动算出已执行', () => {
    const legacy = item({ total: 196, pending: 149, executed: 0 });
    assert.equal(caseExecResolveExecuted(legacy), 47);
    assert.equal(caseExecRemaining(legacy), 149);
    assert.equal(formatCaseExecPercent(legacy), '23.98%');
  });

  it('只填了用例总数（待执行、已执行都还是 0）时不算成全部执行完', () => {
    const item2 = item({ total: 196, pending: 0, executed: 0 });
    assert.equal(caseExecResolveExecuted(item2), 0);
    assert.equal(caseExecRemaining(item2), 196);
    assert.equal(formatCaseExecPercent(item2), '0.00%');
  });

  it('执行比例与截图一致（保留两位小数）', () => {
    assert.equal(formatCaseExecPercent(item({ total: 255, pending: 187, executed: 68 })), '26.67%');
    assert.equal(formatCaseExecPercent(item({ total: 255, pending: 0, executed: 255 })), '100.00%');
    assert.equal(formatCaseExecPercent(item({ total: 208, pending: 31, executed: 177 })), '85.10%');
    assert.equal(formatCaseExecPercent(item({ total: 0, executed: 0 })), '0.00%');
    assert.equal(caseExecPercent(item({ total: 100, pending: 0, executed: 130 })), 100);
  });

  it('累计已执行 = 基线 − 该行当前剩余，和百分比永远配对', () => {
    // 最新一行：总数 149、待执行 50 → 累计 196 − 50 = 146，146 ÷ 196 = 74.49%
    const latest = item({ date: '2026-10-27', total: 149, pending: 50, executed: 99 });
    assert.equal(caseExecCumulativeExecuted(latest, 196), 146);
    assert.equal(formatCaseExecPercent(latest, 196), '74.49%');
    // 更早一行：剩余 149 → 累计 47，47 ÷ 196 = 23.98%
    const earlier = item({ date: '2026-10-27', total: 196, pending: 149, executed: 0 });
    assert.equal(caseExecCumulativeExecuted(earlier, 196), 47);
    assert.equal(formatCaseExecPercent(earlier, 196), '23.98%');
    // 剩余超过基线时不会算成负数（某轮把总数填得比基线大）
    assert.equal(caseExecCumulativeExecuted(item({ total: 200, pending: 200 }), 100), 0);
    // 没有基线时回落到这一行自己的已执行
    assert.equal(
      caseExecCumulativeExecuted(item({ total: 100, pending: 40, executed: 60 }), 0),
      60,
    );
  });

  it('项目基线取最早一条记录的用例总数，比例按 1 − 剩余 ÷ 基线算', () => {
    const rows = [
      item({
        id: 'c',
        date: '2026-08-21',
        createdAt: '2026-08-21T08:00:00.000Z',
        total: 339,
        pending: 125,
        executed: 0,
      }),
      item({
        id: 'a',
        date: '2026-08-19',
        createdAt: '2026-08-19T08:00:00.000Z',
        total: 730,
        pending: 616,
        executed: 0,
      }),
      item({
        id: 'b',
        date: '2026-08-20',
        createdAt: '2026-08-20T08:00:00.000Z',
        total: 616,
        pending: 339,
        executed: 0,
      }),
    ];
    const baselines = caseExecBaselines(rows);
    assert.equal(baselines.get('运营系统v1.9.0'), 730);
    // 剩 125 → (730 − 125) ÷ 730
    assert.equal(formatCaseExecPercent(rows[0], 730), '82.88%');
    assert.equal(formatCaseExecPercent(rows[2], 730), '53.56%');
    // 基线为 0 / 缺省时回落到这一行自己的总数
    assert.equal(formatCaseExecPercent(rows[0]), '63.13%');
    assert.equal(formatCaseExecPercent(rows[0], 0), '0.00%');
  });

  it('同一天多条记录取创建时间更早的那条当基线', () => {
    const rows = [
      item({
        id: 'late',
        date: '2026-10-27',
        createdAt: '2026-10-27T11:50:27.969Z',
        total: 149,
        pending: 50,
        executed: 0,
      }),
      item({
        id: 'early',
        date: '2026-10-27',
        createdAt: '2026-10-27T01:12:19.065Z',
        total: 196,
        pending: 149,
        executed: 0,
      }),
    ];
    assert.equal(caseExecBaselines(rows).get('运营系统v1.9.0'), 196);
    assert.equal(formatCaseExecPercent(rows[0], 196), '74.49%');
  });

  it('基线跳过没有项目名称、用例总数为 0 的记录', () => {
    const rows = [
      item({ id: 'draft', project: '', draft: true, total: 500 }),
      item({ id: 'zero', date: '2026-08-01', total: 0 }),
    ];
    assert.equal(caseExecBaselines(rows).size, 0);
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

  it('项目名称被引用的记录数（删除前的拦截依据）', () => {
    const list = [
      item({ id: 'a', project: '虹口知识库迁移' }),
      item({ id: 'b', project: '运营系统v1.9.0' }),
      item({ id: 'c', project: '虹口知识库迁移' }),
    ];
    assert.equal(countCaseExecByProject(list, '虹口知识库迁移'), 2);
    assert.equal(countCaseExecByProject(list, '运营系统v1.9.0'), 1);
    assert.equal(countCaseExecByProject(list, '没有这个项目'), 0);
    assert.equal(countCaseExecByProject(list, '  '), 0);
  });

  it('页头统计：记录数 / 项目数 / 整体执行率', () => {
    const counts = caseExecCounts([
      item({ project: 'A', date: '2026-08-21', total: 100, pending: 75, executed: 25 }),
      item({ project: 'B', total: 300, pending: 225, executed: 75 }),
      item({ project: 'A', date: '2026-08-22', total: 100, pending: 10, executed: 90 }),
    ]);
    assert.equal(counts.records, 3);
    assert.equal(counts.projects, 2);
    assert.equal(counts.total, 500);
    // 分母按项目只算一次：A 取第一条的 100，B 取 300
    assert.equal(counts.baseline, 400);
    // A 取最新一条的剩余 10（100 − 10 = 90），B 只有一条（300 − 225 = 75）
    assert.equal(counts.executed, 165);
    assert.equal(counts.percent.toFixed(2), '41.25');
  });

  it('整体执行率不超过 100%，也不受某轮重填总数影响', () => {
    const counts = caseExecCounts([
      item({ project: 'A', date: '2026-08-20', total: 100, pending: 40, executed: 0 }),
      // 第二轮把总数填成更大的值，仍按基线 100 算
      item({ project: 'A', date: '2026-08-21', total: 255, pending: 0, executed: 255 }),
    ]);
    assert.equal(counts.baseline, 100);
    assert.equal(counts.executed, 100);
    assert.equal(counts.percent, 100);
  });

  it('最新一行只填了总数（待执行仍为 0）时按还没开始算', () => {
    const counts = caseExecCounts([
      item({ project: 'A', date: '2026-08-20', total: 100, pending: 40, executed: 0 }),
      item({ project: 'A', date: '2026-08-21', total: 100, pending: 0, executed: 0 }),
    ]);
    // 沿用「填了总数但还没开始填待执行」的既有口径：剩余 = 总数，不算完成
    assert.equal(counts.baseline, 100);
    assert.equal(counts.executed, 0);
    assert.equal(counts.percent, 0);
  });

  it('页头整体执行率与行内同一口径（真实三条运管记录）', () => {
    const rows = [
      item({
        id: 'new',
        date: '2026-08-21',
        total: 339,
        pending: 125,
        executed: 0,
      }),
      item({ id: 'mid', date: '2026-08-20', total: 616, pending: 339, executed: 0 }),
      item({ id: 'old', date: '2026-08-19', total: 730, pending: 616, executed: 0 }),
    ];
    const counts = caseExecCounts(rows);
    assert.equal(counts.baseline, 730);
    // 最新一条剩余 125 → 730 − 125
    assert.equal(counts.executed, 605);
    assert.equal(counts.percent.toFixed(2), '82.88');
    // 与最新那一行的行内比例一致
    assert.equal(formatCaseExecPercent(rows[0], 730), '82.88%');
  });

  it('每个项目按 基线 − 最新剩余 汇总（含重复填总数的项目）', () => {
    const progress = caseExecProjectProgress([
      item({ id: 'a1', project: 'A', date: '2026-07-20', total: 255, pending: 187, executed: 0 }),
      item({ id: 'a2', project: 'A', date: '2026-07-21', total: 255, pending: 0, executed: 255 }),
      item({ id: 'b1', project: 'B', date: '2026-08-01', total: 100, pending: 30, executed: 0 }),
    ]);
    assert.deepEqual(progress.get('A'), {
      project: 'A',
      baseline: 255,
      remaining: 0,
      executed: 255,
    });
    assert.deepEqual(progress.get('B'), {
      project: 'B',
      baseline: 100,
      remaining: 30,
      executed: 70,
    });
  });

  it('同一天多条记录按创建时间取最新那条算剩余', () => {
    const progress = caseExecProjectProgress([
      item({
        id: 'early',
        project: 'A',
        date: '2026-10-27',
        createdAt: '2026-10-27T01:12:19.065Z',
        total: 196,
        pending: 149,
        executed: 0,
      }),
      item({
        id: 'late',
        project: 'A',
        date: '2026-10-27',
        createdAt: '2026-10-27T11:50:27.969Z',
        total: 149,
        pending: 50,
        executed: 0,
      }),
    ]);
    assert.equal(progress.get('A')?.baseline, 196);
    assert.equal(progress.get('A')?.remaining, 50);
    assert.equal(progress.get('A')?.executed, 146);
  });
});

describe('用例执行统计：两级分组（项目 / 统计日期）', () => {
  const rows = [
    item({
      id: 'a1',
      project: 'A',
      date: '2026-07-20',
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      createdAt: '2026-07-20T08:00:00.000Z',
      total: 255,
      pending: 187,
      executed: 0,
    }),
    item({
      id: 'a2',
      project: 'A',
      date: '2026-07-21',
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      createdAt: '2026-07-21T08:00:00.000Z',
      total: 255,
      pending: 31,
      executed: 0,
    }),
    item({
      id: 'b1',
      project: 'B',
      date: '2026-08-01',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      createdAt: '2026-08-01T08:00:00.000Z',
      total: 100,
      pending: 30,
      executed: 0,
    }),
  ];

  it('一个项目一组，组内子行按统计日期倒序', () => {
    const groups = groupCaseExec(rows);
    assert.deepEqual(
      groups.map((g) => g.project),
      ['B', 'A'],
    );
    assert.deepEqual(
      groups[1]?.items.map((x) => x.id),
      ['a2', 'a1'],
    );
    assert.equal(groups[1]?.latestDate, '2026-07-21');
  });

  it('周期取组内最新一条写了解日期的记录', () => {
    const groups = groupCaseExec(rows);
    const a = groups.find((g) => g.project === 'A');
    assert.ok(a);
    assert.equal(a.startDate, '2026-07-01');
    assert.equal(a.endDate, '2026-07-31');
  });

  it('组基线 / 累计已执行 / 执行率与页头同一口径', () => {
    const groups = groupCaseExec(rows);
    const a = groups.find((g) => g.project === 'A');
    assert.ok(a);
    // 基线取最早一条的 255，最新一条剩余 31 → 累计 224
    assert.equal(a.baseline, 255);
    assert.equal(a.executed, 224);
    assert.equal(a.percent.toFixed(2), '87.84');
    assert.equal(a.draft, false);
  });

  it('刚加的未命名占位行各自成组', () => {
    const groups = groupCaseExec([
      item({ id: 'd1', project: '', draft: true, total: 0, pending: 0, executed: 0 }),
      item({ id: 'd2', project: '', draft: true, total: 0, pending: 0, executed: 0 }),
      ...rows,
    ]);
    assert.equal(groups.length, 4);
    const drafts = groups.filter((g) => g.draft);
    assert.deepEqual(
      drafts.map((g) => g.key),
      ['draft:d1', 'draft:d2'],
    );
    assert.equal(drafts[0]?.baseline, 0);
    assert.equal(drafts[0]?.percent, 0);
  });

  it('关键词命中项目名时保留整组，只命中子行时只保留命中的子行', () => {
    const byProject = groupCaseExec(rows, { keyword: 'b' });
    assert.equal(byProject.length, 1);
    assert.equal(byProject[0]?.project, 'B');

    const byDate = groupCaseExec(rows, { keyword: '2026-07-20' });
    assert.equal(byDate.length, 1);
    assert.equal(byDate[0]?.project, 'A');
    assert.deepEqual(
      byDate[0]?.items.map((x) => x.id),
      ['a1'],
    );
    // 只命中子行时基线仍按整组算，不会因为搜索把分母改小
    assert.equal(byDate[0]?.baseline, 255);
  });

  it('没有匹配时返回空分组', () => {
    assert.deepEqual(groupCaseExec(rows, { keyword: '没有这个' }), []);
  });

  it('刚加的「＋统计日期」空行不算进度数据点', () => {
    const withEmpty = [
      ...rows,
      item({
        id: 'a3',
        project: 'A',
        date: '2026-07-22',
        createdAt: '2026-07-22T08:00:00.000Z',
        total: 0,
        pending: 0,
        executed: 0,
      }),
    ];
    const a = groupCaseExec(withEmpty).find((g) => g.project === 'A');
    assert.ok(a);
    // 空行仍是最新一条（组排序 / 展开时排最前），但累计进度沿用上一轮的剩余 31
    assert.equal(a.latestDate, '2026-07-22');
    assert.equal(a.items[0]?.id, 'a3');
    assert.equal(a.executed, 224);
    assert.equal(a.percent.toFixed(2), '87.84');
    // 页头整体执行率同样不被空行抬高
    assert.equal(caseExecCounts(withEmpty).executed, 224 + 70);
  });
});
