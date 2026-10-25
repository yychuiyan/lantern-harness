import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useRef, useState } from 'react';

interface Props {
  open: boolean;
  title?: string;
  label?: string;
  placeholder?: string;
  /** 打开时预填（重命名场景） */
  initialValue?: string;
  /**
   * 锁定扩展名：输入框只编辑主名，扩展名灰显固定在右侧。
   * 后端 /rename 要求文件改名后扩展名仍属白名单，锁住可以避免误删扩展名。
   */
  lockExtension?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 校验失败的原因（重名等）：显示在输入框下方，弹窗不关闭 */
  error?: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}

export default function NamePromptDialog({
  open,
  title = '新建文件夹',
  label = '文件夹名称',
  placeholder = '请输入名称',
  initialValue = '',
  lockExtension = false,
  confirmLabel = '创建',
  cancelLabel = '取消',
  error = '',
  onClose,
  onConfirm,
}: Props) {
  const [value, setValue] = useState('');
  /** 被锁定的扩展名（含点，如 .md）；未锁定时为空串 */
  const [ext, setExt] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      let base = initialValue;
      let suffix = '';
      if (lockExtension) {
        // 末段点之后视为扩展名；隐藏文件（.gitkeep）与无扩展名不锁
        const i = initialValue.lastIndexOf('.');
        if (i > 0) {
          base = initialValue.slice(0, i);
          suffix = initialValue.slice(i);
        }
      }
      setValue(base);
      setExt(suffix);
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
      return () => window.clearTimeout(t);
    }
  }, [open, initialValue, lockExtension]);

  function submit() {
    const name = value.trim();
    if (!name) return;
    onConfirm(name + ext);
  }

  // z-110 高于 SlideOverDrawer（z-60），抽屉内改名不被盖住
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
          className="tw-confirm-dialog tw-dialog-panel-anim w-full max-w-sm rounded-xl shadow-xl border border-stone-200 p-5 bg-white"
        >
          <DialogTitle className="tw-confirm-title text-base font-semibold text-stone-900">
            {title}
          </DialogTitle>
          <label className="tw-confirm-msg mt-4 block text-xs font-medium text-stone-500">
            {label}
            <span className="mt-1.5 flex items-center gap-0 rounded-lg border border-stone-200 focus-within:ring-2 focus-within:ring-[#4176e6]/30 focus-within:border-[#4176e6] transition-colors">
              <input
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder={placeholder}
                className="flex-1 min-w-0 h-9 px-3 text-sm rounded-lg border-0 bg-transparent text-stone-800 outline-none"
              />
              {ext ? (
                <span className="shrink-0 pr-3 text-sm text-stone-400 select-none">{ext}</span>
              ) : null}
            </span>
            {error ? (
              <span className="mt-1.5 block text-[11px] font-normal leading-relaxed text-red-600">
                {error}
              </span>
            ) : null}
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="tw-confirm-cancel h-8 px-3 text-sm rounded-lg text-stone-600 hover:bg-stone-100 transition-colors"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              disabled={!value.trim()}
              onClick={submit}
              className="h-8 px-4 text-sm font-medium text-white bg-[#4176e6] rounded-lg hover:bg-[#3565c7] disabled:opacity-40 transition-colors"
            >
              {confirmLabel}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
