/**
 * 倒计时：切换「今天 / 下班 / 周末 / 今年」四个终点，每秒刷新，只影响本卡片。
 * 「下班」第一次点开先让用户设一个下班时间（HH:mm），之后按这个点倒计时；
 * 「周末」也可以改终点时分（默认休息日 00:00，改成 18:00 就是「周五 18:00 起算周末」）。
 * 说明行点一下就能改时间，选择按数据空间记住。
 */
import { useEffect, useRef, useState } from 'react';

import {
  EMPTY_CALENDAR,
  loadHolidayCalendar,
  type HolidayCalendar,
} from '../../../lib/cn-holidays';
import {
  COUNTDOWN_KINDS,
  DEFAULT_OFF_WORK_TIME,
  DEFAULT_WEEKEND_TIME,
  dashboardCountdown,
  parseClockTime,
  type CountdownKind,
} from '../../../lib/dashboard';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../../lib/view-prefs';
import { DashboardIconTile, IconTimer } from './DashboardCard';

const KIND_LABEL: Record<CountdownKind, string> = {
  today: '今天',
  offWork: '下班',
  weekend: '周末',
  year: '今年',
};

const KIND_HINT: Record<CountdownKind, string> = {
  today: '距离今天结束',
  offWork: '距离下班',
  weekend: '距离下一个休息日',
  year: '距离今年结束',
};

/** 可以自定时分的两个终点：fallback 是第一次打开时的预填值，pref 是记忆键 */
const TIME_EDITABLE: Partial<
  Record<CountdownKind, { fallback: string; pref: string; label: string }>
> = {
  offWork: {
    fallback: DEFAULT_OFF_WORK_TIME,
    pref: 'dashboard.offWork',
    label: '下班时间',
  },
  weekend: {
    fallback: DEFAULT_WEEKEND_TIME,
    pref: 'dashboard.weekendTime',
    label: '周末开始时间',
  },
};

export function CountdownWidget() {
  const [now, setNow] = useState(() => new Date());
  const [calendar, setCalendar] = useState<HolidayCalendar>(EMPTY_CALENDAR);
  const [kind, setKind] = useState<CountdownKind>(() =>
    readViewPref('dashboard.countdown', COUNTDOWN_KINDS, 'weekend'),
  );
  /** 自定义时分：空串 = 还没设置（下班第一次点开时先让用户设） */
  const [times, setTimes] = useState<Record<'offWork' | 'weekend', string>>(() => ({
    offWork: readViewText('dashboard.offWork', ''),
    weekend: readViewText('dashboard.weekendTime', ''),
  }));
  /** 正在改时分的终点：null = 不在编辑状态 */
  const [editingKind, setEditingKind] = useState<CountdownKind | null>(() =>
    kind === 'offWork' && !parseClockTime(readViewText('dashboard.offWork', '')) ? 'offWork' : null,
  );
  const [draft, setDraft] = useState(
    () => parseClockTime(readViewText('dashboard.offWork', '')) ?? DEFAULT_OFF_WORK_TIME,
  );
  /** 打开输入框前的终点：按取消就退回去，不留在「下班」上显示一个没确认的时间 */
  const beforeEditRef = useRef<CountdownKind>('weekend');
  const timeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void loadHolidayCalendar().then((next) => {
      if (alive) setCalendar(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  /** 打开时分输入框：已有时间就带出来，没有就用该终点的默认值 */
  const openEditor = (target: CountdownKind) => {
    const spec = TIME_EDITABLE[target];
    if (!spec) return;
    beforeEditRef.current = target === kind ? target : kind;
    setDraft(parseClockTime(times[target as 'offWork' | 'weekend']) ?? spec.fallback);
    setEditingKind(target);
  };

  // 输入框一出现就聚焦（首次点「下班」时直接可以敲时间）
  useEffect(() => {
    if (editingKind) timeInputRef.current?.focus();
  }, [editingKind]);

  const save = () => {
    const spec = editingKind ? TIME_EDITABLE[editingKind] : null;
    const next = parseClockTime(draft);
    if (!spec || !next) return;
    const key = editingKind as 'offWork' | 'weekend';
    setTimes((prev) => ({ ...prev, [key]: next }));
    writeViewText(spec.pref, next);
    setEditingKind(null);
  };

  const cancel = () => {
    const was = editingKind;
    setEditingKind(null);
    // 还没设过时间就退回原来的终点，避免停在没设置的「下班」上（记忆里的选择一并退回）
    if (was === 'offWork' && !parseClockTime(times.offWork)) {
      setKind(beforeEditRef.current);
      writeViewPref('dashboard.countdown', beforeEditRef.current);
    }
  };

  const cd = dashboardCountdown(now, calendar, kind, times.offWork, times.weekend);
  const pad = (value: number) => String(value).padStart(2, '0');
  const blocks = [
    { value: cd.days, label: '天' },
    { value: cd.hours, label: '时' },
    { value: cd.minutes, label: '分' },
    { value: cd.seconds, label: '秒' },
  ];
  const editable = TIME_EDITABLE[kind];
  const editing = editingKind === kind && Boolean(editable);

  return (
    <section className="tw-dash-surface flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white p-4">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <DashboardIconTile tone="amber">
          <IconTimer />
        </DashboardIconTile>
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-stone-900">
          {cd.title}
        </h2>
        {/* 右上角切换终点：四格分段控件，和日历的日 / 周 / 月同一套样子；
            卡片被拖窄时标题先收，分段控件不换行（四个终点一个都不能少） */}
        <div
          role="group"
          aria-label="倒计时目标"
          className="flex shrink-0 items-center gap-0.5 rounded-lg bg-stone-100 p-0.5"
        >
          {COUNTDOWN_KINDS.map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={kind === item}
              aria-label={KIND_HINT[item]}
              onClick={() => {
                const prev = kind;
                setKind(item);
                writeViewPref('dashboard.countdown', item);
                // 第一次点「下班」：先设时间，设完才开始倒计时
                if (item === 'offWork' && !parseClockTime(times.offWork)) openEditor(prev);
                else setEditingKind(null);
              }}
              className={`h-6 rounded-md px-1.5 text-[10px] leading-4 transition-colors ${
                kind === item
                  ? 'bg-white font-medium text-stone-900 shadow-sm'
                  : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              {KIND_LABEL[item]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex min-h-0 flex-1 flex-col justify-center gap-1.5 overflow-hidden">
        <div className="tw-countdown-tile grid grid-cols-4 gap-1.5">
          {blocks.map((block) => (
            <div key={block.label} className="tw-countdown-block">
              <span className="tw-countdown-num">{pad(block.value)}</span>
              <span className="tw-countdown-unit">{block.label}</span>
            </div>
          ))}
        </div>

        {editable && editing ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <input
              ref={timeInputRef}
              type="time"
              value={draft}
              aria-label={editable.label}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') cancel();
              }}
              className="h-6 min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-1.5 text-[11px] text-stone-700 tabular-nums"
            />
            <button
              type="button"
              onClick={save}
              className="h-6 shrink-0 rounded-md bg-[#3370ff] px-2 text-[10px] font-medium text-white transition-colors hover:bg-[#2b5fd9]"
            >
              确定
            </button>
            <button
              type="button"
              onClick={cancel}
              className="h-6 shrink-0 rounded-md px-1.5 text-[10px] text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              取消
            </button>
          </div>
        ) : editable ? (
          <button
            type="button"
            onClick={() => openEditor(kind)}
            aria-label={`修改${editable.label}`}
            className="tw-countdown-edit group flex min-w-0 shrink-0 items-center gap-1 text-left"
          >
            <span className="truncate text-[10px] leading-4 text-stone-400">{cd.note}</span>
            <span className="tw-countdown-edit-hint shrink-0 text-[10px] leading-4">修改</span>
          </button>
        ) : (
          <p className="truncate text-[10px] leading-4 text-stone-400">{cd.note}</p>
        )}
      </div>
    </section>
  );
}
