/**
 * 名称维护弹窗：新增 / 重命名 / 删除。
 *
 * 用例类型、提示词类型、知识库分类共用同一套交互与外观（CaseTypeDialog 也只是它的薄封装）。
 *
 * 挂到 body：外层抽屉是 body 级 portal + z-60，且带 transform（translate-x），
 * 弹窗留在抽屉内部会被当成定位容器并压在遮罩下，所以这里显式 portal 并抬高 z。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type NameEditMode = 'add' | 'edit' | 'delete';

interface Props {
  mode: NameEditMode | null;
  /** 实体名（用例类型 / 提示词类型 / 知识库分类），用于标题与默认文案 */
  entityLabel: string;
  /** 当前名称：编辑时预填，删除时用于提示 */
  currentLabel: string;
  /** 输入框占位文案 */
  placeholder?: string;
  /** 输入框下方的说明；入参是当前输入的名称，便于写出「目录随名称生成」这类提示 */
  hint?: (name: string) => ReactNode;
  /** 删除确认正文；不传用默认文案 */
  deleteMessage?: (currentLabel: string) => ReactNode;
  /** 删除确认正文下方的补充说明块 */
  deleteNote?: ReactNode;
  /** 提交失败的原因（重名、名字为空等）：弹窗不关，就地提示 */
  error?: string;
  onClose: () => void;
  onSubmit: (label: string) => void;
  onDelete: () => void;
}

export default function NameEditDialog({
  mode,
  entityLabel,
  currentLabel,
  placeholder,
  hint,
  deleteMessage,
  deleteNote,
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
            {mode === 'delete'
              ? `删除${entityLabel}`
              : mode === 'edit'
                ? `编辑${entityLabel}`
                : `新增${entityLabel}`}
          </DialogTitle>

          {mode === 'delete' ? (
            <>
              <p className="tw-confirm-msg mt-3 text-sm leading-relaxed text-stone-600">
                {deleteMessage
                  ? deleteMessage(currentLabel)
                  : `确定删除「${currentLabel}」？删除后该项将不再出现在配置里，已生成的内容不受影响。`}
              </p>
              {deleteNote ? (
                <p className="mt-2 rounded-lg bg-stone-50 px-3 py-2 text-[11px] leading-4 text-stone-500">
                  {deleteNote}
                </p>
              ) : null}
            </>
          ) : (
            <label className="tw-confirm-msg mt-4 block text-xs font-medium text-stone-500">
              名称
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
                placeholder={placeholder}
                className="mt-1.5 h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-800 outline-none transition-colors focus:border-[#4176e6] focus:ring-2 focus:ring-[#4176e6]/30"
              />
            </label>
          )}

          {error ? (
            <p className="mt-2 text-[11px] font-normal leading-relaxed text-red-600" role="alert">
              {error}
            </p>
          ) : null}

          {mode === 'delete' || !hint ? null : (
            <p className="mt-2 text-[11px] leading-4 text-stone-400">{hint(name)}</p>
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
