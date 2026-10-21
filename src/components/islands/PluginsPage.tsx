/**
 * 我的插件：只放「可配置的扩展插件」（PLUGIN_CATALOG）。
 *
 * 会话 / 全局这类平台内置能力没有开关，已经移到设置页的「内置插件」里，
 * 这里不再混着展示，避免把「不能关」的能力画成可切换的开关。
 *
 * 页面结构：标题与概览 → 搜索 / 状态筛选 → 按分类分组的插件卡片。
 * 卡片点开才展开完整信息（完整名称、配置状态、运行状态、说明），收起时只留标题与一句话。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  PLUGIN_CATALOG,
  groupPluginsByCategory,
  loadPluginEnabled,
  onPluginEnabledChanged,
  setPluginEnabled,
  type PluginId,
} from '../../lib/plugins';
import { fetchMemoryHealth, type MemoryHealth } from '../../lib/memory';
import { fetchFsHealth, type FsHealth } from '../../lib/fs-tools';
import { hydrateAppConfig } from '../../lib/settings';
import { syncReportPrompt } from '../../lib/report-prompt';
import { syncReqPrompt } from '../../lib/req-analysis';
import { syncStoryReviewPrompt } from '../../lib/story-review';
import { syncTestPointsPrompt } from '../../lib/test-points';
import { syncUiAutoPrompt } from '../../lib/ui-auto-prompt';
import { fetchTasksHealth } from '../../lib/tasks';
import { fetchTodosHealth } from '../../lib/todos';
import { fetchTestStatsHealth } from '../../lib/test-stats';
import { fetchCaseExecHealth } from '../../lib/case-exec';
import { fetchPmHealth, syncPmStore } from '../../lib/pm';
import OverflowHint from './OverflowHint';
import { showToast } from './Toast';

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

type RuntimeStatus = {
  available: boolean | null;
  detail: string;
};

type StateFilter = 'all' | 'on' | 'off';
const STATE_FILTERS: ReadonlyArray<{ id: StateFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'on', label: '已启用' },
  { id: 'off', label: '未启用' },
];

interface Props {
  /** 嵌在 AI 工作台右侧时去掉整页 min-height */
  embedded?: boolean;
}

/** 扩展插件的分类分组（静态目录，模块级算一次） */
const EXTENSION_GROUPS = groupPluginsByCategory();

export default function PluginsPage({ embedded = false }: Props) {
  const [enabled, setEnabled] = useState<Record<PluginId, boolean>>(() => loadPluginEnabled());
  const [memory, setMemory] = useState<MemoryHealth | null>(null);
  const [fs, setFs] = useState<FsHealth | null>(null);
  /** 任务 / 待办 / 项目 / 迭代 / 需求 / 缺陷 / 测试统计 / 用例执行统计的本机服务探测结果 */
  const [boards, setBoards] = useState<Record<BoardPluginId, boolean> | null>(null);
  const [probing, setProbing] = useState(true);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});

  async function refreshRuntime(): Promise<void> {
    setProbing(true);
    try {
      const [
        m,
        f,
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
        fetchFsHealth(),
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
      setFs(f);
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
      return { available: true, detail: '侧栏「用例管理」浏览与维护本空间用例库' };
    }
    if (id === 'caseGen') {
      if (!enabled.cases) {
        return { available: false, detail: '需先启用「用例管理」，生成结果才能写入用例列表' };
      }
      return { available: true, detail: '对话输入 / 打开配置面板，生成用例并写入用例库' };
    }
    if (id === 'prompts') {
      return { available: true, detail: '侧栏「提示词管理」浏览与维护本空间提示词库' };
    }
    if (id === 'promptGen') {
      if (!enabled.prompts) {
        return { available: false, detail: '需先启用「提示词管理」，生成结果才能写入提示词列表' };
      }
      return { available: true, detail: '对话输入 / 打开配置面板，生成提示词并写入提示词库' };
    }
    if (id === 'knowledgeLib') {
      return { available: true, detail: '侧栏「知识库管理」浏览与维护本空间知识库' };
    }
    if (id === 'requirements') {
      return { available: true, detail: '侧栏「需求文档库」浏览与维护本空间需求文档' };
    }
    if (id === 'templates') {
      return { available: true, detail: '侧栏「测试模板库」浏览与维护本空间用例模板' };
    }
    if (id === 'reports') {
      return { available: true, detail: '侧栏「工作汇报」按日报 / 周报 / 月报列出汇报文件' };
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
        return { available: false, detail: '需先启用「知识库管理」，生成结果才能写入知识库列表' };
      }
      return { available: true, detail: '对话输入 / 打开配置面板，生成文档并写入知识库' };
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
      return { available: true, detail: '对话输入 @ 可引用知识库与模板文档' };
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

  function toggle(id: PluginId) {
    const next = setPluginEnabled(id, !enabled[id]);
    const nowOn = Boolean(next[id]);
    const label = PLUGIN_CATALOG.find((p) => p.id === id)?.name ?? id;
    setEnabled(next);
    showToast(nowOn ? `已启用「${label}」` : `已停用「${label}」`, 'success');
    // 工作汇报是纯提示词型插件：打开即生成提示词；汇报目录等真正写入汇报文件时才出现
    if (id === 'reports') {
      void syncReportPrompt(Boolean(next.reports)).catch((e: unknown) => {
        const detail = e instanceof Error ? e.message : String(e);
        showToast(`工作汇报提示词没生成成功：${detail}`, 'error');
      });
    }
    // 自动化测试同样是提示词型插件：打开即把提示词写进「提示词管理」（已存在不覆盖）
    if (id === 'uiAuto') {
      void syncUiAutoPrompt(Boolean(next.uiAuto)).catch((e: unknown) => {
        const detail = e instanceof Error ? e.message : String(e);
        showToast(`UI自动化测试提示词没生成成功：${detail}`, 'error');
      });
    }
    // 需求分析：同样是提示词型插件，打开即把三段提示词写进「提示词管理」（已存在不覆盖）
    if (id === 'reqAnalysis') {
      void syncReqPrompt(Boolean(next.reqAnalysis)).catch((e: unknown) => {
        const detail = e instanceof Error ? e.message : String(e);
        showToast(`需求分析提示词没生成成功：${detail}`, 'error');
      });
    }
    // 用户故事审查：打开即生成「用户故事审查提示词.md」并关联（已存在不覆盖）
    if (id === 'storyReview') {
      void syncStoryReviewPrompt(Boolean(next.storyReview)).catch((e: unknown) => {
        const detail = e instanceof Error ? e.message : String(e);
        showToast(`用户故事审查提示词没生成成功：${detail}`, 'error');
      });
    }
    // 生成测试点：打开即生成「测试点生成提示词.md」并关联（已存在不覆盖）
    if (id === 'testPoints') {
      void syncTestPointsPrompt(Boolean(next.testPoints)).catch((e: unknown) => {
        const detail = e instanceof Error ? e.message : String(e);
        showToast(`测试点生成提示词没生成成功：${detail}`, 'error');
      });
    }
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

  const onCount = useMemo(() => PLUGIN_CATALOG.filter((p) => enabled[p.id]).length, [enabled]);

  const keyword = query.trim().toLowerCase();
  const groups = useMemo(() => {
    return EXTENSION_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((p) => {
        const hit =
          !keyword ||
          p.name.toLowerCase().includes(keyword) ||
          p.id.toLowerCase().includes(keyword) ||
          p.description.toLowerCase().includes(keyword);
        const stateHit =
          stateFilter === 'all' || (stateFilter === 'on' ? enabled[p.id] : !enabled[p.id]);
        return hit && stateHit;
      }),
    })).filter((g) => g.items.length > 0);
  }, [enabled, keyword, stateFilter]);

  return (
    <div
      className={`tw-plugins-page overflow-y-auto ${embedded ? 'h-full min-h-0 flex-1' : 'min-h-screen'}`}
    >
      <div className={`mx-auto w-full max-w-[1080px] ${embedded ? 'px-6 py-5' : 'px-6 py-7'}`}>
        <header className="tw-plugins-head">
          <div className="min-w-0">
            <h2 className="text-[20px] font-semibold tracking-tight text-stone-900">我的插件</h2>
            <p className="mt-1.5 text-[13px] leading-6 text-stone-500">
              按用途分组的扩展能力，开关保存在本机；会话 / 全局内置能力在
              <span className="mx-1 rounded bg-stone-100 px-1 py-0.5 text-[12px] text-stone-600">
                设置 → 内置插件
              </span>
              里查看。
            </p>
          </div>
          <div className="tw-plugins-stats" aria-label="插件概览">
            <div className="tw-plugins-stat">
              <span className="tw-plugins-stat-num">{PLUGIN_CATALOG.length}</span>
              <span className="tw-plugins-stat-label">个插件</span>
            </div>
            <div className="tw-plugins-stat">
              <span className="tw-plugins-stat-num is-on">{onCount}</span>
              <span className="tw-plugins-stat-label">已启用</span>
            </div>
            <div className="tw-plugins-stat">
              <span className="tw-plugins-stat-num">{EXTENSION_GROUPS.length}</span>
              <span className="tw-plugins-stat-label">个分类</span>
            </div>
          </div>
        </header>

        <div className="tw-plugins-toolbar">
          <label className="relative block w-full max-w-72">
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索插件名 / 作用"
              className="h-9 w-full rounded-lg border border-stone-200 bg-white pl-8 pr-3 text-[13px] text-stone-800 outline-none transition-colors placeholder:text-stone-400 focus:border-[#4176e6]"
            />
          </label>
          <div className="tw-plugins-pills" role="group" aria-label="按状态筛选">
            {STATE_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={stateFilter === f.id}
                onClick={() => setStateFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 space-y-6">
          {groups.map((g) => {
            const collapsed = Boolean(collapsedCats[g.category]);
            const catOn = g.items.filter((p) => enabled[p.id]).length;
            return (
              <section key={g.category}>
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() =>
                    setCollapsedCats((prev) => ({ ...prev, [g.category]: !collapsed }))
                  }
                  className="mb-2.5 flex w-full items-center gap-2 text-left"
                >
                  <Chevron
                    className={`h-3.5 w-3.5 shrink-0 text-stone-400 transition-transform ${
                      collapsed ? '-rotate-90' : ''
                    }`}
                  />
                  <span className="text-[13px] font-semibold text-stone-800">{g.category}</span>
                  <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[11px] tabular-nums text-stone-500">
                    {catOn}/{g.items.length}
                  </span>
                  <span className="ml-1 h-px flex-1 bg-stone-200/70" aria-hidden="true" />
                </button>
                {collapsed ? null : (
                  <ul className="tw-anim-list tw-plugin-grid">
                    {g.items.map((p) => {
                      const on = enabled[p.id];
                      const rt = runtimeFor(p.id);
                      const open = expandedId === `ext:${p.id}`;
                      return (
                        <li
                          key={p.id}
                          className={`relative z-0 min-w-0 overflow-visible hover:z-40 focus-within:z-40${
                            open ? ' z-40' : ''
                          }`}
                        >
                          <PluginExpandCard
                            open={open}
                            onToggleOpen={() => setExpandedId(open ? null : `ext:${p.id}`)}
                            title={p.name}
                            subtitle={p.description}
                            badge={
                              <span className="rounded border border-stone-200 px-1.5 py-0.5 text-[11px] tabular-nums text-stone-400">
                                v{p.version}
                              </span>
                            }
                            trailing={
                              p.alwaysOn ? (
                                <span className="rounded border border-stone-200 px-1.5 py-0.5 text-[11px] text-stone-500">
                                  内置
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={on}
                                  aria-label={`${on ? '关闭' : '打开'} ${p.name}`}
                                  onClick={() => toggle(p.id)}
                                  className="tw-toggle"
                                >
                                  <span className="tw-toggle-knob" />
                                </button>
                              )
                            }
                            fullName={`@lh-plugins/${p.id}`}
                            configLabel={p.alwaysOn ? '内置常开' : on ? '已启用' : '未启用'}
                            runLabel={on && rt.available === true ? '运行中' : '已停用'}
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
          {groups.length ? null : (
            <div className="rounded-xl border border-dashed border-stone-200 bg-white/60 px-4 py-12 text-center">
              <p className="text-sm text-stone-600">没有匹配的插件</p>
              <p className="mt-1 text-xs text-stone-400">换个关键词，或把状态筛选切回「全部」。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PluginExpandCard(props: {
  open: boolean;
  onToggleOpen: () => void;
  title: string;
  subtitle: string;
  badge?: ReactNode;
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
    subtitle,
    badge,
    trailing,
    fullName,
    configLabel,
    runLabel,
    extra,
  } = props;

  return (
    <div
      className={`tw-plugin-card group/card relative z-0 self-start w-full overflow-visible rounded-xl border bg-white transition-colors hover:z-40 focus-within:z-40 ${
        open ? 'z-40 border-[#4176e6]/50 shadow-sm' : 'border-stone-200 hover:border-stone-300'
      }`}
    >
      <div className="relative flex h-17 items-start gap-3 overflow-visible px-4 py-3">
        <button
          type="button"
          onClick={onToggleOpen}
          className="relative h-full min-w-0 flex-1 overflow-visible text-left outline-none focus:outline-none"
          aria-expanded={open}
        >
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-[14px] font-medium text-stone-900">{title}</h3>
            {badge}
            <Chevron
              className={`h-3.5 w-3.5 shrink-0 text-stone-400 transition-transform duration-300 ease-out ${
                open ? 'rotate-180' : ''
              }`}
            />
          </div>
          <OverflowHint
            text={subtitle}
            className="mt-1 block min-w-0 truncate text-[13px] leading-5 text-stone-500"
            disabled={open}
          />
        </button>
        <div className="flex shrink-0 items-center gap-2 self-start pt-0.5">{trailing}</div>
      </div>
      <div className={`tw-collapse ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <div className="tw-collapse-inner">
          <div className="border-t border-stone-100 px-4 pb-3 pt-0">
            <dl className="mt-2.5 space-y-1.5 text-[13px]">
              <div className="flex gap-2">
                <dt className="w-18 shrink-0 text-stone-400">完整名称</dt>
                <dd className="min-w-0 break-all font-mono text-[12px] text-stone-700">
                  {fullName}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-18 shrink-0 text-stone-400">配置状态</dt>
                <dd className="text-stone-700">{configLabel}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-18 shrink-0 text-stone-400">运行状态</dt>
                <dd className={runLabel === '运行中' ? 'text-emerald-600' : 'text-stone-500'}>
                  {runLabel}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-18 shrink-0 text-stone-400">简介</dt>
                <dd className="text-[12px] leading-5 text-stone-500">{subtitle}</dd>
              </div>
              {extra ? (
                <div className="flex gap-2">
                  <dt className="w-18 shrink-0 text-stone-400">说明</dt>
                  <dd className="text-[12px] leading-5 text-stone-500">{extra}</dd>
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
