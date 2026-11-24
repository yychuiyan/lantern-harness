import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeCaseExecutionStatus, summarizeCaseExecution } from './case-execution';

describe('用例执行统计口径', () => {
  it('兼容 P/F 等历史状态', () => {
    assert.equal(normalizeCaseExecutionStatus('P'), '通过');
    assert.equal(normalizeCaseExecutionStatus('F'), '不通过');
    assert.equal(normalizeCaseExecutionStatus('blocked'), '阻塞');
    assert.equal(normalizeCaseExecutionStatus('N/A'), '跳过');
    assert.equal(normalizeCaseExecutionStatus(''), '待验证');
  });

  it('已执行不包含待验证，并按状态拆分数量', () => {
    const summary = summarizeCaseExecution([
      { status: '通过' },
      { status: 'P' },
      { status: '不通过' },
      { status: 'F' },
      { status: '阻塞' },
      { status: '跳过' },
      { status: '待验证' },
      { status: '' },
    ]);
    assert.deepEqual(summary, {
      total: 8,
      executed: 6,
      pending: 2,
      passed: 2,
      failed: 2,
      blocked: 1,
      skipped: 1,
      executionRate: 75,
    });
  });

  it('空文件不产生虚假执行率', () => {
    assert.deepEqual(summarizeCaseExecution([]), {
      total: 0,
      executed: 0,
      pending: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      executionRate: 0,
    });
  });
});
