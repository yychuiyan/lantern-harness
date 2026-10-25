import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSession, forkSession, type SessionStore } from './sessions';

function blankStore(): SessionStore {
  return createSession({ sessions: [], activeId: '' }, { access: 'readwrite' });
}

describe('forkSession', () => {
  it('复制消息到新会话，不写 parent 字段，源会话不变', () => {
    let store = blankStore();
    const srcId = store.activeId;
    store = {
      ...store,
      sessions: store.sessions.map((s) =>
        s.id === srcId
          ? {
              ...s,
              title: '需求审查',
              messages: [
                { role: 'user', content: '你好' },
                { role: 'assistant', content: '在' },
              ],
            }
          : s,
      ),
    };

    const next = forkSession(store, srcId);
    assert.notEqual(next.activeId, srcId);
    const forked = next.sessions.find((s) => s.id === next.activeId && s.id !== srcId);
    const src = next.sessions.find((s) => s.id === srcId);
    assert.ok(forked);
    assert.ok(src);
    assert.equal(forked!.messages.length, 2);
    assert.equal((forked!.messages[0] as { content?: string }).content, '你好');
    assert.match(forked!.title, /分叉/);
    assert.equal(src!.messages.length, 2);
    assert.equal(src!.title, '需求审查');
    assert.equal('parentSessionId' in forked!, false);
    assert.equal((forked as { parentSessionId?: string }).parentSessionId, undefined);
    // 改分叉消息不影响源
    (forked!.messages[0] as { content: string }).content = '改过';
    assert.equal((src!.messages[0] as { content?: string }).content, '你好');
  });

  it('找不到源会话时原样返回', () => {
    const store = blankStore();
    assert.equal(forkSession(store, 'missing'), store);
  });
});
