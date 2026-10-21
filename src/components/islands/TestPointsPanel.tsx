/**
 * 生成测试点：导图 / 列表两种视图。
 *
 * 数据来自「需求分析」文档的 `testPoints`（由模型按提示词拆出，服务端排序并编 TP-001）。
 * 这里只负责展示、切换视图与导出，不直接改数据。
 */
import { useState } from 'react';

import OverflowHint from './OverflowHint';
import { PmTag } from './PmShared';
import type { ReqAnalysisDoc } from '../../lib/req-analysis';
import {
  DIMENSION_META,
  PRIORITY_META,
  PRIORITY_ORDER,
  countTestPoints,
  groupTestPoints,
  type TestPoint,
} from '../../lib/test-points';

const BTN_SECONDARY =
  'inline-flex h-7 items-center justify-center rounded-md border border-stone-200 bg-white px-2 text-xs text-stone-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50';
const SECTION_TITLE = 'text-xs font-semibold tracking-wide text-stone-500';

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

/** 导图视图：根节点在顶部，五个维度作为分支，测试点是叶子 */
function MindMap({ doc }: { doc: ReqAnalysisDoc }) {
  const groups = groupTestPoints(doc.testPoints);
  return (
    <div className="overflow-x-auto pb-1">
      <div className="min-w-[860px]">
        <div className="flex justify-center">
          <div className="rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-center shadow-sm">
            <p className="text-sm font-semibold text-stone-800">{doc.title || '未命名分析'}</p>
            <p className="mt-0.5 text-[11px] text-stone-400">
              测试点 {doc.testPoints?.points.length ?? 0} 条 · 五维覆盖
            </p>
          </div>
        </div>
        <div className="mx-auto h-4 w-px bg-stone-200" aria-hidden="true" />
        <div className="relative">
          <div
            className="absolute top-0 right-[10%] left-[10%] h-px bg-stone-200"
            aria-hidden="true"
          />
          <div className="grid grid-cols-5 gap-3">
            {groups.map((group) => {
              const meta = DIMENSION_META[group.key];
              return (
                <div key={group.key} className="flex flex-col">
                  <div className="mx-auto h-4 w-px bg-stone-200" aria-hidden="true" />
                  <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-stone-200 bg-white">
                    <div className="flex items-center justify-between gap-1 border-b border-stone-100 px-2.5 py-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${meta.accent}`}
                          aria-hidden="true"
                        />
                        <span className="truncate text-xs font-medium text-stone-700">
                          {meta.label}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-stone-400">
                        {group.points.length}
                      </span>
                    </div>
                    <div className="space-y-1.5 px-2 py-2">
                      {group.points.length ? (
                        group.points.map((point) => (
                          <div
                            key={point.id}
                            className="rounded-lg border border-stone-100 bg-stone-50/60 px-2 py-1.5"
                          >
                            <div className="flex items-start gap-1.5">
                              <PmTag tone={PRIORITY_META[point.priority].tone}>
                                {point.priority}
                              </PmTag>
                              <p className="min-w-0 flex-1 text-[11px] leading-snug text-stone-700">
                                {point.title}
                              </p>
                            </div>
                            <OverflowHint
                              text={`${point.storyId || '全局'}${point.expected ? ` · ${point.expected}` : ''}`}
                              className="mt-1 block truncate text-[10px] text-stone-400"
                            />
                          </div>
                        ))
                      ) : (
                        <p className="py-2 text-center text-[11px] text-stone-300">无</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <p className="mt-3 text-center text-[11px] text-stone-400">
          分支 = 五个维度，叶子 = 测试点；左侧标签为优先级。需要完整结构可导出 XMind。
        </p>
      </div>
    </div>
  );
}

/** 列表视图：按维度分节，每条可展开看前置 / 步骤 / 预期 */
function PointList({ doc }: { doc: ReqAnalysisDoc }) {
  const groups = groupTestPoints(doc.testPoints);
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <section key={group.key} className="rounded-xl border border-stone-200 bg-white">
          <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-3.5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${DIMENSION_META[group.key].accent}`}
                aria-hidden="true"
              />
              <span className="text-sm font-medium text-stone-700">{group.label}</span>
              <span className="min-w-0 truncate text-[11px] text-stone-400">{group.hint}</span>
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-stone-400">
              {group.points.length}
            </span>
          </div>
          {group.points.length ? (
            <ul className="divide-y divide-stone-100">
              {group.points.map((point) => (
                <li key={point.id}>
                  <details className="group px-3.5 py-2">
                    <summary className="flex cursor-pointer list-none items-start gap-2">
                      <span className="mt-0.5 shrink-0">
                        <PmTag tone={PRIORITY_META[point.priority].tone}>{point.priority}</PmTag>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-stone-800">{point.title}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-stone-400">
                          <span className="font-mono">{point.storyId || '全局'}</span>
                          <span className="text-stone-300">·</span>
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
            <p className="px-3.5 py-3 text-xs text-stone-400">本维度没有测试点。</p>
          )}
        </section>
      ))}
    </div>
  );
}

export default function TestPointsPanel({
  doc,
  generating,
  busy,
  promptReady,
  onGenerate,
  onExportXmind,
  onExportMarkdown,
}: {
  doc: ReqAnalysisDoc;
  /** 本插件正在生成 */
  generating: boolean;
  /** 有任意任务在跑（含拆解 / 审查），此时所有按钮都禁用 */
  busy: boolean;
  promptReady: boolean;
  onGenerate: () => void;
  onExportXmind: () => void;
  onExportMarkdown: () => void;
}) {
  const [view, setView] = useState<PanelView>('map');
  const report = doc.testPoints;
  const stats = countTestPoints(report);

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
          基于拆好的用户故事，按功能 / 边界值 / 异常 / 业务规则 / 非功能五个维度拆测试点，每条标
          P0–P3；结果可看导图、可下载 XMind。
        </p>
        {reason ? <p className="mt-2 text-xs text-amber-700">{reason}</p> : null}
        {/* 这里不再放「生成测试点」按钮：左栏动作区已经有同一个入口，重复一个只会让人多点一次 */}
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
          共 <span className="font-medium text-stone-700">{stats.total}</span> 条
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
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </span>
          <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={onGenerate}>
            {generating ? '生成中…' : '重新生成'}
          </button>
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

      {view === 'map' ? <MindMap doc={doc} /> : <PointList doc={doc} />}

      <div className="rounded-xl border border-stone-200 bg-white px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className={SECTION_TITLE}>生成说明</p>
          <span className="text-[11px] text-stone-400">{report.at}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-stone-600">
          {report.summary || '（模型没有给整体结论）'}
        </p>
      </div>
    </div>
  );
}
