/**
 * 用例执行统计：每个项目一张卡片——卡头是「项目 + 周期 + 累计进度」，卡内是按统计日期
 * 排列的小表。项目（含开始 / 结束日期）与统计日期是一对多：一个项目只有一个周期。
 *
 * 交互约定：
 * - 「+ 添加项目」立刻生成一张空卡片并落库（空占位行也会写进 JSON），刷新后仍在；
 * - 卡头「添加统计」在同一个项目下追加一条统计（周期自动沿用整组）；
 * - 卡头改开始 / 结束日期会写穿该项目全部记录；
 * - 单元格里填完即自动保存（数字停止输入 600ms 落库），没有保存 / 取消按钮，只留删除；
 * - 填完「用例总数」「待执行用例」后，「已执行用例」「当前剩余用例」「执行比例」全部自动算；
 *   已执行是只读派生列（= 总数 − 待执行），历史数据没写过已执行也会直接显示正确值；
 * - 执行比例按项目累计口径：分母是该项目的基线（第一条记录的用例总数），
 *   卡头与行内「已执行 x / 基线」都是这个累计值；
 * - 项目名称支持搜索或直接创建；卡片按最新统计日期倒序（最新的最上面），默认全部展开，
 *   点卡头任意空白处或箭头可折叠 / 展开（只在本次页面停留期间有效）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  caseExecCounts,
  caseExecCumulativeExecuted,
  caseExecExecuted,
  caseExecPercent,
  caseExecRemaining,
  caseExecResolveExecuted,
  countCaseExecByProject,
  createCaseExec,
  deleteCaseExec,
  deleteCaseExecProject,
  fetchCaseExecHealth,
  formatCaseExecPercent,
  groupCaseExec,
  listCaseExec,
  renameCaseExecProject,
  toCount,
  todayIso,
  updateCaseExec,
  updateCaseExecCycle,
  type CaseExecGroup,
  type CaseExecItem,
  type CaseExecNumbers,
  type CaseExecPatch,
} from '../../lib/case-exec';
import { readViewText, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import DatePicker from './DatePicker';
import DocsPager, { usePageSize } from './DocsPager';
import { SingleTagSelect } from './TagSelect';
import { showToast } from './Toast';

const POLL_MS = 8000;
/** 数字输入停止多久自动落库 */
const SAVE_DELAY_MS = 600;
const DEFAULT_PAGE_SIZE = 20;
/** 每页条数单独记一个键，不跟文档库共用 */
const PAGE_SIZE_KEY = 'tw.case-exec.page-size.v1';
/** 搜索词记忆键：重新进入页面仍按上次的关键词过滤 */
const KEYWORD_PREF = 'case-exec.search';

/** 卡内小表列宽（百分比，合计 100） */
const CARD_COLS = [
  { key: 'select', width: '6%' },
  { key: 'date', width: '20%' },
  { key: 'total', width: '12%' },
  { key: 'pending', width: '12%' },
  { key: 'executed', width: '12%' },
  { key: 'remaining', width: '12%' },
  { key: 'ratio', width: '20%' },
  { key: 'action', width: '6%' },
] as const;

const cellInput =
  'h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-center text-sm text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white placeholder:text-stone-300 tabular-nums';

const cellDate =
  'h-8 w-full rounded-md border border-transparent px-1.5 text-sm text-stone-800 tabular-nums transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white';

const HEAD_BTN =
  'h-7 shrink-0 rounded-md border bg-white px-2 text-xs font-medium whitespace-nowrap disabled:opacity-40';

const DELETE_ICON = (
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
);

const CHEVRON_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/** 数字格：输入过程中保留字符串，停止输入 600ms 或失焦时自动落库 */
function NumberCell(props: {
  value: number;
  ariaLabel: string;
  placeholder?: string;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(props.value ? String(props.value) : '');
  /** 已经（或正在）落库的值：用来判断要不要触发一次保存 */
  const committedRef = useRef(props.value);
  const onCommitRef = useRef(props.onCommit);
  onCommitRef.current = props.onCommit;

  // 外部值变化（刷新 / 别的窗口改了）时同步到输入框
  useEffect(() => {
    if (props.value === committedRef.current) return;
    committedRef.current = props.value;
    setText(props.value ? String(props.value) : '');
  }, [props.value]);

  // 停止输入自动保存（值没变就不发请求）
  useEffect(() => {
    const next = text ? toCount(text) : 0;
    if (next === committedRef.current) return;
    const timer = window.setTimeout(() => {
      committedRef.current = next;
      onCommitRef.current(next);
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  function commitNow() {
    const next = text ? toCount(text) : 0;
    if (next === committedRef.current) return;
    committedRef.current = next;
    onCommitRef.current(next);
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={props.ariaLabel}
      value={text}
      placeholder={props.placeholder ?? '0'}
      onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={commitNow}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committedRef.current = props.value;
          setText(props.value ? String(props.value) : '');
          e.currentTarget.blur();
        }
      }}
      className={cellInput}
    />
  );
}

/** 完成度配色：≥80 蓝 / ≥40 橙 / 其余灰（卡头、行内比例、进度条共用） */
function ratioTone(percent: number) {
  return percent >= 80
    ? { text: 'text-[#4176e6]', bar: 'bg-[#3370ff]' }
    : percent >= 40
      ? { text: 'text-[#a85b00]', bar: 'bg-[#f5a524]' }
      : { text: 'text-stone-500', bar: 'bg-stone-400' };
}

/** 执行比例：上行「百分比 + 已执行 / 基线」，下行全宽细条（都按完成度分档着色） */
function RatioCell(props: { item: CaseExecNumbers; baseline: number }) {
  const percent = caseExecPercent(props.item, props.baseline);
  const label = formatCaseExecPercent(props.item, props.baseline);
  const executed = caseExecCumulativeExecuted(props.item, props.baseline);
  const tone = ratioTone(percent);
  return (
    <div className="flex flex-col justify-center gap-1.5 px-1.5">
      <div className="flex items-baseline justify-between gap-1.5">
        <span
          className={`shrink-0 text-[13px] font-semibold leading-none tabular-nums ${tone.text}`}
        >
          {label}
        </span>
        <span className="min-w-0 truncate text-right text-[10px] leading-none text-stone-400 tabular-nums">
          已执行 {executed} / {props.baseline}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-stone-200/70">
        <div
          className={`h-full rounded-full ${tone.bar}`}
          style={{ width: `${percent}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

export default function CaseExecBoard() {
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  const [live, setLive] = useState<boolean | null>(null);
  const [items, setItems] = useState<CaseExecItem[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyword, setKeywordState] = useState(() => readViewText(KEYWORD_PREF));
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(DEFAULT_PAGE_SIZE, PAGE_SIZE_KEY);
  /** 刚添加的那一行：先高亮，再把页码翻到它所在的卡片 */
  const [addedId, setAddedId] = useState<string | null>(null);
  /** 折叠的项目卡片：只在本次会话里记忆，进入页面默认全部展开 */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [deleteTarget, setDeleteTarget] = useState<CaseExecItem[] | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<CaseExecGroup | null>(null);

  /** 改搜索词：边输入边记住，重新进入页面仍按上次的关键词过滤 */
  function chooseKeyword(next: string) {
    writeViewText(KEYWORD_PREF, next);
    setKeywordState(next);
    setPage(1);
  }

  const aliveRef = useRef(true);
  const editingRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await listCaseExec();
      if (!aliveRef.current) return;
      setItems(data.items);
      setProjects(data.projects);
      setSelected((prev) => {
        const ids = new Set(data.items.map((x) => x.id));
        let changed = false;
        const next: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(prev)) {
          if (!value) continue;
          if (ids.has(key)) next[key] = true;
          else changed = true;
        }
        return changed ? next : prev;
      });
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => setPluginOn(Boolean(map.caseExec)));
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('caseExec'));
      setPluginReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchCaseExecHealth();
      if (!aliveRef.current) return;
      if (!ok) {
        setLive(false);
        return;
      }
      // 目录与数据文件在真正落库时才创建：只是打开插件 / 进入页面不铺空目录
      await refresh();
      if (aliveRef.current) setLive(true);
    })();
  }, [pluginReady, pluginOn, refresh]);

  useEffect(() => {
    if (live !== true) return;
    const timer = window.setInterval(() => {
      if (!editingRef.current) void refresh();
    }, POLL_MS);
    const onFocus = () => {
      if (!editingRef.current) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [live, refresh]);

  const today = todayIso();
  const counts = useMemo(() => caseExecCounts(items), [items]);
  const groups = useMemo(() => groupCaseExec(items, { keyword }), [items, keyword]);

  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageGroups = useMemo(
    () => groups.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [groups, currentPage, pageSize],
  );
  /** 当前页所有已展开卡片里的行：全选 / 批量删除按这些走 */
  const pageItems = useMemo(
    () => pageGroups.flatMap((g) => (collapsed[g.key] ? [] : g.items)),
    [pageGroups, collapsed],
  );
  const selectedItems = useMemo(() => items.filter((x) => selected[x.id]), [items, selected]);
  const pageAllSelected = pageItems.length > 0 && pageItems.every((x) => selected[x.id]);

  /** 折叠 / 展开一张卡片（点卡头任意空白处或箭头都能切换） */
  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }

  function expandGroup(key: string) {
    setCollapsed((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function selectMany(ids: string[], value: boolean) {
    setSelected((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        if (value) next[id] = true;
        else delete next[id];
      }
      return next;
    });
  }

  /** 卡片里的全部记录（关键词筛选时 group.items 只是命中的子集，操作要按整组来） */
  function groupRecordIds(group: CaseExecGroup): string[] {
    if (!group.project) {
      const only = group.items[0];
      return only ? [only.id] : [];
    }
    return items.filter((x) => x.project === group.project).map((x) => x.id);
  }

  /** 新行落库后：展开它所在的卡片，并翻到那一页（先算页，再清掉标记） */
  useEffect(() => {
    if (!addedId) return;
    const idx = groups.findIndex((g) => g.items.some((x) => x.id === addedId));
    if (idx < 0) return;
    setPage(Math.floor(idx / pageSize) + 1);
    const timer = window.setTimeout(() => setAddedId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [addedId, groups, pageSize]);

  /** 「+ 添加项目」：先落一个空占位行，填好项目名称后自动变成正式记录 */
  async function addProject() {
    if (busy) return;
    setBusy(true);
    setError(null);
    // 正在按关键字筛选时先清空，否则新行没有内容、匹配不上筛选会「看不见」
    chooseKeyword('');
    try {
      const created = await createCaseExec(
        [{ date: today, project: '', startDate: today, endDate: today }],
        { mode: 'manual' },
      );
      if (!aliveRef.current) return;
      const item = created.items[0];
      if (created.projects.length) setProjects(created.projects);
      await refresh();
      if (!aliveRef.current || !item) return;
      setAddedId(item.id);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  /** 卡内「添加统计」：同项目下补一条统计，周期沿用整组 */
  async function addStatDate(group: CaseExecGroup) {
    if (busy || !group.project) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createCaseExec(
        [
          {
            date: today,
            project: group.project,
            startDate: group.startDate,
            endDate: group.endDate,
          },
        ],
        { mode: 'manual' },
      );
      if (!aliveRef.current) return;
      const item = created.items[0];
      if (created.projects.length) setProjects(created.projects);
      expandGroup(group.key);
      await refresh();
      if (!aliveRef.current || !item) return;
      setAddedId(item.id);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function patchItem(id: string, patch: CaseExecPatch) {
    setItems((prev) => prev.map((x) => (x.id === id ? ({ ...x, ...patch } as CaseExecItem) : x)));
    try {
      const { item, projects: nextProjects } = await updateCaseExec(id, patch);
      if (!aliveRef.current) return;
      setItems((prev) => prev.map((x) => (x.id === id ? item : x)));
      // 选项列表整份覆盖：改名 / 删除后即使只剩空列表也要同步
      setProjects(nextProjects);
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    }
  }

  /**
   * 改整组的开始 / 结束日期：一个项目只有一个周期，服务端一次性写穿该项目全部记录，
   * 避免逐条 PUT 互相覆盖。占位卡片（还没命名）只有一行，直接改那一行。
   */
  function commitCycle(group: CaseExecGroup, patch: { startDate?: string; endDate?: string }) {
    const startDate = patch.startDate ?? group.startDate;
    const endDate = patch.endDate ?? group.endDate;
    if (startDate && endDate && endDate < startDate) {
      showToast('结束日期不能早于开始日期', 'error');
      return;
    }
    if (!group.project) {
      const only = group.items[0];
      if (only) void patchItem(only.id, patch);
      return;
    }
    const name = group.project;
    setItems((prev) =>
      prev.map((x) => (x.project === name ? ({ ...x, startDate, endDate } as CaseExecItem) : x)),
    );
    void (async () => {
      try {
        // 两端一起发：避免服务端用某条老记录的另一个日期兜底，导致整组不一致
        const result = await updateCaseExecCycle(name, { startDate, endDate });
        if (!aliveRef.current) return;
        setItems(result.items);
        setProjects(result.projects);
        setError(null);
      } catch (e) {
        if (!aliveRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        showToast(`修改周期失败：${e instanceof Error ? e.message : String(e)}`, 'error');
        await refresh();
      }
    })();
  }

  /**
   * 卡头改项目名称：占位卡片直接补上项目名；已命名的整组并到新名称里
   * （服务端按「重命名」处理：选项列表与记录一起改，同名时合并）。
   */
  function commitProject(group: CaseExecGroup, value: string) {
    const name = value.trim();
    if (!name || name === group.project) return;
    if (!group.project) {
      const only = group.items[0];
      if (only) void patchItem(only.id, { project: name });
      return;
    }
    void renameProject(group.project, name);
  }

  /**
   * 填完用例总数 / 待执行用例后自动算已执行用例（= 用例总数 − 待执行用例），
   * 当前剩余用例与执行比例随之更新。
   */
  function commitTotal(item: CaseExecItem, total: number) {
    // 待执行还没填时先不动已执行，避免只填总数就先跳成 100%
    if (item.pending > 0) {
      void patchItem(item.id, { total, executed: caseExecExecuted(total, item.pending) });
      return;
    }
    void patchItem(item.id, { total });
  }

  function commitPending(item: CaseExecItem, pending: number) {
    void patchItem(item.id, { pending, executed: caseExecExecuted(item.total, pending) });
  }

  /** 重命名项目名称：同步改掉引用它的记录（后端一并处理），再刷新列表 */
  async function renameProject(from: string, to: string) {
    const name = to.trim();
    if (!name || name === from) return;
    try {
      const result = await renameCaseExecProject(from, name);
      if (!aliveRef.current) return;
      setItems(result.items);
      setProjects(result.projects);
      setError(null);
      showToast(
        result.replaced > 0 ? `已重命名，同步了 ${result.replaced} 条记录` : '已重命名项目名称',
        'success',
      );
    } catch (e) {
      if (!aliveRef.current) return;
      showToast(`重命名失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  /** 删除项目名称：还有记录在用就拦下来，提示先改记录 */
  async function removeProject(name: string) {
    const inUse = countCaseExecByProject(items, name);
    if (inUse > 0) {
      showToast(`还有 ${inUse} 条记录在用「${name}」，先改掉再删除`, 'error');
      return;
    }
    try {
      const result = await deleteCaseExecProject(name);
      if (!aliveRef.current) return;
      setItems(result.items);
      setProjects(result.projects);
      setError(null);
      showToast(`已删除项目名称「${name}」`, 'success');
    } catch (e) {
      if (!aliveRef.current) return;
      showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target || target.length === 0) return;
    setDeleteTarget(null);
    setBusy(true);
    try {
      await deleteCaseExec(target.map((x) => x.id));
      if (!aliveRef.current) return;
      setSelected({});
      setError(null);
      await refresh();
      showToast(
        target.length > 1 ? `已删除 ${target.length} 条执行记录` : '已删除执行记录',
        'success',
      );
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除失败：${msg}`, 'error');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  /** 删除整张卡片：把该项目的全部统计记录删掉（项目名称仍留在下拉里） */
  async function confirmDeleteGroup() {
    const group = deleteGroup;
    if (!group) return;
    setDeleteGroup(null);
    const ids = groupRecordIds(group);
    if (!ids.length) return;
    setBusy(true);
    try {
      await deleteCaseExec(ids);
      if (!aliveRef.current) return;
      selectMany(ids, false);
      setError(null);
      await refresh();
      showToast(
        group.project
          ? `已删除「${group.project}」的 ${ids.length} 条统计`
          : `已删除 ${ids.length} 条执行记录`,
        'success',
      );
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除失败：${msg}`, 'error');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  if (!pluginReady) {
    return (
      <div
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white"
        aria-busy="true"
        aria-label="正在读取插件开关"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <span className="tw-lib-spin" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!pluginOn) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        {pluginDisabledMessage('caseExec')}
      </div>
    );
  }

  if (live === null) {
    return (
      <div
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white"
        aria-busy="true"
        aria-label="正在连接用例执行统计服务"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <span className="tw-lib-spin" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!live) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        用例执行统计需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-stone-100 px-4 py-3">
        <div className="text-sm text-stone-600">
          共 <span className="font-medium text-stone-800">{counts.records}</span> 条统计
          <span className="text-stone-400">
            {' '}
            · {counts.projects} 个项目 · 已执行 {counts.executed} / {counts.baseline} 个用例 ·
            整体执行率 {counts.percent.toFixed(2)}%
            {selectedItems.length ? ` · 已选 ${selectedItems.length} 条` : ''}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm text-stone-600">
            <input
              type="checkbox"
              aria-label="全选本页记录"
              checked={pageAllSelected}
              disabled={pageItems.length === 0}
              onChange={(e) =>
                selectMany(
                  pageItems.map((x) => x.id),
                  e.target.checked,
                )
              }
            />
            全选本页
          </label>
          <input
            value={keyword}
            onChange={(e) => chooseKeyword(e.target.value)}
            placeholder="搜索项目 / 统计日期…"
            className="h-9 w-44 rounded-lg border border-stone-200 px-3 text-sm text-stone-800 outline-none focus:border-[#3370ff]"
          />
          <button
            type="button"
            disabled={busy || selectedItems.length === 0}
            onClick={() => setDeleteTarget(selectedItems)}
            className="h-9 shrink-0 rounded-lg border border-red-200 px-3 text-sm font-medium whitespace-nowrap text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void addProject()}
            className="h-9 shrink-0 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            + 添加项目
          </button>
        </div>
      </div>

      {error ? (
        <div className="mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="关闭"
            className="-mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-red-700/70 hover:bg-red-100 hover:text-red-900"
          >
            ✕
          </button>
        </div>
      ) : null}

      <div
        data-case-exec
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        onFocusCapture={() => {
          editingRef.current = true;
        }}
        onBlurCapture={() => {
          window.setTimeout(() => {
            editingRef.current = Boolean(document.activeElement?.closest('[data-case-exec]'));
          }, 0);
        }}
      >
        {groups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-200 px-4 py-14 text-center text-sm text-stone-400">
            还没有用例执行统计记录，点右上角「+ 添加项目」开始。
          </div>
        ) : null}

        {pageGroups.map((group) => {
          const ids = groupRecordIds(group);
          return (
            <ProjectCard
              key={group.key}
              group={group}
              collapsed={Boolean(collapsed[group.key])}
              groupSelected={ids.length > 0 && ids.every((id) => Boolean(selected[id]))}
              recordCount={ids.length}
              projects={projects}
              addedId={addedId}
              selected={selected}
              busy={busy}
              onToggle={() => toggleGroup(group.key)}
              onToggleGroupSelect={(value) => selectMany(ids, value)}
              onToggleRow={(id, value) => selectMany([id], value)}
              onCommitProject={(value) => commitProject(group, value)}
              onRenameProject={(from, to) => void renameProject(from, to)}
              onRemoveProject={(name) => void removeProject(name)}
              onCommitCycle={(patch) => commitCycle(group, patch)}
              onAddStatDate={() => void addStatDate(group)}
              onDeleteGroup={() => setDeleteGroup(group)}
              onPatch={patchItem}
              onCommitTotal={commitTotal}
              onCommitPending={commitPending}
              onDeleteRow={(item) => setDeleteTarget([item])}
            />
          );
        })}
      </div>

      {groups.length > 0 ? (
        <DocsPager
          page={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          busy={busy}
          unit="个项目"
          onPage={setPage}
          onPageSize={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      ) : (
        <div className="pb-1" />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除用例执行统计"
        message={
          deleteTarget && deleteTarget.length > 1
            ? `确定删除选中的 ${deleteTarget.length} 条记录吗？删除后不可恢复。`
            : `确定删除「${deleteTarget?.[0]?.project ?? ''} ${deleteTarget?.[0]?.date ?? ''}」这条记录吗？删除后不可恢复。`
        }
        confirmLabel="删除"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={deleteGroup !== null}
        title="删除整个项目的统计"
        message={
          deleteGroup?.project
            ? `确定删除「${deleteGroup.project}」的全部 ${groupRecordIds(deleteGroup).length} 条统计吗？删除后不可恢复（项目名称仍保留在下拉里）。`
            : '确定删除这条占位记录吗？删除后不可恢复。'
        }
        confirmLabel="删除整组"
        danger
        onClose={() => setDeleteGroup(null)}
        onConfirm={() => void confirmDeleteGroup()}
      />
    </section>
  );
}

/** 一个项目卡片：卡头（项目 + 周期 + 累计进度 + 操作）+ 统计日期小表 */
function ProjectCard(props: {
  group: CaseExecGroup;
  collapsed: boolean;
  groupSelected: boolean;
  /** 该项目的全部统计条数（关键词筛选时也要按整组算） */
  recordCount: number;
  projects: string[];
  addedId: string | null;
  selected: Record<string, boolean>;
  busy: boolean;
  onToggle: () => void;
  onToggleGroupSelect: (value: boolean) => void;
  onToggleRow: (id: string, value: boolean) => void;
  onCommitProject: (value: string) => void;
  onRenameProject: (from: string, to: string) => void;
  onRemoveProject: (name: string) => void;
  onCommitCycle: (patch: { startDate?: string; endDate?: string }) => void;
  onAddStatDate: () => void;
  onDeleteGroup: () => void;
  onPatch: (id: string, patch: CaseExecPatch) => void;
  onCommitTotal: (item: CaseExecItem, total: number) => void;
  onCommitPending: (item: CaseExecItem, pending: number) => void;
  onDeleteRow: (item: CaseExecItem) => void;
}) {
  const { group } = props;
  const tone = ratioTone(group.percent);
  return (
    <article className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div
        onClick={(e) => {
          // 点卡头任意空白处都能展开 / 收起；点到勾选框、项目下拉、日期、按钮时不触发
          const target = e.target as HTMLElement;
          if (
            target.closest(
              'button, input, a, select, textarea, label, [role="button"], [role="combobox"]',
            )
          )
            return;
          if (window.getSelection()?.toString()) return;
          props.onToggle();
        }}
        className="cursor-pointer border-b border-stone-100 bg-[#fbfbfc] px-3 py-2"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <input
            type="checkbox"
            aria-label={`选择项目 ${group.project || '未命名'}`}
            checked={props.groupSelected}
            disabled={props.recordCount === 0}
            onChange={(e) => props.onToggleGroupSelect(e.target.checked)}
          />
          <button
            type="button"
            aria-expanded={!props.collapsed}
            aria-label={`${props.collapsed ? '展开' : '收起'} ${group.project || '未命名项目'}`}
            onClick={props.onToggle}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-200/70 hover:text-stone-700"
          >
            <span
              className={`transition-transform ${props.collapsed ? '-rotate-90' : ''}`}
              aria-hidden="true"
            >
              {CHEVRON_ICON}
            </span>
          </button>
          <div className="w-52 shrink-0">
            <SingleTagSelect
              compact
              ariaLabel="项目名称"
              options={props.projects}
              value={group.project}
              onChange={props.onCommitProject}
              onRenameOption={props.onRenameProject}
              onDeleteOption={props.onRemoveProject}
              placeholder="选择或创建项目"
            />
          </div>

          {group.draft ? (
            <span className="text-xs text-stone-400">
              选好项目名称后就能在这条项目下按统计日期记录
            </span>
          ) : (
            <>
              <div className="w-28 shrink-0">
                <DatePicker
                  value={group.startDate}
                  onChange={(value) => props.onCommitCycle({ startDate: value })}
                  placeholder="开始日期"
                  className={cellDate}
                />
              </div>
              <span className="text-xs text-stone-400" aria-hidden="true">
                ~
              </span>
              <div className="w-28 shrink-0">
                <DatePicker
                  value={group.endDate}
                  onChange={(value) => props.onCommitCycle({ endDate: value })}
                  placeholder="结束日期"
                  className={cellDate}
                />
              </div>
            </>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <span className="mr-1 whitespace-nowrap text-xs text-stone-400 tabular-nums">
              {props.recordCount} 条统计
            </span>
            {group.draft ? null : (
              <button
                type="button"
                disabled={props.busy}
                onClick={props.onAddStatDate}
                className={`${HEAD_BTN} border-stone-200 text-stone-700 hover:border-[#3370ff] hover:text-[#3370ff]`}
              >
                添加统计
              </button>
            )}
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onDeleteGroup}
              className={`${HEAD_BTN} border-red-200 text-red-600 hover:bg-red-50`}
            >
              删除整组
            </button>
          </div>
        </div>

        {group.draft ? null : (
          <div className="mt-2">
            <div className="flex items-baseline justify-between gap-3 text-xs text-stone-500 tabular-nums">
              <span className="min-w-0 truncate">
                基线 <span className="font-medium text-stone-700">{group.baseline}</span>
                <span className="mx-1.5 text-stone-300">·</span>
                已执行{' '}
                <span className="font-medium text-stone-700">
                  {group.executed} / {group.baseline}
                </span>
              </span>
              <span className={`shrink-0 text-[13px] font-semibold ${tone.text}`}>
                {group.percent.toFixed(2)}%
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-stone-200/70">
              <div
                className={`h-full rounded-full ${tone.bar}`}
                style={{ width: `${group.percent}%` }}
                aria-hidden="true"
              />
            </div>
          </div>
        )}
      </div>

      {/* 卡内小表：展开 / 收起走同一条高度 + 淡入淡出过渡，不做硬切 */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          props.collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
        }`}
        aria-hidden={props.collapsed}
      >
        <div className="min-h-0 overflow-hidden" inert={props.collapsed}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] table-fixed text-sm">
              <colgroup>
                {CARD_COLS.map((c) => (
                  <col key={c.key} style={{ width: c.width }} />
                ))}
              </colgroup>
              <thead className="bg-stone-50 text-xs text-stone-500">
                <tr>
                  <th className="px-2 py-2 text-left font-medium" aria-label="选择" />
                  <th className="px-2 py-2 text-left font-medium whitespace-nowrap">统计日期</th>
                  <th className="px-2 py-2 text-center font-medium whitespace-nowrap">用例总数</th>
                  <th className="px-2 py-2 text-center font-medium whitespace-nowrap">
                    待执行用例
                  </th>
                  <th
                    className="px-2 py-2 text-center font-medium whitespace-nowrap"
                    title="自动计算：用例总数 − 待执行用例"
                  >
                    已执行用例
                  </th>
                  <th className="px-2 py-2 text-center font-medium whitespace-nowrap">
                    当前剩余用例
                  </th>
                  <th className="px-2 py-2 text-left font-medium whitespace-nowrap">执行比例</th>
                  <th className="px-2 py-2 text-center font-medium whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((item) => (
                  <tr
                    key={item.id}
                    className={`border-t border-stone-100 first:border-t-0 ${
                      item.id === props.addedId ? 'bg-[#f2f6ff]' : 'hover:bg-[#f7f8fa]'
                    }`}
                  >
                    <td className="px-2 py-1 align-middle">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${group.project} ${item.date}`}
                        checked={Boolean(props.selected[item.id])}
                        onChange={(e) => props.onToggleRow(item.id, e.target.checked)}
                      />
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <DatePicker
                        value={item.date}
                        onChange={(value) => props.onPatch(item.id, { date: value })}
                        placeholder="选择日期"
                        className={cellDate}
                      />
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <NumberCell
                        value={item.total}
                        ariaLabel="用例总数"
                        onCommit={(value) => props.onCommitTotal(item, value)}
                      />
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <NumberCell
                        value={item.pending}
                        ariaLabel="待执行用例"
                        onCommit={(value) => props.onCommitPending(item, value)}
                      />
                    </td>
                    <td
                      className="px-2 py-1 text-center align-middle text-sm text-stone-800 tabular-nums"
                      title="自动计算：用例总数 − 待执行用例"
                    >
                      {caseExecResolveExecuted(item)}
                    </td>
                    <td className="px-2 py-1 text-center align-middle text-xs text-stone-500 tabular-nums">
                      {caseExecRemaining(item)}
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <RatioCell item={item} baseline={group.baseline || item.total} />
                    </td>
                    <td className="px-2 py-1 text-center align-middle">
                      <button
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onDeleteRow(item)}
                        aria-label={`删除 ${group.project} ${item.date} 的记录`}
                        className="tw-icon-danger rounded p-1"
                      >
                        {DELETE_ICON}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </article>
  );
}
