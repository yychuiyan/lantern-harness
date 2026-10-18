import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  EMPTY_CALENDAR,
  addDays,
  buildHolidayCalendar,
  isHoliday,
  isMakeupWorkday,
  isRestDay,
  nextRestDay,
  restDayName,
  type CnHolidayFile,
} from './cn-holidays';

/** 直接读发布用的数据文件，保证「改 JSON」和「测试」看的是同一份 */
const raw = JSON.parse(
  readFileSync(new URL('../../public/cn-holidays.json', import.meta.url), 'utf8'),
) as CnHolidayFile;
const calendar = buildHolidayCalendar(raw);

describe('cn-holidays 数据文件', () => {
  it('至少收录 2026 / 2027 两年', () => {
    assert.ok(calendar.years.has(2026));
    assert.ok(calendar.years.has(2027));
    assert.equal(calendar.years.size, 2);
  });

  it('每年都是合法的日期区间，且 from <= to', () => {
    for (const [year, value] of Object.entries(raw.years)) {
      for (const block of value.holidays) {
        assert.match(block.from, /^\d{4}-\d{2}-\d{2}$/, `${year} ${block.name} from`);
        assert.match(block.to, /^\d{4}-\d{2}-\d{2}$/, `${year} ${block.name} to`);
        assert.ok(block.from <= block.to, `${year} ${block.name} 区间反了`);
        assert.equal(block.from.slice(0, 4), year, `${year} ${block.name} 年份对不上`);
      }
    }
  });

  it('2027 标成待公布（只有法定假日，没有调休）', () => {
    assert.equal(calendar.provisionalYears.has(2026), false);
    assert.equal(calendar.provisionalYears.has(2027), true);
  });

  it('脏数据不会让整份数据挂掉', () => {
    const broken = buildHolidayCalendar({
      years: {
        '2028': { holidays: [{ name: '元旦', from: '2028-13-01', to: '2028-01-03' }] },
        bad: { holidays: [] },
        '2029': { holidays: [{ name: '元旦', from: '2029-01-05', to: '2029-01-01' }] },
      },
    });
    assert.ok(broken.years.has(2028));
    assert.equal(broken.holidayName.size, 0);
    assert.equal(broken.years.has(2029), true);
    assert.equal(broken.holidayName.size, 0);
  });

  it('不是对象时返回空日历', () => {
    assert.equal(buildHolidayCalendar(null).years.size, 0);
    assert.equal(buildHolidayCalendar('x').holidayName.size, 0);
  });
});

describe('isRestDay / restDayName', () => {
  it('普通工作日 / 周末', () => {
    assert.equal(isRestDay(calendar, '2026-10-14'), false);
    assert.equal(isRestDay(calendar, '2026-10-17'), true);
    assert.equal(isRestDay(calendar, '2026-10-18'), true);
    assert.equal(restDayName(calendar, '2026-10-17'), '周末');
    assert.equal(restDayName(calendar, '2026-10-14'), null);
  });

  it('法定节假日算休息，名字是节日名', () => {
    assert.equal(isHoliday(calendar, '2026-10-05'), true);
    assert.equal(restDayName(calendar, '2026-10-05'), '国庆节');
    assert.equal(restDayName(calendar, '2026-02-20'), '春节');
    assert.equal(restDayName(calendar, '2027-02-06'), '春节');
  });

  it('调休补班的周末不算休息', () => {
    assert.equal(isMakeupWorkday(calendar, '2026-10-10'), true);
    assert.equal(isRestDay(calendar, '2026-10-10'), false);
    assert.equal(isRestDay(calendar, '2026-09-20'), false);
    assert.equal(isRestDay(calendar, '2026-01-04'), false);
  });

  it('没收录的年份按普通周末算', () => {
    assert.equal(calendar.years.has(2030), false);
    assert.equal(isRestDay(calendar, '2030-03-02'), true); // 周六
    assert.equal(isRestDay(calendar, '2030-03-04'), false); // 周一
  });

  it('空日历只看周末', () => {
    assert.equal(isRestDay(EMPTY_CALENDAR, '2026-10-05'), false); // 国庆，但没数据
    assert.equal(isRestDay(EMPTY_CALENDAR, '2026-10-17'), true);
  });
});

describe('nextRestDay / addDays', () => {
  it('当天就是休息日时返回当天', () => {
    assert.equal(nextRestDay(calendar, '2026-10-17'), '2026-10-17');
  });

  it('补班周六直接跳到周日', () => {
    assert.equal(nextRestDay(calendar, '2026-10-10'), '2026-10-11');
  });

  it('国庆假期结束后的第一个休息日', () => {
    assert.equal(nextRestDay(calendar, '2026-10-08'), '2026-10-11');
  });

  it('跨月 / 跨年', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
});
