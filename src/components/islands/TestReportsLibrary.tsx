import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import { docRootLabelPath } from '../../lib/doc-roots';
import {
  parseCsvTemplate,
  parseMdTemplate,
  parseXlsxTemplateBase64,
} from '../../lib/case-template';
import {
  countTreeDirs,
  deleteDocs,
  fetchDocsHealth,
  fetchDocsTree,
  findTreeNode,
  isPathUnder,
  listDocs,
  mkdirDocs,
  openDocsFile,
  parentDirPath,
  readDocsRaw,
  readDocsText,
  remapPath,
  renameDocs,
  uploadDocsFile,
  type DocsEntry,
  type DocsTreeNode,
} from '../../lib/project-docs';
import {
  TEST_REPORT_KINDS,
  REPORT_FILE_FILTER_VALUES,
  ensureTestReportPromptSkills,
  kindDef,
  kindFromReportPath,
  reportFileKind,
  type ReportFileFilter,
  type TestReportKind,
} from '../../lib/test-reports';
import { openDocsInChatSession } from '../../lib/open-docs-in-session';
import ConfirmDialog from './ConfirmDialog';
import DocsFileBrowser, { DocsFileFilterControls, useDocsList } from './DocsFileBrowser';
import ExcelFieldTags from './ExcelFieldTags';
import NamePromptDialog from './NamePromptDialog';
import { PmIcon } from './PmShared';
import SelectDropdown from './SelectDropdown';
import TestReportReviewDrawer from './TestReportReviewDrawer';
import { showToast } from './Toast';
import { readViewPref, writeViewPref } from '../../lib/view-prefs';

/** 文件列表每页条数默认值（仅文件分页，左侧文件夹树照常全部显示；可在分页条切换并记住） */
const DEFAULT_PAGE_SIZE = 5;

const REPORT_FILE_FILTER_OPTIONS: ReadonlyArray<{
  value: ReportFileFilter;
  label: string;
}> = [
  { value: 'all', label: '全部类型' },
  { value: 'word', label: 'Word' },
  { value: 'excel', label: 'Excel' },
  { value: 'text', label: 'Markdown / 文本' },
  { value: 'csv', label: 'CSV' },
  { value: 'other', label: '其他' },
];

interface TestReportsLibraryProps {
  fixedKind?: TestReportKind;
}

/** 删除确认目标；树的节点没有 type 字段，故用 isDir 统一区分 */
interface DeleteTarget {
  name: string;
  path: string;
  isDir: boolean;
  /** 目录非空被拦截：只提示，不执行删除 */
  blocked?: boolean;
  /** 拦截提示用的递归数量；「全部 XX」这类节点无 fileCount 时为 null */
  files?: number | null;
  dirs?: number | null;
}

async function loadFileHeaders(entry: DocsEntry): Promise<string[]> {
  const lower = entry.name.toLowerCase();
  try {
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      const raw = await readDocsRaw('testReports', entry.path);
      if (raw.encoding === 'base64' && raw.contentBase64) {
        return parseXlsxTemplateBase64(raw.contentBase64).headers;
      }
    } else if (lower.endsWith('.csv')) {
      const r = await readDocsText('testReports', entry.path);
      return parseCsvTemplate(r.content).headers;
    } else if (lower.endsWith('.md') || lower.endsWith('.txt')) {
      const r = await readDocsText('testReports', entry.path);
      return parseMdTemplate(r.content).headers;
    }
  } catch {
    // ignore parse errors
  }
  return [];
}

function FolderIcon({
  className = 'w-4 h-4',
  open = false,
}: {
  className?: string;
  open?: boolean;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      {open ? (
        <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      )}
    </svg>
  );
}

function TreeNode({
  node,
  depth,
  activePath,
  expanded,
  globalOpen,
  onToggle,
  onSelect,
}: {
  node: DocsTreeNode;
  depth: number;
  activePath: string;
  expanded: Record<string, boolean>;
  /** 「全部报告」箭头的全局展开状态；单个节点未单独切换过时跟随它 */
  globalOpen: boolean;
  onToggle: (p: string) => void;
  onSelect: (p: string) => void;
}) {
  const open = expanded[node.path] ?? globalOpen;
  const active = activePath === node.path;
  return (
    <div>
      {/* 行的重命名 / 删除操作只保留在右侧「子文件夹列表」，树里只负责选择与折叠 */}
      <div
        className={`group flex items-center rounded-md ${
          active ? 'bg-[#e8f0fe]' : 'hover:bg-stone-100'
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          type="button"
          onClick={() => {
            onSelect(node.path);
            if (node.children.length) onToggle(node.path);
          }}
          aria-expanded={node.children.length ? open : undefined}
          className={`flex-1 min-w-0 flex items-center gap-1.5 py-1.5 pr-1 text-sm text-left ${
            active ? 'text-[#4176e6]' : 'text-stone-600'
          }`}
        >
          {/* 占位：子层级保留被移除箭头所占的宽度（14px + 6px 间距），使各层文件夹图标回到原缩进位置 */}
          <span className="w-3.5 shrink-0" aria-hidden="true" />
          {/* 无独立箭头：文件夹图标直接落在原箭头的位置（展开/闭合形状表示状态） */}
          <FolderIcon
            open={Boolean(node.children.length && open)}
            className="w-3.5 h-3.5 shrink-0 text-[#4176e6]"
          />
          <span className="flex-1 min-w-0 truncate">{node.name}</span>
          <span className="shrink-0 tabular-nums text-[11px] text-stone-400">
            ({node.fileCount ?? 0})
          </span>
        </button>
      </div>
      <div className={`tw-collapse ${open ? 'is-open' : ''}`}>
        <div className="tw-collapse-inner space-y-1">
          {node.children.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              activePath={activePath}
              expanded={expanded}
              globalOpen={globalOpen}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function TestReportsLibrary({ fixedKind }: TestReportsLibraryProps = {}) {
  const fixedKindDef = fixedKind ? kindDef(fixedKind) : null;
  const fixedRootPath = fixedKindDef?.folder ?? '';
  const rootPath = fixedRootPath || '.';
  const reportListId = `testReports.${fixedKind || 'all'}`;
  const [pluginOn, setPluginOn] = useState(() => isPluginEnabled('testReports'));
  const [pluginReady, setPluginReady] = useState(false);
  const [live, setLive] = useState<boolean | null>(null);
  const [tree, setTree] = useState<DocsTreeNode[]>([]);
  const [totalFiles, setTotalFiles] = useState(0);
  const [activePath, setActivePath] = useState(rootPath);
  const [entries, setEntries] = useState<DocsEntry[]>([]);
  const [headersByPath, setHeadersByPath] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 「全部报告」箭头的全局展开态；默认展开 */
  const [globalOpen, setGlobalOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewPath, setReviewPath] = useState('');
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    name: string;
    path: string;
    isDir: boolean;
  } | null>(null);
  const [fileFilter, setFileFilter] = useState<ReportFileFilter>(() =>
    readViewPref(`docs.${reportListId}.filter`, REPORT_FILE_FILTER_VALUES, 'all'),
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const files = useMemo(() => entries.filter((entry) => entry.type === 'file'), [entries]);
  const dirs = useMemo(() => entries.filter((entry) => entry.type === 'dir'), [entries]);
  const filteredFiles = useMemo(
    () => files.filter((file) => fileFilter === 'all' || reportFileKind(file.name) === fileFilter),
    [fileFilter, files],
  );
  const list = useDocsList(filteredFiles, DEFAULT_PAGE_SIZE, reportListId);
  /** 仅在二级类型目录（功能 / 接口 / 性能）下确定自动使用的技能。 */
  const activeKind: TestReportKind | null = useMemo(() => {
    if (fixedKind) return fixedKind;
    if (activePath === '.' || !activePath.trim()) return null;
    return kindFromReportPath(activePath);
  }, [activePath, fixedKind]);
  const fixedRootNode = useMemo(
    () => (fixedKindDef ? findTreeNode(tree, fixedKindDef.folder) : null),
    [fixedKindDef, tree],
  );
  const visibleTree = fixedKindDef ? (fixedRootNode?.children ?? []) : tree;
  const visibleTotalFiles = fixedKindDef ? (fixedRootNode?.fileCount ?? 0) : totalFiles;
  const typedFileCount = useMemo(
    () =>
      TEST_REPORT_KINDS.reduce(
        (sum, kind) => sum + (findTreeNode(tree, kind.folder)?.fileCount ?? 0),
        0,
      ),
    [tree],
  );
  const unscopedFiles = Math.max(0, totalFiles - typedFileCount);
  const loadHeadersForFiles = useCallback(async (fileList: DocsEntry[]) => {
    const next: Record<string, string[]> = {};
    await Promise.all(
      fileList.map(async (f) => {
        const headers = await loadFileHeaders(f);
        if (headers.length) next[f.path] = headers;
      }),
    );
    setHeadersByPath(next);
  }, []);

  /** 重新拉取文件夹树（含各目录递归文件数） */
  const loadTree = useCallback(async () => {
    const t = await fetchDocsTree('testReports');
    setTree(t.tree);
    setTotalFiles(t.totalFiles);
  }, []);

  const refresh = useCallback(
    async (dir = activePath) => {
      setError(null);
      try {
        const nextDir = fixedRootPath && !isPathUnder(dir, fixedRootPath) ? fixedRootPath : dir;
        const [listed] = await Promise.all([listDocs('testReports', nextDir), loadTree()]);
        setEntries(listed.entries);
        setActivePath(listed.path);
        const filesOnly = listed.entries.filter((e) => e.type === 'file');
        await loadHeadersForFiles(filesOnly);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [activePath, fixedRootPath, loadHeadersForFiles, loadTree],
  );

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => setPluginOn(Boolean(map.testReports)));
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('testReports'));
      setPluginReady(true);
    });
    return off;
  }, []);

  /** 幂等：三类空目录 + 默认技能（已存在不覆盖）。 */
  const ensureReportScaffold = useCallback(async () => {
    for (const k of TEST_REPORT_KINDS) {
      try {
        await mkdirDocs('testReports', '.', k.folder);
      } catch {
        // 已存在忽略
      }
    }
    await ensureTestReportPromptSkills();
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchDocsHealth('testReports');
      if (!ok) {
        setLive(false);
        return;
      }
      try {
        await ensureReportScaffold();
        const [listed] = await Promise.all([listDocs('testReports', rootPath), loadTree()]);
        setEntries(listed.entries);
        setActivePath(listed.path);
        await loadHeadersForFiles(listed.entries.filter((e) => e.type === 'file'));
        setLive(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLive(true);
      }
    })();
  }, [pluginReady, pluginOn, ensureReportScaffold, loadHeadersForFiles, loadTree, rootPath]);

  /** 当前浏览目录的递归文件数（仅左树展示，故这里不再需要） */

  /** 「全部报告」箭头：一次性收起/展开整棵树，并清掉各节点的单独覆盖 */
  function toggleAll() {
    setGlobalOpen((v) => !v);
    setExpanded({});
  }

  async function selectDir(p: string) {
    if (fixedRootPath && !isPathUnder(p, fixedRootPath)) p = fixedRootPath;
    setActivePath(p);
    setError(null);
    try {
      const listed = await listDocs('testReports', p);
      setEntries(listed.entries);
      await loadHeadersForFiles(listed.entries.filter((e) => e.type === 'file'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onMkdirConfirm(name: string) {
    setMkdirOpen(false);
    setBusy(true);
    setError(null);
    try {
      await mkdirDocs('testReports', activePath, name);
      await refresh(activePath);
      showToast(`已新建文件夹「${name}」`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`新建文件夹失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        await uploadDocsFile('testReports', activePath, f);
      }
      await refresh(activePath);
      showToast(`已上传 ${files.length} 个文件`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`上传失败：${msg}`, 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  /** 在会话中打开：无关联则新建会话；挂报告 chip，关联技能只注入系统提示 */
  async function openInSession(entry: DocsEntry) {
    const kind = fixedKind ?? kindFromReportPath(entry.path) ?? activeKind;
    const prompt = kind ? kindDef(kind).defaultPrompt : '';
    setBusy(true);
    setError(null);
    try {
      await openDocsInChatSession('testReports', entry, {
        attachPrompt: prompt || undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function onOpenLocal(entry: DocsEntry) {
    if (entry.type !== 'file') return;
    setBusy(true);
    setError(null);
    try {
      await openDocsFile('testReports', entry.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** 打开文件夹删除确认：从树里读递归文件数（零额外请求），非空则拦截 */
  function requestDeleteDir(target: { name: string; path: string }) {
    const node = findTreeNode(tree, target.path);
    const files = node?.fileCount ?? 0;
    const dirs = node ? countTreeDirs(node) : 0;
    setDeleteTarget({
      ...target,
      isDir: true,
      blocked: files > 0 || dirs > 0,
      files,
      dirs,
    });
  }

  function requestDeleteFile(entry: DocsEntry) {
    setDeleteTarget({ name: entry.name, path: entry.path, isDir: false });
  }

  function requestRename(target: { name: string; path: string }, isDir: boolean) {
    setRenameTarget({ ...target, isDir });
  }

  async function confirmDelete() {
    const entry = deleteTarget;
    if (!entry) return;
    setDeleteTarget(null);
    if (entry.blocked) return; // 非空拦截：仅提示，不执行删除
    setBusy(true);
    setError(null);
    try {
      await deleteDocs('testReports', entry.path);
      // 当前浏览路径落在被删目录内时回退到父目录，否则刷新会 404
      const nextDir = isPathUnder(activePath, entry.path) ? parentDirPath(entry.path) : activePath;
      await refresh(nextDir);
      showToast(`已删除「${entry.name}」`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmRename(name: string) {
    const target = renameTarget;
    if (!target) return;
    setRenameTarget(null);
    if (name === target.name) return; // 名称未变化，无需请求
    setBusy(true);
    setError(null);
    try {
      const nextPath = await renameDocs('testReports', target.path, name);
      // 当前浏览路径位于被重命名目录内时，同步到新路径
      await refresh(remapPath(activePath, target.path, nextPath));
      showToast(`已重命名为「${name}」`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`重命名失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  const deleteMessage = (() => {
    if (!deleteTarget) return '';
    if (!deleteTarget.isDir) {
      return `删除文件「${deleteTarget.name}」？将移入系统废纸篓，可随时找回。`;
    }
    if (deleteTarget.blocked) {
      const parts: string[] = [];
      if (deleteTarget.files) parts.push(`${deleteTarget.files} 个文件`);
      if (deleteTarget.dirs) parts.push(`${deleteTarget.dirs} 个子文件夹`);
      return `文件夹「${deleteTarget.name}」中还有 ${parts.join('、')}，请先清空内部内容后再删除。`;
    }
    return `删除文件夹「${deleteTarget.name}」？将移入系统废纸篓。`;
  })();

  if (!pluginReady) {
    return (
      <div className="tw-lib-probing" aria-busy="true" aria-label="正在读取插件开关">
        <span className="tw-lib-spin" aria-hidden="true" />
      </div>
    );
  }

  if (!pluginOn) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        {pluginDisabledMessage('testReports')}
      </div>
    );
  }

  if (live === null) {
    return (
      <div className="tw-lib-probing" aria-busy="true" aria-label="正在连接本地文档服务">
        <span className="tw-lib-spin" aria-hidden="true" />
      </div>
    );
  }

  if (!live) {
    return (
      <div className="tw-lib-notice rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        报告管理需要本地文档服务，当前未就绪。
      </div>
    );
  }

  const reportsLanding = `${import.meta.env.BASE_URL || '/'}test-reports/`;

  return (
    <div className="flex gap-4 min-h-0">
      {fixedKindDef ? null : (
        <aside className="w-56 shrink-0 rounded-xl border border-stone-200 bg-white flex flex-col overflow-hidden">
          <div className="px-3 py-2.5 border-b border-stone-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-stone-500">文件夹</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMkdirOpen(true)}
              className="tw-mkdir-btn disabled:opacity-40"
            >
              + 新建
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-2 px-1 space-y-1">
            {/* 无固定类型时是“全部报告”；固定类型页对应类型目录 */}
            <div
              className={`group flex items-center rounded-md ${
                activePath === '.' ? 'bg-[#e8f0fe]' : 'hover:bg-stone-100'
              }`}
              style={{ paddingLeft: 8 }}
            >
              <button
                type="button"
                onClick={() => {
                  // 从其它目录点进来：选中根并保持展开；已在根上再点才切换展开/收起
                  void selectDir(rootPath);
                  if (activePath === rootPath) {
                    toggleAll();
                  } else {
                    setGlobalOpen(true);
                    setExpanded({});
                  }
                }}
                aria-expanded={globalOpen}
                className={`flex-1 min-w-0 flex items-center gap-1.5 py-1.5 pr-1 text-sm text-left ${
                  activePath === '.' ? 'text-[#4176e6]' : 'text-stone-600'
                }`}
              >
                {/* 无独立箭头：文件夹图标直接落在原箭头的位置 */}
                <FolderIcon open={globalOpen} className="w-3.5 h-3.5 shrink-0 text-[#4176e6]" />
                <span className="flex-1 min-w-0 truncate">全部报告</span>
                {/* 与子行共用一个右内边距 + 等宽数字，数量列才能竖直对齐 */}
                <span className="shrink-0 tabular-nums text-[11px] text-stone-400">
                  ({visibleTotalFiles})
                </span>
              </button>
            </div>
            {/* 根行的子节点必须包在可折叠容器里，否则 globalOpen 只改状态、不产生视觉收起 */}
            <div className={`tw-collapse ${globalOpen ? 'is-open' : ''}`}>
              <div className="tw-collapse-inner space-y-1">
                {visibleTree.map((n) => (
                  <TreeNode
                    key={n.path}
                    node={n}
                    depth={0}
                    activePath={activePath}
                    expanded={expanded}
                    globalOpen={globalOpen}
                    onToggle={(p) => setExpanded((m) => ({ ...m, [p]: !(m[p] ?? globalOpen) }))}
                    onSelect={(p) => void selectDir(p)}
                  />
                ))}
              </div>
            </div>
          </div>
        </aside>
      )}

      <section className="flex-1 min-w-0 rounded-xl border border-stone-200 bg-white flex flex-col overflow-hidden">
        <div className="shrink-0 px-4 py-3 border-b border-stone-100 flex flex-wrap items-start gap-2">
          <div className="mt-1.5 min-w-0 shrink-0 text-sm text-stone-600 xl:mt-0 xl:self-center">
            {list.query.trim() || fileFilter !== 'all' ? (
              <span className="inline-flex items-center gap-2">
                <span>
                  匹配 <span className="font-medium text-stone-800">{list.filtered.length}</span> 个
                </span>
                <span className="text-xs text-stone-400">共 {files.length} 个</span>
              </span>
            ) : (
              <span>
                <span className="font-medium text-stone-800">{files.length}</span> 个文件
              </span>
            )}
            {!fixedKindDef ? (
              <div className="mt-0.5 max-w-80 truncate text-xs text-stone-400">
                {docRootLabelPath('testReports')}
                {activePath === '.' ? '' : activePath}
              </div>
            ) : null}
          </div>
          <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
            <div className="flex shrink-0 items-center gap-2">
              <DocsFileFilterControls
                query={list.query}
                onQuery={list.setQuery}
                sortBy={list.sortBy}
                onSortBy={list.setSortBy}
                searchPlaceholder="搜索文件名或路径…"
                searchClassName="w-64 max-w-full shrink-0"
              />
              <SelectDropdown
                compact
                options={REPORT_FILE_FILTER_OPTIONS}
                value={fileFilter}
                onChange={(value) => {
                  setFileFilter(value);
                  writeViewPref(`docs.${reportListId}.filter`, value);
                }}
                ariaLabel="筛选报告类型"
                showCheck={false}
                className="w-32 shrink-0"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={!activeKind || busy}
                onClick={() => {
                  setReviewPath('');
                  setReviewOpen(true);
                }}
                className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-[#4176e6]/30 bg-[#eef4ff] px-3 text-sm font-medium text-[#315eb8] hover:bg-[#e3edff] disabled:opacity-40"
                data-hint={
                  activeKind ? '从真实用例与统计整理报告' : '先进入功能 / 接口 / 性能报告目录'
                }
              >
                整理报告
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".md,.txt,.docx,.xlsx,.xls,.csv,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => void onUpload(e.target.files)}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                className="h-8 px-3 shrink-0 whitespace-nowrap text-sm font-medium text-white bg-[#4176e6] rounded-lg hover:bg-[#3565c7] disabled:opacity-40"
              >
                上传文件
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="mx-4 mt-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {error}
          </div>
        ) : null}

        {fixedKindDef && unscopedFiles > 0 ? (
          <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            另有 {unscopedFiles} 份未归类报告，
            <a className="underline" href={reportsLanding}>
              打开全部报告
            </a>
          </div>
        ) : null}

        {dirs.length > 0 ? (
          <div className="shrink-0 px-4 pt-4">
            <div className="mb-2 text-xs font-medium text-stone-400">子文件夹</div>
            <ul className="space-y-1">
              {dirs.map((d) => (
                <li
                  key={d.path}
                  className="group flex items-center gap-2 rounded-lg border border-stone-100 px-3 py-2 hover:bg-stone-50"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-stone-700"
                    onClick={() => void selectDir(d.path)}
                  >
                    <FolderIcon className="h-4 w-4 shrink-0 text-[#4176e6]" />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`重命名 ${d.name}`}
                      onClick={() => requestRename({ name: d.name, path: d.path }, true)}
                      className="rounded p-1.5 text-stone-400 opacity-0 transition-opacity hover:bg-[#e8f0fe] hover:text-[#4176e6] focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
                    >
                      <PmIcon name="pencil" size={12} />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`删除 ${d.name}`}
                      onClick={() => requestDeleteDir({ name: d.name, path: d.path })}
                      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <DocsFileBrowser
          files={files}
          filtered={list.filtered}
          pageFiles={list.pageFiles}
          query={list.query}
          onQuery={list.setQuery}
          sortBy={list.sortBy}
          onSortBy={list.setSortBy}
          page={list.page}
          totalPages={list.totalPages}
          pageSize={list.pageSize}
          onPage={list.setPage}
          onPageSize={list.setPageSize}
          busy={busy}
          emptyText="当前文件夹为空，点击「上传文件」添加报告（.md / .xlsx / .docx 等）"
          noMatchText={
            fileFilter === 'all'
              ? undefined
              : '没有符合当前筛选条件的文件，请切换报告类型或清空搜索词。'
          }
          searchPlaceholder="搜索文件名或路径…"
          showFilters={false}
          showSelection={false}
          resizeKey={`docs:test-reports:${fixedKind || 'all'}:cols:v1`}
          selected={{}}
          onToggleRow={() => {}}
          onSelectPage={() => {}}
          onRowDoubleClick={(file) => void onOpenLocal(file)}
          renderBadge={(file) => {
            const fields = headersByPath[file.path] ?? [];
            return fields.length > 0 ? <ExcelFieldTags fields={fields} /> : null;
          }}
          renderNameAction={(file) => (
            <button
              type="button"
              disabled={busy}
              aria-label={`重命名 ${file.name}`}
              onClick={() => requestRename({ name: file.name, path: file.path }, false)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-stone-400 transition-colors hover:bg-[#e8f0fe] hover:text-[#4176e6] disabled:opacity-40"
            >
              <PmIcon name="pencil" size={12} />
            </button>
          )}
          renderActions={(file) => (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void openInSession(file)}
                className="shrink-0 cursor-pointer whitespace-nowrap rounded bg-[#4176e6] px-2.5 py-1 text-xs text-white hover:bg-[#3565c7] disabled:opacity-40"
              >
                在会话中打开
              </button>
              <button
                type="button"
                disabled={busy || !activeKind}
                onClick={() => {
                  setReviewPath(reportFileKind(file.name) === 'text' ? file.path : '');
                  setReviewOpen(true);
                }}
                className="shrink-0 cursor-pointer whitespace-nowrap rounded border border-[#4176e6]/30 bg-[#eef4ff] px-2.5 py-1 text-xs text-[#315eb8] hover:bg-[#e3edff] disabled:opacity-40"
              >
                整理
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => requestDeleteFile(file)}
                className="shrink-0 cursor-pointer whitespace-nowrap rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
              >
                删除
              </button>
            </>
          )}
        />
      </section>

      <NamePromptDialog
        open={mkdirOpen}
        title="新建文件夹"
        onClose={() => setMkdirOpen(false)}
        onConfirm={(name) => void onMkdirConfirm(name)}
      />
      <NamePromptDialog
        open={renameTarget != null}
        title={renameTarget?.isDir ? '重命名文件夹' : '重命名文件'}
        label={renameTarget?.isDir ? '文件夹名称' : '文件名称'}
        initialValue={renameTarget?.name ?? ''}
        lockExtension={renameTarget != null && !renameTarget.isDir}
        confirmLabel="保存"
        onClose={() => setRenameTarget(null)}
        onConfirm={(name) => void confirmRename(name)}
      />
      <ConfirmDialog
        open={deleteTarget != null}
        title={
          deleteTarget?.blocked ? '无法删除文件夹' : deleteTarget?.isDir ? '删除文件夹' : '删除报告'
        }
        message={deleteMessage}
        confirmLabel={deleteTarget?.blocked ? '知道了' : '删除'}
        cancelLabel="取消"
        danger={!deleteTarget?.blocked}
        hideCancel={Boolean(deleteTarget?.blocked)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
      {activeKind ? (
        <TestReportReviewDrawer
          open={reviewOpen}
          kind={activeKind}
          initialReportPath={reviewPath}
          onClose={() => setReviewOpen(false)}
          onApplied={(receipt) => {
            showToast(receipt.receipt, 'success');
            void refresh(activePath);
          }}
        />
      ) : null}
    </div>
  );
}
