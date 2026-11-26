import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCsvCaseRows, parseMarkdownCaseRows, mergeHeaders } from './case-file';
import { applyFieldMap, canonicalizeRows, caseFieldMap, describeFieldMap } from './case-fields';
import {
  auditCases,
  blindspotToRows,
  caseContentChanged,
  caseContentFingerprint,
  caseSuggestions,
  collectAutoFixedKeys,
  collectIgnoredKeys,
  countNeedFix,
  dimensionScores,
  groupBlindspots,
  mergeBlindspotCompletion,
  mergeModelReview,
  nextBlindspotNumbers,
  normalizeReport,
  reviewToMarkdown,
  requirementKeywords,
  splitSteps,
  stitchPartialReview,
  VERDICT_THRESHOLDS,
  type BlindspotItem,
  type CaseVerdict,
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

  it('预期只有“优化后样式”等泛化描述时不能判为可用', () => {
    const audit = auditCases([
      row({
        预期结果: '页面按优化后样式展示，审核操作在页面内完成',
      }),
    ]);
    assert.equal(audit.cases[0].verdict, 'revise');
    assert.ok(audit.cases[0].deductions.some((d) => d.dimension === 'expected'));
  });

  it('排序、拦截、人工选择等具体结果仍可判定', () => {
    const audit = auditCases([
      row({ 预期结果: '紧急与次紧急留言排在一般留言之前，紧急在次紧急之前' }),
      row({
        用例编号: 'TC-002',
        用例标题: '非授权账号访问被拦截',
        测试步骤: '1、登录非授权账号\n2、访问配置页面',
        预期结果: '无该页面入口或访问被拒绝',
      }),
      row({
        用例编号: 'TC-003',
        用例标题: '无级别结果时工单级别需人工选择',
        测试步骤: '1、对无级别结果的留言预填制工单\n2、查看工单级别',
        预期结果: '工单级别无自动值，需人工选择',
      }),
      row({
        用例编号: 'TC-004',
        用例标题: '办结单编号校验通过后允许提交',
        测试步骤: '1、填写已办结工单编号\n2、点击提交',
        预期结果: '校验通过，允许提交派发信息单',
      }),
      row({
        用例编号: 'TC-005',
        用例标题: '规则命中后自动推送',
        测试步骤: '1、提交命中规则的工单\n2、查看推送记录',
        预期结果: '工单自动推送至市信访办，并生成推送记录',
      }),
      row({
        用例编号: 'TC-006',
        用例标题: '切换工单类型时保留已填写内容',
        测试步骤: '1、填写内容描述\n2、切换工单类型',
        预期结果: '已填写工单内容保持不变',
      }),
      row({
        用例编号: 'TC-007',
        用例标题: '推送处室选项固定',
        测试步骤: '1、打开推送菜单\n2、查看处室选项',
        预期结果: '可选项恰为接访处、网信处、办信处、信息技术处四个',
      }),
      row({
        用例编号: 'TC-008',
        用例标题: '夜间外语来电按业务时区判定',
        测试步骤: '1、把设备时区改为其他时区\n2、发起来电',
        预期结果: '夜间窗口按统一业务时区判定，不因时区差异误判',
      }),
    ]);
    assert.ok(audit.cases.every((item) => item.verdict === 'usable'));
  });

  it('空状态按边界场景识别，不因单步或缺少类型列误扣分', () => {
    const audit = auditCases([
      {
        用例编号: 'TC-EMPTY',
        需求编号: 'REQ-1',
        模块: '工单',
        用例标题: '无待审核内容时页面展示空状态',
        前置条件: '系统中没有待审核内容',
        测试步骤: '打开工单指导审核页面',
        预期结果: '页面展示无数据状态，审核按钮不可用',
        优先级: 'P1',
      },
    ]);
    const item = audit.cases[0];
    assert.equal(item.verdict, 'usable');
    assert.equal(item.dimensions.data, 100);
    assert.equal(item.dimensions.steps, 85);
    assert.ok(!item.deductions.some((d) => /边界|异常路径/.test(d.reason)));
  });

  it('同需求已有异常用例时，正常流程用例不再被要求自带边界', () => {
    const audit = auditCases([
      row({ 需求编号: 'REQ-1' }),
      row({
        用例编号: 'TC-002',
        需求编号: 'REQ-1',
        用例标题: '提交订单失败时提示错误',
        测试步骤: '1、进入购物车\n2、提交失败订单',
        预期结果: '页面提示“订单提交失败”并保留购物车商品',
      }),
    ]);
    const normal = audit.cases.find((item) => item.no === 'TC-001');
    assert.equal(normal?.dimensions.data, 100);
    assert.ok(!normal?.deductions.some((d) => /没有体现边界或异常路径/.test(d.reason)));
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

  it('汇总重算仍保留预期可判定质量门槛', () => {
    const audit = auditCases([row({ 预期结果: '按优化后样式展示' })]);
    const report = mergeModelReview(
      audit,
      [
        {
          no: 'TC-001',
          title: goodRow.用例标题,
          dimensions: {
            coverage: 100,
            steps: 100,
            expected: 65,
            data: 100,
            convention: 100,
          },
          deductions: [
            {
              dimension: 'expected',
              points: 20,
              reason: '预期结果仍是泛化描述',
              suggestion: '补具体页面字段、状态和审核结果',
            },
          ],
        },
      ],
      '',
    );
    assert.equal(report.cases[0].verdict, 'revise');
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

  it('补全选中只更新三个执行字段，身份与探测信息保持原值', () => {
    const original = item({
      id: 'bs_keep',
      category: 'security',
      severity: 'high',
      title: '原标题不得变化',
      why: '原原因',
      priority: 'P0',
      reqAnchor: 'XQ-1',
    });
    const completed = item({
      id: 'bs_keep',
      category: 'business',
      severity: 'low',
      title: '模型误改标题',
      why: '模型误改原因',
      priority: 'P3',
      reqAnchor: 'XQ-OTHER',
      precondition: '已登录',
      steps: ['打开页面', '提交'],
      expected: '提示提交成功',
    });
    const [merged] = mergeBlindspotCompletion([original], [completed], ['bs_keep']);
    assert.equal(merged.title, original.title);
    assert.equal(merged.category, 'security');
    assert.equal(merged.severity, 'high');
    assert.equal(merged.why, '原原因');
    assert.equal(merged.priority, 'P0');
    assert.equal(merged.reqAnchor, 'XQ-1');
    assert.equal(merged.precondition, '已登录');
    assert.deepEqual(merged.steps, ['打开页面', '提交']);
    assert.equal(merged.expected, '提示提交成功');
  });

  it('补全选中拒绝漏返、多返和仍不完整的条目', () => {
    const first = item({ id: 'bs_one', title: '条目一' });
    const second = item({ id: 'bs_two', title: '条目二' });
    assert.throws(
      () =>
        mergeBlindspotCompletion(
          [first, second],
          [item({ id: 'bs_one', precondition: '已登录', steps: ['提交'], expected: '成功' })],
          ['bs_one', 'bs_two'],
        ),
      /漏返/,
    );
    assert.throws(
      () =>
        mergeBlindspotCompletion(
          [first],
          [
            item({ id: 'bs_one', precondition: '已登录', steps: ['提交'], expected: '成功' }),
            item({ id: 'bs_extra', title: '未勾选' }),
          ],
          ['bs_one'],
        ),
      /未勾选/,
    );
    assert.throws(
      () =>
        mergeBlindspotCompletion(
          [first],
          [item({ id: 'bs_one', precondition: '', steps: [], expected: '' })],
          ['bs_one'],
        ),
      /仍不完整/,
    );
    assert.throws(() => mergeBlindspotCompletion([first], [], ['bs_missing']), /已不存在或已补全/);
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
    assert.equal(rows[0]['需求编号'], '无');
  });

  it('纯数字文件延续编号，并继承同需求组的模块、状态与真实引用点', () => {
    const headers = [
      '用例编号',
      '需求编号',
      '模块',
      '子模块',
      '用例标题',
      '前置条件',
      '测试步骤',
      '预期结果',
      '优先级',
      '用例状态',
      '引用需求点',
    ];
    const existing = [
      {
        用例编号: '287',
        需求编号: 'XQ-102-20260828-01',
        模块: '工单系统',
        子模块: '工单指导审核页面优化',
        用例标题: '打开工单指导审核页面完成一次审核',
        引用需求点: 'RO-E-1-1 工单指导审核页面优化；TP-042',
      },
      {
        用例编号: '288',
        需求编号: 'XQ-OTHER',
        模块: '其他系统',
        子模块: '其他功能',
        用例标题: '其他用例',
        引用需求点: 'RO-OTHER-1 其他需求；TP-001',
      },
    ];
    assert.deepEqual(nextBlindspotNumbers(existing, 2), ['289', '290']);
    const rows = blindspotToRows(
      [
        item({
          id: 'bs_numeric',
          category: 'nonfunctional',
          title: '工单指导审核弱网恢复后不重复审核',
          steps: ['断开网络后刷新', '恢复网络并提交审核'],
          expected: '只生成一条审核记录',
          priority: 'P1',
          reqAnchor: 'XQ-102-20260828-01',
        }),
      ],
      headers,
      existing,
    );
    assert.equal(rows[0]['用例编号'], '289');
    assert.equal(rows[0]['需求编号'], 'XQ-102-20260828-01');
    assert.equal(rows[0]['模块'], '工单系统');
    assert.equal(rows[0]['子模块'], '工单指导审核页面优化');
    assert.equal(rows[0]['用例状态'], '待验证');
    assert.equal(rows[0]['引用需求点'], 'RO-E-1-1 工单指导审核页面优化');
    assert.doesNotMatch(rows[0]['引用需求点'], /XQ-|TP-/);
  });

  it('多条同需求用例时按标题、步骤和预期匹配最相关的真实引用点', () => {
    const headers = [
      '用例编号',
      '需求编号',
      '模块',
      '子模块',
      '用例标题',
      '前置条件',
      '测试步骤',
      '预期结果',
      '引用需求点',
    ];
    const existing = [
      {
        用例编号: '1',
        需求编号: 'XQ-REPORT',
        模块: '工单系统',
        子模块: '信访推送',
        用例标题: '派单方向为市信访办且命中规则的工单自动推送成功',
        引用需求点: 'RO-E-4-1 自动推送；TP-001',
      },
      {
        用例编号: '2',
        需求编号: 'XQ-REPORT',
        模块: '工单系统',
        子模块: '信访推送',
        用例标题: '按时间查询推送记录',
        引用需求点: 'RO-E-4-10 新增信访工单推送详情报表查询推送记录；TP-002',
      },
      {
        用例编号: '3',
        需求编号: 'XQ-ID',
        模块: '坐席系统',
        子模块: '证件录入',
        用例标题: '新建工单界面可手动输入证件类型',
        前置条件: '进入证件类型录入项',
        引用需求点: 'RO-E-11-3 新建工单界面新增证件类型手动输入；TP-003',
      },
      {
        用例编号: '4',
        需求编号: 'XQ-ID',
        模块: '坐席系统',
        子模块: '证件录入',
        用例标题: '内容描述含证件号提交时拦截',
        前置条件: '进入新建工单界面',
        测试步骤: '在内容描述中输入证件号码',
        引用需求点: 'RO-E-11-1 校验内容描述中的证件号码；TP-004',
      },
    ];
    const rows = blindspotToRows(
      [
        item({
          title: '信访推送详情报表万级记录分页浏览',
          steps: ['进入信访工单推送详情报表', '核对总条数'],
          expected: '分页不重复，总条数一致',
          reqAnchor: 'XQ-REPORT',
        }),
        item({
          title: '证件号码使用全角数字时仍命中内容描述禁录校验',
          precondition: '进入新建工单界面',
          steps: ['在内容描述中输入全角证件号码'],
          expected: '提示禁止记录证件号码',
          reqAnchor: 'XQ-ID',
        }),
      ],
      headers,
      existing,
    );
    assert.match(rows[0]['引用需求点'], /RO-E-4-10/);
    assert.doesNotMatch(rows[0]['引用需求点'], /RO-E-4-1\b/);
    assert.match(rows[1]['引用需求点'], /RO-E-11-1/);
    assert.doesNotMatch(rows[1]['引用需求点'], /RO-E-11-3/);
  });

  it('短 RO 编号按完整 token 匹配，不把 RO-10 误认成 RO-1', () => {
    const headers = ['用例编号', '需求编号', '模块', '子模块', '用例标题', '引用需求点'];
    const existing = [
      {
        用例编号: '1',
        需求编号: '无',
        模块: '工单系统',
        子模块: '创建工单',
        用例标题: '创建工单',
        引用需求点: 'RO-1 创建工单；TP-001',
      },
      {
        用例编号: '2',
        需求编号: '无',
        模块: '查询系统',
        子模块: '查询工单',
        用例标题: '查询工单',
        引用需求点: 'RO-10 查询工单；TP-002',
      },
    ];
    const [rows] = blindspotToRows(
      [item({ title: '创建工单重复提交', reqAnchor: 'RO-1' })],
      headers,
      existing,
    );
    assert.equal(rows['需求编号'], '无');
    assert.equal(rows['模块'], '工单系统');
    assert.equal(rows['子模块'], '创建工单');
    assert.equal(rows['引用需求点'], 'RO-1 创建工单');
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

  it('内容指纹稳定；改步骤 / 预期 / 用例状态能检出', () => {
    const a = caseContentFingerprint(row());
    const b = caseContentFingerprint(row());
    assert.equal(a, b);
    assert.notEqual(a, caseContentFingerprint(row({ 测试步骤: '1、别的步骤' })));
    assert.notEqual(a, caseContentFingerprint(row({ 预期结果: '别的预期' })));
    assert.notEqual(a, caseContentFingerprint(row({ 用例状态: '待验证' })));
  });

  it('规则评审写入 contentFp；缺指纹回填不误报已修改', () => {
    const audit = auditCases([row()]);
    assert.ok(audit.cases[0].contentFp);
    assert.equal(caseContentChanged(audit.cases[0], row()), false);

    const legacy = {
      ...mergeModelReview(audit, [], ''),
      cases: [{ ...audit.cases[0], contentFp: undefined, verdict: 'revise' as const, score: 70 }],
    };
    const normalized = normalizeReport(legacy, [row()]);
    assert.equal(normalized.cases[0].contentFp, caseContentFingerprint(row()));
    assert.equal(collectAutoFixedKeys(normalized.cases, [row()]).size, 0);
  });

  it('collectAutoFixedKeys：非可用且正文变了才标；usable 不标', () => {
    const audit = auditCases([row()]);
    const revised: CaseVerdict = {
      ...audit.cases[0],
      verdict: 'revise',
      score: 70,
    };
    const changedRows = [row({ 测试步骤: '1、已按建议改\n2、再验证' })];
    const keys = collectAutoFixedKeys([revised], changedRows);
    assert.ok(keys.has('TC-001'));

    const usable: CaseVerdict = { ...audit.cases[0], verdict: 'usable', score: 90 };
    assert.equal(collectAutoFixedKeys([usable], changedRows).size, 0);

    assert.equal(countNeedFix([revised], keys), 0);
    assert.equal(countNeedFix([revised]), 1);
  });

  it('已忽略不进已修改集合，也不计入需改', () => {
    const audit = auditCases([row()]);
    const ignored: CaseVerdict = {
      ...audit.cases[0],
      verdict: 'revise',
      score: 70,
      ignored: true,
    };
    const changedRows = [row({ 测试步骤: '1、改过' })];
    assert.equal(collectAutoFixedKeys([ignored], changedRows).size, 0);
    assert.ok(collectIgnoredKeys([ignored]).has('TC-001'));
    assert.equal(countNeedFix([ignored]), 0);
  });

  it('stitchPartialReview：只更新子集，其余与忽略保留上次', () => {
    const a = auditCases([row(), row({ 用例编号: 'TC-002', 用例标题: '取消订单' })]);
    const prevByKey = new Map(
      a.cases.map((c) => {
        if (c.no === 'TC-002')
          return [c.no, { ...c, verdict: 'revise' as const, score: 70, ignored: true }];
        return [c.no, { ...c, verdict: 'revise' as const, score: 72 }];
      }),
    );
    const reviewedOnly = {
      ...mergeModelReview(
        { ...a, cases: [a.cases[0]!] },
        [
          {
            no: 'TC-001',
            dimensions: { coverage: 90, steps: 90, expected: 90, data: 90, convention: 90 },
            deductions: [],
          },
        ],
        '只评了第一条',
      ),
    };
    const stitched = stitchPartialReview(
      a.cases,
      reviewedOnly,
      new Set(['TC-001']),
      prevByKey,
      a.metrics,
    );
    assert.equal(stitched.cases[0]!.verdict, 'usable');
    assert.equal(stitched.cases[1]!.verdict, 'revise');
    assert.equal(stitched.cases[1]!.ignored, true);
    // 忽略条不进三档计数
    assert.equal(stitched.counts.usable, 1);
    assert.equal(stitched.counts.revise, 0);
    assert.equal(stitched.counts.invalid, 0);
  });

  it('无扣分项时 caseSuggestions 按薄弱维度补建议', () => {
    const tips = caseSuggestions({
      verdict: 'revise',
      deductions: [],
      dimensions: { coverage: 90, steps: 50, expected: 90, data: 90, convention: 90 },
    });
    assert.ok(tips.some((t) => /步骤可执行/.test(t)));
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
