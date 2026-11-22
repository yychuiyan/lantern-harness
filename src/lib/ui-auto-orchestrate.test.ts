import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatSession } from './sessions';
import {
  defaultOrchestrateTitle,
  displayOrchestrateTitle,
  filterGenSessionsByWorkbench,
  findOrchestrateSession,
  genSessionHasExecution,
  isPlaceholderOrchestrateTitle,
  isUiAutoOrchestrateSession,
  listOrchestrateSessionsForProject,
} from './ui-auto-orchestrate';

function session(partial: Partial<ChatSession>): ChatSession {
  return {
    id: 's1',
    title: '会话',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    ...partial,
  } as ChatSession;
}

describe('uiauto 编排标题', () => {
  it('defaultOrchestrateTitle 带日期时间', () => {
    const title = defaultOrchestrateTitle(new Date(2026, 10, 11, 17, 26, 0));
    assert.equal(title, '编排 11/11 17:26');
    assert.equal(isPlaceholderOrchestrateTitle(title), true);
    assert.equal(isPlaceholderOrchestrateTitle('工单新建页'), false);
  });
});

describe('uiauto 编排会话识别', () => {
  it('带 uiAuto.uiautoSessionId 的视为编排会话', () => {
    assert.equal(
      isUiAutoOrchestrateSession(session({ uiAuto: { projectId: 'p', uiautoSessionId: 'gen_1' } })),
      true,
    );
    assert.equal(isUiAutoOrchestrateSession(session({})), false);
  });

  it('按 uiautoSessionId 精确查找', () => {
    const sessions = [
      session({
        id: 'a',
        uiAuto: { projectId: 'p1', uiautoSessionId: 'gen_a' },
        updatedAt: 1,
      }),
      session({
        id: 'b',
        uiAuto: { projectId: 'p1', uiautoSessionId: 'gen_b' },
        updatedAt: 9,
      }),
    ];
    assert.equal(findOrchestrateSession(sessions, { uiautoSessionId: 'gen_a' })?.id, 'a');
  });

  it('同项目列表按更新时间倒序', () => {
    const sessions = [
      session({
        id: 'old',
        uiAuto: { projectId: 'p1', uiautoSessionId: 'g1' },
        updatedAt: 1,
      }),
      session({
        id: 'new',
        uiAuto: { projectId: 'p1', uiautoSessionId: 'g2' },
        updatedAt: 9,
      }),
      session({
        id: 'other',
        uiAuto: { projectId: 'p2', uiautoSessionId: 'g3' },
        updatedAt: 99,
      }),
    ];
    assert.deepEqual(
      listOrchestrateSessionsForProject(sessions, 'p1').map((s) => s.id),
      ['new', 'old'],
    );
  });

  it('展示标题去掉项目名前缀', () => {
    assert.equal(
      displayOrchestrateTitle('ui-automation · 输入账号密码登录成功'),
      '输入账号密码登录成功',
    );
    assert.equal(displayOrchestrateTitle('输入账号密码登录成功'), '输入账号密码登录成功');
  });

  it('未执行的草稿不算已进入编排', () => {
    assert.equal(genSessionHasExecution({ status: 'draft' }), false);
    assert.equal(genSessionHasExecution({ status: 'draft', plan: [] }), false);
    assert.equal(genSessionHasExecution({ status: 'draft', plan: [{ id: '1' }] }), true);
    assert.equal(genSessionHasExecution({ status: 'explored' }), true);
    assert.equal(genSessionHasExecution({ status: 'draft', ir: { steps: [{ id: 's1' }] } }), true);
  });

  it('工作台归档 / 删除后生成会话从下拉消失', () => {
    const chats = [
      session({
        id: 'live',
        uiAuto: { projectId: 'p1', uiautoSessionId: 'gen_live' },
      }),
      session({
        id: 'archived',
        archived: true,
        uiAuto: { projectId: 'p1', uiautoSessionId: 'gen_arch' },
      }),
      session({
        id: 'deleted',
        deleted: true,
        uiAuto: { projectId: 'p1', uiautoSessionId: 'gen_del' },
      }),
      // 仅工作台反查：生成侧没写 chatSessionId，归档后也应消失
      session({
        id: 'arch_only',
        archived: true,
        uiAuto: { projectId: 'p1', uiautoSessionId: 'gen_arch_unbound' },
      }),
    ];
    const gen = [
      { id: 'gen_live', chatSessionId: 'live' },
      { id: 'gen_arch', chatSessionId: 'archived' },
      { id: 'gen_del', chatSessionId: 'deleted' },
      { id: 'gen_orphan', chatSessionId: 'missing' },
      { id: 'gen_arch_unbound' },
      { id: 'gen_legacy' },
    ];
    assert.deepEqual(
      filterGenSessionsByWorkbench(gen, chats).map((g) => g.id),
      ['gen_live', 'gen_legacy'],
    );
  });
});
