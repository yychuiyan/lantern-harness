import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countGapsBySeverity,
  groupReviewGaps,
  pendingConfirmToMarkdown,
  reviewToMarkdown,
} from './story-review';
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
    conclusion: over.conclusion,
    outlineId: over.outlineId,
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
  it('待确认与未覆盖分别归组，其余进「其它」', () => {
    const groups = groupReviewGaps([
      gap({ id: 'a', type: 'pending-confirm', title: '口径不清' }),
      gap({ id: 'b', type: 'uncovered-outline', title: '条目未覆盖' }),
      gap({ id: 'c', type: 'other', title: '其它' }),
    ]);
    assert.deepEqual(
      groups.map((g) => g.key),
      ['pending', 'uncovered', 'other'],
    );
    assert.deepEqual(
      groups.map((g) => g.gaps.map((x) => x.id)),
      [['a'], ['b'], ['c']],
    );
  });

  it('空分组不出现，组内按严重度排序', () => {
    const groups = groupReviewGaps([
      gap({ id: 'low', type: 'pending-confirm', severity: 'low', title: 'b' }),
      gap({ id: 'high', type: 'pending-confirm', severity: 'high', title: 'a' }),
      gap({ id: 'mid', type: 'pending-confirm', severity: 'medium', title: 'c' }),
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
        type: 'pending-confirm',
        severity: 'high',
        title: '失败路径口径待确认',
        detail: '原文未写清库存不足时的提示',
        suggestion: '与产品确认提示文案',
      }),
      gap({ id: 'y', type: 'uncovered-outline', title: '待确认：需求点未覆盖' }),
    ],
  };

  it('输出分组标题、覆盖率与建议', () => {
    const md = reviewToMarkdown({ ...DOC, check }, check);
    assert.match(md, /^# 用户故事审查报告 · 优惠券中心/);
    assert.match(md, /需求条目覆盖率：1\/2（50%）/);
    assert.match(md, /## 待确认（1）/);
    assert.match(md, /## 需求点未覆盖（1）/);
    assert.match(md, /US-001 领取优惠券/);
    assert.match(md, /建议：与产品确认提示文案/);
    assert.match(md, /整体结构完整，场景覆盖不足。/);
  });

  it('没有审查结果时只说明一句', () => {
    const md = reviewToMarkdown(DOC, null);
    assert.match(md, /还没有审查结果/);
  });
});

describe('pendingConfirmToMarkdown', () => {
  const check = {
    at: '2026-02-02T10:00:00.000Z',
    summary: '',
    coverage: { total: 2, covered: 1, rate: 0.5 },
    dimensions: [],
    gaps: [
      gap({
        id: 'x',
        storyId: 'US-001',
        type: 'pending-confirm',
        severity: 'high',
        title: '信息审核·提交：倒计时没说清楚',
        detail: '原文只写要有倒计时，故事写成按钮倒计时。',
        suggestion: '跟业务确认秒数和用途',
        outlineId: 'RO-1-1',
        conclusion: '3秒后关页',
      }),
      gap({
        id: 'y',
        type: 'uncovered-outline',
        title: '列表查询：还没有用户故事挂上',
        detail: '这个点还没故事',
        selected: true,
      }),
    ],
  };

  it('输出需求内容/疑问/结论，不含覆盖率块', () => {
    const md = pendingConfirmToMarkdown({ ...DOC, check }, check, {
      outlineBodies: new Map([['RO-1-1', '提交：(1)要有倒计时']]),
    });
    assert.match(md, /^# 待确认事项 · 优惠券中心/);
    assert.match(md, /需求内容：提交：\(1\)要有倒计时/);
    assert.match(md, /疑问：原文只写要有倒计时/);
    assert.match(md, /结论：3秒后关页/);
    assert.doesNotMatch(md, /覆盖率/);
    assert.doesNotMatch(md, /维度覆盖/);
  });

  it('勾选子集时只导出已选', () => {
    const md = pendingConfirmToMarkdown({ ...DOC, check }, check, { gapIds: ['y'] });
    assert.match(md, /列表查询：还没有用户故事挂上/);
    assert.doesNotMatch(md, /倒计时没说清楚/);
  });
});
