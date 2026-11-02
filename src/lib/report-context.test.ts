import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dateInRange,
  detectReportKindFromText,
  filterCaseExec,
  formatReportContext,
  rangesOverlap,
  reportPeriod,
  wantsPreviousWeek,
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
    assert.equal(detectReportKindFromText('生成上一周周报'), 'week');
    assert.equal(detectReportKindFromText('生成月报'), 'month');
    assert.equal(detectReportKindFromText('写一份周报'), null);
  });

  it('wantsPreviousWeek / reportPeriod weekOffset', () => {
    assert.equal(wantsPreviousWeek('生成上一周周报'), true);
    assert.equal(wantsPreviousWeek('生成上周周报'), true);
    assert.equal(wantsPreviousWeek('生成周报'), false);
    const mon = new Date(2026, 10, 2, 9, 0, 0);
    assert.deepEqual(reportPeriod('week', mon), {
      from: '2026-11-02',
      to: '2026-11-08',
      label: '周报（2026.11.02-2026.11.08）',
    });
    assert.deepEqual(reportPeriod('week', mon, { weekOffset: -1 }), {
      from: '2026-10-26',
      to: '2026-11-01',
      label: '周报（2026.10.26-2026.11.01）',
    });
  });

  it('filterCaseExec: 统计日期落入区间或执行周期相交即纳入', () => {
    const from = '2026-11-02';
    const to = '2026-11-08';
    const items = [
      {
        id: 'a',
        date: '2026-10-27',
        project: '政企通',
        startDate: '2026-10-27',
        endDate: '2026-10-29',
        total: 100,
        pending: 50,
        executed: 50,
        draft: false,
        source: 'manual' as const,
        sessionId: '',
        createdAt: '2026-10-27T01:00:00.000Z',
        updatedAt: '2026-10-28T01:00:00.000Z',
      },
      {
        id: 'b',
        date: '2026-10-29',
        project: '运管',
        startDate: '2026-10-29',
        endDate: '2026-11-04',
        total: 225,
        pending: 146,
        executed: 79,
        draft: false,
        source: 'manual' as const,
        sessionId: '',
        createdAt: '2026-10-28T01:00:00.000Z',
        updatedAt: '2026-10-29T01:00:00.000Z',
      },
      {
        id: 'c',
        date: '2026-11-03',
        project: '仅统计日在本周',
        startDate: '2026-10-01',
        endDate: '2026-10-05',
        total: 10,
        pending: 0,
        executed: 10,
        draft: false,
        source: 'manual' as const,
        sessionId: '',
        createdAt: '2026-10-01T01:00:00.000Z',
        updatedAt: '2026-11-03T08:00:00.000Z',
      },
      {
        id: 'd',
        date: '2026-10-01',
        project: '只改过修改日',
        startDate: '2026-10-01',
        endDate: '2026-10-05',
        total: 5,
        pending: 0,
        executed: 5,
        draft: false,
        source: 'manual' as const,
        sessionId: '',
        createdAt: '2026-10-01T01:00:00.000Z',
        updatedAt: '2026-11-03T08:00:00.000Z',
      },
    ];
    assert.deepEqual(
      filterCaseExec(items, from, to).map((x) => x.project),
      ['运管', '仅统计日在本周'],
    );
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
    assert.match(md, /基线 100 · 已执行 60 \/ 100（60\.00%）/);
    assert.doesNotMatch(md, /### 待办事项/);
  });

  it('用例执行按项目基线累计，区间外基线行仍作分母', () => {
    const baselineRow = {
      id: 'ce_base',
      date: '2026-10-01',
      project: '政企通v1.16.0迭代',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      total: 196,
      pending: 149,
      executed: 47,
      draft: false,
      source: 'manual' as const,
      sessionId: '',
      createdAt: '2026-10-01T01:00:00.000Z',
      updatedAt: '2026-10-01T01:00:00.000Z',
    };
    const weekRow = {
      id: 'ce_week',
      date: '2026-10-27',
      project: '政企通v1.16.0迭代',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      total: 149,
      pending: 51,
      executed: 98,
      draft: false,
      source: 'manual' as const,
      sessionId: '',
      createdAt: '2026-10-27T11:00:00.000Z',
      updatedAt: '2026-10-27T11:00:00.000Z',
    };
    const md = formatReportContext({
      period: { from: '2026-10-26', to: '2026-11-01', label: '周报（2026.10.26-2026.11.01）' },
      include: { todos: false, tasks: false, testStats: false, caseExec: true },
      caseExec: [weekRow],
      caseExecAll: [baselineRow, weekRow],
    });
    // 卡头口径：基线 196，累计已执行 196-51=145 → 73.98%
    assert.match(md, /基线 196 · 已执行 145 \/ 196（73\.98%）/);
    assert.match(md, /累计已执行 145 \/ 196（73\.98%）/);
    // 不能把本轮总数 149 当分母
    assert.doesNotMatch(md, /基线 149/);
  });
});
