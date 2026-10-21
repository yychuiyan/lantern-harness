/**
 * 用例生成插件配置：需求来源（文档 / 用户故事）的判定与提示词拼装。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseGenConfigLabel, caseGenReqSource, type CaseGenPluginConfig } from './case-gen-config';
import { buildCaseGenSystemPrompt } from './case-gen-run';

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
});
