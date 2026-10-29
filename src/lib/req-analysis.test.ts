/**
 * 需求分析纯函数回归：
 * 1. `auditStories`：覆盖率按 sourceRefs 集合算，缺字段 / 缺异常 / 维度缺失都要报；
 * 2. `mergeStories`：分批合并按「id → 标题 + 主流程首步」去重，不覆盖用户改过的内容；
 * 3. `toMarkdown` / `parseReqSections` / `splitRequirementSections`：导出与分批的可预期行为。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  auditStories,
  extractDocOutlineEntries,
  extractIdealRequirementTitles,
  extractIdealSmallModules,
  extractMarkdownSectionTitles,
  extractReqSectionOrder,
  formatIdealSmallModuleOrderBlock,
  formatReqSectionOrderBlock,
  inferRequirementName,
  expandQuoteInParentBody,
  fillMissingSourceRefs,
  filterIgnoredFromGaps,
  formatAuditHistoryForPrompt,
  formatOutlinePointsForTestPoints,
  formatPriorMemoryForPrompt,
  gapsLikelySame,
  batchOutlineForStoryGen,
  buildPriorOutlineIndex,
  compareReqVersionTuples,
  groupOutlineParents,
  insertOutlineAfter,
  listPriorReqAnalyses,
  reqProductFamilyKey,
  reqVersionTuple,
  retrievePriorOutlineHits,
  mergeStories,
  outlinePointExcerpt,
  parseReqSections,
  reconcileAuditGaps,
  remapOutlineRefs,
  removeOutlinePoint,
  reqNameFromFileName,
  reqSourceFileName,
  reqTitleLooksLikeFileName,
  seedOutlineFromDoc,
  sortPointsByParentBody,
  sortStoriesByOutlineDocOrder,
  splitRequirementSections,
  storiesToMarkdown,
  storyCompletenessHints,
  toMarkdown,
  uncoveredOutlineItems,
  updateOutlinePointText,
  type ReqAnalysisDoc,
  type ReqGap,
  type ReqIgnoredGap,
  type ReqOutlineItem,
  type ReqStory,
} from './req-analysis';

function gap(partial: Partial<ReqGap> & { id: string; title: string }): ReqGap {
  return {
    storyId: 'US-001',
    type: 'pending-confirm',
    severity: 'medium',
    detail: '',
    suggestion: '',
    origin: 'model',
    selected: false,
    ...partial,
  };
}

function outline(id: string, title: string): ReqOutlineItem {
  return { id, title, quote: `${title} 的原文摘录` };
}

function story(partial: Partial<ReqStory> & { title: string }): ReqStory {
  const { title, ...rest } = partial;
  return {
    id: 'US-001',
    title,
    role: '运营',
    goal: '完成目标',
    value: '',
    sourceRefs: ['RO-1-1'],
    priority: 'P1',
    preconditions: ['已登录'],
    mainFlow: [{ action: '打开页面', result: '看到列表' }],
    altFlows: [],
    exceptions: [],
    postconditions: ['记录已保存'],
    acceptance: [{ given: '已登录', when: '提交', then: '提示成功' }],
    dimensions: [],
    ...rest,
  };
}

function doc(partial: Partial<ReqAnalysisDoc> = {}): ReqAnalysisDoc {
  return {
    id: 'ra_x',
    title: '测试需求',
    sourcePath: 'demo.md',
    sourceTitle: 'demo',
    sourceHash: 'abc',
    status: 'decomposed',
    outline: [outline('RO-1-1', '提交申请')],
    stories: [],
    check: null,
    testPoints: null,
    progress: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('auditStories', () => {
  it('未引用的需求点进待确认缺口，覆盖率按条目计算', () => {
    const report = auditStories({
      outline: [outline('RO-1-1', '提交申请'), outline('RO-1-2', '审批')],
      stories: [story({ title: '提交申请' })],
    });
    assert.equal(report.coverage.total, 2);
    assert.equal(report.coverage.covered, 1);
    assert.equal(report.coverage.rate, 0.5);
    const uncovered = report.gaps.filter((gap) => gap.type === 'uncovered-outline');
    assert.equal(uncovered.length, 1);
    assert.match(uncovered[0]!.title, /审批/);
    assert.equal(uncovered[0]!.outlineId, 'RO-1-2');
  });

  it('字段缺失不进主缺口，由 storyCompletenessHints 提示', () => {
    const incomplete = story({
      id: 'US-007',
      title: '提交申请',
      role: '',
      exceptions: [],
      acceptance: [],
    });
    const report = auditStories(
      doc({
        stories: [incomplete],
      }),
    );
    assert.ok(!report.gaps.some((gap) => gap.type === 'missing-field'));
    assert.ok(!report.gaps.some((gap) => gap.type === 'missing-scenario'));
    const hints = storyCompletenessHints(incomplete);
    assert.ok(hints.some((h) => h.key === 'role'));
    assert.ok(hints.some((h) => h.key === 'exceptions'));
    assert.ok(hints.some((h) => h.key === 'acceptance'));
  });

  it('维度矩阵仍计算，但不硬报维度缺口', () => {
    const report = auditStories({
      outline: [outline('RO-1-1', '提交申请')],
      stories: [story({ title: '提交申请' })],
    });
    assert.equal(report.gaps.filter((gap) => gap.type === 'missing-dimension').length, 0);
    assert.equal(report.dimensions.find((dim) => dim.key === 'permission')?.covered, true);
  });

  it('有查改子点时覆盖率只计子点', () => {
    const report = auditStories({
      outline: [
        { id: 'RO-E-1', title: '申请', quote: '申请原文', body: '申请原文' },
        {
          id: 'RO-1-1',
          title: '申请查询',
          quote: '',
          kind: 'query',
          parentId: 'RO-E-1',
        },
        {
          id: 'RO-1-2',
          title: '申请修改',
          quote: '',
          kind: 'mutate',
          parentId: 'RO-E-1',
        },
      ],
      stories: [story({ title: '查询申请', sourceRefs: ['RO-1-1'] })],
    });
    assert.equal(report.coverage.total, 2);
    assert.equal(report.coverage.covered, 1);
    assert.equal(report.gaps.filter((g) => g.type === 'uncovered-outline').length, 1);
  });
});

describe('mergeStories', () => {
  it('同一标题 + 同一主流程首步只保留一条', () => {
    const existing = [story({ id: 'US-001', title: '提交申请' })];
    const merged = mergeStories(existing, [
      story({ id: '', title: '提交申请', role: '', sourceRefs: ['RO-1-2'] }),
    ]);
    assert.equal(merged.length, 1);
    // 已填的角色不被空值覆盖，sourceRefs 取并集
    assert.equal(merged[0]!.role, '运营');
    assert.deepEqual(merged[0]!.sourceRefs, ['RO-1-1', 'RO-1-2']);
  });

  it('带已存在 id 的故事原地更新，不产生重复', () => {
    const existing = [story({ id: 'US-003', title: '提交申请' })];
    const merged = mergeStories(existing, [
      story({
        id: 'US-003',
        title: '提交申请（改）',
        exceptions: [{ scenario: '超时', expected: '提示' }],
      }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.id, 'US-003');
    assert.equal(merged[0]!.title, '提交申请');
    assert.equal(merged[0]!.exceptions.length, 1);
  });

  it('新故事保留空 id，等待服务端分配', () => {
    const merged = mergeStories([], [story({ id: '', title: '新故事' })]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.id, '');
  });
});

describe('uncoveredOutlineItems / batchOutlineForStoryGen', () => {
  const outline: ReqOutlineItem[] = [
    { id: 'RO-E-1', title: 'A', quote: '', body: '甲乙' },
    { id: 'RO-E-1-1', title: '甲', quote: '甲', kind: 'query', parentId: 'RO-E-1' },
    { id: 'RO-E-1-2', title: '乙', quote: '乙', kind: 'mutate', parentId: 'RO-E-1' },
    { id: 'RO-E-2', title: 'B', quote: '', body: '丙' },
    { id: 'RO-E-2-1', title: '丙', quote: '丙', kind: 'query', parentId: 'RO-E-2' },
  ];

  it('未挂上的覆盖目标', () => {
    const stories = [story({ id: 'US-001', title: '甲', sourceRefs: ['RO-E-1-1'] })];
    assert.deepEqual(
      uncoveredOutlineItems(outline, stories).map((i) => i.id),
      ['RO-E-1-2', 'RO-E-2-1'],
    );
  });

  it('全挂上时为空', () => {
    const stories = [
      story({ id: 'US-001', title: '甲', sourceRefs: ['RO-E-1-1', 'RO-E-1-2'] }),
      story({ id: 'US-002', title: '丙', sourceRefs: ['RO-E-2-1'] }),
    ];
    assert.equal(uncoveredOutlineItems(outline, stories).length, 0);
  });

  it('按父级切批，超限再切开', () => {
    const batches = batchOutlineForStoryGen(outline, 2);
    assert.equal(batches.length, 2);
    assert.equal(batches[0]!.parent?.id, 'RO-E-1');
    assert.deepEqual(
      batches[0]!.mustCover.map((i) => i.id),
      ['RO-E-1-1', 'RO-E-1-2'],
    );
    assert.equal(batches[1]!.parent?.id, 'RO-E-2');
    assert.deepEqual(
      batches[1]!.mustCover.map((i) => i.id),
      ['RO-E-2-1'],
    );

    const manyKids: ReqOutlineItem[] = [
      { id: 'RO-E-9', title: 'P', quote: '', body: 'x' },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `RO-E-9-${i + 1}`,
        title: `k${i + 1}`,
        quote: `k${i + 1}`,
        kind: 'query' as const,
        parentId: 'RO-E-9',
      })),
    ];
    const split = batchOutlineForStoryGen(manyKids, 2);
    assert.equal(split.length, 3);
    assert.equal(split[0]!.mustCover.length, 2);
    assert.equal(split[2]!.mustCover.length, 1);
  });
});

describe('fillMissingSourceRefs', () => {
  const points: ReqOutlineItem[] = [
    { id: 'RO-E-1', title: '政企通', quote: '' },
    {
      id: 'RO-1-1',
      title: '政企通菜单入口与角色数据范围',
      quote: '',
      kind: 'query',
      parentId: 'RO-E-1',
    },
    {
      id: 'RO-1-2',
      title: '政企通页面管理树状展示与开通状态标识',
      quote: '',
      kind: 'query',
      parentId: 'RO-E-1',
    },
  ];

  it('空 refs 按标题挂到查改子点', () => {
    const { stories, filled } = fillMissingSourceRefs(
      [
        story({
          id: 'US-001',
          title: '按角色查看政企通菜单与数据范围',
          sourceRefs: [],
        }),
      ],
      points,
    );
    assert.equal(filled, 1);
    assert.deepEqual(stories[0]!.sourceRefs, ['RO-1-1']);
  });

  it('已有 refs 不被覆盖', () => {
    const { stories, filled } = fillMissingSourceRefs(
      [story({ id: 'US-001', title: '按角色查看政企通菜单与数据范围', sourceRefs: ['RO-1-2'] })],
      points,
    );
    assert.equal(filled, 0);
    assert.deepEqual(stories[0]!.sourceRefs, ['RO-1-2']);
  });

  it('一对一不重复占用', () => {
    const { stories, filled } = fillMissingSourceRefs(
      [
        story({
          id: 'US-001',
          title: '按角色查看政企通菜单与数据范围',
          sourceRefs: [],
        }),
        story({
          id: 'US-002',
          title: '树状展示政企通页面节点与开通状态',
          sourceRefs: [],
        }),
      ],
      points,
    );
    assert.equal(filled, 2);
    assert.deepEqual(stories[0]!.sourceRefs, ['RO-1-1']);
    assert.deepEqual(stories[1]!.sourceRefs, ['RO-1-2']);
  });
});

describe('toMarkdown', () => {
  it('包含需求条目、故事七段与审查摘要', () => {
    const target = doc({
      stories: [story({ title: '提交申请' })],
      check: auditStories({
        outline: [outline('RO-1-1', '提交申请')],
        stories: [story({ title: '提交申请' })],
      }),
    });
    const md = toMarkdown(target);
    assert.match(md, /## 需求条目/);
    assert.match(md, /### US-001 提交申请/);
    assert.match(md, /\*\*前置条件\*\*/);
    assert.match(md, /\*\*验收标准\*\*/);
    assert.match(md, /Given 已登录；When 提交；Then 提示成功/);
    assert.match(md, /## 审查摘要/);
    assert.match(md, /覆盖率：1\/1（100%）/);
  });
});

describe('storiesToMarkdown', () => {
  const target = doc({
    title: '订单需求',
    outline: [outline('RO-1-1', '提交申请'), outline('RO-1-2', '审批')],
    stories: [
      story({ id: 'US-001', title: '提交申请' }),
      story({ id: 'US-002', title: '审批通过', sourceRefs: ['RO-1-2'] }),
    ],
  });

  it('不传 ids 时导出整份分析的全部故事', () => {
    const md = storiesToMarkdown(target);
    assert.match(md, /# 订单需求 · 用户故事/);
    assert.match(md, /### US-001 提交申请/);
    assert.match(md, /### US-002 审批通过/);
    assert.match(md, /## 需求条目/);
    assert.match(md, /\*\*验收标准\*\*/);
  });

  it('传 ids 时只带选中故事，条目照常给出上下文', () => {
    const md = storiesToMarkdown(target, ['US-002']);
    assert.equal(md.includes('### US-001 提交申请'), false);
    assert.match(md, /### US-002 审批通过/);
    assert.match(md, /RO-1-1/);
  });

  it('没有故事时给占位，不抛错', () => {
    const empty = doc({ stories: [], outline: [] });
    const md = storiesToMarkdown(empty);
    assert.match(md, /用户故事/);
    assert.match(md, /（暂无）/);
  });
});

describe('parseReqSections', () => {
  it('旧「## 拆解」整段复用到拆解需求与生成用户故事', () => {
    const sections = parseReqSections(`# 标题

> 引用

## 拆解

拆解规则

## 体检

体检规则

## 补写

补写规则
`);
    assert.equal(sections.decompose.trim(), '拆解规则');
    assert.equal(sections.stories.trim(), '拆解规则');
    assert.equal(sections.audit.trim(), '体检规则');
    assert.equal(sections.fix.trim(), '补写规则');
  });

  it('新模板两段：拆解需求 / 生成用户故事', () => {
    const sections = parseReqSections(`## 拆解需求

整理子点

## 生成用户故事

写故事
`);
    assert.equal(sections.decompose.trim(), '整理子点');
    assert.equal(sections.stories.trim(), '写故事');
  });

  it('缺段时返回空串', () => {
    const sections = parseReqSections('## 拆解\n\n只有拆解');
    assert.equal(sections.audit, '');
    assert.equal(sections.fix, '');
    assert.equal(sections.stories.trim(), '只有拆解');
  });
});

describe('inferRequirementName', () => {
  it('优先取 Markdown 一级标题', () => {
    assert.equal(inferRequirementName('# 政企通\n\n正文', 'ignore.md'), '政企通');
  });

  it('识别「需求名称」标签', () => {
    assert.equal(inferRequirementName('需求名称：市民热线\n\n后文', 'x.md'), '市民热线');
  });

  it('Ideal 表取大模块众数，而不是文件名', () => {
    const csv = [
      '大模块,小模块,优化/问题内容',
      '政企通,政企通,【政企通】新开菜单',
      '政企通,政企通页面管理,【政企通页面管理】树状展示',
      '政企通,政企通信息管理,查询修改',
    ].join('\n');
    assert.equal(inferRequirementName(csv, '政企通v1.16.0版本_需求文档.xlsx'), '政企通');
  });

  it('无结构时用文首短【名称】', () => {
    assert.equal(
      inferRequirementName('【政企通】\n新开菜单\n【政企通页面管理】细节', 'file.xlsx'),
      '政企通',
    );
  });

  it('正文空时回落到清理后的文件名', () => {
    assert.equal(reqNameFromFileName('政企通v1.16.0版本_需求文档.xlsx'), '政企通v1.16.0版本');
    assert.equal(inferRequirementName('', '政企通v1.16.0版本_需求文档.xlsx'), '政企通v1.16.0版本');
  });

  it('能判断标题是否仍是文件名', () => {
    assert.equal(
      reqTitleLooksLikeFileName('政企通v1.16.0版本_需求文档', 'a/政企通v1.16.0版本_需求文档.xlsx'),
      true,
    );
    assert.equal(reqTitleLooksLikeFileName('政企通', 'a/政企通v1.16.0版本_需求文档.xlsx'), false);
  });

  it('产品族与版本解析、历史分析排序', () => {
    assert.equal(reqProductFamilyKey('政企通v1.16.0版本_需求文档.xlsx'), '政企通');
    assert.equal(reqProductFamilyKey('政企通v1.17.0迭代版本'), '政企通');
    assert.deepEqual(reqVersionTuple('政企通v1.16.0版本'), [1, 16, 0]);
    assert.ok(compareReqVersionTuples([1, 16, 0], [1, 17, 0]) < 0);
    const docs: ReqAnalysisDoc[] = [
      {
        id: 'ra-16',
        title: '政企通v1.16.0',
        sourcePath: 'a/政企通v1.16.0版本_需求文档.xlsx',
        sourceTitle: '政企通v1.16.0版本_需求文档.xlsx',
        sourceHash: '',
        status: 'decomposed',
        outline: [],
        stories: [],
        check: null,
        testPoints: null,
        progress: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'ra-15',
        title: '政企通v1.15.0',
        sourcePath: 'a/政企通v1.15.0版本_需求文档.xlsx',
        sourceTitle: '政企通v1.15.0版本_需求文档.xlsx',
        sourceHash: '',
        status: 'decomposed',
        outline: [],
        stories: [],
        check: null,
        testPoints: null,
        progress: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'ra-other',
        title: '市民热线v2.0',
        sourcePath: 'a/市民热线v2.0.xlsx',
        sourceTitle: '市民热线v2.0.xlsx',
        sourceHash: '',
        status: 'decomposed',
        outline: [],
        stories: [],
        check: null,
        testPoints: null,
        progress: null,
        createdAt: '',
        updatedAt: '',
      },
    ];
    const current = {
      id: 'ra-17',
      title: '政企通v1.17.0',
      sourcePath: 'a/政企通v1.17.0版本_需求文档.xlsx',
      sourceTitle: '政企通v1.17.0版本_需求文档.xlsx',
    };
    assert.deepEqual(
      listPriorReqAnalyses(current, docs).map((d) => d.id),
      ['ra-15', 'ra-16'],
    );
  });

  it('历史条目检索命中与 prompt 格式', () => {
    const docs: ReqAnalysisDoc[] = [
      {
        id: 'ra-16',
        title: '政企通v1.16.0',
        sourcePath: 'a/x.xlsx',
        sourceTitle: '政企通v1.16.0版本_需求文档.xlsx',
        sourceHash: '',
        status: 'decomposed',
        outline: [
          { id: 'RO-E-1', title: '审核', quote: '', body: '审核页' },
          {
            id: 'RO-E-1-1',
            title: '提交倒计时',
            quote: '提交要有倒计时',
            kind: 'mutate',
            parentId: 'RO-E-1',
          },
          {
            id: 'RO-E-1-2',
            title: '列表筛选',
            quote: '按状态筛选',
            kind: 'query',
            parentId: 'RO-E-1',
          },
        ],
        stories: [],
        check: null,
        testPoints: null,
        progress: null,
        createdAt: '',
        updatedAt: '',
      },
    ];
    const index = buildPriorOutlineIndex(docs);
    assert.equal(index.length, 2);
    const hits = retrievePriorOutlineHits('页面操作栏提交倒计时控制', index, {
      maxItems: 10,
      maxChars: 4000,
    });
    assert.ok(hits.some((h) => h.point.id === 'RO-E-1-1'));
    const block = formatPriorMemoryForPrompt(hits);
    assert.match(block, /历史迭代需求条目/);
    assert.match(block, /禁止写入本版 sourceRefs/);
    assert.match(block, /RO-E-1-1/);
  });

  it('分析记录展示用需求文档文件名（带扩展名）', () => {
    assert.equal(
      reqSourceFileName({
        title: '政企通',
        sourceTitle: '政企通v1.16.0版本_需求文档.xlsx',
        sourcePath: '上海12345/政企通v1.16.0版本_需求文档.xlsx',
      }),
      '政企通v1.16.0版本_需求文档.xlsx',
    );
  });

  it('Ideal 表按行提取需求标题（一行一条）', () => {
    const csv = [
      '大模块,小模块,优化/问题内容',
      '政企通,政企通,"【政企通】新开菜单"',
      '政企通,政企通页面管理,"【政企通页面管理】树状展示"',
      '政企通,政企通信息管理,"【政企通信息管理】列表"',
      '政企通,知识信息,"【知识信息管理】ai开关"',
    ].join('\n');
    assert.deepEqual(extractIdealRequirementTitles(csv), [
      '政企通',
      '政企通页面管理',
      '政企通信息管理',
      '知识信息管理',
    ]);
  });

  it('Ideal 多行单元格续行并入父级 body（sheet_to_csv 形态）', () => {
    const csv = [
      '大模块,小模块,优化/问题内容',
      '政企通,政企通页面管理,"【政企通页面管理】树状展示',
      '',
      '1、上级节点：显示，不可编辑。',
      '2、本级节点布局：必填',
      '3、节点标题：输入框，必填，max=50字',
      '4、描述：简易富文本，选填',
      '5、图标：单张上传，选填',
      '6、背景图：单张上传，选填"',
      '政企通,政企通信息管理,"【政企通信息管理】列表"',
    ].join('\n');
    const entries = extractDocOutlineEntries(csv);
    const page = entries.find((e) => e.title === '政企通页面管理');
    assert.ok(page);
    assert.match(page!.body, /4、描述/);
    assert.match(page!.body, /6、背景图/);
    const seeded = seedOutlineFromDoc(csv, []);
    const parent = seeded.find((x) => x.title === '政企通页面管理' && !x.kind);
    assert.ok(parent);
    assert.match(parent!.body || '', /4、描述/);
  });

  it('Ideal 正文不带提出人/日期/状态等其它表格列', () => {
    const csv = [
      '大模块,小模块,优化/问题内容,截图1,截图2,截图3,提出人,提出日期,类型,优先级,解决人,当前状态,版本',
      '政企通,政企通信息管理,"【政企通信息管理】查询、修改',
      '3、提交：',
      '（1）直接引用…审核通过；',
      '（2）节选内容…待确认；',
      '4、操作记录：需要正洋完善字段。" ,,,,于赟,2026年9月20日,需求,高,"李正洋,余雷",待开发,v1.16.0,',
    ].join('\n');
    const entries = extractDocOutlineEntries(csv);
    const hit = entries.find((e) => e.title === '政企通信息管理');
    assert.ok(hit);
    assert.match(hit!.body, /4、操作记录/);
    assert.equal(/于赟|待开发|v1\.16\.0|李正洋/.test(hit!.body), false);
  });

  it('Ideal 同一小模块下多行：一行一条，标题按正文区分不合并', () => {
    // 真实需求表常见形态：小模块相同、每行是一条独立需求（单选 / 多选 / 填空…）
    const csv = [
      '大模块,小模块,优化/问题内容',
      '调查问卷,创建问卷,"【创建问卷】目前仅提供pc端进行采编。',
      '',
      '1、问卷关联系统：下拉单选框"',
      '调查问卷,创建问卷,"【创建问卷】单选 序号.输入框 ☑ 必答"',
      '调查问卷,创建问卷,"【创建问卷】多选 序号.输入框 ☑ 必答"',
      '调查问卷,创建问卷,"【创建问卷】段落说明 前面不需要显示序号"',
    ].join('\n');
    const entries = extractDocOutlineEntries(csv);
    assert.equal(entries.length, 4);
    assert.deepEqual(
      entries.map((e) => e.title),
      ['创建问卷', '创建问卷 · 单选', '创建问卷 · 多选', '创建问卷 · 段落说明'],
    );
    // 第一行的多行正文完整，没有被后续行截断
    assert.match(entries[0]!.body, /问卷关联系统/);
    // 播种也按这 4 条来，不再只剩 1 条
    const seeded = seedOutlineFromDoc(csv, []);
    assert.equal(seeded.filter((item) => !item.kind).length, 4);
    assert.equal(new Set(seeded.map((item) => item.id)).size, 4);
    // 用例「子模块」仍按小模块去重，不出现重复
    assert.deepEqual(extractIdealSmallModules(csv), ['创建问卷']);
  });

  it('Ideal 小模块列带引号逗号：按整格取值，正文不夹带列尾巴', () => {
    const csv = [
      '大模块,小模块,优化/问题内容',
      '调查问卷,"调查问卷管理,问卷回收列表","【问卷回收列表】弹窗标题：问卷标题"',
      '调查问卷,"调查问卷管理,问卷回收列表,答卷详情","【答卷详情】查看，隐藏的题目不显示。"',
    ].join('\n');
    const entries = extractDocOutlineEntries(csv);
    assert.deepEqual(
      entries.map((e) => e.title),
      ['问卷回收列表', '答卷详情'],
    );
    assert.equal(entries[0]!.body, '【问卷回收列表】弹窗标题：问卷标题');
    assert.deepEqual(extractIdealSmallModules(csv), [
      '调查问卷管理,问卷回收列表',
      '调查问卷管理,问卷回收列表,答卷详情',
    ]);
  });

  it('Markdown 两级标题（Word 文档形态）：只取最深一级，模块标题不播成空需求', () => {
    const md = [
      '# 业务需求描述',
      '## 工单系统',
      '### 后台处理页面新增处理备注栏',
      '1、新增备注列',
      '### 工单处理页面通话录音优化',
      '2、录音支持下载',
      '## 报表系统',
      '### 后台统计报表更新',
      '3、新增字段',
    ].join('\n');
    const entries = extractDocOutlineEntries(md);
    assert.deepEqual(
      entries.map((e) => e.title),
      ['后台处理页面新增处理备注栏', '工单处理页面通话录音优化', '后台统计报表更新'],
    );
    assert.match(entries[0]!.body, /新增备注列/);
    assert.match(entries[2]!.body, /新增字段/);
  });

  it('Markdown 单层标题：仍按 ## 切章节', () => {
    const md = ['# 需求', '## 登录', '密码登录', '## 下单', '提交订单'].join('\n');
    assert.deepEqual(
      extractDocOutlineEntries(md).map((e) => e.title),
      ['登录', '下单'],
    );
  });

  it('Word 表格形态（` | ` 分隔）也按一行一条抽条目', () => {
    const text = [
      '## Sheet1',
      '',
      '大模块 | 小模块 | 优化/问题内容',
      '工单系统 | 后台处理页面 | 【处理备注】新增备注列',
      '工单系统 | 后台处理页面 | 【处理备注】备注必填校验',
      '工单系统 | 通话录音 | 【通话录音】支持下载',
    ].join('\n');
    const entries = extractDocOutlineEntries(text);
    assert.deepEqual(
      entries.map((e) => e.title),
      ['处理备注', '处理备注 · 备注必填校验', '通话录音'],
    );
    assert.equal(entries.length, 3);
  });

  it('Ideal 小模块行序提示块可再解析，首行仍是菜单总览「政企通」', () => {
    const csv = [
      '大模块,小模块,优化/问题内容',
      '政企通,政企通,"【政企通】新开菜单"',
      '政企通,政企通页面管理,"【政企通页面管理】树状展示"',
      '政企通,政企通信息管理,"【政企通信息管理】列表"',
    ].join('\n');
    const block = formatIdealSmallModuleOrderBlock(csv);
    // 口径已改：排序主依据是需求条目（RO）→ 测试点（TP），小模块行序只做兜底
    assert.match(block, /需求条目 → 条目内测试点/);
    assert.deepEqual(extractIdealSmallModules(block), [
      '政企通',
      '政企通页面管理',
      '政企通信息管理',
    ]);
    assert.deepEqual(extractReqSectionOrder(block), extractIdealSmallModules(block));
  });

  it('非 Ideal 需求：按 Markdown 标题抽章节序，提示块可再解析', () => {
    const md = ['# 需求', '## 登录', '说明', '## 下单', '说明', '## 支付', '说明'].join('\n');
    assert.deepEqual(extractMarkdownSectionTitles(md), ['登录', '下单', '支付']);
    assert.deepEqual(extractReqSectionOrder(md), ['登录', '下单', '支付']);
    const block = formatReqSectionOrderBlock(md);
    assert.match(block, /需求章节顺序/);
    assert.deepEqual(extractReqSectionOrder(block), ['登录', '下单', '支付']);
  });
});

describe('splitRequirementSections', () => {
  it('短文档只切一批', () => {
    const chunks = splitRequirementSections('# 需求\n\n一句话需求');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text.includes('一句话需求'), true);
  });

  it('按章节切批且每批不超过上限', () => {
    const body = '这是一段需求描述。'.repeat(300);
    const raw = `## 第一节\n\n${body}\n\n## 第二节\n\n${body}`;
    const chunks = splitRequirementSections(raw, 2000);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 2000, `chunk ${chunk.index} 超长：${chunk.text.length}`);
    }
  });

  it('空文档返回空数组', () => {
    assert.deepEqual(splitRequirementSections('   \n  '), []);
  });
});

describe('gapsLikelySame / reconcileAuditGaps / formatAuditHistoryForPrompt', () => {
  it('同 story+type 下标题包含关系视为同一问题', () => {
    assert.equal(
      gapsLikelySame(
        gap({ id: 'a', title: '页面互锁：锁定对象与时长未写清' }),
        gap({ id: 'b', title: '页面互锁：锁定对象与时长未写清（复审）' }),
      ),
      true,
    );
    assert.equal(
      gapsLikelySame(
        gap({ id: 'a', title: '页面互锁：锁定对象与时长未写清' }),
        gap({ id: 'b', storyId: 'US-002', title: '页面互锁：锁定对象与时长未写清' }),
      ),
      false,
    );
  });

  it('忽略换皮标题后不再进清单', () => {
    const ignored: ReqIgnoredGap[] = [
      {
        ...gap({ id: 'g_old', title: '操作记录：查询字段未定' }),
        ignoredAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const next = [
      gap({ id: 'g_new', title: '操作记录：查询字段未定，需业务确认' }),
      gap({ id: 'g_other', title: '状态机与原文冲突：审核后回待确认' }),
    ];
    const kept = filterIgnoredFromGaps(next, ignored);
    assert.deepEqual(
      kept.map((g) => g.id),
      ['g_other'],
    );
  });

  it('复审合并保留上轮 id、标题、勾选与结论', () => {
    const prev = [
      gap({
        id: 'g_keep',
        title: '倒计时：用途与秒数未写清',
        selected: true,
        conclusion: '3 秒后关页',
        detail: '旧 detail',
      }),
    ];
    const next = [
      gap({
        id: 'g_fresh',
        title: '倒计时：用途与秒数未写清（模型换皮）',
        detail: '新 detail',
        selected: false,
      }),
      gap({ id: 'g_brand', title: '全新问题：导出格式未约定' }),
    ];
    const { gaps: out, suppressed } = reconcileAuditGaps(prev, next, []);
    assert.equal(out.length, 2);
    assert.equal(suppressed, 0);
    const merged = out.find((g) => g.id === 'g_keep');
    assert.ok(merged);
    assert.equal(merged!.title, '倒计时：用途与秒数未写清');
    assert.equal(merged!.selected, true);
    assert.equal(merged!.conclusion, '3 秒后关页');
    assert.equal(merged!.detail, '新 detail');
    assert.ok(out.some((g) => g.id === 'g_brand'));
  });

  it('allowNew:false 丢纯新增，保留上轮匹配与 uncovered-outline', () => {
    const prev = [
      gap({
        id: 'g_keep',
        title: '倒计时：用途与秒数未写清',
        selected: true,
        conclusion: '3 秒后关页',
      }),
      gap({
        id: 'g_sticky',
        title: '状态机回跳未写清',
        detail: '上轮遗留',
      }),
    ];
    const next = [
      gap({
        id: 'g_fresh',
        title: '倒计时：用途与秒数未写清（换皮）',
        detail: '新 detail',
      }),
      gap({ id: 'g_brand', title: '全新问题：导出格式未约定' }),
      gap({
        id: 'g_uncov',
        type: 'uncovered-outline',
        storyId: '',
        outlineId: 'RO-1-1',
        title: '页面管理：还没有用户故事挂上',
        origin: 'rule',
      }),
    ];
    const { gaps: out, suppressed } = reconcileAuditGaps(prev, next, [], { allowNew: false });
    assert.equal(suppressed, 1);
    assert.equal(out.length, 3);
    assert.ok(out.some((g) => g.id === 'g_keep' && g.detail === '新 detail'));
    assert.ok(out.some((g) => g.id === 'g_sticky'));
    assert.ok(out.some((g) => g.id === 'g_uncov'));
    assert.ok(!out.some((g) => g.id === 'g_brand'));
  });

  it('历史提示含待确认结论与已忽略标题', () => {
    const text = formatAuditHistoryForPrompt({
      pending: [
        gap({
          id: 'g1',
          title: '互锁时长',
          detail: '原文没写多久',
          conclusion: '30 分钟自动解锁',
        }),
      ],
      ignored: [
        {
          ...gap({ id: 'g2', title: '操作记录字段' }),
          ignoredAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    assert.match(text, /上轮待确认/);
    assert.match(text, /conclusion: 30 分钟自动解锁/);
    assert.match(text, /已忽略/);
    assert.match(text, /操作记录字段/);
  });
});

describe('outline doc order', () => {
  it('子点按父级原文出现序排序', () => {
    const parent: ReqOutlineItem = {
      id: 'RO-E-1',
      title: '页面管理',
      quote: '',
      body: '先查询树，再修改节点，最后提交状态',
    };
    const points: ReqOutlineItem[] = [
      { id: 'RO-1-2', title: '修改', quote: '再修改节点', kind: 'mutate', parentId: 'RO-E-1' },
      { id: 'RO-1-1', title: '查询', quote: '先查询树', kind: 'query', parentId: 'RO-E-1' },
      { id: 'RO-1-3', title: '提交', quote: '最后提交状态', kind: 'mutate', parentId: 'RO-E-1' },
    ];
    assert.deepEqual(
      sortPointsByParentBody(parent, points).map((p) => p.id),
      ['RO-1-1', 'RO-1-2', 'RO-1-3'],
    );
  });

  it('乱序 id 仍按文档序：开通→预览→排序→添加', () => {
    const parent: ReqOutlineItem = {
      id: 'RO-E-2',
      title: '政企通页面管理',
      quote: '',
      body: [
        '【政企通页面管理】树状展示',
        '头部显示“政企通（未开通）”，未开通三个字为橙色；',
        '热线办点过“确认开通”按钮后，显示“政企通（已开通）”，已开通三个字为绿色。',
        '',
        '页面功能：',
        '前台预览：打开H5手机端竖屏效果。',
        '',
        '节点排序：默认按照录入顺序排序，支持上下移动',
        '',
        '节点操作：添加/添加下级、修改、删除',
      ].join('\n'),
    };
    // 创建顺序刻意打乱：1-3 → 1-5 → 1-4 → 1-6
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-1-3',
        title: '政企通页面管理头部开通状态展示（未开通橙色/已开通绿色）',
        quote:
          '头部显示“政企通（未开通）”，未开通三个字为橙色；\n热线办点过“确认开通”按钮后，显示“政企通（已开通）”，已开通三个字为绿色。',
        kind: 'query',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-5',
        title: '政企通页面管理节点树状展示与默认排序、上下移动',
        quote: '节点排序：默认按照录入顺序排序，支持上下移动',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-4',
        title: '政企通页面管理前台预览（H5手机端竖屏）',
        quote: '前台预览：打开H5手机端竖屏效果。',
        kind: 'query',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-6',
        title: '政企通页面管理节点添加/添加下级',
        quote: '节点操作：添加/添加下级、修改、删除',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
    ];
    assert.deepEqual(
      sortPointsByParentBody(parent, points).map((p) => p.id),
      ['RO-1-3', 'RO-1-4', 'RO-1-5', 'RO-1-6'],
    );
  });

  it('quote 压成一行仍能按原文位置排序（含树状展示类段落）', () => {
    const parent: ReqOutlineItem = {
      id: 'RO-E-2',
      title: '政企通页面管理',
      quote: '',
      body: [
        '【政企通页面管理】树状展示',
        '',
        '头部显示“政企通（未开通）”，未开通三个字为橙色；',
        '热线办点过“确认开通”按钮后，显示“政企通（已开通）”，已开通三个字为绿色。',
        '',
        '页面功能：前台预览：打开H5手机端竖屏效果。',
        '',
        '节点排序：默认按照录入顺序排序，支持上下移动',
        '',
        '节点操作：添加/添加下级、修改、删除',
        '',
        '页面按钮：',
        '1、暂存：',
        '（1）不论谁暂存，再次打开修改页面时均显示暂存的信息；',
      ].join('\n'),
    };
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-1-5',
        title: '排序',
        quote: '节点排序：默认按照录入顺序排序，支持上下移动',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-11',
        title: '暂存',
        quote: '页面按钮：1、暂存：（1）不论谁暂存，再次打开修改页面时均显示暂存的信息；',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-3',
        title: '树状展示与开通状态',
        quote:
          '【政企通页面管理】树状展示 头部显示“政企通（未开通）”，未开通三个字为橙色；热线办点过“确认开通”按钮后，显示“政企通（已开通）”，已开通三个字为绿色。',
        kind: 'query',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-4',
        title: '竖屏预览',
        quote: '页面功能：前台预览：打开H5手机端竖屏效果。',
        kind: 'query',
        parentId: 'RO-E-2',
      },
    ];
    assert.deepEqual(
      sortPointsByParentBody(parent, points).map((p) => p.id),
      ['RO-1-3', 'RO-1-4', 'RO-1-5', 'RO-1-11'],
    );
  });

  it('groupOutlineParents 组内已按原文序', () => {
    const outline: ReqOutlineItem[] = [
      { id: 'RO-E-1', title: '页面管理', quote: '', body: '甲能力；乙能力' },
      { id: 'RO-1-b', title: '乙', quote: '乙能力', kind: 'mutate', parentId: 'RO-E-1' },
      { id: 'RO-1-a', title: '甲', quote: '甲能力', kind: 'query', parentId: 'RO-E-1' },
    ];
    const groups = groupOutlineParents(outline);
    assert.deepEqual(
      groups[0]!.points.map((p) => p.id),
      ['RO-1-a', 'RO-1-b'],
    );
  });

  it('formatOutlinePointsForTestPoints 按条目分组并带短原文', () => {
    const outline: ReqOutlineItem[] = [
      { id: 'RO-E-1', title: '页面管理', quote: '', body: '甲；乙' },
      {
        id: 'RO-E-1-1',
        title: '查看甲',
        quote: '甲短',
        body: '甲完整原文应优先',
        kind: 'query',
        parentId: 'RO-E-1',
      },
      {
        id: 'RO-E-1-2',
        title: '修改乙',
        quote: '乙原文',
        kind: 'mutate',
        parentId: 'RO-E-1',
      },
      { id: 'RO-E-2', title: '空条目', quote: '', body: '无子点' },
    ];
    const text = formatOutlinePointsForTestPoints(outline);
    assert.match(text, /^- RO-E-1 页面管理$/m);
    assert.match(text, /RO-E-1-1 \[查询\] 查看甲/);
    assert.match(text, /原文：甲完整原文应优先/);
    assert.match(text, /RO-E-1-2 \[修改\] 修改乙/);
    assert.match(text, /原文：乙原文/);
    assert.match(text, /^- RO-E-2 空条目$/m);
    assert.match(text, /尚无查\/改子点/);
  });

  it('formatOutlinePointsForTestPoints 空 outline 与超长截断', () => {
    assert.equal(formatOutlinePointsForTestPoints([]), '（无需求点）');
    const longBody = '字'.repeat(800);
    const outline: ReqOutlineItem[] = [
      { id: 'RO-E-1', title: '条目', quote: '', body: 'x' },
      {
        id: 'RO-E-1-1',
        title: '点',
        quote: 'q',
        body: longBody,
        kind: 'query',
        parentId: 'RO-E-1',
      },
    ];
    const clipped = formatOutlinePointsForTestPoints(outline, { excerptMax: 100 });
    assert.match(clipped, /原文：字{100}…/);
    const tight = formatOutlinePointsForTestPoints(outline, {
      excerptMax: 200,
      blockMax: 80,
    });
    assert.ok(tight.length <= 80);
    assert.match(tight, /RO-E-1-1/);
    assert.doesNotMatch(tight, /原文：/);
  });

  it('故事按 sourceRefs 文档序排，无来源靠后', () => {
    const outline: ReqOutlineItem[] = [
      { id: 'RO-E-1', title: 'A', quote: 'A', body: '先甲后乙' },
      { id: 'RO-1-1', title: '甲', quote: '先甲', kind: 'query', parentId: 'RO-E-1' },
      { id: 'RO-1-2', title: '乙', quote: '后乙', kind: 'mutate', parentId: 'RO-E-1' },
    ];
    const stories = [
      story({ id: 'US-002', title: '乙故事', sourceRefs: ['RO-1-2'] }),
      story({ id: 'US-003', title: '无来源', sourceRefs: [] }),
      story({ id: 'US-001', title: '甲故事', sourceRefs: ['RO-1-1'] }),
    ];
    assert.deepEqual(
      sortStoriesByOutlineDocOrder(stories, outline).map((s) => s.id),
      ['US-001', 'US-002', 'US-003'],
    );
  });

  it('insertOutlineAfter 插在中间并序号顺延', () => {
    const outline: ReqOutlineItem[] = [
      { id: 'RO-E-2', title: '条目', quote: '', body: '一；二；三' },
      {
        id: 'RO-E-2-1',
        title: '一',
        quote: '一',
        kind: 'query',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-E-2-2',
        title: '二',
        quote: '二',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-E-2-3',
        title: '三',
        quote: '三',
        kind: 'query',
        parentId: 'RO-E-2',
      },
    ];
    const inserted = insertOutlineAfter(outline, 'RO-E-2-1', [
      { title: '新点', kind: 'mutate', quote: '新内容' },
    ]);
    assert.equal(inserted.error, undefined);
    assert.deepEqual(inserted.addedIds, ['RO-E-2-2']);
    assert.deepEqual(
      inserted.outline.filter((i) => i.parentId === 'RO-E-2').map((i) => i.id),
      ['RO-E-2-1', 'RO-E-2-2', 'RO-E-2-3', 'RO-E-2-4'],
    );
    assert.equal(inserted.outline.find((i) => i.id === 'RO-E-2-2')?.title, '新点');
    assert.equal(inserted.idMap.get('RO-E-2-2'), 'RO-E-2-3');
    assert.equal(inserted.idMap.get('RO-E-2-3'), 'RO-E-2-4');
    const remapped = remapOutlineRefs(
      {
        stories: [story({ id: 'US-001', title: '二故事', sourceRefs: ['RO-E-2-2'] })],
        check: null,
      },
      inserted.idMap,
    );
    assert.deepEqual(remapped.stories[0]!.sourceRefs, ['RO-E-2-3']);
  });

  it('removeOutlinePoint 删除后序号连续并摘掉引用', () => {
    const outline: ReqOutlineItem[] = [
      { id: 'RO-E-2', title: '条目', quote: '', body: '一；二；三' },
      {
        id: 'RO-E-2-1',
        title: '一',
        quote: '一',
        kind: 'query',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-E-2-2',
        title: '二',
        quote: '二',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-E-2-3',
        title: '三',
        quote: '三',
        kind: 'query',
        parentId: 'RO-E-2',
      },
    ];
    const removed = removeOutlinePoint(outline, 'RO-E-2-2');
    assert.equal(removed.error, undefined);
    assert.deepEqual(
      removed.outline.filter((i) => i.parentId === 'RO-E-2').map((i) => i.id),
      ['RO-E-2-1', 'RO-E-2-2'],
    );
    assert.equal(removed.outline.find((i) => i.id === 'RO-E-2-2')?.title, '三');
    const remapped = remapOutlineRefs(
      {
        stories: [
          story({ id: 'US-001', title: '二故事', sourceRefs: ['RO-E-2-2'] }),
          story({ id: 'US-002', title: '三故事', sourceRefs: ['RO-E-2-3'] }),
        ],
        check: null,
      },
      removed.idMap,
      removed.removedIds,
    );
    assert.deepEqual(remapped.stories[0]!.sourceRefs, []);
    assert.deepEqual(remapped.stories[1]!.sourceRefs, ['RO-E-2-2']);
  });

  it('insertOutlineAfter 拒绝父级 afterId', () => {
    const outline: ReqOutlineItem[] = [
      { id: 'RO-E-2', title: '条目', quote: '', body: '一' },
      { id: 'RO-E-2-1', title: '一', quote: '一', kind: 'query', parentId: 'RO-E-2' },
    ];
    const bad = insertOutlineAfter(outline, 'RO-E-2', [{ title: 'x', kind: 'query', quote: 'x' }]);
    assert.ok(bad.error);
    assert.equal(bad.addedIds.length, 0);
  });

  it('updateOutlinePointText 可改标题/类型/原文且 id 不变', () => {
    const outline: ReqOutlineItem[] = [
      { id: 'RO-E-2', title: '条目', quote: '', body: '一' },
      {
        id: 'RO-E-2-1',
        title: '一',
        quote: '一',
        kind: 'query',
        parentId: 'RO-E-2',
      },
    ];
    const updated = updateOutlinePointText(outline, 'RO-E-2-1', {
      title: '查看一',
      kind: 'mutate',
      quote: '新原文',
      body: '新原文全文',
    });
    assert.equal(updated.error, undefined);
    const point = updated.outline.find((item) => item.id === 'RO-E-2-1');
    assert.equal(point?.title, '查看一');
    assert.equal(point?.kind, 'mutate');
    assert.equal(point?.quote, '新原文');
    assert.equal(point?.body, '新原文全文');
  });
});

describe('outlinePointExcerpt / expandQuoteInParentBody', () => {
  const parentBody = [
    '添加/修改节点：(以下为默认字段)',
    '1、上级节点：显示，不可编辑。',
    '2、本级节点布局：必填',
    '3、节点标题：输入框，必填，max=50字',
    '4、描述：简易富文本，选填，max=200字',
    '5、图标：单张上传，选填',
    '6、背景图：单张上传，选填',
    '',
    '【经营主体选择】——企业开办、企业注销',
    '7、框线背景图：单张上传，必填',
    '8、其他字段',
    '9、适老版标题',
    '10、业务主体选择',
  ].join('\n');

  it('短 quote 能从父级扩出含 4/5/6 的片段', () => {
    const short =
      '添加/修改节点：(以下为默认字段) 1、上级节点：显示，不可编辑。2、本级节点布局：必填 3、节点标题：输入框，必填，max=50字';
    const expanded = expandQuoteInParentBody(short, parentBody);
    assert.match(expanded, /4、描述/);
    assert.match(expanded, /5、图标/);
    assert.match(expanded, /6、背景图/);
  });

  it('outlinePointExcerpt 编号项起头时只扩到本项，不吞后续编号', () => {
    const point: ReqOutlineItem = {
      id: 'RO-1-7',
      title: '上级节点字段',
      quote: '1、上级节点：显示，不可编辑。',
      kind: 'mutate',
      parentId: 'RO-E-2',
    };
    const parent: ReqOutlineItem = {
      id: 'RO-E-2',
      title: '政企通页面管理',
      quote: '',
      body: parentBody,
    };
    const out = outlinePointExcerpt(point, parent);
    assert.equal(out.fromParent, false);
    assert.match(out.text, /1、上级节点/);
    assert.doesNotMatch(out.text, /2、本级节点布局/);
    assert.doesNotMatch(out.text, /4、描述/);
  });

  it('有 body 时直接用 body，不扩写', () => {
    const point: ReqOutlineItem = {
      id: 'RO-1-7',
      title: '默认字段',
      quote: '短',
      body: '完整 body 内容含 4、5、6',
      kind: 'mutate',
      parentId: 'RO-E-2',
    };
    const out = outlinePointExcerpt(point, {
      id: 'RO-E-2',
      title: 'p',
      quote: '',
      body: parentBody,
    });
    assert.equal(out.fromParent, false);
    assert.equal(out.text, '完整 body 内容含 4、5、6');
  });

  it('同父级多子点按原文位置切段，互不吞并', () => {
    const parentBodyMulti = [
      '节点排序：默认按照录入顺序排序，支持上下移动',
      '',
      '节点操作：添加/添加下级、修改、删除',
      '',
      '页面互锁：知识库团队节点维护页',
      '',
      '添加/修改节点：（以下为默认字段）',
      '1、上级节点：显示，不可编辑。',
    ].join('\n');
    const parent: ReqOutlineItem = {
      id: 'RO-E-2',
      title: '政企通页面管理',
      quote: '',
      body: parentBodyMulti,
    };
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-1-5',
        title: '节点排序与上下移动',
        quote: '节点排序：默认按照录入顺序排序，支持上下移动',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-6',
        title: '节点操作',
        quote: '节点操作：添加/添加下级、修改、删除',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-7',
        title: '添加修改字段',
        quote: '添加/修改节点：（以下为默认字段）',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
    ];
    const a = outlinePointExcerpt(points[0]!, parent, points);
    const b = outlinePointExcerpt(points[1]!, parent, points);
    const c = outlinePointExcerpt(points[2]!, parent, points);
    assert.match(a.text, /节点排序/);
    assert.doesNotMatch(a.text, /节点操作/);
    assert.match(b.text, /节点操作/);
    assert.doesNotMatch(b.text, /添加\/修改节点/);
    assert.match(c.text, /添加\/修改节点/);
    assert.match(c.text, /上级节点/);
  });

  it('硬切到下章字段前须在【段首停下，不含【首页】', () => {
    const parentBody = [
      '5、图标：单张上传，非必填',
      '6、背景图：单张上传，非必填',
      '“本级节点布局”发生变化，二次确认：节点布局发生变化，提交后原节点下所有子节点无法保留。',
      '------------------------------------------------------------',
      '【首页】：——政企通',
      '7、在线客服标题：输入框，必填，max=6字；',
      '8、在线客服图标：单张上传，非必填',
    ].join('\n');
    const parent: ReqOutlineItem = {
      id: 'RO-E-2',
      title: '政企通页面管理',
      quote: '',
      body: parentBody,
    };
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-1-16',
        title: '本级节点布局变更二次确认',
        quote:
          '“本级节点布局”发生变化，二次确认：节点布局发生变化，提交后原节点下所有子节点无法保留。',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-17',
        title: '首页布局-在线客服标题',
        quote: '7、在线客服标题：输入框，必填，max=6字；',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
    ];
    const a = outlinePointExcerpt(points[0]!, parent, points);
    assert.match(a.text, /二次确认/);
    assert.doesNotMatch(a.text, /【首页】/);
    assert.doesNotMatch(a.text, /在线客服标题/);
  });

  it('连续编号三项（按钮类）展开互不吞并', () => {
    const parentBody = [
      '页面按钮：',
      '1、暂存：不论谁暂存，再次打开修改页面时均显示暂存的信息；',
      '2、发给承办确认：展示类型为运营信息展示时显示该按钮；',
      '3、提交：展示类型为服务信息展示时提交后状态变为审核通过；',
      '4、操作记录：是否放在右上角？',
    ].join('\n');
    const parent: ReqOutlineItem = {
      id: 'RO-E-2',
      title: '政企通页面管理',
      quote: '',
      body: parentBody,
    };
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-1-11',
        title: '页面按钮暂存',
        quote: '1、暂存：不论谁暂存，再次打开修改页面时均显示暂存的信息；',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-12',
        title: '页面按钮发给承办确认',
        quote: '2、发给承办确认：展示类型为运营信息展示时显示该按钮；',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-1-13',
        title: '页面按钮提交',
        quote: '3、提交：展示类型为服务信息展示时提交后状态变为审核通过；',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
    ];
    const a = outlinePointExcerpt(points[0]!, parent, points);
    const b = outlinePointExcerpt(points[1]!, parent, points);
    const c = outlinePointExcerpt(points[2]!, parent, points);
    assert.match(a.text, /1、暂存/);
    assert.doesNotMatch(a.text, /2、发给承办确认/);
    assert.doesNotMatch(a.text, /3、提交/);
    assert.match(b.text, /2、发给承办确认/);
    assert.doesNotMatch(b.text, /1、暂存/);
    assert.doesNotMatch(b.text, /3、提交/);
    assert.match(c.text, /3、提交/);
    assert.doesNotMatch(c.text, /2、发给承办确认/);
    assert.doesNotMatch(c.text, /4、操作记录/);
  });

  it('同一编号列表被拆成两点时，第一点不在「2、」处被硬切掉菜单', () => {
    const sharedList = [
      '【政企通】',
      '新开菜单，下面分：',
      '1、政企通页面管理：知识库团队',
      '2、政企通信息管理：知识库团队（全部数据）、承办单位（仅限看自己单位的数据）',
      '3、政企通信息审核：知识库团队',
      '4、政企通信息确认：承办单位（仅限看自己单位的待确认数据）',
      '5、政企通开通确认：热线办',
    ].join('\n');
    const parent: ReqOutlineItem = {
      id: 'RO-1',
      title: '政企通',
      quote: '',
      body: sharedList,
    };
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-1-1',
        title: '政企通—新增菜单及五个子菜单',
        quote: '【政企通】\n新开菜单，下面分：\n1、政企通页面管理：知识库团队',
        kind: 'mutate',
        parentId: 'RO-1',
      },
      {
        id: 'RO-1-2',
        title: '政企通—各子菜单角色权限与数据可见范围',
        quote:
          '2、政企通信息管理：知识库团队（全部数据）、承办单位（仅限看自己单位的数据） 3、政企通信息审核：知识库团队 4、政企通信息确认：承办单位（仅限看自己单位的待确认数据） 5、政企通开通确认：热线办',
        kind: 'mutate',
        parentId: 'RO-1',
      },
    ];
    const a = outlinePointExcerpt(points[0]!, parent, points);
    const b = outlinePointExcerpt(points[1]!, parent, points);
    assert.match(a.text, /1、政企通页面管理/);
    assert.match(a.text, /5、政企通开通确认/);
    assert.match(b.text, /2、政企通信息管理/);
    assert.match(b.text, /5、政企通开通确认/);
  });

  it('标题都带「树状展示」时，不同 quote 的两点展开不串成同一段', () => {
    const parentBody = [
      '【政企通页面管理】树状展示',
      '头部显示“政企通（未开通）”，未开通三个字为橙色；',
      '热线办点过“确认开通”按钮后，显示“政企通（已开通）”，已开通三个字为绿色。',
      '',
      '节点排序：默认按照录入顺序排序，支持上下移动',
    ].join('\n');
    const parent: ReqOutlineItem = {
      id: 'RO-E-1',
      title: '政企通页面管理',
      quote: '',
      body: parentBody,
    };
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-1-3',
        title: '政企通页面管理头部开通状态展示（未开通橙色/已开通绿色）',
        quote:
          '头部显示“政企通（未开通）”，未开通三个字为橙色；\n热线办点过“确认开通”按钮后，显示“政企通（已开通）”，已开通三个字为绿色。',
        kind: 'query',
        parentId: 'RO-E-1',
      },
      {
        id: 'RO-1-5',
        title: '政企通页面管理节点树状展示与默认排序、上下移动',
        quote: '节点排序：默认按照录入顺序排序，支持上下移动',
        kind: 'mutate',
        parentId: 'RO-E-1',
      },
    ];
    const a = outlinePointExcerpt(points[0]!, parent, points);
    const b = outlinePointExcerpt(points[1]!, parent, points);
    assert.match(a.text, /未开通三个字为橙色/);
    assert.doesNotMatch(a.text, /节点排序/);
    assert.match(b.text, /节点排序/);
    assert.doesNotMatch(b.text, /未开通三个字为橙色/);
  });

  it('第一点 quote 仅列表导语时，硬切在「1、」前仍软扩出完整编号列表', () => {
    const sharedList = [
      '【政企通】',
      '新开菜单，下面分：',
      '1、政企通页面管理：知识库团队',
      '2、政企通信息管理：知识库团队（全部数据）、承办单位（仅限看自己单位的数据）',
      '3、政企通信息审核：知识库团队',
      '4、政企通信息确认：承办单位（仅限看自己单位的待确认数据）',
      '5、政企通开通确认：热线办',
    ].join('\n');
    const parent: ReqOutlineItem = {
      id: 'RO-1',
      title: '政企通',
      quote: '',
      body: sharedList,
    };
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-1-1',
        title: '政企通菜单新增及五个二级菜单结构',
        quote: '【政企通】\n新开菜单，下面分：',
        kind: 'mutate',
        parentId: 'RO-1',
      },
      {
        id: 'RO-1-2',
        title: '政企通各二级菜单的角色可见权限',
        quote: '1、政企通页面管理：知识库团队',
        kind: 'mutate',
        parentId: 'RO-1',
      },
    ];
    const a = outlinePointExcerpt(points[0]!, parent, points);
    assert.match(a.text, /下面分：/);
    assert.match(a.text, /1、政企通页面管理/);
    assert.match(a.text, /5、政企通开通确认/);
  });

  it('有兄弟时过长 body 按下一编号硬切，不吞后续子点', () => {
    const parent: ReqOutlineItem = {
      id: 'RO-E-2',
      title: '首页布局',
      quote: '',
      body: parentBody,
    };
    const fatBody = [
      '7、框线背景图：单张上传，必填',
      '8、其他字段',
      '9、适老版标题',
      '10、业务主体选择',
    ].join('\n');
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-E-2-7',
        title: '框线背景图',
        quote: '7、框线背景图：单张上传，必填',
        body: fatBody,
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-E-2-8',
        title: '其他字段',
        quote: '8、其他字段',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-E-2-9',
        title: '适老版标题',
        quote: '9、适老版标题',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
    ];
    const out = outlinePointExcerpt(points[0]!, parent, points);
    assert.match(out.text, /7、框线背景图/);
    assert.doesNotMatch(out.text, /8、其他字段/);
    assert.doesNotMatch(out.text, /9、适老版标题/);
  });

  it('有兄弟时长 quote（≥400）仍按 endBefore 裁短', () => {
    const parent: ReqOutlineItem = {
      id: 'RO-E-2',
      title: '首页布局',
      quote: '',
      body: parentBody,
    };
    const longTail = '详'.repeat(400);
    const longQuote = `7、框线背景图：单张上传，必填\n8、其他字段\n9、适老版标题\n${longTail}`;
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-E-2-7',
        title: '框线背景图',
        quote: longQuote,
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-E-2-8',
        title: '其他字段',
        quote: '8、其他字段',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
    ];
    assert.ok(longQuote.length >= 400);
    const out = outlinePointExcerpt(points[0]!, parent, points);
    assert.match(out.text, /7、框线背景图/);
    assert.doesNotMatch(out.text, /8、其他字段/);
    assert.doesNotMatch(out.text, /详{10,}/);
  });

  it('无 siblings 时仍返回完整 body（改原文预填）', () => {
    const fatBody = ['7、框线背景图：单张上传，必填', '8、其他字段', '9、适老版标题'].join('\n');
    const point: ReqOutlineItem = {
      id: 'RO-E-2-7',
      title: '框线背景图',
      quote: '7、框线背景图',
      body: fatBody,
      kind: 'mutate',
      parentId: 'RO-E-2',
    };
    const out = outlinePointExcerpt(point, {
      id: 'RO-E-2',
      title: 'p',
      quote: '',
      body: parentBody,
    });
    assert.equal(out.text, fatBody);
  });

  it('变更需求点保存的 body 有兄弟时也立刻展示，不被父级切片盖住', () => {
    const parent: ReqOutlineItem = {
      id: 'RO-E-2',
      title: '首页布局',
      quote: '',
      body: parentBody,
    };
    const edited = '（1）要有倒计时；时间到了自动关闭并提示「请重新打开」。';
    const points: ReqOutlineItem[] = [
      {
        id: 'RO-E-2-7',
        title: '审核提交倒计时',
        quote: edited,
        body: edited,
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
      {
        id: 'RO-E-2-8',
        title: '其他字段',
        quote: '8、其他字段',
        kind: 'mutate',
        parentId: 'RO-E-2',
      },
    ];
    const out = outlinePointExcerpt(points[0]!, parent, points);
    assert.equal(out.text, edited);
    assert.doesNotMatch(out.text, /8、其他字段/);
  });
});
