/**
 * 用户故事审查：审查报告面板。
 *
 * 覆盖率与维度覆盖来自确定性规则（`auditStories`），缺口清单是规则 + 模型两侧合并后的结果。
 * 缺口按「场景遗漏 / 维度缺失 / 其它」分组；可勾选，交给模型按勾选项补写。
 * 这里只负责展示与选择，不直接改故事。
 */
import { PmTag } from './PmShared';
import OverflowHint from './OverflowHint';
import {
  GAP_SEVERITY_LABEL,
  GAP_SEVERITY_TONE,
  GAP_TYPE_LABEL,
  type ReqCheckReport,
  type ReqGap,
  type ReqStory,
} from '../../lib/req-analysis';
import { countGapsBySeverity, groupReviewGaps } from '../../lib/story-review';

const SECTION_TITLE = 'text-xs font-semibold tracking-wide text-stone-500';
const BTN_PRIMARY =
  'inline-flex h-7 items-center justify-center rounded-md bg-[#3370ff] px-2.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const BTN_SECONDARY =
  'inline-flex h-7 items-center justify-center rounded-md border border-stone-200 bg-white px-2 text-xs text-stone-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50';

export default function StoryReviewReport({
  check,
  stories,
  busy,
  onToggleGap,
  onToggleAll,
  onFix,
  onReview,
  onExport,
}: {
  check: ReqCheckReport | null;
  stories: ReqStory[];
  busy?: boolean;
  onToggleGap: (id: string, selected: boolean) => void;
  onToggleAll: (selected: boolean) => void;
  onFix: () => void;
  onReview: () => void;
  onExport: () => void;
}) {
  if (!check) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-200 px-4 py-16 text-center">
        <p className="text-sm font-medium text-stone-600">还没有审查结果</p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-stone-400">
          审查会先用固定规则核对覆盖率与字段完整性，再让模型专查场景遗漏与维度缺失（替代流程不成立、验收不可测也会一并报）。
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

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-stone-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className={SECTION_TITLE}>需求条目覆盖率</p>
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
                ? '有故事引用的条目算覆盖；sourceRefs 为空的故事不会计入'
                : '还没有需求条目，先回「需求分析」做一次拆解'}
            </p>
          </div>
          <div className="text-right">
            <p className={SECTION_TITLE}>缺口</p>
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
      </div>

      <div className="rounded-xl border border-stone-200 bg-white px-4 py-3">
        <p className={SECTION_TITLE}>维度覆盖</p>
        {/* 每个维度一张小卡：第一行是「状态 + 维度名 + 覆盖条数」，第二行才放故事编号。
            维度名 shrink-0 + nowrap，编号单独一行截断，避免挤成一列竖排文字。 */}
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

      <div className="rounded-xl border border-stone-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-stone-700">缺口清单</p>
            <span className="text-xs text-stone-400">已选 {selected} 条</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={BTN_SECONDARY} onClick={onExport}>
              导出 Markdown
            </button>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => onToggleAll(selected !== check.gaps.length)}
            >
              {selected === check.gaps.length && check.gaps.length ? '清空选择' : '全选'}
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy || !selected}
              onClick={onFix}
            >
              补写选中缺口
            </button>
          </div>
        </div>
        {groups.length ? (
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
                      onToggle={onToggleGap}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="px-4 py-10 text-center text-sm text-stone-400">
            没有发现缺口。覆盖率与维度都过了，可以再人工过一遍验收标准。
          </p>
        )}
      </div>
    </div>
  );
}

function GapRow({
  gap,
  storyTitle,
  onToggle,
}: {
  gap: ReqGap;
  storyTitle: string;
  onToggle: (id: string, selected: boolean) => void;
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
          <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{gap.detail}</p>
        ) : null}
        {gap.suggestion ? (
          <p className="mt-0.5 text-xs leading-relaxed text-amber-700">建议：{gap.suggestion}</p>
        ) : null}
      </div>
    </li>
  );
}
