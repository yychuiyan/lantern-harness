import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  REPORT_KIND_LABEL,
  deleteReports,
  listReportPrompts,
  listReports,
  openReport,
  selectReportPrompt,
  syncReportPrompt,
  type ReportEntry,
  type ReportKind,
  type ReportPromptChoice,
} from '../../lib/report-prompt';
import { readReportKind, writeReportKind } from '../../lib/report-tab';
import { writeDocsText } from '../../lib/project-docs';
import ConfirmDialog from './ConfirmDialog';
import DocsPager, { usePageSize } from './DocsPager';
import OverflowHint from './OverflowHint';
import PromptMountDialog from './PromptMountDialog';
import { showToast } from './Toast';

const KINDS: ReportKind[] = ['day', 'week', 'month'];
/** 每页条数默认值（可在分页条切换，选择会被记住） */
const DEFAULT_PAGE_SIZE = 20;
/** 汇报列表的每页条数用自己的键，不跟文档库共用 */
const PAGE_SIZE_KEY = 'tw.reports.page-size.v1';

/** 新建并挂载时的短种子（完整写法可到提示词管理里改） */
const REPORT_PROMPT_CREATE_SEED = `# 工作汇报提示词

> 由「工作汇报」插件引用。日常增删改请只改本空间「提示词管理」里的本文件。

## 角色

（请在提示词管理中维护汇报角色说明。）

## 任务

（请在提示词管理中维护：按周期生成并落盘。）

## 限制

（请在提示词管理中维护限制条款。）
`;

/** 汇报列显示文件名（去掉扩展名）：周报（2026.10.12-2026.10.18） */
function fileLabel(name: string): string {
  return name.replace(/\.(md|markdown|txt|html?)$/i, '');
}

/** 2026-10-18 14:32 */
function formatGenerated(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 文件大小：汇报都是 Markdown，KB 量级 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 卡片左上角的小字：一眼看出是日报 / 周报 / 月报 */
const KIND_GLYPH: Record<ReportKind, string> = { day: '日', week: '周', month: '月' };

/** 品牌色自定义复选框：勾选 / 半选（全选本页用） */
function ReportCheck(props: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  const mixed = Boolean(props.indeterminate) && !props.checked;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (props.disabled) return;
        props.onChange();
      }}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors disabled:opacity-40 ${
        props.checked || mixed
          ? 'border-[#3370ff] bg-[#3370ff] text-white'
          : 'border-stone-300 bg-white text-transparent hover:border-[#3370ff]/70'
      }`}
    >
      {mixed ? (
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
          <path
            d="M3.5 8h9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
          <path
            d="m3.5 8.2 2.8 2.8 6.2-6.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

/**
 * 工作汇报：日报 / 周报 / 月报三个 Tab，把 `工作汇报/<类型>/` 里的文件列成卡片。
 * 打开页面会幂等补齐提示词与三个目录（对应「打开插件即生成提示词」）。
 * 顶栏挂载框打开「挂载提示词」弹层，与用例生成 / 自动化同一套交互。
 */
export default function ReportsPage() {
  const base = import.meta.env.BASE_URL || '/';
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  const [kind, setKind] = useState<ReportKind>(() => readReportKind());
  /** 首帧记住的 Tab：首屏只拉它，避免切 Tab 时再触发一次全量初始化 */
  const initialKind = useRef(kind);
  const [items, setItems] = useState<ReportEntry[]>([]);
  const [dir, setDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在用系统程序打开的那份（按钮置灰，避免连点） */
  const [opening, setOpening] = useState('');
  /** 工作汇报用的提示词：挂载结果跟空间保存 */
  const [prompts, setPrompts] = useState<ReportPromptChoice[]>([]);
  const [promptFile, setPromptFile] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptMountOpen, setPromptMountOpen] = useState(false);
  /** 分页：列表按生成日期倒序后再切片 */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(DEFAULT_PAGE_SIZE, PAGE_SIZE_KEY);
  /** 当前 Tab 下勾选的文件名 */
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  /** 待确认删除的文件名；null 表示弹窗关闭 */
  const [deleteNames, setDeleteNames] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (next: ReportKind, options?: { ensure?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      // 补齐提示词与目录失败时不阻断列表：list 接口本身也会把目录铺好
      if (options?.ensure) {
        try {
          await syncReportPrompt(true);
        } catch {
          // ignore
        }
      }
      const data = await listReports(next);
      setItems(data.items);
      setDir(data.dir);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      // 静态部署没有本地服务：接口直接 404，给一句明确的提示
      setError(
        text.includes('404')
          ? '工作汇报需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。'
          : text,
      );
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => setPluginOn(Boolean(map.reports)));
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('reports'));
      setPluginReady(true);
    });
    return off;
  }, []);

  /**
   * 挂载弹层候选：拿不到就保持原选择，不打断列表，
   * 但要 toast 说清「写汇报用的提示词没读到」。
   */
  const loadPromptChoices = useCallback(async () => {
    try {
      const data = await listReportPrompts();
      setPrompts(data.items);
      setPromptFile(data.promptFile);
      if (!data.promptFile) {
        showToast('没有读到「提示词管理」里的工作汇报提示词，写汇报前请先挂载一份。', 'error');
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      showToast(`读取工作汇报提示词失败：${text}`, 'error');
    }
  }, []);

  // 进页面：先补齐提示词与目录，再拉「上次停留的 Tab」列表 + 提示词候选
  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      await load(initialKind.current, { ensure: true });
      await loadPromptChoices();
    })();
    // 首帧记忆值放 ref：切 Tab 由 chooseKind 自己拉列表，不触发这里重复请求
  }, [pluginReady, pluginOn, load, loadPromptChoices]);

  /** 切 Tab：记住选择并拉对应目录；刷新 / 重新进入页面后回到这个 Tab */
  function chooseKind(next: ReportKind) {
    writeReportKind(next);
    if (next === kind) return;
    setKind(next);
    setPage(1);
    setSelected({});
    // 先清空旧列表：否则新 Tab 会短暂显示上一个目录的卡片（清空后由 loading 显示转圈）
    setItems([]);
    void load(next);
  }

  /** 挂载提示词：只改「用哪份」，文件本身不动 */
  async function mountPrompt(next: string) {
    if (!next) return;
    setPromptBusy(true);
    setError(null);
    try {
      const applied = await selectReportPrompt(next);
      setPromptFile(applied);
      setPrompts((list) => list.map((p) => ({ ...p, selected: p.name === applied })));
      setPromptMountOpen(false);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setError(text);
      showToast(`挂载提示词失败：${text}`, 'error');
      throw e;
    } finally {
      setPromptBusy(false);
    }
  }

  /** 新建提示词并挂载：写入提示词管理后再 select */
  async function createAndMountPrompt(rawName: string): Promise<string> {
    let name = rawName.trim().replace(/[\\/]/g, '');
    if (!name) throw new Error('请填写提示词文件名');
    if (!/\.(md|markdown|txt)$/i.test(name)) name = `${name}.md`;
    await writeDocsText('prompts', name, REPORT_PROMPT_CREATE_SEED);
    const applied = await selectReportPrompt(name);
    await loadPromptChoices();
    setPromptFile(applied);
    return applied;
  }

  const promptNames = useMemo(() => prompts.map((p) => p.name), [prompts]);
  const promptMissing = !promptFile;

  /** 最新生成的在最上面（接口已按日期倒序，这里再兜一次，防止文件系统顺序抖动） */
  const sorted = useMemo(() => [...items].sort((a, b) => b.generatedAt - a.generatedAt), [items]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sorted, currentPage, pageSize],
  );
  const selectedNames = useMemo(
    () =>
      Object.keys(selected).filter((name) => selected[name] && items.some((x) => x.name === name)),
    [selected, items],
  );
  const pageAllSelected =
    pageItems.length > 0 && pageItems.every((entry) => Boolean(selected[entry.name]));
  const pageSomeSelected =
    pageItems.some((entry) => Boolean(selected[entry.name])) && !pageAllSelected;

  /** 去工作台时把当前 Tab 带过去：输入框会挂上「生成日报/周报/月报」胶囊 */
  const workbenchHref = `${base}workbench/?report=${kind}`;

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[name]) delete next[name];
      else next[name] = true;
      return next;
    });
  }

  function toggleSelectPage() {
    setSelected((prev) => {
      const next = { ...prev };
      if (pageAllSelected) {
        for (const entry of pageItems) delete next[entry.name];
      } else {
        for (const entry of pageItems) next[entry.name] = true;
      }
      return next;
    });
  }

  /** 点文件名：交给系统默认程序打开（不占页面、不弹预览） */
  async function openInLocal(entry: ReportEntry) {
    if (opening || deleting) return;
    setOpening(entry.name);
    setError(null);
    try {
      await openReport(entry.kind, entry.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening('');
    }
  }

  async function confirmDelete() {
    const names = deleteNames;
    if (!names?.length) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await deleteReports(kind, names);
      setDeleteNames(null);
      setSelected((prev) => {
        const next = { ...prev };
        for (const name of result.deleted) delete next[name];
        return next;
      });
      showToast(
        result.deleted.length > 1
          ? `已删除 ${result.deleted.length} 篇${REPORT_KIND_LABEL[kind]}`
          : `已删除「${fileLabel(result.deleted[0] || names[0] || '')}」`,
        'success',
      );
      if (result.missing.length) {
        showToast(`${result.missing.length} 篇未找到或已删除`, 'error');
      }
      await load(kind);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setError(text);
      showToast(`删除失败：${text}`, 'error');
    } finally {
      setDeleting(false);
    }
  }

  if (!pluginReady) {
    return (
      <div
        className="rounded-xl border border-stone-200 bg-white overflow-hidden flex items-center justify-center min-h-[220px]"
        aria-busy="true"
        aria-label="正在读取插件开关"
      >
        <span className="tw-lib-spin" aria-hidden="true" />
      </div>
    );
  }

  if (!pluginOn) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        {pluginDisabledMessage('reports')}
      </div>
    );
  }

  /** 最新一篇：页头摘要用 */
  const latest = sorted[0];

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
      <div className="shrink-0 border-b border-stone-100 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-stone-100/80 p-0.5">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => chooseKind(k)}
                className={`h-8 rounded-md px-3 text-sm transition-colors ${
                  kind === k
                    ? 'bg-white font-medium text-stone-900 shadow-sm'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                {REPORT_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {items.length > 0 ? (
              <div className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-stone-600">
                <ReportCheck
                  checked={pageAllSelected}
                  indeterminate={pageSomeSelected}
                  disabled={pageItems.length === 0 || deleting}
                  label="全选本页汇报"
                  onChange={toggleSelectPage}
                />
                <button
                  type="button"
                  disabled={pageItems.length === 0 || deleting}
                  onClick={() => toggleSelectPage()}
                  className="disabled:opacity-40"
                >
                  全选本页
                </button>
              </div>
            ) : null}
            <button
              type="button"
              disabled={deleting || selectedNames.length === 0}
              onClick={() => setDeleteNames(selectedNames)}
              className="h-9 shrink-0 rounded-lg border border-red-200 px-3 text-sm font-medium whitespace-nowrap text-red-600 hover:bg-red-50 disabled:opacity-40"
            >
              批量删除{selectedNames.length ? ` (${selectedNames.length})` : ''}
            </button>
            <button
              type="button"
              disabled={promptBusy}
              onClick={() => setPromptMountOpen(true)}
              aria-label="挂载提示词"
              className={`flex h-9 w-40 min-w-0 items-center rounded-lg border bg-white px-2.5 text-left transition-colors hover:border-stone-300 focus:border-[#4176e6] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4176e6]/30 disabled:opacity-40 ${
                promptMissing ? 'border-amber-300 text-amber-700' : 'border-stone-200'
              }`}
            >
              <OverflowHint
                text={promptMissing ? '未挂载提示词 · 点击挂载' : promptFile}
                className={`min-w-0 flex-1 truncate text-sm ${
                  promptMissing ? 'text-amber-700' : 'text-stone-700'
                }`}
              />
            </button>
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  await load(kind);
                  await loadPromptChoices();
                })()
              }
              disabled={loading || deleting}
              aria-label="刷新"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-800 disabled:opacity-40"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <path d="M21 4v5h-5" />
              </svg>
            </button>
            <a
              href={workbenchHref}
              className="inline-flex h-9 items-center whitespace-nowrap rounded-lg bg-[#3370ff] px-3 text-sm font-medium text-white transition-colors hover:bg-[#2b5fd9]"
            >
              去工作台写汇报
            </a>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-400">
          <span>
            {REPORT_KIND_LABEL[kind]} · 共 {items.length} 篇
            {selectedNames.length ? ` · 已选 ${selectedNames.length}` : ''}
          </span>
          {latest ? (
            <span className="tabular-nums">最近生成 {formatGenerated(latest.generatedAt)}</span>
          ) : null}
          <span className="min-w-0 truncate">{dir || '—'}</span>
          <span className="ml-auto hidden shrink-0 sm:inline">单击选中 · 双击打开</span>
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

      <div className="min-h-0 flex-1 overflow-auto bg-stone-50/60 p-3 sm:p-4">
        {loading && items.length === 0 ? (
          <div className="flex min-h-[180px] items-center justify-center" aria-busy="true">
            <span className="tw-lib-spin" aria-hidden="true" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 px-6 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-stone-100 text-stone-400">
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
                <path d="M9 13h6M9 17h4" />
              </svg>
            </span>
            <div className="text-sm font-medium text-stone-700">
              还没有{REPORT_KIND_LABEL[kind]}
            </div>
            <p className="max-w-md text-xs leading-5 text-stone-400">
              保存到 {dir || `工作汇报/${REPORT_KIND_LABEL[kind]}`} 后会自动出现在这里。
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] gap-2.5">
            {pageItems.map((entry) => {
              const checked = Boolean(selected[entry.name]);
              const busy = Boolean(opening) || deleting;
              /** 有勾选时角标常显；否则悬停露出空心角标 */
              const showCorner = checked || selectedNames.length > 0;
              /** 已有选中时，未选中卡片不再 hover 描边 / 改色，避免和选中态抢视觉 */
              const hoverOk = !showCorner || checked;
              return (
                <li key={entry.name}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={checked}
                    aria-label={`${checked ? '取消选中' : '选中'} ${fileLabel(entry.name)}，双击打开`}
                    onClick={() => {
                      if (busy) return;
                      toggleSelect(entry.name);
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      if (busy) return;
                      void openInLocal(entry);
                    }}
                    onKeyDown={(e) => {
                      if (busy) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleSelect(entry.name);
                      }
                    }}
                    className={`group relative flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-xl border bg-white px-3.5 py-3 text-left transition-colors select-none ${
                      checked
                        ? 'border-[#3370ff] shadow-[0_0_0_1px_rgba(51,112,255,0.12)]'
                        : hoverOk
                          ? 'border-stone-200 hover:border-[#3370ff]/45'
                          : 'border-stone-200'
                    } ${busy ? 'opacity-60' : ''}`}
                  >
                    {/* 选中时卡片浅底 */}
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-0 z-0 bg-[#3370ff]/[0.07] transition-opacity ${
                        checked ? 'opacity-100' : 'opacity-0'
                      }`}
                    />
                    {/* 贴左上角的小三角角标：默认蓝；未选中加浅蒙版 */}
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={`选择 ${fileLabel(entry.name)}`}
                      disabled={deleting}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!deleting) toggleSelect(entry.name);
                      }}
                      className={`absolute left-0 top-0 z-10 h-[22px] w-[22px] disabled:opacity-40 ${
                        checked || showCorner ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      <svg
                        viewBox="0 0 22 22"
                        className="absolute inset-0 h-full w-full"
                        aria-hidden="true"
                      >
                        <path d="M0 0h22L0 22z" fill="#3370ff" />
                        {/* 未选中：白蒙版压淡；选中：实心蓝不压蒙版 */}
                        {!checked ? (
                          <path d="M0 0h22L0 22z" fill="#fff" fillOpacity={0.45} />
                        ) : null}
                      </svg>
                      <svg
                        viewBox="0 0 16 16"
                        width="9"
                        height="9"
                        className={`absolute left-[3px] top-[3px] text-white ${
                          checked ? 'opacity-100' : 'opacity-70'
                        }`}
                        aria-hidden="true"
                      >
                        <path
                          d="m3.4 8 2.8 2.8 6.2-6.4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <span className="relative z-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-[13px] font-semibold text-stone-600">
                      {KIND_GLYPH[entry.kind]}
                    </span>
                    <span className="relative z-1 min-w-0 flex-1">
                      <span
                        className={`block truncate text-sm font-medium text-stone-800 transition-colors ${
                          hoverOk ? 'group-hover:text-[#3370ff]' : ''
                        }`}
                      >
                        {fileLabel(entry.name)}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-stone-400 tabular-nums">
                        {formatGenerated(entry.generatedAt)} · {formatSize(entry.size)}
                        {opening === entry.name ? ' · 打开中…' : ''}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`删除 ${fileLabel(entry.name)}`}
                      disabled={deleting}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteNames([entry.name]);
                      }}
                      className="relative z-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="15"
                        height="15"
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
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {items.length > 0 ? (
        <DocsPager
          page={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          busy={loading || deleting}
          onPage={setPage}
          onPageSize={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      ) : (
        <div className="pb-2.5" />
      )}

      <ConfirmDialog
        open={deleteNames != null}
        title={deleteNames && deleteNames.length > 1 ? '批量删除' : '删除汇报'}
        message={
          deleteNames && deleteNames.length > 1
            ? `确认删除已选中的 ${deleteNames.length} 篇${REPORT_KIND_LABEL[kind]}？此操作不可恢复。`
            : `删除「${fileLabel(deleteNames?.[0] || '')}」？此操作不可恢复。`
        }
        confirmLabel={deleting ? '删除中…' : '删除'}
        cancelLabel="取消"
        danger
        onClose={() => {
          if (!deleting) setDeleteNames(null);
        }}
        onConfirm={() => void confirmDelete()}
      />

      <PromptMountDialog
        open={promptMountOpen}
        prompts={promptNames}
        value={promptFile}
        force={promptMissing}
        onClose={() => setPromptMountOpen(false)}
        onMount={mountPrompt}
        onCreate={createAndMountPrompt}
        target="工作汇报"
        createHint="会按工作汇报短种子生成一份，之后可在「提示词管理」里改。"
      />
    </section>
  );
}
