/**
 * 中国法定节假日与调休上班日的读取与查询。
 *
 * 数据本身放在 `public/cn-holidays.json`（随静态资源发布，不参与编译），
 * 每年 11 月国务院办公厅公布次年安排后，照通知往 `years` 里加一年即可，这里不用改。
 * 本文件只负责解析数据 + 判断某天是不是休息日。
 *
 * 没有收录的年份按普通周末算（春节这类挪到工作日的假期会算不准，记得补数据）。
 */

export interface CnHolidayBlock {
  /** 节日名，倒计时文案里用 */
  name: string;
  /** 放假第一天（含） */
  from: string;
  /** 放假最后一天（含） */
  to: string;
  /** 调休上班日（周末补班，不算休息） */
  workdays?: readonly string[];
}

export interface CnHolidayYear {
  /** 官方安排是否还没公布（只有法定假日日期，调休待补） */
  provisional?: boolean;
  note?: string;
  holidays: readonly CnHolidayBlock[];
}

export interface CnHolidayFile {
  source?: string;
  updatedAt?: string;
  years: Readonly<Record<string, CnHolidayYear>>;
}

export interface HolidayCalendar {
  /** 放假日期 → 节日名 */
  holidayName: ReadonlyMap<string, string>;
  /** 调休补班日 */
  makeup: ReadonlySet<string>;
  /** 已收录数据的年份 */
  years: ReadonlySet<number>;
  /** 官方安排待公布、只录了法定假日的年份 */
  provisionalYears: ReadonlySet<number>;
}

export const EMPTY_CALENDAR: HolidayCalendar = {
  holidayName: new Map(),
  makeup: new Set(),
  years: new Set(),
  provisionalYears: new Set(),
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD → 本地 0 点；非法输入（含 2026-02-30 这种会被自动进位的）返回 null */
export function parseIsoDate(iso: string): Date | null {
  if (!ISO_RE.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  if (Number.isNaN(date.getTime())) return null;
  return isoOfDate(date) === iso ? date : null;
}
/** Date → YYYY-MM-DD（本地日期，不走 UTC） */
export function isoOfDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 日期加天数（本地日期，跨月 / 跨年安全） */
export function addDays(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  if (!date) return iso;
  date.setDate(date.getDate() + days);
  return isoOfDate(date);
}

/**
 * 解析 JSON 数据：合法的条目进索引，格式不对的静默跳过（数据是手改的，
 * 一条写错不该让整张卡崩掉）。
 */
export function buildHolidayCalendar(raw: unknown): HolidayCalendar {
  const holidayName = new Map<string, string>();
  const makeup = new Set<string>();
  const years = new Set<number>();
  const provisionalYears = new Set<number>();

  if (!raw || typeof raw !== 'object') return { holidayName, makeup, years, provisionalYears };
  const file = raw as Partial<CnHolidayFile>;
  const yearMap = file.years;
  if (!yearMap || typeof yearMap !== 'object') {
    return { holidayName, makeup, years, provisionalYears };
  }

  for (const [yearKey, value] of Object.entries(yearMap)) {
    const year = Number(yearKey);
    if (!Number.isInteger(year) || !value || typeof value !== 'object') continue;
    const blocks = (value as CnHolidayYear).holidays;
    if (!Array.isArray(blocks)) continue;
    years.add(year);
    if ((value as CnHolidayYear).provisional) provisionalYears.add(year);
    for (const block of blocks) {
      if (!block || typeof block.name !== 'string') continue;
      const start = parseIsoDate(block.from);
      const end = parseIsoDate(block.to);
      if (!start || !end || start > end) continue;
      for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        holidayName.set(isoOfDate(d), block.name);
      }
      for (const day of block.workdays ?? []) {
        if (ISO_RE.test(day)) makeup.add(day);
      }
    }
  }
  return { holidayName, makeup, years, provisionalYears };
}

let cache: Promise<HolidayCalendar> | null = null;

/** 读取 public/cn-holidays.json；失败时退回「只按周末算」，不让卡片报错 */
export function loadHolidayCalendar(): Promise<HolidayCalendar> {
  cache ??= fetch(`${import.meta.env.BASE_URL}cn-holidays.json`, { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : null))
    .then((raw) => (raw ? buildHolidayCalendar(raw) : EMPTY_CALENDAR))
    .catch(() => EMPTY_CALENDAR);
  return cache;
}

/** 调休上班日（周末但要去上班） */
export function isMakeupWorkday(calendar: HolidayCalendar, iso: string): boolean {
  return calendar.makeup.has(iso);
}

/** 法定节假日（含调休出来的假期） */
export function isHoliday(calendar: HolidayCalendar, iso: string): boolean {
  return calendar.holidayName.has(iso);
}

/** 是不是休息日：调休上班日优先（不算），然后看法定节假日，最后看周六 / 周日 */
export function isRestDay(calendar: HolidayCalendar, iso: string): boolean {
  if (calendar.makeup.has(iso)) return false;
  if (calendar.holidayName.has(iso)) return true;
  const date = parseIsoDate(iso);
  if (!date) return false;
  const weekday = date.getDay();
  return weekday === 0 || weekday === 6;
}

/** 休息日的名字：法定节假日给节日名，普通周末给「周末」；不是休息日返回 null */
export function restDayName(calendar: HolidayCalendar, iso: string): string | null {
  if (!isRestDay(calendar, iso)) return null;
  return calendar.holidayName.get(iso) ?? '周末';
}

/** 从某天起（含当天）往后找第一个休息日；找不到返回 null */
export function nextRestDay(
  calendar: HolidayCalendar,
  iso: string,
  limitDays = 400,
): string | null {
  let cursor = iso;
  for (let i = 0; i <= limitDays; i += 1) {
    if (isRestDay(calendar, cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return null;
}
