import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReqAnalysisDoc } from './req-analysis';
import {
  DIMENSION_META,
  DIMENSION_ORDER,
  buildXMindContent,
  countTestPoints,
  groupTestPoints,
  groupTestPointsByStory,
  sortTestPoints,
  testPointsToMarkdown,
  type TestPoint,
  type TestPointReport,
} from './test-points';

const BASE: Omit<TestPoint, 'id' | 'storyId' | 'dimension' | 'priority' | 'title'> = {
  precondition: '',
  steps: [],
  expected: '',
};

function point(over: Partial<TestPoint> & { id: string }): TestPoint {
  return {
    storyId: '',
    dimension: 'functional',
    priority: 'P1',
    title: over.id,
    ...BASE,
    ...over,
  };
}

function report(points: TestPoint[]): TestPointReport {
  return { at: '2026-01-01T00:00:00.000Z', summary: '', points };
}

function doc(partial: Partial<ReqAnalysisDoc> = {}): ReqAnalysisDoc {
  return {
    id: 'ra_1',
    title: '优惠券中心',
    sourcePath: '需求/优惠券.md',
    sourceTitle: '优惠券.md',
    sourceHash: '',
    status: 'decomposed',
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
    ...partial,
  };
}

describe('groupTestPoints', () => {
  it('五个维度固定顺序，空维度也保留', () => {
    const groups = groupTestPoints(
      report([point({ id: 'a', dimension: 'exception', title: '超时' })]),
    );
    assert.deepEqual(
      groups.map((g) => g.key),
      DIMENSION_ORDER,
    );
    assert.deepEqual(
      groups.map((g) => g.points.length),
      [0, 0, 1, 0, 0],
    );
    assert.equal(groups[0]!.label, DIMENSION_META.functional.label);
  });

  it('维度内按 P0 → P3 排序，同优先级按标题', () => {
    const groups = groupTestPoints(
      report([
        point({ id: 'c', priority: 'P2', title: 'b' }),
        point({ id: 'a', priority: 'P0', title: 'z' }),
        point({ id: 'b', priority: 'P0', title: 'a' }),
      ]),
    );
    const functional = groups.find((g) => g.key === 'functional');
    assert.deepEqual(
      functional?.points.map((p) => p.id),
      ['b', 'a', 'c'],
    );
  });

  it('没有报告时也返回五个空维度', () => {
    assert.equal(groupTestPoints(null).length, 5);
  });
});

describe('countTestPoints', () => {
  it('统计总数、优先级分布与覆盖维度数', () => {
    const stats = countTestPoints(
      report([
        point({ id: 'a', priority: 'P0', dimension: 'functional' }),
        point({ id: 'b', priority: 'P0', dimension: 'boundary' }),
        point({ id: 'c', priority: 'P3', dimension: 'boundary' }),
      ]),
    );
    assert.equal(stats.total, 3);
    assert.equal(stats.byPriority.P0, 2);
    assert.equal(stats.byPriority.P1, 0);
    assert.equal(stats.byPriority.P3, 1);
    assert.equal(stats.coveredDimensions, 2);
  });

  it('空报告全部为 0', () => {
    const stats = countTestPoints(null);
    assert.equal(stats.total, 0);
    assert.equal(stats.coveredDimensions, 0);
  });
});

describe('sortTestPoints', () => {
  it('维度优先、再按优先级', () => {
    const sorted = sortTestPoints([
      point({ id: 'nf', dimension: 'nonfunctional', priority: 'P0' }),
      point({ id: 'ex', dimension: 'exception', priority: 'P3' }),
      point({ id: 'fn', dimension: 'functional', priority: 'P2' }),
    ]);
    assert.deepEqual(
      sorted.map((p) => p.id),
      ['fn', 'ex', 'nf'],
    );
  });
});

describe('groupTestPointsByStory', () => {
  it('按故事顺序分组，组内 P0 优先，未归属的点排最后', () => {
    const groups = groupTestPointsByStory(
      doc({
        stories: [
          ...doc().stories,
          {
            ...doc().stories[0]!,
            id: 'US-002',
            title: '核销优惠券',
          },
        ],
        testPoints: report([
          point({ id: 'g1', storyId: '', title: '全局校验' }),
          point({ id: 'b1', storyId: 'US-002', priority: 'P2', title: '过期不可用' }),
          point({ id: 'a1', storyId: 'US-001', priority: 'P3', title: '低优先' }),
          point({ id: 'a2', storyId: 'US-001', priority: 'P0', title: '高优先' }),
        ]),
      }),
    );
    assert.deepEqual(
      groups.map((g) => g.key),
      ['US-001', 'US-002', 'global'],
    );
    assert.deepEqual(
      groups[0]!.points.map((p) => p.id),
      ['a2', 'a1'],
    );
    assert.equal(groups[2]!.label, '全局测试点');
  });
});

describe('buildXMindContent', () => {
  const content = buildXMindContent(
    doc({
      testPoints: report([
        point({
          id: 'TP-001',
          storyId: 'US-001',
          dimension: 'boundary',
          priority: 'P0',
          title: '金额为 0 时不可提交',
          precondition: '已登录',
          steps: ['进入下单页', '金额填 0', '点提交'],
          expected: '提交按钮置灰',
        }),
      ]),
    }),
  ) as Array<Record<string, unknown>>;

  it('顶层是一张 sheet，根节点用分析标题', () => {
    assert.equal(content.length, 1);
    const sheet = content[0]!;
    assert.equal(sheet.class, 'sheet');
    const root = sheet.rootTopic as Record<string, unknown>;
    assert.match(String(root.title), /测试点 · 优惠券中心/);
  });

  it('根节点用逻辑图骨架，一级子节点是功能 / 用户故事', () => {
    const root = content[0]!.rootTopic as {
      structureClass: string;
      children: { attached: Array<Record<string, unknown>> };
    };
    assert.equal(root.structureClass, 'org.xmind.ui.logic.right');
    const features = root.children.attached;
    assert.equal(features.length, 1);
    assert.match(String(features[0]!.title), /^US-001 领取优惠券（1）$/);
    assert.match(
      (features[0]!.notes as { plain: { content: string } }).plain.content,
      /测试点 1 条 · 维度覆盖 1\/5/,
    );
  });

  it('功能节点下挂对应测试点，带优先级 marker 与备注', () => {
    const root = content[0]!.rootTopic as {
      children: { attached: Array<Record<string, unknown>> };
    };
    const feature = root.children.attached[0] as {
      children: { attached: Array<Record<string, unknown>> };
    };
    const leaf = feature.children.attached[0] as {
      title: string;
      labels: string[];
      markers: Array<{ markerId: string }>;
      notes: { plain: { content: string } };
    };
    assert.match(leaf.title, /^\[P0\] 金额为 0 时不可提交$/);
    assert.deepEqual(leaf.labels, ['边界值', 'P0']);
    assert.equal(leaf.markers[0]!.markerId, 'priority-1');
    assert.match(leaf.notes.plain.content, /预期：提交按钮置灰/);
  });

  it('没有归属故事的测试点落在「全局测试点」，没有测试点时只有功能骨架', () => {
    const global = buildXMindContent(
      doc({ testPoints: report([point({ id: 'TP-009', storyId: '', title: '通用校验' })]) }),
    ) as Array<{ rootTopic: { children: { attached: Array<{ title: string }> } } }>;
    assert.deepEqual(
      global[0]!.rootTopic.children.attached.map((f) => f.title),
      ['全局测试点（1）'],
    );

    const empty = buildXMindContent(doc()) as Array<{
      rootTopic: { children: { attached: Array<{ title: string }> } };
    }>;
    assert.equal(empty[0]!.rootTopic.children.attached.length, 0);
  });
});

describe('testPointsToMarkdown', () => {
  it('按功能分节，带优先级与所属维度', () => {
    const md = testPointsToMarkdown(
      doc({
        testPoints: report([
          point({
            id: 'TP-001',
            storyId: 'US-001',
            dimension: 'functional',
            priority: 'P0',
            title: '正常领券',
            steps: ['打开活动页', '点领取'],
            expected: '券到账',
          }),
        ]),
      }),
    );
    assert.match(md, /# 测试点 · 优惠券中心/);
    // 一级小节是功能（用户故事），不再是五个维度
    assert.match(md, /## US-001 领取优惠券（1）/);
    assert.doesNotMatch(md, /^## 功能$/m);
    assert.match(md, /\*\*\[P0\]\*\* 正常领券 · 功能/);
    assert.match(md, /前置：|步骤：打开活动页；点领取/);
    assert.match(md, /预期：券到账/);
  });

  it('无归属测试点落到「全局测试点」小节', () => {
    const md = testPointsToMarkdown(
      doc({
        testPoints: report([
          point({ id: 'TP-009', storyId: '', dimension: 'exception', title: '接口超时' }),
        ]),
      }),
    );
    assert.match(md, /## 全局测试点（1）/);
  });

  it('没有测试点时给出提示', () => {
    assert.match(testPointsToMarkdown(doc()), /还没有生成测试点/);
  });
});
