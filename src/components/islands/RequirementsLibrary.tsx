import { useCallback, useEffect, useRef, useState } from 'react';
import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import { docRootLabelPath } from '../../lib/doc-roots';
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
  readDocsText,
  remapPath,
  renameDocs,
  uploadDocsFile,
  type DocsEntry,
  type DocsTreeNode,
} from '../../lib/project-docs';
import ConfirmDialog from './ConfirmDialog';
import DocsPager, { usePageSize } from './DocsPager';
import NamePromptDialog from './NamePromptDialog';
import { showToast } from './Toast';
import { useListAnim } from './useListAnim';

/** 文件列表每页条数默认值（仅文件分页，左侧文件夹树照常全部显示；可在分页条切换并记住） */
const DEFAULT_PAGE_SIZE = 5;

/** 删除确认目标；树的节点没有 type 字段，故用 isDir 统一区分 */
interface DeleteTarget {
  name: string;
  path: string;
  isDir: boolean;
  /** 目录非空被拦截：只提示，不执行删除 */
  blocked?: boolean;
  /** 拦截提示用的递归数量；「全部需求」这类节点无 fileCount 时为 null */
  files?: number | null;
  dirs?: number | null;
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

function PencilIcon({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function TrashIcon({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
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
  /** 「全部需求」箭头的全局展开状态；单个节点未单独切换过时跟随它 */
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

function fmtSize(n?: number) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RequirementsLibrary() {
  const [pluginOn, setPluginOn] = useState(() => isPluginEnabled('requirements'));
  const [pluginReady, setPluginReady] = useState(false);
  const [live, setLive] = useState<boolean | null>(null);
  const [tree, setTree] = useState<DocsTreeNode[]>([]);
  const [totalFiles, setTotalFiles] = useState(0);
  const [activePath, setActivePath] = useState('.');
  const [entries, setEntries] = useState<DocsEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 「全部需求」箭头的全局展开态；默认展开 */
  const [globalOpen, setGlobalOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    name: string;
    path: string;
    isDir: boolean;
  } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = usePageSize(DEFAULT_PAGE_SIZE);
  /** 单击选中的文件（双击才打开，故需要高亮反馈选中了谁） */
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 文件列表入场动画：首屏（刷新）不播，只有用户翻页 / 换目录后才播 */
  const { cls: listAnimCls, play: playListAnim } = useListAnim();

  /** 重新拉取文件夹树（含各目录递归文件数） */
  const loadTree = useCallback(async () => {
    const t = await fetchDocsTree('requirements');
    setTree(t.tree);
    setTotalFiles(t.totalFiles);
  }, []);

  const refresh = useCallback(
    async (dir = activePath) => {
      setError(null);
      try {
        const [listed] = await Promise.all([listDocs('requirements', dir), loadTree()]);
        setEntries(listed.entries);
        setActivePath(listed.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [activePath, loadTree],
  );

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => setPluginOn(Boolean(map.requirements)));
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('requirements'));
      setPluginReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchDocsHealth('requirements');
      setLive(ok);
      if (!ok) return;
      try {
        const [listed] = await Promise.all([listDocs('requirements', '.'), loadTree()]);
        setEntries(listed.entries);
        setActivePath(listed.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [pluginReady, pluginOn, loadTree]);

  /** 「全部需求」箭头：一次性收起/展开整棵树，并清掉各节点的单独覆盖 */
  function toggleAll() {
    setGlobalOpen((v) => !v);
    setExpanded({});
  }

  async function selectDir(p: string) {
    playListAnim();
    setActivePath(p);
    setPage(1);
    setPreview(null);
    setSelectedFile(null);
    setError(null);
    try {
      const listed = await listDocs('requirements', p);
      setEntries(listed.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onMkdirConfirm(name: string) {
    setMkdirOpen(false);
    setBusy(true);
    setError(null);
    try {
      await mkdirDocs('requirements', activePath, name);
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

  async function onOpenLocal(entry: DocsEntry) {
    if (entry.type !== 'file') return;
    setBusy(true);
    setError(null);
    try {
      await openDocsFile('requirements', entry.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        await uploadDocsFile('requirements', activePath, f);
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
      await deleteDocs('requirements', entry.path);
      // 预览内容若位于被删目录内，一并关闭
      if (preview && isPathUnder(preview.path, entry.path)) setPreview(null);
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
      const nextPath = await renameDocs('requirements', target.path, name);
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

  async function onPreview(entry: DocsEntry) {
    if (entry.type !== 'file') return;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.txt')) {
      setError('仅 .md / .txt 支持就地预览；docx / xlsx / csv 请双击用本机程序打开。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await readDocsText('requirements', entry.path);
      setPreview({ path: r.path, content: r.content });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

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
        {pluginDisabledMessage('requirements')}
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
        需求文档库需要本地文档服务，当前未就绪。
      </div>
    );
  }

  const files = entries.filter((e) => e.type === 'file');
  const dirs = entries.filter((e) => e.type === 'dir');
  const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageFiles = files.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  /** 切换每页条数：页码归 1，避免落在越界页 */
  function changePageSize(n: number) {
    playListAnim();
    setPageSizeState(n);
    setPage(1);
  }

  return (
    <div className="flex gap-4 min-h-0">
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
          {/* 「全部需求」= 根目录：点箭头收起/展开整棵树，点名称选中根目录 */}
          <div
            className={`group flex items-center rounded-md ${
              activePath === '.' ? 'bg-[#e8f0fe]' : 'hover:bg-stone-100'
            }`}
            style={{ paddingLeft: 8 }}
          >
            <button
              type="button"
              onClick={() => {
                // 与子文件夹行一致：点名称同时选中根目录并展开/收起整棵树
                void selectDir('.');
                toggleAll();
              }}
              aria-expanded={globalOpen}
              className={`flex-1 min-w-0 flex items-center gap-1.5 py-1.5 pr-1 text-sm text-left ${
                activePath === '.' ? 'text-[#4176e6]' : 'text-stone-600'
              }`}
            >
              {/* 无独立箭头：文件夹图标直接落在原箭头的位置 */}
              <FolderIcon open={globalOpen} className="w-3.5 h-3.5 shrink-0 text-[#4176e6]" />
              <span className="flex-1 min-w-0 truncate">全部需求</span>
              {/* 与子行共用一个右内边距 + 等宽数字，数量列才能竖直对齐 */}
              <span className="shrink-0 tabular-nums text-[11px] text-stone-400">
                ({totalFiles})
              </span>
            </button>
          </div>
          {/* 根行的子节点必须包在可折叠容器里，否则 globalOpen 只改状态、不产生视觉收起 */}
          <div className={`tw-collapse ${globalOpen ? 'is-open' : ''}`}>
            <div className="tw-collapse-inner space-y-1">
              {tree.map((n) => (
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

      <section className="flex-1 min-w-0 rounded-xl border border-stone-200 bg-white flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-stone-100 flex items-center gap-2 flex-wrap">
          <div className="text-sm text-stone-600 flex-1 min-w-0 truncate">
            <span className="text-stone-400">{docRootLabelPath('requirements')}</span>
            {activePath === '.' ? '' : activePath}
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".md,.txt,.docx,.xlsx,.xls,.csv,text/plain,text/markdown,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
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

        {error ? (
          <div className="mx-4 mt-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {error}
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {dirs.length > 0 && (
            <div>
              <div className="text-xs font-medium text-stone-400 mb-2">子文件夹</div>
              <ul className="space-y-1">
                {dirs.map((d) => (
                  <li
                    key={d.path}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-stone-100 hover:bg-stone-50"
                  >
                    <button
                      type="button"
                      className="flex-1 min-w-0 flex items-center gap-2 text-left text-sm text-stone-700"
                      onClick={() => void selectDir(d.path)}
                    >
                      <FolderIcon className="w-4 h-4 text-[#4176e6] shrink-0" />
                      <span className="flex-1 min-w-0 truncate">{d.name}</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`重命名 ${d.name}`}
                      onClick={() => requestRename({ name: d.name, path: d.path }, true)}
                      className="p-1.5 rounded text-stone-400 hover:text-[#4176e6] hover:bg-[#e8f0fe] disabled:opacity-40"
                    >
                      <PencilIcon className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`删除 ${d.name}`}
                      onClick={() => requestDeleteDir({ name: d.name, path: d.path })}
                      className="p-1.5 rounded text-red-600 hover:bg-red-50 disabled:opacity-40"
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="text-xs font-medium text-stone-400 mb-2">文件</div>
            {files.length === 0 ? (
              <p className="text-sm text-stone-400 py-6 text-center border border-dashed border-stone-200 rounded-lg">
                当前文件夹为空，点击「上传文件」添加需求文档（.md / .txt / .docx / .xlsx / .csv）
              </p>
            ) : (
              <ul className={`${listAnimCls}space-y-1`}>
                {pageFiles.map((f) => {
                  const selected = selectedFile === f.path;
                  return (
                    <li
                      key={f.path}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                        selected
                          ? 'border-[#c7dcff] bg-[#e8f0fe]'
                          : 'border-stone-100 hover:bg-stone-50'
                      }`}
                    >
                      <button
                        type="button"
                        className="flex-1 min-w-0 text-left"
                        onClick={() => {
                          setSelectedFile(f.path);
                          void onPreview(f);
                        }}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          void onOpenLocal(f);
                        }}
                      >
                        <div className="text-sm text-stone-800 truncate" data-hint={f.name}>
                          {f.name}
                        </div>
                        <div className="text-[11px] text-stone-400">{fmtSize(f.size)}</div>
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`重命名 ${f.name}`}
                        onClick={() => requestRename({ name: f.name, path: f.path }, false)}
                        className="p-1.5 rounded text-stone-400 hover:text-[#4176e6] hover:bg-[#e8f0fe] disabled:opacity-40"
                      >
                        <PencilIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`删除 ${f.name}`}
                        onClick={() => requestDeleteFile(f)}
                        className="p-1.5 rounded text-red-600 hover:bg-red-50 disabled:opacity-40"
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {preview ? (
            <div className="rounded-lg border border-stone-200 overflow-hidden">
              <div className="px-3 py-2 bg-stone-50 border-b border-stone-200 flex items-center justify-between">
                <span className="text-xs text-stone-500 truncate">{preview.path}</span>
                <button
                  type="button"
                  className="text-xs text-stone-500 hover:text-stone-800"
                  onClick={() => setPreview(null)}
                >
                  关闭预览
                </button>
              </div>
              <pre className="max-h-80 overflow-auto p-4 text-xs leading-5 text-stone-700 whitespace-pre-wrap bg-white">
                {preview.content}
              </pre>
            </div>
          ) : null}
        </div>
        {files.length > 0 ? (
          <DocsPager
            page={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            busy={busy}
            onPage={(p) => {
              playListAnim();
              setPage(p);
            }}
            onPageSize={changePageSize}
          />
        ) : null}
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
          deleteTarget?.blocked
            ? '无法删除文件夹'
            : deleteTarget?.isDir
              ? '删除文件夹'
              : '删除需求文件'
        }
        message={deleteMessage}
        confirmLabel={deleteTarget?.blocked ? '知道了' : '删除'}
        cancelLabel="取消"
        danger={!deleteTarget?.blocked}
        hideCancel={Boolean(deleteTarget?.blocked)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
