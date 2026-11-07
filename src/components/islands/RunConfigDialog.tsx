import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useState } from 'react';

import type { CustomRunTask, RunTask } from '../../lib/ui-auto';
import { PmIcon } from './PmShared';
import SelectDropdown, { type SelectOption } from './SelectDropdown';

interface Props {
  open: boolean;
  projectName: string;
  /** 自动发现的任务（已套用改动，`edited` 标出改过的） */
  detected: RunTask[];
  /** 被忽略的自动发现任务：排在列表最后，点「恢复」放回下拉 */
  ignored: RunTask[];
  customTasks: CustomRunTask[];
  /** 改过的条数，用来显示「恢复默认」 */
  editedCount: number;
  error: string;
  /** 是否弹出浏览器窗口跑（有头）；只有 Playwright 认这个开关 */
  headed: boolean;
  headedSupported: boolean;
  onHeadedChange: (headed: boolean) => void;
  onClose: () => void;
  onAdd: (name: string, command: string) => Promise<void> | void;
  onRemove: (id: string) => Promise<void> | void;
  onEdit: (id: string, name: string, command: string) => Promise<void> | void;
  onHide: (id: string) => Promise<void> | void;
  /** 恢复一条被忽略的命令 */
  onRestore: (id: string) => Promise<void> | void;
  /** 一次放回所有被忽略的命令（忽略多了逐条点太累） */
  onRestoreAll: () => Promise<void> | void;
  /** 还原改动：清掉改名 / 改命令的差异（不动忽略记录） */
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

/** 运行方式：有头会弹出浏览器窗口，排查用；无头与 CI 一致 */
const HEADED_OPTIONS: SelectOption[] = [
  { value: 'headless', label: '无头', secondary: '不弹窗口，和 CI 一致' },
  { value: 'headed', label: '有头', secondary: '弹出浏览器窗口，便于排查' },
];

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
  ignored,
  customTasks,
  editedCount,
  error,
  headed,
  headedSupported,
  onHeadedChange,
  onClose,
  onAdd,
  onRemove,
  onEdit,
  onHide,
  onRestore,
  onRestoreAll,
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
            {/* 运行方式放最上面：先定这次怎么跑，再看具体命令 */}
            <section className={`border-b px-5 py-4 ${ROW_BORDER}`}>
              {/* 两列固定：文字列可收缩换行，下拉永远贴右。
                  用 flex + wrap 时文案一变长就会把下拉挤到第二行（左边），布局会跳。 */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--tw-surface-recessed)] ${TEXT_TERTIARY}`}
                    >
                      <PmIcon name="play" size={12} />
                    </span>
                    <span className={`truncate text-xs font-medium ${TEXT_SECONDARY}`}>
                      运行方式
                    </span>
                    {!headedSupported ? (
                      <span
                        className={`shrink-0 rounded bg-[var(--tw-surface-recessed)] px-1.5 py-0.5 text-[10px] ${TEXT_TERTIARY}`}
                      >
                        当前框架固定
                      </span>
                    ) : null}
                  </div>
                  <p className={`mt-1 text-[11px] leading-relaxed ${TEXT_TERTIARY}`}>
                    {headedSupported
                      ? '改动在下次运行时生效；有头适合排查，批量回归建议留在无头。'
                      : '当前框架不是 Playwright，没有有头 / 无头之分，按项目自身方式启动。'}
                  </p>
                </div>
                <SelectDropdown
                  options={HEADED_OPTIONS}
                  value={headed ? 'headed' : 'headless'}
                  onChange={(next) => onHeadedChange(next === 'headed')}
                  // 触发器自己做：弹窗 portal 到 body，不在 main 里，用 stone/white 的默认外观
                  // 在深色主题下会留一块白底；这里全走 CSS 变量，两套主题同一份写法。
                  unstyled
                  className="w-56 shrink-0"
                  ariaLabel="运行方式"
                  disabled={!headedSupported}
                  triggerClassName="tw-field-trigger h-11 w-full gap-2 rounded-lg border border-[var(--tw-border)] bg-[var(--tw-surface-recessed)] px-2.5 text-[var(--tw-label-primary)] outline-none transition-colors hover:border-[#4176e6]/60 focus:border-[#4176e6] disabled:cursor-not-allowed disabled:opacity-45"
                  renderOptionPrefix={(option) => (
                    <PmIcon
                      name={option.value === 'headed' ? 'play' : 'terminal'}
                      size={12}
                      className={option.value === 'headed' ? 'text-amber-600' : 'text-[#4176e6]'}
                    />
                  )}
                  renderTrigger={(option, state) => (
                    <>
                      <span
                        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                          headed
                            ? 'bg-amber-500/15 text-amber-600'
                            : 'bg-[#4176e6]/10 text-[#4176e6]'
                        }`}
                      >
                        <PmIcon name={headed ? 'play' : 'terminal'} size={13} />
                      </span>
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-xs font-medium leading-4">
                          {option?.label ?? ''}
                        </span>
                        <span
                          className={`mt-0.5 block truncate text-[10px] leading-3.5 ${TEXT_TERTIARY}`}
                        >
                          {option?.secondary ?? ''}
                        </span>
                      </span>
                      <PmIcon
                        name="chevronDown"
                        size={13}
                        className={`shrink-0 ${TEXT_TERTIARY} transition-transform ${
                          state.open ? 'rotate-180' : ''
                        }`}
                      />
                    </>
                  )}
                />
              </div>
            </section>

            {/* 自定义命令 */}
            <section className={`border-b px-5 py-4 ${ROW_BORDER}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--tw-surface-recessed)] ${TEXT_TERTIARY}`}
                >
                  <PmIcon name="terminal" size={12} />
                </span>
                <span className={`text-xs font-medium ${TEXT_SECONDARY}`}>自定义命令</span>
                <span className={`text-[11px] ${TEXT_TERTIARY}`}>{customTasks.length} 条</span>
              </div>

              {customTasks.length ? (
                <ul className={`mt-2 divide-y rounded-lg border ${ROW_DIVIDE} ${ROW_BORDER}`}>
                  {customTasks.map((task) => (
                    <li key={task.id} className="flex min-w-0 items-start gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div
                          className={`truncate ${
                            task.name
                              ? `text-xs font-medium ${TEXT_PRIMARY}`
                              : `font-mono text-[11px] ${TEXT_SECONDARY}`
                          }`}
                        >
                          {task.name || task.command}
                        </div>
                        {task.name ? (
                          <div className={`mt-0.5 truncate font-mono text-[11px] ${TEXT_TERTIARY}`}>
                            {task.command}
                          </div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className={`${ROW_BTN} shrink-0 self-center hover:bg-red-50 hover:text-red-600`}
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
                  placeholder="pnpm run test:smoke"
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
                <span
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--tw-surface-recessed)] ${TEXT_TERTIARY}`}
                >
                  <PmIcon name="search" size={12} />
                </span>
                <span className={`text-xs font-medium ${TEXT_SECONDARY}`}>自动发现</span>
                <span className={`min-w-0 max-w-[240px] truncate text-[11px] ${TEXT_TERTIARY}`}>
                  {detected.length} 条{ignored.length ? ` · 已忽略 ${ignored.length}` : ''}
                  {scannedAt ? ` · ${scannedAt} 已扫描` : ' · 挂载时扫描项目配置'}
                </span>
                {editedCount ? (
                  <span className={`shrink-0 text-[11px] ${TEXT_TERTIARY}`}>
                    已改 {editedCount}
                  </span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {/* 两个入口各管一件事：「还原改动」只清改名 / 改命令的差异，
                      「全部恢复」只清忽略记录——不要合成一个按钮，人会怕点掉别的设置 */}
                  {editedCount ? (
                    <button
                      type="button"
                      className={`${ROW_BTN} hover:bg-[var(--tw-session-hover-bg)] hover:text-[#4176e6]`}
                      onClick={() => void onReset()}
                    >
                      还原改动
                    </button>
                  ) : null}
                  {ignored.length > 1 ? (
                    <button
                      type="button"
                      className={`${ROW_BTN} hover:bg-[var(--tw-session-hover-bg)] hover:text-[#4176e6]`}
                      onClick={() => void onRestoreAll()}
                    >
                      全部恢复
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

              {detected.length || ignored.length ? (
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
                        className={`group flex min-w-0 items-start gap-3 px-3 py-2 ${ROW_HOVER}`}
                      >
                        {/* 两行：上面是哪条任务（+ 原始脚本说明），下面整行宽给命令。
                            三列并排时名字 / 命令 / 说明都要抢宽度，谁都显示不全。 */}
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className={`min-w-0 max-w-[55%] truncate text-xs font-medium ${TEXT_PRIMARY}`}
                            >
                              {task.display || task.command}
                            </span>
                            {task.edited ? (
                              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">
                                已改
                              </span>
                            ) : task.hint ? (
                              <span
                                className={`hidden min-w-0 truncate text-[11px] sm:block ${TEXT_TERTIARY}`}
                              >
                                {task.hint}
                              </span>
                            ) : null}
                          </div>
                          <div className={`mt-0.5 truncate font-mono text-[11px] ${TEXT_TERTIARY}`}>
                            {task.command}
                          </div>
                        </div>
                        <span className="flex shrink-0 items-center gap-0.5 self-center">
                          {/* 忽略：自动扫出来的命令不提供删除，只让它从下拉里消失（恢复到「恢复默认」里）。
                              默认藏起来，悬停这一行才出现；用 opacity 而不是 display，出现时「修改」不会跳位置。 */}
                          <button
                            type="button"
                            className={`${ROW_BTN} pointer-events-none opacity-0 transition-opacity hover:bg-[var(--tw-session-hover-bg)] hover:text-[var(--tw-label-primary)] focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100`}
                            onClick={() => void onHide(task.id)}
                          >
                            忽略
                          </button>
                          <button
                            type="button"
                            className={`${ROW_BTN} hover:bg-[var(--tw-session-hover-bg)] hover:text-[var(--tw-label-primary)]`}
                            onClick={() => beginEdit(task)}
                          >
                            修改
                          </button>
                        </span>
                      </li>
                    ),
                  )}
                  {/* 被忽略的排在最后：整行压暗、命令加删除线，点「恢复」放回下拉。
                      放在同一张列表里而不是单独一段，是为了让人一眼看到「这些只是被藏起来了」。 */}
                  {ignored.map((task) => (
                    <li
                      key={task.id}
                      className={`group flex min-w-0 items-start gap-3 px-3 py-2 ${ROW_HOVER}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`min-w-0 max-w-[55%] truncate text-xs font-medium ${TEXT_TERTIARY}`}
                          >
                            {task.display || task.command}
                          </span>
                          <span
                            className={`shrink-0 rounded bg-[var(--tw-surface-recessed)] px-1.5 py-0.5 text-[10px] ${TEXT_TERTIARY}`}
                          >
                            已忽略
                          </span>
                        </div>
                        <div
                          className={`mt-0.5 truncate font-mono text-[11px] line-through ${TEXT_TERTIARY}`}
                        >
                          {task.command}
                        </div>
                      </div>
                      <span className="flex shrink-0 items-center gap-0.5 self-center">
                        <button
                          type="button"
                          className={`${ROW_BTN} hover:bg-[var(--tw-session-hover-bg)] hover:text-[#4176e6]`}
                          onClick={() => void onRestore(task.id)}
                        >
                          恢复
                        </button>
                      </span>
                    </li>
                  ))}
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
                profiles。改过的命令按原样用 shell
                执行，不再追加框架参数；忽略的命令不进「运行任务」下拉，排在列表末尾，点「恢复」放回去。右上角「还原改动」清掉改名
                / 改命令，「全部恢复」一次放回所有忽略项。
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
