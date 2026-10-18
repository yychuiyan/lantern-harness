import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  REPORT_KIND_LABEL,
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
import DocsPager, { usePageSize } from './DocsPager';
import SelectDropdown from './SelectDropdown';

const KINDS: ReportKind[] = ['day', 'week', 'month'];
/** 每页条数默认值（可在分页条切换，选择会被记住） */
const DEFAULT_PAGE_SIZE = 20;
/** 汇报列表的每页条数用自己的键，不跟文档库共用 */
const PAGE_SIZE_KEY = 'tw.reports.page-size.v1';

/** 提示词下拉里显示的名字去掉扩展名，省一点宽度 */
function promptLabel(name: string): string {
  return name.replace(/\.(md|markdown|txt)$/i, '');
}

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

/**
 * 工作汇报：日报 / 周报 / 月报三个 Tab，把 `工作汇报/<类型>/` 里的文件列成卡片。
 * 打开页面会幂等补齐提示词与三个目录（对应「打开插件即生成提示词」）。
 * 刷新按钮左侧的提示词下拉可以从「提示词管理」里换一份提示词来写汇报。
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
  /** 工作汇报用的提示词：从「提示词管理」里选，选择结果跟空间保存 */
  const [prompts, setPrompts] = useState<ReportPromptChoice[]>([]);
  const [promptFile, setPromptFile] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  /** 分页：列表按生成日期倒序后再切片 */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(DEFAULT_PAGE_SIZE, PAGE_SIZE_KEY);

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

  /** 提示词下拉候选：拿不到就保持原选择，不打断列表 */
  const loadPromptChoices = useCallback(async () => {
    try {
      const data = await listReportPrompts();
      setPrompts(data.items);
      setPromptFile(data.promptFile);
    } catch {
      // ignore
    }
  }, []);

  // 进页面：先补齐提示词与目录，再拉「上次停留的 Tab」列表 + 提示词下拉候选
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
    // 先清空旧列表：否则新 Tab 会短暂显示上一个目录的卡片（清空后由 loading 显示转圈）
    setItems([]);
    void load(next);
  }

  /** 换提示词：只改「用哪份」，文件本身不动 */
  async function choosePrompt(next: string) {
    if (!next || next === promptFile) return;
    setPromptBusy(true);
    setError(null);
    try {
      const applied = await selectReportPrompt(next);
      setPromptFile(applied);
      setPrompts((list) => list.map((p) => ({ ...p, selected: p.name === applied })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPromptBusy(false);
    }
  }

  const promptOptions = useMemo(
    () =>
      prompts.length
        ? prompts.map((p) => ({ value: p.name, label: promptLabel(p.name) }))
        : [{ value: '', label: '暂无提示词' }],
    [prompts],
  );

  /** 最新生成的在最上面（接口已按日期倒序，这里再兜一次，防止文件系统顺序抖动） */
  const sorted = useMemo(() => [...items].sort((a, b) => b.generatedAt - a.generatedAt), [items]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sorted, currentPage, pageSize],
  );

  /** 去工作台时把当前 Tab 带过去：输入框会挂上「生成日报/周报/月报」胶囊 */
  const workbenchHref = `${base}?report=${kind}`;

  /** 点文件名：交给系统默认程序打开（不占页面、不弹预览） */
  async function openInLocal(entry: ReportEntry) {
    if (opening) return;
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
            <SelectDropdown
              className="w-[172px]"
              flat
              options={promptOptions}
              value={promptFile}
              onChange={(next) => void choosePrompt(next)}
              disabled={!prompts.length || promptBusy}
              ariaLabel="选择工作汇报提示词"
              menuMinWidth={200}
            />
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  await load(kind);
                  await loadPromptChoices();
                })()
              }
              disabled={loading}
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
          </span>
          {latest ? (
            <span className="tabular-nums">最近生成 {formatGenerated(latest.generatedAt)}</span>
          ) : null}
          <span className="min-w-0 truncate">{dir || '—'}</span>
          <span className="ml-auto hidden shrink-0 sm:inline">点击卡片用系统默认程序打开</span>
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
            {pageItems.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  onClick={() => void openInLocal(entry)}
                  disabled={Boolean(opening)}
                  className="group flex w-full items-center gap-3 rounded-xl border border-stone-200 bg-white px-3.5 py-3 text-left transition-colors hover:border-[#3370ff]/50 hover:bg-stone-50 disabled:cursor-progress disabled:opacity-60"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-[13px] font-semibold text-stone-600">
                    {KIND_GLYPH[entry.kind]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-stone-800 transition-colors group-hover:text-[#3370ff]">
                      {fileLabel(entry.name)}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-stone-400 tabular-nums">
                      {formatGenerated(entry.generatedAt)} · {formatSize(entry.size)}
                    </span>
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-stone-400 transition-colors group-hover:text-[#3370ff]">
                    {opening === entry.name ? '打开中…' : '打开'}
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
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {items.length > 0 ? (
        <DocsPager
          page={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          busy={loading}
          onPage={setPage}
          onPageSize={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      ) : (
        <div className="pb-2.5" />
      )}
    </section>
  );
}
