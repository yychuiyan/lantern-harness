import { useRef } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

interface Props {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作：solid=红底白字；outline=描边红字（对齐 dsh 删工作区） */
  danger?: boolean | 'solid' | 'outline';
  /** 纯提示（如拦截删除）：隐藏取消按钮，只留一个确认 */
  hideCancel?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * 二次确认框。
 *
 * 关闭时调用方常把 tip 数据一并清掉（message → ''），若退场动画还在播，
 * 中间正文会空一帧，弹窗瞬间变矮，看起来像「小弹窗缩影」。
 * 这里把打开时的文案冻住，退场期间继续显示，再叠透明度动画。
 */
export default function ConfirmDialog({
  open,
  title = '确认',
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  hideCancel = false,
  onClose,
  onConfirm,
}: Props) {
  const snap = useRef({
    title,
    message,
    confirmLabel,
    cancelLabel,
    danger,
    hideCancel,
  });
  if (open) {
    snap.current = { title, message, confirmLabel, cancelLabel, danger, hideCancel };
  }
  const view = open
    ? { title, message, confirmLabel, cancelLabel, danger, hideCancel }
    : snap.current;

  const dangerMode =
    view.danger === true || view.danger === 'solid'
      ? 'solid'
      : view.danger === 'outline'
        ? 'outline'
        : null;

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
          className="tw-confirm-dialog tw-dialog-panel-anim relative w-full max-w-sm rounded-xl shadow-xl border border-stone-200 p-5 bg-white"
        >
          <button
            type="button"
            onClick={onClose}
            className="tw-confirm-cancel absolute top-3.5 right-3.5 w-7 h-7 flex items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 transition-colors"
            aria-label="关闭"
          >
            ✕
          </button>
          <DialogTitle className="tw-confirm-title pr-8 text-base font-semibold text-stone-900">
            {view.title}
          </DialogTitle>
          <p className="tw-confirm-msg mt-3 text-sm text-stone-600 leading-relaxed whitespace-pre-wrap">
            {view.message}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            {view.hideCancel ? null : (
              <button
                type="button"
                onClick={onClose}
                className="tw-confirm-cancel h-8 px-3 text-sm rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-100 transition-colors"
              >
                {view.cancelLabel}
              </button>
            )}
            <button
              type="button"
              onClick={onConfirm}
              className={
                dangerMode === 'outline'
                  ? 'h-8 px-3 text-sm rounded-lg border border-red-300 text-red-600 bg-transparent hover:bg-red-50 transition-colors'
                  : dangerMode === 'solid'
                    ? 'h-8 px-3 text-sm rounded-lg text-white bg-red-600 hover:bg-red-700 transition-colors'
                    : 'h-8 px-3 text-sm rounded-lg text-white bg-[#4176e6] hover:bg-[#3566d0] transition-colors'
              }
            >
              {view.confirmLabel}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
