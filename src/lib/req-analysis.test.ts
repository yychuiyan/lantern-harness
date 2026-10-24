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
  extractIdealRequirementTitles,
  inferRequirementName,
  mergeStories,
  parseReqSections,
  reqNameFromFileName,
  reqSourceFileName,
  reqTitleLooksLikeFileName,
  splitRequirementSections,
  storiesToMarkdown,
  toMarkdown,
  type ReqAnalysisDoc,
  type ReqOutlineItem,
  type ReqStory,
} from './req-analysis';

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
  it('未引用的需求条目进缺口，覆盖率按条目录入计算', () => {
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
  });

  it('缺异常、缺验收、缺角色都会报，且 id 稳定', () => {
    const target = doc({
      stories: [
        story({ id: 'US-007', title: '提交申请', role: '', exceptions: [], acceptance: [] }),
      ],
    });
    const first = auditStories(target);
    const second = auditStories(target);
    const types = first.gaps.map((gap) => gap.type);
    assert.ok(types.includes('missing-field'));
    assert.ok(types.includes('missing-scenario'));
    assert.ok(types.includes('untestable-acceptance'));
    assert.deepEqual(
      first.gaps.map((gap) => gap.id),
      second.gaps.map((gap) => gap.id),
    );
  });

  it('写操作只写一条异常时提示异常分支不足', () => {
    const report = auditStories({
      outline: [outline('RO-1-1', '提交申请')],
      stories: [
        story({
          title: '提交申请',
          mainFlow: [{ action: '提交申请单', result: '进入待审批' }],
          exceptions: [{ scenario: '网络中断', expected: '提示重试' }],
        }),
      ],
    });
    assert.ok(report.gaps.some((gap) => gap.title === '写操作缺少异常分支'));
  });

  it('维度没有任何故事覆盖时给一条全局缺口', () => {
    const report = auditStories({
      outline: [outline('RO-1-1', '提交申请')],
      stories: [story({ title: '提交申请' })],
    });
    const dims = report.gaps.filter((gap) => gap.type === 'missing-dimension');
    // 故事里带「已登录」，权限维度算覆盖；其余五个维度都应报缺失
    assert.ok(dims.some((gap) => gap.title.includes('并发与幂等')));
    assert.ok(dims.every((gap) => gap.storyId === ''));
    assert.equal(report.dimensions.find((dim) => dim.key === 'permission')?.covered, true);
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
  it('按拆解 / 体检 / 补写三段切分', () => {
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
    assert.equal(sections.audit.trim(), '体检规则');
    assert.equal(sections.fix.trim(), '补写规则');
  });

  it('缺段时返回空串', () => {
    const sections = parseReqSections('## 拆解\n\n只有拆解');
    assert.equal(sections.audit, '');
    assert.equal(sections.fix, '');
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
