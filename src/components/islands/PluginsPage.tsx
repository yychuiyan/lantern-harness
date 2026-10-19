import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  PLUGIN_CATALOG,
  groupPluginsByCategory,
  loadPluginEnabled,
  onPluginEnabledChanged,
  setPluginEnabled,
  type PluginId,
} from '../../lib/plugins';
import {
  GLOBAL_PLUGIN_CATALOG,
  SESSION_PLUGIN_CATALOG,
  builtinRuntimeKey,
  type BuiltinCatalogEntry,
} from '../../lib/builtin-plugin-catalog';
import { fetchMemoryHealth, type MemoryHealth } from '../../lib/memory';
import { fetchWebHealth, type WebHealth } from '../../lib/web-tools';
import { fetchFsHealth, type FsHealth } from '../../lib/fs-tools';
import {
  fetchBashHealth,
  fetchPwshHealth,
  type BashHealth,
  type PwshHealth,
} from '../../lib/bash-tools';
import { hydrateAppConfig } from '../../lib/settings';
import { syncReportPrompt } from '../../lib/report-prompt';
import { fetchTasksHealth } from '../../lib/tasks';
import { fetchTodosHealth } from '../../lib/todos';
import { fetchTestStatsHealth } from '../../lib/test-stats';
import { fetchCaseExecHealth } from '../../lib/case-exec';
import { fetchPmHealth, syncPmStore } from '../../lib/pm';
import { readViewPref, writeViewPref } from '../../lib/view-prefs';
import OverflowHint from './OverflowHint';

type MineTab = 'session' | 'global' | 'extension';

/** 侧栏有独立页面的数据型插件：运行状态靠各自的本机服务探测 */
type BoardPluginId =
  | 'tasks'
  | 'todos'
  | 'projects'
  | 'iterations'
  | 'pmRequirements'
  | 'bugs'
  | 'testStats'
  | 'caseExec'
  | 'dashboard';

const BOARD_DETAIL: Record<BoardPluginId, string> = {
  tasks: '侧栏「任务管理」按状态列出任务；工作台可直接增删改',
  todos: '侧栏「待办事项」按状态 / 紧急程度分组；工作台可直接增删改',
  projects: '侧栏「项目列表」管理项目并汇总迭代 / 需求 / 缺陷；工作台可直接增删改',
  iterations: '侧栏「迭代管理」按项目维护迭代周期、进度与逾期；工作台可直接增删改',
  pmRequirements: '侧栏「需求管理」维护需求编号 / 优先级 / 状态与验收标准；工作台可直接增删改',
  bugs: '侧栏「缺陷管理」记录严重程度 / 重现步骤与修复状态；工作台可直接增删改',
  testStats: '侧栏「测试统计」按维度记录每天的统计数量',
  caseExec: '侧栏「用例执行统计」按项目记录用例执行情况',
  dashboard: '侧栏「仪表盘」聚合待办 / 任务 / 测试统计；卡片可拖动排序、拖角改宽高，右上角编辑组件',
};

const BOARD_PROBES: Record<BoardPluginId, () => Promise<boolean>> = {
  tasks: fetchTasksHealth,
  todos: fetchTodosHealth,
  projects: fetchPmHealth,
  iterations: fetchPmHealth,
  pmRequirements: fetchPmHealth,
  bugs: fetchPmHealth,
  testStats: fetchTestStatsHealth,
  caseExec: fetchCaseExecHealth,
  dashboard: fetchTodosHealth,
};

/** 「我的插件」Tab 的记忆键与候选值 */
const MINE_TAB_VALUES = ['extension', 'session', 'global'] as const;
const MINE_TAB_PREF = 'plugins.mine-tab';

type RuntimeStatus = {
  available: boolean | null;
  detail: string;
};

type BuiltinStatus = {
  label: string;
  tone: 'ready' | 'warn' | 'plan';
};

interface Props {
  /** 嵌在 AI 工作台右侧时去掉整页 min-height */
  embedded?: boolean;
}

/** 扩展插件的分类分组（静态目录，模块级算一次） */
const EXTENSION_GROUPS = groupPluginsByCategory();

export default function PluginsPage({ embedded = false }: Props) {
  const [mineTab, setMineTabState] = useState<MineTab>(() =>
    readViewPref<MineTab>(MINE_TAB_PREF, MINE_TAB_VALUES, 'extension'),
  );
  const [enabled, setEnabled] = useState<Record<PluginId, boolean>>(() => loadPluginEnabled());
  const [memory, setMemory] = useState<MemoryHealth | null>(null);
  const [web, setWeb] = useState<WebHealth | null>(null);
  const [fs, setFs] = useState<FsHealth | null>(null);
  const [bash, setBash] = useState<BashHealth | null>(null);
  const [pwsh, setPwsh] = useState<PwshHealth | null>(null);
  /** 任务 / 待办 / 项目 / 迭代 / 需求 / 缺陷 / 测试统计 / 用例执行统计的本机服务探测结果 */
  const [boards, setBoards] = useState<Record<BoardPluginId, boolean> | null>(null);
  const [probing, setProbing] = useState(true);

  async function refreshRuntime(): Promise<void> {
    setProbing(true);
    try {
      const [
        m,
        w,
        f,
        b,
        p,
        tasks,
        todos,
        projects,
        iterations,
        pmRequirements,
        bugs,
        testStats,
        caseExec,
        dashboard,
      ] = await Promise.all([
        fetchMemoryHealth(),
        fetchWebHealth(),
        fetchFsHealth(),
        fetchBashHealth(),
        fetchPwshHealth(),
        BOARD_PROBES.tasks(),
        BOARD_PROBES.todos(),
        BOARD_PROBES.projects(),
        BOARD_PROBES.iterations(),
        BOARD_PROBES.pmRequirements(),
        BOARD_PROBES.bugs(),
        BOARD_PROBES.testStats(),
        BOARD_PROBES.caseExec(),
        BOARD_PROBES.dashboard(),
      ]);
      setMemory(m);
      setWeb(w);
      setFs(f);
      setBash(b);
      setPwsh(p);
      setBoards({
        tasks,
        todos,
        projects,
        iterations,
        pmRequirements,
        bugs,
        testStats,
        caseExec,
        dashboard,
      });
    } finally {
      setProbing(false);
    }
  }

  useEffect(() => {
    const offP = onPluginEnabledChanged((mapNext) => setEnabled(mapNext));
    void hydrateAppConfig().then(() => {
      setEnabled(loadPluginEnabled());
      void refreshRuntime();
    });
    return () => {
      offP();
    };
  }, []);

  function runtimeFor(id: PluginId): RuntimeStatus {
    if (id === 'cases') {
      return {
        available: true,
        detail: '侧栏「用例管理」浏览与维护本空间用例库',
      };
    }
    if (id === 'caseGen') {
      if (!enabled.cases) {
        return {
          available: false,
          detail: '需先启用「用例管理」，生成结果才能写入用例列表',
        };
      }
      return {
        available: true,
        detail: '对话输入 / 打开配置面板，生成用例并写入用例库',
      };
    }
    if (id === 'prompts') {
      return {
        available: true,
        detail: '侧栏「提示词管理」浏览与维护本空间提示词库',
      };
    }
    if (id === 'promptGen') {
      if (!enabled.prompts) {
        return {
          available: false,
          detail: '需先启用「提示词管理」，生成结果才能写入提示词列表',
        };
      }
      return {
        available: true,
        detail: '对话输入 / 打开配置面板，生成提示词并写入提示词库',
      };
    }
    if (id === 'knowledgeLib') {
      return {
        available: true,
        detail: '侧栏「知识库管理」浏览与维护本空间知识库',
      };
    }
    if (id === 'requirements') {
      return {
        available: true,
        detail: '侧栏「需求文档库」浏览与维护本空间需求文档',
      };
    }
    if (id === 'templates') {
      return {
        available: true,
        detail: '侧栏「测试模板库」浏览与维护本空间用例模板',
      };
    }
    if (id === 'reports') {
      return {
        available: true,
        detail: '侧栏「工作汇报」按日报 / 周报 / 月报列出汇报文件；工作台按提示词写作',
      };
    }
    if (
      id === 'tasks' ||
      id === 'todos' ||
      id === 'projects' ||
      id === 'iterations' ||
      id === 'pmRequirements' ||
      id === 'bugs' ||
      id === 'testStats' ||
      id === 'caseExec' ||
      id === 'dashboard'
    ) {
      const ok = boards?.[id];
      if (ok === undefined) {
        return { available: probing ? null : false, detail: probing ? '探测中…' : '需本地服务' };
      }
      return ok
        ? { available: true, detail: BOARD_DETAIL[id] }
        : { available: false, detail: '需本地服务（npm run dev / lantern web）' };
    }
    if (id === 'knowledgeGen') {
      if (!enabled.knowledgeLib) {
        return {
          available: false,
          detail: '需先启用「知识库管理」，生成结果才能写入知识库列表',
        };
      }
      return {
        available: true,
        detail: '对话输入 / 打开配置面板，生成文档并写入知识库',
      };
    }
    if (id === 'memory') {
      if (probing && memory === null) return { available: null, detail: '探测中…' };
      if (memory?.ok) {
        return {
          available: true,
          detail: `已连接 · ${memory.entryCount ?? memory.entityCount ?? 0} 条记忆 / 待确认 ${memory.suggestionCount ?? 0}`,
        };
      }
      return { available: false, detail: '本地记忆服务未就绪' };
    }
    if (id === 'knowledge') {
      return {
        available: true,
        detail: '对话输入 @ 可引用知识库与模板文档',
      };
    }
    if (id === 'pluginDev') {
      if (probing && fs === null) return { available: null, detail: '探测中…' };
      if (fs?.ok) {
        return {
          available: true,
          detail: '固定提示词开发扩展插件；先评估确认，再改代码并入「扩展插件」',
        };
      }
      return { available: false, detail: '需本地文件服务：开发要读写项目源码' };
    }
    return { available: false, detail: '未知' };
  }

  function builtinStatus(entry: BuiltinCatalogEntry): BuiltinStatus {
    const key = builtinRuntimeKey(entry.id);
    if (key === 'none') return { label: '规划中', tone: 'plan' };
    if (key === 'ready') return { label: '已就绪', tone: 'ready' };
    if (
      probing &&
      ((key === 'web' && web === null) ||
        (key === 'fs' && fs === null) ||
        (key === 'bash' && bash === null) ||
        (key === 'pwsh' && pwsh === null))
    ) {
      return { label: '探测中…', tone: 'plan' };
    }
    if (key === 'web') {
      if (web?.ok) return { label: '已就绪', tone: 'ready' };
      return { label: '需本地服务', tone: 'warn' };
    }
    if (key === 'fs') {
      if (fs?.ok) return { label: '已就绪', tone: 'ready' };
      return { label: '需本地服务', tone: 'warn' };
    }
    if (key === 'bash') {
      if (bash?.ok) return { label: '已就绪', tone: 'ready' };
      return { label: '需本地服务', tone: 'warn' };
    }
    if (key === 'pwsh') {
      if (pwsh?.ok && pwsh.available) return { label: '已就绪', tone: 'ready' };
      if (pwsh?.ok) return { label: '未装 PowerShell', tone: 'warn' };
      return { label: '需本地服务', tone: 'warn' };
    }
    return { label: '规划中', tone: 'plan' };
  }

  function toggle(id: PluginId) {
    const next = setPluginEnabled(id, !enabled[id]);
    setEnabled(next);
    // 工作汇报是纯提示词型插件：打开即生成提示词；汇报目录等真正写入汇报文件时才出现
    if (id === 'reports') {
      void syncReportPrompt(Boolean(next.reports)).catch((e: unknown) => {
        // 失败不阻断开关本身：控制台留痕，进入工作汇报页时还会再补一次
        console.warn('[reports] 同步工作汇报提示词失败', e);
      });
    }
    // 测试统计 / 用例执行统计：不预建目录，第一次落库时才在空间里铺出对应文件夹
    // 项目管理四插件：空间里有旧版单文件数据时，打开开关后拆到各自目录；没有数据不建空目录
    if (
      (id === 'projects' || id === 'iterations' || id === 'pmRequirements' || id === 'bugs') &&
      next[id]
    ) {
      void syncPmStore().catch((e: unknown) => {
        console.warn('[pm] 同步项目管理数据目录失败', e);
      });
    }
  }

  /** 切「我的插件」Tab：记住选择，刷新 / 重新进入页面后回到这个 Tab */
  function chooseMineTab(next: MineTab) {
    writeViewPref(MINE_TAB_PREF, next);
    setMineTabState(next);
  }

  return (
    <div
      className={`tw-plugins-page overflow-y-auto ${embedded ? 'h-full min-h-0 flex-1' : 'min-h-screen'}`}
    >
      <div className={`w-full ${embedded ? 'px-6 py-5' : 'px-6 py-6'}`}>
        <MinePanel
          mineTab={mineTab}
          onMineTab={chooseMineTab}
          enabled={enabled}
          runtimeFor={runtimeFor}
          builtinStatus={builtinStatus}
          onToggle={toggle}
        />
      </div>
    </div>
  );
}

function lhFullName(id: string): string {
  return `@lh-plugins/${id}`;
}

/** 全局/会话卡片描述：去掉对照体系残留字样，避免出现在产品页 */
function displayPluginRoleZh(text: string): string {
  return String(text ?? '')
    .replace(/（\s*dsh[^）]*）/gi, '')
    .replace(/\(\s*dsh[^)]*\)/gi, '')
    .replace(/\bdsh\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/（\s*）/g, '')
    .trim();
}

function MinePanel(props: {
  mineTab: MineTab;
  onMineTab: (t: MineTab) => void;
  enabled: Record<PluginId, boolean>;
  runtimeFor: (id: PluginId) => RuntimeStatus;
  builtinStatus: (e: BuiltinCatalogEntry) => BuiltinStatus;
  onToggle: (id: PluginId) => void;
}) {
  const { mineTab, onMineTab, enabled, runtimeFor, builtinStatus, onToggle } = props;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});

  const tabs: Array<{ id: MineTab; label: string; count: number; hint: string }> = [
    { id: 'extension', label: '扩展插件', count: PLUGIN_CATALOG.length, hint: '可配置插件' },
    { id: 'session', label: '会话插件', count: SESSION_PLUGIN_CATALOG.length, hint: '默认' },
    { id: 'global', label: '全局插件', count: GLOBAL_PLUGIN_CATALOG.length, hint: '默认' },
  ];

  // 选中项下标：滑动指示块据此平移
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === mineTab),
  );

  // WAI-ARIA Tabs 配套：给 tab / tabpanel 建立 id 关联，并支持方向键 + roving tabindex。
  // 用 useId 生成前缀，避免同页多个实例 id 冲突。
  const idBase = useId();
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const panelId = `${idBase}-panel`;
  const tabDomId = (id: string) => `${idBase}-tab-${id}`;
  // 轨道列数由 tabs 推导（原实现写死 3 列，加 tab 会静默错位）
  const tabCount = Math.max(1, tabs.length);
  // 轨道被"占掉"的固定宽度：p-1 左右各 0.25rem + (n-1) 条 gap-1
  const trackChrome = 0.5 + 0.25 * (tabCount - 1);

  function selectTab(id: MineTab) {
    onMineTab(id);
    setExpandedId(null);
  }

  /** 方向键 / Home / End：按 tabs 顺序环形切换，并把焦点带到新选中的 tab。 */
  function onTablistKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const n = tabs.length;
    if (!n) return;
    let next = activeIndex;
    if (e.key === 'ArrowLeft') next = (activeIndex - 1 + n) % n;
    else if (e.key === 'ArrowRight') next = (activeIndex + 1) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    const target = tabs[next];
    if (!target) return;
    selectTab(target.id);
    tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  function toggleExpand(id: string) {
    setExpandedId((cur) => (cur === id ? null : id));
  }

  return (
    <>
      <header className="mb-4 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold text-stone-900">我的插件</h2>
          <p className="mt-1.5 text-sm text-stone-500 leading-6">
            扩展为可配置插件；会话 / 全局为平台默认。点击卡片展开详情。
          </p>
        </div>
      </header>

      <div
        ref={tablistRef}
        className="mb-5 relative grid gap-1 p-1 rounded-2xl bg-stone-100 border border-stone-200/90"
        style={{ gridTemplateColumns: `repeat(${tabCount}, minmax(0, 1fr))` }}
        role="tablist"
        aria-label="插件分类"
        aria-orientation="horizontal"
        onKeyDown={onTablistKeyDown}
      >
        {/* 选中滑块：跟随选中项平移，替代原先「活动项直接换底色」的硬切。
            轨道 p-1 左右各 0.25rem、列间 gap-1，故
            滑块宽 = (100% − trackChrome) / 列数，位移 100% 即自身宽度（一列），
            每多一项再加一个 gap（0.25rem）。列数从 tabs.length 推导，
            避免原实现写死 3 列、日后加 tab 时静默错位。 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1 top-1 bottom-1 rounded-xl bg-white shadow-sm ring-1 ring-stone-200/80 transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={{
            width: `calc((100% - ${trackChrome}rem) / ${tabCount})`,
            transform: `translateX(calc(${activeIndex} * (100% + 0.25rem)))`,
          }}
        />
        {tabs.map((t) => {
          const active = mineTab === t.id;
          return (
            <button
              key={t.id}
              id={tabDomId(t.id)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onClick={() => selectTab(t.id)}
              className={`relative min-w-0 h-11 px-2 rounded-xl text-left transition-colors ${
                active ? 'text-stone-900' : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              <div className="flex items-baseline gap-1.5 justify-center sm:justify-start sm:px-1">
                <span className="text-[13px] font-semibold truncate">{t.label}</span>
                <span className="text-[11px] tabular-nums text-stone-400">{t.count}</span>
              </div>
              <div
                className={`hidden sm:block text-[10px] px-1 mt-0.5 ${active ? 'text-stone-400' : 'text-stone-400/80'}`}
              >
                {t.hint}
              </div>
            </button>
          );
        })}
      </div>

      {/* 三个分类共用同一个面板容器，作为 tablist 对应的 tabpanel。
          面板内始终存在可聚焦元素（插件卡片按钮 / 链接），因此按 WAI-ARIA APG
          不额外设置 tabIndex，避免多出一个空转的 tab 停靠点。 */}
      <div id={panelId} role="tabpanel" aria-labelledby={tabDomId(mineTab)}>
        {mineTab === 'extension' ? (
          <>
            <p className="mb-3 text-xs text-stone-500">可配置插件 · {PLUGIN_CATALOG.length} 个</p>
            <div className="space-y-5">
              {EXTENSION_GROUPS.map((g) => {
                const collapsed = Boolean(collapsedCats[g.category]);
                return (
                  <section key={g.category}>
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() =>
                        setCollapsedCats((prev) => ({ ...prev, [g.category]: !collapsed }))
                      }
                      className="mb-2 flex w-full items-center gap-1.5 text-left text-[13px] font-medium text-stone-600"
                    >
                      <Chevron
                        className={`h-3.5 w-3.5 shrink-0 text-stone-400 transition-transform ${
                          collapsed ? '-rotate-90' : ''
                        }`}
                      />
                      <span>{g.category}</span>
                      <span className="text-[11px] tabular-nums text-stone-400">
                        {g.items.length}
                      </span>
                    </button>
                    {collapsed ? null : (
                      <ul className="tw-anim-list tw-plugin-grid">
                        {g.items.map((p) => {
                          const on = enabled[p.id];
                          const rt = runtimeFor(p.id);
                          const open = expandedId === `ext:${p.id}`;
                          const configLabel = p.alwaysOn ? '内置常开' : on ? '已启用' : '未启用';
                          const runLabel = on && rt.available === true ? '运行中' : '已停用';
                          return (
                            <li
                              key={p.id}
                              className={`min-w-0 relative z-0 overflow-visible hover:z-40 focus-within:z-40${open ? ' z-40' : ''}`}
                            >
                              <PluginExpandCard
                                open={open}
                                onToggleOpen={() => toggleExpand(`ext:${p.id}`)}
                                title={p.name}
                                subtitle={p.description}
                                badge={
                                  <span className="text-[11px] px-1.5 py-0.5 rounded border border-stone-200 text-stone-500 tabular-nums">
                                    v{p.version}
                                  </span>
                                }
                                trailing={
                                  p.alwaysOn ? (
                                    <span className="text-[11px] px-1.5 py-0.5 rounded border border-stone-200 text-stone-500">
                                      内置
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      role="switch"
                                      aria-checked={on}
                                      aria-label={`${on ? '关闭' : '打开'} ${p.name}`}
                                      onClick={() => onToggle(p.id)}
                                      className="tw-toggle"
                                    >
                                      <span className="tw-toggle-knob" />
                                    </button>
                                  )
                                }
                                fullName={lhFullName(p.id)}
                                configLabel={configLabel}
                                runLabel={runLabel}
                                extra={rt.detail}
                              />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
            <p className="mt-5 text-xs text-stone-400 leading-5">
              开关保存在本机。网页搜索 / 工作区文件已迁入会话默认能力。
            </p>
          </>
        ) : null}

        {mineTab === 'session' ? (
          <BuiltinCatalogGrid
            title="由平台按会话默认提供"
            entries={SESSION_PLUGIN_CATALOG}
            statusOf={builtinStatus}
            groupByCategory={false}
            expandedId={expandedId}
            onExpand={toggleExpand}
            idPrefix="sess"
          />
        ) : null}
        {mineTab === 'global' ? (
          <BuiltinCatalogGrid
            title="由系统与全部会话共享"
            entries={GLOBAL_PLUGIN_CATALOG}
            statusOf={builtinStatus}
            groupByCategory
            expandedId={expandedId}
            onExpand={toggleExpand}
            idPrefix="glob"
          />
        ) : null}
      </div>
    </>
  );
}

function BuiltinCatalogGrid(props: {
  title: string;
  entries: BuiltinCatalogEntry[];
  statusOf: (e: BuiltinCatalogEntry) => BuiltinStatus;
  groupByCategory: boolean;
  expandedId: string | null;
  onExpand: (id: string) => void;
  idPrefix: string;
}) {
  const { title, entries, statusOf, groupByCategory, expandedId, onExpand, idPrefix } = props;

  const groups = useMemo(() => {
    if (!groupByCategory) return [{ name: '', items: entries }];
    const map = new Map<string, BuiltinCatalogEntry[]>();
    for (const e of entries) {
      const k = e.category || '其它';
      const list = map.get(k) ?? [];
      list.push(e);
      map.set(k, list);
    }
    return [...map.entries()].map(([name, items]) => ({ name, items }));
  }, [entries, groupByCategory]);

  return (
    <div>
      <p className="mb-3 text-xs text-stone-500">
        {title} · {entries.length} 个
      </p>
      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g.name || 'all'}>
            {g.name ? (
              <h3 className="mb-2 text-[13px] font-medium text-stone-600">{g.name}</h3>
            ) : null}
            <ul className="tw-anim-list tw-plugin-grid">
              {g.items.map((e) => {
                const st = statusOf(e);
                const key = `${idPrefix}:${e.id}`;
                const open = expandedId === key;
                const configLabel = '已启用';
                const runLabel = st.tone === 'ready' ? '运行中' : '已停用';
                return (
                  <li
                    key={e.id}
                    className={`min-w-0 relative z-0 overflow-visible hover:z-40 focus-within:z-40${open ? ' z-40' : ''}`}
                  >
                    <PluginExpandCard
                      open={open}
                      onToggleOpen={() => onExpand(key)}
                      title={e.id}
                      titleMono
                      subtitle={displayPluginRoleZh(e.roleZh)}
                      status={st}
                      fullName={lhFullName(e.id)}
                      configLabel={configLabel}
                      runLabel={runLabel}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function PluginExpandCard(props: {
  open: boolean;
  onToggleOpen: () => void;
  title: string;
  titleMono?: boolean;
  subtitle: string;
  badge?: ReactNode;
  /** 右侧与标题行对齐的状态（已就绪 / 规划中 / …） */
  status?: BuiltinStatus;
  trailing?: ReactNode;
  fullName: string;
  configLabel: string;
  runLabel: string;
  extra?: string;
}) {
  const {
    open,
    onToggleOpen,
    title,
    titleMono,
    subtitle,
    badge,
    status,
    trailing,
    fullName,
    configLabel,
    runLabel,
    extra,
  } = props;

  return (
    <div
      className={`tw-plugin-card group/card relative z-0 hover:z-40 focus-within:z-40 bg-white border rounded-xl transition-colors self-start w-full overflow-visible ${
        open ? 'border-[#4176e6]/50 shadow-sm z-40' : 'border-stone-200 hover:border-stone-300'
      }`}
    >
      <div className="relative px-4 py-3 flex gap-3 items-start h-17 overflow-visible">
        <button
          type="button"
          onClick={onToggleOpen}
          className="relative flex-1 min-w-0 h-full text-left outline-none focus:outline-none overflow-visible"
          aria-expanded={open}
        >
          <div className="flex items-center gap-2 min-w-0">
            <h3
              className={`font-medium text-stone-900 truncate min-w-0 ${titleMono ? 'font-mono text-[13px]' : 'text-[14px]'}`}
            >
              {title}
            </h3>
            {badge}
            <Chevron
              className={`w-3.5 h-3.5 text-stone-400 shrink-0 transition-transform duration-300 ease-out ${open ? 'rotate-180' : ''}`}
            />
          </div>
          <OverflowHint
            text={subtitle}
            className="mt-1 block min-w-0 text-[13px] text-stone-500 leading-5 truncate"
            disabled={open}
          />
        </button>
        <div className="shrink-0 flex items-center gap-2 pt-0.5 self-start">
          {status ? <StatusPill tone={status.tone} label={status.label} /> : null}
          {trailing}
        </div>
      </div>
      <div className={`tw-collapse ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <div className="tw-collapse-inner">
          <div className="px-4 pb-3 pt-0 border-t border-stone-100">
            <dl className="mt-2.5 space-y-1.5 text-[13px]">
              <div className="flex gap-2">
                <dt className="shrink-0 w-18 text-stone-400">完整名称</dt>
                <dd className="min-w-0 font-mono text-[12px] text-stone-700 break-all">
                  {fullName}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 w-18 text-stone-400">配置状态</dt>
                <dd className="text-stone-700">{configLabel}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 w-18 text-stone-400">运行状态</dt>
                <dd className={runLabel === '运行中' ? 'text-emerald-600' : 'text-stone-500'}>
                  {runLabel}
                </dd>
              </div>
              {subtitle ? (
                <div className="flex gap-2">
                  <dt className="shrink-0 w-18 text-stone-400">简介</dt>
                  <dd className="text-stone-500 text-[12px] leading-5">{subtitle}</dd>
                </div>
              ) : null}
              {extra ? (
                <div className="flex gap-2">
                  <dt className="shrink-0 w-18 text-stone-400">说明</dt>
                  <dd className="text-stone-500 text-[12px] leading-5">{extra}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function StatusPill(props: { tone: BuiltinStatus['tone']; label: string }) {
  const { tone, label } = props;
  const cls =
    tone === 'ready'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
      : tone === 'warn'
        ? 'bg-amber-50 text-amber-800 border-amber-100'
        : 'bg-stone-100 text-stone-500 border-stone-200';
  return <span className={`text-[11px] px-1.5 py-0.5 rounded border ${cls}`}>{label}</span>;
}
