import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildChatTools,
  chatToolsAllow,
  filterToolsForServerRun,
  isServerRunExcludedTool,
} from './chat-tool-registry';

function names(tools: ReturnType<typeof buildChatTools>): string[] {
  return tools.map((t) => t.function?.name ?? '').filter(Boolean);
}

describe('buildChatTools', () => {
  it('structuredPlugin 返回空', () => {
    assert.deepEqual(
      buildChatTools({
        access: 'full',
        structuredPlugin: true,
        caps: { fs: true, bash: true },
      }),
      [],
    );
  });

  it('readonly 不含 bash / 写工具', () => {
    const tools = buildChatTools({
      access: 'readonly',
      caps: { fs: true, bash: true, pwsh: true, web: true },
    });
    const n = names(tools);
    assert.ok(n.includes('fs_list') || n.includes('fs_read') || n.some((x) => x.startsWith('fs_')));
    assert.equal(n.includes('bash'), false);
    assert.equal(n.includes('pwsh'), false);
    assert.equal(n.includes('fs_write'), false);
  });

  it('关插件则不含对应工具；subagent/workflow 可关', () => {
    const withPm = names(
      buildChatTools({
        access: 'readwrite',
        caps: { todos: true, projects: true, subagent: true, workflow: true },
      }),
    );
    assert.ok(withPm.some((x) => x.startsWith('todo_')));
    assert.ok(withPm.includes('spawn_subagent'));
    assert.ok(withPm.includes('workflow'));

    const noExtra = names(
      buildChatTools({
        access: 'readwrite',
        caps: {
          todos: false,
          projects: false,
          subagent: false,
          workflow: false,
          interact: false,
          goal: false,
          schedule: false,
        },
      }),
    );
    assert.equal(noExtra.includes('spawn_subagent'), false);
    assert.equal(noExtra.includes('workflow'), false);
    assert.equal(noExtra.includes('ask_user_question'), false);
  });

  it('serverRun 过滤掉 subagent / ask / workflow', () => {
    const tools = buildChatTools({
      access: 'full',
      caps: { fs: true, subagent: true, workflow: true, interact: true },
      planPhase: 'planning',
    });
    assert.ok(isServerRunExcludedTool('spawn_subagent'));
    assert.ok(isServerRunExcludedTool('subagent_list'));
    const filtered = filterToolsForServerRun(tools);
    assert.equal(chatToolsAllow(filtered, 'spawn_subagent'), false);
    assert.equal(chatToolsAllow(filtered, 'ask_user_question'), false);
    assert.equal(chatToolsAllow(filtered, 'workflow'), false);
    assert.equal(chatToolsAllow(filtered, 'submit_plan'), false);
  });
});
