/**
 * 项目管理四个看板共用的外壳：插件门禁、取数、提示、胶囊与分页。
 *
 * 四个页面都读同一份 `/__tb_pm`，所以取数逻辑只在这里写一遍：
 * 首次进入先探活，再拉整份 store，之后每 8 秒静默刷新一次。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, type PluginId } from '../../lib/plugins';
import {
  emptyPmStore,
  fetchPmHealth,
  fetchPmStore,
  type BugSeverity,
  type BugStatus,
  type IterationStatus,
  type ProjectStatus,
  type RequirementPriority,
  type RequirementStatus,
  type PmStore,
} from '../../lib/pm';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';
import SlideOverDrawer from './SlideOverDrawer';

const POLL_MS = 8000;

/**
 * 筛选条件记忆：状态 / 优先级 / 严重程度这类枚举值用候选表校验，
 * 非法或缺失都回退默认值；按数据空间分键存在浏览器本地。
 */
export function usePmFilter<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readViewPref(name, allowed, fallback));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeViewPref(name, next);
    },
    [name],
  );
  return [value, set];
}

/** 项目 / 迭代 id 与搜索词这类自由文本筛选：原样记住，空值回落默认 */
export function usePmFilterText(name: string, fallback = ''): [string, (next: string) => void] {
  const [value, setValue] = useState<string>(() => readViewText(name) || fallback);
  const set = useCallback(
    (next: string) => {
      setValue(next);
      writeViewText(name, next === fallback ? '' : next);
    },
    [name, fallback],
  );
  return [value, set];
}

/** 插件开关：配置从磁盘水合完成前不要先闪一下「未启用」 */
export function usePmPlugin(pluginId: PluginId) {
  const [ready, setReady] = useState(false);
  const [on, setOn] = useState(() => isPluginEnabled(pluginId));

  useEffect(() => {
    let alive = true;
    const off = onPluginEnabledChanged(() => setOn(isPluginEnabled(pluginId)));
    void hydrateAppConfig().then(() => {
      if (!alive) return;
      setOn(isPluginEnabled(pluginId));
      setReady(true);
    });
    return () => {
      alive = false;
      off();
    };
  }, [pluginId]);

  return { ready, on };
}

/** 本地服务是否可用 + 整份数据；live === null 表示还在探测 */
type PmStoreValue = {
  store: PmStore;
  live: boolean | null;
  loading: boolean;
  error: string;
  setError: (value: string) => void;
  reload: (silent?: boolean) => Promise<PmStore | null>;
};

const PmStoreContext = createContext<PmStoreValue | null>(null);

/** enabled=false 时不发请求、不轮询：详情页把同一份 store 通过 Provider 共享给子看板 */
function usePmStoreData(enabled: boolean): PmStoreValue {
  const [store, setStore] = useState<PmStore>(emptyPmStore);
  const [live, setLive] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const aliveRef = useRef(true);

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await fetchPmStore();
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

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    aliveRef.current = true;
    let timer: number | null = null;

    void (async () => {
      const health = await fetchPmHealth();
      if (!aliveRef.current) return;
      if (!health) {
        setLive(false);
        setLoading(false);
        return;
      }
      setLive(true);
      await reload();
      timer = window.setInterval(() => void reload(true), POLL_MS);
    })();

    return () => {
      aliveRef.current = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [enabled, reload]);

  return { store, live, loading, error, setError, reload };
}

/** 一套 store 喂给多个子看板（项目详情页用），避免每个 Tab 各拉一遍 */
export function PmStoreProvider({ children }: { children: ReactNode }) {
  const value = usePmStoreData(true);
  return <PmStoreContext.Provider value={value}>{children}</PmStoreContext.Provider>;
}

export function usePmStore(): PmStoreValue {
  const shared = useContext(PmStoreContext);
  const own = usePmStoreData(shared === null);
  return shared ?? own;
}

/** 胶囊底：项目管理四类状态共用一套浅色底，只换色相 */
export const PM_TONES = {
  gray: 'bg-stone-100 text-stone-600',
  blue: 'bg-[#e1eaff] text-[#1f4ec2]',
  amber: 'bg-[#fff1e3] text-[#a85b00]',
  yellow: 'bg-[#fff7d6] text-[#8a6100]',
  red: 'bg-[#fee4e3] text-[#c02a26]',
  purple: 'bg-[#efe7ff] text-[#5b32b4]',
  green: 'bg-[#d9f5d2] text-[#1d7a12]',
  muted: 'bg-stone-100 text-stone-400',
} as const;

export type PmTone = keyof typeof PM_TONES;

export const PROJECT_STATUS_TONE: Record<ProjectStatus, PmTone> = {
  planning: 'blue',
  in_progress: 'amber',
  archived: 'gray',
};

export const ITERATION_STATUS_TONE: Record<IterationStatus, PmTone> = {
  planning: 'blue',
  in_progress: 'amber',
  done: 'green',
};

export const REQUIREMENT_PRIORITY_TONE: Record<RequirementPriority, PmTone> = {
  urgent: 'red',
  high: 'amber',
  medium: 'yellow',
  low: 'gray',
};

export const REQUIREMENT_STATUS_TONE: Record<RequirementStatus, PmTone> = {
  pending: 'gray',
  todo: 'blue',
  in_progress: 'blue',
  testing: 'purple',
  done: 'green',
  cancelled: 'muted',
};

export const BUG_SEVERITY_TONE: Record<BugSeverity, PmTone> = {
  critical: 'red',
  major: 'amber',
  minor: 'yellow',
  trivial: 'gray',
};

export const BUG_STATUS_TONE: Record<BugStatus, PmTone> = {
  pending: 'gray',
  todo: 'blue',
  in_progress: 'blue',
  verifying: 'purple',
  closed: 'green',
};

/** 色调对应的圆点颜色：下拉菜单里用它标识状态 / 优先级，代替对钩 */
export const PM_DOT_COLORS: Record<PmTone, string> = {
  gray: '#a8a29e',
  blue: '#3370ff',
  amber: '#f59e0b',
  yellow: '#eab308',
  red: '#ef4444',
  purple: '#8b5cf6',
  green: '#22c55e',
  muted: '#d6d3d1',
};

export function PmDot({ tone }: { tone: PmTone }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: PM_DOT_COLORS[tone] }}
    />
  );
}

export function PmTag({ tone, children }: { tone: PmTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center rounded-md px-2 text-xs font-medium ${PM_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------ 图标 ------------------------------ */

export type PmIconName =
  | 'plus'
  | 'more'
  | 'chevronRight'
  | 'arrowLeft'
  | 'pencil'
  | 'trash'
  | 'check'
  | 'play'
  | 'search'
  | 'folder'
  | 'calendar'
  | 'file'
  | 'bug';

const PM_ICON_PATHS: Record<PmIconName, string[]> = {
  plus: ['M12 5v14', 'M5 12h14'],
  more: [],
  chevronRight: ['m9 5 7 7-7 7'],
  arrowLeft: ['M19 12H5', 'm11 18-6-6 6-6'],
  pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
  check: ['m4.5 12.5 5 5 10-11'],
  play: ['M8 5.5v13l11-6.5Z'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm20 20-3.6-3.6'],
  folder: [
    'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2h7.8A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z',
  ],
  calendar: [
    'M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z',
    'M8 3v4',
    'M16 3v4',
    'M4 10h16',
  ],
  file: ['M7 3.5h6.5L18 8v12.5H7Z', 'M13.5 3.5V8H18', 'M10 12.5h5', 'M10 16h5'],
  bug: [
    'M8.5 9.5h7V14a3.5 3.5 0 0 1-7 0Z',
    'M9.5 6.2 12 8l2.5-1.8',
    'M4.5 13H8.5',
    'M15.5 13h4',
    'M6 18.5l2-2',
    'M18 18.5l-2-2',
  ],
};

/** 项目管理里的线性图标：统一线宽与圆角，避免各处手写 SVG 规格漂移 */
export function PmIcon({
  name,
  size = 16,
  className = '',
}: {
  name: PmIconName;
  size?: number;
  className?: string;
}) {
  if (name === 'more') {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        className={className}
      >
        <circle cx="5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="19" cy="12" r="1.6" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {PM_ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/* ------------------------------ 分段控件 ------------------------------ */

export interface PmTabOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function PmTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
}: {
  tabs: readonly PmTabOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="tw-pm-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className="tw-pm-tab"
        >
          {tab.label}
          {typeof tab.count === 'number' ? (
            <span className="tw-pm-tab-count">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export interface PmFilterOption<T extends string> {
  value: T;
  label: string;
}

export function PmFilterPills<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly PmFilterOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="tw-pm-pills" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 空状态：方图标 + 主副文案 + 可选动作，和 luckytask 的空列表观感一致 */
export function PmEmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: PmIconName;
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-20 text-center">
      <span className="tw-pm-tile mb-4 flex h-16 w-16 items-center justify-center rounded-2xl">
        <PmIcon name={icon} size={30} />
      </span>
      <p className="text-sm font-medium text-stone-600">{title}</p>
      <p className="mt-1 text-xs text-stone-400">{hint}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** 详情页跳转地址：静态输出下用查询参数承载项目 id */
export function pmProjectHref(projectId: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base}pm/projects/detail/?id=${encodeURIComponent(projectId)}`;
}

export const PM_INPUT =
  'h-9 w-full rounded-md border border-transparent bg-transparent px-2 text-sm text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white placeholder:text-stone-400';

export const PM_TEXTAREA =
  'min-h-[72px] w-full resize-y rounded-md border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-800 outline-none transition-colors focus:border-[#3370ff] placeholder:text-stone-400';

/**
 * 分页条：跟 luckytask 一致——居中显示「上一页 / x / y / 下一页」，没有首页 / 末页，
 * 也不放每页条数选择器；只有一页时按钮置灰，仍然显示，避免看起来「没有分页」。
 */
export function PmPager({
  page,
  totalPages,
  busy = false,
  onPage,
}: {
  page: number;
  totalPages: number;
  busy?: boolean;
  onPage: (page: number) => void;
}) {
  const btn =
    'h-7 shrink-0 rounded-md border border-stone-200 bg-white px-2.5 text-xs text-stone-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 pt-3">
      <button
        type="button"
        className={btn}
        disabled={busy || page <= 1}
        onClick={() => onPage(page - 1)}
      >
        上一页
      </button>
      <span className="px-2 text-xs tabular-nums text-stone-400">
        {page} / {totalPages}
      </span>
      <button
        type="button"
        className={btn}
        disabled={busy || page >= totalPages}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </button>
    </div>
  );
}

export function PmLoading({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-[240px] items-center justify-center rounded-xl border border-stone-200 bg-white"
      aria-busy="true"
      aria-label={label}
    >
      <span className="tw-lib-spin" aria-hidden="true" />
    </div>
  );
}

export function PmNotice({ children }: { children: ReactNode }) {
  return (
    <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
      {children}
    </div>
  );
}

export function PmEmpty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-16 text-center text-sm text-stone-400">{children}</div>;
}

/** 右侧抽屉：统一标题与底部按钮区 */
export function PmDrawer({
  open,
  title,
  busy,
  submitLabel,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  busy?: boolean;
  submitLabel: string;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex items-center justify-end gap-2 border-t border-stone-100 px-2 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-lg border border-stone-200 px-3 text-sm text-stone-600 hover:bg-stone-100"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onSubmit}
            className="h-8 rounded-lg bg-[#3370ff] px-3 text-sm font-medium text-white hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            {submitLabel}
          </button>
        </div>
      }
    >
      {children}
    </SlideOverDrawer>
  );
}

/** 抽屉里的字段行：标签列固定宽度，四个看板保持一致 */
export function PmField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-2 py-2">
      {/* 单行控件统一 h-9：标签也占 h-9 并垂直居中，文字才不会比控件高 / 低半个字 */}
      <div className="flex h-9 w-[88px] shrink-0 items-center text-sm text-stone-600">
        <span className="truncate">
          {label}
          {required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </span>
      </div>
      {/* 子控件统一从容器顶部起算：SelectDropdown 自带 mt-1（表单场景），在抽屉里会低 4px */}
      <div className="min-w-0 flex-1 [&>div]:mt-0">{children}</div>
    </div>
  );
}

/** 错误条：四个页面同一套外观 */
export function PmErrorBar({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        className="-mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-red-700/70 hover:bg-red-100 hover:text-red-900"
      >
        ✕
      </button>
    </div>
  );
}
