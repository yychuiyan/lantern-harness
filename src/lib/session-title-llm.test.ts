import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstUserText, sanitizeLlmTitle, shouldGenerateLlmTitle } from './session-title-llm';

describe('session-title-llm', () => {
  it('firstUserText picks first user', () => {
    assert.equal(
      firstUserText([
        { role: 'assistant', content: 'x' },
        { role: 'user', content: '  你好  ' },
      ]),
      '你好',
    );
  });

  it('shouldGenerateLlmTitle for default and auto titles', () => {
    const msgs = [{ role: 'user', content: '为登录写测试点' }];
    assert.equal(shouldGenerateLlmTitle('新对话', msgs), true);
    assert.equal(shouldGenerateLlmTitle('新编排', msgs), true);
    assert.equal(shouldGenerateLlmTitle('编排 11/11 17:26', msgs), true);
    assert.equal(shouldGenerateLlmTitle('为登录写测试点', msgs), true);
    assert.equal(shouldGenerateLlmTitle('我手改的标题', msgs), false);
  });

  it('sanitizeLlmTitle strips quotes and length', () => {
    assert.equal(sanitizeLlmTitle('「登录测试」'), '登录测试');
    assert.equal(sanitizeLlmTitle('标题：ABC'), 'ABC');
    const long = '啊'.repeat(40);
    assert.ok(sanitizeLlmTitle(long)!.endsWith('…'));
  });
});
