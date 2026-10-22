/**
 * 文档库文件列表（搜索 + 排序 + 分页 + 表格），供知识库 / 用例 / 提示词管理复用。
 *
 * 表格结构（列宽、对齐、溢出气泡）与「知识库管理」保持一致，避免各页样式漂移。
 * 状态由调用方的 useDocsList 持有，本组件只负责渲染，便于页面头部展示匹配计数。
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { fmtSize, fmtTime } from '../../lib/docs-format';
import type { DocsEntry } from '../../lib/project-docs';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';
import {
  ColumnResizeHandle,
  useFlexColumnWidths,
  useScrollEdges,
  type ColumnSpec,
} from './ColumnResize';
import DocsPager, { usePageSize } from './DocsPager';
import OverflowHint from './OverflowHint';
import SelectDropdown from './SelectDropdown';
import { useListAnim } from './useListAnim';

export type DocsSortBy = 'mtime' | 'name';

export const DOCS_SORT_OPTIONS: ReadonlyArray<{ value: DocsSortBy; label: string }> = [
  { value: 'mtime', label: '按修改时间' },
  { value: 'name', label: '按文件名' },
];

const DOCS_SORT_VALUES = DOCS_SORT_OPTIONS.map((o) => o.value);

const TOOL_INPUT_CLS =
  'h-8 px-3 text-sm border border-stone-300 rounded-lg bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-[#4176e6]/30 focus:border-[#4176e6]';

const ROW_HOVER =
  'transition-colors duration-150 hover:bg-stone-50 hover:shadow-[inset_3px_0_0_0_var(--tw-accent)] cursor-pointer';

/** 时间列宽（表头与行共用，避免错位） */
const TIME_COL_CLS = 'w-38 shrink-0';
/** 大小列宽（表头与值共用；左对齐） */
const SIZE_COL_CLS = 'w-16 shrink-0 text-left';
/** 操作列默认宽度（在会话中打开 + 删除 两个按钮，含间距） */
const ACTIONS_WIDTH = 176;
/** 操作列的宽度下限：按实际按钮测量，太窄时兜底 */
const ACTIONS_MIN = 96;
/** 操作列左右各留这么多白：按钮不贴着卡片边缘，也不和左边「大小」挤在一起 */
const ACTIONS_PAD_SIDE = 12;
/** 操作列宽度 = 按钮实测宽 + 两侧留白 */
const ACTIONS_PAD = ACTIONS_PAD_SIDE * 2;
/** 文件名列的最小宽度：再窄就横向滚动，不把文件名压成 0 */
const NAME_MIN = 160;
/** 勾选列宽度：与表格一致（32px 列 + 居中勾选框，左右各 8px 留白） */
const CHECK_W = 32;
/** 行内列间距，和 li 上的 gap-2 一致 */
const LEFT_GAP = 8;
/** 文件名右侧附加列（评审 / 关联插件）默认宽度：要放得下「48 分 补 3 过期」 */
const EXTRA_WIDTH = 168;
/** 操作列的对齐类；宽度由实际按钮测量得到，走行内样式 */
const ACTION_COL_CLS = 'shrink-0 justify-center text-center';

/* 卡片本身已经有一圈边框，空状态不要再套一层虚线框，否则是双层框 */
const EMPTY_BOX = 'text-sm text-stone-400 py-12 text-center';

/**
 * 搜索 → 排序 → 分页（顺序固定：先在全集里筛，再切页）。
 * 每页条数取自用户偏好（usePageSize），切换档位时页码归 1。
 *
 * 传入 libraryId 时，搜索词与排序方式也会记住：刷新 / 重新进入页面、
 * 切回同一空间都还是上次的样子（各文档库分开记，互不干扰）。
 */
export function useDocsList(files: DocsEntry[], defaultPageSize: number, libraryId?: string) {
  const [query, setQueryState] = useState(() =>
    libraryId ? readViewText(`docs.${libraryId}.search`) : '',
  );
  const [sortBy, setSortByState] = useState<DocsSortBy>(() =>
    libraryId
      ? readViewPref<DocsSortBy>(`docs.${libraryId}.sort`, DOCS_SORT_VALUES, 'mtime')
      : 'mtime',
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = usePageSize(defaultPageSize);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? files.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      : files;
    const sorted = [...base];
    if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    else sorted.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return sorted;
  }, [files, query, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // 删除 / 搜索 / 改档位后页数可能变少，钳制到有效范围
  const currentPage = Math.min(page, totalPages);
  const pageFiles = useMemo(
    () => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize],
  );

  const updateQuery = (v: string) => {
    setQueryState(v);
    if (libraryId) writeViewText(`docs.${libraryId}.search`, v);
    setPage(1);
  };
  const updateSortBy = (v: DocsSortBy) => {
    setSortByState(v);
    if (libraryId) writeViewPref(`docs.${libraryId}.sort`, v);
    setPage(1);
  };
  const updatePageSize = (n: number) => {
    setPageSizeState(n);
    setPage(1);
  };

  return {
    query,
    setQuery: updateQuery,
    sortBy,
    setSortBy: updateSortBy,
    page: currentPage,
    setPage,
    pageSize,
    setPageSize: updatePageSize,
    filtered,
    totalPages,
    pageFiles,
  };
}

export default function DocsFileBrowser({
  files,
  filtered,
  pageFiles,
  query,
  onQuery,
  sortBy,
  onSortBy,
  page,
  totalPages,
  pageSize,
  onPage,
  onPageSize,
  busy = false,
  emptyText,
  searchPlaceholder,
  selectAllLabel = '全选本页',
  renderBadge,
  renderNameAction,
  renderActions,
  resizeKey = 'docs:list:cols:v1',
  extraColumn,
  onRowDoubleClick,
  selectable,
  selected,
  onToggleRow,
  onSelectPage,
}: {
  files: DocsEntry[];
  filtered: DocsEntry[];
  pageFiles: DocsEntry[];
  query: string;
  onQuery: (v: string) => void;
  sortBy: DocsSortBy;
  onSortBy: (v: DocsSortBy) => void;
  page: number;
  totalPages: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (size: number) => void;
  busy?: boolean;
  /** 无任何文件时的提示 */
  emptyText: string;
  searchPlaceholder: string;
  /** 表头全选框的无障碍标签 */
  selectAllLabel?: string;
  renderBadge?: (f: DocsEntry) => ReactNode;
  /**
   * 文件名右侧的行内操作（目前只有提示词管理用它放「改名」按钮）。
   * 默认悬停整行才显示，避免列表里常驻一堆小图标。
   */
  renderNameAction?: (f: DocsEntry) => ReactNode;
  renderActions: (f: DocsEntry) => ReactNode;
  /** 列宽记忆的 key：各文档库分开存，互不影响；拖动表头右边缘可改宽度 */
  resizeKey?: string;
  /** 文件名右侧的附加列（目前只有提示词管理用它展示「关联插件」） */
  extraColumn?: {
    header: string;
    render: (f: DocsEntry) => ReactNode;
  };
  onRowDoubleClick?: (f: DocsEntry) => void;
  /** 判断某行是否可选（如受保护的系统提示词不可选） */
  selectable?: (f: DocsEntry) => boolean;
  selected: Record<string, boolean>;
  onToggleRow: (path: string) => void;
  /** 本页全选 / 取消全选：只传可选行 */
  onSelectPage: (paths: string[], value: boolean) => void;
}) {
  const isSelectable = selectable ?? (() => true);
  const selectablePageFiles = pageFiles.filter(isSelectable);
  const allChecked =
    selectablePageFiles.length > 0 && selectablePageFiles.every((f) => selected[f.path]);
  const someChecked = !allChecked && selectablePageFiles.some((f) => selected[f.path]);

  /**
   * 排序 / 筛选 / 翻页这些用户主动操作才播入场动画；
   * 首次加载（含刷新）不播，避免列表整体「跳」出来。
   */
  const { cls: listAnimCls, play: playListAnim } = useListAnim();
  const changeQuery = (v: string) => {
    playListAnim();
    onQuery(v);
  };
  const changeSortBy = (v: DocsSortBy) => {
    playListAnim();
    onSortBy(v);
  };
  const changePage = (p: number) => {
    playListAnim();
    onPage(p);
  };
  const changePageSize = (n: number) => {
    playListAnim();
    onPageSize(n);
  };

  /** 操作列实测宽度：先给默认值，挂载后按真实按钮宽同步 */
  const [actionsW, setActionsW] = useState(ACTIONS_WIDTH);

  /**
   * 可拖拽的列：与表头 / 行里单元格的顺序一一对应（勾选框、文件名是第 0、1 个）。
   * 文件名没有默认宽度：没有任何列被拖过时它吃掉剩余空间（不低于 NAME_MIN）；
   * 一旦拖过任意列，它就按实测像素固定。操作列宽度由内容测量得到，不给手柄。
   */
  const columns = useMemo<ColumnSpec[]>(
    () => [
      { key: 'check' },
      { key: 'name', min: NAME_MIN },
      ...(extraColumn ? [{ key: 'extra', width: EXTRA_WIDTH, min: 120 }] : []),
      { key: 'ctime', width: 152, min: 96 },
      { key: 'mtime', width: 152, min: 96 },
      { key: 'size', width: 64, min: 48 },
      { key: 'actions' },
    ],
    [extraColumn],
  );
  const cols = useFlexColumnWidths(resizeKey, columns);
  const scrollRef = useScrollEdges(resizeKey);
  /**
   * 文件名列默认 flex-1 吃掉剩余宽度；拖过之后改成固定宽度，
   * 多出来的空间交给操作列之前的占位元素，避免被文件名「弹回去」。
   */
  const nameWidth = cols.styleOf('name')?.width;
  const nameFixed = Boolean(nameWidth);
  const nameStyle: CSSProperties = nameWidth
    ? { width: nameWidth, flex: '0 0 auto', minWidth: NAME_MIN }
    : { minWidth: NAME_MIN };
  /**
   * 列表最小宽度：按「各列固定宽度 + 文件名下限」算，容器放不下时横向滚动，
   * 而不是把文件名压扁（与表格的行为一致）。容器更宽时文件名照常吃掉剩余空间。
   */
  const listMinWidth =
    columns.reduce((sum, c) => {
      if (c.key === 'check') return sum + CHECK_W + LEFT_GAP;
      if (c.key === 'actions') return sum + actionsW;
      if (c.key === 'name') return sum + (nameWidth ?? NAME_MIN);
      return sum + (cols.styleOf(c.key)?.width ?? c.width ?? 0);
    }, 0) +
    (columns.length - 1) * 8;
  const NAME_CLS = nameFixed ? 'shrink-0 min-w-0' : 'flex-1 min-w-0';
  /** 首列（勾选 + 文件名）与操作列始终贴边：任何宽度下横向滚动都不会滚丢它们 */
  const STICKY_L = 'tw-sticky-l';
  const STICKY_R = 'tw-sticky-r';
  /**
   * 左侧固定区：勾选列与文件名共用一个 sticky 外壳（left: 0）。
   * 拆成两个 sticky 元素时，两者之间必然有一条缝——横向滚动时下层字段会从缝里透出来，
   * 也会因为两段各自的 left 偏移算不准而错位。包成一整块只有一个不透明底，天然无缝。
   */
  const LEFT_STICKY: CSSProperties = { '--tw-sticky-left': '0px' } as CSSProperties;
  /** 外壳宽度：勾选 + 间距 + 文件名；文件名未拖动时给下限，由 flex-1 吃掉剩余空间 */
  const leftGroupStyle: CSSProperties = nameFixed
    ? { width: CHECK_W + LEFT_GAP + Number(nameWidth), ...LEFT_STICKY }
    : { minWidth: CHECK_W + LEFT_GAP + NAME_MIN, ...LEFT_STICKY };
  /** 附加列（评审 / 关联插件）用固定宽度，避免被内容挤窄或撑爆 */
  const extraStyle: CSSProperties = {
    width: cols.styleOf('extra')?.width ?? EXTRA_WIDTH,
    flex: '0 0 auto',
    ...cols.styleOf('extra'),
  };
  /**
   * 操作列宽度：按实际按钮测量（隐藏探针 + ResizeObserver），
   * 放得下就刚好，按钮多了自动变宽、不会向两侧溢出压住邻列。
   */
  const probeRef = useRef<HTMLDivElement | null>(null);
  const probeFile = pageFiles[0] ?? filtered[0] ?? files[0];
  const probe = probeFile && files.length > 0 ? renderActions(probeFile) : null;
  useLayoutEffect(() => {
    const el = probeRef.current;
    if (!el) return;
    const sync = () => {
      const next = Math.max(ACTIONS_MIN, Math.ceil(el.getBoundingClientRect().width) + ACTIONS_PAD);
      setActionsW((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [probeFile?.path]);

  return (
    <>
      {files.length > 0 ? (
        <div className="shrink-0 px-4 py-2 border-b border-stone-100 bg-stone-50/60 flex items-center gap-2 flex-wrap">
          <input
            type="search"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className={`${TOOL_INPUT_CLS} flex-1 min-w-48`}
          />
          <SelectDropdown
            compact
            options={DOCS_SORT_OPTIONS}
            value={sortBy}
            onChange={changeSortBy}
            ariaLabel="排序方式"
            showCheck={false}
            className="w-34 shrink-0"
          />
        </div>
      ) : null}

      {/* 内边距放在外层，滚动容器本身不留 padding：
          否则固定列（sticky right）会贴到滚动容器的内边距外侧，
          一横向滚动，列表卡片右缘就被推出可视区，右边多出一条空白。 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4">
        {/* 卡片边框画在滚动容器上：横向滚动时框不动，固定列也不会盖住圆角 */}
        <div
          ref={scrollRef}
          className="tw-scroll-x min-h-0 flex-1 overflow-auto rounded-lg border border-stone-200"
        >
          {files.length === 0 ? (
            <p className={EMPTY_BOX}>{emptyText}</p>
          ) : filtered.length === 0 ? (
            <p className={EMPTY_BOX}>没有匹配「{query.trim()}」的文件。</p>
          ) : (
            <ul
              className={`${listAnimCls}tw-sticky-list divide-y divide-stone-100`}
              style={listMinWidth ? { minWidth: listMinWidth } : undefined}
            >
              <li className="flex items-stretch gap-2 bg-stone-50 text-xs text-stone-500">
                <div
                  className={`${STICKY_L} flex min-w-0 items-stretch gap-2 ${
                    nameFixed ? 'shrink-0' : 'flex-1'
                  }`}
                  style={leftGroupStyle}
                >
                  <span
                    className="flex shrink-0 items-center justify-center"
                    style={{ width: CHECK_W }}
                  >
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = someChecked;
                      }}
                      onChange={() =>
                        onSelectPage(
                          selectablePageFiles.map((f) => f.path),
                          !allChecked,
                        )
                      }
                      disabled={busy || selectablePageFiles.length === 0}
                      className="rounded border-stone-300"
                      aria-label={selectAllLabel}
                    />
                  </span>
                  <span
                    className={`relative flex min-w-0 items-center py-2 ${NAME_CLS}`}
                    style={nameStyle}
                    data-col="name"
                  >
                    文件名
                    <ColumnResizeHandle {...cols.resizeProps('name')} />
                  </span>
                </div>
                {extraColumn ? (
                  <span
                    className="relative flex shrink-0 items-center py-2"
                    style={extraStyle}
                    data-col="extra"
                  >
                    {extraColumn.header}
                    <ColumnResizeHandle {...cols.resizeProps('extra')} />
                  </span>
                ) : null}
                <span
                  className={`relative flex items-center py-2 ${TIME_COL_CLS}`}
                  style={cols.styleOf('ctime')}
                  data-col="ctime"
                >
                  创建时间
                  <ColumnResizeHandle {...cols.resizeProps('ctime')} />
                </span>
                <span
                  className={`relative flex items-center py-2 ${TIME_COL_CLS}`}
                  style={cols.styleOf('mtime')}
                  data-col="mtime"
                >
                  修改时间
                  <ColumnResizeHandle {...cols.resizeProps('mtime')} />
                </span>
                <span
                  className={`relative flex items-center py-2 ${SIZE_COL_CLS}`}
                  style={cols.styleOf('size')}
                  data-col="size"
                >
                  大小
                  <ColumnResizeHandle {...cols.resizeProps('size')} />
                </span>
                {/* 占位放在操作列之前：剩余空间归它，操作列才能贴住右边 */}
                <span className="flex-1" aria-hidden />
                <span
                  className={`flex items-center py-2 ${STICKY_R} ${ACTION_COL_CLS} px-3`}
                  style={{ width: actionsW, flex: '0 0 auto' }}
                >
                  操作
                </span>
              </li>
              {pageFiles.map((f) => {
                const rowSelectable = isSelectable(f);
                return (
                  <li
                    key={f.path}
                    className={`group flex items-stretch gap-2 ${ROW_HOVER}`}
                    onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(f) : undefined}
                  >
                    <div
                      className={`${STICKY_L} flex min-w-0 items-center gap-2 py-2.5 ${
                        nameFixed ? 'shrink-0' : 'flex-1'
                      }`}
                      style={leftGroupStyle}
                    >
                      <span
                        className="flex shrink-0 items-center justify-center"
                        style={{ width: CHECK_W }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(selected[f.path])}
                          disabled={busy || !rowSelectable}
                          onChange={() => onToggleRow(f.path)}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border-stone-300"
                          aria-label={`选择 ${f.name}`}
                        />
                      </span>
                      <div
                        className={`${NAME_CLS} text-left flex items-center gap-2`}
                        style={nameStyle}
                      >
                        <OverflowHint text={f.name} className="text-sm text-stone-800 truncate" />
                        {renderBadge ? renderBadge(f) : null}
                        {renderNameAction ? (
                          /* 文件名右侧的小图标（改名 / 复制）：图标之间留 gap，否则两个按钮贴在一起看不出是两个 */
                          <span
                            className="ml-1 flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
                            onDoubleClick={(e) => e.stopPropagation()}
                          >
                            {renderNameAction(f)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {extraColumn ? (
                      <div
                        className="flex min-w-0 items-center overflow-hidden py-2.5"
                        style={extraStyle}
                      >
                        {extraColumn.render(f)}
                      </div>
                    ) : null}
                    <span
                      className={`${TIME_COL_CLS} flex items-center py-2.5 text-[11px] text-stone-500 tabular-nums`}
                      style={cols.styleOf('ctime')}
                    >
                      {fmtTime(f.ctime ?? f.mtime)}
                    </span>
                    <span
                      className={`${TIME_COL_CLS} flex items-center py-2.5 text-[11px] text-stone-500 tabular-nums`}
                      style={cols.styleOf('mtime')}
                    >
                      {fmtTime(f.mtime)}
                    </span>
                    <span
                      className={`${SIZE_COL_CLS} flex items-center py-2.5 text-[11px] text-stone-400`}
                      style={cols.styleOf('size')}
                    >
                      {fmtSize(f.size)}
                    </span>
                    <span className="flex-1" aria-hidden />
                    <div
                      className={`${STICKY_R} ${ACTION_COL_CLS} flex flex-nowrap items-center justify-center gap-1 px-3 py-2.5`}
                      style={{ width: actionsW, flex: '0 0 auto' }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      {renderActions(f)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* 操作列宽度探针：把真实按钮按自然宽度排一次，量完即用（固定定位，不参与滚动） */}
      {probe ? (
        <div
          aria-hidden="true"
          className="pointer-events-none invisible fixed top-0 left-0 -z-10 flex w-max flex-nowrap items-center gap-1 text-xs"
        >
          <div ref={probeRef} className="flex w-max flex-nowrap items-center gap-1">
            {probe}
          </div>
        </div>
      ) : null}

      {files.length > 0 ? (
        <DocsPager
          page={page}
          totalPages={totalPages}
          pageSize={pageSize}
          busy={busy}
          onPage={changePage}
          onPageSize={changePageSize}
        />
      ) : null}
    </>
  );
}
