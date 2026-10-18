import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { readReportKind, writeReportKind } from './report-tab';

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

beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: Storage }).localStorage = mockLocalStorage();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = mockLocalStorage();
});

describe('工作汇报：Tab 记忆', () => {
  it('没记过时回退到日报', () => {
    assert.equal(readReportKind(), 'day');
  });

  it('写入后可读回，刷新即恢复上次的 Tab', () => {
    writeReportKind('week');
    assert.equal(readReportKind(), 'week');
    writeReportKind('month');
    assert.equal(readReportKind(), 'month');
  });

  it('非法值回退到默认值', () => {
    mem.set('tw.reports.kind.v1', 'year');
    assert.equal(readReportKind(), 'day');
    assert.equal(readReportKind('week'), 'week');
  });

  it('非法入参不写入', () => {
    writeReportKind('year' as never);
    assert.equal(mem.size, 0);
  });
});
