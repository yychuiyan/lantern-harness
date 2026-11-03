/**
 * 人生管理六张看板共用：插件门禁、整库取数、状态胶囊、分组 / 多选 / 抽屉壳。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { hydrateAppConfig } from '../../lib/app-config';
import {
  createLifeItems,
  deleteLifeItems,
  emptyLifeStore,
  fetchLifeHealth,
  fetchLifeStore,
  updateLifeItem,
  type KrTaskStatus,
  type KrTodoStatus,
  type LifeEntity,
  type LifePriority,
  type LifeStore,
  type ObjectiveItem,
  type YearPlanStatus,
} from '../../lib/life';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';
import DatePicker from './DatePicker';
import OverflowHint from './OverflowHint';
import {
  filterTableCols,
  TableFieldConfigButton,
  useTableFieldVisibility,
  type TableFieldOption,
} from './TableFieldConfig';

export const LIFE_POLL_MS = 8000;

export function lifePluginDisabledMessage(): string {
  return pluginDisabledMessage('life');
}

export function useLifePlugin() {
  const [ready, setReady] = useState(false);
  const [on, setOn] = useState(() => isPluginEnabled('life'));

  useEffect(() => {
    let alive = true;
    const off = onPluginEnabledChanged(() => setOn(isPluginEnabled('life')));
    void hydrateAppConfig().then(() => {
      if (!alive) return;
      setOn(isPluginEnabled('life'));
      setReady(true);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return { ready, on };
}

type LifeStoreValue = {
  store: LifeStore;
  live: boolean | null;
  loading: boolean;
  error: string;
  setError: (value: string) => void;
  reload: (silent?: boolean) => Promise<LifeStore | null>;
  createItems: (
    entity: LifeEntity,
    items: Record<string, unknown>[],
  ) => Promise<{ items: unknown[]; total: number }>;
  updateItem: (entity: LifeEntity, id: string, patch: Record<string, unknown>) => Promise<void>;
  deleteItems: (entity: LifeEntity, ids: string[]) => Promise<void>;
};

export function useLifeStore(enabled: boolean): LifeStoreValue {
  const [store, setStore] = useState<LifeStore>(emptyLifeStore);
  const [live, setLive] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const aliveRef = useRef(true);

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await fetchLifeStore();
      if (!aliveRef.current) return null;
      setStore(next);
      setLive(true);
      setError('');
      return next;
    } catch (e) {
      if (!aliveRef.current) return null;
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (aliveRef.current && !silent) setLoading(false);
    }
  }, []);

  const createItemsFn = useCallback(
    async (entity: LifeEntity, items: Record<string, unknown>[]) => {
      const result = await createLifeItems(entity, items);
      await reload(true);
      return result;
    },
    [reload],
  );

  const updateItemFn = useCallback(
    async (entity: LifeEntity, id: string, patch: Record<string, unknown>) => {
      await updateLifeItem(entity, id, patch);
      await reload(true);
    },
    [reload],
  );

  const deleteItemsFn = useCallback(
    async (entity: LifeEntity, ids: string[]) => {
      await deleteLifeItems(entity, ids);
      await reload(true);
    },
    [reload],
  );

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    aliveRef.current = true;
    let timer: number | null = null;

    void (async () => {
      try {
        const health = await fetchLifeHealth();
        if (!aliveRef.current) return;
        if (!health.ok) {
          setLive(false);
          setLoading(false);
          return;
        }
        await reload();
        if (!aliveRef.current) return;
        setLive(true);
        timer = window.setInterval(() => void reload(true), LIFE_POLL_MS);
      } catch {
        if (!aliveRef.current) return;
        setLive(false);
        setLoading(false);
      }
    })();

    return () => {
      aliveRef.current = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [enabled, reload]);

  return {
    store,
    live,
    loading,
    error,
    setError,
    reload,
    createItems: createItemsFn,
    updateItem: updateItemFn,
    deleteItems: deleteItemsFn,
  };
}

export function useLifeKeyword(prefKey: string): [string, (next: string) => void] {
  const [keyword, setKeyword] = useState(() => readViewText(prefKey));
  const set = useCallback(
    (next: string) => {
      setKeyword(next);
      writeViewText(prefKey, next);
    },
    [prefKey],
  );
  return [keyword, set];
}

/** 分组方式等枚举偏好（按空间记忆） */
export function useLifeEnumPref<T extends string>(
  prefKey: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState(() => readViewPref<T>(prefKey, allowed, fallback));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeViewPref(prefKey, next);
    },
    [prefKey],
  );
  return [value, set];
}

/** 表格多选：返回选中 id 列表与勾选操作 */
export function useLifeSelection(itemIds: string[]) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const idSet = useMemo(() => new Set(itemIds), [itemIds]);

  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, on] of Object.entries(prev)) {
        if (idSet.has(id) && on) next[id] = true;
        else if (on) changed = true;
      }
      return changed || Object.keys(next).length !== Object.keys(prev).length ? next : prev;
    });
  }, [idSet]);

  const selectedIds = useMemo(() => Object.keys(selected).filter((id) => selected[id]), [selected]);

  const allVisibleSelected = itemIds.length > 0 && itemIds.every((id) => selected[id]);

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = { ...prev };
      const turnOn = !allVisibleSelected;
      for (const id of itemIds) next[id] = turnOn;
      return next;
    });
  }

  function clear() {
    setSelected({});
  }

  return { selected, selectedIds, allVisibleSelected, toggle, toggleAllVisible, clear };
}

export type LifeGroup<T> = {
  key: string;
  label: string;
  pill: string;
  items: T[];
  /** 嵌套分组深度：0 顶层（如年度），1 子层（如状态 / 季度） */
  depth?: number;
};

/** 可嵌套分组（年 → 状态 / 年 → 季度） */
export type LifeNestGroup<T> = {
  key: string;
  label: string;
  pill: string;
  items?: T[];
  children?: LifeNestGroup<T>[];
};

export type LifeFlatGroup<T> = {
  key: string;
  label: string;
  pill: string;
  depth: number;
  count: number;
  /** section=年度等标题；tag=状态/类型胶囊（含单层分组） */
  kind: 'section' | 'tag';
  /** 仅叶子节点带行数据 */
  items?: T[];
};

function nestCount<T>(node: LifeNestGroup<T>): number {
  if (node.items) return node.items.length;
  return (node.children ?? []).reduce((sum, c) => sum + nestCount(c), 0);
}

/** 按折叠状态展平嵌套分组，供表格渲染。空叶子组（items: []）保留，便于组底「+ 新增记录」。 */
export function flattenLifeNestGroups<T>(
  groups: LifeNestGroup<T>[],
  collapsed: Record<string, boolean>,
): LifeFlatGroup<T>[] {
  const out: LifeFlatGroup<T>[] = [];
  const walk = (nodes: LifeNestGroup<T>[], depth: number) => {
    for (const n of nodes) {
      const hasChildren = Boolean(n.children?.length);
      const count = nestCount(n);
      // 空分支父级跳过；空叶子（显式 items 数组）保留
      if (count === 0 && hasChildren) continue;
      if (count === 0 && n.items === undefined) continue;
      const open = !collapsed[n.key];
      out.push({
        key: n.key,
        label: n.label,
        pill: n.pill,
        depth,
        count,
        kind: hasChildren ? 'section' : 'tag',
        items: hasChildren || !open ? undefined : (n.items ?? []),
      });
      if (open && hasChildren) walk(n.children!, depth + 1);
    }
  };
  walk(groups, 0);
  return out;
}

export function collectNestItemIds<T extends { id: string }>(
  groups: LifeNestGroup<T>[],
  collapsed: Record<string, boolean>,
): string[] {
  return flattenLifeNestGroups(groups, collapsed).flatMap((g) =>
    g.items ? g.items.map((x) => x.id) : [],
  );
}

/** 序号 / 勾选列：与分组头展开箭头同宽槽；嵌套时左侧再加缩进与二级箭头对齐 */
export const LIFE_SELECT_COL_PX = 36;
export const LIFE_NEST_INDENT_PX = 28;
export function lifeSelectColPx(nested = false): number {
  return LIFE_SELECT_COL_PX + (nested ? LIFE_NEST_INDENT_PX : 0);
}
export function lifeStickyTitleStyle(nested = false): { [key: string]: string } {
  return { ['--tw-sticky-left']: `${lifeSelectColPx(nested)}px` };
}
/** @deprecated 用 lifeStickyTitleStyle(false)；保留给未接嵌套缩进的调用 */
export const LIFE_STICKY_TITLE_STYLE = lifeStickyTitleStyle(false);

/** 字段名行：单行 thead，与待办同款 */
export const LIFE_TH =
  'relative px-2 py-2 text-left text-xs font-medium whitespace-nowrap text-stone-500';
/** 列簇起点：左侧细分隔（单行字段名，不用叠字簇名） */
export const LIFE_TH_CLUSTER =
  'relative border-l border-stone-200/90 px-2 py-2 text-left text-xs font-medium whitespace-nowrap text-stone-500';

/** 表格里始终显示的列（勾选 / 标题 / 填充 / 操作），不参与字段显隐 */
export const LIFE_COL_ALWAYS = new Set(['select', 'title', 'filler', 'action']);

export type LifeFieldOption = TableFieldOption;

/** 六表共用：创建 / 修改日期（可配置显隐） */
export const LIFE_TIME_FIELD_OPTIONS: readonly LifeFieldOption[] = [
  { key: 'createdAt', label: '创建日期' },
  { key: 'updatedAt', label: '修改日期' },
];

export const LIFE_TIME_COLS = [
  { key: 'createdAt', width: 120, min: 96 },
  { key: 'updatedAt', width: 120, min: 96 },
] as const;

/** ISO 时间戳 → 本地 YYYY/MM/DD HH:mm；空值显示 — */
export function formatLifeTimestamp(iso: string | undefined | null): string {
  const raw = (iso ?? '').trim();
  if (!raw) return '—';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    const day = raw.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.replace(/-/g, '/') : '—';
  }
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

/** 按空间记忆：隐藏哪些可配置列（存 hidden key 列表） */
export function useLifeFieldVisibility(prefKey: string, fields: readonly LifeFieldOption[]) {
  return useTableFieldVisibility(prefKey, fields, LIFE_COL_ALWAYS);
}

/** 过滤表格 col 定义：只保留始终显示 + 当前可见的可配置列 */
export function filterLifeCols<T extends { key: string }>(
  cols: readonly T[],
  isVisible: (key: string) => boolean,
): T[] {
  return filterTableCols(cols, isVisible);
}

/** 顶栏「字段」按钮：勾选显示 / 隐藏列 */
export function LifeFieldConfigButton(props: {
  fields: readonly LifeFieldOption[];
  isVisible: (key: string) => boolean;
  onToggle: (key: string) => void;
}) {
  return <TableFieldConfigButton {...props} />;
}

/** 序号 / 勾选 / 分组箭头列：无横向 padding，避免和箭头槽错位 */
export const LIFE_SELECT_CELL = 'tw-sticky-l px-0 py-1 align-middle';
export const LIFE_SELECT_HEAD = 'tw-sticky-l px-0 py-2 text-left font-medium whitespace-nowrap';

/** 表格胶囊下拉：空值用整格「未选择」单选框样式；有值时整格可点、内嵌胶囊 */
export const LIFE_EMPTY_SELECT_TRIGGER =
  'h-8 w-full justify-start rounded-md border border-stone-200 bg-white px-2 text-left text-sm font-normal text-stone-400 hover:border-stone-300 focus:ring-2 focus:ring-[#3370ff]/30';
/** 表格已选胶囊触发器：宽度跟内容，不随列宽拉长（配合 SelectDropdown fitContent） */
export const LIFE_FILLED_PILL_TRIGGER =
  'h-8 w-auto max-w-full justify-start bg-transparent px-0 text-left focus:ring-0';
/** 目录 / 枚举空值（计划类型、季度、优先级等） */
export const LIFE_UNSELECTED_LABEL = '未选择';
/** 外键空值（所属任务 / Objective 等关联） */
export const LIFE_UNLINKED_LABEL = '未关联';
/** 分组桶：未选或无效年度周期 */
export const LIFE_YEAR_UNSET_LABEL = '未设置年度';

function LifeGroupChevron(props: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`text-stone-400 transition-transform duration-200 ease-out ${
        props.open ? 'rotate-0' : '-rotate-90'
      }`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * 分组头（飞书多维表风格）：
 * - 一级（年）：整行左起「箭头 + 胶囊 + 条数」，sticky 贴左（勾选+标题两列宽）
 * - 二级：箭头在勾选列（缩进），胶囊在标题列，与「目标描述」对齐
 * kind 保留兼容调用方。
 */
export function LifeGroupHeader(props: {
  label: string;
  pill: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  colSpan: number;
  depth?: number;
  kind?: 'section' | 'tag';
  /** 勾选列宽，须与表体 sticky 标题的 --tw-sticky-left 一致 */
  selectColPx?: number;
}) {
  const depth = props.depth ?? 0;
  const isChild = depth > 0;
  const selectW = props.selectColPx ?? LIFE_SELECT_COL_PX;
  void props.kind;
  const pill = (
    <span
      className={`max-w-[min(100%,16rem)] truncate rounded-full px-2.5 py-0.5 text-xs font-medium ${props.pill}`}
    >
      {props.label}
    </span>
  );
  const count = (
    <span className="shrink-0 text-xs text-stone-400 tabular-nums">{props.count} 条记录</span>
  );
  const chevron = (
    <span className="flex h-7 w-9 shrink-0 items-center justify-center">
      <LifeGroupChevron open={props.open} />
    </span>
  );

  // 一级：左对齐，箭头+胶囊贴表左；sticky 覆盖勾选+标题两列，横滚不被挡；整行可点
  if (!isChild) {
    const restSpan = Math.max(0, props.colSpan - 2);
    return (
      <tr
        role="button"
        tabIndex={0}
        aria-expanded={props.open}
        aria-label={props.open ? '收起分组' : '展开分组'}
        className="tw-life-group-head cursor-pointer bg-white"
        style={
          {
            ['--tw-row-bg']: '#ffffff',
            ['--life-select-w']: `${selectW}px`,
          } as CSSProperties
        }
        onClick={props.onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            props.onToggle();
          }
        }}
      >
        <td
          colSpan={2}
          className="tw-sticky-l tw-life-group-sticky-lead border-b border-stone-100 px-0 pb-1.5 pt-3 align-middle"
          style={{
            left: 0,
            ['--tw-sticky-left']: '0px',
          }}
        >
          <div className="flex w-full items-center gap-2 py-1.5 pr-2 text-left">
            {chevron}
            {pill}
            {count}
          </div>
        </td>
        {restSpan > 0 ? (
          <td
            colSpan={restSpan}
            className="border-b border-stone-100 bg-white pb-1.5 pt-3"
            aria-hidden="true"
          />
        ) : null}
      </tr>
    );
  }

  // 二级：箭头缩进在勾选列，胶囊在标题列；整行可点
  const restSpan = Math.max(0, props.colSpan - 2);
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-expanded={props.open}
      aria-label={props.open ? '收起分组' : '展开分组'}
      className="tw-life-group-head cursor-pointer bg-white"
      style={
        {
          ['--tw-row-bg']: '#ffffff',
          ['--life-select-w']: `${selectW}px`,
        } as CSSProperties
      }
      onClick={props.onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onToggle();
        }
      }}
    >
      <td
        className="tw-sticky-l tw-life-group-sticky-lead border-b border-stone-100 px-0 py-0.5 align-middle"
        style={{
          left: 0,
          width: selectW,
          minWidth: selectW,
          maxWidth: selectW,
          ['--tw-sticky-left']: '0px',
        }}
      >
        <div className="flex w-full items-center py-1.5">
          <span
            className="inline-block shrink-0"
            style={{ width: LIFE_NEST_INDENT_PX }}
            aria-hidden="true"
          />
          {chevron}
        </div>
      </td>
      <td
        className="tw-sticky-l tw-life-group-sticky-label border-b border-stone-100 px-2 py-0.5 align-middle"
        style={{
          left: selectW,
          ['--tw-sticky-left']: `${selectW}px`,
        }}
      >
        <div className="flex w-full min-w-0 items-center gap-2 py-1.5 text-left">
          {pill}
          {count}
        </div>
      </td>
      {restSpan > 0 ? (
        <td
          colSpan={restSpan}
          className="border-b border-stone-100 bg-white py-0.5"
          aria-hidden="true"
        />
      ) : null}
    </tr>
  );
}

/** 组底「+ 新增记录」：+ 贴勾选列，文案贴标题列（与分组头同一套 sticky） */
export function LifeAddRecordRow(props: {
  colSpan: number;
  disabled?: boolean;
  onClick: () => void;
  depth?: number;
  selectColPx?: number;
}) {
  const indent = (props.depth ?? 0) > 0;
  const selectW = props.selectColPx ?? LIFE_SELECT_COL_PX;
  const restSpan = Math.max(0, props.colSpan - 2);
  return (
    <tr className="tw-life-group-body" style={{ ['--life-select-w' as string]: `${selectW}px` }}>
      <td
        className="tw-sticky-l tw-life-group-sticky-lead px-0 py-0.5 align-middle"
        style={{
          left: 0,
          width: selectW,
          minWidth: selectW,
          maxWidth: selectW,
          ['--tw-sticky-left' as string]: '0px',
        }}
      >
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onClick}
          aria-label="新增记录"
          className="flex w-full items-center py-0.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 disabled:opacity-40"
        >
          {indent ? (
            <span
              className="inline-block shrink-0"
              style={{ width: LIFE_NEST_INDENT_PX }}
              aria-hidden="true"
            />
          ) : null}
          <span className="flex h-7 w-9 shrink-0 items-center justify-center text-sm leading-none">
            +
          </span>
        </button>
      </td>
      <td
        className="tw-sticky-l tw-life-group-sticky-label px-2 py-0.5 align-middle"
        style={{
          left: selectW,
          ['--tw-sticky-left' as string]: `${selectW}px`,
        }}
      >
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onClick}
          className="rounded py-0.5 text-xs text-stone-400 transition-colors hover:text-stone-600 disabled:opacity-40"
        >
          新增记录
        </button>
      </td>
      {restSpan > 0 ? (
        <td colSpan={restSpan} className="bg-white py-0.5" aria-hidden="true" />
      ) : null}
    </tr>
  );
}

/** 行内新增标题输入：对齐待办事项 tw-new-row */
export const LIFE_NEW_ROW_TITLE_INPUT =
  'h-8 w-full truncate rounded-md border border-[#3370ff]/40 bg-white px-2 text-sm text-stone-800 outline-none focus:border-[#3370ff] disabled:opacity-50';

/**
 * 行内新增收尾：点行外空白——有标题则保存，未改动则收起。
 * 下拉菜单 / 日期面板 / 确认弹窗点选不算离开。
 */
export function useLifeInlineNewRow<T extends { title: string }>(opts: {
  row: T | null;
  setRow: (next: T | null) => void;
  submitting: boolean;
  onSubmit: (row: T) => Promise<void>;
  isPristine: (row: T) => boolean;
}) {
  const rowRef = useRef(opts.row);
  rowRef.current = opts.row;
  const submittingRef = useRef(opts.submitting);
  submittingRef.current = opts.submitting;
  const onSubmitRef = useRef(opts.onSubmit);
  onSubmitRef.current = opts.onSubmit;
  const isPristineRef = useRef(opts.isPristine);
  isPristineRef.current = opts.isPristine;
  const setRowRef = useRef(opts.setRow);
  setRowRef.current = opts.setRow;

  const submit = useCallback(async () => {
    const row = rowRef.current;
    if (!row || submittingRef.current) return;
    const title = row.title.trim();
    if (!title) return;
    await onSubmitRef.current({ ...row, title });
  }, []);

  useEffect(() => {
    if (opts.row == null) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.tw-new-row')) return;
      if (target.closest('.tw-select-menu')) return;
      if (target.closest('.tw-date-panel')) return;
      if (target.closest('.tw-confirm-dialog')) return;
      if (target.closest('[data-headlessui-portal]')) return;
      const row = rowRef.current;
      if (!row) return;
      if (row.title.trim()) {
        void submit();
        return;
      }
      if (isPristineRef.current(row)) setRowRef.current(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [opts.row, submit]);

  return { submit };
}

/** 完成度条：只读细条 + 百分比（无 width 过渡，避免刷新挂载时从 0 动画到目标值造成「跳一下」） */
export function LifeProgressBar(props: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(props.value)));
  return (
    <div className={`flex items-center gap-2.5 ${props.className ?? ''}`}>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-stone-100">
        <span className="block h-full rounded-full bg-[#3370ff]" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-stone-500">{pct}%</span>
    </div>
  );
}

/**
 * 可调进度：进度条与滑块合为一行（自定义拇指），右侧百分比。
 * 松手 / 键盘调完后调 onCommit；拖动过程只走 onChange。
 */
export function LifeProgressControl(props: {
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(props.value)));
  return (
    <div className={`flex items-center gap-2.5 ${props.className ?? ''}`}>
      <div className="relative flex h-6 min-w-0 flex-1 items-center">
        <div
          className="pointer-events-none absolute inset-x-0 h-1.5 overflow-hidden rounded-full bg-stone-100"
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full bg-[#3370ff] transition-[width] duration-75"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          aria-label={props.ariaLabel ?? '进度'}
          onChange={(e) => props.onChange(Number(e.target.value))}
          onMouseUp={(e) => props.onCommit?.(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => props.onCommit?.(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => {
            if (
              e.key === 'ArrowLeft' ||
              e.key === 'ArrowRight' ||
              e.key === 'Home' ||
              e.key === 'End'
            ) {
              props.onCommit?.(Number((e.target as HTMLInputElement).value));
            }
          }}
          className="tw-life-range relative z-1 w-full"
        />
      </div>
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-stone-500">{pct}%</span>
    </div>
  );
}

export function LifeSelectHead(props: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  /** 嵌套分组时与行序号同一缩进 */
  nested?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(props.indeterminate) && !props.checked;
  }, [props.checked, props.indeterminate]);
  return (
    <th className={LIFE_SELECT_HEAD} aria-label="全选">
      <div className="flex items-center">
        {props.nested ? (
          <span
            className="inline-block shrink-0"
            style={{ width: LIFE_NEST_INDENT_PX }}
            aria-hidden="true"
          />
        ) : null}
        <div className="flex h-7 w-9 items-center justify-center">
          <input
            ref={ref}
            type="checkbox"
            checked={props.checked}
            onChange={props.onChange}
            aria-label="全选"
            className="h-3.5 w-3.5 rounded border-stone-300 text-[#3370ff] focus:ring-[#3370ff]/30"
          />
        </div>
      </div>
    </th>
  );
}

/**
 * 默认显示组内序号（与分组展开箭头对齐）；已选或行悬停时换成复选框。
 */
export function LifeSelectCell(props: {
  checked: boolean;
  onChange: () => void;
  label: string;
  index: number;
  /** 已有勾选时整列切到复选框 */
  selecting?: boolean;
  depth?: number;
}) {
  const showCheck = Boolean(props.selecting || props.checked);
  const indent = (props.depth ?? 0) > 0;
  return (
    <td className={LIFE_SELECT_CELL}>
      <div className="flex items-center">
        {indent ? (
          <span
            className="inline-block shrink-0"
            style={{ width: LIFE_NEST_INDENT_PX }}
            aria-hidden="true"
          />
        ) : null}
        <div className="relative flex h-7 w-9 shrink-0 items-center justify-center">
          <span
            className={`text-xs tabular-nums text-stone-400 transition-opacity ${
              showCheck ? 'opacity-0' : 'opacity-100 group-hover/row:opacity-0'
            }`}
          >
            {props.index}
          </span>
          <input
            type="checkbox"
            checked={props.checked}
            onChange={props.onChange}
            aria-label={props.label}
            className={`absolute h-3.5 w-3.5 rounded border-stone-300 text-[#3370ff] focus:ring-[#3370ff]/30 transition-opacity ${
              showCheck ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
            }`}
          />
        </div>
      </div>
    </td>
  );
}

export function LifeDrawer(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog open={props.open} onClose={props.onClose} transition className="relative z-100">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/25 duration-[280ms]"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex justify-end overflow-hidden">
        <DialogPanel
          transition
          className="tw-drawer-panel-anim flex h-full w-full max-w-[520px] flex-col border-l border-stone-200 bg-white shadow-2xl duration-[280ms]"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-100 px-6 py-4">
            <DialogTitle className="text-base font-semibold text-stone-900">
              {props.title}
            </DialogTitle>
            <button
              type="button"
              onClick={props.onClose}
              aria-label="关闭"
              className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-3">{props.children}</div>
          {props.footer ? (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stone-100 px-6 py-4">
              {props.footer}
            </div>
          ) : null}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

export function LifeExpandButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.label}
      className="rounded p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:opacity-40"
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M15 3h6v6" />
        <path d="M9 21H3v-6" />
        <path d="M21 3l-7 7" />
        <path d="M3 21l7-7" />
      </svg>
    </button>
  );
}

export function sortByUpdated<T extends { updatedAt?: string; createdAt?: string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const ta = a.updatedAt || a.createdAt || '';
    const tb = b.updatedAt || b.createdAt || '';
    return tb.localeCompare(ta);
  });
}

/** 列表默认：按创建时间升序（先建在前），编辑不会把行顶走 */
export function sortByCreated<T extends { createdAt?: string; id?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ta = a.createdAt || '';
    const tb = b.createdAt || '';
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

/**
 * 有状态的列表：先按 statusOrder（进行中 → 未完成 → 已完成…），同状态再按创建时间升序。
 */
export function sortByStatusThenCreated<
  T extends { status?: string; createdAt?: string; id?: string },
>(items: T[], statusOrder: readonly string[]): T[] {
  const rank = new Map(statusOrder.map((s, i) => [s, i]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.status ?? '') ?? statusOrder.length;
    const rb = rank.get(b.status ?? '') ?? statusOrder.length;
    if (ra !== rb) return ra - rb;
    const ta = a.createdAt || '';
    const tb = b.createdAt || '';
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

export function objectiveById(store: LifeStore, id: string): ObjectiveItem | undefined {
  return store.objectives.find((o) => o.id === id);
}

export const KR_TODO_STATUS_CELL: Record<KrTodoStatus, string> = {
  pending: 'bg-stone-100 text-stone-600',
  in_progress: 'bg-[#e1eaff] text-[#1f4ec2]',
  overdue: 'bg-[#fee4e3] text-[#c02a26]',
  done: 'bg-[#d9f5d2] text-[#1d7a12]',
  stalled: 'bg-[#fff7d6] text-[#8a6100]',
  closed: 'bg-stone-100 text-stone-400',
};

export const KR_TODO_STATUS_DOT: Record<KrTodoStatus, string> = {
  pending: 'bg-stone-400',
  in_progress: 'bg-[#3370ff]',
  overdue: 'bg-[#f54a45]',
  done: 'bg-[#34c724]',
  stalled: 'bg-[#f7ba1e]',
  closed: 'bg-stone-300',
};

export const KR_TASK_STATUS_CELL: Record<KrTaskStatus, string> = {
  pool: 'bg-stone-100 text-stone-600',
  in_progress: 'bg-[#e1eaff] text-[#1f4ec2]',
  done: 'bg-[#d9f5d2] text-[#1d7a12]',
  incomplete: 'bg-[#fff1e3] text-[#a85b00]',
  closed: 'bg-stone-100 text-stone-400',
};

export const KR_TASK_STATUS_DOT: Record<KrTaskStatus, string> = {
  pool: 'bg-stone-400',
  in_progress: 'bg-[#3370ff]',
  done: 'bg-[#34c724]',
  incomplete: 'bg-[#ff8800]',
  closed: 'bg-stone-300',
};

export const YEAR_PLAN_STATUS_CELL: Record<YearPlanStatus, string> = {
  in_progress: 'bg-[#e1eaff] text-[#1f4ec2]',
  incomplete: 'bg-[#fff1e3] text-[#a85b00]',
  done: 'bg-[#d9f5d2] text-[#1d7a12]',
};

export const YEAR_PLAN_STATUS_DOT: Record<YearPlanStatus, string> = {
  in_progress: 'bg-[#3370ff]',
  incomplete: 'bg-[#ff8800]',
  done: 'bg-[#34c724]',
};

export const LIFE_PRIORITY_CELL: Record<LifePriority, string> = {
  urgent_important: 'bg-[#fee4e3] text-[#c02a26]',
  important: 'bg-[#fff1e3] text-[#a85b00]',
  urgent: 'bg-[#fff7d6] text-[#8a6100]',
  normal: 'bg-stone-100 text-stone-600',
  '': 'bg-stone-50 text-stone-400',
};

export const LIFE_PRIORITY_PILL: Record<LifePriority, string> = {
  urgent_important: 'bg-[#f54a45] text-white',
  important: 'bg-[#ff8800] text-white',
  urgent: 'bg-[#f7ba1e] text-stone-800',
  normal: 'bg-stone-200 text-stone-600',
  '': 'bg-transparent text-stone-400',
};

export const LIFE_PRIORITY_DOT: Record<LifePriority, string> = {
  urgent_important: 'bg-[#f54a45]',
  important: 'bg-[#ff8800]',
  urgent: 'bg-[#f7ba1e]',
  normal: 'bg-stone-300',
  '': 'border border-stone-300 bg-transparent',
};

/** 计划类型 / 年度周期等目录项：按 id 稳定取色（单元格浅底 / 分组头实底） */
const LIFE_CATALOG_PALETTE = [
  { cell: 'bg-[#e1eaff] text-[#1f4ec2]', pill: 'bg-[#3370ff] text-white' },
  { cell: 'bg-[#d9f5d2] text-[#1d7a12]', pill: 'bg-[#34c724] text-white' },
  { cell: 'bg-[#fff1e3] text-[#a85b00]', pill: 'bg-[#ff8800] text-white' },
  { cell: 'bg-[#e0f2fe] text-[#0369a1]', pill: 'bg-[#0ea5e9] text-white' },
  { cell: 'bg-[#fce7f3] text-[#9d174d]', pill: 'bg-[#db2777] text-white' },
  { cell: 'bg-[#ecfdf5] text-[#047857]', pill: 'bg-[#10b981] text-white' },
  { cell: 'bg-[#fff7d6] text-[#8a6100]', pill: 'bg-[#f7ba1e] text-stone-800' },
  { cell: 'bg-[#fee4e3] text-[#c02a26]', pill: 'bg-[#f54a45] text-white' },
] as const;

const LIFE_CATALOG_EMPTY = {
  cell: 'bg-stone-50 text-stone-400',
  pill: 'bg-stone-300 text-stone-600',
} as const;

function lifeCatalogHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function lifeCatalogCellClass(id: string): string {
  if (!id.trim()) return LIFE_CATALOG_EMPTY.cell;
  return LIFE_CATALOG_PALETTE[lifeCatalogHash(id) % LIFE_CATALOG_PALETTE.length].cell;
}

export function lifeCatalogPillClass(id: string): string {
  if (!id.trim()) return LIFE_CATALOG_EMPTY.pill;
  return LIFE_CATALOG_PALETTE[lifeCatalogHash(id) % LIFE_CATALOG_PALETTE.length].pill;
}

/** 只读年度周期等：浅底胶囊；空值灰字 */
export function LifeCatalogPill(props: { id: string; label: string; emptyLabel?: string }) {
  const empty = !props.id.trim() || !props.label.trim() || props.label === '—';
  if (empty) {
    return <span className="text-sm text-stone-300">{props.emptyLabel ?? '—'}</span>;
  }
  return (
    <span
      className={`inline-flex h-7 max-w-full items-center rounded-md px-2 text-xs font-medium ${lifeCatalogCellClass(props.id)}`}
    >
      <OverflowHint text={props.label} className="block min-w-0 truncate" />
    </span>
  );
}

export const cellInput =
  'h-8 w-full min-w-0 truncate rounded-md border border-transparent bg-transparent px-1.5 text-sm text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white placeholder:text-stone-300';

export function TextCell(props: {
  value: string;
  placeholder?: string;
  muted?: boolean;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { value, placeholder, muted, autoFocus, onChange, onCommit, onCancel } = props;
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
          e.currentTarget.blur();
        }
      }}
      className={`${cellInput} ${muted && !value ? 'text-stone-300' : ''}`}
    />
  );
}

export function NoteCell(props: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { value, onChange, onCommit, onCancel } = props;
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex h-8 w-full min-w-0 items-center rounded-md border border-transparent px-1.5 text-left text-sm text-stone-700 transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:outline-none"
      >
        <OverflowHint
          text={value || '—'}
          className={`block min-w-0 truncate ${value ? '' : 'text-stone-300'}`}
        />
      </button>
    );
  }
  return (
    <TextCell
      value={value}
      placeholder="—"
      autoFocus
      onChange={onChange}
      onCommit={() => {
        setEditing(false);
        onCommit();
      }}
      onCancel={() => {
        setEditing(false);
        onCancel();
      }}
    />
  );
}

export function DateCell(props: { value: string; onChange: (value: string) => void }) {
  return (
    <DatePicker
      value={props.value}
      onChange={props.onChange}
      placeholder="选择日期"
      className="h-8 rounded-md border border-transparent px-1.5 text-sm text-stone-800 tabular-nums transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
    />
  );
}

export function LifeLoading(props: { label?: string }) {
  return (
    <div
      className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white"
      aria-busy="true"
      aria-label={props.label ?? '正在加载'}
    >
      <div className="flex min-h-[240px] flex-1 items-center justify-center">
        <span className="tw-lib-spin" aria-hidden="true" />
      </div>
    </div>
  );
}

export function LifeNotice(props: { children: ReactNode }) {
  return (
    <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
      {props.children}
    </div>
  );
}

export function LifeDeleteButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.label}
      className="tw-icon-danger rounded p-1"
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="M19 6l-1 14H6L5 6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}

export function ReadonlyCell(props: { text: string; muted?: boolean }) {
  return (
    <OverflowHint
      text={props.text}
      className={`block min-w-0 truncate px-1.5 text-sm ${props.muted ? 'text-stone-300' : 'text-stone-600'}`}
    />
  );
}

export function LifeErrorBar(props: { error: string; onDismiss: () => void }) {
  if (!props.error) return null;
  return (
    <div className="mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      <span className="min-w-0 flex-1">{props.error}</span>
      <button
        type="button"
        onClick={props.onDismiss}
        aria-label="关闭"
        className="-mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-red-700/70 hover:bg-red-100 hover:text-red-900"
      >
        ✕
      </button>
    </div>
  );
}
