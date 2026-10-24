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
    assert.ok(prompt.includes('必须按上文材料出现的顺序输出'));
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
});
