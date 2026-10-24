/**
 * 生成测试点：导图 / 列表两种视图。
 *
 * 展示口径：文档名 → Ideal 需求标题（一行一条）→ 五维 → 测试点。
 * 导图左右展开（中间根节点，两侧需求分支），避免上下堆叠过长。
 * 完整树形导出 XMind（向右逻辑图；单条需求时根即「标题（N）」→ 五维）与 Markdown。
 */
import { useMemo, useState } from 'react';

import OverflowHint from './OverflowHint';
import { PmTag } from './PmShared';
import { type ReqAnalysisDoc } from '../../lib/req-analysis';
import {
  DIMENSION_META,
  PRIORITY_META,
  PRIORITY_ORDER,
  countTestPoints,
  groupTestPointsByRequirement,
  type TestPoint,
  type TestPointRequirementGroup,
} from '../../lib/test-points';
import { readViewPref, writeViewPref } from '../../lib/view-prefs';

const TP_VIEW_PREF = 'reqanalysis.testPointsView';
const TP_VIEWS = ['map', 'list'] as const;

const BTN_SECONDARY =
  'inline-flex h-7 items-center justify-center rounded-md border border-stone-200 bg-white px-2 text-xs text-stone-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50';

type PanelView = 'map' | 'list';

function PointDetail({ point }: { point: TestPoint }) {
  return (
    <div className="space-y-1 text-[11px] leading-relaxed text-stone-500">
      {point.precondition ? (
        <p>
          <span className="text-stone-400">前置：</span>
          {point.precondition}
        </p>
      ) : null}
      {point.steps.length ? (
        <div>
          <p className="text-stone-400">步骤：</p>
          <ol className="mt-0.5 list-decimal space-y-0.5 pl-4">
            {point.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {point.expected ? (
        <p>
          <span className="text-stone-400">预期：</span>
          {point.expected}
        </p>
      ) : null}
    </div>
  );
}

/** 单条需求：标题在左，五维横向向右展开（列宽固定，避免中文被挤成竖排单字） */
function RequirementBranch({ req }: { req: TestPointRequirementGroup }) {
  return (
    <div className="flex items-stretch gap-0">
      <div className="flex w-36 shrink-0 flex-col justify-center rounded-l-xl border border-r-0 border-[#c9d8ff] bg-[#f5f8ff] px-3 py-3">
        <p className="text-[11px] text-[#5b7fd6]">需求</p>
        <p className="text-sm font-semibold leading-snug text-stone-800">{req.title}</p>
        <p className="mt-1 text-[11px] tabular-nums text-stone-400">{req.points.length} 条</p>
      </div>
      <div className="flex min-w-0 flex-1 overflow-hidden rounded-r-xl border border-stone-200 bg-white">
        {req.dimensions.map((group, index) => {
          const meta = DIMENSION_META[group.key];
          return (
            <div
              key={group.key}
              className={`flex w-[9.5rem] shrink-0 flex-col ${
                index > 0 ? 'border-l border-stone-100' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-1 border-b border-stone-100 px-2 py-1.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${meta.accent}`}
                    aria-hidden="true"
                  />
                  <span className="truncate text-[11px] font-medium text-stone-700">
                    {meta.label}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-stone-400">
                  {group.points.length}
                </span>
              </div>
              <div className="max-h-52 space-y-1.5 overflow-y-auto px-1.5 py-1.5">
                {group.points.length ? (
                  group.points.map((point) => (
                    <div
                      key={point.id}
                      className="rounded-lg border border-stone-100 bg-stone-50/70 px-1.5 py-1"
                    >
                      <div className="flex items-start gap-1">
                        <PmTag tone={PRIORITY_META[point.priority].tone}>{point.priority}</PmTag>
                        <p className="min-w-0 flex-1 break-words text-[11px] leading-snug text-stone-700">
                          {point.title}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="py-3 text-center text-[11px] text-stone-300">无</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 导图：文档根在上，其下每条需求一行「标题 → 五维」横向展开，整体可左右滚动 */
function MindMap({ doc, idealTitles }: { doc: ReqAnalysisDoc; idealTitles: string[] }) {
  const requirements = useMemo(
    () => groupTestPointsByRequirement(doc, idealTitles),
    [doc, idealTitles],
  );

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto pb-1">
        <div className="min-w-[62rem] space-y-3">
          {requirements.length ? (
            requirements.map((req) => <RequirementBranch key={req.key} req={req} />)
          ) : (
            <p className="py-8 text-center text-xs text-stone-400">还没有测试点。</p>
          )}
        </div>
      </div>
      <p className="text-center text-[11px] text-stone-400">
        每条需求横向展开五个维度；列过窄时整行左右滑动。导出 XMind 为同结构的向右逻辑图。
      </p>
    </div>
  );
}

/** 列表：需求标题分节，节内再按五维 */
function PointList({ doc, idealTitles }: { doc: ReqAnalysisDoc; idealTitles: string[] }) {
  const requirements = useMemo(
    () => groupTestPointsByRequirement(doc, idealTitles),
    [doc, idealTitles],
  );
  return (
    <div className="space-y-3">
      {requirements.map((req) => (
        <section
          key={req.key}
          className="overflow-hidden rounded-xl border border-stone-200 bg-white"
        >
          <div className="border-b border-stone-100 bg-[#f8fafc] px-3.5 py-2.5">
            <p className="text-[11px] text-stone-400">需求</p>
            <p className="text-sm font-semibold text-stone-800">{req.title}</p>
            <p className="mt-0.5 text-[11px] text-stone-400">{req.points.length} 条</p>
          </div>
          <div className="divide-y divide-stone-100">
            {req.dimensions.map((group) => (
              <div key={group.key}>
                <div className="flex items-center justify-between gap-2 px-3.5 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${DIMENSION_META[group.key].accent}`}
                      aria-hidden="true"
                    />
                    <span className="text-xs font-medium text-stone-700">{group.label}</span>
                    <span className="min-w-0 truncate text-[11px] text-stone-400">
                      {group.hint}
                    </span>
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-stone-400">
                    {group.points.length}
                  </span>
                </div>
                {group.points.length ? (
                  <ul className="border-t border-stone-50">
                    {group.points.map((point) => (
                      <li key={point.id} className="border-t border-stone-50 first:border-t-0">
                        <details className="group px-3.5 py-2 pl-8">
                          <summary className="flex cursor-pointer list-none items-start gap-2">
                            <span className="mt-0.5 shrink-0">
                              <PmTag tone={PRIORITY_META[point.priority].tone}>
                                {point.priority}
                              </PmTag>
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm text-stone-800">{point.title}</span>
                              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-stone-400">
                                <span>{point.steps.length} 步</span>
                                {point.expected ? (
                                  <>
                                    <span className="text-stone-300">·</span>
                                    <OverflowHint
                                      text={point.expected}
                                      className="min-w-0 flex-1 truncate"
                                    />
                                  </>
                                ) : null}
                              </span>
                            </span>
                            <span className="mt-0.5 shrink-0 text-[11px] text-stone-300 group-open:hidden">
                              展开
                            </span>
                            <span className="mt-0.5 hidden shrink-0 text-[11px] text-stone-300 group-open:inline">
                              收起
                            </span>
                          </summary>
                          <div className="mt-1.5 border-l-2 border-stone-100 pl-2.5">
                            <PointDetail point={point} />
                          </div>
                        </details>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-3.5 py-2 pl-8 text-[11px] text-stone-300">本维度没有测试点。</p>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function TestPointsPanel({
  doc,
  idealTitles = [],
  generating,
  busy,
  promptReady,
  onExportXmind,
  onExportMarkdown,
}: {
  doc: ReqAnalysisDoc;
  /** Ideal 表行标题；有则按行归组，否则退回按故事标题 */
  idealTitles?: string[];
  generating: boolean;
  busy: boolean;
  promptReady: boolean;
  onExportXmind: () => void;
  onExportMarkdown: () => void;
}) {
  const [view, setView] = useState<PanelView>(() => readViewPref(TP_VIEW_PREF, TP_VIEWS, 'map'));
  const report = doc.testPoints;
  const stats = countTestPoints(report);
  /** 有来源但行标题还没到：先别按故事归组渲染，避免刷新时结构跳变闪一下 */
  const titlesPending = Boolean(doc.sourcePath) && idealTitles.length === 0;
  const reqCount = useMemo(
    () => (titlesPending ? 0 : groupTestPointsByRequirement(doc, idealTitles).length),
    [doc, idealTitles, titlesPending],
  );

  const setViewPref = (next: PanelView) => {
    setView(next);
    writeViewPref(TP_VIEW_PREF, next);
  };

  if (!report) {
    const reason = !doc.stories.length
      ? '还没有用户故事，先做一次拆解'
      : !promptReady
        ? '「测试点生成提示词.md」还没就绪，重新打开插件会自动补齐'
        : '';
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-200 px-4 py-16 text-center">
        <p className="text-sm font-medium text-stone-600">还没有测试点</p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-stone-400">
          按需求文档每一行整理标题，再按功能 / 边界值 / 异常 / 业务规则 /
          非功能拆测试点；导图左右展开，可导出 XMind（向右逻辑图）与 Markdown。
        </p>
        {reason ? <p className="mt-2 text-xs text-amber-700">{reason}</p> : null}
        <p className="mt-3 text-xs text-stone-400">
          {generating
            ? '正在生成测试点，完成后会自动出现在这里。'
            : '用左栏的「生成测试点」开始拆。'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-stone-200 bg-white px-3.5 py-2">
        <span className="text-xs text-stone-500">
          需求 <span className="font-medium text-stone-700">{reqCount}</span> · 测试点{' '}
          <span className="font-medium text-stone-700">{stats.total}</span>
        </span>
        <span className="flex items-center gap-1">
          {PRIORITY_ORDER.map((priority) => (
            <PmTag key={priority} tone={PRIORITY_META[priority].tone}>
              {priority} {stats.byPriority[priority]}
            </PmTag>
          ))}
        </span>
        <span className="text-xs text-stone-400">维度覆盖 {stats.coveredDimensions}/5</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="flex overflow-hidden rounded-md border border-stone-200">
            {(
              [
                { id: 'map', label: '导图' },
                { id: 'list', label: '列表' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`h-7 px-2.5 text-xs transition-colors ${
                  view === item.id
                    ? 'bg-[#eef3ff] font-medium text-[#1f4fd8]'
                    : 'bg-white text-stone-500 hover:bg-stone-50'
                }`}
                onClick={() => setViewPref(item.id)}
              >
                {item.label}
              </button>
            ))}
          </span>
          <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={onExportXmind}>
            导出 XMind
          </button>
          <button
            type="button"
            className={BTN_SECONDARY}
            disabled={busy}
            onClick={onExportMarkdown}
          >
            导出 Markdown
          </button>
        </span>
      </div>

      {titlesPending ? (
        <div
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-stone-200 py-16 text-xs text-stone-400"
          aria-busy="true"
        >
          <span className="tw-lib-spin" aria-hidden="true" />
          正在按需求文档行整理…
        </div>
      ) : view === 'map' ? (
        <MindMap doc={doc} idealTitles={idealTitles} />
      ) : (
        <PointList doc={doc} idealTitles={idealTitles} />
      )}

      {report.summary ? (
        <details className="rounded-xl border border-stone-200 bg-white px-3.5 py-2">
          <summary className="cursor-pointer text-xs font-medium text-stone-600">生成说明</summary>
          <p className="mt-1.5 text-xs leading-relaxed whitespace-pre-wrap text-stone-500">
            {report.summary}
          </p>
        </details>
      ) : null}
    </div>
  );
}
