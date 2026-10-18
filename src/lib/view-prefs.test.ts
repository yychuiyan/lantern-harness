import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { rememberActiveSpaceId } from './space-scope';
import { readViewPref, readViewText, writeViewPref, writeViewText } from './view-prefs';

const mem = new Map<string, string>();

function mockLocalStorage(): Storage {
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  } as Storage;
}

const TABS = ['all', 'pool', 'done'] as const;

beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: Storage }).localStorage = mockLocalStorage();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = mockLocalStorage();
});

describe('视图偏好记忆', () => {
  it('没记过时回退默认值', () => {
    assert.equal(readViewPref('tasks.status', TABS, 'all'), 'all');
  });

  it('写入后可读回（刷新即恢复上次的 Tab）', () => {
    writeViewPref('tasks.status', 'pool');
    assert.equal(readViewPref('tasks.status', TABS, 'all'), 'pool');
  });

  it('不在候选值里的脏数据回退默认值', () => {
    mem.set('tw.view.tasks.status.v1', 'not-a-tab');
    assert.equal(readViewPref('tasks.status', TABS, 'all'), 'all');
  });

  it('按数据空间分键：换空间不串', () => {
    rememberActiveSpaceId('sp_a');
    writeViewPref('todos.group', 'priority');
    assert.equal(
      readViewPref('todos.group', ['status', 'priority', 'none'] as const, 'status'),
      'priority',
    );

    rememberActiveSpaceId('sp_b');
    assert.equal(
      readViewPref('todos.group', ['status', 'priority', 'none'] as const, 'status'),
      'status',
    );
  });
});

describe('搜索词等自由文本偏好', () => {
  it('没记过时回退空串', () => {
    assert.equal(readViewText('tasks.search'), '');
  });

  it('写入后可读回，且按数据空间分开记', () => {
    rememberActiveSpaceId('sp_a');
    writeViewText('docs.prompts.search', '接口');
    assert.equal(readViewText('docs.prompts.search'), '接口');

    rememberActiveSpaceId('sp_b');
    assert.equal(readViewText('docs.prompts.search'), '');
  });

  it('空串等同清空，不会留下空值', () => {
    writeViewText('todos.search', '逾期');
    writeViewText('todos.search', '');
    assert.equal(readViewText('todos.search'), '');
    assert.equal(mem.has('tw.view.todos.search.v1'), false);
  });

  it('超长搜索词截断到上限，避免撑大本地存储', () => {
    writeViewText('case-exec.search', 'a'.repeat(500));
    assert.equal(readViewText('case-exec.search').length, 200);
  });
});
