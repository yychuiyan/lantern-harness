import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { autoCompactThresholdChars } from './session-compact';

describe('model caps compact threshold', () => {
  it('优先用 contextWindow 覆盖', () => {
    const withOverride = autoCompactThresholdChars('deepseek-flash', 10_000);
    const without = autoCompactThresholdChars('deepseek-flash');
    assert.ok(withOverride < without);
    assert.equal(autoCompactThresholdChars(undefined, undefined), 80_000);
  });
});
