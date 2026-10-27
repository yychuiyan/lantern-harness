/**
 * 测试统计：按「统计日期 + 测试统计维度」记录每天的数量。
 *
 * 交互约定：
 * - 「+ 添加记录」立刻生成一行并落库（空占位行也会写进 JSON），刷新后仍在；
 * - 单元格里填完即自动保存（数量停止输入 600ms 落库），没有保存 / 取消按钮，只留删除；
 * - 维度是单选彩色胶囊，支持在下拉里搜索或直接创建，也可重命名 / 删除未被引用的维度；
 *   下拉按维度创建时间倒序（最新创建的在最上面）；
 * - 列表按日期倒序（最新在最上面）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  countTestStatsByDimension,
  createTestStats,
  deleteTestStats,
  deleteTestStatsDimension,
  fetchTestStatsHealth,
  filterTestStats,
  listTestStats,
  renameTestStatsDimension,
  sortTestStats,
  testStatsCounts,
  toCount,
  todayIso,
  updateTestStats,
  type TestStatsItem,
  type TestStatsPatch,
} from '../../lib/test-stats';
import { readViewText, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import {
  STICKY_CELL_L,
  STICKY_CELL_L_TIGHT,
  STICKY_CELL_R,
  STICKY_HEAD_L,
  STICKY_HEAD_L_RESIZE,
  STICKY_HEAD_R,
  ColumnResizeHandle,
  useColumnWidths,
  useScrollEdges,
} from './ColumnResize';
import DatePicker from './DatePicker';
import DocsPager, { usePageSize } from './DocsPager';
import { SingleTagSelect } from './TagSelect';
import { showToast } from './Toast';

const POLL_MS = 8000;
/** 数量输入停止多久自动落库 */
const SAVE_DELAY_MS = 600;
const DEFAULT_PAGE_SIZE = 20;
/** 每页条数单独记一个键，不跟文档库共用 */
const PAGE_SIZE_KEY = 'tw.test-stats.page-size.v1';
/** 搜索词记忆键：重新进入页面仍按上次的关键词过滤 */
const KEYWORD_PREF = 'test-stats.search';

const COLUMNS = [
  { key: 'select', width: 32, min: 28 },
  { key: 'date', width: 140, min: 120 },
  { key: 'dimensions', width: 320, min: 200 },
  { key: 'count', width: 120, min: 90 },
  { key: 'filler', filler: true },
  { key: 'action', width: 76, min: 64 },
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

/** 数量格：输入过程中保留字符串，停止输入 600ms 或失焦时自动落库 */
function NumberCell(props: {
  value: number;
  placeholder?: string;
  ariaLabel: string;
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

export default function TestStatsBoard() {
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  const [live, setLive] = useState<boolean | null>(null);
  const [items, setItems] = useState<TestStatsItem[]>([]);
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyword, setKeywordState] = useState(() => readViewText(KEYWORD_PREF));
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(DEFAULT_PAGE_SIZE, PAGE_SIZE_KEY);
  /** 刚添加的那一行：先高亮，再把页码翻到它所在的页 */
  const [addedId, setAddedId] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<TestStatsItem[] | null>(null);

  /** 改搜索词：边输入边记住，重新进入页面仍按上次的关键词过滤 */
  function chooseKeyword(next: string) {
    writeViewText(KEYWORD_PREF, next);
    setKeywordState(next);
    setPage(1);
  }

  const aliveRef = useRef(true);
  const editingRef = useRef(false);

  const cols = useColumnWidths('lh:test-stats:cols:v1', COLUMNS);
  const scrollRef = useScrollEdges('test-stats');

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await listTestStats();
      if (!aliveRef.current) return;
      setItems(data.items);
      setDimensions(data.dimensions);
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
    const off = onPluginEnabledChanged((map) => setPluginOn(Boolean(map.testStats)));
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('testStats'));
      setPluginReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchTestStatsHealth();
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
  const sorted = useMemo(
    () => sortTestStats(filterTestStats(items, { keyword })),
    [items, keyword],
  );
  const counts = useMemo(() => testStatsCounts(items), [items]);

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
      // 空占位行也先落库：刷新页面不会丢，填好维度后自动变成正式记录
      const created = await createTestStats([{ date: today, dimensions: [], count: 0 }], {
        mode: 'manual',
      });
      if (!aliveRef.current) return;
      const item = created.items[0];
      if (created.dimensions.length) setDimensions(created.dimensions);
      await refresh();
      if (!aliveRef.current || !item) return;
      setAddedId(item.id);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function patchItem(id: string, patch: TestStatsPatch) {
    setItems((prev) => prev.map((x) => (x.id === id ? ({ ...x, ...patch } as TestStatsItem) : x)));
    try {
      const { item, dimensions: nextDimensions } = await updateTestStats(id, patch);
      if (!aliveRef.current) return;
      setItems((prev) => prev.map((x) => (x.id === id ? item : x)));
      if (nextDimensions.length) setDimensions(nextDimensions);
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    }
  }

  /** 重命名维度：服务端把引用它的记录一起改名，返回改了几条 */
  async function renameDimension(from: string, to: string) {
    const name = to.trim();
    if (!name || name === from) return;
    try {
      const result = await renameTestStatsDimension(from, name);
      if (!aliveRef.current) return;
      setItems(result.items);
      setDimensions(result.dimensions);
      setError(null);
      showToast(
        result.replaced > 0 ? `已重命名，同步了 ${result.replaced} 条记录` : '已重命名测试统计维度',
        'success',
      );
    } catch (e) {
      if (!aliveRef.current) return;
      showToast(`重命名失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  /** 删除维度：还有记录在用就拦下来，提示先改记录 */
  async function removeDimension(name: string) {
    const inUse = countTestStatsByDimension(items, name);
    if (inUse > 0) {
      showToast(`还有 ${inUse} 条记录在用「${name}」，先改掉再删除`, 'error');
      return;
    }
    try {
      const result = await deleteTestStatsDimension(name);
      if (!aliveRef.current) return;
      setItems(result.items);
      setDimensions(result.dimensions);
      setError(null);
      showToast(`已删除测试统计维度「${name}」`, 'success');
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
      await deleteTestStats(target.map((x) => x.id));
      if (!aliveRef.current) return;
      setSelected({});
      setError(null);
      await refresh();
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
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
        {pluginDisabledMessage('testStats')}
      </div>
    );
  }

  if (live === null) {
    return (
      <div
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white"
        aria-busy="true"
        aria-label="正在连接测试统计服务"
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
        测试统计需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。
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
            · 覆盖 {counts.dimensions} 个维度 · 数量合计 {counts.total}
            {selectedItems.length ? ` · 已选 ${selectedItems.length} 条` : ''}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => chooseKeyword(e.target.value)}
            placeholder="搜索日期 / 维度…"
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
        ref={scrollRef}
        className="tw-scroll-x min-h-0 flex-1 overflow-auto"
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
          className="tw-data-table tw-sticky-table w-full table-fixed text-sm"
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
              <th className={STICKY_HEAD_L}>
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
              <th
                className={STICKY_HEAD_L_RESIZE}
                style={{ '--tw-sticky-left': '32px' } as CSSProperties}
              >
                统计日期
                <ColumnResizeHandle {...cols.resizeProps('date')} />
              </th>
              <th className="relative px-2 py-2 text-left font-medium whitespace-nowrap">
                测试统计维度
                <ColumnResizeHandle {...cols.resizeProps('dimensions')} />
              </th>
              <th className="relative px-2 py-2 text-center font-medium whitespace-nowrap">
                统计数量
                <ColumnResizeHandle {...cols.resizeProps('count')} />
              </th>
              <th aria-hidden="true" />
              <th className={STICKY_HEAD_R}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-14 text-center text-sm text-stone-400">
                  还没有测试统计记录，点右上角「+ 添加记录」开始。
                </td>
              </tr>
            ) : null}

            {pageItems.map((item) => (
              <tr
                key={item.id}
                className={`group/row ${item.id === addedId ? 'tw-new-row' : 'hover:bg-[#f7f8fa]'}`}
              >
                <td className={STICKY_CELL_L}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${item.date} ${item.dimensions.join('/')}`}
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
                <td
                  className={STICKY_CELL_L_TIGHT}
                  style={{ '--tw-sticky-left': '32px' } as CSSProperties}
                >
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
                    ariaLabel="测试统计维度"
                    options={dimensions}
                    value={item.dimensions[0] ?? ''}
                    onChange={(value) =>
                      void patchItem(item.id, { dimensions: value ? [value] : [] })
                    }
                    onRenameOption={(from, to) => void renameDimension(from, to)}
                    onDeleteOption={(name) => void removeDimension(name)}
                    placeholder="选择或创建维度"
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <NumberCell
                    value={item.count}
                    ariaLabel="统计数量"
                    onCommit={(value) => void patchItem(item.id, { count: value })}
                  />
                </td>
                <td aria-hidden="true" />
                <td className={STICKY_CELL_R}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDeleteTarget([item])}
                    aria-label={`删除 ${item.date} 的记录`}
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
        title="删除测试统计"
        message={
          deleteTarget && deleteTarget.length > 1
            ? `确定删除选中的 ${deleteTarget.length} 条记录吗？删除后不可恢复。`
            : `确定删除 ${deleteTarget?.[0]?.date ?? ''} 的这条记录吗？删除后不可恢复。`
        }
        confirmLabel="删除"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
