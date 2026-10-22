/**
 * 表格列宽拖拽 + 横向滚动固定列。
 *
 * 表格（待办 / 任务 / 统计 / 评审）都按列定义渲染 <colgroup>，默认宽度就是设计稿里的宽度；
 * 用户拖表头右边缘时把各列「冻结」成实测像素，再只改被拖的那一列，
 * 这样拖完不会因为 table-layout:fixed 重新分配剩余宽度而整体跳动。
 *
 * 松手时落盘整份冻结快照（按列 key），但等于默认宽度的值不落盘；
 * 快照总宽≈容器宽，松手后不会按比例重排。
 *
 * 拖动时不画竖向引导线，只靠手柄（光标变 col-resize，悬停时手柄自己露出一小段竖线）
 * 与列实时变宽表示正在调整。双击手柄不做任何事。
 * `useScrollEdges` 配合 `.tw-sticky-l / .tw-sticky-r` 做首列与操作列固定；
 * 真的横向滚出去之后，固定列朝内容的一侧压一条 1px 细线做区分。
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const MIN_WIDTH = 44;
/** 自适应列在计算最小表宽时按这个宽度估算 */
const FLEX_FALLBACK = 200;
/** 单列宽度上限：防止拖动/脏数据把一列撑到吃掉整张表 */
const MAX_WIDTH = 1200;

export interface ColumnSpec {
  /** 列标识，用于持久化；同一表格内唯一 */
  key: string;
  /**
   * 初始宽度（px）。省略表示「默认自适应」：没有任何列被拖过时它吃剩余宽度；
   * 一旦开始拖动，它同样按实测像素冻结，跟其它列一致。
   */
  width?: number;
  /** 拖拽时允许的最小宽度 */
  min?: number;
  /**
   * 填充列：不可拖、不落盘，专门吃掉容器剩余的空间。
   * 放在操作列之前，让数据列严格按像素渲染、操作列贴住右边，
   * 列总宽超过容器时它自动变 0，表格转为横向滚动。
   */
  filler?: boolean;
}

/**
 * 列宽记忆的存储版本。
 * v2 → v3：文档库的左侧「勾选 + 文件名」合并成一个 sticky 外壳之后，
 * 旧版本按表头子元素下标冻结宽度会把宽度张冠李戴（文件名存成附加列的宽度等），
 * 这类快照会一直生效、看起来像「列宽被重置 / 怎么改都不对」，所以整体作废一次。
 */
const STORE_VERSION = 'v3';

function storageKeyOf(base: string): string {
  return base.endsWith(`:${STORE_VERSION}`) ? base : `${base}:${STORE_VERSION}`;
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

/** 该列允许的宽度区间 */
function boundsOf(spec: ColumnSpec): { min: number; max: number } {
  const min = Math.max(MIN_WIDTH, spec.min ?? MIN_WIDTH);
  return { min, max: Math.max(min, MAX_WIDTH) };
}

/**
 * 读取后校验：丢掉当前表格已经没有的列，把宽度夹进该列允许区间。
 * 换过列定义、或者历史脏数据把首列撑到几百像素时，在这里被清掉。
 */
function sanitizeWidths(
  widths: Record<string, number>,
  columns: readonly ColumnSpec[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(widths)) {
    const spec = columns.find((c) => c.key === key);
    if (!spec) continue;
    const { min, max } = boundsOf(spec);
    if (value < min - 1) continue;
    out[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  return out;
}

/**
 * 落盘前裁掉「等于默认宽度」的列。
 * 拖动会把所有列冻结成实测值，不裁的话默认宽度也进了 localStorage，
 * 快照总宽会显著偏离容器宽，用户改窗口大小后表格再也回不到自适应布局。
 */
function pruneWidths(
  widths: Record<string, number>,
  columns: readonly ColumnSpec[],
): Record<string, number> {
  const next = { ...widths };
  for (const c of columns) {
    const value = next[c.key];
    if (c.width == null || value == null) continue;
    // 实测值会因四舍五入差 1px，按 1px 容差判成默认
    if (Math.abs(value - c.width) <= 1) delete next[c.key];
  }
  return next;
}

/** 写 localStorage：裁完没剩自定义宽度就把键删掉，避免留一个空对象 */
function persist(
  storageKey: string,
  widths: Record<string, number>,
  columns: readonly ColumnSpec[],
): void {
  try {
    const next = pruneWidths(widths, columns);
    if (Object.keys(next).length) window.localStorage.setItem(storageKey, JSON.stringify(next));
    else window.localStorage.removeItem(storageKey);
  } catch {
    // 隐私模式下写不进去也不影响本次使用
  }
}

/**
 * 拖拽时不画任何引导线：只靠手柄本身（光标变 col-resize + 列实时变宽）表示。
 * 这里只负责清掉旧版本可能残留在 body 上的 `.tw-col-guide` 节点。
 */
function clearGuides(): void {
  for (const el of Array.from(document.querySelectorAll('.tw-col-guide'))) el.remove();
}

/** 已存宽度里是否有「非默认值」；旧版本残留的其它列 key 不算 */
function hasCustomWidths(widths: Record<string, number>, columns: readonly ColumnSpec[]): boolean {
  return Object.entries(widths).some(([key, value]) => {
    const spec = columns.find((c) => c.key === key);
    if (!spec) return false;
    return spec.width == null || Math.abs(value - spec.width) > 1;
  });
}

export function useColumnWidths(storageKey: string, columns: readonly ColumnSpec[]) {
  const key = storageKeyOf(storageKey);
  // render = 当前这一帧的实际宽度（拖动时会冻结成实测值）；manual = 上一次松手落盘的整份快照
  const [state, setState] = useState(() => {
    const stored = sanitizeWidths(readStored(key), columns);
    return { render: stored, manual: stored };
  });
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const widths = state.render;

  /** 各列的像素宽度；undefined = 自适应 */
  function widthOf(key: string): number | undefined {
    const stored = widths[key];
    if (stored) return stored;
    return columns.find((c) => c.key === key)?.width;
  }

  /** 数据列宽度之和（填充列不参与）：表格至少这么宽，超出容器就横向滚动 */
  const total = columns.reduce(
    (sum, c) => (c.filler ? sum : sum + (widthOf(c.key) ?? FLEX_FALLBACK)),
    0,
  );

  /** 按列 key 找下标；传数字时沿用旧的位置语义 */
  function indexOf(target: string | number): number {
    if (typeof target === 'number') return target;
    return columnsRef.current.findIndex((c) => c.key === target);
  }

  /** 松手后落盘整份冻结快照：快照总宽≈拖动开始时的容器宽，
   *  所以松手后浏览器不会再按比例重排，被拖列宽度与拖动距离 1:1。 */
  function commitSnapshot(
    frozen: Record<string, number>,
    spec: ColumnSpec,
    value: number,
  ): Record<string, number> {
    const next = sanitizeWidths({ ...frozen, [spec.key]: value }, columnsRef.current);
    persist(key, next, columnsRef.current);
    return next;
  }

  function startResize(index: number) {
    return (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const handle = e.currentTarget;
      const th = handle.parentElement;
      const thead = th?.closest('thead');
      if (!th || !thead) return;
      e.preventDefault();
      e.stopPropagation();

      // 开始拖之前先把各数据列按实测宽度冻结，避免表格重新分配剩余空间；
      // 填充列不冻结（它就是用来吃剩余空间的），其余列只记实测值、不带最小宽度，
      // 否则像勾选框这种窄列一开始就会被撑宽
      const headerCells = thead.querySelectorAll('tr')[0]?.children ?? [];
      const frozen: Record<string, number> = {};
      columnsRef.current.forEach((spec, i) => {
        if (spec.filler) return;
        const cell = headerCells[i] as HTMLElement | undefined;
        frozen[spec.key] = Math.max(
          1,
          Math.round(cell?.getBoundingClientRect().width ?? spec.width ?? FLEX_FALLBACK),
        );
      });
      const spec = columnsRef.current[index];
      if (!spec) return;

      const startX = e.clientX;
      const startWidth = frozen[spec.key] ?? spec.width ?? FLEX_FALLBACK;
      const { min, max } = boundsOf(spec);
      const clamp = (v: number) => Math.min(max, Math.max(min, v));
      clearGuides();
      let moved = false;
      let latest = startWidth;

      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // 老浏览器不支持捕获也能用：下面同时挂了 window 监听
      }
      document.body.classList.add('tw-col-resizing');
      const onMove = (ev: PointerEvent) => {
        latest = clamp(Math.round(startWidth + ev.clientX - startX));
        if (!moved) {
          // 位移为 0 时不动任何状态：单纯点一下手柄不该让整张表突然变成固定像素宽度
          if (latest === startWidth) return;
          moved = true;
          setState((prev) => ({
            render: { ...frozen, [spec.key]: latest },
            manual: prev.manual,
          }));
          return;
        }
        setState((prev) => ({
          render: { ...prev.render, [spec.key]: latest },
          manual: prev.manual,
        }));
      };
      const finish = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        document.body.classList.remove('tw-col-resizing');
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {
          // 已释放 / 未捕获：忽略
        }
        // 没真的拖动（点了一下就松手）不动存储，把手柄做成「点击即脏数据」会很烦人
        // 点了一下就松手：不落盘、不改状态
        if (!moved) return;
        const next = commitSnapshot(frozen, spec, latest);
        setState({ render: next, manual: next });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    };
  }

  return {
    widthOf,
    /** 表头拖拽热区用：左右拖动改列宽。传列 key（推荐）或位置下标 */
    resizeProps(target: string | number) {
      return { onStart: startResize(indexOf(target)) };
    },
    // 表格始终铺满容器：还有自适应列时它吃掉剩余宽度；
    // 全部列都有宽度后，多出来的空间按比例摊给各列，避免右侧留一条空白。
    tableStyle: {
      width: '100%',
      minWidth: total,
    } as const,
  };
}

/**
 * 固定列的统一外观 —— 全站表格共用这一套，新增表格直接引用，不要各写一份 class。
 *
 * 参考基准是「用例执行统计」：
 *   左固定：勾选列 32px（px-2）+ 关键字段列紧跟其后，表头 py-2、单元格 py-1；
 *   右固定：操作列 px-3、内容居中，宽度由列定义给出（通常 76–88px）。
 * 只负责间距与对齐，颜色 / 底色 / 分隔线全部由 `.tw-sticky-l`、`.tw-sticky-r` 在 CSS 里统一。
 */
export const STICKY_HEAD_L = 'tw-sticky-l px-2 py-2 text-left font-medium';
/** 首列（勾选）或行号列：横向内边距更小，不浪费宽度 */
export const STICKY_HEAD_L_TIGHT = 'tw-sticky-l px-1 py-2 text-left font-medium whitespace-nowrap';
/** 需要挂列宽手柄的固定表头（父级要 relative） */
export const STICKY_HEAD_L_RESIZE =
  'tw-sticky-l relative px-2 py-2 text-left font-medium whitespace-nowrap';
export const STICKY_HEAD_R = 'tw-sticky-r px-3 py-2 text-center font-medium whitespace-nowrap';
export const STICKY_CELL_L = 'tw-sticky-l px-2 py-1 align-middle';
export const STICKY_CELL_L_TIGHT = 'tw-sticky-l px-1 py-1 align-middle';
export const STICKY_CELL_R = 'tw-sticky-r px-3 py-1 text-center align-middle';

/**
 * 表头右边缘的拖拽热区；父级单元格需要 relative。
 * 热区跨在列边界上（左右各 6px），几何样式统一在 `.tw-col-resize` 里。
 * 双击不做任何事——恢复默认宽度的入口已移除，误触双击不该悄悄改列宽。
 */
export function ColumnResizeHandle(props: {
  onStart: (e: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整列宽"
      onPointerDown={props.onStart}
      onDoubleClick={(e) => {
        // 只是不让双击透传到行上（列表行有双击打开），不改列宽
        e.stopPropagation();
      }}
      className="tw-col-resize"
    />
  );
}

/**
 * 横向滚动容器的固定列开关 + 滚动位置记忆。
 *
 * 两个坑：
 *  1. 不能只在挂载时恢复一次。这些表格 / 列表的数据都是异步拿的，挂载那一刻容器里
 *     还没有可滚动宽度，`el.scrollLeft = saved` 会被浏览器夹回 0，等于没记忆。
 *     所以改成「只要溢出就尝试恢复」，等 ResizeObserver / MutationObserver 报告
 *     内容长出来之后再写一次。
 *  2. `data-x-start / data-x-end` 必须和恢复在同一次布局里同步好，晚一帧写的话
 *     固定列的分隔线会先不画再补上，看起来就是闪一下。
 */
const SCROLL_KEY_PREFIX = 'lh:scroll-x:';

function readScrollX(key: string): number {
  if (!key) return 0;
  try {
    const raw = window.localStorage.getItem(key);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 1 ? Math.round(n) : 0;
  } catch {
    return 0;
  }
}

export function useScrollEdges(storageKey?: string) {
  const cleanupRef = useRef<(() => void) | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!el) return;
      const key = storageKey ? `${SCROLL_KEY_PREFIX}${storageKey}` : '';

      /**
       * x-start / x-end 记录滚到哪一端，CSS 靠它们决定固定列的分隔线画不画。
       * 必须每帧同步写（scroll 里调），否则滚动停下后状态会和实际位置脱节。
       */
      const sync = () => {
        el.dataset.xStart = el.scrollLeft > 1 ? 'true' : 'false';
        el.dataset.xEnd = el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? 'true' : 'false';
      };

      const saved = readScrollX(key);
      // settled：恢复完成（或用户自己滚过），之后不再干预滚动位置
      let settled = saved <= 0;
      // expected：我们自己写进去的位置。scroll 事件分不清是谁触发的，
      // 位置还等于 expected 就说明是恢复动作，不算用户操作。
      let expected = -1;

      const applyScroll = (value: number) => {
        expected = value;
        el.scrollLeft = value;
      };

      /** 有可滚动宽度了才恢复：否则 scrollLeft 会被夹成 0 */
      const tryRestore = () => {
        if (settled) return;
        const max = el.scrollWidth - el.clientWidth;
        if (max <= 1) return;
        const target = Math.min(saved, max);
        if (Math.abs(el.scrollLeft - target) > 1) applyScroll(target);
        // 内容还在陆续渲染时先按当前最大宽度恢复，后面长出来再补到准确位置
        if (target >= saved) settled = true;
        sync();
      };

      // 先同步做一次：表格类页面挂载时行已经在了，这一步就在首帧绘制之前完成
      sync();
      tryRestore();

      // 滚动中不写 localStorage（每帧一次太吵），停下来 160ms 再落盘
      let saveTimer = 0;
      const save = () => {
        if (!key) return;
        try {
          window.localStorage.setItem(key, String(Math.round(el.scrollLeft)));
        } catch {
          // 写不进去不影响本次使用
        }
      };
      const onScroll = () => {
        if (!settled) {
          // 还是我们恢复出来的位置 → 继续等数据渲染完
          if (expected >= 0 && Math.abs(el.scrollLeft - expected) <= 1) {
            sync();
            return;
          }
          // 用户自己动了：以用户为准
          settled = true;
        }
        sync();
        if (!key) return;
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(save, 160);
      };
      el.addEventListener('scroll', onScroll, { passive: true });

      const observer = new ResizeObserver(() => {
        sync();
        tryRestore();
      });
      observer.observe(el);
      const observeChildren = () => {
        for (const child of Array.from(el.children)) observer.observe(child);
      };
      observeChildren();

      // 数据是异步渲染进来的：行挂上来之后立即补一次恢复
      const mutations = new MutationObserver(() => {
        observeChildren();
        sync();
        tryRestore();
      });
      mutations.observe(el, { childList: true, subtree: true });

      // 兜底：半天都恢复不出来就别再管了（例如当前页根本没有可横向滚动的内容）
      const giveUp = window.setTimeout(() => {
        settled = true;
      }, 3000);

      cleanupRef.current = () => {
        window.clearTimeout(giveUp);
        window.clearTimeout(saveTimer);
        // 卸载 / 换页面时把最后的位置补存一次（否则 160ms 内的滚动会丢）
        save();
        el.removeEventListener('scroll', onScroll);
        observer.disconnect();
        mutations.disconnect();
      };
    },
    [storageKey],
  );
}

/**
 * 弹性列表（`li` + flex，不是 <table>）的列宽拖拽。
 *
 * 文档库文件列表用 flex 行渲染，没有 <colgroup> 可以改宽度，所以这里直接给单元格写 `width`。
 * 没有默认宽度的列平时 flex-1 吃掉剩余空间；一旦拖过任意列，所有列都按实测像素固定，
 * 列表允许横向滚动，不把内容裁掉。
 * 拖动开始时先把各列实测宽度冻结，避免 flex 重新分配导致其它列跟着跳。
 * 结果同样按列表存 localStorage。
 */
export function useFlexColumnWidths(storageKey: string, columns: readonly ColumnSpec[]) {
  const key = storageKeyOf(storageKey);
  // render = 当前这一帧的宽度（拖动时冻结成实测值）；manual = 上一次松手落盘的整份快照
  const [state, setState] = useState(() => {
    const stored = sanitizeWidths(readStored(key), columns);
    return { render: stored, manual: stored };
  });
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const widths = state.render;

  /** 有任意一列被改成非默认宽度：决定要不要启用固定列 / 横向滚动 */
  const hasCustom = hasCustomWidths(state.manual, columns);

  /** 该列被拖过就返回固定宽度样式，否则沿用 class 上的默认宽度 */
  function styleOf(key: string): { width: number; flex: '0 0 auto' } | undefined {
    const stored = widths[key];
    return stored ? { width: stored, flex: '0 0 auto' } : undefined;
  }

  /** 按列 key 找下标；传数字时沿用旧的位置语义 */
  function indexOf(target: string | number): number {
    if (typeof target === 'number') return target;
    return columnsRef.current.findIndex((c) => c.key === target);
  }

  /** 松手后落盘整份冻结快照，保证宽度与拖动距离 1:1、其它列不动 */
  function commitSnapshot(
    frozen: Record<string, number>,
    spec: ColumnSpec,
    value: number,
  ): Record<string, number> {
    const next = sanitizeWidths({ ...frozen, [spec.key]: value }, columnsRef.current);
    persist(key, next, columnsRef.current);
    return next;
  }

  function startResize(index: number) {
    return (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const handle = e.currentTarget;
      const cell = handle.parentElement as HTMLElement | null;
      const headerRow = cell?.parentElement as HTMLElement | null;
      const spec = columnsRef.current[index];
      if (!cell || !headerRow || !spec) return;
      e.preventDefault();
      e.stopPropagation();

      // 所有数据列都按实测宽度冻结（含自适应列），拖动时只有目标列变化。
      // 用 data-col 按列 key 找元素：左侧固定区把「勾选 + 文件名」包成一个 sticky 外壳之后，
      // 表头子元素的顺序与列下标不再一一对应，按下标取会把宽度张冠李戴。
      const frozen: Record<string, number> = {};
      columnsRef.current.forEach((item) => {
        if (item.filler) return;
        // 勾选 / 操作列不参与列宽记忆（宽度由布局决定），冻结了反而会污染快照
        if (!item.width && item.min == null) return;
        const el =
          headerRow.querySelector(`[data-col='${item.key}']`) ??
          (headerRow.children[columnsRef.current.indexOf(item)] as HTMLElement | null);
        if (!el) return;
        frozen[item.key] = Math.max(1, Math.round(el.getBoundingClientRect().width));
      });

      const startX = e.clientX;
      const startWidth = frozen[spec.key] ?? spec.width ?? MIN_WIDTH;
      const { min, max } = boundsOf(spec);
      const clamp = (v: number) => Math.min(max, Math.max(min, v));
      clearGuides();
      let moved = false;
      let latest = startWidth;

      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // 老浏览器不支持捕获也能用：下面同时挂了 window 监听
      }
      document.body.classList.add('tw-col-resizing');
      const onMove = (ev: PointerEvent) => {
        latest = clamp(Math.round(startWidth + ev.clientX - startX));
        if (!moved) {
          // 位移为 0 时不动任何状态：单纯点一下手柄不该让列表突然变成固定像素宽度
          if (latest === startWidth) return;
          moved = true;
          setState((prev) => ({
            render: { ...frozen, [spec.key]: latest },
            manual: prev.manual,
          }));
          return;
        }
        setState((prev) => ({
          render: { ...prev.render, [spec.key]: latest },
          manual: prev.manual,
        }));
      };
      const finish = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        document.body.classList.remove('tw-col-resizing');
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {
          // 已释放 / 未捕获：忽略
        }
        // 点了一下就松手：不落盘、不改状态
        if (!moved) return;
        const next = commitSnapshot(frozen, spec, latest);
        setState({ render: next, manual: next });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    };
  }

  return {
    styleOf,
    hasCustom,
    /** 表头拖拽热区：左右拖动改列宽。传列 key（推荐）或位置下标 */
    resizeProps(target: string | number) {
      return { onStart: startResize(indexOf(target)) };
    },
  };
}
