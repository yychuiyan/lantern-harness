import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCsvCaseRows, parseMarkdownCaseRows, mergeHeaders } from './case-file';
import { applyFieldMap, canonicalizeRows, caseFieldMap, describeFieldMap } from './case-fields';
import {
  auditCases,
  blindspotToRows,
  caseSuggestions,
  dimensionScores,
  groupBlindspots,
  mergeModelReview,
  nextBlindspotNumbers,
  normalizeReport,
  reviewToMarkdown,
  requirementKeywords,
  splitSteps,
  VERDICT_THRESHOLDS,
  type BlindspotItem,
} from './case-review';

const goodRow = {
  用例编号: 'TC-001',
  所属模块: '订单',
  用例标题: '已登录用户提交订单后跳转到支付页',
  前置条件: '已登录普通用户，购物车有 1 件商品',
  测试步骤: '1、进入购物车\n2、点击结算\n3、点击提交订单',
  预期结果: '跳转到支付页，订单状态变为待支付',
  优先级: 'P0',
  用例类型: '功能测试',
};

function row(over: Record<string, string> = {}) {
  return { ...goodRow, ...over };
}

describe('case-file', () => {
  it('解析 Markdown 用例表并跳过对齐行', () => {
    const md = [
      '# 用例',
      '',
      '| 用例编号 | 用例标题 | 测试步骤 |',
      '| --- | --- | --- |',
      '| TC-1 | 提交订单 | 1、点提交 |',
      '| TC-2 | 取消订单 | 1、点取消 |',
      '',
      '## 备注',
      '无关文字',
    ].join('\n');
    const { headers, rows } = parseMarkdownCaseRows(md);
    assert.deepEqual(headers, ['用例编号', '用例标题', '测试步骤']);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]['用例标题'], '取消订单');
  });

  it('把 <br> 还原成换行', () => {
    const md = '| 用例编号 | 测试步骤 |\n| --- | --- |\n| TC-1 | 1、点提交<br>2、看结果 |';
    const { rows } = parseMarkdownCaseRows(md);
    assert.equal(rows[0]['测试步骤'], '1、点提交\n2、看结果');
  });

  it('CSV 支持引号内的逗号 / 换行与 BOM', () => {
    const csv =
      '\uFEFF用例编号,用例标题,测试步骤\r\nTC-1,"提交, 订单","1、点提交\r\n2、看结果"\r\n';
    const { headers, rows } = parseCsvCaseRows(csv);
    assert.deepEqual(headers, ['用例编号', '用例标题', '测试步骤']);
    assert.equal(rows[0]['用例标题'], '提交, 订单');
    assert.equal(rows[0]['测试步骤'], '1、点提交\r\n2、看结果');
  });

  it('mergeHeaders 保留文件顺序并补齐标准字段', () => {
    const merged = mergeHeaders(['用例编号', '用例标题']);
    assert.deepEqual(merged.slice(0, 2), ['用例编号', '用例标题']);
    assert.ok(merged.includes('预期结果'));
    assert.equal(new Set(merged).size, merged.length);
  });
});

describe('case-review 规则', () => {
  it('步骤按编号拆分', () => {
    assert.equal(splitSteps('1、进入\n2、点击').length, 2);
    assert.equal(splitSteps('打开页面；2、点提交').length, 2);
    assert.equal(splitSteps('').length, 0);
  });

  it('需求关键词只留短句', () => {
    const keys = requirementKeywords('- 用户可以用手机号登录\n- 订单状态：待支付 / 已支付');
    assert.ok(keys.includes('用户可以用手机号登录'));
    assert.ok(keys.every((k) => k.length >= 3 && k.length <= 24));
  });

  it('完整用例判可用，空标题直接判无效', () => {
    const audit = auditCases([row()]);
    assert.equal(audit.cases[0].verdict, 'usable');
    assert.ok(audit.score >= VERDICT_THRESHOLDS.usable);

    const bad = auditCases([row({ 用例标题: '' })]);
    assert.equal(bad.cases[0].verdict, 'invalid');
    assert.match(bad.cases[0].hard ?? '', /标题/);
  });

  it('模糊预期降分并给改进建议', () => {
    const audit = auditCases([row({ 预期结果: '正常' })]);
    const item = audit.cases[0];
    assert.ok(item.score < 85);
    assert.ok(item.deductions.some((d) => d.dimension === 'expected' && d.suggestion));
  });

  it('修改建议优先取建议、按文本去重，没有建议回退原因', () => {
    const list = caseSuggestions({
      deductions: [
        {
          dimension: 'expected',
          points: 10,
          reason: '预期写成了「正常」',
          suggestion: '写明跳转后的页面与状态',
        },
        {
          dimension: 'steps',
          points: 5,
          reason: '步骤没有写点击对象',
          suggestion: '写明跳转后的页面与状态',
        },
        { dimension: 'data', points: 5, reason: '缺少前置条件：账号状态', suggestion: '' },
      ],
    });
    assert.deepEqual(list, ['写明跳转后的页面与状态', '缺少前置条件：账号状态']);
    assert.deepEqual(caseSuggestions({ deductions: [] }), []);
  });

  it('七项指标齐全，重复用例被统计', () => {
    const audit = auditCases([
      row(),
      row(),
      row({ 用例编号: 'TC-2', 用例标题: '提交订单失败提示' }),
    ]);
    assert.equal(audit.metrics.length, 8);
    const dup = audit.metrics.find((m) => m.key === 'duplicate');
    assert.equal(dup?.text, '67%');
    const coverage = audit.metrics.find((m) => m.key === 'coverage');
    assert.equal(coverage?.text, '—');
  });

  it('挂了需求后覆盖率有数', () => {
    const audit = auditCases([row()], '- 已登录用户提交订单');
    const coverage = audit.metrics.find((m) => m.key === 'coverage');
    assert.notEqual(coverage?.text, '—');
  });

  it('模型分数会被采用，但硬伤不可推翻', () => {
    const audit = auditCases([row({ 预期结果: '' })]);
    const report = mergeModelReview(
      audit,
      [
        {
          no: 'TC-001',
          title: goodRow.用例标题,
          verdict: 'usable',
          dimensions: { coverage: 100, steps: 100, expected: 100, data: 100, convention: 100 },
          deductions: [],
        },
      ],
      '整体还行',
    );
    assert.equal(report.cases[0].verdict, 'invalid');
    assert.equal(report.modeled, true);
    assert.equal(report.summary, '整体还行');
  });

  it('模型自己要判无效必须给 hard 证据，否则按分数算', () => {
    const audit = auditCases([row()]);
    const high = {
      coverage: 90,
      steps: 88,
      expected: 86,
      data: 90,
      convention: 90,
    };
    const noEvidence = mergeModelReview(
      audit,
      [{ no: 'TC-001', verdict: 'invalid', dimensions: high, deductions: [] }],
      '',
    );
    assert.equal(noEvidence.cases[0].verdict, 'usable');

    const withEvidence = mergeModelReview(
      audit,
      [
        {
          no: 'TC-001',
          verdict: 'invalid',
          hard: '与 US-020 验收冲突（需求要求二次确认，用例写直接清空）',
          dimensions: high,
          deductions: [],
        },
      ],
      '',
    );
    assert.equal(withEvidence.cases[0].verdict, 'invalid');
    assert.match(withEvidence.cases[0].hard ?? '', /US-020/);
    assert.equal(withEvidence.counts.invalid, 1);
  });

  it('读旧报告时按分数修正判定，并按编号回填空标题', () => {
    const audit = auditCases([row()]);
    const legacy = {
      ...mergeModelReview(audit, [], ''),
      cases: [{ ...audit.cases[0], title: '', verdict: 'invalid' as const, score: 86 }],
      counts: { usable: 0, revise: 0, invalid: 1 },
    };
    const fixed = normalizeReport(legacy, [row()]);
    assert.equal(fixed.cases[0].title, goodRow.用例标题);
    assert.equal(fixed.cases[0].verdict, 'usable');
    assert.deepEqual(fixed.counts, { usable: 1, revise: 0, invalid: 0 });
  });

  it('两级模板：测试分项目 当标题，测试项目 归到所属模块', () => {
    const twoLevel = {
      用例编号: 'TC-001',
      需求编号: 'US-020',
      测试项目: '运管系统v1.10.0迭代',
      测试分项目: '问卷参与人设置-条件筛选',
      预置条件: '问卷已创建',
      测试步骤: '1、进入条件筛选\n2、选择单位',
      期望内容标准: '只展示属于该单位的人员',
    };
    const map = caseFieldMap(Object.keys(twoLevel));
    assert.equal(map.title, '测试分项目');
    assert.equal(map.module, '测试项目');
    const audit = auditCases([twoLevel]);
    assert.equal(audit.cases[0].title, '问卷参与人设置-条件筛选');
  });

  it('模板表头是别名时按别名算分，不再漏成「无标题」', () => {
    const aliasRow = {
      测试项目: '已登录用户提交订单后跳转到支付页',
      预置条件: '已登录普通用户，购物车有 1 件商品',
      操作步骤: '1、进入购物车\n2、点击结算\n3、点击提交订单',
      期望内容标准: '跳转到支付页，订单状态变为待支付',
      优先级: 'P0',
      用例类型: '功能测试',
      所属模块: '订单',
      用例编号: 'TC-001',
    };
    const map = caseFieldMap(Object.keys(aliasRow));
    assert.equal(map.title, '测试项目');
    assert.equal(map.steps, '操作步骤');
    assert.equal(map.expected, '期望内容标准');
    assert.equal(map.precondition, '预置条件');
    assert.match(describeFieldMap(map), /用例标题（表头：测试项目）/);

    const [filled] = canonicalizeRows([aliasRow]);
    assert.equal(filled['用例标题'], aliasRow.测试项目);
    assert.equal(filled['测试步骤'], aliasRow.操作步骤);

    const audit = auditCases([aliasRow]);
    assert.equal(audit.cases[0].title, aliasRow.测试项目);
    assert.notEqual(audit.cases[0].verdict, 'invalid');
  });

  it('字段完整率只算文件里真的有的列', () => {
    const only = {
      用例编号: 'TC-1',
      用例标题: '提交订单',
      测试步骤: '1、点提交\n2、看结果',
      预期结果: '跳转到支付页',
    };
    const audit = auditCases([only]);
    const m = audit.metrics.find((x) => x.key === 'fieldComplete');
    assert.equal(m?.text, '100%');
  });

  it('补全行按文件表头写回别名列', () => {
    const headers = ['用例编号', '测试项目', '操作步骤', '期望内容标准'];
    const map = caseFieldMap(headers);
    const [row] = blindspotToRows(
      [
        item({
          id: 'bs_y',
          category: 'business',
          title: '金额精度',
          steps: ['下单'],
          expected: '显示 0.01',
        }),
      ],
      headers,
      [],
    );
    const applied = applyFieldMap(row, map);
    assert.equal(applied['测试项目'], row['用例标题']);
    assert.equal(applied['期望内容标准'], '显示 0.01');
  });

  it('模型给出 hard 证据时保留「错误无效」（规则看不出的冲突 / 重复）', () => {
    const audit = auditCases([row()]);
    const report = mergeModelReview(
      audit,
      [
        {
          no: 'TC-001',
          title: goodRow.用例标题,
          verdict: 'invalid',
          hard: '与需求 US-002 冲突：需求要求普通用户提交，用例写管理员',
          dimensions: { coverage: 95, steps: 95, expected: 95, data: 95, convention: 95 },
          deductions: [
            {
              dimension: 'coverage',
              points: 10,
              reason: '与需求 US-002 冲突',
              suggestion: '按需求改回普通用户',
            },
          ],
        },
      ],
      '',
    );
    assert.equal(report.cases[0].verdict, 'invalid');
    assert.equal(report.counts.invalid, 1);
    assert.match(report.cases[0].hard ?? '', /US-002/);
  });

  it('按四类分组并跳过空类', () => {
    const items: BlindspotItem[] = [
      item({ id: 'bs_a', category: 'security', title: '越权访问' }),
      item({ id: 'bs_b', category: 'business', title: '金额精度' }),
    ];
    const groups = groupBlindspots(items);
    assert.deepEqual(
      groups.map((g) => g.key),
      ['security', 'business'],
    );
  });

  it('补全编号跳过已用编号并加标记', () => {
    const existing = [{ 用例编号: 'TC-BL-001' } as Record<string, string>];
    assert.deepEqual(nextBlindspotNumbers(existing, 2), ['TC-BL-002', 'TC-BL-003']);

    const rows = blindspotToRows(
      [
        item({
          id: 'bs_x',
          category: 'security',
          title: '未登录直接调接口',
          steps: ['打开接口', '发送请求'],
          expected: '返回 401',
          reqAnchor: '提交退款申请',
        }),
      ],
      ['用例编号', '用例标题', '需求编号', '测试步骤', '预期结果'],
      existing,
    );
    assert.equal(rows[0]['用例编号'], 'TC-BL-002');
    assert.match(rows[0]['用例标题'], /^\[补全·安全\] /);
    assert.equal(rows[0]['测试步骤'], '打开接口\n发送请求');
    assert.equal(rows[0]['需求编号'], '提交退款申请');
  });

  it('Markdown 导出含结论与补全明细', () => {
    const audit = auditCases([row()]);
    const md = reviewToMarkdown(
      'a.md',
      {
        at: '2026-10-21T00:00:00.000Z',
        score: audit.score,
        counts: audit.counts,
        dimensions: dimensionScores(audit.dimensions),
        metrics: audit.metrics,
        cases: audit.cases,
        summary: '一句话',
        modeled: false,
      },
      null,
    );
    assert.match(md, /# 用例质量评审报告 · a\.md/);
    assert.match(md, /一句话/);
    assert.match(md, /TC-001/);
  });
});

function item(over: Partial<BlindspotItem>): BlindspotItem {
  return {
    id: over.id ?? 'bs_1',
    category: over.category ?? 'business',
    severity: over.severity ?? 'medium',
    title: over.title ?? '盲区',
    why: over.why ?? '人工容易漏',
    precondition: over.precondition ?? '',
    steps: over.steps ?? [],
    expected: over.expected ?? '',
    priority: over.priority ?? 'P1',
    reqAnchor: over.reqAnchor ?? '',
    added: over.added ?? false,
    caseNo: over.caseNo ?? '',
  };
}
