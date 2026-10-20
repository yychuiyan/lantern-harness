/**
 * 文档库文件列表（搜索 + 排序 + 分页 + 表格），供知识库 / 用例 / 提示词管理复用。
 *
 * 表格结构（列宽、对齐、溢出气泡）与「知识库管理」保持一致，避免各页样式漂移。
 * 状态由调用方的 useDocsList 持有，本组件只负责渲染，便于页面头部展示匹配计数。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { fmtSize, fmtTime } from '../../lib/docs-format';
import type { DocsEntry } from '../../lib/project-docs';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';
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
/** 操作列宽（在会话中打开 + 删除） */
const ACTION_COL_CLS = 'w-40 shrink-0 text-right';

const EMPTY_BOX =
  'text-sm text-stone-400 py-10 text-center border border-dashed border-stone-200 rounded-lg';

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
  actionsClassName = ACTION_COL_CLS,
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
  /** 操作列宽度：默认 w-40；按钮多时可以放宽，避免换行错位 */
  actionsClassName?: string;
  /** 文件名右侧的附加列（目前只有提示词管理用它展示「关联插件」） */
  extraColumn?: {
    header: string;
    className?: string;
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

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {files.length === 0 ? (
          <p className={EMPTY_BOX}>{emptyText}</p>
        ) : filtered.length === 0 ? (
          <p className={EMPTY_BOX}>没有匹配「{query.trim()}」的文件。</p>
        ) : (
          <ul
            className={`${listAnimCls}divide-y divide-stone-100 border border-stone-200 rounded-lg overflow-hidden`}
          >
            <li className="flex items-center gap-2 px-3 py-2 bg-stone-50 text-xs text-stone-500">
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
              <span className="flex-1 min-w-0">文件名</span>
              {extraColumn ? (
                <span
                  className={`${extraColumn.className ?? 'w-28 shrink-0'} text-xs text-stone-500`}
                >
                  {extraColumn.header}
                </span>
              ) : null}
              <span className={TIME_COL_CLS}>创建时间</span>
              <span className={TIME_COL_CLS}>修改时间</span>
              <span className={SIZE_COL_CLS}>大小</span>
              <span className={actionsClassName}>操作</span>
            </li>
            {pageFiles.map((f) => {
              const rowSelectable = isSelectable(f);
              return (
                <li
                  key={f.path}
                  className={`group flex items-center gap-2 px-3 py-2.5 ${ROW_HOVER}`}
                  onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(f) : undefined}
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
                  <div className="flex-1 min-w-0 text-left flex items-center gap-2">
                    <OverflowHint text={f.name} className="text-sm text-stone-800 truncate" />
                    {renderBadge ? renderBadge(f) : null}
                    {renderNameAction ? (
                      <span
                        className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        {renderNameAction(f)}
                      </span>
                    ) : null}
                  </div>
                  {extraColumn ? (
                    <div className={`${extraColumn.className ?? 'w-28 shrink-0'} truncate`}>
                      {extraColumn.render(f)}
                    </div>
                  ) : null}
                  <span className={`${TIME_COL_CLS} text-[11px] text-stone-500 tabular-nums`}>
                    {fmtTime(f.ctime ?? f.mtime)}
                  </span>
                  <span className={`${TIME_COL_CLS} text-[11px] text-stone-500 tabular-nums`}>
                    {fmtTime(f.mtime)}
                  </span>
                  <span className={`${SIZE_COL_CLS} text-[11px] text-stone-400`}>
                    {fmtSize(f.size)}
                  </span>
                  <div
                    className={`${actionsClassName} flex flex-nowrap items-center justify-end gap-1`}
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
