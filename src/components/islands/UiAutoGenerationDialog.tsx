/**
 * 「生成过程」回看：创建项目时的检查日志、平台体检与 AI 建议、应用过的补丁、文件清单。
 *
 * 记录只保留最近一次（`<空间>/自动化执行/<项目名>/生成记录/生成过程.json`），
 * 这里只读；运行环境的安装记录单独内嵌 `UiAutoSetupPanel`，可以顺便重装。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useMemo, useState } from 'react';

import {
  fetchScaffoldRecord,
  type ScaffoldGenerationRecord,
  type UiAutoProject,
} from '../../lib/ui-auto';
import { buildPreviewTree } from '../../lib/ui-auto-scaffold-tree';
import { PmIcon } from './PmShared';
import UiAutoPreviewTree, { dirPathsOf } from './UiAutoPreviewTree';
import UiAutoSetupPanel from './UiAutoSetupPanel';

type Tab = 'logs' | 'findings' | 'files' | 'setup';

const TEXT_PRIMARY = 'text-[var(--tw-label-primary)]';
const TEXT_SECONDARY = 'text-[var(--tw-label-secondary)]';
const TEXT_TERTIARY = 'text-[var(--tw-label-tertiary)]';

const STAGE_LABEL: Record<string, string> = {
  skeleton: '读骨架',
  structure: '结构检查',
  render: '渲染检查',
  target: '目标目录',
  prompt: '读提示词',
  ai: 'AI 分析',
  parse: '解析输出',
  summary: '汇总',
  setup: '安装',
};

const SOURCE_LABEL: Record<string, string> = {
  space: '空间骨架',
  builtin: '内置骨架',
  custom: '本次调过',
};

const LEVEL_STYLE: Record<string, string> = {
  error: 'text-red-600',
  warn: 'text-amber-600',
  info: TEXT_SECONDARY,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function UiAutoGenerationDialog({
  project,
  onClose,
  onSetupFinished,
}: {
  project: UiAutoProject;
  onClose: () => void;
  /** 安装状态变化后让调用方刷新项目列表 */
  onSetupFinished?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('logs');
  const [record, setRecord] = useState<ScaffoldGenerationRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void fetchScaffoldRecord(project.id)
      .then((data) => {
        if (alive) setRecord(data);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [project.id]);

  const tree = useMemo(() => buildPreviewTree(record?.files ?? []), [record?.files]);
  const allDirs = useMemo(() => dirPathsOf(tree), [tree]);
  const applied = new Set(record?.applied ?? []);
  const errorCount = record?.findings.filter((item) => item.level === 'error').length ?? 0;
  const warnCount = record?.findings.filter((item) => item.level === 'warn').length ?? 0;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'logs', label: '过程日志' },
    {
      id: 'findings',
      label: `检查与建议${record?.findings.length ? ` (${record.findings.length})` : ''}`,
    },
    { id: 'files', label: `文件清单${record?.files.length ? ` (${record.files.length})` : ''}` },
    { id: 'setup', label: '运行环境' },
  ];

  return (
    <Dialog open onClose={onClose} className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="tw-pop-dialog-anim relative flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--tw-border)] bg-[var(--tw-surface-panel)] shadow-xl"
        >
          <div className="flex shrink-0 items-start gap-3 border-b border-[var(--tw-border)] px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <DialogTitle className={`truncate text-[15px] font-semibold ${TEXT_PRIMARY}`}>
                生成过程 · {project.name}
              </DialogTitle>
              <p className={`mt-0.5 truncate font-mono text-[11px] ${TEXT_TERTIARY}`}>
                {project.dir}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="inline-flex h-5 items-center rounded-md bg-(--tw-accent-soft) px-1.5 font-medium text-(--tw-accent)">
                  {project.frameworkLabel || project.framework}
                </span>
                {record ? (
                  <>
                    <span
                      className={`inline-flex h-5 items-center rounded-md border border-[var(--tw-border)] px-1.5 ${TEXT_SECONDARY}`}
                    >
                      {SOURCE_LABEL[record.skeletonSource || ''] || '骨架'}
                      {record.skeleton ? ` · ${record.skeleton}` : ''}
                    </span>
                    <span
                      className={`inline-flex h-5 items-center rounded-md border border-[var(--tw-border)] px-1.5 ${TEXT_SECONDARY}`}
                    >
                      {record.files.length} 个文件 · {formatBytes(record.totalBytes)}
                    </span>
                    {applied.size ? (
                      <span className="inline-flex h-5 items-center rounded-md border border-emerald-200 px-1.5 text-emerald-700">
                        应用 {applied.size} 条建议
                      </span>
                    ) : null}
                    {errorCount ? (
                      <span className="inline-flex h-5 items-center rounded-md border border-red-200 px-1.5 text-red-600">
                        {errorCount} 个必须处理
                      </span>
                    ) : null}
                    {warnCount ? (
                      <span className="inline-flex h-5 items-center rounded-md border border-amber-200 px-1.5 text-amber-700">
                        {warnCount} 个建议
                      </span>
                    ) : null}
                    <span className={`${TEXT_TERTIARY}`}>
                      {record.at
                        ? new Date(record.at).toLocaleString('zh-CN', { hour12: false })
                        : ''}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-md p-1 text-[var(--tw-label-tertiary)] transition-colors hover:bg-[var(--tw-session-hover-bg)] hover:text-[var(--tw-label-primary)]"
              onClick={onClose}
              aria-label="关闭"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--tw-border)] px-4">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`relative h-9 px-2.5 text-[13px] transition-colors ${
                  tab === item.id
                    ? 'font-medium text-(--tw-label-primary)'
                    : 'text-(--tw-label-secondary) hover:text-(--tw-label-primary)'
                }`}
              >
                {item.label}
                {tab === item.id ? (
                  <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-(--tw-accent)" />
                ) : null}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {loading ? (
              <p className={`text-xs ${TEXT_TERTIARY}`}>读取生成记录…</p>
            ) : error ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
            ) : !record ? (
              <p className={`text-xs ${TEXT_TERTIARY}`}>还没有生成过程记录。</p>
            ) : (
              <>
                {tab === 'logs' ? (
                  <div className="space-y-2">
                    {record.stats ? (
                      <p className={`text-[11px] ${TEXT_TERTIARY}`}>
                        耗时 {(record.stats.ms / 1000).toFixed(1)}s
                        {record.stats.firstTokenMs
                          ? ` · 首字 ${(record.stats.firstTokenMs / 1000).toFixed(1)}s`
                          : ''}
                        {record.stats.chars ? ` · 模型输出 ${record.stats.chars} 字` : ''}
                        {record.stats.model ? ` · ${record.stats.model}` : ''}
                      </p>
                    ) : null}
                    {!record.promptReady ? (
                      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                        当时没有挂载「自动化项目提示词」，只跑了平台检查。
                      </p>
                    ) : null}
                    <div className="space-y-1 rounded-xl border border-[var(--tw-border)] px-2.5 py-2 font-mono text-[11px] leading-5">
                      {record.logs.length === 0 ? (
                        <p className={`font-sans ${TEXT_TERTIARY}`}>没有日志记录。</p>
                      ) : (
                        record.logs.map((entry, index) => (
                          <div key={`${entry.seq}-${index}`} className="flex gap-1.5">
                            <span className="shrink-0 text-[var(--tw-label-tertiary)]">
                              {entry.at
                                ? new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })
                                : '--:--:--'}
                            </span>
                            <span className="shrink-0 text-[var(--tw-label-tertiary)]">
                              [{STAGE_LABEL[entry.stage] ?? entry.stage}]
                            </span>
                            <span
                              className={`min-w-0 flex-1 break-words ${LEVEL_STYLE[entry.level] ?? TEXT_SECONDARY}`}
                            >
                              {entry.text}
                              {entry.detail ? (
                                <span
                                  className={`mt-0.5 block whitespace-pre-wrap ${TEXT_TERTIARY}`}
                                >
                                  {entry.detail}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                    {record.raw ? (
                      <div>
                        <button
                          type="button"
                          className={`inline-flex items-center gap-1 text-[11px] ${TEXT_SECONDARY} transition-colors hover:text-(--tw-label-primary)`}
                          onClick={() => setShowRaw((prev) => !prev)}
                        >
                          <PmIcon name={showRaw ? 'chevronDown' : 'chevronRight'} size={12} />
                          模型原始输出
                        </button>
                        {showRaw ? (
                          <pre
                            className={`mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--tw-border)] px-2.5 py-2 font-mono text-[11px] leading-5 ${TEXT_SECONDARY}`}
                          >
                            {record.raw}
                          </pre>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {tab === 'findings' ? (
                  <div className="space-y-2">
                    {record.findings.length === 0 ? (
                      <p className={`text-xs ${TEXT_TERTIARY}`}>没有检查项。</p>
                    ) : (
                      record.findings.map((item) => {
                        const used = applied.has(item.id);
                        return (
                          <div
                            key={item.id}
                            className="rounded-lg border border-[var(--tw-border)] px-3 py-2"
                          >
                            <div className="flex items-start gap-2">
                              <span
                                className={`mt-0.5 shrink-0 text-[11px] ${LEVEL_STYLE[item.level] ?? TEXT_SECONDARY}`}
                              >
                                {item.level === 'error'
                                  ? '必须'
                                  : item.level === 'warn'
                                    ? '建议'
                                    : '提示'}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className={`text-xs font-medium ${TEXT_PRIMARY}`}>
                                  {item.title}
                                </p>
                                {item.detail ? (
                                  <p
                                    className={`mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-5 ${TEXT_SECONDARY}`}
                                  >
                                    {item.detail}
                                  </p>
                                ) : null}
                                {item.file ? (
                                  <p
                                    className={`mt-0.5 truncate font-mono text-[11px] ${TEXT_TERTIARY}`}
                                  >
                                    {item.file}
                                  </p>
                                ) : null}
                                {item.patches.length ? (
                                  <p
                                    className={`mt-1 flex flex-wrap gap-1 text-[11px] ${TEXT_TERTIARY}`}
                                  >
                                    {item.patches.map((patch, index) => (
                                      <span
                                        key={`${patch.action}-${patch.path}-${index}`}
                                        className="inline-flex items-center rounded border border-[var(--tw-border)] px-1 py-0.5 font-mono"
                                      >
                                        {patch.action} · {patch.path || '-'}
                                      </span>
                                    ))}
                                  </p>
                                ) : null}
                              </div>
                              {used ? (
                                <span className="shrink-0 rounded-md border border-emerald-200 px-1.5 py-0.5 text-[11px] text-emerald-700">
                                  已应用
                                </span>
                              ) : item.source === 'platform' ? (
                                <span className={`shrink-0 text-[11px] ${TEXT_TERTIARY}`}>
                                  平台检查
                                </span>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : null}

                {tab === 'files' ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`text-[11px] ${TEXT_TERTIARY}`}>
                        {record.files.length} 个文件 · {formatBytes(record.totalBytes)}
                      </span>
                      <button
                        type="button"
                        className={`ml-auto text-[11px] ${TEXT_SECONDARY} transition-colors hover:text-(--tw-label-primary)`}
                        onClick={() => {
                          const allFolded = allDirs.every((dir) => collapsed[dir]);
                          setCollapsed(Object.fromEntries(allDirs.map((dir) => [dir, !allFolded])));
                        }}
                      >
                        {allDirs.every((dir) => collapsed[dir]) ? '全部展开' : '全部收起'}
                      </button>
                    </div>
                    <UiAutoPreviewTree
                      nodes={tree}
                      collapsed={collapsed}
                      onToggle={(path) =>
                        setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))
                      }
                    />
                  </div>
                ) : null}

                {tab === 'setup' ? (
                  <UiAutoSetupPanel
                    projectId={project.id}
                    plan={project.setupPlan ?? []}
                    note={project.setupNote ?? ''}
                    showTitle={false}
                    onStatusChange={() => onSetupFinished?.()}
                  />
                ) : null}
              </>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
