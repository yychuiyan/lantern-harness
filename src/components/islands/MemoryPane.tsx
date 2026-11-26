/**
 * 对话区「记忆」Tab：对齐 dsh memory 导航（指南 / 待确认记忆建议 / 各轨 md）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAgentInstructions, openFsPath } from '../../lib/fs-tools';
import { loadAccessLevel } from '../../lib/settings';
import {
  applySuggestionBatch,
  approveSuggestion,
  archiveEntry,
  createSuggestionBatchDraft,
  deleteArchiveEntry,
  deleteMemoryEntry,
  fetchArchives,
  fetchMemoryConfig,
  fetchMemoryHealth,
  fetchMemoryTracks,
  fetchSuggestionReviewContext,
  manualAddMemory,
  promoteArchive,
  rejectSuggestion,
  saveMemoryConfig,
  type MemoryConfig,
  type MemoryEntry,
  type MemoryHealth,
  type MemorySuggestion,
  type MemorySuggestionBatchDraft,
  type MemoryTrack,
  type MemoryTrackData,
} from '../../lib/memory';
import ConfirmDialog from './ConfirmDialog';
import { showToast } from './Toast';

type VisibleTrack = 'memory' | 'key' | 'project';
type TabId = VisibleTrack | 'guide' | 'suggestions' | 'agents' | 'archive' | 'settings';

const TRACK_LABEL: Record<string, string> = {
  user: '用户档案',
  memory: '长期记忆',
  key: '项目关键记忆',
  project: '项目日志',
};

function shortPath(p: string | null | undefined): string {
  if (!p) return '';
  const n = p.replace(/\\/g, '/');
  return n.replace(/^\/Users\/[^/]+/, '~');
}

const TRACK_META: Record<
  VisibleTrack,
  { title: string; fileHint: string; desc: string; curated: boolean }
> = {
  project: {
    title: '项目日志',
    fileHint: 'MEMORY.md',
    desc: '项目进展流水账，按需查阅，默认不注入上下文。',
    curated: false,
  },
  key: {
    title: '项目关键记忆',
    fileHint: 'KEY.md',
    desc: '项目关键约定与事实；写入需经待确认记忆建议采纳后注入。',
    curated: true,
  },
  memory: {
    title: '长期记忆',
    fileHint: 'MEMORY.md',
    desc: '全局环境与跨项目事实，注入所有会话；写入需审查建议并经确认。',
    curated: true,
  },
};

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'guide', label: '指南' },
  { id: 'suggestions', label: '待确认记忆建议' },
  { id: 'project', label: '项目日志' },
  { id: 'key', label: '项目关键记忆 KEY.md' },
  { id: 'memory', label: '长期记忆 MEMORY.md' },
  { id: 'agents', label: '全局规则 AGENTS.md' },
  { id: 'archive', label: '归档' },
  { id: 'settings', label: '设置' },
];

interface Props {
  live: boolean;
  pluginOn: boolean;
  workspacePath?: string;
  /** 待确认队列 / 健康信息变化时通知外层（刷新「记忆」Tab 角标） */
  onHealthChange?: (health: MemoryHealth | null) => void;
}

export default function MemoryPane({ live, pluginOn, workspacePath = '', onHealthChange }: Props) {
  const [tab, setTab] = useState<TabId>('suggestions');
  const [health, setHealth] = useState<MemoryHealth | null>(null);
  const [tracks, setTracks] = useState<Record<string, MemoryTrackData>>({});
  const [projectId, setProjectId] = useState('');
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([]);
  const [suggestionRevision, setSuggestionRevision] = useState('');
  const [suggestionDuplicates, setSuggestionDuplicates] = useState<Record<string, string>>({});
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());
  const [suggestionDraft, setSuggestionDraft] = useState<MemorySuggestionBatchDraft | null>(null);
  const [allowSuggestionDuplicates, setAllowSuggestionDuplicates] = useState(false);
  const [suggestionBatchBusy, setSuggestionBatchBusy] = useState(false);
  const [archives, setArchives] = useState<MemoryEntry[]>([]);
  const [archiveTarget, setArchiveTarget] = useState<'user' | 'memory' | 'key'>('memory');
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [agentFiles, setAgentFiles] = useState<
    Array<{ path: string; name: string; abs?: string; label?: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [archiveIndex, setArchiveIndex] = useState<number | null>(null);
  const [purgeArchiveIndex, setPurgeArchiveIndex] = useState<number | null>(null);

  const cwd = workspacePath.trim();
  const onHealthChangeRef = useRef(onHealthChange);
  onHealthChangeRef.current = onHealthChange;

  const refresh = useCallback(async () => {
    if (!live) {
      setHealth(null);
      setTracks({});
      setSuggestions([]);
      setAgentFiles([]);
      onHealthChangeRef.current?.(null);
      return;
    }
    setError(null);
    try {
      const [h, t, s, cfg, agents] = await Promise.all([
        fetchMemoryHealth(),
        fetchMemoryTracks(cwd, 'all'),
        fetchSuggestionReviewContext(),
        fetchMemoryConfig(),
        fetchAgentInstructions().catch(() => null),
      ]);
      setHealth(h);
      setTracks(t.tracks);
      setProjectId(t.projectId || '');
      setSuggestions(s.suggestions);
      setSuggestionRevision(s.revision);
      setSuggestionDuplicates(s.duplicates);
      setSelectedSuggestions((prev) => {
        const live = new Set(s.suggestions.map((item) => item.id));
        return new Set([...prev].filter((id) => live.has(id)));
      });
      setConfig(cfg);
      setAgentFiles(
        agents?.files?.length
          ? agents.files
          : agents?.text
            ? [{ path: 'AGENTS.md', name: 'AGENTS.md' }]
            : [],
      );
      if (tab === 'archive') {
        setArchives(await fetchArchives(archiveTarget, cwd));
      }
      onHealthChangeRef.current?.(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [live, cwd, tab, archiveTarget]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!pluginOn) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <p className="text-sm text-stone-600">会话记忆未启用</p>
        <p className="mt-1 text-xs text-stone-400">
          在「我的插件」中打开「会话记忆」后，可在此管理记忆轨与待确认记忆建议
        </p>
      </div>
    );
  }

  if (!live) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <p className="text-sm text-stone-600">会话记忆中间件未就绪</p>
        <p className="mt-1 text-xs text-stone-400">本地记忆服务未就绪</p>
      </div>
    );
  }

  const curated = tab === 'memory' || tab === 'key';
  const isTrack = tab === 'memory' || tab === 'key' || tab === 'project';
  const entries = isTrack ? (tracks[tab]?.entries ?? []) : [];
  const trackPath = isTrack ? tracks[tab]?.path : null;
  const memBase = health?.path || '.lantern/local/memories';

  async function onApprove(id: string) {
    setBusy(true);
    try {
      await approveSuggestion(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReject(id: string) {
    setBusy(true);
    try {
      await rejectSuggestion(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleSuggestion(id: string) {
    setSuggestionDraft(null);
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllSuggestions() {
    setSuggestionDraft(null);
    setSelectedSuggestions((prev) =>
      prev.size === suggestions.length ? new Set() : new Set(suggestions.map((item) => item.id)),
    );
  }

  async function previewSuggestionBatch(action: 'approve' | 'reject') {
    if (!selectedSuggestions.size || suggestionBatchBusy) return;
    setSuggestionBatchBusy(true);
    setError(null);
    try {
      const draft = await createSuggestionBatchDraft({
        ids: [...selectedSuggestions],
        action,
        expectedRevision: suggestionRevision,
        allowDuplicates: allowSuggestionDuplicates,
      });
      setSuggestionDraft(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggestionBatchBusy(false);
    }
  }

  async function applySuggestionDraft() {
    if (!suggestionDraft || suggestionBatchBusy) return;
    setSuggestionBatchBusy(true);
    setError(null);
    try {
      const receipt = await applySuggestionBatch({
        ids: suggestionDraft.selected.map((item) => item.id),
        action: suggestionDraft.action,
        expectedRevision: suggestionDraft.revision,
        draftId: suggestionDraft.draftId,
        allowDuplicates: allowSuggestionDuplicates,
      });
      setSuggestionDraft(null);
      setSelectedSuggestions(new Set());
      showToast(receipt.receipt, 'success');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggestionBatchBusy(false);
    }
  }

  function onArchive(index: number) {
    if (!curated) return;
    setArchiveIndex(index);
  }

  async function confirmArchive() {
    if (archiveIndex == null || !curated) return;
    const index = archiveIndex;
    setArchiveIndex(null);
    setBusy(true);
    try {
      await archiveEntry(tab as MemoryTrack, index, cwd);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPurgeArchive() {
    if (purgeArchiveIndex == null) return;
    const index = purgeArchiveIndex;
    setPurgeArchiveIndex(null);
    setBusy(true);
    try {
      await deleteArchiveEntry(archiveTarget, index, cwd);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onDelete(index: number) {
    setDeleteIndex(index);
  }

  async function confirmDelete() {
    if (deleteIndex == null) return;
    const index = deleteIndex;
    setDeleteIndex(null);
    setBusy(true);
    try {
      await deleteMemoryEntry(tab as MemoryTrack, index, cwd);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onManualAdd() {
    if (!curated || !draft.trim()) return;
    setBusy(true);
    try {
      await manualAddMemory(tab as 'memory' | 'key', draft.trim(), cwd);
      setDraft('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveConfig(patch: Partial<MemoryConfig>) {
    setBusy(true);
    try {
      const next = await saveMemoryConfig(patch);
      setConfig(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function renderTrackHeader(track: VisibleTrack) {
    const meta = TRACK_META[track];
    const fileLabel = track === 'key' ? 'KEY.md' : meta.fileHint;
    const title =
      track === 'key'
        ? `项目关键记忆 ${fileLabel}`
        : track === 'memory'
          ? `长期记忆 ${fileLabel}`
          : meta.title;
    const pathShow = shortPath(trackPath) || `${shortPath(memBase)}/…/${fileLabel}`;
    return (
      <div className="mb-3 space-y-1.5">
        <div className="flex items-start gap-2 flex-wrap min-w-0">
          <h3 className="text-sm font-semibold text-stone-800">{title}</h3>
          {!meta.curated ? (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-stone-100 text-stone-500 border border-stone-200">
              只读追加
            </span>
          ) : null}
          <span className="text-[11px] text-stone-400 tabular-nums">{entries.length} 条</span>
          <span
            className="max-w-full break-all whitespace-normal text-[11px] text-[#4176e6] bg-[#edf3fe] border border-[#4176e6]/20 rounded-lg px-2 py-0.5 font-mono leading-4"
            data-hint={trackPath || pathShow}
          >
            {pathShow}
          </span>
        </div>
        <p className="text-xs text-stone-500 leading-5 break-words">{meta.desc}</p>
        {cwd ? (
          <p className="text-[11px] text-stone-400 break-all">
            当前会话工作目录：<span className="font-mono">{cwd}</span>
            {projectId ? (
              <>
                {' · '}项目 id <span className="font-mono">{projectId.slice(0, 12)}</span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-stone-200/80 px-4 py-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`h-7 shrink-0 px-2.5 text-xs rounded-md whitespace-nowrap text-left leading-tight ${
              tab === t.id ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
            }`}
          >
            {t.label}
            {t.id === 'suggestions' && suggestions.length > 0 ? (
              <span className="ml-1 tabular-nums">({suggestions.length})</span>
            ) : null}
          </button>
        ))}
        <span className="text-[11px] text-stone-400 tabular-nums">
          {health?.entryCount ?? 0} 条 · 待确认 {health?.suggestionCount ?? suggestions.length}
        </span>
      </div>

      {error ? (
        <div className="mx-4 mt-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
          {error}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {tab === 'guide' ? (
          <div className="space-y-3 max-w-2xl">
            <section className="rounded-xl border border-stone-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-stone-800">确认制：为什么必须你点头</h3>
              <p className="mt-1.5 text-xs text-stone-500 leading-5">
                记忆会改变后续对话行为。长期记忆 /
                项目关键记忆经「待确认记忆建议」采纳后才写入并注入；项目日志可直写但不注入。
              </p>
            </section>
            <section className="rounded-xl border border-stone-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-stone-800">
                待确认记忆建议：AI 只提议，你拍板
              </h3>
              <p className="mt-1.5 text-xs text-stone-500 leading-5">
                后台或对话中产出的记忆建议进入独立队列。采纳可写入对应轨；拒绝则丢弃。
              </p>
              <ul className="mt-2 space-y-1.5 text-xs text-stone-600">
                <li className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2 break-words">
                  采纳 → 长期记忆 MEMORY.md / 项目关键记忆 KEY.md
                </li>
                <li className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2">
                  拒绝 → 丢弃，不落盘
                </li>
              </ul>
            </section>
            <section className="rounded-xl border border-stone-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-stone-800">各轨文件（对齐 dsh）</h3>
              <ul className="mt-2 space-y-1.5 text-xs text-stone-600">
                <li className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2">
                  项目日志 · 项目目录 MEMORY.md（不注入）
                </li>
                <li className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2">
                  项目关键记忆 KEY.md（注入，需确认）
                </li>
                <li className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2">
                  长期记忆 MEMORY.md（注入，需确认）
                </li>
                <li className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2">
                  全局规则：展示工作区 AGENTS.md 等规则文件
                </li>
              </ul>
            </section>
            <section className="rounded-xl border border-stone-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-stone-800">编辑与维护</h3>
              <p className="mt-1.5 text-xs text-stone-500 leading-5">
                可在本 Tab 浏览条目、手动添加（注入轨）、归档或删除。文件为 §
                分隔结构化记忆，用外部编辑器打开时请谨慎修改。
              </p>
              <p className="mt-2 text-[11px] text-amber-700/90">
                存储目录：<code className="font-mono">{memBase}</code>
              </p>
            </section>
          </div>
        ) : null}

        {tab === 'suggestions' ? (
          <div className="space-y-3">
            <div className="flex flex-col gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-stone-800">待确认记忆建议</h3>
                <p className="mt-1 text-xs text-stone-500 leading-5">
                  勾选后可先预览作用范围、重复内容和目标记忆轨；确认后一次性采纳或拒绝。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!suggestions.length || suggestionBatchBusy}
                  onClick={toggleAllSuggestions}
                  className="h-7 rounded-md border border-stone-200 bg-white px-2.5 text-[11px] text-stone-600 hover:bg-stone-50 disabled:opacity-40"
                >
                  {selectedSuggestions.size === suggestions.length ? '清空选择' : '全选'}
                </button>
                <button
                  type="button"
                  disabled={
                    !selectedSuggestions.size || suggestionBatchBusy || Boolean(suggestionDraft)
                  }
                  onClick={() => void previewSuggestionBatch('approve')}
                  className="h-7 rounded-md bg-emerald-600 px-2.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  预览采纳
                </button>
                <button
                  type="button"
                  disabled={
                    !selectedSuggestions.size || suggestionBatchBusy || Boolean(suggestionDraft)
                  }
                  onClick={() => void previewSuggestionBatch('reject')}
                  className="h-7 rounded-md border border-stone-200 bg-white px-2.5 text-[11px] text-stone-600 hover:bg-stone-50 disabled:opacity-40"
                >
                  预览拒绝
                </button>
              </div>
            </div>

            {selectedSuggestions.size ? (
              <label className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[11px] text-stone-600">
                <input
                  type="checkbox"
                  checked={allowSuggestionDuplicates}
                  onChange={(event) => {
                    setAllowSuggestionDuplicates(event.target.checked);
                    setSuggestionDraft(null);
                  }}
                  className="h-4 w-4 accent-[#4176e6]"
                />
                目标轨已有相同内容时仍允许采纳（默认拦截，避免重复注入）
                <span className="ml-auto tabular-nums text-stone-400">
                  已选 {selectedSuggestions.size}
                </span>
              </label>
            ) : null}

            {suggestionDraft ? (
              <section className="rounded-xl border border-emerald-200 bg-emerald-50/35 p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h4 className="text-xs font-semibold text-emerald-950">批量预览</h4>
                    <p className="mt-1 text-[11px] leading-5 text-emerald-800">
                      {suggestionDraft.summary}
                    </p>
                  </div>
                  <span className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] text-emerald-700">
                    {suggestionDraft.action === 'approve' ? '采纳' : '拒绝'}
                  </span>
                </div>
                <ul className="mt-2 max-h-44 space-y-1.5 overflow-y-auto pr-1">
                  {suggestionDraft.selected.map((item) => (
                    <li
                      key={item.id}
                      className="rounded-lg border border-emerald-200/70 bg-white px-2.5 py-2 text-xs text-stone-700"
                    >
                      <span className="mr-1 text-[10px] text-stone-400">
                        {TRACK_LABEL[item.target] ?? item.target}
                      </span>
                      <span className="break-words">{item.content}</span>
                    </li>
                  ))}
                </ul>
                {suggestionDraft.duplicates.length ? (
                  <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-5 text-amber-800">
                    {suggestionDraft.duplicates.length} 条内容已存在于目标轨，已按“允许重复”处理。
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    disabled={suggestionBatchBusy}
                    onClick={() => setSuggestionDraft(null)}
                    className="h-7 rounded-md border border-stone-200 bg-white px-2.5 text-[11px] text-stone-600 hover:bg-stone-50 disabled:opacity-40"
                  >
                    返回修改
                  </button>
                  <button
                    type="button"
                    disabled={suggestionBatchBusy}
                    onClick={() => void applySuggestionDraft()}
                    className="h-7 rounded-md bg-emerald-600 px-2.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    {suggestionBatchBusy
                      ? '处理中…'
                      : suggestionDraft.action === 'approve'
                        ? '确认采纳'
                        : '确认拒绝'}
                  </button>
                </div>
              </section>
            ) : null}

            {suggestions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50/50 px-4 py-16 text-center text-sm text-stone-400">
                没有待确认的建议。
              </div>
            ) : (
              <ul className="space-y-3">
                {suggestions.map((s) => (
                  <li
                    key={s.id}
                    className={`rounded-lg border p-3 ${
                      selectedSuggestions.has(s.id)
                        ? 'border-[#4176e6]/50 bg-[#f5f8ff]'
                        : 'border-amber-200/80 bg-amber-50/30'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-[11px] text-stone-400 mb-1 flex-wrap">
                      <input
                        type="checkbox"
                        checked={selectedSuggestions.has(s.id)}
                        onChange={() => toggleSuggestion(s.id)}
                        aria-label={`选择记忆建议：${s.content.slice(0, 40)}`}
                        className="h-4 w-4 accent-[#4176e6]"
                      />
                      <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-200 font-medium">
                        待确认记忆建议
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-white text-stone-600 border border-stone-200">
                        {TRACK_LABEL[s.target] ?? s.target}
                      </span>
                      <span>{s.time}</span>
                      {s.hits && s.hits > 1 ? <span>×{s.hits}</span> : null}
                    </div>
                    <p className="text-sm text-stone-800 whitespace-pre-wrap">{s.content}</p>
                    {s.reason ? (
                      <p className="mt-1 text-xs text-stone-500">原因：{s.reason}</p>
                    ) : null}
                    {suggestionDuplicates[s.id] ? (
                      <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                        目标轨已有相同内容；批量采纳默认会拦截。
                      </p>
                    ) : null}
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        disabled={busy || suggestionBatchBusy || Boolean(suggestionDraft)}
                        onClick={() => void onApprove(s.id)}
                        className="h-7 px-2.5 text-xs text-white bg-emerald-600 rounded-md hover:bg-emerald-700 disabled:opacity-40"
                      >
                        采纳
                      </button>
                      <button
                        type="button"
                        disabled={busy || suggestionBatchBusy || Boolean(suggestionDraft)}
                        onClick={() => void onReject(s.id)}
                        className="h-7 px-2.5 text-xs text-stone-600 border border-stone-200 rounded-md hover:bg-stone-50 disabled:opacity-40"
                      >
                        拒绝
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {isTrack ? (
          <div className="space-y-3">
            {renderTrackHeader(tab as VisibleTrack)}
            {curated ? (
              <div className="rounded-xl border border-stone-200 bg-white p-3 space-y-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={
                    tab === 'key'
                      ? '输入一条项目关键约定，例如：本仓库包管理器用 pnpm…'
                      : '输入一条想长期记住的全局事实/惯例/环境…'
                  }
                  rows={3}
                  className="w-full text-sm rounded-lg border border-stone-200 px-3 py-2 focus:outline-none focus:border-[#4176e6] resize-y"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-stone-400">
                    手动写入会直接落盘；重要偏好更推荐走「待确认记忆建议」。
                  </p>
                  <button
                    type="button"
                    disabled={busy || !draft.trim()}
                    onClick={() => void onManualAdd()}
                    className="shrink-0 h-8 px-3 text-xs text-white bg-[#4176e6] rounded-lg disabled:opacity-40"
                  >
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-stone-400">
                本轨由对话中 memory_append 自动追加，一般不注入上下文。
              </p>
            )}
            {entries.length === 0 ? (
              <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50/50 px-4 py-12 text-center text-sm text-stone-400">
                （文件不存在或为空）
              </div>
            ) : (
              <ul className="space-y-2">
                {entries.map((e) => (
                  <li
                    key={`${tab}-${e.index}`}
                    className="rounded-lg border border-stone-200 bg-white px-3 py-2.5 flex gap-2"
                  >
                    <p className="flex-1 text-sm text-stone-800 whitespace-pre-wrap">{e.text}</p>
                    <div className="shrink-0 self-start flex flex-col gap-0.5">
                      {curated ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onArchive(e.index)}
                          className="h-7 px-2 text-[11px] text-stone-500 hover:bg-stone-50 rounded-md"
                        >
                          归档
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onDelete(e.index)}
                        className="h-7 px-2 text-[11px] text-red-600 hover:bg-red-50 rounded-md"
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {tab === 'agents' ? (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-stone-800">全局规则</h3>
            <p className="text-xs text-stone-500 leading-5">
              工作区规则文件（AGENTS.md 等），随系统提示注入。
            </p>
            {agentFiles.length === 0 ? (
              <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50/50 px-4 py-12 text-center text-sm text-stone-400">
                （未找到规则文件）
              </div>
            ) : (
              <ul className="space-y-2 w-full">
                {agentFiles.map((f) => {
                  const displayPath =
                    shortPath(f.abs) || shortPath(f.path) || f.label || f.path || f.name;
                  return (
                    <li key={f.abs || f.path} className="w-full">
                      <div className="w-full flex items-center gap-4 rounded-xl border border-stone-200 bg-white px-4 py-3.5">
                        <span className="w-12 h-12 rounded-xl bg-[#edf3fe] text-[#4176e6] flex items-center justify-center text-[11px] font-semibold shrink-0">
                          {(f.name.split('.').pop() || 'MD').toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] font-medium text-stone-800 break-all">
                            {f.name || 'AGENTS.md'}
                          </span>
                          <span className="block text-xs text-stone-400 break-all font-mono mt-1">
                            {displayPath}
                          </span>
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setError(null);
                            setBusy(true);
                            void openFsPath(f.path || f.name || 'AGENTS.md', loadAccessLevel(), {
                              abs: f.abs,
                            })
                              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                              .finally(() => setBusy(false));
                          }}
                          className="shrink-0 h-9 px-4 text-xs text-[#4176e6] border border-[#4176e6]/30 rounded-lg hover:bg-[#f5f8ff] disabled:opacity-40"
                        >
                          打开文件
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {tab === 'archive' ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              {(['user', 'memory', 'key'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setArchiveTarget(t);
                  }}
                  className={`h-7 px-2.5 text-xs rounded-md ${
                    archiveTarget === t ? 'bg-stone-800 text-white' : 'border border-stone-200'
                  }`}
                >
                  {TRACK_LABEL[t] ?? t}
                </button>
              ))}
            </div>
            {archives.length === 0 ? (
              <p className="text-sm text-stone-400 text-center py-10">暂无归档</p>
            ) : (
              <ul className="space-y-2">
                {archives.map((e) => (
                  <li
                    key={`a-${e.index}`}
                    className="rounded-lg border border-stone-200 bg-white px-3 py-2.5 flex gap-2"
                  >
                    <p className="flex-1 text-sm text-stone-800 whitespace-pre-wrap">{e.text}</p>
                    <div className="shrink-0 self-start flex flex-col gap-0.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void (async () => {
                            setBusy(true);
                            try {
                              await promoteArchive(archiveTarget, e.index, cwd);
                              await refresh();
                            } catch (err) {
                              setError(err instanceof Error ? err.message : String(err));
                            } finally {
                              setBusy(false);
                            }
                          })()
                        }
                        className="h-7 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50 rounded-md"
                      >
                        转正
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setPurgeArchiveIndex(e.index)}
                        className="h-7 px-2 text-[11px] text-red-600 hover:bg-red-50 rounded-md"
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {tab === 'settings' && config ? (
          <div className="space-y-4 max-w-md">
            <label className="flex items-center justify-between gap-3 text-sm text-stone-700">
              <span>每回合注入 USER / MEMORY / KEY</span>
              <input
                type="checkbox"
                checked={config.injectMemory}
                onChange={(e) => void onSaveConfig({ injectMemory: e.target.checked })}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm text-stone-700">
              <span>收尾提示写 project</span>
              <input
                type="checkbox"
                checked={config.perTurnProjectWrites}
                onChange={(e) => void onSaveConfig({ perTurnProjectWrites: e.target.checked })}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm text-stone-700">
              <span>重要事实用 suggest（KEY）</span>
              <input
                type="checkbox"
                checked={config.perTurnKeyWrites}
                onChange={(e) => void onSaveConfig({ perTurnKeyWrites: e.target.checked })}
              />
            </label>
            <p className="text-xs text-stone-400 leading-5 break-all">
              存储目录：
              <code className="font-mono">{health?.path ?? '.lantern/local/memories'}</code>
              。memory/key 经待确认记忆建议后注入；project 不注入。
            </p>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={deleteIndex != null}
        title="删除记忆"
        message="永久删除该条目？此操作不可恢复。"
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setDeleteIndex(null)}
        onConfirm={() => void confirmDelete()}
      />
      <ConfirmDialog
        open={archiveIndex != null}
        title="归档记忆"
        message="归档该条目？归档后不再注入上下文。"
        confirmLabel="归档"
        cancelLabel="取消"
        onClose={() => setArchiveIndex(null)}
        onConfirm={() => void confirmArchive()}
      />
      <ConfirmDialog
        open={purgeArchiveIndex != null}
        title="删除归档"
        message="永久删除该归档？此操作不可恢复。"
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setPurgeArchiveIndex(null)}
        onConfirm={() => void confirmPurgeArchive()}
      />
    </div>
  );
}
