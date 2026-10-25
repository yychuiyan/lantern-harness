/**
 * 仪表盘：按插件开关并行拉取待办 / 任务 / 测试统计，渲染可拖拽、可增减的卡片。
 * 画布照飞书仪表盘：12 列坐标 + 20px 行高的自由画布（react-grid-layout），
 * 卡片可拖到任意位置、拖右下角独立改宽高（挡住邻居时松手让它们向下让位），布局按空间存在浏览器本地。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import ReactGridLayout, { type Layout as GridLayoutModel } from 'react-grid-layout';
// 自由画布 + 允许拖动时暂时重叠：RGL 自己的碰撞算法在「不压缩」模式下会把卡片
// 互相往下塞，落位后容易出现谁压着谁；改成松手时由 settleDashboardOverlaps 统一收边。
import { noOverlapCompactor } from 'react-grid-layout/core';
import 'react-grid-layout/css/styles.css';

import { hydrateAppConfig } from '../../lib/app-config';
import {
  DASHBOARD_COLS,
  DASHBOARD_MAX_ROWS,
  DASHBOARD_ROW_HEIGHT,
  DASHBOARD_WIDGETS,
  allDashboardWidgetsLayout,
  compactDashboardWidgets,
  dashboardKpis,
  dashboardMinCols,
  dashboardMinRows,
  defaultDashboardRect,
  isDashboardWidgetId,
  normalizeDashboardLayout,
  placeDashboardWidget,
  settleDashboardOverlaps,
  stackedDashboardWidgets,
  visibleDashboardWidgets,
  type DashboardLayout,
  type DashboardRect,
  type DashboardWidgetId,
} from '../../lib/dashboard';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import { fetchPmHealth, fetchPmStore, type ProjectItem } from '../../lib/pm';
import { listSpaces } from '../../lib/spaces-client';
import { fetchTasksHealth, listTasks, type TaskItem } from '../../lib/tasks';
import { fetchTestStatsHealth, listTestStats, type TestStatsItem } from '../../lib/test-stats';
import { fetchTodosHealth, listTodos, updateTodo, type TodoItem } from '../../lib/todos';
import { readViewJson, writeViewJson } from '../../lib/view-prefs';
import { DashboardWidgetBody } from './DashboardWidgets';

const POLL_MS = 15_000;
const LAYOUT_PREF = 'dashboard.layout';
/** 刷新后恢复滚动位置（sessionStorage：同一标签页刷新有效） */
const DASHBOARD_SCROLL_KEY = 'dashboard.scroll';
/** 画布窄于这个宽度（px）就不再按坐标铺开，改成一列堆叠 */
const NARROW_BREAKPOINT = 760;

/** 星期：与页头日期「2026年10月19日 星期一」一致 */
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

/** 按当前时间给一句问候（中午 12–14 点 / 下午 14–18 点 …） */
function greetingOf(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 9) return '早上好';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  if (hour < 23) return '晚上好';
  return '夜深了';
}

function dateOf(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 星期${
    WEEKDAY_CN[date.getDay()]
  }`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type SourceResult<T> = { ok: true; items: T[] } | { ok: false; error: string };

/** 单个来源：插件关着 → 空列表；服务没起来 → 只让对应卡片降级 */
async function loadSource<T>(
  enabled: boolean,
  healthy: boolean,
  load: () => Promise<T[]>,
  empty: T[],
): Promise<SourceResult<T>> {
  if (!enabled) return { ok: true, items: empty };
  if (!healthy) return { ok: false, error: '本地服务未就绪' };
  try {
    return { ok: true, items: await load() };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** 拖动手柄：3 × 2 小圆点（飞书样式，只有点，没有胶囊底） */
function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {[6.5, 9.5].map((cy) =>
        [5, 8, 11].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.15" fill="currentColor" />
        )),
      )}
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" fill="currentColor" />
      <rect
        x="11.5"
        y="2.5"
        width="6"
        height="6"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <rect
        x="2.5"
        y="11.5"
        width="6"
        height="6"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <rect
        x="11.5"
        y="11.5"
        width="6"
        height="6"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

/** 「编辑组件」弹层：卡片式勾选，点击整块切换 */
function EditWidgetsDialog(props: {
  open: boolean;
  layout: DashboardLayout;
  onChange: (next: DashboardLayout) => void;
  onClose: () => void;
}) {
  const { open, layout, onChange, onClose } = props;
  const hidden = new Set(layout.hidden);

  const toggle = (id: DashboardWidgetId) => {
    if (!hidden.has(id)) {
      onChange({ ...layout, hidden: [...layout.hidden, id] });
      return;
    }
    // 重新添加时尽量放回原来的位置；原位被别人占了就追加到画布最下方
    onChange(
      placeDashboardWidget({ ...layout, hidden: layout.hidden.filter((x) => x !== id) }, id),
    );
  };

  const shownCount = DASHBOARD_WIDGETS.filter((def) => !hidden.has(def.id)).length;

  return (
    <Dialog open={open} onClose={onClose} className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="tw-confirm-dialog tw-dialog-panel-anim flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white p-6 shadow-xl"
        >
          <DialogTitle className="tw-confirm-title shrink-0 text-base font-semibold text-stone-900">
            编辑组件
          </DialogTitle>
          <p className="mt-1.5 shrink-0 text-[11px] leading-5 text-stone-400">
            点选要放进画布的组件；卡片按住顶部圆点拖到任意位置，拖右下角把手可独立改宽 /
            改高，双击把手恢复默认大小。
          </p>

          {/* 一行三个；组件多时这一块单独滚动，底部按钮始终可见 */}
          <div className="mt-4 grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-2 overflow-y-auto pr-1">
            {DASHBOARD_WIDGETS.map((def) => {
              const on = !hidden.has(def.id);
              return (
                <button
                  type="button"
                  key={def.id}
                  onClick={() => toggle(def.id)}
                  aria-pressed={on}
                  className="tw-widget-option"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="tw-widget-check">
                      <CheckIcon />
                    </span>
                    <span className="tw-widget-option-title min-w-0 truncate">{def.title}</span>
                  </span>
                  <span className="tw-widget-option-desc pl-6">{def.desc}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-5 flex shrink-0 items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onChange(allDashboardWidgetsLayout(layout))}
                className="h-8 rounded-lg px-2.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                全部添加
              </button>
              <button
                type="button"
                onClick={() => onChange(compactDashboardWidgets(layout))}
                className="h-8 rounded-lg px-2.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                自动整理
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-stone-400 tabular-nums">
                已添加 {shownCount} / {DASHBOARD_WIDGETS.length}
              </span>
              <button
                type="button"
                onClick={onClose}
                className="h-8 rounded-lg bg-[#3370ff] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2b5fd9]"
              >
                完成
              </button>
            </div>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

export default function DashboardBoard() {
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(false);
  const [sources, setSources] = useState({
    todos: false,
    tasks: false,
    stats: false,
    projects: false,
  });
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<TestStatsItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [spaces, setSpaces] = useState<{ total: number; activeName: string } | null>(null);
  const [errors, setErrors] = useState<{
    todos?: string;
    tasks?: string;
    stats?: string;
    projects?: string;
  }>({});
  const [editOpen, setEditOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<DashboardWidgetId | null>(null);
  /** 正在拖 / 拉的卡片：只用来给一个抓起来的视觉反馈 */
  const [activeId, setActiveId] = useState<DashboardWidgetId | null>(null);
  /** 画布容器：用回调 ref 拿节点，容器真正挂上后再量宽度（首屏可能在等插件开关） */
  const [gridNode, setGridNode] = useState<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [layout, setLayout] = useState<DashboardLayout>(() =>
    normalizeDashboardLayout(readViewJson<unknown>(LAYOUT_PREF, null)),
  );

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // 归一化结果写回一次：旧版「待办概览」拆成五张指标卡这类迁移只做一遍，
  // 否则每次进页面都按旧数据重算坐标，画布看起来会「自己挪位置」
  useEffect(() => {
    writeViewJson(LAYOUT_PREF, layoutRef.current);
  }, []);

  const aliveRef = useRef(true);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      document.body.classList.remove('tw-reordering', 'tw-resizing');
    };
  }, []);

  /**
   * 刷新后回到上次浏览的位置。
   * 卡片是按数据加载后撑开的，太早恢复会被「页面还不够高」吞掉，所以边等边重试；
   * 滚动位置存 sessionStorage —— 同一个标签页刷新能回到原处，新开标签页仍从顶部开始。
   */
  useEffect(() => {
    const KEY = DASHBOARD_SCROLL_KEY;
    let target = 0;
    try {
      target = Number(window.sessionStorage.getItem(KEY) ?? 0) || 0;
    } catch {
      target = 0;
    }
    if (target <= 0) {
      // 没记录：只负责监听并保存
      let queued = false;
      const onScroll = () => {
        if (queued) return;
        queued = true;
        window.requestAnimationFrame(() => {
          queued = false;
          try {
            window.sessionStorage.setItem(KEY, String(window.scrollY));
          } catch {
            // 隐私模式下写不进去，不影响使用
          }
        });
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      return () => window.removeEventListener('scroll', onScroll);
    }

    let cancelled = false;
    let restoring = true;
    let tries = 0;
    const mountedAt = Date.now();
    const apply = () => {
      if (cancelled) return;
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      if (max + 2 >= target || tries >= 30) {
        window.scrollTo({ top: Math.min(target, max), behavior: 'instant' as ScrollBehavior });
        restoring = false;
        return;
      }
      tries += 1;
      window.setTimeout(apply, 100);
    };
    window.setTimeout(apply, 50);

    const onScroll = () => {
      if (restoring) return; // 恢复过程中的滚轮 / 锚点跳动不覆盖记录
      // 刚挂载时 Base.astro 可能还会把页面清零一次，别把「恢复目标」写成 0
      if (window.scrollY === 0 && Date.now() - mountedAt < 1500) return;
      try {
        window.sessionStorage.setItem(KEY, String(window.scrollY));
      } catch {
        // 同上
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    // 软导航时 Base.astro 会在 page-load 把滚动清零，这里再补一次
    const onPageLoad = () => {
      if (!cancelled && window.scrollY === 0) window.setTimeout(apply, 0);
    };
    document.addEventListener('astro:page-load', onPageLoad);
    return () => {
      cancelled = true;
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('astro:page-load', onPageLoad);
    };
  }, []);

  /**
   * 健康检查只在「还没确认可用」时打一次：本地服务起来之后每 15 秒最多 3 次多余探活，
   * 一旦拉取失败会自动把缓存清掉，下一次轮询重新探。
   */
  const healthRef = useRef<Record<'todos' | 'tasks' | 'stats' | 'projects', boolean>>({
    todos: false,
    tasks: false,
    stats: false,
    projects: false,
  });

  const refresh = useCallback(async () => {
    if (!aliveRef.current) return;
    const on = sourcesRef.current;
    const probe = async (
      key: 'todos' | 'tasks' | 'stats' | 'projects',
      enabled: boolean,
      check: () => Promise<boolean>,
    ) => {
      if (!enabled) return false;
      if (healthRef.current[key]) return true;
      const ok = await check();
      healthRef.current[key] = ok;
      return ok;
    };
    const [todoHealth, taskHealth, statHealth, projectHealth] = await Promise.all([
      probe('todos', on.todos, fetchTodosHealth),
      probe('tasks', on.tasks, fetchTasksHealth),
      probe('stats', on.stats, fetchTestStatsHealth),
      probe('projects', on.projects, fetchPmHealth),
    ]);
    const [todoRes, taskRes, statRes, projectRes, spaceRes] = await Promise.all([
      loadSource<TodoItem>(on.todos, todoHealth, listTodos, []),
      loadSource<TaskItem>(on.tasks, taskHealth, listTasks, []),
      loadSource<TestStatsItem>(
        on.stats,
        statHealth,
        () => listTestStats().then((list) => list.items),
        [],
      ),
      loadSource<ProjectItem>(
        on.projects,
        projectHealth,
        () => fetchPmStore().then((store) => store.projects),
        [],
      ),
      // 空间列表不跟插件开关走：静态部署拿不到就返回 null
      listSpaces().then((data) => {
        if (!data) return null;
        const list = data.spaces.filter((item) => item.exists);
        return {
          total: list.length,
          activeName: list.find((item) => item.isActive)?.name ?? '',
        };
      }),
    ]);
    if (!aliveRef.current) return;
    if (todoRes.ok) setTodos(todoRes.items);
    else healthRef.current.todos = false;
    if (taskRes.ok) setTasks(taskRes.items);
    else healthRef.current.tasks = false;
    if (statRes.ok) setStats(statRes.items);
    else healthRef.current.stats = false;
    if (projectRes.ok) setProjects(projectRes.items);
    else healthRef.current.projects = false;
    setSpaces(spaceRes);
    setErrors({
      todos: todoRes.ok ? undefined : todoRes.error,
      tasks: taskRes.ok ? undefined : taskRes.error,
      stats: statRes.ok ? undefined : statRes.error,
      projects: projectRes.ok ? undefined : projectRes.error,
    });
  }, []);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => {
      setPluginOn(Boolean(map.dashboard));
      setSources({
        todos: Boolean(map.todos),
        tasks: Boolean(map.tasks),
        stats: Boolean(map.testStats),
        projects: Boolean(map.projects),
      });
    });
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('dashboard'));
      setSources({
        todos: isPluginEnabled('todos'),
        tasks: isPluginEnabled('tasks'),
        stats: isPluginEnabled('testStats'),
        projects: isPluginEnabled('projects'),
      });
      setPluginReady(true);
    });
    return off;
  }, []);

  // 首次进入 / 来源插件开关变化后拉一次
  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void refresh();
  }, [
    pluginReady,
    pluginOn,
    sources.todos,
    sources.tasks,
    sources.stats,
    sources.projects,
    refresh,
  ]);

  // 15 秒轮询 + 回到前台刷新（工作台 AI 可能刚写入待办 / 任务）；页面在后台时跳过，省一次请求
  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pluginReady, pluginOn, refresh]);

  function updateLayout(next: DashboardLayout) {
    const normalized = normalizeDashboardLayout(next);
    // 拖拽时同一帧可能连续落位两次，ref 立即跟上，避免第二次基于旧布局计算
    layoutRef.current = normalized;
    setLayout(normalized);
    writeViewJson(LAYOUT_PREF, normalized);
  }

  const visible = useMemo(() => visibleDashboardWidgets(layout), [layout]);

  /** 页头问候用：有逾期待办时在标题后挂一句提醒 */
  const headerOverdue = useMemo(
    () => (sources.todos ? dashboardKpis(todos, tasks).overdue : 0),
    [sources.todos, todos, tasks],
  );
  const headerNow = new Date();
  const header = (
    <header className="mb-7 flex shrink-0 items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="tw-dash-hero-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3.2 13.9 9l5.8 1.9-5.8 1.9L12 18.6l-1.9-5.8L4.3 10.9 10.1 9Z" />
            <path d="M18.5 4.2v2.6M17.2 5.5h2.6M6 16.5v2M5 17.5h2" />
          </svg>
        </span>
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[26px] font-semibold leading-9 tracking-tight text-stone-900">
            {greetingOf(headerNow)}
            {headerOverdue > 0 ? (
              <span className="tw-dash-overdue text-sm font-medium">{headerOverdue} 项已延期</span>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-stone-500">{dateOf(headerNow)}</p>
        </div>
      </div>
      <div className="shrink-0 pt-1">
        {pluginReady && pluginOn ? (
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3.5 text-sm font-medium text-stone-700 shadow-sm transition-colors hover:bg-stone-50 hover:text-stone-900"
          >
            <span className="text-[#3370ff]">
              <EditIcon />
            </span>
            编辑组件
          </button>
        ) : null}
      </div>
    </header>
  );

  // 画布宽度随侧栏展开 / 窗口缩放变化：容器一变宽就重新排版
  useEffect(() => {
    if (!gridNode) return;
    const measure = () => setGridWidth(Math.round(gridNode.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(gridNode);
    return () => observer.disconnect();
  }, [gridNode]);

  /**
   * 画布坐标 → RGL 的 layout（高度上限防拉太高；宽度 / 高度冲突在松手时推开邻居）。
   * 窄屏（手机 / 分屏）下列宽只有一百多 px，日历和表格都放不下，
   * 改为把所有卡片堆成一列，并关掉拖动 / 缩放（坐标仍按原画布保存，变宽后自动还原）。
   */
  const narrow = gridWidth > 0 && gridWidth < NARROW_BREAKPOINT;
  /**
   * 行数上限不能写死：卡片拖到画布底部后，y 会超过固定的 DASHBOARD_MAX_ROWS，
   * RGL 会把落点夹回「maxRows - h」（表现为「怎么都拖不下去 / 一拖就跳」）。
   * 这里按当前最靠下的卡片动态放宽，留 40 行余量；拉高上限仍由每张卡的 maxH 管。
   */
  const gridMaxRows = useMemo(() => {
    const bottom = visible.reduce((max, { rect }) => Math.max(max, rect.y + rect.h), 0);
    return Math.max(DASHBOARD_MAX_ROWS, bottom + 40);
  }, [visible]);
  const gridLayout = useMemo<GridLayoutModel>(() => {
    if (narrow) {
      return stackedDashboardWidgets(layout).map(({ id, rect }) => ({
        i: id,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        minW: DASHBOARD_COLS,
      }));
    }
    return visible.map(({ id, rect }) => ({
      i: id,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      minW: dashboardMinCols(id),
      minH: dashboardMinRows(id),
      maxH: DASHBOARD_MAX_ROWS,
    }));
  }, [visible, narrow, layout]);

  /**
   * 松手时一次性落盘：RGL 内部拖动期间自己维护位置，不跟 React state 打架。
   * 缩放不会推邻居（RGL 的自由画布没有 compaction），所以松手后把重叠的卡收边。
   * `direction` 记录拖动方向：往上拖时上面的卡往上让，而不是被顶到下面。
   */
  function commitGrid(
    next: GridLayoutModel,
    pushFrom?: DashboardWidgetId,
    mode: 'drag' | 'resize' = 'drag',
    direction: 'up' | 'down' = 'down',
  ) {
    const rects: Partial<Record<DashboardWidgetId, DashboardRect>> = { ...layoutRef.current.rects };
    let changed = false;
    for (const item of next) {
      if (!isDashboardWidgetId(item.i)) continue;
      const prev = rects[item.i];
      if (
        prev &&
        prev.x === item.x &&
        prev.y === item.y &&
        prev.w === item.w &&
        prev.h === item.h
      ) {
        continue;
      }
      rects[item.i] = { x: item.x, y: item.y, w: item.w, h: item.h };
      changed = true;
    }
    if (!changed) return;
    const merged = { ...layoutRef.current, rects };
    updateLayout(
      pushFrom ? settleDashboardOverlaps(merged, pushFrom, mode, { direction }) : merged,
    );
  }

  /** 双击右下角把手：优先在原地恢复这张卡的默认大小，原位放不下再排到画布最下方 */
  function resetRect(id: DashboardWidgetId) {
    const rects = { ...layoutRef.current.rects };
    const current = rects[id];
    const def = defaultDashboardRect(id);
    rects[id] = current ? { ...def, x: current.x, y: current.y } : def;
    updateLayout(placeDashboardWidget({ ...layoutRef.current, rects }, id));
  }

  /** 今日待办勾选完成：先乐观更新，失败回滚并提示 */
  async function handleToggleTodo(item: TodoItem) {
    const snapshot = todos;
    setTodos((prev) =>
      prev.map((x) =>
        x.id === item.id ? { ...x, status: 'done', doneAt: new Date().toISOString() } : x,
      ),
    );
    try {
      const updated = await updateTodo(item.id, { status: 'done' });
      if (!aliveRef.current) return;
      setTodos((prev) => prev.map((x) => (x.id === item.id ? updated : x)));
      setErrors((prev) => ({ ...prev, todos: undefined }));
    } catch (e) {
      if (!aliveRef.current) return;
      setTodos(snapshot);
      setErrors((prev) => ({ ...prev, todos: errorText(e) }));
    }
  }

  if (!pluginReady) {
    return (
      <>
        {header}
        <div
          className="tw-dash-surface flex min-h-[280px] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white"
          aria-busy="true"
          aria-label="正在读取插件开关"
        >
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <span className="tw-lib-spin" aria-hidden="true" />
          </div>
        </div>
      </>
    );
  }

  if (!pluginOn) {
    return (
      <>
        {header}
        <div className="tw-lib-notice rounded-2xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
          {pluginDisabledMessage('dashboard')}
        </div>
      </>
    );
  }

  let content: ReactNode;
  if (visible.length === 0) {
    content = (
      <div className="tw-dash-surface flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-stone-200 bg-white px-5 py-24 text-center">
        <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-stone-100 text-stone-400">
          <EditIcon />
        </span>
        <p className="text-sm font-medium text-stone-700">画布上还没有组件</p>
        <p className="text-xs text-stone-400">先挑要显示的卡片，之后布局会按当前空间记住</p>
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="mt-2 h-8 rounded-lg bg-[#3370ff] px-3.5 text-xs font-medium text-white transition-colors hover:bg-[#2b5fd9]"
        >
          添加组件
        </button>
      </div>
    );
  } else {
    content = (
      <div
        ref={setGridNode}
        className={`tw-dash-grid w-full${narrow ? ' tw-dash-grid--stacked' : ''}`}
        onMouseDown={(e) => {
          // 点画布空白处取消选中（RGL 的容器和占位层都算空白）
          if (!(e.target as HTMLElement).closest('.react-grid-item')) setSelectedId(null);
        }}
        onDoubleClick={(e) => {
          const handle = (e.target as HTMLElement).closest('.react-resizable-handle');
          if (!handle) return;
          const cell = handle.closest<HTMLElement>('[data-sort-key]');
          const id = cell?.dataset.sortKey;
          if (isDashboardWidgetId(id)) resetRect(id);
        }}
      >
        {gridWidth > 0 ? (
          <ReactGridLayout
            width={gridWidth}
            layout={gridLayout}
            gridConfig={{
              cols: DASHBOARD_COLS,
              rowHeight: DASHBOARD_ROW_HEIGHT,
              // 纵向不留 margin：间距由格子内 6px 的 padding 提供（两侧相加 12px），卡片高度才能正好 = 行数 × 20
              margin: [0, 0] as const,
              containerPadding: [0, 0],
              maxRows: gridMaxRows,
            }}
            // 自由画布：不自动往上压；拖动 / 拉伸时允许临时重叠，松手后统一把被挡住的卡往下推
            compactor={noOverlapCompactor}
            dragConfig={{
              enabled: !narrow,
              handle: '.tw-dash-handle',
              cancel: '.react-resizable-handle',
            }}
            resizeConfig={{ enabled: !narrow, handles: ['se'] }}
            onDragStart={(_next, oldItem) => {
              if (oldItem && isDashboardWidgetId(oldItem.i)) {
                setActiveId(oldItem.i);
                setSelectedId(oldItem.i);
              }
              document.body.classList.add('tw-reordering');
            }}
            onDragStop={(next, oldItem) => {
              document.body.classList.remove('tw-reordering');
              setActiveId(null);
              const id = oldItem && isDashboardWidgetId(oldItem.i) ? oldItem.i : undefined;
              const was = id ? layoutRef.current.rects[id] : undefined;
              const now = id ? next.find((item) => item.i === id) : undefined;
              commitGrid(next, id, 'drag', now && was && now.y < was.y ? 'up' : 'down');
            }}
            onResizeStart={(_next, oldItem) => {
              if (oldItem && isDashboardWidgetId(oldItem.i)) {
                setActiveId(oldItem.i);
                setSelectedId(oldItem.i);
              }
              document.body.classList.add('tw-resizing');
            }}
            onResizeStop={(next, oldItem) => {
              document.body.classList.remove('tw-resizing');
              setActiveId(null);
              commitGrid(next, oldItem && isDashboardWidgetId(oldItem.i) ? oldItem.i : undefined);
            }}
          >
            {visible.map(({ id, def }) => {
              const selected = selectedId === id;
              const active = activeId === id;
              return (
                <div
                  key={id}
                  data-sort-key={id}
                  className="tw-dash-cell min-w-0 p-1.5"
                  onClick={() => setSelectedId(id)}
                >
                  <div
                    className={`tw-dash-card group relative h-full min-h-0 rounded-2xl ${
                      selected ? 'tw-dash-card-selected' : ''
                    } ${active ? 'tw-dash-card-selected opacity-70' : ''}`}
                  >
                    <button
                      type="button"
                      aria-label={`拖动 ${def.title}`}
                      draggable={false}
                      onDragStart={(e) => e.preventDefault()}
                      className={`tw-dash-handle absolute left-1/2 top-0 z-10 flex h-7 w-12 -translate-x-1/2 cursor-move touch-none items-center justify-center rounded-b-md text-stone-400 transition-[opacity,color,background-color] hover:bg-stone-100 hover:text-stone-600 focus-visible:opacity-100 ${
                        selected || active
                          ? 'opacity-100'
                          : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
                      }`}
                    >
                      <GripIcon />
                    </button>

                    <DashboardWidgetBody
                      id={id}
                      data={{
                        todos,
                        tasks,
                        stats,
                        projects,
                        spaces,
                        todosOn: sources.todos,
                        tasksOn: sources.tasks,
                        statsOn: sources.stats,
                        projectsOn: sources.projects,
                        errors,
                        onToggleTodo: handleToggleTodo,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </ReactGridLayout>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {header}

      {content}

      <EditWidgetsDialog
        open={editOpen}
        layout={layout}
        onChange={updateLayout}
        onClose={() => setEditOpen(false)}
      />
    </>
  );
}
