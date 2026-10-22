import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useState } from 'react';
import type { ComposerTask } from '../../lib/composer-task';

interface Props {
  task: ComposerTask | null;
  onClose: () => void;
  /** 保存修改后的正文 */
  onSave: (body: string) => void;
  /** 移除这张任务卡 */
  onRemove: () => void;
}

/**
 * 任务卡预览 / 编辑：评审跳过来的长要求默认收成胶囊，点开在这里看全文、改完再发。
 * 打开时把正文拷进本地草稿，取消不会动原卡片。
 */
export default function ComposerTaskDialog({ task, onClose, onSave, onRemove }: Props) {
  const [draft, setDraft] = useState('');
  const open = Boolean(task);

  useEffect(() => {
    setDraft(task?.body ?? '');
  }, [task]);

  const changed = Boolean(task) && draft.trim() !== task?.body.trim();

  return (
    <Dialog open={open} onClose={onClose} transition className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="tw-dialog-panel-anim relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3.5 right-3.5 flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-label="关闭"
          >
            ✕
          </button>
          <DialogTitle className="pr-8 text-base font-semibold text-stone-900">
            {task?.label || '任务要求'}
          </DialogTitle>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-stone-400">
            <span>发送时这段要求会随消息一起带给模型</span>
            {task?.detail ? <span className="truncate">· {task.detail}</span> : null}
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="mt-3 min-h-[240px] flex-1 resize-none overflow-y-auto rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-stone-700 outline-none focus:border-[#4176e6]/40 focus:bg-white"
          />
          <div className="mt-4 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onRemove}
              className="h-8 rounded-lg border border-stone-200 px-3 text-sm text-stone-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600"
            >
              移除
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-8 rounded-lg border border-stone-200 px-3 text-sm text-stone-600 transition-colors hover:bg-stone-100"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!draft.trim()}
                onClick={() => onSave(draft.trim())}
                className="h-8 rounded-lg bg-[#4176e6] px-3.5 text-sm text-white transition-colors hover:bg-[#3566d0] disabled:cursor-not-allowed disabled:bg-stone-300"
              >
                {changed ? '保存修改' : '完成'}
              </button>
            </div>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
