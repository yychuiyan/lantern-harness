/**
 * 用例类型维护弹窗：新增 / 重命名 / 删除。
 *
 * 挂到 body：外层抽屉是 body 级 portal + z-60，且带 transform（translate-x），
 * 弹窗留在抽屉内部会被当成定位容器并压在遮罩下，所以这里显式 portal 并抬高 z。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type CaseTypeDialogMode = 'add' | 'edit' | 'delete';

interface Props {
  mode: CaseTypeDialogMode | null;
  /** 当前类型名：编辑时预填，删除时用于提示 */
  currentLabel: string;
  /** 编辑/删除的目标类型模板目录（用于提示会用到哪个模板文件夹） */
  templateFolder: string;
  /** 提交失败的原因（重名、名字为空等）：弹窗不关，就地提示 */
  error?: string;
  onClose: () => void;
  onSubmit: (label: string) => void;
  onDelete: () => void;
}

export default function CaseTypeDialog({
  mode,
  currentLabel,
  templateFolder,
  error = '',
  onClose,
  onSubmit,
  onDelete,
}: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode !== 'add' && mode !== 'edit') return;
    setValue(mode === 'edit' ? currentLabel : '');
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => window.clearTimeout(t);
  }, [mode, currentLabel]);

  if (typeof document === 'undefined') return null;

  const name = value.trim();

  const dialog = (
    <Dialog open={mode !== null} onClose={onClose} transition className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="tw-confirm-dialog tw-dialog-panel-anim relative w-full max-w-sm rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
        >
          <DialogTitle className="tw-confirm-title pr-8 text-base font-semibold text-stone-900">
            {mode === 'delete' ? '删除用例类型' : mode === 'edit' ? '编辑用例类型' : '新增用例类型'}
          </DialogTitle>

          {mode === 'delete' ? (
            <>
              <p className="tw-confirm-msg mt-3 text-sm leading-relaxed text-stone-600">
                确定删除「{currentLabel}
                」？已有用例与模板不会被删除，但该类型将不再出现在生成配置里。
              </p>
              <p className="mt-2 rounded-lg bg-stone-50 px-3 py-2 text-[11px] leading-4 text-stone-500">
                关联模板目录：测试模板库/{templateFolder}/
              </p>
            </>
          ) : (
            <label className="tw-confirm-msg mt-4 block text-xs font-medium text-stone-500">
              类型名称
              <input
                ref={inputRef}
                value={value}
                maxLength={40}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (name) onSubmit(name);
                  }
                }}
                placeholder="如：安全测试"
                className="mt-1.5 h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-800 outline-none transition-colors focus:border-[#4176e6] focus:ring-2 focus:ring-[#4176e6]/30"
              />
            </label>
          )}

          {error ? (
            <p className="mt-2 text-[11px] font-normal leading-relaxed text-red-600" role="alert">
              {error}
            </p>
          ) : null}

          {mode === 'delete' ? null : (
            <p className="mt-2 text-[11px] leading-4 text-stone-400">
              模板目录随名称生成：测试模板库/{name || '名称'}用例/
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="tw-confirm-cancel h-8 rounded-lg px-3 text-sm text-stone-600 transition-colors hover:bg-stone-100"
            >
              取消
            </button>
            {mode === 'delete' ? (
              <button
                type="button"
                onClick={onDelete}
                className="h-8 rounded-lg bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700"
              >
                删除
              </button>
            ) : (
              <button
                type="button"
                disabled={!name}
                onClick={() => onSubmit(name)}
                className="h-8 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#3565c7] disabled:opacity-40"
              >
                {mode === 'edit' ? '保存' : '新增'}
              </button>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );

  return createPortal(dialog, document.body);
}
