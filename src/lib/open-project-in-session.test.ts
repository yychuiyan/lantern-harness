import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeDirPath, pickWorkspaceSession, sameDirPath } from './open-project-in-session';
import { matchProjectByDir, normalizeProjectDir, type UiAutoProject } from './ui-auto';
import type { ChatSession } from './sessions';

function session(partial: Partial<ChatSession>): ChatSession {
  return {
    id: 's1',
    title: '会话',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    ...partial,
  } as ChatSession;
}

function project(id: string, dir: string): UiAutoProject {
  return {
    id,
    name: id,
    dir,
    framework: 'playwright',
    frameworkLabel: 'Playwright',
    kind: 'ui',
    runner: 'npx playwright test',
    createdAt: '',
    lastRunId: '',
    lastRunAt: '',
    lastStatus: '',
    exists: true,
    controls: [],
    frameworkReady: true,
    readyHint: '',
    packageManager: 'pnpm',
    mountable: true,
    runningRunId: '',
    candidates: [],
    specFiles: [],
    projectNames: [],
    runTasks: [],
    customTasks: [],
  };
}

describe('目录归一（工作区 / 项目匹配）', () => {
  it('统一斜杠、去尾部斜杠与空白', () => {
    assert.equal(normalizeDirPath('  /a/b/c/  '), '/a/b/c');
    assert.equal(normalizeDirPath('/a\\b\\c'), '/a/b/c');
    assert.equal(normalizeProjectDir('/a/b///'), '/a/b');
    assert.equal(normalizeDirPath(''), '');
  });

  it('空路径不相同', () => {
    assert.equal(sameDirPath('', ''), false);
    assert.equal(sameDirPath('/a', ''), false);
  });

  it('不同写法的同一目录视为相同（忽略大小写）', () => {
    assert.equal(sameDirPath('/Users/Me/Proj/', '/Users/Me/Proj'), true);
    assert.equal(sameDirPath('/Users/Me/Proj', '/users/me/proj'), true);
    assert.equal(sameDirPath('/Users/Me/Proj', '/Users/Me/Other'), false);
  });
});

describe('复用同目录会话', () => {
  it('只认未归档、未删除且工作区一致的会话', () => {
    const sessions = [
      session({ id: 'archived', workspacePath: '/p/a', archived: true, updatedAt: 99 }),
      session({ id: 'deleted', workspacePath: '/p/a', deleted: true, updatedAt: 98 }),
      session({ id: 'other', workspacePath: '/p/b', updatedAt: 97 }),
      session({ id: 'hit', workspacePath: '/p/a/', updatedAt: 5 }),
    ];
    assert.equal(pickWorkspaceSession(sessions, '/p/a')?.id, 'hit');
  });

  it('多个同名会话取最近更新的那个', () => {
    const sessions = [
      session({ id: 'old', workspacePath: '/p/a', updatedAt: 10 }),
      session({ id: 'new', workspacePath: '/p/a', updatedAt: 20 }),
      session({ id: 'mid', workspacePath: '/p/a', updatedAt: 15 }),
    ];
    assert.equal(pickWorkspaceSession(sessions, '/p/a')?.id, 'new');
  });

  it('没有匹配或目录为空时返回 null', () => {
    assert.equal(pickWorkspaceSession([], '/p/a'), null);
    assert.equal(pickWorkspaceSession([session({ workspacePath: '/p/a' })], ''), null);
    assert.equal(pickWorkspaceSession([session({ workspacePath: '' })], '/p/a'), null);
  });
});

describe('工作台工作区匹配自动化项目', () => {
  const projects = [project('a', '/p/a'), project('b', 'C:\\work\\b')];

  it('精确目录命中', () => {
    assert.equal(matchProjectByDir(projects, '/p/a')?.id, 'a');
    assert.equal(matchProjectByDir(projects, '/p/a/')?.id, 'a');
  });

  it('反斜杠路径也能命中', () => {
    assert.equal(matchProjectByDir(projects, 'C:/work/b')?.id, 'b');
  });

  it('匹配不到返回 null', () => {
    assert.equal(matchProjectByDir(projects, '/p/c'), null);
    assert.equal(matchProjectByDir(projects, ''), null);
  });
});
