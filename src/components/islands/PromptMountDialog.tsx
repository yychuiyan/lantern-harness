import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useState } from 'react';

import OverflowHint from './OverflowHint';

interface Props {
  open: boolean;
  /** 可选提示词（提示词管理里的 .md 相对路径） */
  prompts: ReadonlyArray<string>;
  /** 当前挂载的那份 */
  value: string;
  /**
   * 项目还没挂提示词：标题与说明换成「先挂载提示词」的措辞。
   * 仍然可以取消（取消后项目保持未挂载状态，生成时再提示）。
   */
  force?: boolean;
  onClose: () => void;
  /** 选中并挂载 */
  onMount: (file: string) => Promise<void> | void;
  /**
   * 新建一份提示词并挂载（复制插件自带的模板，之后可去提示词管理里改）。
   * 不传时不显示「新建提示词」卡片。
   */
  onCreate?: (name: string) => Promise<string>;
  /** 挂载对象的叫法（项目 / 用例类型），只影响说明文案 */
  target?: string;
  /** 新建卡片里「会按什么模板生成」的说明 */
  createHint?: string;
}

const PANEL = 'bg-[var(--tw-surface-panel)] border-[var(--tw-border)]';
const TEXT_PRIMARY = 'text-[var(--tw-label-primary)]';
const TEXT_SECONDARY = 'text-[var(--tw-label-secondary)]';
const TEXT_TERTIARY = 'text-[var(--tw-label-tertiary)]';
const PRIMARY_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#4176e6] px-3 text-sm font-medium text-white transition-colors hover:bg-[#3566d0] disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--tw-border)] px-3 text-sm text-[var(--tw-label-secondary)] transition-colors hover:bg-[var(--tw-session-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50';
const INPUT =
  'h-8 w-full rounded-lg border border-[var(--tw-border)] bg-[var(--tw-surface-panel)] px-2.5 text-sm text-[var(--tw-label-primary)] outline-none transition-colors placeholder:text-[var(--tw-label-tertiary)] focus:border-[#4176e6]';

/**
 * 挂载提示词：点顶栏的提示词框打开。
 *
 * 这里只负责「挂哪一份」：列出现有提示词，选中一份就挂到当前项目（自动计入引用）。
 * 底部固定一张「新建提示词」卡片——一份提示词都没有时也能直接建一份再挂上，
 * 不用先跳到提示词管理。任何时候都能取消，取消后项目保持未挂载。
 *
 * 层级用 z-110：它常从右侧抽屉（z-60）里打开，比抽屉低会被整块盖住。
 *
 * 底部只有一排按钮，随当前模式切换：
 * - 选中列表里的提示词：取消 / 挂载；
 * - 点开新建卡片：取消 / 创建并挂载（此时列表取消选中；再点回列表项会收起卡片、不创建）。
 */
export default function PromptMountDialog({
  open,
  prompts,
  value,
  force = false,
  onClose,
  onMount,
  onCreate,
  target = '项目',
  createHint = '会按插件自带的模板生成（规划 / 探索 / 生成代码三段），之后可在「提示词管理」里改。',
}: Props) {
  /** 列表里选中的提示词；新建卡片展开时为空（= 取消选中） */
  const [choice, setChoice] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 新建卡片展开中 / 输入的文件名 */
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  // 每次打开都对齐当前挂载项，上一次没提交的选择 / 半截输入不带过来
  useEffect(() => {
    if (!open) return;
    setChoice(value);
    setBusy(false);
    setError('');
    setCreating(false);
    setNewName('');
  }, [open, value]);

  /** 从列表里选一份：同时收起新建卡片（不创建），按钮回到「取消 / 挂载」 */
  const pickPrompt = (file: string) => {
    setChoice(file);
    setCreating(false);
    setNewName('');
    setError('');
  };

  /** 展开新建卡片：列表取消选中，按钮换成「取消 / 创建并挂载」 */
  const startCreate = () => {
    setChoice('');
    setCreating(true);
    setNewName('我的提示词.md');
    setError('');
  };

  /** 收起新建卡片、不创建：选择回到当前已挂载的那份 */
  const cancelCreate = () => {
    setCreating(false);
    setNewName('');
    setError('');
    setChoice(value);
  };

  const confirm = async () => {
    if (busy || !choice) return;
    setBusy(true);
    setError('');
    try {
      await onMount(choice);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!onCreate || busy) return;
    const name = newName.trim();
    if (!name) {
      setError('先给新提示词起个文件名');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const file = await onCreate(name);
      await onMount(file);
      setCreating(false);
      setNewName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className={`tw-dialog-panel-anim w-full max-w-md overflow-hidden rounded-xl border shadow-xl ${PANEL}`}
        >
          <div className="border-b border-[var(--tw-border)] px-5 py-4">
            <DialogTitle className={`text-base font-semibold ${TEXT_PRIMARY}`}>
              {force ? '先挂载提示词' : '挂载提示词'}
            </DialogTitle>
            <p className={`mt-1 text-xs leading-relaxed ${TEXT_SECONDARY}`}>
              {force
                ? `这个${target}还没有挂载提示词，选一份挂上才能开始生成；也可以先取消，稍后再挂。`
                : `一个${target}只挂一份提示词，换新的会立即取消上一份的引用`}
            </p>
          </div>

          <div className="max-h-[60vh] overflow-auto px-5 py-4">
            {prompts.length ? (
              <div className="space-y-1 rounded-lg border border-[var(--tw-border)] p-1">
                {prompts.map((file) => {
                  const active = choice === file;
                  return (
                    <button
                      key={file}
                      type="button"
                      disabled={busy}
                      onClick={() => pickPrompt(file)}
                      aria-pressed={active}
                      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed ${
                        active
                          ? 'bg-(--tw-accent-soft) font-medium text-(--tw-accent)'
                          : 'text-[var(--tw-label-primary)] hover:bg-[var(--tw-session-hover-bg)]'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-3 w-3 shrink-0 rounded-full border ${
                          active
                            ? 'border-[#4176e6] bg-[#4176e6] shadow-[inset_0_0_0_2px_var(--tw-surface-panel)]'
                            : 'border-[var(--tw-border)]'
                        }`}
                      />
                      <OverflowHint text={file} className="min-w-0 flex-1 truncate" />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p
                className={`rounded-lg border border-dashed border-[var(--tw-border)] px-3 py-6 text-center text-xs ${TEXT_TERTIARY}`}
              >
                「提示词管理」里还没有可用的提示词，用下面的卡片新建一份再挂上。
              </p>
            )}

            {/* 新建提示词：复制插件自带的三段式模板，建完直接挂到当前项目。
                展开后只留输入框，确认按钮在底部那一排（不重复摆一套） */}
            {onCreate ? (
              creating ? (
                <div className="mt-3 rounded-lg border border-[var(--tw-border)] p-3">
                  <p className={`text-xs font-medium ${TEXT_PRIMARY}`}>新建提示词并挂载</p>
                  <p className={`mt-1 text-[11px] leading-relaxed ${TEXT_SECONDARY}`}>
                    {createHint}
                  </p>
                  <input
                    className={`${INPUT} mt-2`}
                    value={newName}
                    autoFocus
                    placeholder="文件名，例如 我的登录流程.md"
                    aria-label="新提示词文件名"
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void create();
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={startCreate}
                  className="mt-3 flex w-full items-center gap-3 rounded-lg border border-dashed border-[var(--tw-border)] px-3 py-3 text-left transition-colors hover:border-[#4176e6] hover:bg-[var(--tw-session-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-(--tw-accent-soft) text-(--tw-accent)"
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-medium ${TEXT_PRIMARY}`}>
                      新建提示词并挂载
                    </span>
                    <span className={`mt-0.5 block text-[11px] ${TEXT_SECONDARY}`}>
                      按插件模板生成一份新的，建完直接挂到当前项目
                    </span>
                  </span>
                </button>
              )
            ) : null}

            {error ? (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed break-words text-red-600">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--tw-border)] px-5 py-3">
            {force && !creating ? (
              <span className={`mr-auto text-[11px] ${TEXT_TERTIARY}`}>不挂载时生成会被拦下</span>
            ) : null}
            {creating ? (
              <>
                <button type="button" className={GHOST_BTN} onClick={cancelCreate} disabled={busy}>
                  取消
                </button>
                <button
                  type="button"
                  className={PRIMARY_BTN}
                  onClick={() => void create()}
                  disabled={busy || !newName.trim()}
                >
                  {busy ? '创建中…' : '创建并挂载'}
                </button>
              </>
            ) : (
              <>
                <button type="button" className={GHOST_BTN} onClick={onClose} disabled={busy}>
                  取消
                </button>
                <button
                  type="button"
                  className={PRIMARY_BTN}
                  onClick={() => void confirm()}
                  disabled={busy || !choice || !prompts.length}
                >
                  {busy ? '保存中…' : '挂载'}
                </button>
              </>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
