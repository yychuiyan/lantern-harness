import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countGapsBySeverity, groupReviewGaps, reviewToMarkdown } from './story-review';
import type { ReqAnalysisDoc, ReqGap } from './req-analysis';

function gap(over: Partial<ReqGap>): ReqGap {
  return {
    id: over.id ?? 'g1',
    storyId: over.storyId ?? '',
    type: over.type ?? 'other',
    severity: over.severity ?? 'medium',
    title: over.title ?? '缺口',
    detail: over.detail ?? '',
    suggestion: over.suggestion ?? '',
    origin: over.origin ?? 'rule',
    selected: over.selected ?? false,
  };
}

const DOC: ReqAnalysisDoc = {
  id: 'ra_1',
  title: '优惠券中心',
  sourcePath: '需求/优惠券.md',
  sourceTitle: '优惠券.md',
  sourceHash: '',
  status: 'checked',
  outline: [],
  stories: [
    {
      id: 'US-001',
      title: '领取优惠券',
      role: '普通用户',
      goal: '领到券',
      value: '',
      sourceRefs: [],
      priority: 'P0',
      preconditions: [],
      mainFlow: [],
      altFlows: [],
      exceptions: [],
      postconditions: [],
      acceptance: [],
      dimensions: [],
    },
  ],
  check: null,
  testPoints: null,
  progress: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('groupReviewGaps', () => {
  it('把场景遗漏与维度缺失分别归组，其余进「其它」', () => {
    const groups = groupReviewGaps([
      gap({ id: 'a', type: 'missing-scenario', title: '只写了顺利路径' }),
      gap({ id: 'b', type: 'missing-dimension', title: '没有空态' }),
      gap({ id: 'c', type: 'untestable-acceptance', title: '验收不可测' }),
    ]);
    assert.deepEqual(
      groups.map((g) => g.key),
      ['scenario', 'dimension', 'other'],
    );
    assert.deepEqual(
      groups.map((g) => g.gaps.map((x) => x.id)),
      [['a'], ['b'], ['c']],
    );
  });

  it('空分组不出现，组内按严重度排序', () => {
    const groups = groupReviewGaps([
      gap({ id: 'low', type: 'missing-scenario', severity: 'low', title: 'b' }),
      gap({ id: 'high', type: 'missing-scenario', severity: 'high', title: 'a' }),
      gap({ id: 'mid', type: 'missing-scenario', severity: 'medium', title: 'c' }),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0]!.gaps.map((g) => g.id),
      ['high', 'mid', 'low'],
    );
  });

  it('没有缺口时返回空数组', () => {
    assert.deepEqual(groupReviewGaps([]), []);
  });
});

describe('countGapsBySeverity', () => {
  it('按严重度计数', () => {
    const counts = countGapsBySeverity([
      gap({ id: '1', severity: 'high' }),
      gap({ id: '2', severity: 'high' }),
      gap({ id: '3', severity: 'low' }),
    ]);
    assert.deepEqual(counts, { high: 2, medium: 0, low: 1 });
  });
});

describe('reviewToMarkdown', () => {
  const check = {
    at: '2026-02-02T10:00:00.000Z',
    summary: '整体结构完整，场景覆盖不足。',
    coverage: { total: 2, covered: 1, rate: 0.5 },
    dimensions: [{ key: 'boundary', label: '边界值', covered: false, stories: [] }],
    gaps: [
      gap({
        id: 'x',
        storyId: 'US-001',
        type: 'missing-scenario',
        severity: 'high',
        title: '没有领券失败的处理',
        detail: '主流程只有成功路径',
        suggestion: '补重复领取与库存不足',
      }),
      gap({ id: 'y', type: 'missing-dimension', title: '没有考虑空数据' }),
    ],
  };

  it('输出分组标题、覆盖率与建议', () => {
    const md = reviewToMarkdown({ ...DOC, check }, check);
    assert.match(md, /^# 用户故事审查报告 · 优惠券中心/);
    assert.match(md, /需求条目覆盖率：1\/2（50%）/);
    assert.match(md, /## 场景遗漏（1）/);
    assert.match(md, /## 维度缺失（1）/);
    assert.match(md, /US-001 领取优惠券/);
    assert.match(md, /建议：补重复领取与库存不足/);
    assert.match(md, /整体结构完整，场景覆盖不足。/);
  });

  it('没有审查结果时只说明一句', () => {
    const md = reviewToMarkdown(DOC, null);
    assert.match(md, /还没有审查结果/);
  });
});
