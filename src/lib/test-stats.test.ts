import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TEST_DIMENSIONS,
  filterTestStats,
  normalizeDimensions,
  normalizeTestStatsItem,
  sortTestStats,
  testStatsCounts,
  toCount,
  type TestStatsItem,
} from './test-stats';

function item(over: Partial<TestStatsItem> = {}): TestStatsItem {
  return {
    id: 'ts_1',
    date: '2026-08-21',
    dimensions: ['接口测试用例'],
    count: 10,
    draft: false,
    source: 'manual',
    sessionId: '',
    createdAt: '2026-08-21T08:00:00.000Z',
    updatedAt: '2026-08-21T08:00:00.000Z',
    ...over,
  };
}

describe('测试统计：维度归一化', () => {
  it('去空白、去重并保持选择顺序', () => {
    assert.deepEqual(normalizeDimensions([' 接口测试用例 ', '缺陷统计', '接口测试用例', '']), [
      '接口测试用例',
      '缺陷统计',
    ]);
  });

  it('非数组按空处理', () => {
    assert.deepEqual(normalizeDimensions(undefined), []);
    assert.deepEqual(normalizeDimensions('接口测试用例'), []);
  });

  it('默认维度覆盖截图里的常用项', () => {
    for (const name of ['功能测试用例', '接口测试用例', '测试报告', '缺陷统计', '测试计划']) {
      assert.ok((DEFAULT_TEST_DIMENSIONS as readonly string[]).includes(name), name);
    }
  });
});

describe('测试统计：数量', () => {
  it('空值 / 负数归零，小数四舍五入', () => {
    assert.equal(toCount(''), 0);
    assert.equal(toCount('abc'), 0);
    assert.equal(toCount(-3), 0);
    assert.equal(toCount('12.6'), 13);
  });
});

describe('测试统计：解析 / 排序 / 统计', () => {
  it('缺维度的记录直接丢弃', () => {
    assert.equal(normalizeTestStatsItem({ count: 3 }), null);
  });

  it('带 draft 标记的空占位行保留（新增行要能落库）', () => {
    const parsed = normalizeTestStatsItem({ draft: true, dimensions: [], count: '0' });
    assert.ok(parsed);
    assert.equal(parsed.draft, true);
    assert.deepEqual(parsed.dimensions, []);
  });

  it('缺少日期时落到今天', () => {
    const parsed = normalizeTestStatsItem({ dimensions: ['测试报告'], count: '8' });
    assert.ok(parsed);
    assert.equal(parsed.count, 8);
    assert.match(parsed.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('日期倒序，同一天按创建时间倒序（最新记录在最上面）', () => {
    const sorted = sortTestStats([
      item({ id: 'a', date: '2026-08-19' }),
      item({ id: 'b', date: '2026-08-21', createdAt: '2026-08-21T07:00:00.000Z' }),
      item({ id: 'c', date: '2026-08-21', createdAt: '2026-08-21T09:00:00.000Z' }),
    ]);
    assert.deepEqual(
      sorted.map((x) => x.id),
      ['c', 'b', 'a'],
    );
  });

  it('关键词可以搜日期、维度与数量', () => {
    const list = [
      item({ id: 'a', dimensions: ['接口测试用例'], count: 255 }),
      item({ id: 'b', dimensions: ['缺陷统计'], count: 3 }),
    ];
    assert.deepEqual(
      filterTestStats(list, { keyword: '接口' }).map((x) => x.id),
      ['a'],
    );
    assert.deepEqual(
      filterTestStats(list, { keyword: '255' }).map((x) => x.id),
      ['a'],
    );
  });

  it('页头统计：记录数 / 维度数 / 数量合计', () => {
    const counts = testStatsCounts([
      item({ dimensions: ['接口测试用例'], count: 255 }),
      item({ dimensions: ['接口测试用例', '缺陷统计'], count: 45 }),
    ]);
    assert.deepEqual(counts, { records: 2, dimensions: 2, total: 300 });
  });
});
