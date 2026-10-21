import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Props {
  fields: string[];
  /** 多工作表时展示的名称行 */
  sheetNames?: string[];
}

/**
 * 按容器宽度尽量铺满一行字段标签；装不下时显示 +N，点击展开全部。
 */
export default function ExcelFieldTags({ fields, sheetNames }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [visibleCount, setVisibleCount] = useState(fields.length);
  const [expanded, setExpanded] = useState(false);

  const recalc = useCallback(() => {
    const root = rootRef.current;
    const measure = measureRef.current;
    if (!root || !measure || fields.length === 0) return;

    // 用外层满宽容器量宽，避免随可见 chip 变少而收缩
    const maxW = root.clientWidth;
    if (maxW <= 0) return;

    const gap = 4;
    const chips = Array.from(measure.querySelectorAll<HTMLElement>('[data-chip]'));
    const widths = chips.map((el) => el.offsetWidth);
    const moreW = moreRef.current?.offsetWidth ?? 36;

    let total = 0;
    for (let i = 0; i < widths.length; i++) {
      total += widths[i]! + (i > 0 ? gap : 0);
    }
    if (total <= maxW) {
      setVisibleCount(fields.length);
      return;
    }

    let used = 0;
    let count = 0;
    for (let i = 0; i < widths.length; i++) {
      const next = used + (count > 0 ? gap : 0) + widths[i]!;
      const withMore = next + gap + moreW;
      if (withMore <= maxW || (i === widths.length - 1 && next <= maxW)) {
        used = next;
        count = i + 1;
      } else {
        break;
      }
    }
    setVisibleCount(Math.max(1, Math.min(count, fields.length - 1)));
  }, [fields.length]);

  useLayoutEffect(() => {
    setExpanded(false);
    recalc();
    // 字段集合变化才重算：fields 每次渲染都是新数组，用拼接签名做等价比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.join('\0'), recalc]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!expanded) recalc();
    });
    ro.observe(root);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, fields.join('\0'), recalc]);

  if (!fields.length) return null;

  const shown = expanded ? fields : fields.slice(0, visibleCount);
  const hidden = expanded ? 0 : Math.max(0, fields.length - visibleCount);

  return (
    <div ref={rootRef} className="mt-1.5 relative w-full min-w-0">
      {sheetNames && sheetNames.length > 1 && (
        <p className="mb-1.5 text-xs text-stone-400 truncate" data-hint={sheetNames.join(' | ')}>
          工作表：{sheetNames.join(' | ')}
        </p>
      )}

      {/* 隐藏测量层：渲染全部 chip 以量宽。限定为容器宽度并裁剪，
          否则这层会被内容撑宽，把抽屉的横向滚动条撑出来 */}
      <div
        ref={measureRef}
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 flex w-full gap-1 overflow-hidden opacity-0 whitespace-nowrap"
        aria-hidden
      >
        {fields.map((f) => (
          <span
            key={`m-${f}`}
            data-chip
            className="text-[11px] px-1.5 py-0.5 rounded border border-stone-200 max-w-36 shrink-0 truncate"
          >
            {f}
          </span>
        ))}
        <button
          ref={moreRef}
          type="button"
          tabIndex={-1}
          className="text-[11px] px-1.5 py-0.5 shrink-0"
        >
          +99
        </button>
      </div>

      <div
        className={`flex gap-1 items-center w-full min-w-0 ${
          expanded ? 'flex-wrap' : 'flex-nowrap overflow-hidden'
        }`}
      >
        {shown.map((f) => (
          <span
            key={f}
            className="text-[11px] px-1.5 py-0.5 rounded border border-stone-200 text-stone-500 max-w-36 truncate shrink-0"
            data-hint={f}
          >
            {f}
          </span>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-[11px] text-stone-400 hover:text-amber-700 cursor-pointer shrink-0"
          >
            +{hidden}
          </button>
        )}
        {expanded && fields.length > visibleCount && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-[11px] text-stone-400 hover:text-amber-700 cursor-pointer shrink-0"
          >
            收起
          </button>
        )}
      </div>
    </div>
  );
}
