import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dateInRange,
  detectReportKindFromText,
  formatReportContext,
  rangesOverlap,
  reportPeriod,
} from './report-context';

describe('report-context', () => {
  it('reportPeriod: day / week / month', () => {
    // 2026-10-24 周六 → 周一 10-19 ~ 周日 10-25
    const sat = new Date(2026, 9, 24, 12, 0, 0);
    assert.deepEqual(reportPeriod('day', sat), {
      from: '2026-10-24',
      to: '2026-10-24',
      label: '日报（2026.10.24）',
    });
    assert.deepEqual(reportPeriod('week', sat), {
      from: '2026-10-19',
      to: '2026-10-25',
      label: '周报（2026.10.19-2026.10.25）',
    });
    assert.deepEqual(reportPeriod('month', sat), {
      from: '2026-10-01',
      to: '2026-10-31',
      label: '月报（2026.10）',
    });
  });

  it('dateInRange / rangesOverlap', () => {
    assert.equal(dateInRange('2026-10-20', '2026-10-19', '2026-10-25'), true);
    assert.equal(dateInRange('2026-10-18', '2026-10-19', '2026-10-25'), false);
    assert.equal(rangesOverlap('2026-10-18', '2026-10-20', '2026-10-19', '2026-10-25'), true);
    assert.equal(rangesOverlap('2026-10-01', '2026-10-05', '2026-10-19', '2026-10-25'), false);
  });

  it('detectReportKindFromText', () => {
    assert.equal(detectReportKindFromText('生成日报'), 'day');
    assert.equal(detectReportKindFromText('生成周报，顺便带上测试进度'), 'week');
    assert.equal(detectReportKindFromText('生成月报'), 'month');
    assert.equal(detectReportKindFromText('写一份周报'), null);
  });

  it('formatReportContext includes test stats and case exec', () => {
    const md = formatReportContext({
      period: { from: '2026-10-19', to: '2026-10-25', label: '周报（2026.10.19-2026.10.25）' },
      include: { todos: false, tasks: false, testStats: true, caseExec: true },
      testStats: [
        {
          id: '1',
          date: '2026-10-20',
          dimensions: ['功能测试用例'],
          count: 12,
          draft: false,
          source: 'manual',
          sessionId: '',
          createdAt: '2026-10-20T01:00:00.000Z',
          updatedAt: '2026-10-20T01:00:00.000Z',
        },
      ],
      caseExec: [
        {
          id: '2',
          date: '2026-10-21',
          project: '政企通',
          startDate: '2026-10-01',
          endDate: '2026-10-31',
          total: 100,
          pending: 40,
          executed: 60,
          draft: false,
          source: 'manual',
          sessionId: '',
          createdAt: '2026-10-21T01:00:00.000Z',
          updatedAt: '2026-10-21T01:00:00.000Z',
        },
      ],
    });
    assert.match(md, /### 测试统计/);
    assert.match(md, /功能测试用例：12/);
    assert.match(md, /### 用例执行统计/);
    assert.match(md, /政企通/);
    assert.match(md, /60\.00%/);
    assert.doesNotMatch(md, /### 待办事项/);
  });
});
