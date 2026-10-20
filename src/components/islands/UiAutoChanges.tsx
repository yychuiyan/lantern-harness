/**
 * 本次 AI 写入的变更账本：左侧文件列表 + 右侧行级 diff，项目 git 工作区摘要收在左列底部。
 *
 * 账本来自写入时记录的 before / after（精确、不受项目其它改动干扰）；
 * git 摘要只是补充，告诉用户「除了这次写入，项目里还有哪些脏文件」。
 */
import { useMemo, useState } from 'react';

import type { UiChangeEntry, UiDraftSummary, UiGitSummary } from '../../lib/ui-auto-agent';

function kindMeta(entry: UiChangeEntry) {
  if (entry.kind === 'create') {
    return { label: '新增', className: 'bg-emerald-50 text-emerald-600' };
  }
  if (entry.kind === 'merge') {
    // 已有文件只在原基础上补了内容，不是整文件替换
    return { label: '追加', className: 'bg-sky-50 text-sky-600' };
  }
  return { label: '修改', className: 'bg-amber-50 text-amber-600' };
}

export default function UiAutoChanges({
  changes,
  git,
  draft,
  loading,
  onReveal,
  onRefresh,
}: {
  changes: UiChangeEntry[];
  git: UiGitSummary | null;
  draft: UiDraftSummary | null;
  loading?: boolean;
  onReveal: (path: string) => void;
  onRefresh: () => void;
}) {
  const [activePath, setActivePath] = useState('');
  const active = useMemo(
    () => changes.find((item) => item.path === activePath) ?? changes[0] ?? null,
    [activePath, changes],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-100 px-3 py-1">
        <span className="shrink-0 text-[11px] text-stone-500">
          本次写入 <span className="font-medium text-stone-700">{changes.length}</span> 个文件
        </span>
        {draft?.draftRoot ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-stone-400">
            {draft.draftRoot}
          </span>
        ) : null}
        <button
          type="button"
          className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-[#3370ff] hover:underline disabled:opacity-40"
          onClick={onRefresh}
          disabled={loading}
        >
          刷新
          {/* 转圈槽位常驻：加载前后按钮宽度、文字位置都不动 */}
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 shrink-0 rounded-full border border-[#3370ff]/30 border-t-[#3370ff] ${
              loading ? 'animate-spin' : 'opacity-0'
            }`}
          />
        </button>
      </div>

      {changes.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <p className="text-[11px] leading-relaxed text-stone-400">
            还没有写入项目。试跑通过后点「写入项目」，这里会出现精确到行的改动内容。
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左：文件列表 + 其它脏文件 */}
          <div className="flex w-60 shrink-0 flex-col overflow-auto border-r border-stone-100">
            <div className="shrink-0">
              {changes.map((entry) => {
                const meta = kindMeta(entry);
                const selected = active?.path === entry.path;
                return (
                  <button
                    key={entry.path}
                    type="button"
                    className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                      selected ? 'bg-[#f2f6ff]' : 'hover:bg-stone-50'
                    }`}
                    onClick={() => setActivePath(entry.path)}
                  >
                    <span
                      className={`shrink-0 rounded px-1 text-[10px] leading-4 ${meta.className}`}
                    >
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-stone-700">
                      {entry.path}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-emerald-600">
                      +{entry.added}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-red-500">
                      -{entry.removed}
                    </span>
                  </button>
                );
              })}
            </div>

            {git?.ok && git.entries.length ? (
              <details className="mt-auto shrink-0 border-t border-stone-100 px-2.5 py-1.5">
                <summary className="cursor-pointer list-none text-[11px] text-stone-500">
                  项目工作区其它改动 {git.entries.length}
                  {git.truncated ? '（截断）' : ''}
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {git.entries.map((entry) => (
                    <li
                      key={`${entry.code}-${entry.path}`}
                      className="flex items-center gap-1.5 font-mono text-[10px] text-stone-500"
                    >
                      <span className="w-4 shrink-0 text-[#3370ff]">{entry.code}</span>
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left hover:underline"
                        onClick={() => onReveal(entry.path)}
                      >
                        {entry.path}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>

          {/* 右：diff 占满剩余宽度 */}
          {active ? (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-stone-100 px-3 py-1">
                <span className="min-w-0 truncate font-mono text-[11px] text-stone-600">
                  {active.path}
                </span>
                <button
                  type="button"
                  className="ml-auto shrink-0 text-[11px] text-[#3370ff] hover:underline"
                  onClick={() => onReveal(active.path)}
                >
                  打开文件
                </button>
                <button
                  type="button"
                  className="shrink-0 text-[11px] text-[#3370ff] hover:underline"
                  onClick={() => {
                    const slash = active.path.lastIndexOf('/');
                    onReveal(slash === -1 ? '' : active.path.slice(0, slash));
                  }}
                >
                  打开目录
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-stone-50/40">
                {active.truncated ? (
                  <p className="px-3 py-2 text-[11px] text-stone-500">{active.message}</p>
                ) : null}
                {(active.hunks ?? []).map((hunk, hunkIndex) => (
                  <div key={`${active.path}-${hunkIndex}`} className="border-b border-stone-100">
                    <div className="bg-stone-100/70 px-3 py-0.5 font-mono text-[10px] text-stone-500">
                      @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                    </div>
                    <div className="py-1">
                      {(() => {
                        let oldNo = hunk.oldStart;
                        let newNo = hunk.newStart;
                        return hunk.lines.map((line, lineIndex) => {
                          const prefix =
                            line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
                          const oldLabel = line.type === 'add' ? '' : oldNo;
                          const newLabel = line.type === 'del' ? '' : newNo;
                          if (line.type !== 'add') oldNo += 1;
                          if (line.type !== 'del') newNo += 1;
                          return (
                            <div
                              key={lineIndex}
                              className={`flex gap-2 px-2 font-mono text-[11px] leading-5 ${
                                line.type === 'add'
                                  ? 'bg-emerald-50 text-emerald-800'
                                  : line.type === 'del'
                                    ? 'bg-red-50 text-red-700'
                                    : 'text-stone-600'
                              }`}
                            >
                              <span className="w-8 shrink-0 select-none text-right text-[10px] text-stone-400">
                                {oldLabel}
                              </span>
                              <span className="w-8 shrink-0 select-none text-right text-[10px] text-stone-400">
                                {newLabel}
                              </span>
                              <span className="w-2 shrink-0 select-none text-stone-400">
                                {prefix}
                              </span>
                              <span className="whitespace-pre">{line.text || ' '}</span>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                ))}
                {!active.truncated && (active.hunks ?? []).length === 0 ? (
                  <p className="px-3 py-2 text-[11px] text-stone-400">内容没有变化</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
