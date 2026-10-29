/**
 * 用例生成插件配置：需求来源（文档 / 用户故事）的判定与提示词拼装。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseGenConfigLabel, caseGenReqSource, type CaseGenPluginConfig } from './case-gen-config';
import {
  buildCaseGenSystemPrompt,
  caseFileMatchesReqTitle,
  caseGenFileBase,
  caseReqMatchKey,
  ensureCaseRemarkHeader,
  formatReqCiteCell,
  idealOrderRank,
  normalizeReqCiteValue,
  parseOutlineLookupFromReqBlock,
  parseStorySourceRefsFromReqBlock,
  parseCiteIds,
  promotePendingConfirmCases,
  sortGeneratedCaseRows,
} from './case-gen-run';

function cfg(partial: Partial<CaseGenPluginConfig> = {}): CaseGenPluginConfig {
  return {
    active: true,
    caseType: 'functional',
    outputFormat: 'md',
    templateHeaders: ['用例编号', '用例标题'],
    templateBody: '模板正文',
    promptBody: '只输出 JSON',
    confirmedAt: 0,
    ...partial,
  };
}

describe('caseGenReqSource', () => {
  it('旧配置只有 reqPath 时按需求文档处理', () => {
    assert.deepEqual(caseGenReqSource(cfg({ reqPath: 'demo/需求.md' })), {
      kind: 'doc',
      path: 'demo/需求.md',
    });
  });

  it('用户故事来源优先于 reqPath', () => {
    assert.deepEqual(
      caseGenReqSource(
        cfg({
          reqPath: 'demo/需求.md',
          reqSource: { kind: 'stories', docId: 'ra_1', storyIds: ['US-001'] },
        }),
      ),
      { kind: 'stories', docId: 'ra_1', storyIds: ['US-001'] },
    );
  });

  it('两者都没有时返回 undefined', () => {
    assert.equal(caseGenReqSource(cfg()), undefined);
  });
});

describe('caseGenConfigLabel', () => {
  it('用户故事来源显示文档名与故事条数', () => {
    const label = caseGenConfigLabel(
      cfg({
        templateTitle: '功能测试用例模板',
        outputFormat: 'xlsx',
        docTitle: '订单需求',
        reqSource: { kind: 'stories', docId: 'ra_1', storyIds: ['US-001', 'US-002'] },
      }),
    );
    assert.equal(label, '功能测试用例模板 · XLSX · 订单需求 · 2 条故事');
  });

  it('需求文档来源显示文件名', () => {
    const label = caseGenConfigLabel(cfg({ reqPath: 'demo/需求.md' }));
    assert.match(label, /需求\.md$/);
  });
});

describe('buildCaseGenSystemPrompt', () => {
  it('需求块（用户故事）拼在模板之后、运行时约束之前', () => {
    const prompt = buildCaseGenSystemPrompt(
      cfg({ reqBlock: '### 用户故事：订单需求\n### US-001 提交申请' }),
      '订单需求',
    );
    assert.ok(prompt.includes('### 用户故事：订单需求'));
    assert.ok(prompt.indexOf('### 用例模板') < prompt.indexOf('### 用户故事'));
    assert.ok(prompt.indexOf('### 用户故事') < prompt.indexOf('【运行时约束'));
    assert.ok(prompt.includes('需求名称默认可用「订单需求」'));
  });

  it('没有 reqBlock 时不额外插入需求段', () => {
    const prompt = buildCaseGenSystemPrompt(cfg());
    assert.equal(prompt.includes('### 用户故事'), false);
  });

  it('需求 / 测试点 / 模板正文不做字数截断，并标明已注入条数', () => {
    const longTp = Array.from({ length: 120 }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      return `- **[P0]** 点${n}（TP-${n}）\n  - 前置：预${n}\n  - 步骤：步${n}\n  - 预期：期${n}`;
    }).join('\n');
    const longReq = `### 需求文档\n${'甲'.repeat(30000)}`;
    const longTpl = `模板全文${'乙'.repeat(10000)}`;
    const prompt = buildCaseGenSystemPrompt(
      cfg({
        reqBlock: longReq,
        templateBody: longTpl,
        testPointIds: Array.from({ length: 120 }, (_, i) => `TP-${String(i + 1).padStart(3, '0')}`),
        testPointBlock: longTp,
      }),
      '大批量',
    );
    assert.ok(prompt.includes(longReq), '需求正文应完整注入');
    assert.ok(prompt.includes(longTpl), '模板正文应完整注入');
    assert.ok(prompt.includes('TP-120'), '末尾测试点应完整注入');
    assert.ok(prompt.includes('共 120 条'));
    assert.ok(prompt.includes('不要声称「材料未提供后半段测试点」'));
    assert.ok(prompt.includes('必须按上文材料的需求顺序输出'));
    assert.ok(prompt.includes('待业务确认'));
    assert.ok(prompt.includes('备注'));
  });
});

describe('ensureCaseRemarkHeader / promotePendingConfirmCases', () => {
  it('模板没有备注列时自动补上', () => {
    assert.deepEqual(ensureCaseRemarkHeader(['用例编号', '用例标题']), [
      '用例编号',
      '用例标题',
      '备注',
    ]);
    assert.deepEqual(ensureCaseRemarkHeader(['用例标题', '备注说明']), ['用例标题', '备注说明']);
  });

  it('把未覆盖里的待业务确认项补成用例并剔除', () => {
    const { cases, uncovered } = promotePendingConfirmCases(
      [{ 用例标题: '已有用例', 备注: '' }],
      ['删除父节点时子节点的级联规则待业务确认。', '完全缺失的无关材料', '空节点占位符格式待确认'],
      ['用例标题', '测试步骤', '预期结果', '备注'],
    );
    assert.equal(cases.length, 3);
    assert.deepEqual(uncovered, ['完全缺失的无关材料']);
    const pending = cases.slice(1) as Array<Record<string, string>>;
    assert.match(pending[0]!.备注, /待业务确认/);
    assert.match(pending[0]!.用例标题, /删除父节点/);
    assert.match(pending[1]!.备注, /待确认|待业务确认/);
  });
});

describe('caseGenFileBase', () => {
  const fixed = new Date(2026, 9, 23, 17, 24, 5);

  it('需求名 + 类型后缀 + 时间戳', () => {
    assert.equal(
      caseGenFileBase('政企通', 'functional', fixed),
      '政企通_功能测试用例_20261023-172405',
    );
    assert.equal(caseGenFileBase('政企通', 'api', fixed), '政企通_接口测试用例_20261023-172405');
  });

  it('需求文档文件名收成「需求+迭代版本」', () => {
    assert.equal(
      caseGenFileBase('政企通v1.16.0版本_需求文档.xlsx', 'functional', fixed),
      '政企通v1.16.0迭代版本_功能测试用例_20261023-172405',
    );
    assert.equal(
      caseGenFileBase('政企通v1.16.0版本', 'functional', fixed),
      '政企通v1.16.0迭代版本_功能测试用例_20261023-172405',
    );
    assert.equal(
      caseGenFileBase('政企通v1.16.0', 'functional', fixed),
      '政企通v1.16.0迭代版本_功能测试用例_20261023-172405',
    );
  });

  it('标题已带类型后缀或时间戳时不重复拼接', () => {
    assert.equal(
      caseGenFileBase('政企通_功能测试用例', 'functional', fixed),
      '政企通_功能测试用例_20261023-172405',
    );
    assert.equal(
      caseGenFileBase('政企通_功能测试用例_20261023-100000', 'functional', fixed),
      '政企通_功能测试用例_20261023-172405',
    );
  });
});

describe('caseReqMatchKey / caseFileMatchesReqTitle', () => {
  it('匹配键只保留前缀+版本号，不含版本/迭代版本', () => {
    assert.equal(caseReqMatchKey('政企通v1.16.0版本_需求文档.xlsx'), '政企通v1.16.0');
    assert.equal(
      caseReqMatchKey('政企通v1.16.0迭代版本_功能测试用例_20261023-214822.xlsx'),
      '政企通v1.16.0',
    );
    assert.equal(
      caseReqMatchKey('政企通v1.16.0版本_功能测试用例_20261023-214822.xlsx'),
      '政企通v1.16.0',
    );
  });

  it('「版本」与「迭代版本」文件名能对上', () => {
    assert.equal(
      caseFileMatchesReqTitle(
        '政企通v1.16.0版本_功能测试用例_20261023-214822.xlsx',
        '政企通v1.16.0版本_需求文档.xlsx',
      ),
      true,
    );
    assert.equal(
      caseFileMatchesReqTitle(
        '政企通v1.16.0迭代版本_功能测试用例_20261023-214822.xlsx',
        '政企通v1.16.0版本_需求文档.xlsx',
      ),
      true,
    );
  });

  it('不同产品或版本不对上', () => {
    assert.equal(
      caseFileMatchesReqTitle(
        '政企通v1.16.0版本_功能测试用例_20261023-214822.xlsx',
        '运管系统v1.10.0版本_需求文档.xlsx',
      ),
      false,
    );
    assert.equal(
      caseFileMatchesReqTitle(
        '政企通v1.17.0版本_功能测试用例_20261023-214822.xlsx',
        '政企通v1.16.0版本_需求文档.xlsx',
      ),
      false,
    );
  });
});

describe('sortGeneratedCaseRows', () => {
  it('按用户故事顺序重排乱序用例', () => {
    const headers = ['用例编号', '用例标题', '需求编号'];
    const sorted = sortGeneratedCaseRows(
      [
        { 用例编号: '3', 用例标题: 'C', 需求编号: 'US-003' },
        { 用例编号: '1', 用例标题: 'A', 需求编号: 'US-001' },
        { 用例编号: '2', 用例标题: 'B', 需求编号: 'US-002' },
      ],
      headers,
      { storyIds: ['US-001', 'US-002', 'US-003'] },
    );
    assert.deepEqual(
      sorted.map((r) => r['需求编号']),
      ['US-001', 'US-002', 'US-003'],
    );
  });

  it('Ideal 行序：菜单(US-018)排到页面管理(US-001)之前，不被故事编号带走', () => {
    const order = ['政企通', '政企通页面管理', '政企通信息管理'];
    assert.equal(idealOrderRank('政企通页面管理', order), 1);
    assert.ok(idealOrderRank('政企通页面管理', order) > idealOrderRank('政企通', order));
    // 短名「政企通」不能被更长键 via includes 吞成页面管理
    assert.equal(idealOrderRank('政企通', order), 0);

    const headers = ['用例编号', '模块', '子模块', '用例标题', '需求编号'];
    const sorted = sortGeneratedCaseRows(
      [
        {
          用例编号: '1',
          模块: '政企通',
          子模块: '政企通页面管理',
          用例标题: '节点',
          需求编号: 'US-001',
        },
        {
          用例编号: '159',
          模块: '政企通',
          子模块: '政企通',
          用例标题: '政企通菜单-三类角色',
          需求编号: 'US-018',
        },
        {
          用例编号: '151',
          模块: '政企通',
          子模块: '政企通',
          用例标题: '政企通-节点维护页互锁',
          需求编号: 'US-017',
        },
        {
          用例编号: '50',
          模块: '政企通',
          子模块: '政企通信息管理',
          用例标题: '信息',
          需求编号: 'US-006',
        },
      ],
      headers,
      { idealOrder: order, storyIds: ['US-001', 'US-006', 'US-017', 'US-018'] },
    );
    assert.deepEqual(
      sorted.map((r) => r['用例标题']),
      ['政企通菜单-三类角色', '政企通-节点维护页互锁', '节点', '信息'],
    );
  });

  it('子模块误标成「政企通」时，标题里的更长小模块名仍能对齐到正确行', () => {
    const order = ['政企通', '政企通页面管理', '政企通信息管理'];
    const headers = ['模块', '子模块', '用例标题', '需求编号'];
    const sorted = sortGeneratedCaseRows(
      [
        {
          模块: '政企通',
          子模块: '政企通',
          用例标题: '政企通信息管理-知识库团队进入-全量数据',
          需求编号: 'US-009',
        },
        {
          模块: '政企通',
          子模块: '政企通',
          用例标题: '政企通菜单-三类角色登录',
          需求编号: 'US-018',
        },
        {
          模块: '政企通',
          子模块: '政企通页面管理',
          用例标题: '政企通页面管理-添加下级',
          需求编号: 'US-001',
        },
      ],
      headers,
      { idealOrder: order },
    );
    assert.deepEqual(
      sorted.map((r) => r['用例标题']),
      [
        '政企通菜单-三类角色登录',
        '政企通页面管理-添加下级',
        '政企通信息管理-知识库团队进入-全量数据',
      ],
    );
  });

  it('子模块精确等于 Ideal 小模块时按行序排', () => {
    const headers = ['模块', '子模块', '用例标题'];
    const sorted = sortGeneratedCaseRows(
      [
        { 模块: '政企通', 子模块: '政企通信息管理', 用例标题: '信息' },
        { 模块: '政企通', 子模块: '政企通', 用例标题: '菜单权限' },
        { 模块: '政企通', 子模块: '政企通页面管理', 用例标题: '页面' },
      ],
      headers,
      { idealOrder: ['政企通', '政企通页面管理', '政企通信息管理'] },
    );
    assert.deepEqual(
      sorted.map((r) => r['用例标题']),
      ['菜单权限', '页面', '信息'],
    );
  });

  it('不同用例模板表头（小模块 / 测试分项目）仍按需求章节序排', () => {
    const order = ['账号登录', '订单提交', '支付回调'];
    const headers = ['用例编号', '所属模块', '小模块', '测试分项目', '需求编号'];
    const sorted = sortGeneratedCaseRows(
      [
        {
          用例编号: '3',
          所属模块: '交易',
          小模块: '支付回调',
          测试分项目: '回调验签失败',
          需求编号: 'US-003',
        },
        {
          用例编号: '1',
          所属模块: '交易',
          小模块: '账号登录',
          测试分项目: '密码正确登录',
          需求编号: 'US-001',
        },
        {
          用例编号: '2',
          所属模块: '交易',
          小模块: '订单提交',
          测试分项目: '库存不足拦截',
          需求编号: 'US-002',
        },
      ],
      headers,
      { idealOrder: order, storyIds: ['US-003', 'US-001', 'US-002'] },
    );
    assert.deepEqual(
      sorted.map((r) => r['测试分项目']),
      ['密码正确登录', '库存不足拦截', '回调验签失败'],
    );
  });

  it('无子模块列时用所属模块 + 标题对齐 Markdown 章节序', () => {
    const order = ['登录', '下单'];
    const headers = ['所属模块', '用例标题'];
    const sorted = sortGeneratedCaseRows(
      [
        { 所属模块: '商城', 用例标题: '下单-库存不足' },
        { 所属模块: '商城', 用例标题: '登录-验证码错误' },
      ],
      headers,
      { idealOrder: order },
    );
    assert.deepEqual(
      sorted.map((r) => r['用例标题']),
      ['登录-验证码错误', '下单-库存不足'],
    );
  });

  it('Ideal 表写层级路径（大模块,小模块）时，叶子子模块也能对上正确行', () => {
    // 需求表小模块是「调查问卷管理,问卷回收列表」这种层级路径，用例子模块只写叶子名
    const order = ['调查问卷管理', '调查问卷管理,创建问卷', '调查问卷管理,问卷回收列表'];
    const headers = ['模块', '子模块', '用例标题'];
    const sorted = sortGeneratedCaseRows(
      [
        { 模块: '调查问卷', 子模块: '问卷回收列表', 用例标题: '回收列表查询' },
        { 模块: '调查问卷', 子模块: '创建问卷', 用例标题: '创建问卷' },
        { 模块: '调查问卷', 子模块: '调查问卷管理', 用例标题: '问卷管理入口' },
      ],
      headers,
      { idealOrder: order },
    );
    assert.deepEqual(
      sorted.map((r) => r['用例标题']),
      ['问卷管理入口', '创建问卷', '回收列表查询'],
    );
  });

  it('同名的裸小模块优先整键命中，不被层级路径抢走', () => {
    // 「我的问卷,移动端」在前，但用例子模块只写「移动端」→ 应归到裸键「移动端」
    const order = ['我的问卷,移动端', '我的问卷,PC端', '移动端'];
    const headers = ['模块', '子模块', '用例标题'];
    const sorted = sortGeneratedCaseRows(
      [
        { 模块: '问卷', 子模块: '移动端', 用例标题: '移动端答题' },
        { 模块: '问卷', 子模块: '我的问卷,移动端', 用例标题: '移动端我的问卷' },
      ],
      headers,
      { idealOrder: order },
    );
    assert.deepEqual(
      sorted.map((r) => r['用例标题']),
      ['移动端我的问卷', '移动端答题'],
    );
  });

  it('有需求条目序时以「引用需求点」的 RO 为主口径，先于 Ideal 与 US 编号', () => {
    const headers = ['用例编号', '模块', '子模块', '用例标题', '需求编号', '引用需求点'];
    const sorted = sortGeneratedCaseRows(
      [
        // 子模块看着在前面，但引用的是第 3 个需求条目
        {
          用例编号: '1',
          模块: '调查问卷',
          子模块: '创建问卷',
          用例标题: '回复问卷',
          需求编号: 'US-001',
          引用需求点: 'RO-E-1-3 小程序的问卷回答；TP-021',
        },
        {
          用例编号: '2',
          模块: '调查问卷',
          子模块: '问卷回收列表',
          用例标题: '创建问卷',
          需求编号: 'US-003',
          引用需求点: 'RO-E-1-2 创建问卷；TP-011',
        },
        {
          用例编号: '3',
          模块: '调查问卷',
          子模块: '我的问卷,移动端',
          用例标题: '问卷管理入口',
          需求编号: 'US-009',
          引用需求点: 'RO-E-1-1 问卷管理；TP-002',
        },
      ],
      headers,
      {
        outlineOrder: ['RO-E-1-1', 'RO-E-1-2', 'RO-E-1-3'],
        testPointIds: ['TP-002', 'TP-011', 'TP-021'],
        idealOrder: ['调查问卷管理', '调查问卷管理,创建问卷', '调查问卷管理,问卷回收列表'],
        storyIds: ['US-001', 'US-003', 'US-009'],
      },
    );
    assert.deepEqual(
      sorted.map((r) => r['用例标题']),
      ['问卷管理入口', '创建问卷', '回复问卷'],
    );
  });

  it('同一条目内按测试点序；没有 TP 的行落到该条目末尾并保持原序', () => {
    const headers = ['用例编号', '用例标题', '引用需求点'];
    const sorted = sortGeneratedCaseRows(
      [
        { 用例编号: '1', 用例标题: '无测试点甲', 引用需求点: 'RO-E-1-1 问卷管理' },
        { 用例编号: '2', 用例标题: '测试点二', 引用需求点: 'RO-E-1-1 问卷管理；TP-012' },
        { 用例编号: '3', 用例标题: '无测试点乙', 引用需求点: 'RO-E-1-1 问卷管理' },
        { 用例编号: '4', 用例标题: '测试点一', 引用需求点: 'RO-E-1-1 问卷管理；TP-005' },
      ],
      headers,
      { outlineOrder: ['RO-E-1-1'], testPointIds: ['TP-005', 'TP-012'] },
    );
    assert.deepEqual(
      sorted.map((r) => r['用例标题']),
      ['测试点一', '测试点二', '无测试点甲', '无测试点乙'],
    );
  });

  it('没有引用需求点时用故事来源条目反查条目序', () => {
    const headers = ['用例编号', '用例标题', '需求编号'];
    const sorted = sortGeneratedCaseRows(
      [
        { 用例编号: '1', 用例标题: '乙', 需求编号: 'US-002' },
        { 用例编号: '2', 用例标题: '甲', 需求编号: 'US-001' },
      ],
      headers,
      {
        outlineOrder: ['RO-E-1-1', 'RO-E-1-2', 'RO-E-1-3'],
        storySourceRefs: new Map([
          ['US-001', ['RO-E-1-3']],
          ['US-002', ['RO-E-1-1']],
        ]),
      },
    );
    assert.deepEqual(
      sorted.map((r) => r['用例标题']),
      ['乙', '甲'],
    );
  });

  it('parseCiteIds 同时取出 RO 与 TP（大小写归一）', () => {
    assert.deepEqual(parseCiteIds('RO-E-1-2 创建问卷；tp-011；RO-E-1-3 回答'), {
      roIds: ['RO-E-1-2', 'RO-E-1-3'],
      tpIds: ['TP-011'],
    });
    assert.deepEqual(parseCiteIds('US-001'), { roIds: [], tpIds: [] });
  });
});

describe('normalizeReqCiteValue', () => {
  const outline = new Map([
    ['RO-1-4', { title: '政企通页面管理树状展示查询', quote: '【政企通页面管理】树状展示' }],
    ['RO-1-5', { title: '政企通页面管理节点修改' }],
  ]);
  const storyRefs = new Map([['US-001', ['RO-1-4', 'RO-1-5']]]);

  it('混写 US 与 RO 时只保留 RO 并补标题', () => {
    const out = normalizeReqCiteValue('US-001 / RO-1-4', {
      outlineById: outline,
      storySourceRefs: storyRefs,
    });
    assert.equal(out, 'RO-1-4 【政企通页面管理】树状展示');
  });

  it('仅 US 时用故事来源条目替换', () => {
    const out = normalizeReqCiteValue('US-001', {
      outlineById: outline,
      storySourceRefs: storyRefs,
    });
    assert.match(out, /^RO-1-4 /);
    assert.match(out, /RO-1-5 /);
  });

  it('去掉全局测试点前缀', () => {
    const out = normalizeReqCiteValue('全局测试点：RO-1-5', { outlineById: outline });
    assert.equal(out, 'RO-1-5 政企通页面管理节点修改');
  });

  it('formatReqCiteCell 编号在前且不重复', () => {
    assert.equal(formatReqCiteCell('RO-1-4', '标题'), 'RO-1-4 标题');
    assert.equal(formatReqCiteCell('RO-1-4', 'RO-1-4 标题'), 'RO-1-4 标题');
  });

  it('保留测试点编号并排在 RO 之后', () => {
    assert.equal(
      normalizeReqCiteValue('RO-1-4 树状展示查询；TP-012', { outlineById: outline }),
      'RO-1-4 【政企通页面管理】树状展示；TP-012',
    );
    // 只写 TP 时也不会被吃掉
    assert.equal(normalizeReqCiteValue('tp-007', { outlineById: outline }), 'TP-007');
  });

  it('从材料 Markdown 解析 outline 与故事来源', () => {
    const block = [
      '## 需求条目',
      '1. **RO-1-4** 树状展示查询',
      '> 原文摘录甲',
      '### US-002 某故事',
      '',
      '- **来源条目**：RO-1-4',
    ].join('\n');
    const o = parseOutlineLookupFromReqBlock(block);
    assert.equal(o.get('RO-1-4')?.title, '树状展示查询');
    assert.equal(o.get('RO-1-4')?.quote, '原文摘录甲');
    const s = parseStorySourceRefsFromReqBlock(block);
    assert.deepEqual(s.get('US-002'), ['RO-1-4']);
  });
});
