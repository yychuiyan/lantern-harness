/**
 * 表格列宽拖拽。
 *
 * 两套表格（待办 / 任务）都按列定义渲染 <colgroup>，默认宽度就是设计稿里的宽度；
 * 用户拖表头右边缘时把每一列「冻结」成实测像素，再只改被拖的那一列，
 * 这样拖完不会因为 table-layout:fixed 重新分配剩余宽度而整体跳动。
 * 结果按页面存 localStorage，刷新后保持。
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const MIN_WIDTH = 44;
/** 自适应列在计算最小表宽时按这个宽度估算 */
const FLEX_FALLBACK = 200;

export interface ColumnSpec {
  /** 列标识，用于持久化；同一表格内唯一 */
  key: string;
  /** 初始宽度（px）；省略表示自适应剩余宽度 */
  width?: number;
  /** 拖拽时允许的最小宽度 */
  min?: number;
}

function readStored(storageKey: string): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        out[key] = Math.round(value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function useColumnWidths(storageKey: string, columns: readonly ColumnSpec[]) {
  const [widths, setWidths] = useState<Record<string, number>>(() => readStored(storageKey));
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  /** 各列的像素宽度；undefined = 自适应 */
  function widthOf(key: string): number | undefined {
    const stored = widths[key];
    if (stored) return stored;
    return columns.find((c) => c.key === key)?.width;
  }

  const total = columns.reduce((sum, c) => sum + (widthOf(c.key) ?? FLEX_FALLBACK), 0);

  function startResize(index: number) {
    return (e: ReactPointerEvent<HTMLElement>) => {
      const th = e.currentTarget.parentElement;
      const thead = th?.closest('thead');
      if (!th || !thead) return;
      e.preventDefault();
      e.stopPropagation();

      // 开始拖之前先把所有列按实测宽度冻结，避免表格重新分配剩余空间
      const headerCells = thead.querySelectorAll('tr')[0]?.children ?? [];
      const frozen: Record<string, number> = {};
      columnsRef.current.forEach((spec, i) => {
        const cell = headerCells[i] as HTMLElement | undefined;
        const measured = cell?.getBoundingClientRect().width ?? spec.width ?? FLEX_FALLBACK;
        // 这里只记录实测值；列的最小宽度只在拖动该列时生效，
        // 否则像勾选框这种窄列一开始就会被撑到最小宽度
        frozen[spec.key] = Math.max(1, Math.round(measured));
      });
      setWidths(frozen);

      const spec = columnsRef.current[index];
      if (!spec) return;
      const startX = e.clientX;
      const startWidth = frozen[spec.key] ?? FLEX_FALLBACK;
      const min = Math.max(MIN_WIDTH, spec.min ?? MIN_WIDTH);

      document.body.classList.add('tw-col-resizing');
      const onMove = (ev: PointerEvent) => {
        const next = Math.max(min, Math.round(startWidth + ev.clientX - startX));
        setWidths((prev) => ({ ...prev, [spec.key]: next }));
      };
      const finish = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        document.body.classList.remove('tw-col-resizing');
        // 用函数式更新拿最新宽度再落盘：松手太快时新一轮渲染可能还没发生
        setWidths((prev) => {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(prev));
          } catch {
            // 隐私模式下写不进去也不影响本次使用
          }
          return prev;
        });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    };
  }

  return {
    widthOf,
    /** 表头拖拽热区用：左右拖动改宽度，双击恢复该列默认宽度 */
    resizeProps(index: number) {
      return {
        onStart: startResize(index),
        onReset: () => {
          const spec = columnsRef.current[index];
          if (!spec) return;
          setWidths((prev) => {
            if (!(spec.key in prev)) return prev;
            const next = { ...prev };
            delete next[spec.key];
            try {
              window.localStorage.setItem(storageKey, JSON.stringify(next));
            } catch {
              // 忽略写入失败
            }
            return next;
          });
        },
      };
    },
    // 表格始终铺满容器：还有自适应列时它吃掉剩余宽度；
    // 全部列都有宽度后，多出来的空间按比例摊给各列，避免右侧留一条空白。
    tableStyle: {
      width: '100%',
      minWidth: total,
    } as const,
  };
}

/** 表头右边缘的拖拽热区；父级 <th> 需要 relative。双击恢复该列默认宽度。 */
export function ColumnResizeHandle(props: {
  onStart: (e: ReactPointerEvent<HTMLElement>) => void;
  onReset?: () => void;
}) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整列宽，双击恢复默认"
      onPointerDown={props.onStart}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onReset?.();
      }}
      className="tw-col-resize absolute top-0 right-0 z-20 h-full w-2 cursor-col-resize touch-none select-none"
    />
  );
}
