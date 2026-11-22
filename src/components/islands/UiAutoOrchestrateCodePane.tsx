/**
 * 编排「代码」阶段：文件清单（多选）+ 可编辑正文 + 写入项目 / 从项目移除。
 */
import { useEffect, useMemo, useState } from 'react';

import type { UiEmitFile } from '../../lib/ui-auto-agent';

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

function roleMeta(role: string): { label: string; className: string } {
  if (role === 'page') return { label: '页面', className: 'bg-sky-50 text-sky-700' };
  if (role === 'fixture') return { label: '登录态', className: 'bg-amber-50 text-amber-700' };
  return { label: '用例', className: 'bg-emerald-50 text-emerald-700' };
}

export default function UiAutoOrchestrateCodePane({
  files,
  reemitting,
  dirtyPaths,
  writtenPaths,
  selectedPaths,
  forceOverwrite,
  writing,
  reverting,
  onReemit,
  onChangeContent,
  onChangePath,
  onToggleSelect,
  onToggleSelectAll,
  onForceOverwriteChange,
  onWriteSelected,
  onRevertSelected,
}: {
  files: UiEmitFile[];
  reemitting?: boolean;
  dirtyPaths?: Set<string>;
  /** 本会话已写入项目的路径 */
  writtenPaths?: Set<string>;
  selectedPaths: Set<string>;
  forceOverwrite?: boolean;
  writing?: boolean;
  reverting?: boolean;
  onReemit?: () => void;
  onChangeContent?: (path: string, content: string) => void;
  onChangePath?: (from: string, to: string) => void;
  onToggleSelect?: (path: string) => void;
  onToggleSelectAll?: (select: boolean) => void;
  onForceOverwriteChange?: (value: boolean) => void;
  onWriteSelected?: () => void;
  onRevertSelected?: () => void;
}) {
  const [activePath, setActivePath] = useState('');
  const [pathDraft, setPathDraft] = useState('');

  useEffect(() => {
    if (!files.length) {
      setActivePath('');
      setPathDraft('');
      return;
    }
    if (!files.some((file) => file.path === activePath)) {
      const next = files[0]?.path ?? '';
      setActivePath(next);
      setPathDraft(next);
    }
  }, [activePath, files]);

  const active = useMemo(() => {
    if (!files.length) return null;
    return files.find((file) => file.path === activePath) ?? files[0] ?? null;
  }, [activePath, files]);

  useEffect(() => {
    setPathDraft(active?.path ?? '');
  }, [active?.path]);

  const dirtyCount = dirtyPaths?.size ?? 0;
  const selectedCount = selectedPaths.size;
  const allSelected = files.length > 0 && files.every((file) => selectedPaths.has(file.path));
  const selectedWrittenCount = files.filter(
    (file) => selectedPaths.has(file.path) && writtenPaths?.has(file.path),
  ).length;
  const busy = Boolean(writing || reverting || reemitting);

  if (!files.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <p className="text-[13px] font-medium text-stone-600">还没有代码</p>
        <p className="max-w-sm text-[12px] leading-relaxed text-stone-400">
          探索完成后，在会话里发送「生成代码」。出码后可编辑、多选写入项目，底栏仍可草稿试跑。
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-stone-200/80 bg-[#fafaf9]">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stone-200/80 px-3">
          <span className="text-[12px] font-medium text-stone-800">文件</span>
          <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] tabular-nums text-stone-500 ring-1 ring-stone-200/80">
            {files.length}
          </span>
          {dirtyCount ? (
            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
              {dirtyCount} 已改
            </span>
          ) : null}
          {onReemit ? (
            <button
              type="button"
              className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-stone-500 transition-colors hover:bg-white hover:text-stone-800 disabled:opacity-40"
              onClick={onReemit}
              disabled={busy}
            >
              {reemitting ? '出码中…' : '重新出码'}
            </button>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-b border-stone-200/70 px-3 py-1.5">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-stone-600">
            <input
              type="checkbox"
              className="rounded border-stone-300 text-[#4176e6] focus:ring-[#4176e6]/30"
              checked={allSelected}
              disabled={busy}
              onChange={(event) => onToggleSelectAll?.(event.target.checked)}
            />
            全选
          </label>
          <span className="text-[11px] tabular-nums text-stone-400">已选 {selectedCount}</span>
        </div>

        <ul className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
          {files.map((file) => {
            const selected = (active?.path ?? '') === file.path;
            const checked = selectedPaths.has(file.path);
            const meta = roleMeta(file.role);
            const dirty = dirtyPaths?.has(file.path);
            const written = writtenPaths?.has(file.path);
            return (
              <li key={file.path}>
                <div
                  className={`flex w-full items-start gap-1.5 rounded-lg px-1.5 py-1.5 transition-colors ${
                    selected
                      ? 'bg-white shadow-[0_0_0_1px_rgba(65,118,230,0.28)]'
                      : 'hover:bg-white/90'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1.5 shrink-0 rounded border-stone-300 text-[#4176e6] focus:ring-[#4176e6]/30"
                    checked={checked}
                    disabled={busy}
                    aria-label={`选择 ${baseName(file.path)}`}
                    onChange={() => onToggleSelect?.(file.path)}
                    onClick={(event) => event.stopPropagation()}
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    onClick={() => setActivePath(file.path)}
                  >
                    <span
                      className={`mt-0.5 shrink-0 rounded px-1 py-px text-[10px] leading-4 ${meta.className}`}
                    >
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="block min-w-0 truncate font-mono text-[11px] text-stone-800">
                          {baseName(file.path)}
                        </span>
                        {dirty ? (
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                            aria-label="已修改"
                          />
                        ) : null}
                        {written ? (
                          <span className="shrink-0 rounded bg-violet-50 px-1 py-px text-[10px] text-violet-700">
                            已写入
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate font-mono text-[10px] leading-4 text-stone-400">
                        {dirName(file.path) || '·'}
                      </span>
                    </span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="shrink-0 space-y-1.5 border-t border-stone-200/80 bg-[#fafaf9] p-2">
          <label className="flex cursor-pointer items-center gap-1.5 px-0.5 text-[11px] text-stone-500">
            <input
              type="checkbox"
              className="rounded border-stone-300 text-[#4176e6] focus:ring-[#4176e6]/30"
              checked={Boolean(forceOverwrite)}
              disabled={busy}
              onChange={(event) => onForceOverwriteChange?.(event.target.checked)}
            />
            整文件覆盖（默认合并）
          </label>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="inline-flex h-7 flex-1 items-center justify-center rounded-md bg-[#4176e6] px-2 text-[11px] font-medium text-white transition-colors hover:bg-[#3566d0] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy || selectedCount === 0}
              onClick={onWriteSelected}
            >
              {writing ? '写入中…' : `写入选中${selectedCount ? ` ${selectedCount}` : ''}`}
            </button>
            <button
              type="button"
              className="inline-flex h-7 flex-1 items-center justify-center rounded-md border border-stone-200 bg-white px-2 text-[11px] text-stone-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy || selectedWrittenCount === 0}
              onClick={onRevertSelected}
            >
              {reverting
                ? '移除中…'
                : `从项目移除${selectedWrittenCount ? ` ${selectedWrittenCount}` : ''}`}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-white">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stone-200/80 px-3">
          <input
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 font-mono text-[11px] text-stone-600 outline-none transition-colors hover:border-stone-200 focus:border-[#4176e6]/40 focus:ring-2 focus:ring-[#4176e6]/15"
            value={pathDraft}
            spellCheck={false}
            aria-label="文件路径"
            disabled={!onChangePath || busy}
            onChange={(event) => setPathDraft(event.target.value)}
            onBlur={() => {
              if (!active || !onChangePath) return;
              const next = pathDraft.trim();
              if (!next || next === active.path) {
                setPathDraft(active.path);
                return;
              }
              onChangePath(active.path, next);
              setActivePath(next);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
          />
          {active && dirtyPaths?.has(active.path) ? (
            <span className="shrink-0 text-[11px] text-amber-600">相对出码已改动</span>
          ) : active && writtenPaths?.has(active.path) ? (
            <span className="shrink-0 text-[11px] text-violet-600">已在项目中</span>
          ) : (
            <span className="shrink-0 text-[11px] text-stone-400">与出码一致</span>
          )}
        </div>
        <textarea
          className="min-h-0 flex-1 resize-none border-0 bg-[#f7f6f3] px-4 py-3 font-mono text-[11px] leading-[1.65] text-stone-800 outline-none"
          value={active?.content ?? ''}
          spellCheck={false}
          aria-label="代码编辑"
          disabled={busy}
          onChange={(event) => {
            if (!active || !onChangeContent) return;
            onChangeContent(active.path, event.target.value);
          }}
        />
      </div>
    </div>
  );
}
