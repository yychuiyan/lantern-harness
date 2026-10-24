/**
 * 场景补全写回：按归属需求插入，而不是整份追加到末尾。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blindspotWritebackInstruction } from './case-fix-jump';
import type { BlindspotItem } from './case-review';

function item(over: Partial<BlindspotItem> = {}): BlindspotItem {
  return {
    id: over.id ?? 'bs_1',
    category: over.category ?? 'business',
    severity: over.severity ?? 'medium',
    title: over.title ?? '金额舍入',
    why: over.why ?? '人工容易漏',
    precondition: over.precondition ?? '',
    steps: over.steps ?? ['提交订单'],
    expected: over.expected ?? '显示两位小数',
    priority: over.priority ?? 'P1',
    reqAnchor: over.reqAnchor ?? '',
    added: over.added ?? false,
    caseNo: over.caseNo ?? '',
  };
}

describe('blindspotWritebackInstruction', () => {
  it('要求按归属需求插入分组，禁止默认追加到末尾', () => {
    const text = blindspotWritebackInstruction({
      path: 'cases/demo.md',
      name: 'demo.md',
      requirementTitle: '订单结算',
      items: [item({ reqAnchor: '提交退款申请' })],
    });
    assert.match(text, /归属需求：提交退款申请/);
    assert.match(text, /对照需求：订单结算/);
    assert.match(text, /必须插到「归属需求」对应分组的最后一行之后/);
    assert.match(text, /禁止整批发到文件末尾/);
    assert.match(text, /再补一个自定义编号/);
    assert.equal(text.includes('只追加这些新用例'), false);
  });

  it('未标归属时提示按标题推断，xlsx 交付要标明插入位置', () => {
    const text = blindspotWritebackInstruction({
      path: 'cases/ideal.xlsx',
      items: [item({ reqAnchor: '' })],
    });
    assert.match(text, /归属需求：（未标/);
    assert.match(text, /标明每条应插在哪个归属需求分组/);
    assert.match(text, /不要默认贴到末尾/);
  });
});
