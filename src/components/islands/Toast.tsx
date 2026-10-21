/**
 * 轻量 toast：页面内的即时反馈（保存成功 / 提示词没读到），不打断操作。
 *
 * 两种用法：
 * - 任意模块直接 `showToast('...', 'error')`：事件冒泡到全局宿主 `GlobalToastHost`
 *   （由 Base.astro 常驻挂载，跨页面软导航不丢）；
 * - 页面内自渲染：`const toast = useToast()` + `<ToastHost state={toast.state} onClose={toast.hide} />`。
 *
 * 默认 3s 自动消失；错误停留久一点，方便看清原因。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastState {
  message: string;
  tone: ToastTone;
  /** 每次 show 递增，相同文案也能重新触发动画 / 计时 */
  seq: number;
}

export interface ToastApi {
  state: ToastState | null;
  show: (message: string, tone?: ToastTone) => void;
  hide: () => void;
}

/** 全局 toast 事件名：detail = { message, tone } */
const TOAST_EVENT = 'lantern:toast';

/** 宿主自动消失时长：错误多留一会儿 */
const DURATION: Record<ToastTone, number> = {
  info: 2600,
  success: 2600,
  error: 4200,
};

const TONE: Record<ToastTone, { dot: string; box: string; text: string }> = {
  info: {
    dot: 'bg-stone-400',
    box: 'border-stone-200 bg-white tw-toast-info',
    text: 'text-stone-700',
  },
  success: {
    dot: 'bg-emerald-500',
    box: 'border-emerald-200 bg-white tw-toast-success',
    text: 'text-emerald-700',
  },
  error: {
    dot: 'bg-red-500',
    box: 'border-red-200 bg-white tw-toast-error',
    text: 'text-red-600',
  },
};

/**
 * 从任意模块弹一条 toast（不依赖 React 上下文）。
 * 全局宿主不在（极早期 / 静态页）时静默忽略，不影响主流程。
 */
export function showToast(message: string, tone: ToastTone = 'info'): void {
  const text = String(message ?? '').trim();
  if (!text || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message: text, tone } }));
}

export function useToast(): ToastApi {
  const [state, setState] = useState<ToastState | null>(null);
  const seqRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const hide = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState(null);
  }, []);

  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    const text = String(message ?? '').trim();
    if (!text) return;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    seqRef.current += 1;
    setState({ message: text, tone, seq: seqRef.current });
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setState(null);
    }, DURATION[tone] ?? 2600);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return { state, show, hide };
}

interface HostProps {
  state: ToastState | null;
  onClose: () => void;
  /** 距页面顶部的偏移；页面顶部有固定栏时可下移避让 */
  topClassName?: string;
}

/** toast 出口：同一时刻只显示一条，固定在页面顶部居中 */
export function ToastHost({ state, onClose, topClassName = 'top-[68px]' }: HostProps) {
  if (!state) return null;
  const tone = TONE[state.tone] ?? TONE.info;
  return (
    <div
      key={state.seq}
      className={`tw-plugin-toast pointer-events-none fixed left-1/2 z-[200] -translate-x-1/2 ${topClassName}`}
      role={state.tone === 'error' ? 'alert' : 'status'}
      aria-live={state.tone === 'error' ? 'assertive' : 'polite'}
    >
      <div
        className={`tw-toast-box pointer-events-auto flex max-w-[min(92vw,520px)] items-start gap-2 rounded-xl border px-3.5 py-2.5 shadow-lg ${tone.box}`}
      >
        <span
          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`}
          aria-hidden="true"
        />
        <p className={`tw-toast-text text-[12px] leading-relaxed ${tone.text}`}>{state.message}</p>
        <button
          type="button"
          onClick={onClose}
          className="tw-toast-close -mr-1 ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
          aria-label="关闭提示"
        >
          <svg viewBox="0 0 24 24" width={11} height={11} fill="none" aria-hidden="true">
            <path
              d="M5 5l14 14M19 5 5 19"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * 全局宿主：挂一次，任何模块的 `showToast()` 都能显示。
 * 放在 Base.astro 里 `transition:persist`，软导航后不用重挂。
 */
export function GlobalToastHost() {
  const [state, setState] = useState<ToastState | null>(null);
  const seqRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const hide = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState(null);
  }, []);

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string; tone?: ToastTone }>).detail ?? {};
      const text = String(detail.message ?? '').trim();
      if (!text) return;
      const tone: ToastTone = detail.tone ?? 'info';
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      seqRef.current += 1;
      setState({ message: text, tone, seq: seqRef.current });
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setState(null);
      }, DURATION[tone] ?? 2600);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return <ToastHost state={state} onClose={hide} />;
}
