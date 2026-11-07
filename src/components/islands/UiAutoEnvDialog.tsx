/**
 * 环境配置弹窗（独立入口：执行页运行条上的「环境配置」）。
 *
 * 内容全在 `UiAutoEnvPanel` 里；「项目配置」弹窗直接嵌同一个面板，避免两份口径。
 * 关闭只有右上角 X（底部不再留「关闭」），保存仍在面板底部操作条。
 * 有未保存改动时和「项目配置」一样先确认：两处关闭口径保持一致，别在这里静默丢改动。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useState } from 'react';

import type { UiAutoProject } from '../../lib/ui-auto';
import ConfirmDialog from './ConfirmDialog';
import { PmIcon } from './PmShared';
import UiAutoEnvPanel from './UiAutoEnvPanel';

interface Props {
  project: UiAutoProject;
  onClose: () => void;
  /** 保存后回调：带回来更新过的项目记录（改了默认环境时服务端会返回） */
  onSaved?: (project?: UiAutoProject) => void;
}

export default function UiAutoEnvDialog({ project, onClose, onSaved }: Props) {
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const requestClose = () => {
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <Dialog open onClose={requestClose} className="relative z-110">
        <DialogBackdrop
          transition
          className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
          aria-hidden="true"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="tw-pop-dialog-anim flex h-[min(86vh,760px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-(--tw-border) bg-(--tw-surface-panel) shadow-2xl"
          >
            <div className="flex shrink-0 items-start gap-3 border-b border-(--tw-border) px-5 py-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-(--tw-accent-soft) text-(--tw-accent)">
                <PmIcon name="sliders" size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-[15px] leading-6 font-semibold text-[var(--tw-label-primary)]">
                  环境配置
                </DialogTitle>
                <p className="mt-0.5 truncate text-[11px] text-[var(--tw-label-tertiary)]">
                  {project.name} · 直接读写项目里的 .env 文件，运行与 CLI 用的是同一份
                </p>
              </div>
              <button
                type="button"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm text-(--tw-label-tertiary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary)"
                onClick={requestClose}
                aria-label="关闭环境配置"
              >
                ✕
              </button>
            </div>
            <UiAutoEnvPanel project={project} onSaved={onSaved} onDirtyChange={setDirty} />
          </DialogPanel>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmClose}
        title="关闭环境配置"
        message="环境配置还有未保存的改动，关闭后这些改动会丢掉。"
        confirmLabel="仍然关闭"
        onClose={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
      />
    </>
  );
}
