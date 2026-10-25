import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizePlanPhase, normalizePlanProposal } from './session-plan';

describe('session-plan normalize', () => {
  it('normalizePlanPhase', () => {
    assert.equal(normalizePlanPhase('planning'), 'planning');
    assert.equal(normalizePlanPhase('approved'), 'approved');
    assert.equal(normalizePlanPhase('off'), 'off');
    assert.equal(normalizePlanPhase(null), 'off');
  });

  it('normalizePlanProposal', () => {
    assert.equal(normalizePlanProposal(null), null);
    assert.equal(normalizePlanProposal({ title: 'x' }), null);
    const p = normalizePlanProposal({
      title: '改登录',
      summary: '…',
      steps: ['a', 'b', ''],
    });
    assert.ok(p);
    assert.equal(p!.title, '改登录');
    assert.deepEqual(p!.steps, ['a', 'b']);
  });
});
