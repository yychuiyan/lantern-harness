/**
 * 需求分析：体检报告面板。
 *
 * 覆盖率与维度覆盖来自确定性规则（服务端 / `auditStories`），缺口清单是规则 + 模型两侧合并后的结果。
 * 缺口可勾选，交给模型按勾选项补写；这里只负责展示与选择，不直接改故事。
 */
import { PmTag } from './PmShared';
import {
  GAP_SEVERITY_LABEL,
  GAP_SEVERITY_TONE,
  GAP_TYPE_LABEL,
  type ReqCheckReport,
  type ReqGap,
  type ReqStory,
} from '../../lib/req-analysis';

const SECTION_TITLE = 'text-xs font-semibold tracking-wide text-stone-500';

const SEVERITY_RANK: Record<ReqGap['severity'], number> = { high: 0, medium: 1, low: 2 };

export default function ReqCheckPanel({
  check,
  stories,
  busy,
  onToggleGap,
  onToggleAll,
  onFix,
  onAudit,
}: {
  check: ReqCheckReport | null;
  stories: ReqStory[];
  busy?: boolean;
  onToggleGap: (id: string, selected: boolean) => void;
  onToggleAll: (selected: boolean) => void;
  onFix: () => void;
  onAudit: () => void;
}) {
  if (!check) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-200 px-4 py-16 text-center">
        <p className="text-sm font-medium text-stone-600">还没有体检</p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-stone-400">
          体检会先用固定规则核对覆盖率与字段完整性，再让模型补语义缺口（场景遗漏、替代流程不成立、验收不可测）。
        </p>
        <button
          type="button"
          className="mt-4 h-9 rounded-md bg-[#3370ff] px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={busy || !stories.length}
          onClick={onAudit}
        >
          开始体检
        </button>
      </div>
    );
  }

  const gaps = [...check.gaps].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const selected = gaps.filter((gap) => gap.selected).length;
  const pct = check.coverage.total ? Math.round(check.coverage.rate * 100) : 0;
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
                : '还没有需求条目，先做一次拆解'}
            </p>
          </div>
          <div className="text-right">
            <p className={SECTION_TITLE}>缺口</p>
            <p className="mt-0.5 text-lg font-semibold text-stone-800">
              {gaps.length}
              <span className="ml-1 text-xs font-normal text-stone-400">
                高 {gaps.filter((gap) => gap.severity === 'high').length}
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
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {check.dimensions.map((dim) => (
            <div
              key={dim.key}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                dim.covered
                  ? 'border-emerald-200 bg-emerald-50/60 text-emerald-800'
                  : 'border-stone-200 bg-stone-50 text-stone-500'
              }`}
            >
              <span aria-hidden="true">{dim.covered ? '✓' : '—'}</span>
              <span className="font-medium">{dim.label}</span>
              {dim.stories.length ? (
                <span className="truncate text-[11px] text-stone-400">
                  {dim.stories.join(', ')}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-stone-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-stone-700">缺口清单</p>
            <span className="text-xs text-stone-400">已选 {selected} 条</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-7 rounded-md border border-stone-200 px-2 text-xs text-stone-600 transition-colors hover:bg-stone-50"
              onClick={() => onToggleAll(selected !== gaps.length)}
            >
              {selected === gaps.length && gaps.length ? '清空选择' : '全选'}
            </button>
            <button
              type="button"
              className="h-7 rounded-md bg-[#3370ff] px-2.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={busy || !selected}
              onClick={onFix}
            >
              补写选中缺口
            </button>
          </div>
        </div>
        {gaps.length ? (
          <ul className="divide-y divide-stone-100">
            {gaps.map((gap) => (
              <li key={gap.id} className="flex items-start gap-2.5 px-4 py-2.5">
                <input
                  type="checkbox"
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-[#3370ff]"
                  checked={gap.selected}
                  onChange={(e) => onToggleGap(gap.id, e.target.checked)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PmTag tone={GAP_SEVERITY_TONE[gap.severity]}>
                      {GAP_SEVERITY_LABEL[gap.severity]}
                    </PmTag>
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">
                      {GAP_TYPE_LABEL[gap.type]}
                    </span>
                    {gap.storyId ? (
                      <span className="font-mono text-[11px] text-stone-400">
                        {gap.storyId}
                        {storyTitle.get(gap.storyId) ? ` · ${storyTitle.get(gap.storyId)}` : ''}
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
                    <p className="mt-0.5 text-xs leading-relaxed text-amber-700">
                      建议：{gap.suggestion}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-10 text-center text-sm text-stone-400">
            没有发现缺口。覆盖率与维度都过了，可以再人工过一遍验收标准。
          </p>
        )}
      </div>
    </div>
  );
}
