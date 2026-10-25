import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useState } from 'react';

import type { CustomRunTask, RunTask } from '../../lib/ui-auto';
import { PmIcon } from './PmShared';

interface Props {
  open: boolean;
  projectName: string;
  /** 自动发现的任务（已套用改动，`edited` 标出改过的） */
  detected: RunTask[];
  customTasks: CustomRunTask[];
  /** 被删掉 / 改过的条数，用来显示「恢复默认」 */
  hiddenCount: number;
  editedCount: number;
  error: string;
  onClose: () => void;
  onAdd: (name: string, command: string) => Promise<void> | void;
  onRemove: (id: string) => Promise<void> | void;
  onEdit: (id: string, name: string, command: string) => Promise<void> | void;
  onHide: (id: string) => Promise<void> | void;
  onReset: () => Promise<void> | void;
  /** 重新扫描项目配置（服务端每次请求都会重扫，这里只是让用户有个明确的入口） */
  onRescan: () => Promise<void> | void;
}

/*
 * 颜色全部走 CSS 变量（--tw-surface-panel / --tw-border / --tw-label-*），
 * 不写 stone / white 这类固定色：深浅两套主题自动跟随，不必再往 global.css
 * 的「深色浅色映射」里加白名单。
 */
const PANEL = 'bg-[var(--tw-surface-panel)] border-[var(--tw-border)]';
const ROW_DIVIDE = 'divide-[var(--tw-border)]';
const ROW_BORDER = 'border-[var(--tw-border)]';
const TEXT_PRIMARY = 'text-[var(--tw-label-primary)]';
const TEXT_SECONDARY = 'text-[var(--tw-label-secondary)]';
const TEXT_TERTIARY = 'text-[var(--tw-label-tertiary)]';
const ROW_HOVER = 'hover:bg-[var(--tw-session-hover-bg)]';
const INPUT = `h-8 min-w-0 rounded-lg border ${ROW_BORDER} bg-[var(--tw-surface-recessed)] px-2.5 text-xs ${TEXT_PRIMARY} outline-none transition-colors placeholder:text-[var(--tw-label-tertiary)] focus:border-[#3370ff]`;
const PRIMARY_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#4176e6] px-3 text-sm font-medium text-white transition-colors hover:bg-[#3566d0] disabled:cursor-not-allowed disabled:opacity-50';
const ROW_BTN = `shrink-0 rounded px-1.5 py-0.5 text-[11px] ${TEXT_TERTIARY} transition-colors`;

/**
 * 运行配置弹窗：管理「运行任务」下拉里的命令。
 *
 * - 自定义命令：自己写名称 + 命令；
 * - 自动发现：挂载时从项目里扫出来的脚本 / Makefile 目标 / marker，可以改名、改命令或删掉，
 *   改动只存差异（项目换了 `package.json` 也不会串），也能手动「重新扫描」。
 * 放弹窗而不是页面内联，是因为命令会越来越多，铺在页面里会把执行卡片撑得很高。
 */
export default function RunConfigDialog({
  open,
  projectName,
  detected,
  customTasks,
  hiddenCount,
  editedCount,
  error,
  onClose,
  onAdd,
  onRemove,
  onEdit,
  onHide,
  onReset,
  onRescan,
}: Props) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scannedAt, setScannedAt] = useState('');
  // 正在编辑的自动发现任务
  const [editId, setEditId] = useState('');
  const [editName, setEditName] = useState('');
  const [editCommand, setEditCommand] = useState('');

  // 每次打开都从干净状态开始，上一次没填完的草稿不往下一个项目带
  useEffect(() => {
    if (!open) return;
    setName('');
    setCommand('');
    setAdding(false);
    setScanning(false);
    setScannedAt('');
    setEditId('');
  }, [open]);

  const submit = async () => {
    const value = command.trim();
    if (!value || adding) return;
    setAdding(true);
    try {
      await onAdd(name.trim(), value);
      setName('');
      setCommand('');
    } finally {
      setAdding(false);
    }
  };

  const rescan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await onRescan();
      setScannedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } finally {
      setScanning(false);
    }
  };

  const beginEdit = (task: RunTask) => {
    setEditId(task.id);
    // 已改过的沿用改后的值；没改过的把扫描出来的短名带进去，方便直接微调
    setEditName(task.edited ? task.display : '');
    setEditCommand(task.command);
  };

  const commitEdit = async () => {
    if (!editId) return;
    const id = editId;
    setEditId('');
    await onEdit(id, editName, editCommand);
  };

  return (
    <Dialog open={open} onClose={onClose} className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className={`tw-dialog-panel-anim relative flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border shadow-xl ${PANEL}`}
        >
          <div
            className={`flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4 ${ROW_BORDER}`}
          >
            <div className="min-w-0">
              <DialogTitle className={`text-base font-semibold ${TEXT_PRIMARY}`}>
                运行配置
              </DialogTitle>
              <p className={`mt-1 truncate text-xs leading-relaxed ${TEXT_TERTIARY}`}>
                {projectName} · 命令在该项目目录下用 shell 执行，支持引号与 &amp;&amp;
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className={`tw-confirm-cancel -mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${TEXT_TERTIARY} transition-colors hover:bg-[var(--tw-session-hover-bg)] hover:text-[var(--tw-label-primary)]`}
              aria-label="关闭"
            >
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {/* 自定义命令 */}
            <section className={`border-b px-5 py-4 ${ROW_BORDER}`}>
              <div className="flex items-baseline gap-2">
                <span className={`text-xs font-medium ${TEXT_SECONDARY}`}>自定义命令</span>
                <span className={`text-[11px] ${TEXT_TERTIARY}`}>{customTasks.length} 条</span>
              </div>

              {customTasks.length ? (
                <ul className={`mt-2 divide-y rounded-lg border ${ROW_DIVIDE} ${ROW_BORDER}`}>
                  {customTasks.map((task) => (
                    <li key={task.id} className={`flex min-w-0 items-center gap-2 px-2.5 py-1.5`}>
                      <span className={`min-w-0 flex-1 truncate ${TEXT_SECONDARY}`}>
                        {task.name ? (
                          <>
                            <span className="text-xs">{task.name}</span>
                            <span className={`ml-1.5 font-mono text-[11px] ${TEXT_TERTIARY}`}>
                              {task.command}
                            </span>
                          </>
                        ) : (
                          <span className={`font-mono text-[11px] ${TEXT_SECONDARY}`}>
                            {task.command}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        className={`${ROW_BTN} hover:bg-red-50 hover:text-red-600`}
                        onClick={() => void onRemove(task.id)}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p
                  className={`mt-2 rounded-lg border border-dashed px-2.5 py-2 text-[11px] ${ROW_BORDER} ${TEXT_TERTIARY}`}
                >
                  还没有自定义命令。名称可以不填，不填时下拉里直接显示命令。
                </p>
              )}

              <div className="mt-2 flex min-w-0 items-center gap-2">
                <input
                  className={`${INPUT} w-28 shrink-0`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="名称（可选）"
                  aria-label="运行任务名称"
                />
                <input
                  className={`${INPUT} flex-1 font-mono`}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit();
                  }}
                  placeholder="npm run test:smoke"
                  aria-label="运行命令"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={PRIMARY_BTN}
                  onClick={() => void submit()}
                  disabled={!command.trim() || adding}
                >
                  <PmIcon name="plus" size={13} />
                  添加
                </button>
              </div>
            </section>

            {/* 自动发现 */}
            <section className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-xs font-medium ${TEXT_SECONDARY}`}>自动发现</span>
                <span className={`text-[11px] ${TEXT_TERTIARY}`}>
                  {detected.length} 条
                  {scannedAt ? ` · ${scannedAt} 已扫描` : ' · 挂载时扫描项目配置'}
                </span>
                {hiddenCount || editedCount ? (
                  <span className={`text-[11px] ${TEXT_TERTIARY}`}>
                    已改 {editedCount} · 已删 {hiddenCount}
                  </span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {hiddenCount || editedCount ? (
                    <button
                      type="button"
                      className={`${ROW_BTN} hover:bg-[var(--tw-session-hover-bg)] hover:text-[#4176e6]`}
                      onClick={() => void onReset()}
                    >
                      恢复默认
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${ROW_BTN} inline-flex items-center gap-1 hover:bg-[var(--tw-session-hover-bg)] hover:text-[var(--tw-label-primary)] disabled:cursor-not-allowed disabled:opacity-50`}
                    onClick={() => void rescan()}
                    disabled={scanning}
                  >
                    <svg
                      className={`h-3 w-3 shrink-0 ${scanning ? 'animate-spin' : ''}`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
                      <path d="M21 4v5h-5" />
                    </svg>
                    {scanning ? '扫描中…' : '重新扫描'}
                  </button>
                </div>
              </div>

              {detected.length ? (
                <ul className={`mt-2 divide-y rounded-lg border ${ROW_DIVIDE} ${ROW_BORDER}`}>
                  {detected.map((task) =>
                    editId === task.id ? (
                      <li
                        key={task.id}
                        className="flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-2"
                      >
                        <input
                          className={`${INPUT} w-28 shrink-0`}
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          placeholder="名称（留空用原名称）"
                          aria-label={`修改名称 ${task.id}`}
                        />
                        <input
                          className={`${INPUT} flex-1 font-mono`}
                          value={editCommand}
                          onChange={(event) => setEditCommand(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void commitEdit();
                            if (event.key === 'Escape') setEditId('');
                          }}
                          placeholder="命令"
                          aria-label={`修改命令 ${task.id}`}
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="h-8 shrink-0 rounded-lg bg-[#4176e6] px-2.5 text-xs text-white transition-colors hover:bg-[#3566d0]"
                          onClick={() => void commitEdit()}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className={`h-8 shrink-0 rounded-lg border px-2.5 text-xs ${ROW_BORDER} ${TEXT_SECONDARY} transition-colors hover:bg-[var(--tw-session-hover-bg)]`}
                          onClick={() => setEditId('')}
                        >
                          取消
                        </button>
                      </li>
                    ) : (
                      <li
                        key={task.id}
                        className={`flex min-w-0 items-center gap-2 px-2.5 py-1.5 ${ROW_HOVER}`}
                      >
                        <span className={`w-24 shrink-0 truncate text-xs ${TEXT_SECONDARY}`}>
                          {task.display || task.command}
                        </span>
                        <span
                          className={`min-w-0 flex-1 truncate font-mono text-[11px] ${TEXT_TERTIARY}`}
                        >
                          {task.command}
                        </span>
                        {task.edited ? (
                          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">
                            已改
                          </span>
                        ) : task.hint ? (
                          <span
                            className={`hidden max-w-[170px] shrink-0 truncate text-[11px] sm:block ${TEXT_TERTIARY}`}
                          >
                            {task.hint}
                          </span>
                        ) : null}
                        <span className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            className={`${ROW_BTN} hover:bg-[var(--tw-session-hover-bg)] hover:text-[var(--tw-label-primary)]`}
                            onClick={() => beginEdit(task)}
                          >
                            修改
                          </button>
                          <button
                            type="button"
                            className={`${ROW_BTN} hover:bg-red-50 hover:text-red-600`}
                            onClick={() => void onHide(task.id)}
                          >
                            删除
                          </button>
                        </span>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p
                  className={`mt-2 rounded-lg border border-dashed px-2.5 py-2 text-[11px] ${ROW_BORDER} ${TEXT_TERTIARY}`}
                >
                  没扫到可复用命令（项目里没有测试脚本 / Makefile 目标 / marker），只保留全量运行。
                </p>
              )}
              <p className={`mt-2 text-[11px] leading-relaxed ${TEXT_TERTIARY}`}>
                扫描来源：package.json 的 scripts、Makefile 目标、pytest markers、Maven
                profiles。改过的命令按原样用 shell 执行，不再追加框架参数。
              </p>
            </section>
          </div>

          {error ? (
            <p className={`shrink-0 border-t px-5 py-2 text-[11px] text-red-600 ${ROW_BORDER}`}>
              {error}
            </p>
          ) : null}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
