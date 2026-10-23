/**
 * 需求分析工作台。
 *
 * 左栏：分析记录、提示词状态、动作、活动日志；
 * 右栏：故事卡片 / 审查结果 / 需求条目。
 *
 * 「用户故事审查」是独立插件（storyReview），但没有独立菜单：开关打开时
 * 左栏多一个「用户故事审查」按钮、右栏多一个「审查结果」Tab，审查用
 * `用户故事审查提示词.md` 的「审查 / 补写」两段；关闭时这些入口整体不显示。
 *
 * 「生成测试点」同样嵌在这里（testPoints）：开关打开时左栏多一个「生成测试点」
 * 按钮、右栏多一个「测试点」Tab，用 `测试点生成提示词.md` 的「生成」一段，
 * 结果可看导图 / 列表，也可导出 XMind 与 Markdown。
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
  readReqSourceExcerpt,
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
import { isOfficeLockFile } from '../../lib/project-docs';
import {
  REQ_ANALYSIS_TOOLS,
  REQ_TOOL_GUIDE,
  parseStoriesFallback,
  parseTestPointsFallback,
  runReqAnalysisTool,
  type ReqToolContext,
} from '../../lib/req-analysis-tools';
import {
  loadSettings,
  onSettingsChanged,
  openSettings,
  type LLMSettings,
} from '../../lib/settings';
import {
  readViewJson,
  readViewPref,
  readViewText,
  writeViewJson,
  writeViewPref,
  writeViewText,
} from '../../lib/view-prefs';
import {
  downloadReviewMarkdown,
  fetchStoryReviewPrompt,
  STORY_REVIEW_PROMPT_FILE,
  syncStoryReviewPrompt,
  type StoryReviewPrompt,
} from '../../lib/story-review';
import {
  downloadTestPointsMarkdown,
  downloadTestPointsXMind,
  fetchTestPointsPrompt,
  TEST_POINTS_PROMPT_FILE,
  syncTestPointsPrompt,
  type TestPointsPrompt,
} from '../../lib/test-points';
import ConfirmDialog from './ConfirmDialog';
import OverflowHint from './OverflowHint';
import { PmEmptyState, PmIcon, PmLoading, PmNotice, PmTag, usePmPlugin } from './PmShared';
import StoryReviewReport from './StoryReviewReport';
import TestPointsPanel from './TestPointsPanel';
import ReqStoryCard from './ReqStoryCard';
import SelectDropdown, { type SelectOption } from './SelectDropdown';
import { showToast } from './Toast';

const DOC_PREF = 'reqanalysis.doc';
/** 列表页的视图：按需求说明书 / 按用户故事（记忆） */
const LIST_MODE_PREF = 'reqanalysis.listmode';
/** 上次停在列表还是某份分析的工作台（记忆） */
const VIEW_PREF = 'reqanalysis.view';
/** 工作台右侧页签（记忆） */
const TAB_PREF = 'reqanalysis.tab';
/** 「按用户故事」列表的搜索词（记忆） */
const STORY_KW_PREF = 'reqanalysis.storykeyword';
const VIEW_MODES = ['list', 'work'] as const;
const TAB_IDS = ['stories', 'check', 'outline', 'points'] as const;

interface ActivityItem {
  id: number;
  kind: 'info' | 'tool' | 'done' | 'error';
  text: string;
  at: string;
}

/**
 * 活动日志按「分析 id」存在本地偏好里：刷新、切走再回来都还在。
 * 只留最近 200 条，避免长跑把本地存储撑大。
 */
const ACTIVITY_PREF = 'reqanalysis.activity';
const ACTIVITY_MAX = 200;
const ACTIVITY_KINDS: ActivityItem['kind'][] = ['info', 'tool', 'done', 'error'];

function activityKey(docId: string): string {
  return `${ACTIVITY_PREF}.${docId}`;
}

/** 读回某份分析的日志；结构对不上的条目直接丢掉，坏数据不炸页面 */
function readActivity(docId: string): ActivityItem[] {
  if (!docId) return [];
  const raw = readViewJson<unknown>(activityKey(docId), []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is ActivityItem => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Partial<ActivityItem>;
      return (
        typeof row.id === 'number' &&
        typeof row.text === 'string' &&
        typeof row.at === 'string' &&
        ACTIVITY_KINDS.includes(row.kind as ActivityItem['kind'])
      );
    })
    .slice(-ACTIVITY_MAX);
}
type TabId = 'stories' | 'check' | 'outline' | 'points';
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

/** 提示词一行：文件名在左、状态靠右对齐；文件名过长省略号 + 悬停气泡预览 */
function PromptStatusRow({ name, ready }: { name: string; ready: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <OverflowHint text={name} className="min-w-0 flex-1 truncate text-xs text-stone-500" />
      <span className={`shrink-0 text-[11px] ${ready ? 'text-emerald-600' : 'text-stone-400'}`}>
        {ready ? '已就绪' : '未就绪'}
      </span>
    </div>
  );
}

export default function ReqAnalysisBoard() {
  const gate = usePmPlugin('reqAnalysis');
  const reviewGate = usePmPlugin('storyReview');
  const tpGate = usePmPlugin('testPoints');
  const [live, setLive] = useState<boolean | null>(null);
  const [docs, setDocs] = useState<ReqAnalysisDoc[]>([]);
  const [docId, setDocId] = useState('');
  const [doc, setDoc] = useState<ReqAnalysisDoc | null>(null);
  const [sources, setSources] = useState<ReqSourceFile[]>([]);
  const [sourcePick, setSourcePick] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [prompt, setPrompt] = useState<ReqPrompt | null>(null);
  /** 用户故事审查插件的提示词（审查 / 补写两段）；插件关闭时为空 */
  const [reviewPrompt, setReviewPrompt] = useState<StoryReviewPrompt | null>(null);
  /** 生成测试点插件的提示词（`## 生成` 一段）；插件关闭时为空 */
  const [testPointsPrompt, setTestPointsPrompt] = useState<TestPointsPrompt | null>(null);
  const [busy, setBusy] = useState<null | 'decompose' | 'audit' | 'fix' | 'testpoints'>(null);
  /**
   * 本轮任务的即时进度（只在内存里，不落盘）。
   * 落盘的 `doc.progress` 给刷新后看，这里给正在跑的这一刻看：
   * 拆解按批次推进，审查 / 生成测试点按阶段推进。
   */
  const [runProgress, setRunProgress] = useState<{
    label: string;
    done: number;
    total: number;
    message: string;
  } | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<TabId>(() => readViewPref(TAB_PREF, TAB_IDS, 'stories'));
  /** 页签选择跟着落到本地：刷新 / 切页回来还停在同一个 Tab */
  useEffect(() => {
    writeViewPref(TAB_PREF, tab);
  }, [tab]);
  /**
   * 列表 / 工作台两屏。
   * 进页面按上次离开时的位置还原（`reqanalysis.view`）：停在工作台就回到同一份分析，
   * 新增 / 删除 / 返回列表会立刻写回记忆；文档已不存在时退回列表。
   */
  const [view, setView] = useState<'list' | 'work'>('list');
  /** 首次加载完成后要还原到的视图（读在状态初始化前，避免刷新时被默认值覆盖） */
  const savedViewRef = useRef<'list' | 'work'>(readViewPref(VIEW_PREF, VIEW_MODES, 'list'));
  /** 还在等分析列表：要还原到工作台时先显示加载态，避免先闪一下空列表 */
  const [booting, setBooting] = useState(() => savedViewRef.current === 'work');
  /** 列表子视图：需求说明书列表 / 扁平用户故事列表 */
  const [listMode, setListMode] = useState<ListMode>(() =>
    readViewPref(LIST_MODE_PREF, ['doc', 'story'] as const, 'doc'),
  );
  const [storyKeyword, setStoryKeyword] = useState(() => readViewText(STORY_KW_PREF, ''));
  /** 故事搜索词跟着输入落本地：刷新 / 切页回来还在 */
  useEffect(() => {
    writeViewText(STORY_KW_PREF, storyKeyword);
  }, [storyKeyword]);
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

  /**
   * 状态标签：「已审查 / 已验收」来自审查插件，插件关掉时审查入口与结果都不显示，
   * 这里退回「已拆解」，避免右侧留着一个看不懂来源的状态。
   */
  const statusMetaOf = useCallback(
    (status: ReqAnalysisDoc['status']) =>
      reviewGate.on || (status !== 'checked' && status !== 'accepted')
        ? REQ_STATUS_META[status]
        : REQ_STATUS_META.decomposed,
    [reviewGate.on],
  );

  /** 来源下拉：能拆解的排前面，暂不支持的置灰（仍然列出来，说明为什么不能选） */
  const sourceOptions = useMemo<SelectOption[]>(() => {
    const rank = (file: ReqSourceFile) => (file.supported ? 0 : 1);
    return [...sources]
      .filter((file) => !isOfficeLockFile(file.name))
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

  /* --------------------- 活动日志：按分析 id 存取 --------------------- */
  /** 切分析 / 刷新回来时，把这份分析的日志读回来（并跳过紧随其后的回写） */
  const skipActivitySaveRef = useRef(false);
  useEffect(() => {
    if (!docId) {
      skipActivitySaveRef.current = true;
      setActivity([]);
      return;
    }
    const saved = readActivity(docId);
    activityIdRef.current = saved.reduce((max, item) => Math.max(max, item.id), 0);
    skipActivitySaveRef.current = true;
    setActivity(saved);
  }, [docId]);

  // 日志变化即落本地偏好：刷新后照样能看到上一轮的拆解 / 审查过程
  useEffect(() => {
    if (skipActivitySaveRef.current) {
      skipActivitySaveRef.current = false;
      return;
    }
    if (!docId) return;
    writeViewJson(activityKey(docId), activity.slice(-ACTIVITY_MAX));
  }, [activity, docId]);

  const loadDoc = useCallback((next: ReqAnalysisDoc | null) => {
    docRef.current = next;
    setDoc(next);
    setDocId(next?.id ?? '');
    writeViewText(DOC_PREF, next?.id ?? '');
    if (next?.sourcePath) setSourcePick(next.sourcePath);
  }, []);

  /** 切换列表 / 工作台，同时写回本地记忆 */
  const changeView = useCallback((next: 'list' | 'work') => {
    setView(next);
    writeViewPref(VIEW_PREF, next);
  }, []);

  /**
   * 进工作台看某份分析：加载数据、可指定落到哪个页签。
   * 顺手清掉刷新缓存——缓存里如果是列表，切进工作台后它会在挂载前闪一下。
   */
  const openDoc = useCallback(
    (next: ReqAnalysisDoc, nextTab: TabId = 'stories') => {
      loadDoc(next);
      setTab(nextTab);
      changeView('work');
      clearHydrateCache('req-analysis');
    },
    [changeView, loadDoc],
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
        const [list, pr, rp, tpp] = await Promise.all([
          listReqDocs(),
          fetchReqPrompt(),
          fetchStoryReviewPrompt(),
          fetchTestPointsPrompt(),
        ]);
        if (!alive) return;
        // 插件开着但提示词被删了 / 还是空的：补一份种子再读
        let readyPrompt = pr;
        if (!pr.exists || !pr.decompose.trim()) {
          await syncReqPrompt(true).catch(() => undefined);
          readyPrompt = await fetchReqPrompt();
        }
        if (!alive) return;
        setPrompt(readyPrompt);

        // 审查插件开着但提示词被删了 / 还是空的：补一份种子再读
        let readyReview = rp;
        if (!rp.exists || !rp.review.trim()) {
          await syncStoryReviewPrompt(true).catch(() => undefined);
          readyReview = await fetchStoryReviewPrompt();
        }
        if (!alive) return;
        // 只在真的读到文件时记下来：插件还没开 / 文件缺失时留空，等开关打开再补
        if (readyReview.exists) setReviewPrompt(readyReview);
        // 生成测试点同样只记录读到的文件；缺文件时由下面的开关 effect 补种子
        if (tpp.exists) setTestPointsPrompt(tpp);
        const ordered = sortDocs(list);
        setDocs(ordered);
        const wanted = readViewText(DOC_PREF, '');
        const pick = ordered.find((item) => item.id === wanted) ?? ordered[0] ?? null;
        loadDoc(pick);
        // 上次停在工作台且那份分析还在 → 直接回到工作台（页签已按记忆初始化）
        const savedView = savedViewRef.current;
        savedViewRef.current = 'list';
        if (savedView === 'work' && pick && wanted && pick.id === wanted) {
          changeView('work');
          clearHydrateCache('req-analysis');
        }
        setBooting(false);
      } catch (err) {
        if (alive) {
          setBooting(false);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    const off = onSettingsChanged(() => setSettings(loadSettings()));
    return () => {
      alive = false;
      off();
    };
  }, [changeView, loadDoc]);

  /**
   * 「用户故事审查」开关变化：打开时补一份提示词并读两段正文，
   * 关闭时清空状态并把停在「审查结果」的页面拉回用户故事，避免看到隐藏 Tab 的内容。
   */
  useEffect(() => {
    if (!reviewGate.ready) return;
    if (!reviewGate.on) {
      setReviewPrompt(null);
      setTab((prev) => (prev === 'check' ? 'stories' : prev));
      return;
    }
    if (!live || reviewPrompt !== null) return;
    let alive = true;
    void (async () => {
      let next = await fetchStoryReviewPrompt();
      if (!next.exists || !next.review.trim()) {
        await syncStoryReviewPrompt(true).catch(() => undefined);
        next = await fetchStoryReviewPrompt();
      }
      if (alive) setReviewPrompt(next);
    })();
    return () => {
      alive = false;
    };
  }, [reviewGate.ready, reviewGate.on, live, reviewPrompt]);

  /**
   * 「生成测试点」开关变化：打开时补一份提示词并读 `## 生成`，
   * 关闭时清空状态并把停在「测试点」的页面拉回用户故事。
   */
  useEffect(() => {
    if (!tpGate.ready) return;
    if (!tpGate.on) {
      setTestPointsPrompt(null);
      setTab((prev) => (prev === 'points' ? 'stories' : prev));
      return;
    }
    if (!live || testPointsPrompt !== null) return;
    let alive = true;
    void (async () => {
      let next = await fetchTestPointsPrompt();
      if (!next.exists || !next.generate.trim()) {
        await syncTestPointsPrompt(true).catch(() => undefined);
        next = await fetchTestPointsPrompt();
      }
      if (alive) setTestPointsPrompt(next);
    })();
    return () => {
      alive = false;
    };
  }, [tpGate.ready, tpGate.on, live, testPointsPrompt]);

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
      saveTestPoints: async (report) => {
        const saved = await updateReqDoc(target.id, { testPoints: report });
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
    setRunProgress({ label: '拆解', done: 0, total: 0, message: '正在读取来源文档' });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // 一进拆解就把状态落成「待拆解」：读源文件那几秒否则还挂着上一次的「已审查」，
      // 拆完再变成「已拆解」，看起来像顺序倒了。
      const started = await updateReqDoc(current.id, {
        status: 'draft',
        progress: {
          stage: 'stories',
          done: 0,
          total: 0,
          message: '正在读取来源文档',
          at: new Date().toISOString(),
        },
      });
      patchDoc(started);

      const content = await readReqSource(current.sourcePath);
      if (!content.trim()) throw new Error('来源文档是空的');
      const chunks = splitRequirementSections(content);
      if (!chunks.length) throw new Error('来源文档没有可拆解的内容');
      setRunProgress({
        label: '拆解',
        done: 0,
        total: chunks.length,
        message: `共 ${chunks.length} 批，准备拆第 1 批`,
      });
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

        setRunProgress({
          label: '拆解',
          done: part.index,
          total: chunks.length,
          message: `正在拆第 ${part.index + 1}/${chunks.length} 批`,
        });

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
        setRunProgress({
          label: '拆解',
          done: part.index + 1,
          total: chunks.length,
          message: `第 ${part.index + 1}/${chunks.length} 批已写入`,
        });
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
      // 审查插件开着才接着审：关掉插件时流程就到「已拆解」为止
      if (reviewGate.on && !controller.signal.aborted) {
        showToast('拆解完成，接着做用户故事审查', 'success');
        await auditRef.current?.(true);
      } else {
        showToast('拆解完成', 'success');
      }
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
      setRunProgress(null);
      abortRef.current = null;
    }
  }, [makeToolContext, patchDoc, pushActivity, realPrompt, requireModel, reviewGate.on, savePatch]);

  /* ------------------------------ 体检 ------------------------------ */

  /**
   * 审查（规则 + 模型）。
   * `auto` 由「拆解完成 → 自动审查」调用：接着拆解那轮的日志与模型说明往后写，
   * 不清空，才能在同一条时间线里看到「先拆后审」。
   */
  const runAudit = useCallback(
    async (auto = false) => {
      const current = docRef.current;
      if (!current) return;
      if (!current.stories.length) {
        if (!auto) showToast('还没有用户故事，先做一次拆解', 'info');
        return;
      }
      setError('');
      if (!auto) {
        setAnswer('');
        setActivity([]);
      }
      setBusy('audit');
      setRunProgress({ label: '审查用户故事', done: 0, total: 2, message: '正在跑规则体检' });
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
        setRunProgress({
          label: '审查用户故事',
          done: 1,
          total: 2,
          message: '规则体检完成，等待模型评审',
        });

        const reviewText = reviewPrompt?.review.trim() ?? '';
        const model = modelReady ? settings : null;
        if (!model || !reviewText) {
          pushActivity(
            !model
              ? '没有配置模型，只保留规则结果'
              : '「用户故事审查提示词.md」缺少「## 审查」段落，只保留规则结果',
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
        const source = await readReqSourceExcerpt(latest.sourcePath);
        if (!source.text) {
          pushActivity('没有读到原始需求，只能依据需求条目摘句审查', 'info');
        }
        const user = [
          '## 原始需求',
          source.text
            ? source.truncated
              ? `${source.text}\n\n（原文共 ${source.total} 字，以上为前 ${source.text.length} 字，没看到的部分不要猜）`
              : source.text
            : '（未读到原始需求，只能依据下面的需求条目摘句判断）',
          '',
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
            { role: 'system', content: `${reviewText}\n\n${REQ_TOOL_GUIDE}` },
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
        setRunProgress({
          label: '审查用户故事',
          done: 2,
          total: 2,
          message: checkSaved ? '模型评审完成' : '已保留规则结果',
        });
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
        setRunProgress(null);
        abortRef.current = null;
      }
    },
    [makeToolContext, modelReady, patchDoc, pushActivity, reviewPrompt, settings],
  );

  /**
   * 拆解完成后要接着自动审查，但 runAudit 定义在 decompose 之后。
   * 用一个 ref 挂最新版本，decompose 里按需取用，避免把两个大回调互相塞进依赖。
   */
  const auditRef = useRef<((auto?: boolean) => Promise<void>) | null>(null);
  auditRef.current = runAudit;

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
    const fixText = reviewPrompt?.fix.trim() ?? '';
    if (!fixText) {
      showToast('「用户故事审查提示词.md」缺少「## 补写」段落', 'error');
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
      const source = await readReqSourceExcerpt(current.sourcePath);
      const user = [
        '## 原始需求',
        source.text
          ? source.truncated
            ? `${source.text}\n\n（原文共 ${source.total} 字，以上为前 ${source.text.length} 字，没看到的部分不要猜）`
            : source.text
          : '（未读到原始需求，只能依据需求条目与当前故事集判断）',
        '',
        '## 需求条目（新增故事的 sourceRefs 只能引用这里的 id）',
        current.outline.length
          ? current.outline
              .map(
                (item) =>
                  `- ${item.id} ${item.title}${item.quote ? `（原文：${item.quote}）` : ''}`,
              )
              .join('\n')
          : '（无）',
        '',
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
          { role: 'system', content: `${fixText}\n\n${REQ_TOOL_GUIDE}` },
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
  }, [makeToolContext, patchDoc, pushActivity, requireModel, reviewPrompt]);

  /* ------------------------------ 生成测试点 ------------------------------ */

  const runTestPoints = useCallback(async () => {
    const current = docRef.current;
    const model = requireModel();
    if (!current || !model) return;
    if (!current.stories.length) {
      showToast('还没有用户故事，先做一次拆解', 'info');
      return;
    }
    const generateText = testPointsPrompt?.generate.trim() ?? '';
    if (!generateText) {
      showToast(`没有读到「${TEST_POINTS_PROMPT_FILE}」的「## 生成」段落`, 'error');
      return;
    }
    setError('');
    setAnswer('');
    setActivity([]);
    setBusy('testpoints');
    // 点下去就先切到「测试点」Tab：生成过程与结果都在这一屏，不用等跑完才跳
    setTab('points');
    setRunProgress({
      label: '生成测试点',
      done: 0,
      total: 2,
      message: '正在整理用户故事，等待模型生成',
    });
    // 落一份进度：刷新页面或切走再回来也能看出「正在生成测试点」
    await savePatch(
      {
        progress: {
          stage: 'points',
          done: 0,
          total: 2,
          message: '正在生成测试点',
          at: new Date().toISOString(),
        },
      },
      current,
    ).catch(() => undefined);
    pushActivity('开始生成测试点（五维覆盖，P0–P3）', 'info');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const ctx = makeToolContext(current, 90);
      let submitted = false;
      const saveTestPoints = ctx.saveTestPoints;
      ctx.saveTestPoints = async (report) => {
        submitted = true;
        setRunProgress({
          label: '生成测试点',
          done: 1,
          total: 2,
          message: '正在写入测试点',
        });
        const saved = await saveTestPoints(report);
        pushActivity(`测试点已写入：${saved.testPoints?.points.length ?? 0} 条`, 'done');
        return saved;
      };

      const user = [
        `## 分析标题\n${current.title || '未命名分析'}`,
        '',
        '## 需求条目',
        current.outline.length
          ? current.outline
              .map(
                (item) =>
                  `- ${item.id} ${item.title}${item.quote ? `（原文：${item.quote}）` : ''}`,
              )
              .join('\n')
          : '（无）',
        '',
        `## 用户故事（${current.stories.length} 条）`,
        '```json',
        JSON.stringify(current.stories, null, 2),
        '```',
      ].join('\n');

      let text = '';
      for await (const chunk of streamChatWithTools(
        model,
        [
          { role: 'system', content: `${generateText}\n\n${REQ_TOOL_GUIDE}` },
          { role: 'user', content: user },
        ] as ChatMessage[],
        controller.signal,
        {
          tools: REQ_ANALYSIS_TOOLS.filter((tool) => tool.function.name === 'req_save_test_points'),
          maxToolRounds: 8,
          runTool: (name, args) => runReqAnalysisTool(name, args, ctx),
        },
      )) {
        if (chunk.type === 'content') {
          text += chunk.delta;
          setAnswer((prev) => prev + chunk.delta);
        } else if (chunk.type === 'tool' && chunk.status === 'running') {
          pushActivity(`调用 ${chunk.name}`, 'tool');
        }
      }

      // 模型没调工具时，从回答里的 ```json 代码块兜底解析，别让这一轮白跑
      if (!submitted) {
        const fallback = parseTestPointsFallback(
          text,
          current.stories.map((story) => story.id),
        );
        if (fallback) {
          await ctx.saveTestPoints(fallback);
          submitted = true;
          pushActivity(`模型没调工具，已从回答里兜底解析 ${fallback.points.length} 条`, 'info');
        }
      }

      if (!submitted) {
        pushActivity('模型没有提交测试点，原结果保持不变', 'error');
        showToast('模型没有提交测试点，原结果保持不变', 'error');
      } else {
        const report = docRef.current?.testPoints;
        const points = report?.points ?? [];
        const byPriority = (key: string) => points.filter((p) => p.priority === key).length;
        pushActivity(
          `测试点完成：${points.length} 条（P0 ${byPriority('P0')} / P1 ${byPriority('P1')} / P2 ${byPriority('P2')} / P3 ${byPriority('P3')}）`,
          'done',
        );
        setRunProgress({
          label: '生成测试点',
          done: 2,
          total: 2,
          message: `已生成 ${points.length} 条`,
        });
        await savePatch(
          {
            progress: {
              stage: 'done',
              done: 2,
              total: 2,
              message: `测试点已生成 ${points.length} 条`,
              at: new Date().toISOString(),
            },
          },
          docRef.current,
        ).catch(() => undefined);
        showToast('测试点已生成', 'success');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        pushActivity('已中断：已经生成的测试点保留', 'info');
      } else {
        setError(message);
        pushActivity(`生成测试点失败：${message}`, 'error');
      }
    } finally {
      setBusy(null);
      setRunProgress(null);
      abortRef.current = null;
    }
  }, [makeToolContext, pushActivity, requireModel, savePatch, testPointsPrompt]);

  /** 导出 XMind；浏览器端打包，失败只提示不打断页面 */
  const exportTestPointsXMind = useCallback(async () => {
    const current = docRef.current;
    if (!current?.testPoints) {
      showToast('还没有测试点可导出', 'info');
      return;
    }
    try {
      const name = await downloadTestPointsXMind(current);
      pushActivity(`已导出 ${name}`, 'done');
    } catch (err) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [pushActivity]);

  const exportTestPointsMarkdown = useCallback(() => {
    const current = docRef.current;
    if (!current?.testPoints) {
      showToast('还没有测试点可导出', 'info');
      return;
    }
    const name = downloadTestPointsMarkdown(current);
    pushActivity(`已导出 ${name}`, 'done');
  }, [pushActivity]);

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
      changeView('list');
      showToast('已删除分析记录', 'success');
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setConfirmDelete(false);
    }
  }, [changeView, docs, loadDoc]);

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

  /** 导出审查报告（覆盖率 + 按类型分组的缺口），与整份分析的 Markdown 分开 */
  const downloadReview = useCallback(() => {
    const current = docRef.current;
    if (!current?.check) return;
    const name = downloadReviewMarkdown(current, current.check);
    showToast(`已导出 ${name}`, 'success');
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
  // 上次停在工作台：等分析列表回来直接进工作台，不先闪一下空列表
  if (booting) return <PmLoading label="正在回到上次的分析" />;

  const outlineCovered = doc?.outline.filter((item) => outlineRefs.has(item.id)).length ?? 0;
  const checkGaps = doc?.check?.gaps ?? [];

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
                  const meta = statusMetaOf(item.status);
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
                        className="tw-icon-danger flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
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
    <div className="flex h-full min-h-0 flex-1 flex-col p-3">
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
                changeView('list');
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
            {/* 左栏：记录 / 提示词 / 动作 / 活动日志。来源就是当前这份分析自己带进来的，不再重复展示 */}
            <aside className="flex w-[280px] shrink-0 flex-col gap-3 overflow-y-auto pb-1">
              <section data-hint-width className="rounded-xl border border-stone-200 bg-white">
                <div className="flex items-center justify-between border-b border-stone-100 px-3.5 py-2.5">
                  <p className={SECTION_TITLE}>分析记录</p>
                  <span className="text-[11px] tabular-nums text-stone-400">{docs.length}</span>
                </div>
                <div className="px-2 py-2">
                  {docs.length ? (
                    <ul className="space-y-0.5">
                      {docs.map((item) => {
                        const active = item.id === docId;
                        const meta = statusMetaOf(item.status);
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                                active ? 'bg-[#eef3ff]' : 'hover:bg-stone-50'
                              }`}
                              onClick={() => loadDoc(item)}
                            >
                              <span className="min-w-0 flex-1">
                                <OverflowHint
                                  text={item.title}
                                  matchAnchorWidth
                                  className={`block truncate text-xs ${
                                    active ? 'font-medium text-[#1f4fd8]' : 'text-stone-700'
                                  }`}
                                />
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
                    <p className="px-1.5 py-1 text-xs text-stone-400">
                      还没有分析记录，选一份来源文档开始。
                    </p>
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-stone-200 bg-white">
                <div className="border-b border-stone-100 px-3.5 py-2.5">
                  <p className={SECTION_TITLE}>提示词</p>
                </div>
                <div className="px-3.5 py-3">
                  {/* 文件名一行、状态靠右对齐；文件过长时省略号 + 悬停气泡预览 */}
                  <div className="space-y-1.5">
                    <PromptStatusRow name={REQ_ANALYSIS_PROMPT_FILE} ready={promptReady} />
                    <PromptStatusRow
                      name={reviewPrompt?.file ?? STORY_REVIEW_PROMPT_FILE}
                      ready={
                        reviewGate.on &&
                        Boolean(reviewPrompt?.review.trim()) &&
                        Boolean(reviewPrompt?.fix.trim())
                      }
                    />
                    <PromptStatusRow
                      name={TEST_POINTS_PROMPT_FILE}
                      ready={tpGate.on && Boolean(testPointsPrompt?.generate.trim())}
                    />
                  </div>
                  <p
                    className={`mt-2 text-[11px] ${modelReady ? 'text-stone-400' : 'text-amber-700'}`}
                  >
                    {modelReady ? `模型：${settings?.model}` : '还没配置模型'}
                  </p>
                </div>
              </section>

              <section className="rounded-xl border border-stone-200 bg-white">
                <div className="border-b border-stone-100 px-3.5 py-2.5">
                  <p className={SECTION_TITLE}>动作</p>
                </div>
                <div className="space-y-2 px-3.5 py-3">
                  <button
                    type="button"
                    className={`${BTN_PRIMARY} w-full`}
                    disabled={!doc || Boolean(busy) || !doc.sourcePath}
                    onClick={() => {
                      if (doc?.stories.length) setConfirmDecompose(true);
                      else void decompose();
                    }}
                  >
                    {busy === 'decompose'
                      ? '拆解中…'
                      : doc?.stories.length
                        ? '重新拆解'
                        : '开始拆解'}
                  </button>
                  {reviewGate.on ? (
                    <button
                      type="button"
                      className={`${BTN_SECONDARY} w-full`}
                      disabled={!doc || Boolean(busy) || !doc.stories.length}
                      onClick={() => void runAudit()}
                    >
                      {busy === 'audit'
                        ? '审查中…'
                        : doc?.check
                          ? '重新审查用户故事'
                          : '用户故事审查'}
                    </button>
                  ) : null}
                  {tpGate.on ? (
                    <button
                      type="button"
                      className={`${BTN_SECONDARY} w-full`}
                      disabled={!doc || Boolean(busy) || !doc.stories.length}
                      onClick={() => void runTestPoints()}
                    >
                      {busy === 'testpoints'
                        ? '生成中…'
                        : doc?.testPoints
                          ? '重新生成测试点'
                          : '生成测试点'}
                    </button>
                  ) : null}
                  {/* 跑任务时只留「中断」：导出还没东西可导，删除也不该在拆解中途出现。
                      两者都是整宽单按钮，不会因为并排把文案挤换行。 */}
                  {busy ? (
                    <button type="button" className={`${BTN_SECONDARY} w-full`} onClick={stop}>
                      中断
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`${BTN_SECONDARY} w-full`}
                      disabled={!doc}
                      onClick={downloadMarkdown}
                    >
                      导出 Markdown
                    </button>
                  )}
                  {doc && !busy ? (
                    <button
                      type="button"
                      className="h-8 w-full rounded-md text-xs text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500"
                      onClick={() => setConfirmDelete(true)}
                    >
                      删除这份分析
                    </button>
                  ) : null}
                </div>
              </section>

              <section className="flex min-h-[140px] flex-1 flex-col rounded-xl border border-stone-200 bg-white">
                <div className="flex shrink-0 items-center justify-between border-b border-stone-100 px-3.5 py-2.5">
                  <p className={SECTION_TITLE}>活动日志</p>
                  {activity.length ? (
                    <button
                      type="button"
                      className="text-[11px] text-stone-400 transition-colors hover:text-stone-600"
                      onClick={() => setActivity([])}
                    >
                      清空
                    </button>
                  ) : null}
                </div>
                <div
                  ref={activityBoxRef}
                  className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3.5 py-2.5"
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
                    <p className="text-[11px] leading-relaxed text-stone-400">
                      拆解 / 审查的过程会记在这里：抽取需求条目、写故事、跑审查与补写。
                    </p>
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
                  <header className="shrink-0 rounded-xl border border-stone-200 bg-white">
                    <div className="px-4 pt-3">
                      <div className="flex items-center gap-2">
                        <input
                          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
                          defaultValue={doc.title}
                          key={doc.id}
                          aria-label="分析标题"
                          onBlur={(e) => renameDoc(e.target.value)}
                        />
                        {busy ? (
                          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-stone-500">
                            <span className="tw-lib-spin" aria-hidden="true" />
                            {runProgress
                              ? runProgress.message
                              : busy === 'decompose'
                                ? '拆解中'
                                : busy === 'audit'
                                  ? '审查中'
                                  : busy === 'testpoints'
                                    ? '生成测试点中'
                                    : busy === 'fix'
                                      ? '补写中'
                                      : '处理中'}
                            {runProgress && runProgress.total > 0 ? (
                              <span className="tabular-nums text-stone-400">
                                {Math.round(
                                  (Math.min(runProgress.done, runProgress.total) /
                                    runProgress.total) *
                                    100,
                                )}
                                %
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                        <PmTag tone={statusMetaOf(doc.status).tone}>
                          {statusMetaOf(doc.status).label}
                        </PmTag>
                      </div>
                      {/* 执行进度：知道总数就按批次 / 阶段推进，不知道总数时只滑动不报数 */}
                      {busy ? (
                        <div className="mt-2">
                          <div
                            className="tw-run-track"
                            role="progressbar"
                            aria-label={`${runProgress?.label ?? '任务'}进度`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={
                              runProgress && runProgress.total > 0
                                ? Math.round(
                                    (Math.min(runProgress.done, runProgress.total) /
                                      runProgress.total) *
                                      100,
                                  )
                                : undefined
                            }
                          >
                            <div
                              className={
                                runProgress && runProgress.total > 0
                                  ? 'tw-run-fill'
                                  : 'tw-run-fill tw-run-fill--indeterminate'
                              }
                              style={
                                runProgress && runProgress.total > 0
                                  ? {
                                      width: `${Math.round(
                                        (Math.min(runProgress.done, runProgress.total) /
                                          runProgress.total) *
                                          100,
                                      )}%`,
                                    }
                                  : undefined
                              }
                            />
                          </div>
                        </div>
                      ) : null}
                      {/* 一行元信息：数字加粗、项之间用浅色竖线分隔，来源靠右省略 */}
                      <div className="mt-2 flex min-w-0 items-center gap-2.5 text-[11px] text-stone-400">
                        <span className="shrink-0">
                          故事{' '}
                          <span className="font-medium text-stone-600">{doc.stories.length}</span>
                        </span>
                        <span className="h-3 w-px shrink-0 bg-stone-200" aria-hidden="true" />
                        <span className="shrink-0">
                          条目{' '}
                          <span className="font-medium text-stone-600">
                            {outlineCovered}/{doc.outline.length}
                          </span>{' '}
                          覆盖
                        </span>
                        {reviewGate.on ? (
                          <>
                            <span className="h-3 w-px shrink-0 bg-stone-200" aria-hidden="true" />
                            <span className="shrink-0">
                              缺口{' '}
                              <span className="font-medium text-stone-600">{checkGaps.length}</span>
                              {selectedGaps ? ` · 已选 ${selectedGaps}` : ''}
                            </span>
                            {doc.check ? (
                              <>
                                <span
                                  className="h-3 w-px shrink-0 bg-stone-200"
                                  aria-hidden="true"
                                />
                                <span className="shrink-0">
                                  覆盖率{' '}
                                  <span className="font-medium text-stone-600">
                                    {doc.check.coverage.total
                                      ? `${Math.round(doc.check.coverage.rate * 100)}%`
                                      : '—'}
                                  </span>
                                </span>
                              </>
                            ) : null}
                          </>
                        ) : null}
                        {tpGate.on ? (
                          <>
                            <span className="h-3 w-px shrink-0 bg-stone-200" aria-hidden="true" />
                            <span className="shrink-0">
                              测试点{' '}
                              <span className="font-medium text-stone-600">
                                {doc.testPoints?.points.length ?? 0}
                              </span>
                            </span>
                          </>
                        ) : null}
                        <span className="ml-auto min-w-0 truncate pl-2">
                          来源：{doc.sourcePath}
                        </span>
                        {sourceChanged ? (
                          <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                            源文档已更新
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div
                      role="tablist"
                      aria-label="需求分析视图"
                      className="mt-2.5 flex items-center gap-1 border-b border-stone-100 px-2"
                    >
                      {(
                        [
                          { id: 'stories', label: '用户故事', count: doc.stories.length },
                          { id: 'check', label: '审查结果', count: checkGaps.length },
                          { id: 'outline', label: '需求条目', count: doc.outline.length },
                          {
                            id: 'points',
                            label: '测试点',
                            count: doc.testPoints?.points.length ?? 0,
                          },
                        ] as const
                      )
                        .filter(
                          (item) =>
                            (item.id !== 'check' || reviewGate.on) &&
                            (item.id !== 'points' || tpGate.on),
                        )
                        .map((item) => {
                          const active = tab === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              role="tab"
                              aria-selected={active}
                              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs transition-colors ${
                                active
                                  ? 'border-[#3370ff] font-medium text-[#3370ff]'
                                  : 'border-transparent text-stone-500 hover:text-stone-800'
                              }`}
                              onClick={() => setTab(item.id)}
                            >
                              {item.label}
                              <span
                                className={`rounded-full px-1.5 text-[10px] leading-4 tabular-nums ${
                                  active
                                    ? 'bg-[#eaf1ff] text-[#3370ff]'
                                    : 'bg-stone-100 text-stone-400'
                                }`}
                              >
                                {item.count}
                              </span>
                            </button>
                          );
                        })}
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

                    {tab === 'check' && reviewGate.on ? (
                      <StoryReviewReport
                        check={doc.check}
                        stories={doc.stories}
                        busy={Boolean(busy)}
                        onToggleGap={toggleGap}
                        onToggleAll={toggleAllGaps}
                        onFix={() => void fixSelected()}
                        onReview={() => void runAudit()}
                        onExport={downloadReview}
                      />
                    ) : null}

                    {tab === 'points' && tpGate.on ? (
                      <TestPointsPanel
                        doc={doc}
                        generating={busy === 'testpoints'}
                        busy={Boolean(busy)}
                        promptReady={Boolean(testPointsPrompt?.generate.trim())}
                        onGenerate={() => void runTestPoints()}
                        onExportXmind={() => void exportTestPointsXMind()}
                        onExportMarkdown={exportTestPointsMarkdown}
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
        message={`确认删除「${doc?.title ?? ''}」？故事、需求条目、体检报告与测试点都会一起删掉，来源需求文档不受影响。`}
        confirmLabel="删除"
        danger="solid"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void removeDoc()}
      />

      <ConfirmDialog
        open={confirmDecompose}
        title="重新拆解"
        message={`重新拆解会用模型结果替换当前 ${doc?.stories.length ?? 0} 个用户故事，旧体检报告、测试点与需求条目也会一起清掉，编号从 US-001 重新开始。`}
        confirmLabel="重新拆解"
        onClose={() => setConfirmDecompose(false)}
        onConfirm={() => {
          // 先收起弹窗再开跑：拆解过程本身有「拆解中…」状态，弹窗留着会挡操作
          setConfirmDecompose(false);
          void decompose();
        }}
      />
    </div>
  );
}
