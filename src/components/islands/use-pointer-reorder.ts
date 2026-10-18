/**
 * 按住拖动排序（侧栏分组 / 菜单项排序共用）。
 * 用 window 级 pointermove / pointerup 实现，不依赖 setPointerCapture（部分 webview 不稳定）。
 *
 * 列表容器上加 `ref={listRef}`，参与排序的行加 `data-sort-key="<id>"`；
 * 在行的拖拽手柄上调用 `onPointerDown(id, e)`。
 */
import { useRef, useState, type PointerEvent } from 'react';

import { reorderList } from '../../lib/nav-menu';

export function usePointerReorder<T extends string>(
  ids: readonly T[],
  onChange: (next: T[]) => void,
  onEnd?: () => void,
) {
  const [dragId, setDragId] = useState<T | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const endRef = useRef(onEnd);
  endRef.current = onEnd;

  function onPointerDown(id: T, e: PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const list = listRef.current;
    if (!list) return;
    setDragId(id);

    const overRow = (y: number): T | null => {
      const rows = [...list.querySelectorAll<HTMLElement>('[data-sort-key]')];
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom) return row.dataset.sortKey as T;
      }
      return null;
    };

    const track = (ev: globalThis.PointerEvent) => {
      const over = overRow(ev.clientY);
      if (!over || over === id) return;
      const next = reorderList(idsRef.current, id, over);
      if (next.join('|') === idsRef.current.join('|')) return;
      idsRef.current = next;
      changeRef.current(next);
    };

    const finish = () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      setDragId(null);
      endRef.current?.();
    };

    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  return { listRef, dragId, onPointerDown };
}
