/**
 * 编排代码页底部：运行日志（可拖高度 / 展开收起）。
 * 左侧：运行 / 重新运行；中间箭头收起；右侧：项目内草稿目录入口。
 */
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { UiDraftSummary, UiVerifyResult } from '../../lib/ui-auto-agent';

function shortPath(path: string, keep = 52): string {
  const text = String(path || '');
  if (text.length <= keep) return text;
  return `…${text.slice(-(keep - 1))}`;
}

export default function UiAutoOrchestrateRunLog({
  verify,
  draft,
  verifying,
  canRun,
  collapsed,
  dragging,
  height,
  onToggle,
  onVerify,
  onReveal,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: {
  verify: UiVerifyResult | null;
  draft: UiDraftSummary | null;
  verifying: boolean;
  canRun: boolean;
  collapsed: boolean;
  dragging: boolean;
  height: number;
  onToggle: () => void;
  onVerify: () => void;
  onReveal?: (path: string) => void;
  onDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDragMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDragEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDragCancel: () => void;
}) {
  const passed = verify?.passed;
  const log =
    verify?.log ||
    (verify ? '试跑没有输出' : '点左侧「运行」后这里显示日志；草稿在项目目录 .lantern-ai/ 下。');

  // 草稿落在「项目/.lantern-ai/<会话>/」；优先打开会话根目录，而不是单个 spec
  const draftRoot = draft?.draftRoot || verify?.draftRoot || '';
  const draftDir = draft?.draftDir || '';
  const draftFile = verify?.draftPath || '';
  const openFolder = draftRoot || draftDir;
  const tracePath = verify?.tracePath || draft?.tracePath || '';
  const logPath = verify?.logPath || '';

  return (
    <section
      className={`relative flex shrink-0 flex-col overflow-hidden border-t border-stone-200 bg-white ${
        dragging ? '' : 'transition-[height] duration-200 ease-out'
      }`}
      style={{ height: collapsed && !dragging ? 40 : height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整运行日志高度"
        className={
          collapsed && !dragging
            ? 'absolute inset-x-0 top-0 z-10 flex h-3 cursor-row-resize touch-none items-start justify-center'
            : `flex h-2.5 shrink-0 cursor-row-resize touch-none items-center justify-center border-b border-stone-100 ${
                dragging ? 'bg-[#4176e6]/12' : 'bg-stone-50 hover:bg-[#4176e6]/10'
              }`
        }
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragCancel}
      >
        <span
          className={`mt-0.5 h-1 w-8 rounded-full ${dragging ? 'bg-[#4176e6]' : 'bg-stone-300'}`}
          aria-hidden="true"
        />
      </div>

      <div
        className={`relative flex h-9 shrink-0 items-center gap-2 px-2.5 ${
          collapsed ? '' : 'border-b border-stone-100'
        }`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center rounded-md bg-[#4176e6] px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[#3566d0] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onVerify}
            disabled={!canRun || verifying}
          >
            {verifying ? '运行中…' : verify ? '重新运行' : '运行'}
          </button>
          <span
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${
              !verify
                ? 'text-stone-500'
                : passed
                  ? 'bg-emerald-50 text-emerald-700'
                  : verifying
                    ? 'text-[#4176e6]'
                    : 'bg-red-50 text-red-600'
            }`}
          >
            {!verify ? (
              '运行日志'
            ) : verifying ? (
              '运行中'
            ) : passed ? (
              <>
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                通过
              </>
            ) : (
              <>
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
                失败{verify.exitCode != null ? ` · ${verify.exitCode}` : ''}
              </>
            )}
          </span>
          {verify && !verifying ? (
            <span className="text-[11px] tabular-nums text-stone-400">
              {Math.round((verify.durationMs ?? 0) / 100) / 10}s{verify.timedOut ? ' · 超时' : ''}
            </span>
          ) : null}
        </div>

        <button
          type="button"
          aria-label={collapsed ? '展开运行日志' : '收起运行日志'}
          aria-expanded={!collapsed}
          className="absolute left-1/2 top-1/2 z-[1] flex h-7 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
          onClick={onToggle}
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-3.5 w-3.5 transition-transform duration-200 ${
              collapsed ? 'rotate-180' : ''
            }`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        <div className="ml-auto flex min-w-0 max-w-[46%] items-center gap-1.5">
          {openFolder ? (
            <span className="min-w-0 truncate font-mono text-[10px] text-stone-400">
              {shortPath(openFolder)}
            </span>
          ) : null}
          {onReveal && openFolder ? (
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-[#4176e6] transition-colors hover:bg-[#4176e6]/8"
              onClick={() => onReveal(openFolder)}
            >
              打开目录
            </button>
          ) : null}
        </div>
      </div>

      {!collapsed || dragging ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-[#f4f3f0] px-3 py-2 font-mono text-[11px] leading-[1.65] text-stone-700">
            {log}
          </pre>
          {(openFolder || draftFile || tracePath || logPath) && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-stone-100 bg-white px-3 py-1.5">
              <span className="text-[11px] text-stone-400">项目内草稿试跑</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-stone-500">
                {shortPath(openFolder || draftFile)}
              </span>
              {onReveal && draftFile ? (
                <button
                  type="button"
                  className="text-[11px] text-stone-500 transition-colors hover:text-stone-700"
                  onClick={() => onReveal(draftFile)}
                >
                  打开用例
                </button>
              ) : null}
              {onReveal && logPath ? (
                <button
                  type="button"
                  className="text-[11px] text-stone-500 transition-colors hover:text-stone-700"
                  onClick={() => onReveal(logPath)}
                >
                  完整日志
                </button>
              ) : null}
              {onReveal && tracePath ? (
                <button
                  type="button"
                  className="text-[11px] text-stone-500 transition-colors hover:text-stone-700"
                  onClick={() => onReveal(tracePath)}
                >
                  trace
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
