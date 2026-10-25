/**
 * 用户故事审查：待确认缺口面板。
 *
 * 覆盖率来自规则；缺口主清单可勾选补写、忽略或填结论。
 * 「待确认清单 / 忽略」Tab 切换；清单工具栏在滚动区内 sticky。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PmTag } from './PmShared';
import OverflowHint from './OverflowHint';
import {
  GAP_SEVERITY_LABEL,
  GAP_SEVERITY_TONE,
  GAP_TYPE_LABEL,
  type ReqCheckReport,
  type ReqGap,
  type ReqIgnoredGap,
  type ReqStory,
} from '../../lib/req-analysis';
import { countGapsBySeverity, groupReviewGaps } from '../../lib/story-review';
import { readViewPref, writeViewPref } from '../../lib/view-prefs';

const SECTION_TITLE = 'text-xs font-semibold tracking-wide text-stone-500';
const BTN_PRIMARY =
  'inline-flex h-7 items-center justify-center rounded-md bg-[#3370ff] px-2.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const BTN_SECONDARY =
  'inline-flex h-7 items-center justify-center rounded-md border border-stone-200 bg-white px-2 text-xs text-stone-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50';

type ListTab = 'pending' | 'ignored';
const LIST_TAB_IDS = ['pending', 'ignored'] as const;
const LIST_TAB_PREF = 'reqanalysis.reviewListTab';

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export default function StoryReviewReport({
  check,
  stories,
  outlineTitles,
  ignoredGaps = [],
  busy,
  onToggleGap,
  onToggleAll,
  onFix,
  onReview,
  onFullScan,
  onExport,
  onExportPending,
  onIgnoreGap,
  onIgnoreSelected,
  onSaveGapConclusion,
  onRestoreIgnored,
  onPromoteIgnored,
}: {
  check: ReqCheckReport | null;
  stories: ReqStory[];
  outlineTitles?: Map<string, string>;
  ignoredGaps?: readonly ReqIgnoredGap[];
  busy?: boolean;
  onToggleGap: (id: string, selected: boolean) => void;
  onToggleAll: (selected: boolean) => void;
  onFix: () => void;
  onReview: () => void;
  /** 显式再挖新待确认（仍滤已忽略）；默认复审不会扩清单 */
  onFullScan?: () => void;
  onExport: () => void;
  onExportPending?: () => void;
  onIgnoreGap?: (id: string) => void;
  onIgnoreSelected?: () => void;
  onSaveGapConclusion?: (gap: ReqGap, conclusion: string) => void;
  onRestoreIgnored?: (id: string) => void;
  onPromoteIgnored?: (id: string) => void;
}) {
  const [listTab, setListTab] = useState<ListTab>(() =>
    readViewPref(LIST_TAB_PREF, LIST_TAB_IDS, 'pending'),
  );
  const [conclusionGap, setConclusionGap] = useState<ReqGap | null>(null);
  const [conclusionText, setConclusionText] = useState('');
  const conclusionRef = useRef<HTMLTextAreaElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const listShellRef = useRef<HTMLDivElement>(null);
  const keepStickyRef = useRef(false);

  useEffect(() => {
    writeViewPref(LIST_TAB_PREF, listTab);
  }, [listTab]);

  useEffect(() => {
    if (!conclusionGap) return;
    setConclusionText(conclusionGap.conclusion?.trim() || '');
    const t = window.setTimeout(() => {
      conclusionRef.current?.focus();
      conclusionRef.current?.select();
    }, 50);
    return () => window.clearTimeout(t);
  }, [conclusionGap]);

  /** 列表过短时补最小高度，切 Tab 后仍能把工具栏吸在滚动区顶部 */
  useLayoutEffect(() => {
    const sticky = stickyRef.current;
    const list = listShellRef.current;
    const scroller = findScrollParent(sticky);
    if (!sticky || !list || !scroller) return;

    const gap = 16; // space-y-4
    const minH = Math.max(0, scroller.clientHeight - sticky.offsetHeight - gap);
    list.style.minHeight = `${minH}px`;

    if (!keepStickyRef.current) return;
    keepStickyRef.current = false;
    const delta = sticky.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
  }, [listTab, check?.gaps.length, ignoredGaps.length]);

  const switchListTab = (next: ListTab) => {
    if (next === listTab) return;
    const sticky = stickyRef.current;
    const scroller = findScrollParent(sticky);
    if (sticky && scroller) {
      keepStickyRef.current =
        sticky.getBoundingClientRect().top <= scroller.getBoundingClientRect().top + 1;
    } else {
      keepStickyRef.current = false;
    }
    setListTab(next);
  };

  if (!check) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-200 px-4 py-16 text-center">
        <p className="text-sm font-medium text-stone-600">还没有审查结果</p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-stone-400">
          审查会核对需求点覆盖，并标出需要业务确认的点（不是需求文档缺什么的质检单）。
        </p>
        <button
          type="button"
          className="mt-4 h-9 rounded-md bg-[#3370ff] px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={busy || !stories.length}
          onClick={onReview}
        >
          开始审查
        </button>
      </div>
    );
  }

  const groups = groupReviewGaps(check.gaps);
  const selected = check.gaps.filter((gap) => gap.selected).length;
  const pct = check.coverage.total ? Math.round(check.coverage.rate * 100) : 0;
  const sev = countGapsBySeverity(check.gaps);
  const storyTitle = new Map(stories.map((story) => [story.id, story.title]));
  const listTabs: { id: ListTab; label: string; count: number }[] = [
    { id: 'pending', label: '待确认清单', count: check.gaps.length },
    { id: 'ignored', label: '忽略', count: ignoredGaps.length },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-stone-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className={SECTION_TITLE}>需求点覆盖率</p>
            <p className="mt-0.5 text-lg font-semibold text-stone-800">
              {check.coverage.covered}
              <span className="text-sm font-normal text-stone-400"> / {check.coverage.total}</span>
              <span className="ml-2 text-sm font-normal text-stone-500">{pct}%</span>
            </p>
          </div>
          <div className="min-w-[160px] flex-1">
            <div className="h-2 overflow-hidden rounded-full bg-stone-100">
              <div
                className={`h-full rounded-full transition-all ${
                  pct >= 90 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500'
                }`}
                style={{ width: `${Math.max(pct, check.coverage.total ? 2 : 0)}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-stone-400">
              {check.coverage.total
                ? '有故事引用的需求点算覆盖；未覆盖会进待确认清单'
                : '还没有需求条目，先做一次拆解'}
            </p>
          </div>
          <div className="text-right">
            <p className={SECTION_TITLE}>待确认</p>
            <p className="mt-0.5 text-lg font-semibold text-stone-800">
              {check.gaps.length}
              <span className="ml-1.5 text-xs font-normal text-stone-400">
                高 {sev.high} · 中 {sev.medium} · 低 {sev.low}
              </span>
            </p>
          </div>
        </div>
        {check.summary ? (
          <p className="mt-3 border-t border-stone-100 pt-2 text-xs leading-relaxed text-stone-500">
            {check.summary}
          </p>
        ) : null}
        {onFullScan ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-2">
            <p className="text-[11px] leading-relaxed text-stone-400">
              复审只刷新上轮清单；需要再挖新问题用全量扫描（已忽略仍不回潮）
            </p>
            <button
              type="button"
              className={BTN_SECONDARY}
              disabled={busy || !stories.length}
              onClick={onFullScan}
            >
              重新全量扫描
            </button>
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-stone-200 bg-white px-4 py-3">
        <p className={SECTION_TITLE}>维度覆盖（仅供参考，无原文依据不进待确认）</p>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {check.dimensions.map((dim) => {
            const ids = dim.stories.join(', ');
            return (
              <div
                key={dim.key}
                data-hint-width
                className={`min-w-0 rounded-lg border px-2.5 py-1.5 text-xs ${
                  dim.covered
                    ? 'border-emerald-200 bg-emerald-50/60'
                    : 'border-stone-200 bg-stone-50'
                }`}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`shrink-0 ${dim.covered ? 'text-emerald-600' : 'text-stone-400'}`}
                  >
                    {dim.covered ? '✓' : '—'}
                  </span>
                  <span
                    className={`shrink-0 whitespace-nowrap font-medium ${
                      dim.covered ? 'text-emerald-800' : 'text-stone-500'
                    }`}
                  >
                    {dim.label}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-stone-400">
                    {dim.stories.length ? `${dim.stories.length} 条` : '未覆盖'}
                  </span>
                </div>
                <div className="mt-0.5 min-w-0 pl-[18px]">
                  {ids ? (
                    <OverflowHint
                      text={ids}
                      matchAnchorWidth
                      className="block truncate text-[11px] text-stone-400"
                    />
                  ) : (
                    <span className="text-[11px] text-stone-300">没有故事覆盖</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 工具栏提到列表卡片外，sticky 相对右栏滚动容器，待确认/忽略切换都吸顶 */}
      <div
        ref={stickyRef}
        className="sticky top-0 z-10 -mx-0.5 rounded-xl border border-stone-200 bg-white px-2 shadow-sm sm:px-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-0.5" role="tablist" aria-label="审查清单">
            {listTabs.map((item) => {
              const active = listTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs transition-colors ${
                    active
                      ? 'border-[#3370ff] font-medium text-[#3370ff]'
                      : 'border-transparent text-stone-500 hover:text-stone-800'
                  }`}
                  onClick={() => switchListTab(item.id)}
                >
                  {item.label}
                  <span
                    className={`rounded-full px-1.5 text-[10px] leading-4 tabular-nums ${
                      active ? 'bg-[#eaf1ff] text-[#3370ff]' : 'bg-stone-100 text-stone-400'
                    }`}
                  >
                    {item.count}
                  </span>
                </button>
              );
            })}
          </div>
          {listTab === 'pending' ? (
            <div className="flex flex-wrap items-center gap-2 px-1 py-1.5 sm:px-0">
              <span className="text-xs text-stone-400">已选 {selected} 条</span>
              <button type="button" className={BTN_SECONDARY} onClick={onExport}>
                导出 Markdown
              </button>
              {onExportPending ? (
                <button type="button" className={BTN_SECONDARY} onClick={onExportPending}>
                  导出待确认
                </button>
              ) : null}
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => onToggleAll(selected !== check.gaps.length)}
              >
                {selected === check.gaps.length && check.gaps.length ? '清空选择' : '全选'}
              </button>
              {onIgnoreSelected ? (
                <button
                  type="button"
                  className={BTN_SECONDARY}
                  disabled={busy || !selected}
                  onClick={onIgnoreSelected}
                >
                  批量忽略
                </button>
              ) : null}
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={busy || !selected}
                onClick={onFix}
              >
                补写选中缺口
              </button>
            </div>
          ) : (
            <span className="px-1 py-1.5 text-xs text-stone-400 sm:px-0">
              忽略项可恢复或落成用户故事
            </span>
          )}
        </div>
      </div>

      <div ref={listShellRef} className="rounded-xl border border-stone-200 bg-white">
        {listTab === 'pending' ? (
          groups.length ? (
            <div className="divide-y divide-stone-100">
              {groups.map((group) => (
                <section key={group.key}>
                  <div className="flex items-center gap-2 bg-stone-50/60 px-4 py-1.5">
                    <p className="text-xs font-semibold text-stone-600">{group.label}</p>
                    <span className="rounded bg-white px-1.5 py-0.5 text-[11px] text-stone-500">
                      {group.gaps.length}
                    </span>
                    <span className="text-[11px] text-stone-400">{group.hint}</span>
                  </div>
                  <ul className="divide-y divide-stone-100">
                    {group.gaps.map((gap) => (
                      <GapRow
                        key={gap.id}
                        gap={gap}
                        storyTitle={storyTitle.get(gap.storyId) ?? ''}
                        outlineLabel={
                          gap.outlineId ? (outlineTitles?.get(gap.outlineId) ?? gap.outlineId) : ''
                        }
                        onToggle={onToggleGap}
                        onIgnore={onIgnoreGap}
                        onFillConclusion={
                          onSaveGapConclusion ? (g) => setConclusionGap(g) : undefined
                        }
                        busy={busy}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-stone-400">
              没有待确认项。需求点覆盖与待确认都过了，可再人工过一遍故事。
            </p>
          )
        ) : ignoredGaps.length ? (
          <ul className="divide-y divide-stone-100">
            {ignoredGaps.map((gap) => (
              <li key={gap.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">
                    {GAP_TYPE_LABEL[gap.type]}
                  </span>
                  {gap.outlineId ? (
                    <span className="rounded bg-[#eaf1ff] px-1.5 py-0.5 text-[11px] text-[#3370ff]">
                      {outlineTitles?.get(gap.outlineId) ?? gap.outlineId}
                    </span>
                  ) : null}
                  <span className="text-[11px] text-stone-400">
                    {gap.ignoredAt.slice(0, 16).replace('T', ' ')}
                  </span>
                </div>
                <p className="mt-1 text-sm text-stone-800">{gap.title}</p>
                {gap.detail ? (
                  <p className="mt-0.5 line-clamp-3 text-xs text-stone-500">{gap.detail}</p>
                ) : null}
                {gap.conclusion?.trim() ? (
                  <p className="mt-1 line-clamp-2 text-xs text-emerald-700">
                    结论：{gap.conclusion.trim()}
                  </p>
                ) : null}
                <div className="mt-1.5 flex flex-wrap justify-end gap-2">
                  {onRestoreIgnored ? (
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      disabled={busy}
                      onClick={() => onRestoreIgnored(gap.id)}
                    >
                      恢复
                    </button>
                  ) : null}
                  {onPromoteIgnored ? (
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      disabled={busy}
                      onClick={() => onPromoteIgnored(gap.id)}
                    >
                      落成用户故事
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-10 text-center text-sm text-stone-400">
            忽略后不进用户故事，可随时恢复或落成。
          </p>
        )}
      </div>

      <Dialog
        open={Boolean(conclusionGap)}
        onClose={() => setConclusionGap(null)}
        className="relative z-110"
      >
        <DialogBackdrop
          transition
          className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
          aria-hidden="true"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="tw-confirm-dialog tw-dialog-panel-anim w-full max-w-md rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          >
            <DialogTitle className="tw-confirm-title text-base font-semibold text-stone-900">
              填写结论
            </DialogTitle>
            {conclusionGap ? (
              <p className="mt-1 text-xs leading-relaxed text-stone-400 line-clamp-2">
                {conclusionGap.title}
              </p>
            ) : null}
            <p className="mt-1 text-xs leading-relaxed text-stone-400">
              把产品/项目确认的结论写在这里；勾选后点「补写选中缺口」时会带给模型。
            </p>
            <label className="mt-3 block text-xs font-medium text-stone-500">
              结论
              <textarea
                ref={conclusionRef}
                value={conclusionText}
                onChange={(e) => setConclusionText(e.target.value)}
                rows={3}
                placeholder="例如：倒计时是提交后 3 秒关页，时间到自动关，不能取消…"
                className="mt-1.5 block w-full resize-y rounded-lg border border-stone-200 px-3 py-2 text-sm leading-relaxed text-stone-800 outline-none transition-colors focus:border-[#4176e6] focus:ring-2 focus:ring-[#4176e6]/30"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="tw-confirm-cancel h-8 rounded-lg px-3 text-sm text-stone-600 transition-colors hover:bg-stone-100"
                onClick={() => setConclusionGap(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="h-8 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#3565c7] disabled:opacity-40"
                disabled={busy || !conclusionText.trim()}
                onClick={() => {
                  if (!conclusionGap || !onSaveGapConclusion || !conclusionText.trim()) return;
                  const gap = conclusionGap;
                  const text = conclusionText.trim();
                  setConclusionGap(null);
                  onSaveGapConclusion(gap, text);
                }}
              >
                保存结论
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

function GapRow({
  gap,
  storyTitle,
  outlineLabel,
  onToggle,
  onIgnore,
  onFillConclusion,
  busy,
}: {
  gap: ReqGap;
  storyTitle: string;
  outlineLabel: string;
  onToggle: (id: string, selected: boolean) => void;
  onIgnore?: (id: string) => void;
  onFillConclusion?: (gap: ReqGap) => void;
  busy?: boolean;
}) {
  return (
    <li className="flex items-start gap-2.5 px-4 py-2.5">
      <input
        type="checkbox"
        className="mt-1 h-3.5 w-3.5 shrink-0 accent-[#3370ff]"
        checked={gap.selected}
        onChange={(e) => onToggle(gap.id, e.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <PmTag tone={GAP_SEVERITY_TONE[gap.severity]}>{GAP_SEVERITY_LABEL[gap.severity]}</PmTag>
          <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">
            {GAP_TYPE_LABEL[gap.type]}
          </span>
          {outlineLabel ? (
            <span className="rounded bg-[#eaf1ff] px-1.5 py-0.5 text-[11px] text-[#3370ff]">
              {outlineLabel}
            </span>
          ) : null}
          {gap.storyId ? (
            <span className="font-mono text-[11px] text-stone-400">
              {gap.storyId}
              {storyTitle ? ` · ${storyTitle}` : ''}
            </span>
          ) : (
            <span className="text-[11px] text-stone-400">全局</span>
          )}
          <span className="text-[11px] text-stone-300">
            {gap.origin === 'model' ? '模型' : '规则'}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-stone-800">{gap.title}</p>
        {gap.detail ? (
          <p className="mt-0.5 text-xs leading-relaxed text-stone-500 whitespace-pre-wrap">
            {gap.detail}
          </p>
        ) : null}
        {gap.suggestion ? (
          <p className="mt-0.5 text-xs leading-relaxed text-amber-700">建议：{gap.suggestion}</p>
        ) : null}
        {gap.conclusion?.trim() ? (
          <p className="mt-1 line-clamp-3 text-xs text-emerald-700">
            结论：{gap.conclusion.trim()}
          </p>
        ) : null}
        {onFillConclusion || onIgnore ? (
          <div className="mt-1.5 flex items-center justify-end gap-2">
            {onFillConclusion ? (
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={busy}
                onClick={() => onFillConclusion(gap)}
              >
                填结论
              </button>
            ) : null}
            {onIgnore ? (
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={busy}
                onClick={() => onIgnore(gap.id)}
              >
                忽略
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
