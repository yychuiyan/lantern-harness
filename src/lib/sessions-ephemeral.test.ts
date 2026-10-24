import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isEphemeralEmptySession,
  pruneEphemeralSessions,
  type ChatSession,
  type SessionStore,
} from './sessions';

function base(partial: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    title: '新对话',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    ...partial,
  };
}

describe('isEphemeralEmptySession', () => {
  it('discards empty session even with promptGen active', () => {
    assert.equal(
      isEphemeralEmptySession(
        base({
          title: '新对话',
          promptGen: { active: true, kind: '功能' } as ChatSession['promptGen'],
        }),
      ),
      true,
    );
  });

  it('keeps session that already has messages', () => {
    assert.equal(
      isEphemeralEmptySession(
        base({
          messages: [{ role: 'user', content: 'hi' }],
          knowledgeGen: { active: true } as ChatSession['knowledgeGen'],
        }),
      ),
      false,
    );
  });
});

describe('pruneEphemeralSessions', () => {
  it('drops sibling empty sessions but keeps the active one', () => {
    const store: SessionStore = {
      activeId: 'keep',
      sessions: [
        base({ id: 'keep', title: '新对话' }),
        base({ id: 'drop1', title: '新对话', createdAt: 2 }),
        base({
          id: 'keep-msg',
          title: '有内容',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ],
    };
    const next = pruneEphemeralSessions(store, 'keep');
    assert.deepEqual(next.sessions.map((s) => s.id).sort(), ['keep', 'keep-msg']);
    assert.equal(next.activeId, 'keep');
  });

  it('respects shouldKeep for drafts / task cards', () => {
    const store: SessionStore = {
      activeId: 'a',
      sessions: [base({ id: 'a' }), base({ id: 'with-task', createdAt: 2 })],
    };
    const next = pruneEphemeralSessions(store, 'a', (id) => id === 'with-task');
    assert.deepEqual(next.sessions.map((s) => s.id).sort(), ['a', 'with-task']);
  });
});
