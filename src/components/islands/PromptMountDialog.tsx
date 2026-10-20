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
   * 强制挂载：项目还没挂提示词时用它。
   * 不能关掉弹窗（没有取消、点遮罩也无效），必须选一份挂上才能继续用页面。
   */
  force?: boolean;
  onClose: () => void;
  /** 选中并挂载 */
  onMount: (file: string) => Promise<void> | void;
}

const PANEL = 'bg-[var(--tw-surface-panel)] border-[var(--tw-border)]';
const TEXT_PRIMARY = 'text-[var(--tw-label-primary)]';
const TEXT_SECONDARY = 'text-[var(--tw-label-secondary)]';
const TEXT_TERTIARY = 'text-[var(--tw-label-tertiary)]';
const PRIMARY_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#4176e6] px-3 text-sm font-medium text-white transition-colors hover:bg-[#3566d0] disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--tw-border)] px-3 text-sm text-[var(--tw-label-secondary)] transition-colors hover:bg-[var(--tw-session-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50';

/**
 * 挂载提示词：点顶栏的提示词框打开。
 *
 * 这里只负责「挂哪一份」：列出现有提示词，选中一份就挂到当前项目（自动计入引用）。
 * 新建提示词在「提示词管理」里做，弹窗不再夹带新建入口。
 */
export default function PromptMountDialog({
  open,
  prompts,
  value,
  force = false,
  onClose,
  onMount,
}: Props) {
  const [choice, setChoice] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 每次打开都对齐当前挂载项，上一次没提交的选择不带过来
  useEffect(() => {
    if (!open) return;
    setChoice(value);
    setBusy(false);
    setError('');
  }, [open, value]);

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

  return (
    <Dialog
      open={open}
      onClose={busy || force ? () => undefined : onClose}
      className="relative z-50"
    >
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
                ? '这个项目还没有挂载提示词，选一份挂上才能开始生成。'
                : '一个项目只挂一份提示词，换新的会立即取消上一份的引用'}
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
                      onClick={() => setChoice(file)}
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
                提示词管理里还没有可用的提示词，先去那里新建一份再回来挂载。
              </p>
            )}

            {error ? (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed break-words text-red-600">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--tw-border)] px-5 py-3">
            {/* 强制挂载时不给退路：必须选一份 */}
            {force ? (
              <span className={`mr-auto text-[11px] ${TEXT_TERTIARY}`}>不挂载无法生成脚本</span>
            ) : (
              <button type="button" className={GHOST_BTN} onClick={onClose} disabled={busy}>
                取消
              </button>
            )}
            <button
              type="button"
              className={PRIMARY_BTN}
              onClick={() => void confirm()}
              disabled={busy || !choice || !prompts.length}
            >
              {busy ? '保存中…' : '挂载'}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
