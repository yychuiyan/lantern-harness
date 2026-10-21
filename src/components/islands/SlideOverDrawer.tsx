/**
 * 右侧抽屉：滑入/滑出动画 + Esc / 遮罩关闭。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const EXIT_MS = 220;

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** 遮罩 aria-label */
  closeAriaLabel?: string;
  /** 抽屉宽度（Tailwind max-w-* 类）；默认 max-w-md。宽面板用 max-w-2xl / max-w-3xl */
  widthClass?: string;
  /** 内层弹窗打开时置 true：Esc 交给弹窗处理，避免连抽屉一起关掉 */
  escDisabled?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}

export default function SlideOverDrawer({
  open,
  onClose,
  title,
  closeAriaLabel = '关闭面板',
  widthClass = 'max-w-md',
  escDisabled = false,
  children,
  footer,
}: Props) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => setEntered(true));
      });
      return () => window.cancelAnimationFrame(id);
    }
    setEntered(false);
    const t = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open || escDisabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // 抽屉里的下拉菜单展开时不抢 Esc：让菜单先关，再按一次才关抽屉
      if (document.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, escDisabled]);

  if (!mounted) return null;

  const overlay = (
    <div className="fixed inset-0 z-60 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        className={`absolute inset-0 bg-stone-900/30 transition-opacity duration-200 ease-out ${
          entered ? 'opacity-100' : 'opacity-0'
        }`}
        aria-label={closeAriaLabel}
        onClick={onClose}
      />
      <aside
        className={`tw-slide-over relative w-full ${widthClass} h-full shadow-2xl border-l border-stone-200 flex flex-col transition-transform duration-200 ease-out will-change-transform ${
          entered ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="shrink-0 h-12 px-4 border-b border-stone-100 flex items-center gap-2">
          <h2 className="tw-slide-over-title text-sm font-semibold text-stone-800 flex-1">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="tw-icon-btn w-8 h-8 rounded-lg"
            data-hint="关闭（Esc）"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">{children}</div>
        {footer}
      </aside>
    </div>
  );

  // 挂到 body：抽屉在页面内容里时，<main> 的 view-transition-name 会形成层叠上下文，
  // 遮罩再高也盖不住 z-45 的左侧栏，打开时导航会「透」在蒙版上方。
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}
