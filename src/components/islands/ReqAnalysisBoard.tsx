/**
 * 需求分析工作台。
 *
 * 左栏：来源需求文档、历史分析、提示词状态、动作与活动日志；
 * 右栏：故事卡片 / 体检报告 / 需求条目。
 *
 * 模型在浏览器里跑（`streamChatWithTools`），工具通过 HTTP 落到
 * `/__tb_reqanalysis`。故事与条目在每次工具调用后立即落盘，中途离开
 * 只中断当前这一批，已经写好的内容保留。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { hydrateAppConfig } from '../../lib/app-config';
import { clearHydrateCache } from '../../lib/hydrate-cache';
import { streamChatWithTools, type ChatMessage } from '../../lib/llm';
import { pluginDisabledMessage } from '../../lib/plugins';
import {
  auditStories,
  createReqDoc,
  deleteReqDoc,
  exportFileName,
  fetchReqAnalysisHealth,
  fetchReqPrompt,
  listReqDocs,
  listReqSources,
  mergeStories,
  preserveGapSelection,
  readReqSource,
  REQ_ANALYSIS_DIR,
  REQ_ANALYSIS_PROMPT_FILE,
  REQ_STATUS_META,
  sourceHashOf,
  splitRequirementSections,
  syncReqPrompt,
  toMarkdown,
  updateReqDoc,
  type ReqAnalysisDoc,
  type ReqDocPatch,
  type ReqOutlineItem,
  type ReqPrompt,
  type ReqSourceFile,
  type ReqStory,
} from '../../lib/req-analysis';
import {
  REQ_ANALYSIS_TOOLS,
  REQ_TOOL_GUIDE,
  parseStoriesFallback,
  runReqAnalysisTool,
  type ReqToolContext,
} from '../../lib/req-analysis-tools';
import {
  loadSettings,
  onSettingsChanged,
  openSettings,
  type LLMSettings,
} from '../../lib/settings';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import { PmEmptyState, PmIcon, PmLoading, PmNotice, PmTag, usePmPlugin } from './PmShared';
import ReqCheckPanel from './ReqCheckPanel';
import ReqStoryCard from './ReqStoryCard';
import SelectDropdown, { type SelectOption } from './SelectDropdown';
import { showToast } from './Toast';

const DOC_PREF = 'reqanalysis.doc';
/** 列表页的视图：按需求说明书 / 按用户故事（记忆） */
const LIST_MODE_PREF = 'reqanalysis.listmode';
type TabId = 'stories' | 'check' | 'outline';
type ListMode = 'doc' | 'story';

/** 去掉扩展名：word / excel / md 都适用 */
const SOURCE_EXT = /\.[a-z0-9]+$/i;
/** 页面里能看到的来源格式（含暂不支持拆解的，给一行说明） */
const SOURCE_LABEL: Record<string, string> = {
  md: 'Markdown',
  markdown: 'Markdown',
  txt: '文本',
  csv: 'CSV',
  docx: 'Word',
  xlsx: 'Excel',
  xls: 'Excel',
  doc: 'Word（旧版）',
  pdf: 'PDF',
  ppt: 'PPT',
  pptx: 'PPT',
};

const BTN_PRIMARY =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[#3370ff] px-3.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const BTN_SECONDARY =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-stone-200 bg-white px-3 text-sm text-stone-700 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50';
const SECTION_TITLE = 'text-xs font-semibold tracking-wide text-stone-500';

interface ActivityItem {
  id: number;
  kind: 'info' | 'tool' | 'done' | 'error';
  text: string;
  at: string;
}

function fileName(path: string): string {
  return path.split('/').pop() || path;
}

function stripExt(name: string): string {
  return name.replace(SOURCE_EXT, '');
}

function sourceFormat(file: ReqSourceFile): string {
  return (file.format || fileName(file.path).split('.').pop() || '').toLowerCase();
}

/** 列表里的时间列：只到分钟，跨年才带年份 */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.getFullYear() === new Date().getFullYear() ? md : `${at.getFullYear()}/${md}`;
}

function sortDocs(list: ReqAnalysisDoc[]): ReqAnalysisDoc[] {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export default function ReqAnalysisBoard() {
  const gate = usePmPlugin('reqAnalysis');
  const [live, setLive] = useState<boolean | null>(null);
  const [docs, setDocs] = useState<ReqAnalysisDoc[]>([]);
  const [docId, setDocId] = useState('');
  const [doc, setDoc] = useState<ReqAnalysisDoc | null>(null);
  const [sources, setSources] = useState<ReqSourceFile[]>([]);
  const [sourcePick, setSourcePick] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [prompt, setPrompt] = useState<ReqPrompt | null>(null);
  const [busy, setBusy] = useState<null | 'decompose' | 'audit' | 'fix'>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<TabId>('stories');
  /**
   * 列表 / 工作台两屏。
   * 进页面先看分析列表（每次进来都是列表，不记忆上次停在哪份分析里），
   * 点某条的「用户故事」才进工作台拆解；工作台左上角能退回列表。
   */
  const [view, setView] = useState<'list' | 'work'>('list');
  /** 列表子视图：需求说明书列表 / 扁平用户故事列表 */
  const [listMode, setListMode] = useState<ListMode>(() =>
    readViewPref(LIST_MODE_PREF, ['doc', 'story'] as const, 'doc'),
  );
  const [storyKeyword, setStoryKeyword] = useState('');
  /** 故事视图里勾选的故事（只允许来自同一份分析，便于带进用例生成） */
  const [pickedStories, setPickedStories] = useState<{ docId: string; ids: string[] } | null>(null);
  /** 折叠的文档分组（按 doc.id） */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  /** 从故事视图跳进工作台后要滚到的那条故事 */
  const focusStoryRef = useRef('');
  const [sourceHash, setSourceHash] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDecompose, setConfirmDecompose] = useState(false);

  const docRef = useRef<ReqAnalysisDoc | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activityIdRef = useRef(0);
  const activityBoxRef = useRef<HTMLDivElement | null>(null);
  const checkSaveRef = useRef<number | null>(null);

  /** 来源下拉：能拆解的排前面，暂不支持的置灰（仍然列出来，说明为什么不能选） */
  const sourceOptions = useMemo<SelectOption[]>(() => {
    const rank = (file: ReqSourceFile) => (file.supported ? 0 : 1);
    return [...sources]
      .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, 'zh'))
      .map((file) => {
        const format = sourceFormat(file);
        const label = SOURCE_LABEL[format] ?? format.toUpperCase();
        return {
          value: file.path,
          label: file.path,
          secondary: file.supported ? format : `${label} · 暂不支持，请另存为 .docx / .xlsx / .md`,
          disabled: !file.supported,
        };
      });
  }, [sources]);

  const patchDoc = useCallback((next: ReqAnalysisDoc) => {
    docRef.current = next;
    setDoc(next);
    setDocs((prev) => sortDocs(prev.map((item) => (item.id === next.id ? next : item))));
  }, []);

  const pushActivity = useCallback((text: string, kind: ActivityItem['kind'] = 'info') => {
    activityIdRef.current += 1;
    setActivity((prev) => [
      ...prev,
      { id: activityIdRef.current, kind, text, at: new Date().toISOString() },
    ]);
  }, []);

  const loadDoc = useCallback((next: ReqAnalysisDoc | null) => {
    docRef.current = next;
    setDoc(next);
    setDocId(next?.id ?? '');
    writeViewText(DOC_PREF, next?.id ?? '');
    if (next?.sourcePath) setSourcePick(next.sourcePath);
  }, []);

  /**
   * 进工作台看某份分析：加载数据、可指定落到哪个页签。
   * 顺手清掉刷新缓存——缓存里如果是列表，切进工作台后它会在挂载前闪一下。
   */
  const openDoc = useCallback(
    (next: ReqAnalysisDoc, nextTab: TabId = 'stories') => {
      loadDoc(next);
      setTab(nextTab);
      setView('work');
      clearHydrateCache('req-analysis');
    },
    [loadDoc],
  );

  /** 从「按用户故事」列表跳进工作台：定位到那条故事卡片 */
  const openStory = useCallback(
    (next: ReqAnalysisDoc, storyId: string) => {
      focusStoryRef.current = storyId;
      openDoc(next, 'stories');
    },
    [openDoc],
  );

  /* 进工作台后滚到目标故事并短暂高亮（等故事卡片渲染完） */
  useEffect(() => {
    if (view !== 'work' || !focusStoryRef.current) return;
    const storyId = focusStoryRef.current;
    focusStoryRef.current = '';
    let timer = 0;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`req-story-${storyId}`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('tw-req-story-focus');
      timer = window.setTimeout(() => el.classList.remove('tw-req-story-focus'), 1600);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
    };
  }, [view, doc?.id]);

  /** 故事视图：扁平化成「分析记录 × 故事」，按编号 / 标题 / 角色 / 目标 / 文档名搜索 */
  const allStoryRows = useMemo(
    () => docs.flatMap((item) => item.stories.map((story) => ({ doc: item, story }))),
    [docs],
  );
  const storyTotal = allStoryRows.length;

  const storyGroups = useMemo(() => {
    const kw = storyKeyword.trim().toLowerCase();
    const hit = (v: unknown) =>
      String(v ?? '')
        .toLowerCase()
        .includes(kw);
    const rows: Array<{ doc: ReqAnalysisDoc; story: ReqStory }> = kw
      ? allStoryRows.filter(
          ({ doc: item, story }) =>
            hit(story.id) ||
            hit(story.title) ||
            hit(story.role) ||
            hit(story.goal) ||
            hit(item.title),
        )
      : allStoryRows;
    const groups: Array<{ doc: ReqAnalysisDoc; rows: typeof rows }> = [];
    const index = new Map<string, number>();
    for (const row of rows) {
      const at = index.get(row.doc.id);
      if (at === undefined) {
        index.set(row.doc.id, groups.length);
        groups.push({ doc: row.doc, rows: [row] });
      } else {
        groups[at]!.rows.push(row);
      }
    }
    return groups.sort((a, b) => b.doc.updatedAt.localeCompare(a.doc.updatedAt));
  }, [allStoryRows, storyKeyword]);

  const pickedSet = useMemo(() => new Set(pickedStories?.ids ?? []), [pickedStories]);

  /** 勾选只允许来自同一份分析：换了文档就重新开始选 */
  const toggleStoryPick = useCallback((nextDocId: string, storyId: string) => {
    setPickedStories((prev) => {
      if (!prev || prev.docId !== nextDocId) return { docId: nextDocId, ids: [storyId] };
      const ids = prev.ids.includes(storyId)
        ? prev.ids.filter((x) => x !== storyId)
        : [...prev.ids, storyId];
      return ids.length ? { docId: nextDocId, ids } : null;
    });
  }, []);

  const toggleGroupPick = useCallback((nextDocId: string, ids: string[]) => {
    setPickedStories((prev) => {
      if (prev?.docId === nextDocId && ids.every((id) => prev.ids.includes(id))) return null;
      return ids.length ? { docId: nextDocId, ids } : null;
    });
  }, []);

  const setListModePref = useCallback((mode: ListMode) => {
    setListMode(mode);
    writeViewPref(LIST_MODE_PREF, mode);
  }, []);

  /* ------------------------------ 首屏 ------------------------------ */

  useEffect(() => {
    let alive = true;
    void (async () => {
      await hydrateAppConfig();
      if (!alive) return;
      setSettings(loadSettings());
      const ok = await fetchReqAnalysisHealth();
      if (!alive) return;
      setLive(ok);
      if (!ok) return;
      try {
        const [list, pr] = await Promise.all([listReqDocs(), fetchReqPrompt()]);
        if (!alive) return;
        // 插件开着但提示词被删了 / 还是空的：补一份种子再读
        let readyPrompt = pr;
        if (!pr.exists || !pr.decompose.trim()) {
          await syncReqPrompt(true).catch(() => undefined);
          readyPrompt = await fetchReqPrompt();
        }
        if (!alive) return;
        setPrompt(readyPrompt);
        const ordered = sortDocs(list);
        setDocs(ordered);
        const wanted = readViewText(DOC_PREF, '');
        const pick = ordered.find((item) => item.id === wanted) ?? ordered[0] ?? null;
        loadDoc(pick);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    const off = onSettingsChanged(() => setSettings(loadSettings()));
    return () => {
      alive = false;
      off();
    };
  }, [loadDoc]);

  /* 来源文档列表：需求文档库插件没开 / 目录为空都在这里兜住 */
  useEffect(() => {
    if (!live) return;
    let alive = true;
    void listReqSources()
      .then((list) => {
        if (alive) setSources(list);
      })
      .catch((err: unknown) => {
        if (alive) setSourceError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [live]);

  /* 源文档指纹：和拆解时记下的不一致就提示「需重新拆解」 */
  useEffect(() => {
    const path = doc?.sourcePath;
    if (!path) {
      setSourceHash('');
      return;
    }
    let alive = true;
    void readReqSource(path)
      .then((content) => {
        if (alive) setSourceHash(sourceHashOf(content));
      })
      .catch(() => {
        if (alive) setSourceHash('');
      });
    return () => {
      alive = false;
    };
  }, [doc?.sourcePath, doc?.sourceHash]);

  useEffect(() => {
    const box = activityBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [activity]);

  const sourceChanged = Boolean(doc?.sourceHash && sourceHash && doc.sourceHash !== sourceHash);
  const outlineRefs = useMemo(
    () => new Set((doc?.stories ?? []).flatMap((story) => story.sourceRefs)),
    [doc?.stories],
  );
  const realPrompt = prompt ?? null;
  const promptReady = Boolean(realPrompt?.decompose.trim());
  const selectedGaps = useMemo(
    () => (doc?.check?.gaps ?? []).filter((gap) => gap.selected).length,
    [doc?.check],
  );

  /* ------------------------------ 落盘 ------------------------------ */

  const savePatch = useCallback(
    async (patch: ReqDocPatch, target?: ReqAnalysisDoc | null) => {
      const current = target ?? docRef.current;
      if (!current) throw new Error('还没有分析文档');
      const saved = await updateReqDoc(current.id, patch);
      patchDoc(saved);
      return saved;
    },
    [patchDoc],
  );

  const scheduleCheckSave = useCallback(() => {
    if (checkSaveRef.current) window.clearTimeout(checkSaveRef.current);
    checkSaveRef.current = window.setTimeout(() => {
      const current = docRef.current;
      if (!current?.check) return;
      void updateReqDoc(current.id, { check: current.check }).catch(() => undefined);
    }, 600);
  }, []);

  /** 选了一份来源：已有分析就复用，没有才新建，然后直接进工作台拆解 */
  const openSource = useCallback(
    async (path: string) => {
      if (!path) return null;
      const existing = docs.find((item) => item.sourcePath === path);
      if (existing) {
        openDoc(existing, 'stories');
        return existing;
      }
      try {
        const content = await readReqSource(path);
        const name = fileName(path);
        const created = await createReqDoc({
          sourcePath: path,
          sourceTitle: name,
          sourceHash: sourceHashOf(content),
          title: stripExt(name),
        });
        setDocs((prev) => sortDocs([created, ...prev]));
        openDoc(created, 'stories');
        pushActivity(`新建分析：${created.title}`);
        return created;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        showToast(message, 'error');
        // 选中的这份读不出来（格式不支持 / 扫描件）：下拉回到当前分析真正的来源
        setSourcePick(docRef.current?.sourcePath ?? '');
        return null;
      }
    },
    [docs, openDoc, pushActivity],
  );

  /* ------------------------------ 模型 ------------------------------ */

  const modelReady = Boolean(settings?.baseURL && settings.apiKey && settings.model);

  const requireModel = useCallback((): LLMSettings | null => {
    if (!modelReady || !settings) {
      showToast('请先在设置里配置模型', 'error');
      openSettings('model');
      return null;
    }
    return settings;
  }, [modelReady, settings]);

  const makeToolContext = useCallback(
    (target: ReqAnalysisDoc, batch: number): ReqToolContext => ({
      getDoc: () => docRef.current,
      batch,
      saveOutline: async (items: ReqOutlineItem[]) => {
        const saved = await updateReqDoc(target.id, { outline: items });
        patchDoc(saved);
        return saved.outline;
      },
      saveStories: async (stories) => {
        const saved = await updateReqDoc(target.id, { stories });
        patchDoc(saved);
        pushActivity(`已写入 ${saved.stories.length} 个用户故事`);
        return saved;
      },
      saveCheck: async (report) => {
        const previous = docRef.current?.check;
        const next = {
          ...report,
          gaps: preserveGapSelection(previous?.gaps ?? [], report.gaps),
        };
        const saved = await updateReqDoc(target.id, { check: next, status: 'checked' });
        patchDoc(saved);
        return saved;
      },
    }),
    [patchDoc, pushActivity],
  );

  /* ------------------------------ 拆解 ------------------------------ */

  const decompose = useCallback(async () => {
    const current = docRef.current;
    const model = requireModel();
    if (!current || !model) return;
    const promptText = realPrompt?.decompose.trim() ?? '';
    if (!promptText) {
      showToast(`没有读到「${REQ_ANALYSIS_PROMPT_FILE}」的「## 拆解」段落`, 'error');
      return;
    }
    setError('');
    setAnswer('');
    setActivity([]);
    setBusy('decompose');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const content = await readReqSource(current.sourcePath);
      if (!content.trim()) throw new Error('来源文档是空的');
      const chunks = splitRequirementSections(content);
      if (!chunks.length) throw new Error('来源文档没有可拆解的内容');
      pushActivity(
        chunks.length > 1
          ? `来源 ${content.length} 字，已分 ${chunks.length} 批拆解`
          : `来源 ${content.length} 字，单批拆解`,
      );

      // 重新拆解：旧故事与旧体检一起清掉，编号从 US-001 重来
      const reset = await updateReqDoc(current.id, {
        replaceStories: true,
        stories: [],
        outline: [],
        check: null,
        status: 'draft',
        sourceHash: sourceHashOf(content),
      });
      patchDoc(reset);

      for (const part of chunks) {
        if (controller.signal.aborted) break;
        const before = docRef.current?.stories.length ?? 0;
        const outlineText =
          (docRef.current?.outline ?? [])
            .map(
              (item) => `- ${item.id} ${item.title}${item.quote ? `（原文：${item.quote}）` : ''}`,
            )
            .join('\n') || '（本批还没有条目，先调用 req_set_outline）';
        const system = [
          promptText,
          '',
          REQ_TOOL_GUIDE,
          '',
          '## 已抽取的需求条目（sourceRefs 只能引用这些 id）',
          outlineText,
        ].join('\n');
        const user = [
          `这一批是原始需求的第 ${part.index + 1}/${chunks.length} 段${
            part.title ? `（章节：${part.title}）` : ''
          }。只处理这一段的条目与故事，已完成的部分不要重写。`,
          '',
          '## 原始需求',
          '',
          part.text,
        ].join('\n');

        await savePatch(
          {
            progress: {
              stage: 'stories',
              done: part.index,
              total: chunks.length,
              message: `正在拆第 ${part.index + 1}/${chunks.length} 批`,
              at: new Date().toISOString(),
            },
          },
          docRef.current,
        ).catch(() => undefined);

        let batchAnswer = '';
        for await (const chunk of streamChatWithTools(
          model,
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ] as ChatMessage[],
          controller.signal,
          {
            tools: REQ_ANALYSIS_TOOLS,
            maxToolRounds: 20,
            runTool: (name, args) =>
              runReqAnalysisTool(name, args, makeToolContext(current, part.index)),
          },
        )) {
          if (chunk.type === 'content') {
            batchAnswer += chunk.delta;
            setAnswer((prev) => prev + chunk.delta);
          } else if (chunk.type === 'tool' && chunk.status === 'running') {
            pushActivity(`调用 ${chunk.name}`, 'tool');
          }
        }

        if ((docRef.current?.stories.length ?? 0) === before) {
          const fallback = parseStoriesFallback(batchAnswer);
          if (fallback.length) {
            const merged = mergeStories(docRef.current?.stories ?? [], fallback);
            const saved = await updateReqDoc(current.id, { stories: merged });
            patchDoc(saved);
            pushActivity(`模型没调工具，已从回答里兜底解析 ${fallback.length} 个故事`, 'info');
          } else {
            pushActivity(`第 ${part.index + 1} 批没有拿到结构化故事`, 'error');
          }
        }
      }

      if (controller.signal.aborted) {
        pushActivity('已中断：已经写入的故事保留', 'info');
        return;
      }
      const done = await updateReqDoc(current.id, {
        status: 'decomposed',
        progress: {
          stage: 'done',
          done: chunks.length,
          total: chunks.length,
          message: '拆解完成',
          at: new Date().toISOString(),
        },
      });
      patchDoc(done);
      pushActivity(
        `拆解完成：${done.outline.length} 条需求条目、${done.stories.length} 个用户故事`,
        'done',
      );
      setTab('stories');
      showToast('拆解完成，建议接着跑一次体检', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        pushActivity('已中断：已经写入的故事保留', 'info');
      } else {
        setError(message);
        pushActivity(`拆解失败：${message}`, 'error');
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  }, [makeToolContext, patchDoc, pushActivity, realPrompt, requireModel, savePatch]);

  /* ------------------------------ 体检 ------------------------------ */

  const runAudit = useCallback(async () => {
    const current = docRef.current;
    if (!current) return;
    if (!current.stories.length) {
      showToast('还没有用户故事，先做一次拆解', 'info');
      return;
    }
    setError('');
    setAnswer('');
    setActivity([]);
    setBusy('audit');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const rule = auditStories(current);
      const withRule = await updateReqDoc(current.id, {
        check: {
          ...rule,
          gaps: preserveGapSelection(current.check?.gaps ?? [], rule.gaps),
        },
        status: 'checked',
        progress: {
          stage: 'audit',
          done: 0,
          total: 1,
          message: '规则体检完成，等待模型评审',
          at: new Date().toISOString(),
        },
      });
      patchDoc(withRule);
      pushActivity(
        `规则体检：覆盖率 ${Math.round(rule.coverage.rate * 100)}%，${rule.gaps.length} 个缺口`,
      );

      const promptText = realPrompt?.audit.trim() ?? '';
      const model = modelReady ? settings : null;
      if (!model || !promptText) {
        pushActivity(
          !model ? '没有配置模型，只保留规则结果' : '体检提示词为空，只保留规则结果',
          'info',
        );
        setTab('check');
        return;
      }

      let checkSaved = false;
      const ctx = makeToolContext(current, 90);
      const saveCheck = ctx.saveCheck;
      ctx.saveCheck = async (report) => {
        checkSaved = true;
        const saved = await saveCheck(report);
        pushActivity(`模型体检：整体 ${saved.check?.gaps.length ?? 0} 个缺口`, 'done');
        return saved;
      };

      const latest = docRef.current ?? withRule;
      const user = [
        '## 需求条目',
        latest.outline.length
          ? latest.outline
              .map(
                (item) =>
                  `- ${item.id} ${item.title}${item.quote ? `（原文：${item.quote}）` : ''}`,
              )
              .join('\n')
          : '（无）',
        '',
        `## 用户故事（${latest.stories.length} 条）`,
        '```json',
        JSON.stringify(latest.stories, null, 2),
        '```',
      ].join('\n');

      for await (const chunk of streamChatWithTools(
        model,
        [
          { role: 'system', content: `${promptText}\n\n${REQ_TOOL_GUIDE}` },
          { role: 'user', content: user },
        ] as ChatMessage[],
        controller.signal,
        {
          tools: REQ_ANALYSIS_TOOLS.filter((tool) => tool.function.name === 'req_save_check'),
          maxToolRounds: 8,
          runTool: (name, args) => runReqAnalysisTool(name, args, ctx),
        },
      )) {
        if (chunk.type === 'content') setAnswer((prev) => prev + chunk.delta);
        else if (chunk.type === 'tool' && chunk.status === 'running') {
          pushActivity(`调用 ${chunk.name}`, 'tool');
        }
      }

      if (!checkSaved) {
        pushActivity('模型没有提交体检结果，当前只保留规则结果', 'error');
        showToast('模型没有提交体检结果，只保留了规则检查', 'error');
      }
      setTab('check');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        pushActivity('已中断：规则体检结果已保留', 'info');
      } else {
        setError(message);
        pushActivity(`体检失败：${message}`, 'error');
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  }, [makeToolContext, modelReady, patchDoc, pushActivity, realPrompt, settings]);

  /* ------------------------------ 补写 ------------------------------ */

  const fixSelected = useCallback(async () => {
    const current = docRef.current;
    const model = requireModel();
    if (!current || !model) return;
    const gaps = (current.check?.gaps ?? []).filter((gap) => gap.selected);
    if (!gaps.length) {
      showToast('先在缺口清单里勾选要补写的条目', 'info');
      return;
    }
    const promptText = realPrompt?.fix.trim() ?? '';
    if (!promptText) {
      showToast('「需求分析提示词.md」缺少「## 补写」段落', 'error');
      return;
    }
    setError('');
    setAnswer('');
    setActivity([]);
    setBusy('fix');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      pushActivity(`按 ${gaps.length} 个勾选缺口补写`, 'info');
      const titleOf = new Map(current.stories.map((story) => [story.id, story.title]));
      const user = [
        `## 当前故事集（${current.stories.length} 条，没被点名的必须原样保留）`,
        '```json',
        JSON.stringify(current.stories, null, 2),
        '```',
        '',
        '## 勾选待补写的缺口',
        gaps
          .map((gap) => {
            const where = gap.storyId
              ? `${gap.storyId} ${titleOf.get(gap.storyId) ?? ''}`
              : '全局问题';
            return [
              `- [${gap.severity}] ${where}｜${gap.title}`,
              gap.detail ? `  原因：${gap.detail}` : '',
              gap.suggestion ? `  建议：${gap.suggestion}` : '',
            ]
              .filter(Boolean)
              .join('\n');
          })
          .join('\n'),
      ].join('\n');

      const ctx = makeToolContext(current, 90);
      let submitted = false;
      const saveStories = ctx.saveStories;
      ctx.saveStories = async (stories) => {
        submitted = true;
        return saveStories(stories);
      };

      for await (const chunk of streamChatWithTools(
        model,
        [
          { role: 'system', content: `${promptText}\n\n${REQ_TOOL_GUIDE}` },
          { role: 'user', content: user },
        ] as ChatMessage[],
        controller.signal,
        {
          tools: REQ_ANALYSIS_TOOLS.filter((tool) => tool.function.name === 'req_set_stories'),
          maxToolRounds: 10,
          runTool: (name, args) => runReqAnalysisTool(name, args, ctx),
        },
      )) {
        if (chunk.type === 'content') setAnswer((prev) => prev + chunk.delta);
        else if (chunk.type === 'tool' && chunk.status === 'running') {
          pushActivity(`调用 ${chunk.name}`, 'tool');
        }
      }

      if (!submitted) {
        pushActivity('模型没有提交补写结果，故事集保持不变', 'error');
        showToast('模型没有提交补写结果', 'error');
        return;
      }
      // 故事变了：按规则重算覆盖率，旧体检结论不再作数
      const latest = docRef.current;
      if (latest) {
        const rule = auditStories(latest);
        const saved = await updateReqDoc(latest.id, { check: rule, status: 'decomposed' });
        patchDoc(saved);
      }
      pushActivity('补写完成，已按规则重算覆盖率；建议再跑一次体检', 'done');
      setTab('check');
      showToast('补写完成，建议再跑一次体检', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        pushActivity('已中断：已经写入的改动保留', 'info');
      } else {
        setError(message);
        pushActivity(`补写失败：${message}`, 'error');
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  }, [makeToolContext, patchDoc, pushActivity, realPrompt, requireModel]);

  /* ------------------------------ 故事编辑 ------------------------------ */

  const replaceStories = useCallback(
    async (stories: ReqStory[]) => {
      const current = docRef.current;
      if (!current) return;
      try {
        await savePatch({ stories }, current);
      } catch (err) {
        showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
    [savePatch],
  );

  const saveStory = useCallback(
    (index: number, next: ReqStory) => {
      const current = docRef.current;
      if (!current) return;
      const stories = current.stories.map((story, i) =>
        i === index ? { ...next, id: story.id } : story,
      );
      void replaceStories(stories);
    },
    [replaceStories],
  );

  const removeStory = useCallback(
    (index: number) => {
      const current = docRef.current;
      if (!current) return;
      void replaceStories(current.stories.filter((_, i) => i !== index));
    },
    [replaceStories],
  );

  const moveStory = useCallback(
    (index: number, dir: -1 | 1) => {
      const current = docRef.current;
      if (!current) return;
      const j = index + dir;
      if (j < 0 || j >= current.stories.length) return;
      const stories = [...current.stories];
      const a = stories[index];
      const b = stories[j];
      if (!a || !b) return;
      stories[index] = b;
      stories[j] = a;
      void replaceStories(stories);
    },
    [replaceStories],
  );

  const toggleGap = useCallback(
    (id: string, selected: boolean) => {
      const current = docRef.current;
      if (!current?.check) return;
      const next = {
        ...current,
        check: {
          ...current.check,
          gaps: current.check.gaps.map((gap) => (gap.id === id ? { ...gap, selected } : gap)),
        },
      };
      patchDoc(next);
      scheduleCheckSave();
    },
    [patchDoc, scheduleCheckSave],
  );

  const toggleAllGaps = useCallback(
    (selected: boolean) => {
      const current = docRef.current;
      if (!current?.check) return;
      const next = {
        ...current,
        check: {
          ...current.check,
          gaps: current.check.gaps.map((gap) => ({ ...gap, selected })),
        },
      };
      patchDoc(next);
      scheduleCheckSave();
    },
    [patchDoc, scheduleCheckSave],
  );

  const renameDoc = useCallback(
    (title: string) => {
      const current = docRef.current;
      const next = title.trim();
      if (!current || !next || next === current.title) return;
      void savePatch({ title: next }, current).catch(() => undefined);
    },
    [savePatch],
  );

  const removeDoc = useCallback(async () => {
    const current = docRef.current;
    if (!current) return;
    try {
      await deleteReqDoc(current.id);
      const rest = docs.filter((item) => item.id !== current.id);
      setDocs(rest);
      loadDoc(rest[0] ?? null);
      // 删掉正在看的这份就回列表：列表是这一屏的默认落点
      setView('list');
      showToast('已删除分析记录', 'success');
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setConfirmDelete(false);
    }
  }, [docs, loadDoc]);

  const downloadMarkdown = useCallback(() => {
    const current = docRef.current;
    if (!current) return;
    const blob = new Blob([toMarkdown(current)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(current);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已导出 Markdown', 'success');
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /* ------------------------------ 渲染 ------------------------------ */

  if (!gate.ready) return <PmLoading label="正在读取插件开关" />;
  if (!gate.on) return <PmNotice>{pluginDisabledMessage('reqAnalysis')}</PmNotice>;
  if (live === null) return <PmLoading label="正在连接需求分析服务" />;
  if (!live) {
    return (
      <PmNotice>
        需求分析需要本地服务，当前未就绪：确认服务已升级到最新版本并重启（`lantern` 一体服务或 `npm
        run dev`），静态部署的页面用不了。
      </PmNotice>
    );
  }

  const outlineCovered = doc?.outline.filter((item) => outlineRefs.has(item.id)).length ?? 0;
  const checkGaps = doc?.check?.gaps ?? [];
  const progress = doc?.progress;

  /** 来源下拉：新建分析 / 工作台左栏共用 */
  const sourcePicker = (
    <SelectDropdown
      options={sourceOptions}
      value={sourcePick}
      onChange={(path) => {
        setSourcePick(path);
        if (path) void openSource(path);
      }}
      triggerTitle={sourcePick || '选择来源需求文档…'}
      ariaLabel="选择来源需求文档"
      searchable
      searchPlaceholder="搜索文件名或路径…"
      flat
    />
  );

  /* 默认屏：分析列表。点某条的「用户故事」进工作台拆解。 */
  const listView = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="shrink-0 rounded-xl border border-stone-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <p className={SECTION_TITLE}>新建分析</p>
            <div className="mt-1.5 max-w-[440px]">{sourcePicker}</div>
          </div>
          <span className="pb-1 text-[11px] text-stone-400">共 {docs.length} 份分析</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-stone-400">
          选一份需求文档就新建分析（同一份来源再选一次会回到已有记录），随后进「用户故事」拆解。支持
          Word（.docx）/ Excel（.xlsx / .xls）/ Markdown / txt / csv，读取时抽成文本，不改原文件。
        </p>
        {sourceError ? (
          <p className="mt-2 text-xs leading-relaxed text-amber-700">
            读不到需求文档库：{sourceError}
            <br />
            请先启用「需求文档库」插件，或确认 {REQ_ANALYSIS_DIR} 之外的内容目录没有被移动。
          </p>
        ) : null}
      </section>

      {error ? (
        <div className="flex shrink-0 items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <span className="break-all">{error}</span>
          <button type="button" className="shrink-0 text-red-400" onClick={() => setError('')}>
            ✕
          </button>
        </div>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stone-100 px-3 py-2">
          <div className="inline-flex rounded-lg border border-stone-200 bg-stone-50 p-0.5">
            <button
              type="button"
              onClick={() => setListModePref('doc')}
              className={`h-7 rounded-md px-2.5 text-xs transition-colors ${
                listMode === 'doc'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              按需求说明书
            </button>
            <button
              type="button"
              onClick={() => setListModePref('story')}
              className={`h-7 rounded-md px-2.5 text-xs transition-colors ${
                listMode === 'story'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              按用户故事
            </button>
          </div>
          {listMode === 'story' ? (
            <>
              <label className="relative block">
                <PmIcon
                  name="search"
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400"
                />
                <input
                  value={storyKeyword}
                  onChange={(e) => setStoryKeyword(e.target.value)}
                  placeholder="搜索编号 / 标题 / 角色…"
                  className="h-8 w-52 rounded-lg border border-stone-200 bg-white pl-8 pr-3 text-xs text-stone-800 outline-none transition-colors focus:border-[#3370ff]"
                />
              </label>
              <span className="text-[11px] text-stone-400">
                {storyTotal} 个故事
                {pickedStories ? ` · 已选 ${pickedStories.ids.length}` : ''}
              </span>
              <button
                type="button"
                disabled={!pickedStories}
                onClick={() => {
                  if (!pickedStories) return;
                  // 交给工作台的「生成测试用例」抽屉：后续修改仍在该会话里继续
                  const params = new URLSearchParams({
                    plugin: 'caseGen',
                    reqDoc: pickedStories.docId,
                    stories: pickedStories.ids.join(','),
                  });
                  const base = import.meta.env.BASE_URL || '/';
                  window.location.href = `${base}workbench/?${params.toString()}`;
                }}
                className={`${BTN_PRIMARY} ml-auto h-8 text-xs`}
              >
                用选中故事生成用例
              </button>
            </>
          ) : (
            <span className="ml-auto text-[11px] text-stone-400">
              {docs.length} 份分析 · {storyTotal} 个故事
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listMode === 'doc' ? (
            docs.length ? (
              <ul className="divide-y divide-stone-100">
                {docs.map((item) => {
                  const meta = REQ_STATUS_META[item.status];
                  return (
                    <li
                      key={item.id}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-stone-50"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center text-left"
                        onClick={() => openDoc(item, 'stories')}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium text-stone-800">
                              {item.title}
                            </span>
                            <PmTag tone={meta.tone}>{meta.label}</PmTag>
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-stone-400">
                            <span className="truncate">{item.sourcePath || '（未指定来源）'}</span>
                            <span>用户故事 {item.stories.length}</span>
                            <span>需求条目 {item.outline.length}</span>
                            <span>{formatWhen(item.updatedAt)}</span>
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-stone-200 bg-white px-2.5 text-xs text-stone-700 transition-colors hover:border-[#3370ff] hover:text-[#3370ff]"
                        onClick={() => openDoc(item, 'stories')}
                      >
                        用户故事
                        <PmIcon name="chevronRight" size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`删除 ${item.title}`}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600"
                        onClick={() => {
                          loadDoc(item);
                          setConfirmDelete(true);
                        }}
                      >
                        <PmIcon name="trash" size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <PmEmptyState
                icon="file"
                title="还没有分析记录"
                hint="上面选一份需求文档，系统会新建一份分析并进入用户故事拆解。"
              />
            )
          ) : storyGroups.length ? (
            <div className="divide-y divide-stone-100">
              {storyGroups.map(({ doc: item, rows }) => {
                const collapsed = collapsedGroups.includes(item.id);
                const groupIds = rows.map((row) => row.story.id);
                const allPicked =
                  pickedStories?.docId === item.id &&
                  groupIds.length > 0 &&
                  groupIds.every((id) => pickedSet.has(id));
                return (
                  <section key={item.id}>
                    <div className="flex items-center gap-2 bg-stone-50/70 px-3 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`选中 ${item.title} 的全部故事`}
                        checked={allPicked}
                        onChange={() => toggleGroupPick(item.id, groupIds)}
                      />
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() =>
                          setCollapsedGroups((prev) =>
                            prev.includes(item.id)
                              ? prev.filter((x) => x !== item.id)
                              : [...prev, item.id],
                          )
                        }
                      >
                        <PmIcon
                          name={collapsed ? 'chevronRight' : 'chevronDown'}
                          size={13}
                          className="shrink-0 text-stone-400"
                        />
                        <span className="truncate text-xs font-medium text-stone-700">
                          {item.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-stone-400">
                          {rows.length} 个故事 · {formatWhen(item.updatedAt)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="shrink-0 text-[11px] text-[#3370ff] hover:underline"
                        onClick={() => openDoc(item, 'stories')}
                      >
                        打开拆解
                      </button>
                    </div>
                    {collapsed ? null : (
                      <ul className="divide-y divide-stone-50">
                        {rows.map(({ story }) => (
                          <li
                            key={`${item.id}-${story.id}`}
                            className="flex items-start gap-2 px-4 py-2 transition-colors hover:bg-stone-50"
                          >
                            <input
                              type="checkbox"
                              className="mt-1"
                              aria-label={`选中 ${story.id}`}
                              checked={pickedSet.has(story.id) && pickedStories?.docId === item.id}
                              onChange={() => toggleStoryPick(item.id, story.id)}
                            />
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => openStory(item, story.id)}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="shrink-0 font-mono text-[11px] text-stone-400">
                                  {story.id}
                                </span>
                                <span className="truncate text-sm text-stone-800">
                                  {story.title}
                                </span>
                              </span>
                              <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-stone-400">
                                {story.role ? <span>角色：{story.role}</span> : null}
                                <span>优先级 {story.priority}</span>
                                <span>验收 {story.acceptance.length}</span>
                                <span>异常 {story.exceptions.length}</span>
                                <span>维度 {story.dimensions.length}</span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <PmEmptyState
              icon="file"
              title={storyKeyword ? '没有匹配的用户故事' : '还没有用户故事'}
              hint={
                storyKeyword
                  ? '换个编号、标题或角色再试。'
                  : '先按「需求说明书」选中一份文档拆解，故事会自动出现在这里。'
              }
            />
          )}
        </div>
      </section>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {view === 'list' ? (
        listView
      ) : (
        <>
          <div className="mb-2 flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-md border border-stone-200 bg-white px-2.5 text-xs text-stone-600 transition-colors hover:border-stone-300 hover:text-stone-800"
              onClick={() => {
                setSourcePick('');
                setError('');
                setView('list');
              }}
            >
              <PmIcon name="arrowLeft" size={14} />
              返回列表
            </button>
            <span className="min-w-0 truncate text-xs text-stone-400">
              {doc?.title ? `用户故事 · ${doc.title}` : '用户故事'}
            </span>
          </div>
          <div className="flex min-h-0 flex-1 gap-4">
            {/* 左栏：来源、历史、动作 */}
            <aside className="flex w-[272px] shrink-0 flex-col gap-3 overflow-y-auto pb-1">
              <section className="rounded-xl border border-stone-200 bg-white p-3">
                <p className={SECTION_TITLE}>来源需求文档</p>
                <div className="mt-2">{sourcePicker}</div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-stone-400">
                  支持 Word（.docx）/ Excel（.xlsx / .xls）/ Markdown / txt /
                  csv，读取时抽成文本，不改原文件。
                </p>
                {doc ? (
                  <div className="mt-2 space-y-1 text-[11px] text-stone-400">
                    <p className="break-all">当前：{doc.sourcePath || '（未指定）'}</p>
                    {sourceChanged ? (
                      <p className="rounded bg-amber-50 px-2 py-1 text-amber-700">
                        源文档已更新，建议重新拆解
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="rounded-xl border border-stone-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <p className={SECTION_TITLE}>分析记录</p>
                  <span className="text-[11px] text-stone-400">{docs.length}</span>
                </div>
                {docs.length ? (
                  <ul className="mt-2 space-y-1">
                    {docs.map((item) => {
                      const active = item.id === docId;
                      const meta = REQ_STATUS_META[item.status];
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                              active ? 'bg-[#eef3ff]' : 'hover:bg-stone-50'
                            }`}
                            onClick={() => loadDoc(item)}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium text-stone-700">
                                {item.title}
                              </span>
                              <span className="mt-0.5 flex items-center gap-1 text-[11px] text-stone-400">
                                <PmTag tone={meta.tone}>{meta.label}</PmTag>
                                <span>{item.stories.length} 个故事</span>
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-stone-400">
                    还没有分析记录，选一份来源文档开始。
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-stone-200 bg-white p-3">
                <p className={SECTION_TITLE}>提示词</p>
                <p className="mt-1 break-all text-xs text-stone-500">{REQ_ANALYSIS_PROMPT_FILE}</p>
                <p
                  className={`mt-1 text-[11px] ${promptReady ? 'text-emerald-600' : 'text-amber-700'}`}
                >
                  {promptReady
                    ? '拆解 / 体检 / 补写三段已就绪'
                    : '没有读到「## 拆解」段落：去「提示词管理」补上，或关闭再打开插件重新生成'}
                </p>
                <p
                  className={`mt-1 text-[11px] ${modelReady ? 'text-stone-400' : 'text-amber-700'}`}
                >
                  {modelReady ? `模型：${settings?.model}` : '还没配置模型'}
                </p>
              </section>

              <section className="space-y-2 rounded-xl border border-stone-200 bg-white p-3">
                <p className={SECTION_TITLE}>动作</p>
                <button
                  type="button"
                  className={`${BTN_PRIMARY} w-full`}
                  disabled={!doc || Boolean(busy) || !doc.sourcePath}
                  onClick={() => {
                    if (doc?.stories.length) setConfirmDecompose(true);
                    else void decompose();
                  }}
                >
                  {busy === 'decompose' ? '拆解中…' : doc?.stories.length ? '重新拆解' : '开始拆解'}
                </button>
                <button
                  type="button"
                  className={`${BTN_SECONDARY} w-full`}
                  disabled={!doc || Boolean(busy) || !doc.stories.length}
                  onClick={() => void runAudit()}
                >
                  {busy === 'audit' ? '体检中…' : '体检'}
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={`${BTN_SECONDARY} flex-1`}
                    disabled={!doc}
                    onClick={downloadMarkdown}
                  >
                    导出 Markdown
                  </button>
                  {busy ? (
                    <button type="button" className={`${BTN_SECONDARY} flex-1`} onClick={stop}>
                      中断
                    </button>
                  ) : null}
                </div>
                {doc ? (
                  <button
                    type="button"
                    className="h-8 w-full rounded-md text-xs text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500"
                    onClick={() => setConfirmDelete(true)}
                  >
                    删除这份分析
                  </button>
                ) : null}
              </section>

              <section className="min-h-[120px] rounded-xl border border-stone-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <p className={SECTION_TITLE}>活动日志</p>
                  {activity.length ? (
                    <button
                      type="button"
                      className="text-[11px] text-stone-400 hover:text-stone-600"
                      onClick={() => setActivity([])}
                    >
                      清空
                    </button>
                  ) : null}
                </div>
                <div
                  ref={activityBoxRef}
                  className="mt-2 max-h-[240px] space-y-1 overflow-y-auto pr-1"
                >
                  {activity.length ? (
                    activity.map((item) => (
                      <p key={item.id} className="flex gap-1.5 text-[11px] leading-relaxed">
                        <span
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                            item.kind === 'error'
                              ? 'bg-red-500'
                              : item.kind === 'done'
                                ? 'bg-emerald-500'
                                : item.kind === 'tool'
                                  ? 'bg-[#3370ff]'
                                  : 'bg-stone-300'
                          }`}
                          aria-hidden="true"
                        />
                        <span className={item.kind === 'error' ? 'text-red-600' : 'text-stone-500'}>
                          {item.text}
                        </span>
                      </p>
                    ))
                  ) : (
                    <p className="text-[11px] text-stone-400">拆解 / 体检的过程会记在这里。</p>
                  )}
                </div>
              </section>
            </aside>

            {/* 右栏：故事与体检 */}
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              {error ? (
                <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <span className="break-all">{error}</span>
                  <button
                    type="button"
                    className="shrink-0 text-red-400"
                    onClick={() => setError('')}
                  >
                    ✕
                  </button>
                </div>
              ) : null}

              {!doc ? (
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-stone-200 bg-white">
                  <PmEmptyState
                    icon="file"
                    title="还没有选来源"
                    hint="左侧选一份「需求文档库」里的 Word / Excel / Markdown / txt，系统会新建一份分析。"
                  />
                </div>
              ) : (
                <>
                  <header className="shrink-0 rounded-xl border border-stone-200 bg-white px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-base font-semibold text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
                        defaultValue={doc.title}
                        key={doc.id}
                        aria-label="分析标题"
                        onBlur={(e) => renameDoc(e.target.value)}
                      />
                      <PmTag tone={REQ_STATUS_META[doc.status].tone}>
                        {REQ_STATUS_META[doc.status].label}
                      </PmTag>
                      {busy ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-stone-500">
                          <span className="tw-lib-spin" aria-hidden="true" />
                          {progress?.message ||
                            (busy === 'decompose'
                              ? '拆解中'
                              : busy === 'audit'
                                ? '体检中'
                                : '补写中')}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-stone-400">
                      <span>
                        故事{' '}
                        <span className="font-medium text-stone-600">{doc.stories.length}</span>
                      </span>
                      <span>
                        需求条目{' '}
                        <span className="font-medium text-stone-600">
                          {outlineCovered}/{doc.outline.length}
                        </span>{' '}
                        覆盖
                      </span>
                      <span>
                        缺口 <span className="font-medium text-stone-600">{checkGaps.length}</span>
                        {selectedGaps ? ` · 已选 ${selectedGaps}` : ''}
                      </span>
                      {doc.check ? (
                        <span>
                          覆盖率{' '}
                          <span className="font-medium text-stone-600">
                            {doc.check.coverage.total
                              ? `${Math.round(doc.check.coverage.rate * 100)}%`
                              : '—'}
                          </span>
                        </span>
                      ) : null}
                      <span className="truncate">来源：{doc.sourcePath}</span>
                    </div>

                    <div className="mt-3 flex items-center gap-1 border-b border-stone-100">
                      {(
                        [
                          { id: 'stories', label: `用户故事 ${doc.stories.length}` },
                          { id: 'check', label: `体检结果 ${checkGaps.length}` },
                          { id: 'outline', label: `需求条目 ${doc.outline.length}` },
                        ] as const
                      ).map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`-mb-px border-b-2 px-3 py-1.5 text-xs transition-colors ${
                            tab === item.id
                              ? 'border-[#3370ff] font-medium text-[#3370ff]'
                              : 'border-transparent text-stone-500 hover:text-stone-700'
                          }`}
                          onClick={() => setTab(item.id)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </header>

                  <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
                    {tab === 'stories' ? (
                      doc.stories.length ? (
                        <ul className="space-y-2">
                          {doc.stories.map((story, index) => (
                            <ReqStoryCard
                              key={`${story.id}-${index}`}
                              story={story}
                              index={index}
                              total={doc.stories.length}
                              gaps={checkGaps.filter((gap) => gap.storyId === story.id)}
                              busy={Boolean(busy)}
                              onSave={(next) => saveStory(index, next)}
                              onDelete={() => removeStory(index)}
                              onMove={(dir) => moveStory(index, dir)}
                              domId={story.id ? `req-story-${story.id}` : undefined}
                            />
                          ))}
                        </ul>
                      ) : (
                        <div className="flex items-center justify-center rounded-xl border border-stone-200 bg-white">
                          <PmEmptyState
                            icon="file"
                            title="还没有用户故事"
                            hint="点左侧「开始拆解」，会先抽需求条目再拆故事。"
                          />
                        </div>
                      )
                    ) : null}

                    {tab === 'check' ? (
                      <ReqCheckPanel
                        check={doc.check}
                        stories={doc.stories}
                        busy={Boolean(busy)}
                        onToggleGap={toggleGap}
                        onToggleAll={toggleAllGaps}
                        onFix={() => void fixSelected()}
                        onAudit={() => void runAudit()}
                      />
                    ) : null}

                    {tab === 'outline' ? (
                      doc.outline.length ? (
                        <ul className="space-y-2">
                          {doc.outline.map((item) => {
                            const covered = outlineRefs.has(item.id);
                            return (
                              <li
                                key={item.id}
                                className="rounded-xl border border-stone-200 bg-white px-4 py-2.5"
                              >
                                <div className="flex items-start gap-2">
                                  <span
                                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                      covered ? 'bg-emerald-500' : 'bg-amber-400'
                                    }`}
                                    aria-hidden="true"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm text-stone-800">
                                      <span className="mr-1.5 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-500">
                                        {item.id}
                                      </span>
                                      {item.title}
                                    </p>
                                    {item.quote ? (
                                      <p className="mt-1 border-l-2 border-stone-200 pl-2 text-xs leading-relaxed text-stone-400">
                                        {item.quote}
                                      </p>
                                    ) : null}
                                  </div>
                                  <span
                                    className={`shrink-0 text-[11px] ${covered ? 'text-emerald-600' : 'text-amber-600'}`}
                                  >
                                    {covered ? '已覆盖' : '未覆盖'}
                                  </span>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <div className="flex items-center justify-center rounded-xl border border-stone-200 bg-white">
                          <PmEmptyState
                            icon="file"
                            title="还没有需求条目"
                            hint="拆解时模型会先抽条目，覆盖率按条目统计。"
                          />
                        </div>
                      )
                    ) : null}
                  </div>

                  {answer ? (
                    <details className="mt-2 shrink-0 rounded-xl border border-stone-200 bg-white px-3 py-2">
                      <summary className="cursor-pointer text-xs text-stone-500">
                        模型说明（本轮）
                      </summary>
                      <pre className="mt-1 max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-stone-600">
                        {answer}
                      </pre>
                    </details>
                  ) : null}
                </>
              )}
            </section>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="删除分析记录"
        message={`确认删除「${doc?.title ?? ''}」？故事、需求条目与体检报告都会一起删掉，来源需求文档不受影响。`}
        confirmLabel="删除"
        danger="solid"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void removeDoc()}
      />

      <ConfirmDialog
        open={confirmDecompose}
        title="重新拆解"
        message={`重新拆解会用模型结果替换当前 ${doc?.stories.length ?? 0} 个用户故事，旧体检报告与需求条目也会一起清掉，编号从 US-001 重新开始。`}
        confirmLabel="重新拆解"
        onClose={() => setConfirmDecompose(false)}
        onConfirm={() => void decompose()}
      />
    </div>
  );
}
