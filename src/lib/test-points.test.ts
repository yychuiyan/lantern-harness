import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReqAnalysisDoc } from './req-analysis';
import {
  DIMENSION_META,
  DIMENSION_ORDER,
  XMIND_REQ_STRUCTURE,
  buildXMindContent,
  countTestPoints,
  groupTestPoints,
  groupTestPointsByRequirement,
  groupTestPointsByStory,
  orderTestPointsForCaseGen,
  sortTestPoints,
  testPointsToPromptBlock,
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

describe('orderTestPointsForCaseGen / testPointsToPromptBlock', () => {
  it('按用户故事顺序排列，不按维度重排', () => {
    const ordered = orderTestPointsForCaseGen(
      [
        point({ id: 'TP-010', storyId: 'US-002', dimension: 'functional', title: '后' }),
        point({ id: 'TP-001', storyId: 'US-001', dimension: 'exception', title: '先' }),
        point({ id: 'TP-002', storyId: 'US-001', dimension: 'functional', title: '中' }),
      ],
      ['US-001', 'US-002'],
    );
    assert.deepEqual(
      ordered.map((p) => p.id),
      ['TP-001', 'TP-002', 'TP-010'],
    );
    const block = testPointsToPromptBlock(ordered, ['US-001', 'US-002']);
    assert.ok(block.indexOf('US-001') < block.indexOf('US-002'));
    assert.ok(block.indexOf('TP-001') < block.indexOf('TP-010'));
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

  it('单条需求时根就是「标题（N）」，一级五维（图2）', () => {
    assert.equal(content.length, 1);
    const sheet = content[0]!;
    assert.equal(sheet.class, 'sheet');
    assert.equal(String(sheet.title), '领取优惠券');
    const root = sheet.rootTopic as {
      title: string;
      structureClass: string;
      children: { attached: Array<Record<string, unknown>> };
    };
    assert.equal(root.title, '领取优惠券（1）');
    assert.equal(root.structureClass, XMIND_REQ_STRUCTURE);
    assert.equal(
      (root as { style?: { properties?: Record<string, string> } }).style?.properties?.[
        'shape-class'
      ],
      'org.xmind.topicShape.roundedRect',
    );
    assert.equal(
      (sheet as { theme?: { mainTopic?: { properties?: Record<string, string> } } }).theme
        ?.mainTopic?.properties?.['line-class'],
      'org.xmind.branchConnection.elbow',
    );
    assert.deepEqual(
      root.children.attached.map((d) => String(d.title)),
      ['功能（0）', '边界值（1）', '异常（0）', '业务规则（0）', '非功能（0）'],
    );
    const boundary = root.children.attached[1] as {
      structureClass?: string;
      style?: { properties?: Record<string, string> };
    };
    assert.equal(boundary.structureClass, XMIND_REQ_STRUCTURE);
    assert.equal(boundary.style?.properties?.['svg:fill'], '#ffffff');
  });

  it('Ideal 多行时单画布：根是文档名，一级是各需求（N）', () => {
    const withIdeal = buildXMindContent(
      doc({
        stories: [
          {
            id: 'US-001',
            title: '知识库团队查看政企通页面树',
            role: '',
            goal: '',
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
          {
            id: 'US-010',
            title: '按权限查询政企通信息管理列表',
            role: '',
            goal: '',
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
        testPoints: report([
          point({ id: 'a', storyId: 'US-001', dimension: 'functional', title: '树' }),
          point({ id: 'b', storyId: 'US-010', dimension: 'functional', title: '列表' }),
        ]),
      }),
      ['政企通页面管理', '政企通信息管理'],
    ) as Array<{
      title: string;
      rootTopic: {
        title: string;
        structureClass: string;
        children: { attached: Array<{ title: string; children: { attached: unknown[] } }> };
      };
    }>;
    assert.equal(withIdeal.length, 1);
    assert.equal(withIdeal[0]!.title, '优惠券.md');
    assert.equal(withIdeal[0]!.rootTopic.title, '优惠券.md');
    assert.equal(withIdeal[0]!.rootTopic.structureClass, XMIND_REQ_STRUCTURE);
    const reqs = withIdeal[0]!.rootTopic.children.attached;
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0]!.title, '政企通页面管理（1）');
    assert.equal(reqs[1]!.title, '政企通信息管理（1）');
    assert.equal(reqs[0]!.children.attached.length, 5);
  });

  it('维度节点下挂对应测试点，带优先级 marker 与备注', () => {
    const root = content[0]!.rootTopic as {
      children: { attached: Array<Record<string, unknown>> };
    };
    const boundary = root.children.attached[1] as {
      children: { attached: Array<Record<string, unknown>> };
    };
    const leaf = boundary.children.attached[0] as {
      title: string;
      style?: unknown;
      labels: string[];
      markers: Array<{ markerId: string }>;
      notes: { plain: { content: string } };
    };
    assert.match(leaf.title, /^\[P0\] 金额为 0 时不可提交$/);
    assert.equal(leaf.style, undefined);
    assert.deepEqual(leaf.labels, ['边界值']);
    assert.equal(leaf.markers[0]!.markerId, 'priority-1');
    assert.match(leaf.notes.plain.content, /预期：提交按钮置灰/);
  });

  it('节点 id 全 workbook 唯一（避免 XMind 报损坏）', () => {
    const sheets = buildXMindContent(
      doc({
        stories: [
          {
            id: 'US-001',
            title: '知识库团队查看政企通页面树',
            role: '',
            goal: '',
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
          {
            id: 'US-010',
            title: '按权限查询政企通信息管理列表',
            role: '',
            goal: '',
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
        testPoints: report([
          point({ id: 'a', storyId: 'US-001', dimension: 'functional', title: '树' }),
          point({ id: 'b', storyId: 'US-010', dimension: 'boundary', title: '列表' }),
        ]),
      }),
      ['政企通页面管理', '政企通信息管理'],
    ) as Array<{ id: string; rootTopic: Record<string, unknown> }>;

    const ids: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (typeof obj.id === 'string') ids.push(obj.id);
      for (const [key, value] of Object.entries(obj)) {
        // style.id 按填充色复用，不算主题撞号
        if (key === 'style') continue;
        if (Array.isArray(value)) value.forEach(walk);
        else walk(value);
      }
    };
    walk(sheets);
    assert.equal(ids.length, new Set(ids).size, `撞 id：${ids.join(', ')}`);
  });

  it('没有测试点时仍有一张空骨架 sheet', () => {
    const empty = buildXMindContent(doc()) as Array<{
      rootTopic: { title: string; children: { attached: Array<{ title: string }> } };
    }>;
    assert.equal(empty.length, 1);
    assert.equal(empty[0]!.rootTopic.title, '优惠券.md（0）');
    assert.equal(empty[0]!.rootTopic.children.attached.length, 5);
    assert.ok(empty[0]!.rootTopic.children.attached.every((d) => /（0）$/.test(d.title)));
  });
});

describe('groupTestPointsByRequirement', () => {
  it('无 Ideal 标题时按故事标题分，每条下保留五维', () => {
    const groups = groupTestPointsByRequirement(
      doc({
        testPoints: report([
          point({ id: 'a', storyId: 'US-001', dimension: 'functional', title: '主流程' }),
          point({ id: 'b', storyId: 'US-001', dimension: 'exception', title: '失败' }),
          point({ id: 'c', storyId: '', dimension: 'business', title: '全局规则' }),
        ]),
      }),
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0]!.title, '领取优惠券');
    assert.equal(groups[0]!.dimensions.length, 5);
    assert.equal(groups[0]!.dimensions[0]!.points.length, 1);
    assert.equal(groups[0]!.dimensions[2]!.points.length, 1);
    assert.equal(groups[1]!.title, '全局测试点');
    assert.equal(groups[1]!.dimensions[3]!.points[0]!.title, '全局规则');
  });

  it('有 Ideal 行标题时按行归组（关键词匹配）', () => {
    const groups = groupTestPointsByRequirement(
      doc({
        stories: [
          {
            id: 'US-001',
            title: '知识库团队查看政企通页面树',
            role: '',
            goal: '',
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
          {
            id: 'US-010',
            title: '按权限查询政企通信息管理列表',
            role: '',
            goal: '',
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
        testPoints: report([
          point({ id: 'a', storyId: 'US-001', dimension: 'functional', title: '树展示' }),
          point({ id: 'b', storyId: 'US-010', dimension: 'functional', title: '列表查询' }),
        ]),
      }),
      ['政企通页面管理', '政企通信息管理'],
    );
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((g) => g.title),
      ['政企通页面管理', '政企通信息管理'],
    );
  });

  it('Ideal 标题带「 · 区分词」时按基础名仍能归组', () => {
    const story = {
      id: 'US-001',
      title: '创建问卷单选题目',
      role: '',
      goal: '',
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
    } as const;
    const groups = groupTestPointsByRequirement(
      doc({
        stories: [{ ...story }],
        testPoints: report([
          point({ id: 'a', storyId: 'US-001', dimension: 'functional', title: '加选项' }),
        ]),
      }),
      ['创建问卷 · 单选', '创建问卷 · 多选'],
    );
    assert.equal(groups[0]!.title, '创建问卷 · 单选');
    assert.equal(groups[1]!.title, '创建问卷 · 多选');
    assert.equal(groups[0]!.dimensions[0]!.points[0]!.title, '加选项');
  });
});

describe('testPointsToMarkdown', () => {
  it('按需求标题分节，节内再按五维', () => {
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
    assert.match(md, /^# 优惠券\.md$/m);
    assert.match(md, /## 领取优惠券 · 1 条/);
    assert.match(md, /### 功能（1）/);
    assert.match(md, /\*\*\[P0\]\*\* 正常领券/);
    assert.match(md, /步骤：打开活动页；点领取/);
    assert.match(md, /预期：券到账/);
  });

  it('无故事归属的点归入全局测试点', () => {
    const md = testPointsToMarkdown(
      doc({
        testPoints: report([
          point({ id: 'TP-009', storyId: '', dimension: 'exception', title: '接口超时' }),
        ]),
      }),
    );
    assert.match(md, /## 全局测试点/);
    assert.match(md, /### 异常（1）/);
    assert.match(md, /接口超时/);
  });

  it('没有测试点时给出提示', () => {
    assert.match(testPointsToMarkdown(doc()), /还没有生成测试点/);
  });
});
