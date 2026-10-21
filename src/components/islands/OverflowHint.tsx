/**
 * 溢出预览气泡：仅当文本真的被截断（显示省略号）时，悬停弹出气泡显示完整内容。
 *
 * 为什么用 portal + fixed：
 * - 列表容器常有 overflow-hidden（如知识库 <ul>），绝对定位的气泡会被裁切；
 * - 列表行常带入场 animation，动画期间 transform 会建 containing block，劫持 fixed 定位。
 * portal 到 body 后完全脱离该子树，两种情况都能规避，并配合滚动 / 缩放跟随。
 *
 * 进出场动画：移入时挂载并在下一帧切到展开态，移出时先过渡再卸载，
 * 过渡样式见 global.css 的 .tw-tooltip-anim（沿用 .tw-menu-anim 的 [data-closed] 约定）。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** 气泡层级：低于 ConfirmDialog 的 z-90，保证弹窗仍可覆盖气泡 */
const Z_INDEX = 80;
/** 气泡最大宽度（px）：长文件名 / 长路径需要换行，避免撑破视口 */
const MAX_WIDTH = 420;
/** 箭头中心距气泡左右边缘的最小内缩（px）：保证 45° 旋转后不越出圆角 */
const ARROW_INSET = 14;
/** 进出场时长（ms），需与 .tw-tooltip-anim 的 transition 保持一致 */
const ANIM_MS = 150;

type Pos = { top: number; left: number; maxWidth: number; openUp: boolean; arrowLeft: number };

export default function OverflowHint({
  text,
  className,
  disabled = false,
  matchAnchorWidth = false,
}: {
  text: string;
  className?: string;
  /** 为 true 时强制不显示气泡（如卡片已展开、无需预览） */
  disabled?: boolean;
  /**
   * 气泡宽度固定成锚点宽度（长标题不再挤成窄条）。
   * 宽度取最近的 `[data-hint-width]` 祖先，没有就取文本自身；
   * 典型用法是在卡片外层标 `data-hint-width`，让气泡和卡片同宽。
   */
  matchAnchorWidth?: boolean;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [hover, setHover] = useState(false);
  /** 是否留在 DOM 中：退场过渡期间仍需挂载 */
  const [mounted, setMounted] = useState(false);
  /** 展开态：false 渲染 data-closed（收起），true 过渡到展开 */
  const [entered, setEntered] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);

  // 测量是否真的超出（scrollWidth > clientWidth 才是被省略号截断）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [text]);

  // 不满足显示条件时收起气泡
  useLayoutEffect(() => {
    if (disabled || !overflow) setHover(false);
  }, [disabled, overflow]);

  // 悬停 → 挂载并切到展开态；移开 → 收起并等过渡结束再卸载
  useLayoutEffect(() => {
    if (hover) {
      setMounted(true);
      // 双 rAF：先让「收起态」渲染一帧，否则同帧切开会跳过过渡（首帧无起始值）
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setEntered(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        if (inner) cancelAnimationFrame(inner);
      };
    }
    setEntered(false);
    const timer = window.setTimeout(() => setMounted(false), ANIM_MS);
    return () => window.clearTimeout(timer);
  }, [hover]);

  /** 按元素当前位置计算气泡坐标；坐标未变则复用原对象，避免无谓重渲染 */
  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 指定按卡片同宽时，取最近的标记元素量宽度（文本自身只是卡片里的一列）
    const widthHost = matchAnchorWidth
      ? ((el.closest('[data-hint-width]') as HTMLElement | null) ?? el)
      : el;
    const hostRect = widthHost.getBoundingClientRect();
    const widthBase = matchAnchorWidth ? hostRect.width : r.width;
    const maxWidth = Math.min(Math.max(widthBase, 160), MAX_WIDTH);
    const openUp = r.bottom + 72 > window.innerHeight - 8;
    const top = openUp ? r.top - 6 : r.bottom + 6;
    // 同宽气泡贴着卡片左边对齐；其它情况仍跟着文本左缘走
    const leftBase = matchAnchorWidth ? hostRect.left : r.left;
    const left = Math.max(8, Math.min(leftBase, Math.max(8, window.innerWidth - maxWidth - 8)));
    // 箭头对准锚点水平中心：锚点宽时不再挤在气泡最左边；
    // 气泡被视口右缘夹住时按夹取后的偏移跟随，并保证不超出气泡两端圆角。
    const arrowLeft = Math.max(
      ARROW_INSET,
      Math.min(r.left + r.width / 2 - left, maxWidth - ARROW_INSET),
    );
    setPos((prev) =>
      prev &&
      prev.top === top &&
      prev.left === left &&
      prev.maxWidth === maxWidth &&
      prev.openUp === openUp &&
      prev.arrowLeft === arrowLeft
        ? prev
        : { top, left, maxWidth, openUp, arrowLeft },
    );
  }, [matchAnchorWidth]);

  // 挂载期间每次渲染后重算坐标：排序 / 分页等重排会让元素位移，气泡需跟着走。
  // 故意不给依赖数组：需要在任何重渲染后重新定位；place() 在坐标未变时返回原对象，
  // 不会引发额外渲染，故不存在 exhaustive-deps 担心的无限更新链。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!mounted) {
      setPos(null);
      return;
    }
    place();
  });

  // 滚动 / 缩放时重算（capture 阶段以覆盖内部滚动容器）
  useLayoutEffect(() => {
    if (!mounted) return;
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [mounted, place]);

  return (
    <>
      <span
        ref={ref}
        className={className}
        onMouseEnter={() => {
          if (overflow && !disabled) setHover(true);
        }}
        onMouseLeave={() => setHover(false)}
      >
        {text}
      </span>
      {mounted && pos && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="tooltip"
              data-closed={entered ? undefined : ''}
              className={`tw-tooltip tw-tooltip-anim ${
                pos.openUp ? 'is-up' : 'is-down'
              } pointer-events-none fixed rounded-md px-2 py-1 text-[12px] leading-5 break-all text-stone-700 shadow-lg`}
              style={{
                zIndex: Z_INDEX,
                top: pos.top,
                left: pos.left,
                maxWidth: pos.maxWidth,
                // 按锚点同宽：固定宽度，长标题也铺满整张卡片
                ...(matchAnchorWidth ? { width: pos.maxWidth } : null),
              }}
            >
              {/* 指向锚点的小凸起：对准锚点中心，随上下翻转切换朝向 */}
              <span
                aria-hidden="true"
                className={`tw-tooltip-arrow ${pos.openUp ? 'is-up' : 'is-down'} absolute h-2 w-2`}
                style={{
                  left: pos.arrowLeft,
                  ...(pos.openUp ? { bottom: -5 } : { top: -5 }),
                  transform: 'translateX(-50%) rotate(45deg)',
                }}
              />
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
