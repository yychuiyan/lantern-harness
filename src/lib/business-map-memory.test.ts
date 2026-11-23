import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  readBusinessMapMemory,
  readBusinessMapSystemFilter,
  readBusinessMapSystemSort,
  writeBusinessMapMemory,
  writeBusinessMapSystemFilter,
  writeBusinessMapSystemSort,
} from './business-map-memory';
import { rememberActiveSpaceId } from './space-scope';
import { writeViewJson } from './view-prefs';

const mem = new Map<string, string>();

function mockLocalStorage(): Storage {
  return {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => {
      mem.set(key, value);
    },
    removeItem: (key: string) => {
      mem.delete(key);
    },
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  } as Storage;
}

beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: Storage }).localStorage = mockLocalStorage();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = mockLocalStorage();
});

describe('业务地图操作记忆', () => {
  it('没有记录时返回 null', () => {
    assert.equal(readBusinessMapMemory(), null);
  });

  it('刷新后恢复系统、主 Tab、详情 Tab 和选中项', () => {
    rememberActiveSpaceId('sp_quality');
    const memory = {
      systemId: 'sys_1',
      view: 'flows' as const,
      systemQuery: '工单',
      query: '受理',
      domain: '受理域',
      functionFilter: 'unlinked' as const,
      selectedFunctionId: 'fn_1',
      selectedDirectoryId: 'dir_1',
      expandedDirectoryIds: ['dir_1', 'dir_2'],
      selectedFlowId: 'flow_1',
      selectedStepId: 'step_2',
      detailTab: 'rules' as const,
      detailOpen: true,
    };
    writeBusinessMapMemory(memory);
    assert.deepEqual(readBusinessMapMemory(), memory);
  });

  it('脏数据回退安全默认值', () => {
    writeViewJson('business-map.navigation', {
      systemId: 12,
      view: 'unknown',
      query: 'x'.repeat(260),
      domain: '',
      functionFilter: 'unknown',
      detailTab: 'unknown',
      detailOpen: 'yes',
    });
    const memory = readBusinessMapMemory();
    assert.equal(memory?.systemId, '');
    assert.equal(memory?.view, 'functions');
    assert.equal(memory?.query.length, 200);
    assert.equal(memory?.domain, '全部');
    assert.equal(memory?.functionFilter, 'all');
    assert.equal(memory?.detailTab, 'overview');
    assert.equal(memory?.detailOpen, undefined);
  });

  it('卡片筛选与排序按空间记住', () => {
    rememberActiveSpaceId('sp_a');
    writeBusinessMapSystemFilter('pending');
    writeBusinessMapSystemSort('name');
    assert.equal(readBusinessMapSystemFilter(), 'pending');
    assert.equal(readBusinessMapSystemSort(), 'name');

    rememberActiveSpaceId('sp_b');
    assert.equal(readBusinessMapSystemFilter(), 'all');
    assert.equal(readBusinessMapSystemSort(), 'updated');
  });
});
