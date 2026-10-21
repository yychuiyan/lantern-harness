/**
 * 用例执行统计：按项目记录每一轮用例的执行情况。
 *
 * 交互约定：
 * - 「+ 添加记录」立刻生成一行并落库（空占位行也会写进 JSON），刷新后仍在；
 * - 单元格里填完即自动保存（数字停止输入 600ms 落库），没有保存 / 取消按钮，只留删除；
 * - 「当前剩余用例」「执行比例」是派生列，不落库；项目名称支持搜索或直接创建；
 * - 列表按日期倒序（最新在最上面）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  caseExecCounts,
  caseExecPercent,
  caseExecRemaining,
  createCaseExec,
  deleteCaseExec,
  fetchCaseExecHealth,
  filterCaseExec,
  formatCaseExecPercent,
  listCaseExec,
  sortCaseExec,
  toCount,
  todayIso,
  updateCaseExec,
  type CaseExecItem,
  type CaseExecPatch,
} from '../../lib/case-exec';
import { readViewText, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import { ColumnResizeHandle, useColumnWidths } from './ColumnResize';
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

const COLUMNS = [
  { key: 'select', width: 32, min: 28 },
  { key: 'index', width: 36, min: 28 },
  { key: 'date', width: 124, min: 108 },
  { key: 'project', width: 180, min: 120 },
  { key: 'start', width: 124, min: 108 },
  { key: 'end', width: 124, min: 108 },
  { key: 'total', width: 96, min: 76 },
  { key: 'pending', width: 104, min: 80 },
  { key: 'executed', width: 104, min: 80 },
  { key: 'remaining', width: 110, min: 84 },
  { key: 'ratio', width: 168, min: 132 },
  { key: 'action', width: 64, min: 56 },
] as const;

const cellInput =
  'h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-center text-sm text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white placeholder:text-stone-300 tabular-nums';

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

/** 执行比例：细进度条 + 百分比（进度条保留最小宽度，列窄也不会压成一条线） */
function RatioCell(props: { item: Pick<CaseExecItem, 'total' | 'executed'> }) {
  const percent = caseExecPercent(props.item);
  return (
    <div className="flex items-center gap-2 px-1.5">
      <div className="h-1.5 min-w-[36px] flex-1 overflow-hidden rounded-full bg-stone-200/70">
        <div
          className="h-full rounded-full bg-[#3370ff]"
          style={{ width: `${percent}%` }}
          aria-hidden="true"
        />
      </div>
      <span className="w-[52px] shrink-0 text-right text-xs text-stone-600 tabular-nums">
        {formatCaseExecPercent(props.item)}
      </span>
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
  /** 刚添加的那一行：先高亮，再把页码翻到它所在的页 */
  const [addedId, setAddedId] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<CaseExecItem[] | null>(null);

  /** 改搜索词：边输入边记住，重新进入页面仍按上次的关键词过滤 */
  function chooseKeyword(next: string) {
    writeViewText(KEYWORD_PREF, next);
    setKeywordState(next);
    setPage(1);
  }

  const aliveRef = useRef(true);
  const editingRef = useRef(false);

  const cols = useColumnWidths('lh:case-exec:cols:v1', COLUMNS);

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
  const sorted = useMemo(() => sortCaseExec(filterCaseExec(items, { keyword })), [items, keyword]);
  const counts = useMemo(() => caseExecCounts(items), [items]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sorted, currentPage, pageSize],
  );
  const selectedItems = useMemo(() => items.filter((x) => selected[x.id]), [items, selected]);
  const pageAllSelected = pageItems.length > 0 && pageItems.every((x) => selected[x.id]);

  /** 新行落库后：翻到它所在的页（先算页，再清掉标记） */
  useEffect(() => {
    if (!addedId) return;
    const idx = sorted.findIndex((x) => x.id === addedId);
    if (idx < 0) return;
    setPage(Math.floor(idx / pageSize) + 1);
    const timer = window.setTimeout(() => setAddedId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [addedId, sorted, pageSize]);

  async function addRecord() {
    if (busy) return;
    setBusy(true);
    setError(null);
    // 正在按关键字筛选时先清空，否则新行没有内容、匹配不上筛选会「看不见」
    chooseKeyword('');
    try {
      // 空占位行也先落库：刷新页面不会丢，填好项目后自动变成正式记录
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

  async function patchItem(id: string, patch: CaseExecPatch) {
    setItems((prev) => prev.map((x) => (x.id === id ? ({ ...x, ...patch } as CaseExecItem) : x)));
    try {
      const { item, projects: nextProjects } = await updateCaseExec(id, patch);
      if (!aliveRef.current) return;
      setItems((prev) => prev.map((x) => (x.id === id ? item : x)));
      if (nextProjects.length) setProjects(nextProjects);
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
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
          共 <span className="font-medium text-stone-800">{counts.records}</span> 条
          <span className="text-stone-400">
            {' '}
            · {counts.projects} 个项目 · 已执行 {counts.executed} / {counts.total} 条 · 整体执行率{' '}
            {counts.percent.toFixed(2)}%
            {selectedItems.length ? ` · 已选 ${selectedItems.length} 条` : ''}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => chooseKeyword(e.target.value)}
            placeholder="搜索项目 / 日期…"
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
            onClick={() => void addRecord()}
            className="h-9 shrink-0 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            + 添加记录
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
        className="min-h-0 flex-1 overflow-auto"
        onFocusCapture={() => {
          editingRef.current = true;
        }}
        onBlurCapture={() => {
          window.setTimeout(() => {
            editingRef.current = Boolean(document.activeElement?.closest('.tw-data-table'));
          }, 0);
        }}
      >
        <table
          className="tw-data-table w-full table-fixed border-collapse text-sm"
          style={cols.tableStyle}
        >
          <colgroup>
            {COLUMNS.map((c) => (
              <col
                key={c.key}
                style={cols.widthOf(c.key) ? { width: cols.widthOf(c.key) } : undefined}
              />
            ))}
          </colgroup>
          <thead className="tw-table-head sticky top-0 z-10 text-xs text-stone-500">
            <tr>
              <th className="px-2 py-2 text-left font-medium">
                <input
                  type="checkbox"
                  aria-label="全选本页记录"
                  checked={pageAllSelected}
                  disabled={pageItems.length === 0}
                  onChange={(e) => {
                    const value = e.target.checked;
                    setSelected((prev) => {
                      const next = { ...prev };
                      for (const item of pageItems) {
                        if (value) next[item.id] = true;
                        else delete next[item.id];
                      }
                      return next;
                    });
                  }}
                />
              </th>
              <th className="px-1 py-2 text-left font-medium" aria-label="行号" />
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                当前日期
                <ColumnResizeHandle {...cols.resizeProps(2)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                项目名称
                <ColumnResizeHandle {...cols.resizeProps(3)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                开始日期
                <ColumnResizeHandle {...cols.resizeProps(4)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                结束日期
                <ColumnResizeHandle {...cols.resizeProps(5)} />
              </th>
              <th className="relative px-2 py-2 text-center font-medium whitespace-nowrap">
                用例总数
                <ColumnResizeHandle {...cols.resizeProps(6)} />
              </th>
              <th className="relative px-2 py-2 text-center font-medium whitespace-nowrap">
                待执行用例
                <ColumnResizeHandle {...cols.resizeProps(7)} />
              </th>
              <th className="relative px-2 py-2 text-center font-medium whitespace-nowrap">
                已执行用例
                <ColumnResizeHandle {...cols.resizeProps(8)} />
              </th>
              <th className="relative px-2 py-2 text-center font-medium whitespace-nowrap">
                当前剩余用例
                <ColumnResizeHandle {...cols.resizeProps(9)} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                执行比例
                <ColumnResizeHandle {...cols.resizeProps(10)} />
              </th>
              <th className="px-1 py-2 text-center font-medium whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr className="border-t border-stone-100">
                <td colSpan={12} className="px-4 py-14 text-center text-sm text-stone-400">
                  还没有用例执行统计记录，点右上角「+ 添加记录」开始。
                </td>
              </tr>
            ) : null}

            {pageItems.map((item, index) => (
              <tr
                key={item.id}
                className={`group/row border-t border-stone-100 ${
                  item.id === addedId ? 'tw-new-row' : 'hover:bg-[#f7f8fa]'
                }`}
              >
                <td className="px-2 py-1 align-middle">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${item.project} ${item.date}`}
                    checked={Boolean(selected[item.id])}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = { ...prev };
                        if (e.target.checked) next[item.id] = true;
                        else delete next[item.id];
                        return next;
                      })
                    }
                  />
                </td>
                <td className="px-1 py-1 align-middle text-xs text-stone-400 tabular-nums">
                  {(currentPage - 1) * pageSize + index + 1}
                </td>
                <td className="px-1 py-1 align-middle">
                  <DatePicker
                    value={item.date}
                    onChange={(value) => void patchItem(item.id, { date: value })}
                    placeholder="选择日期"
                    className="h-8 w-full rounded-md border border-transparent px-1.5 text-sm text-stone-800 tabular-nums transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <SingleTagSelect
                    compact
                    ariaLabel="项目名称"
                    options={projects}
                    value={item.project}
                    onChange={(value) => void patchItem(item.id, { project: value })}
                    placeholder="查找或创建选项"
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <DatePicker
                    value={item.startDate}
                    onChange={(value) => void patchItem(item.id, { startDate: value })}
                    placeholder="开始日期"
                    className="h-8 w-full rounded-md border border-transparent px-1.5 text-sm text-stone-800 tabular-nums transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <DatePicker
                    value={item.endDate}
                    onChange={(value) => void patchItem(item.id, { endDate: value })}
                    placeholder="结束日期"
                    className="h-8 w-full rounded-md border border-transparent px-1.5 text-sm text-stone-800 tabular-nums transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <NumberCell
                    value={item.total}
                    ariaLabel="用例总数"
                    onCommit={(value) => void patchItem(item.id, { total: value })}
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <NumberCell
                    value={item.pending}
                    ariaLabel="待执行用例"
                    onCommit={(value) => void patchItem(item.id, { pending: value })}
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <NumberCell
                    value={item.executed}
                    ariaLabel="已执行用例"
                    onCommit={(value) => void patchItem(item.id, { executed: value })}
                  />
                </td>
                <td className="px-2 py-1 text-center align-middle text-xs text-stone-500 tabular-nums">
                  {caseExecRemaining(item)}
                </td>
                <td className="px-1 py-1 align-middle">
                  <RatioCell item={item} />
                </td>
                <td className="px-1 py-1 text-center align-middle">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDeleteTarget([item])}
                    aria-label={`删除 ${item.project} ${item.date}`}
                    className="rounded p-1 text-stone-300 transition-colors hover:bg-red-50 hover:text-red-600 focus:text-red-600 disabled:opacity-40"
                  >
                    {DELETE_ICON}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length > 0 ? (
        <DocsPager
          page={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          busy={busy}
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
    </section>
  );
}
