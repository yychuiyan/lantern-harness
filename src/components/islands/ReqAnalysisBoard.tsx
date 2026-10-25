/**
 * 需求分析工作台。
 *
 * 左栏：分析记录、提示词状态、动作、活动日志；
 * 右栏 Tab：需求条目 / 用户故事 / 审查结果 / 测试点。
 * 左栏动作分步：拆解需求 → 生成用户故事 →（可选）审查 →（可选）测试点。
 *
 * 「用户故事审查」是独立插件（storyReview），但没有独立菜单：开关打开时
 * 左栏多一个「用户故事审查」按钮、右栏多一个「审查结果」Tab，审查用
 * `用户故事审查提示词.md` 的「审查 / 补写」两段；关闭时这些入口整体不显示。
 *
 * 「生成测试点」同样嵌在这里（testPoints）：开关打开时左栏多一个「生成测试点」
 * 按钮、右栏多一个「测试点」Tab，用 `测试点生成提示词.md` 的「生成」一段，
 * 结果按「需求标题 → 五维 → 测试点」展示（列表 / 导图），也可导出 XMind（逻辑图）与 Markdown。
 *
 * 模型在浏览器里跑（`streamChatWithTools`），工具通过 HTTP 落到
 * `/__tb_reqanalysis`。故事与条目在每次工具调用后立即落盘，中途离开
 * 只中断当前这一批，已经写好的内容保留。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { hydrateAppConfig } from '../../lib/app-config';
import { clearHydrateCache } from '../../lib/hydrate-cache';
import { streamChatWithTools, type ChatMessage } from '../../lib/llm';
import { pluginDisabledMessage } from '../../lib/plugins';
import {
  auditStories,
  batchOutlineForStoryGen,
  createReqDoc,
  deleteReqDoc,
  exportFileName,
  fetchReqAnalysisHealth,
  fetchReqPrompt,
  extractIdealRequirementTitles,
  buildPriorOutlineIndex,
  fillMissingSourceRefs,
  filterIgnoredFromGaps,
  filterMainConfirmGaps,
  formatAuditHistoryForPrompt,
  formatOutlinePointsForTestPoints,
  formatPriorMemoryForPrompt,
  formatReqSectionOrderBlock,
  groupOutlineParents,
  listPriorReqAnalyses,
  listReqDocs,
  listReqSources,
  mergeStories,
  outlineCoverageItems,
  outlineLabelById,
  outlinePointExcerpt,
  outlineTitleById,
  reconcileAuditGaps,
  remapOutlineRefs,
  removeOutlinePoint,
  resolvePriorMemoryDocs,
  retrievePriorOutlineHits,
  sortStoriesByOutlineDocOrder,
  readReqSource,
  readReqSourceExcerpt,
  REQ_ANALYSIS_DIR,
  REQ_ANALYSIS_PROMPT_FILE,
  REQ_STATUS_META,
  reqAnalysisLabel,
  reqSourceFileName,
  seedOutlineFromDoc,
  sourceHashOf,
  splitRequirementSections,
  storyCompletenessHints,
  syncReqPrompt,
  toMarkdown,
  uncoveredOutlineItems,
  updateOutlinePointText,
  updateReqDoc,
  type ReqAnalysisDoc,
  type ReqDocPatch,
  type ReqGap,
  type ReqIgnoredGap,
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
  removeViewJson,
  writeViewJson,
  writeViewPref,
  writeViewText,
} from '../../lib/view-prefs';
import {
  downloadPendingConfirmMarkdown,
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
import MultiSelectDropdown from './MultiSelectDropdown';
import OverflowHint from './OverflowHint';
import { PmEmptyState, PmIcon, PmLoading, PmNotice, PmTag, usePmPlugin } from './PmShared';
import StoryReviewReport from './StoryReviewReport';
import TestPointsPanel from './TestPointsPanel';
import ReqStoryCard from './ReqStoryCard';
import SelectDropdown, { type SelectOption } from './SelectDropdown';
import { showToast } from './Toast';

function formatOutlineForPrompt(outline: ReqOutlineItem[]): string {
  if (!outline.length) return '（尚未播种文档条目）';
  const parents = outline.filter((item) => !item.parentId && !item.kind);
  const children = outline.filter((item) => item.parentId);
  if (!parents.length) {
    return outline
      .map((item) => {
        const kind = item.kind === 'query' ? '查询' : item.kind === 'mutate' ? '修改' : '条目';
        return `- ${item.id} [${kind}] ${item.title}${item.quote ? `（原文：${item.quote}）` : ''}`;
      })
      .join('\n');
  }
  const lines: string[] = [];
  for (const parent of parents) {
    lines.push(`- ${parent.id} [文档条目] ${parent.title}`);
    if (parent.body) {
      lines.push(`  原文：${parent.body.replace(/\s+/g, ' ').slice(0, 1500)}`);
    } else if (parent.quote) {
      lines.push(`  原文：${parent.quote}`);
    }
    const kids = children.filter((c) => c.parentId === parent.id);
    for (const kid of kids) {
      const kind = kid.kind === 'query' ? '查询' : kid.kind === 'mutate' ? '修改' : '子点';
      lines.push(`  - ${kid.id} [${kind}] ${kid.title}`);
    }
    if (!kids.length) {
      lines.push(
        '  （尚无查询/修改子点：按原文能力点逐条用 req_set_outline 提交，同一父级可有多条 query/mutate，勿合并）',
      );
    }
  }
  return lines.join('\n');
}

/** 本批必须挂上的查改子点（含短 quote），供按需求点生成故事 */
function formatMustCoverForPrompt(items: ReqOutlineItem[]): string {
  if (!items.length) return '（无）';
  return items
    .map((item) => {
      const kind = item.kind === 'query' ? '查询' : item.kind === 'mutate' ? '修改' : '条目';
      const quote = (item.quote || item.body || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      return `- ${item.id} [${kind}] ${item.title}${quote ? `\n  原文：${quote}` : ''}`;
    })
    .join('\n');
}

const DOC_PREF = 'reqanalysis.doc';
/** 列表页的视图：按需求说明书 / 按用户故事（记忆） */
const LIST_MODE_PREF = 'reqanalysis.listmode';
/** 上次停在列表还是某份分析的工作台（记忆） */
const VIEW_PREF = 'reqanalysis.view';
/** 工作台右侧页签（记忆） */
const TAB_PREF = 'reqanalysis.tab';
/** 左栏提示词卡片是否展开（记忆） */
const PROMPT_CARD_PREF = 'reqanalysis.promptCardOpen';
/** 「按用户故事」列表的搜索词（记忆） */
const STORY_KW_PREF = 'reqanalysis.storykeyword';
const VIEW_MODES = ['list', 'work'] as const;
const TAB_IDS = ['outline', 'stories', 'check', 'points'] as const;

interface ActivityItem {
  id: number;
  /** stage：一轮任务的开始分隔条；其余是过程里的具体步骤 */
  kind: 'info' | 'tool' | 'done' | 'error' | 'stage';
  text: string;
  /** 补充说明：工具参数、批次章节、耗时、产出条数等 */
  detail?: string;
  at: string;
}

/**
 * 活动日志按「分析 id」存在本地偏好里：刷新、切走再回来都还在。
 * 只留最近 200 条，避免长跑把本地存储撑大。
 */
const ACTIVITY_PREF = 'reqanalysis.activity';
const ACTIVITY_MAX = 200;
const ACTIVITY_KINDS: ActivityItem['kind'][] = ['info', 'tool', 'done', 'error', 'stage'];

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
        typeof (row.detail ?? '') === 'string' &&
        ACTIVITY_KINDS.includes(row.kind as ActivityItem['kind'])
      );
    })
    .slice(-ACTIVITY_MAX);
}
type TabId = 'stories' | 'check' | 'outline' | 'points';
type ListMode = 'doc' | 'story';

type RunKind = 'decompose' | 'stories' | 'audit' | 'fix' | 'testpoints' | 'change-point';

interface RunSnapshot {
  docId: string;
  kind: RunKind;
  label: string;
  done: number;
  total: number;
  message: string;
  startedAt: number;
  status: 'running' | 'done' | 'stopped' | 'error';
  finishedAt?: number;
}

/**
 * 任务状态放在模块级：切菜单只卸载 React 岛屿，模块实例还在，后台继续跑的请求
 * 把进度写进这里；回到页面重新挂载时先接上，不会「切走就没状态」。
 * 刷新页面模块会重建，这时用 localStorage 里的最后一份快照说明上次跑到哪、跑完没有。
 */
const RUN_PREF = 'reqanalysis.run';
const RUN_KINDS: RunKind[] = ['decompose', 'stories', 'audit', 'fix', 'testpoints', 'change-point'];
let liveRun: RunSnapshot | null = null;
/** 当前任务的 AbortController：放模块级，切页回来「中断」按钮仍然能停掉后台任务 */
const runAbortRef: { current: AbortController | null } = { current: null };
const runSubs = new Set<(next: RunSnapshot | null) => void>();

function runKey(docId: string): string {
  return `${RUN_PREF}.${docId}`;
}

function publishRun(next: RunSnapshot | null): void {
  // 关掉提示时写一份 null，别让刷新后又被旧快照「复活」
  const docId = next?.docId ?? liveRun?.docId;
  liveRun = next;
  if (docId) writeViewJson(runKey(docId), next);
  for (const fn of runSubs) fn(next);
}

function subscribeRun(fn: (next: RunSnapshot | null) => void): () => void {
  runSubs.add(fn);
  return () => {
    runSubs.delete(fn);
  };
}

/**
 * 进度统一按 0–100 百分点。
 * 长等待用心跳渐近爬升（越接近上限越慢，但不会钉死在某一格），真正完成再 setRunPercent(100)。
 */
function setRunPercent(done: number, message?: string): void {
  if (!liveRun || liveRun.status !== 'running') return;
  const next = Math.max(0, Math.min(100, Math.round(done)));
  if (next === liveRun.done && (message === undefined || message === liveRun.message)) return;
  publishRun({
    ...liveRun,
    total: 100,
    done: next,
    ...(message !== undefined ? { message } : {}),
  });
}

/** 心跳 / 流式软爬的硬顶：留出 97–100 给写盘与收尾 */
const RUN_PULSE_CEILING = 96;

/**
 * 向 ceiling 渐近爬一格：远处可按 burst 走，近处只 +1。
 * 不回退；到顶后由心跳降频继续挤，但不会超过 RUN_PULSE_CEILING。
 */
function pulseRun(ceiling: number, burst = 1): void {
  if (!liveRun || liveRun.status !== 'running') return;
  const cap = Math.max(1, Math.min(RUN_PULSE_CEILING, Math.round(ceiling)));
  const cur = liveRun.done;
  if (cur >= cap) return;
  const remaining = cap - cur;
  const step = remaining > 28 ? Math.min(Math.max(1, burst), remaining) : 1;
  publishRun({
    ...liveRun,
    total: 100,
    done: Math.min(cap, cur + step),
  });
}

/**
 * 无输出时也缓慢推进：离终点越近跳过越多拍，整体偏慢，但每隔一段时间仍会 +1。
 */
function startRunHeartbeat(ceiling: number, intervalMs = 1200): () => void {
  let tick = 0;
  const id = window.setInterval(() => {
    if (!liveRun || liveRun.status !== 'running') return;
    const cap = Math.max(1, Math.min(RUN_PULSE_CEILING, Math.round(ceiling)));
    const remaining = cap - liveRun.done;
    if (remaining <= 0) return;
    tick += 1;
    const every =
      remaining > 40 ? 1 : remaining > 24 ? 2 : remaining > 12 ? 3 : remaining > 5 ? 5 : 8;
    if (tick % every !== 0) return;
    pulseRun(ceiling, 1);
  }, intervalMs);
  return () => window.clearInterval(id);
}

/** 读回某份分析的最后一次任务快照；结构对不上的直接丢掉 */
function readStoredRun(docId: string): RunSnapshot | null {
  if (!docId) return null;
  const raw = readViewJson<unknown>(runKey(docId), null);
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<RunSnapshot>;
  if (typeof row.label !== 'string' || typeof row.message !== 'string') return null;
  if (!RUN_KINDS.includes(row.kind as RunKind)) return null;
  // 刷新前记的 running 说明请求已经跟页面一起没了，按「中断」展示
  const status = row.status === 'done' || row.status === 'error' ? row.status : 'stopped';
  return {
    docId,
    kind: row.kind as RunKind,
    label: row.label,
    done: Math.max(0, Number(row.done) || 0),
    total: Math.max(0, Number(row.total) || 0),
    message: row.message,
    startedAt: Number(row.startedAt) || 0,
    status,
    finishedAt: Number(row.finishedAt) || undefined,
  };
}

/** 去掉扩展名：word / excel / md 都适用 */
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

/** 活动日志每行前面的时刻，精确到秒，方便对上「卡在哪一步」 */
function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** 把工具参数 / 返回值压成一行短说明，日志里不至于铺开整段 JSON */
function briefText(value: unknown, max = 160): string {
  if (value === undefined || value === null) return '';
  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '';
  }
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 耗时：不足 1 秒也给出可读值 */
function elapsedText(from: number): string {
  const seconds = Math.max(0, (Date.now() - from) / 1000);
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
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
  /**
   * 本轮任务的进度：由模块级 store 驱动。
   * 切菜单回来重新挂载时先接上后台还在跑的任务，跑完了也能看到结论。
   */
  const [run, setRun] = useState<RunSnapshot | null>(() => liveRun);
  useEffect(() => {
    setRun(liveRun);
    return subscribeRun(setRun);
  }, []);
  /** 正在跑的任务类型；跨分析也阻止并发，避免两个任务同时改同一份文档 */
  const busy: RunKind | null = run?.status === 'running' ? run.kind : null;
  /** 头部进度只用当前分析的；别的分析在后台跑时不要在标题旁显示别人的进度 */
  const runProgress =
    run?.status === 'running' && run.docId === docId
      ? { label: run.label, done: run.done, total: run.total, message: run.message }
      : null;
  /** 挂载时刻：早于它结束的任务是「切走期间跑完的」，回来给一行结论 */
  const mountedAtRef = useRef(Date.now());
  const finishedRun =
    run &&
    run.docId === docId &&
    run.status !== 'running' &&
    (run.finishedAt ?? 0) < mountedAtRef.current
      ? run
      : null;
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<TabId>(() => readViewPref(TAB_PREF, TAB_IDS, 'outline'));
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
  /** 首屏一律等列表拉完再揭卡，避免刷新缓存撤掉后先闪空列表 / 空工作台 */
  const [booting, setBooting] = useState(true);
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
  /** Ideal 表「一行一条」的需求标题，测试点归组 / 导出共用 */
  const [idealReqTitles, setIdealReqTitles] = useState<string[]>([]);
  const idealReqTitlesRef = useRef<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmOutline, setConfirmOutline] = useState(false);
  const [confirmStories, setConfirmStories] = useState(false);
  const [confirmTestPoints, setConfirmTestPoints] = useState(false);
  /** 左栏提示词卡片展开；按空间记本地 */
  const [promptCardOpen, setPromptCardOpen] = useState(
    () => readViewText(PROMPT_CARD_PREF, '1') !== '0',
  );
  /** 子点「变更需求点」弹窗 */
  const [changePoint, setChangePoint] = useState<{
    pointId: string;
    parentId: string;
  } | null>(null);
  const [changeDraft, setChangeDraft] = useState('');
  const [confirmDeletePointId, setConfirmDeletePointId] = useState<string | null>(null);

  const docRef = useRef<ReqAnalysisDoc | null>(null);
  const activityIdRef = useRef(0);
  const activityBoxRef = useRef<HTMLDivElement | null>(null);
  const checkSaveRef = useRef<number | null>(null);
  /** 每个分析 id 只自动补挂一次空 sourceRefs，避免反复写盘 */
  const sourceRefBackfillRef = useRef('');
  /** 本轮审查是否允许模型新开待确认（初审 / 全量扫描 true；默认复审 false） */
  const auditAllowNewRef = useRef(true);
  /** 本轮因止增丢弃的新报条数 */
  const auditSuppressedRef = useRef(0);
  /** 本轮审查开始时的待确认底稿（规则预写不得冲掉，供复审合并 / 历史提示） */
  const auditPrevGapsRef = useRef<ReqGap[]>([]);

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

  /** 来源下拉：能拆解的排前面，同档按上传时间新→旧 */
  const sourceOptions = useMemo<SelectOption[]>(() => {
    const rank = (file: ReqSourceFile) => (file.supported ? 0 : 1);
    const uploadedAt = (file: ReqSourceFile) => file.ctime || file.mtime || 0;
    return [...sources]
      .filter((file) => !isOfficeLockFile(file.name))
      .sort(
        (a, b) =>
          rank(a) - rank(b) || uploadedAt(b) - uploadedAt(a) || a.path.localeCompare(b.path, 'zh'),
      )
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

  const pushActivity = useCallback(
    (text: string, kind: ActivityItem['kind'] = 'info', detail?: string) => {
      activityIdRef.current += 1;
      setActivity((prev) => [
        ...prev,
        {
          id: activityIdRef.current,
          kind,
          text,
          detail: detail?.trim() || undefined,
          at: new Date().toISOString(),
        },
      ]);
    },
    [],
  );

  /* --------------------------- 任务进度（跨页保留） --------------------------- */

  /** 开始一轮任务：进度写进模块级 store；total 固定 100（百分点） */
  const beginRun = useCallback((kind: RunKind, label: string, _total: number, message: string) => {
    publishRun({
      docId: docRef.current?.id ?? '',
      kind,
      label,
      done: 0,
      total: 100,
      message,
      startedAt: Date.now(),
      status: 'running',
    });
  }, []);

  /** 推进进行中的进度（done 按百分点理解） */
  const reportRun = useCallback(
    (patch: { label?: string; done?: number; total?: number; message?: string }) => {
      if (!liveRun || liveRun.status !== 'running') return;
      const nextDone =
        patch.done != null ? Math.max(0, Math.min(100, Math.round(patch.done))) : liveRun.done;
      publishRun({
        ...liveRun,
        ...patch,
        total: 100,
        done: nextDone,
      });
    },
    [],
  );

  /** 收尾：完成时进度落到 100；中断 / 失败保留当前进度 */
  const finishRun = useCallback(
    (kind: RunKind, status: 'done' | 'stopped' | 'error', message?: string) => {
      // 拆解完会接着跑审查：任务已经换成别人的话，不要再改写它的状态
      if (liveRun?.kind !== kind) return;
      runAbortRef.current = null;
      publishRun({
        ...liveRun,
        status,
        done: status === 'done' ? 100 : liveRun.done,
        total: 100,
        message: message ?? liveRun.message,
        finishedAt: Date.now(),
      });
    },
    [],
  );

  /** 接上模块级 store 的最新进度 / 换分析时读回该分析的最后一份快照 */
  useEffect(() => {
    if (!docId) return;
    setRun(liveRun ?? readStoredRun(docId));
  }, [docId]);

  /** 关掉「上次任务」提示：连同本地快照一起清掉 */
  const dismissRun = useCallback(() => {
    // 刷新后 liveRun 已经没了，提示来自本地快照，按当前分析清一次
    if (docId) writeViewJson(runKey(docId), null);
    publishRun(null);
  }, [docId]);

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

  const applyIdealTitles = useCallback((docId: string, titles: string[]) => {
    const prev = idealReqTitlesRef.current;
    const same = prev.length === titles.length && prev.every((item, i) => item === titles[i]);
    idealReqTitlesRef.current = titles;
    if (!same) setIdealReqTitles(titles);
    if (docId) writeViewJson(`reqanalysis.idealTitles.${docId}`, titles);
  }, []);

  const loadDoc = useCallback((next: ReqAnalysisDoc | null) => {
    docRef.current = next;
    setDoc(next);
    setDocId(next?.id ?? '');
    writeViewText(DOC_PREF, next?.id ?? '');
    if (next?.sourcePath) setSourcePick(next.sourcePath);
    // 同步恢复缓存的 Ideal 行标题，避免首屏先按故事归组再跳成按行归组而闪一下
    if (next?.id) {
      const cached = readViewJson<string[]>(`reqanalysis.idealTitles.${next.id}`, []);
      const titles = Array.isArray(cached) ? cached.filter((t) => typeof t === 'string') : [];
      idealReqTitlesRef.current = titles;
      setIdealReqTitles(titles);
    } else {
      idealReqTitlesRef.current = [];
      setIdealReqTitles([]);
    }
  }, []);

  /** 打开旧分析时：空 sourceRefs 按标题补挂一次并写回 */
  useEffect(() => {
    const current = doc;
    if (!current?.id) return;
    if (sourceRefBackfillRef.current === current.id) return;
    if (!current.outline.length || !current.stories.some((s) => !s.sourceRefs.length)) {
      sourceRefBackfillRef.current = current.id;
      return;
    }
    const { stories, filled } = fillMissingSourceRefs(current.stories, current.outline);
    sourceRefBackfillRef.current = current.id;
    if (!filled) return;
    let cancelled = false;
    void updateReqDoc(current.id, { stories })
      .then((saved) => {
        if (cancelled) return;
        patchDoc(saved);
        showToast(`已自动挂上 ${filled} 条需求点`, 'success');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, patchDoc]);

  /** 历史迭代记忆未设置时：默认全选同产品更早分析并落盘 */
  useEffect(() => {
    const current = doc;
    if (!current?.id) return;
    if (current.priorMemoryDocIds !== undefined) return;
    if (!docs.length) return;
    const ids = listPriorReqAnalyses(current, docs).map((item) => item.id);
    let cancelled = false;
    void updateReqDoc(current.id, { priorMemoryDocIds: ids })
      .then((saved) => {
        if (cancelled) return;
        patchDoc(saved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, docs, patchDoc]);

  const priorMemoryCandidates = useMemo(() => {
    if (!doc) return [];
    return listPriorReqAnalyses(doc, docs);
  }, [doc, docs]);

  const priorMemoryOptions = useMemo(
    () =>
      priorMemoryCandidates.map((item) => ({
        value: item.id,
        label: reqAnalysisLabel(item),
      })),
    [priorMemoryCandidates],
  );

  /** 按当前批文本检索已选历史分析的条目，拼进 prompt */
  const buildPriorMemoryBlock = useCallback(
    (queryText: string): string => {
      const current = docRef.current;
      if (!current?.priorMemoryDocIds?.length) return '';
      const priorDocs = resolvePriorMemoryDocs(current.priorMemoryDocIds, docs);
      if (!priorDocs.length) return '';
      const hits = retrievePriorOutlineHits(queryText, buildPriorOutlineIndex(priorDocs));
      if (!hits.length) return '';
      const docCount = new Set(hits.map((hit) => hit.docId)).size;
      pushActivity(`历史记忆命中 ${hits.length} 条（来自 ${docCount} 版）`);
      return formatPriorMemoryForPrompt(hits);
    },
    [docs, pushActivity],
  );

  /** 切换列表 / 工作台，同时写回本地记忆 */
  const changeView = useCallback((next: 'list' | 'work') => {
    setView(next);
    writeViewPref(VIEW_PREF, next);
  }, []);

  /** 从正文抽出 Ideal 行标题，供测试点按「一行一条需求」归组 */
  const syncIdealTitlesFromSource = useCallback(
    async (target: ReqAnalysisDoc | null) => {
      if (!target?.sourcePath) {
        applyIdealTitles('', []);
        return [];
      }
      try {
        const content = await readReqSource(target.sourcePath);
        const titles = extractIdealRequirementTitles(content);
        applyIdealTitles(target.id, titles);
        return titles;
      } catch {
        applyIdealTitles(target.id, idealReqTitlesRef.current);
        return idealReqTitlesRef.current;
      }
    },
    [applyIdealTitles],
  );

  /** 从正文抽出 Ideal 行标题，供测试点按「一行一条」归组（分析记录名用文件名，不再改成大模块名） */
  const syncTitleFromSource = useCallback(
    async (target: ReqAnalysisDoc) => {
      try {
        const content = await readReqSource(target.sourcePath);
        const titles = extractIdealRequirementTitles(content);
        applyIdealTitles(target.id, titles);
        return target;
      } catch {
        return target;
      }
    },
    [applyIdealTitles],
  );

  /**
   * 进工作台看某份分析：加载数据、可指定落到哪个页签。
   * 顺手清掉刷新缓存——缓存里如果是列表，切进工作台后它会在挂载前闪一下。
   */
  const openDoc = useCallback(
    (next: ReqAnalysisDoc, nextTab: TabId = 'outline') => {
      loadDoc(next);
      setTab(nextTab);
      changeView('work');
      clearHydrateCache('req-analysis');
      void syncTitleFromSource(next);
    },
    [changeView, loadDoc, syncTitleFromSource],
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
            hit(reqSourceFileName(item)) ||
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
      if (!ok) {
        setBooting(false);
        return;
      }
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
        // 等正文标题 / Ideal 行标题就绪再揭开首屏，避免归组从「故事」跳到「行」闪一下
        if (pick) await syncTitleFromSource(pick);
        if (!alive) return;
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
  }, [changeView, loadDoc, syncTitleFromSource]);

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

  /** 打开测试点 Tab 时补齐 Ideal 行标题（导图 / 列表 / 导出共用） */
  useEffect(() => {
    if (tab !== 'points' || !doc?.sourcePath) return;
    if (idealReqTitlesRef.current.length) return;
    void syncIdealTitlesFromSource(doc);
  }, [tab, doc, syncIdealTitlesFromSource]);

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
  const outlinePromptReady = Boolean(realPrompt?.decompose.trim());
  const storiesPromptReady = Boolean((realPrompt?.stories || realPrompt?.decompose || '').trim());
  const promptReady = outlinePromptReady || storiesPromptReady;
  const selectedGaps = useMemo(
    () => (doc?.check?.gaps ?? []).filter((gap) => gap.selected).length,
    [doc?.check],
  );
  const checkGaps = useMemo(
    () => filterIgnoredFromGaps(filterMainConfirmGaps(doc?.check?.gaps ?? []), doc?.ignoredGaps),
    [doc?.check?.gaps, doc?.ignoredGaps],
  );
  const outlineTitleMap = useMemo(() => outlineTitleById(doc?.outline ?? []), [doc?.outline]);
  const outlineLabelMap = useMemo(() => outlineLabelById(doc?.outline ?? []), [doc?.outline]);
  const outlineGroups = useMemo(
    () => (doc ? groupOutlineParents(doc.outline, doc.stories) : []),
    [doc],
  );
  const storiesInDocOrder = useMemo(
    () => (doc ? sortStoriesByOutlineDocOrder(doc.stories, doc.outline) : []),
    [doc],
  );
  const [expandedOutline, setExpandedOutline] = useState<Record<string, boolean>>({});
  const [expandedOutlinePoints, setExpandedOutlinePoints] = useState<Record<string, boolean>>({});
  const ignoredGaps = doc?.ignoredGaps ?? [];

  const jumpToOutlinePoint = useCallback((outlineId: string) => {
    const current = docRef.current;
    if (!current) return;
    const item = current.outline.find((o) => o.id === outlineId);
    const parentId = item?.parentId || outlineId;
    const pointId = item?.parentId ? outlineId : '';
    setTab('outline');
    setExpandedOutline((prev) => ({ ...prev, [parentId]: true }));
    if (pointId) {
      setExpandedOutlinePoints((prev) => ({ ...prev, [pointId]: true }));
    }
    requestAnimationFrame(() => {
      const el =
        (pointId && document.getElementById(`req-outline-point-${pointId}`)) ||
        document.getElementById(`req-outline-${parentId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, []);

  /** 测试点「所属需求」（Ideal 行标题）→ 需求条目：优先落该行故事挂上的查/改子点 */
  const jumpToRequirementOutline = useCallback(
    (reqTitle: string, storyIds: string[] = []) => {
      const current = docRef.current;
      if (!current || !reqTitle.trim()) return;
      const title = reqTitle.trim();
      const refIds = new Set(
        current.stories
          .filter((story) => storyIds.includes(story.id))
          .flatMap((story) => story.sourceRefs),
      );
      const pointFromRefs = current.outline.find(
        (item) => item.parentId && item.kind && refIds.has(item.id),
      );
      if (pointFromRefs) {
        jumpToOutlinePoint(pointFromRefs.id);
        return;
      }
      const parentHit =
        current.outline.find(
          (item) =>
            !item.parentId &&
            !item.kind &&
            (item.title === title || item.title.includes(title) || title.includes(item.title)),
        ) ??
        current.outline.find(
          (item) =>
            item.parentId &&
            item.kind &&
            (item.title === title || item.title.includes(title) || title.includes(item.title)),
        );
      if (parentHit) {
        jumpToOutlinePoint(parentHit.id);
        return;
      }
      setTab('outline');
      showToast('需求条目里没找到对应项', 'info');
    },
    [jumpToOutlinePoint],
  );

  const ignoreGapsByIds = useCallback(
    async (ids: string[]) => {
      const current = docRef.current;
      if (!current?.check || !ids.length) return;
      const moving = current.check.gaps.filter((gap) => ids.includes(gap.id));
      if (!moving.length) return;
      const now = new Date().toISOString();
      const nextIgnored: ReqIgnoredGap[] = [
        ...(current.ignoredGaps ?? []),
        ...moving.map((gap) => ({ ...gap, selected: false, ignoredAt: now })),
      ];
      const nextGaps = current.check.gaps.filter((gap) => !ids.includes(gap.id));
      const saved = await updateReqDoc(current.id, {
        check: { ...current.check, gaps: nextGaps },
        ignoredGaps: nextIgnored,
      });
      patchDoc(saved);
      showToast(`已忽略 ${moving.length} 项`, 'success');
    },
    [patchDoc],
  );

  const restoreIgnoredGap = useCallback(
    async (id: string) => {
      const current = docRef.current;
      if (!current) return;
      const item = (current.ignoredGaps ?? []).find((gap) => gap.id === id);
      if (!item) return;
      const { ignoredAt: _ignoredAt, ...gap } = item;
      const nextIgnored = (current.ignoredGaps ?? []).filter((g) => g.id !== id);
      const baseGaps = current.check?.gaps ?? [];
      const nextGaps = [...baseGaps, { ...gap, selected: false }];
      const saved = await updateReqDoc(current.id, {
        check: current.check
          ? { ...current.check, gaps: nextGaps }
          : {
              at: new Date().toISOString(),
              summary: '',
              coverage: { total: 0, covered: 0, rate: 0 },
              dimensions: [],
              gaps: nextGaps,
            },
        ignoredGaps: nextIgnored,
      });
      patchDoc(saved);
      showToast('已恢复到待确认清单', 'success');
    },
    [patchDoc],
  );

  const promoteIgnoredToStory = useCallback(
    async (id: string) => {
      const current = docRef.current;
      if (!current) return;
      const item = (current.ignoredGaps ?? []).find((gap) => gap.id === id);
      if (!item) return;
      const title =
        window.prompt('落成用户故事：请输入故事标题', item.title.replace(/^待确认[：:]/, '')) || '';
      if (!title.trim()) return;
      const draft: ReqStory = {
        id: '',
        title: title.trim(),
        role: '待确认',
        goal: item.suggestion || item.detail || title.trim(),
        value: '由忽略项落成，请补全字段',
        sourceRefs: item.outlineId ? [item.outlineId] : [],
        priority: 'P1',
        preconditions: [],
        mainFlow: [{ action: '按待确认项补齐主流程', result: '可验收' }],
        altFlows: [],
        exceptions: [],
        postconditions: [],
        acceptance: [{ given: '前置就绪', when: '执行操作', then: '结果可判定' }],
        dimensions: [],
      };
      const merged = mergeStories(current.stories, [draft]);
      const nextIgnored = (current.ignoredGaps ?? []).filter((g) => g.id !== id);
      const saved = await updateReqDoc(current.id, {
        stories: merged,
        ignoredGaps: nextIgnored,
        status: current.status === 'draft' ? 'decomposed' : current.status,
      });
      patchDoc(saved);
      setTab('stories');
      showToast('已落成用户故事', 'success');
    },
    [patchDoc],
  );

  /** 待确认缺口「填结论」：只写入 conclusion，不造故事；补写时再带给模型 */
  const saveGapConclusion = useCallback(
    async (gap: ReqGap, conclusion: string) => {
      const current = docRef.current;
      if (!current?.check) return;
      const text = conclusion.trim();
      if (!text) return;
      const nextGaps = current.check.gaps.map((item) =>
        item.id === gap.id ? { ...item, conclusion: text } : item,
      );
      const saved = await updateReqDoc(current.id, {
        check: { ...current.check, gaps: nextGaps },
      });
      patchDoc(saved);
      showToast('结论已保存', 'success');
    },
    [patchDoc],
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

  /** 选了一份来源：已有分析就复用，没有才新建，然后进工作台（默认需求条目 Tab） */
  const openSource = useCallback(
    async (path: string) => {
      if (!path) return null;
      const existing = docs.find((item) => item.sourcePath === path);
      if (existing) {
        openDoc(existing, 'outline');
        return existing;
      }
      try {
        const content = await readReqSource(path);
        const name = fileName(path);
        const created = await createReqDoc({
          sourcePath: path,
          sourceTitle: name,
          sourceHash: sourceHashOf(content),
          title: name,
        });
        setDocs((prev) => sortDocs([created, ...prev]));
        openDoc(created, 'outline');
        pushActivity(`新建分析：${reqSourceFileName(created)}`);
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
      saveIgnoredGaps: async (gaps) => {
        const saved = await updateReqDoc(target.id, { ignoredGaps: gaps });
        patchDoc(saved);
        return saved;
      },
      saveCheck: async (report) => {
        const currentDoc = docRef.current;
        // 用本轮开始时的底稿合并，避免规则预写冲掉上轮待确认后模型结果对不上
        const prevGaps =
          auditPrevGapsRef.current.length > 0
            ? auditPrevGapsRef.current
            : (currentDoc?.check?.gaps ?? []);
        const reconciled = reconcileAuditGaps(prevGaps, report.gaps, currentDoc?.ignoredGaps, {
          allowNew: auditAllowNewRef.current,
        });
        auditSuppressedRef.current += reconciled.suppressed;
        const next = {
          ...report,
          gaps: reconciled.gaps,
        };
        // 只写体检数据，不改 status：避免拆解阶段误调工具 / 审查中途就标成「已审查」
        const saved = await updateReqDoc(target.id, { check: next });
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

  /* ------------------------------ 拆解需求（只整理条目） ------------------------------ */

  const decomposeOutline = useCallback(async () => {
    const current = docRef.current;
    const model = requireModel();
    if (!current || !model) return;
    const promptText = realPrompt?.decompose.trim() ?? '';
    if (!promptText) {
      showToast(`没有读到「${REQ_ANALYSIS_PROMPT_FILE}」的「## 拆解需求」段落`, 'error');
      return;
    }
    setError('');
    setAnswer('');
    pushActivity('开始拆解需求', 'stage');
    beginRun('decompose', '拆解需求', 100, '正在读取来源文档');
    const controller = new AbortController();
    runAbortRef.current = controller;
    let outcome: 'done' | 'stopped' | 'error' = 'done';
    try {
      const started = await updateReqDoc(current.id, {
        status: 'draft',
        progress: {
          stage: 'outline',
          done: 0,
          total: 100,
          message: '正在读取来源文档',
          at: new Date().toISOString(),
        },
      });
      patchDoc(started);

      const content = await readReqSource(current.sourcePath);
      if (!content.trim()) throw new Error('来源文档是空的');
      const chunks = splitRequirementSections(content);
      if (!chunks.length) throw new Error('来源文档没有可拆解的内容');
      setRunPercent(5, `共 ${chunks.length} 批，准备整理需求条目`);
      pushActivity(
        chunks.length > 1
          ? `来源 ${content.length} 字，已分 ${chunks.length} 批整理条目`
          : `来源 ${content.length} 字，单批整理条目`,
      );

      // 重新拆解需求：按文档结构播种父级；清空子点、故事与体检（sourceRefs 会失效）
      const seeded = seedOutlineFromDoc(content, []);
      const reset = await updateReqDoc(current.id, {
        replaceStories: true,
        stories: [],
        outline: seeded,
        check: null,
        ignoredGaps: [],
        testPoints: null,
        status: 'draft',
        sourceHash: sourceHashOf(content),
      });
      patchDoc(reset);
      pushActivity(
        seeded.length
          ? `已按文档结构播种 ${seeded.length} 条需求条目`
          : '未能从文档结构抽出条目，将仅按原文整理',
      );
      const sectionHint = formatReqSectionOrderBlock(content);
      setTab('outline');

      for (const part of chunks) {
        if (controller.signal.aborted) break;
        const outlineBefore = docRef.current?.outline.length ?? 0;
        const outlineText = formatOutlineForPrompt(docRef.current?.outline ?? []);
        const priorMemory = buildPriorMemoryBlock(part.text);
        const system = [
          promptText,
          '',
          REQ_TOOL_GUIDE,
          priorMemory ? `\n${priorMemory}` : '',
          '',
          '## 需求条目（文档结构已播种；只用 req_set_outline 按能力点补查询/修改子点，同一父级可多条 query/mutate，本步不要写用户故事）',
          outlineText,
        ]
          .filter(Boolean)
          .join('\n');
        const user = [
          `这一批是原始需求的第 ${part.index + 1}/${chunks.length} 段${
            part.title ? `（章节：${part.title}）` : ''
          }。只整理这一段的查/改子点：一个可独立验收的能力点交一条，勿把多个能力点捆进同一 title；不要另造文档没有的条目标题；不要写用户故事。`,
          '',
          sectionHint ? `${sectionHint}\n` : '',
          '## 原始需求',
          '',
          part.text,
        ]
          .filter(Boolean)
          .join('\n');

        const batchStart = 5 + Math.floor((part.index / chunks.length) * 85);
        const batchEnd = 5 + Math.floor(((part.index + 1) / chunks.length) * 85);
        const isLastBatch = part.index === chunks.length - 1;
        const softCap = Math.max(
          batchStart + 1,
          isLastBatch ? Math.min(90, batchEnd) : Math.min(batchEnd - 2, 88),
        );

        await savePatch(
          {
            progress: {
              stage: 'outline',
              done: batchStart,
              total: 100,
              message: `正在整理第 ${part.index + 1}/${chunks.length} 批条目`,
              at: new Date().toISOString(),
            },
          },
          docRef.current,
        ).catch(() => undefined);

        const batchStartedAt = Date.now();
        pushActivity(
          `第 ${part.index + 1}/${chunks.length} 批开始（拆解需求）`,
          'info',
          [part.title ? `章节：${part.title}` : '', `${part.text.length} 字`]
            .filter(Boolean)
            .join(' · '),
        );
        setRunPercent(batchStart, `正在整理第 ${part.index + 1}/${chunks.length} 批条目`);
        const stopHb = startRunHeartbeat(softCap);

        try {
          for await (const chunk of streamChatWithTools(
            model,
            [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ] as ChatMessage[],
            controller.signal,
            {
              tools: REQ_ANALYSIS_TOOLS.filter((tool) => tool.function.name === 'req_set_outline'),
              maxToolRounds: 20,
              runTool: (name, args) =>
                runReqAnalysisTool(name, args, makeToolContext(current, part.index)),
            },
          )) {
            if (chunk.type === 'content') {
              setAnswer((prev) => prev + chunk.delta);
              pulseRun(softCap, 1);
            } else if (chunk.type === 'tool' && chunk.status === 'running') {
              pushActivity(`调用 ${chunk.name}`, 'tool', briefText(chunk.args));
              pulseRun(softCap, 1);
            } else if (chunk.type === 'tool' && chunk.status === 'done') {
              pushActivity(`${chunk.name} 返回`, 'tool', briefText(chunk.result, 120));
              pulseRun(softCap, 2);
            }
          }
        } finally {
          stopHb();
        }

        setRunPercent(
          Math.min(90, Math.max(softCap + 2, batchEnd - 2)),
          `第 ${part.index + 1}/${chunks.length} 批返回，正在写入`,
        );
        const added = Math.max(0, (docRef.current?.outline.length ?? 0) - outlineBefore);
        pushActivity(
          `第 ${part.index + 1}/${chunks.length} 批完成`,
          'done',
          `条目变化 +${added} · 耗时 ${elapsedText(batchStartedAt)}`,
        );
        setRunPercent(batchEnd, `第 ${part.index + 1}/${chunks.length} 批已写入`);
      }

      if (controller.signal.aborted) {
        pushActivity('已中断：已经写入的需求条目保留', 'info');
        return;
      }
      setRunPercent(92, '正在保存需求条目');
      const done = await updateReqDoc(current.id, {
        status: 'decomposed',
        progress: {
          stage: 'done',
          done: 100,
          total: 100,
          message: '需求条目已整理',
          at: new Date().toISOString(),
        },
      });
      patchDoc(done);
      pushActivity(`拆解需求完成：${done.outline.length} 条需求条目`, 'done');
      setTab('outline');
      setRunPercent(100, '需求条目已整理');
      showToast('需求条目已整理，可继续生成用户故事', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        outcome = 'stopped';
        pushActivity('已中断：已经写入的需求条目保留', 'info');
      } else {
        outcome = 'error';
        setError(message);
        pushActivity(`拆解需求失败：${message}`, 'error');
        // 失败保持 draft，禁止进入「生成用户故事」
        await updateReqDoc(current.id, { status: 'draft' })
          .then((saved) => patchDoc(saved))
          .catch(() => undefined);
      }
    } finally {
      if (controller.signal.aborted) outcome = 'stopped';
      finishRun(
        'decompose',
        outcome,
        outcome === 'done'
          ? '需求条目已整理'
          : outcome === 'stopped'
            ? '已中断：已经写入的需求条目保留'
            : '拆解需求失败，详见活动日志',
      );
    }
  }, [
    beginRun,
    buildPriorMemoryBlock,
    finishRun,
    makeToolContext,
    patchDoc,
    pushActivity,
    realPrompt,
    requireModel,
    savePatch,
  ]);

  /* ------------------------------ 子点变更需求点 ------------------------------ */

  const openChangePoint = useCallback((point: ReqOutlineItem, parent: ReqOutlineItem) => {
    if (!point.parentId || !point.kind) return;
    setChangePoint({ pointId: point.id, parentId: parent.id });
    const excerpt = outlinePointExcerpt(point, parent, []);
    setChangeDraft(point.body || point.quote || excerpt.text || '');
  }, []);

  const persistOutlineRemap = useCallback(
    async (
      target: ReqAnalysisDoc,
      outline: ReqOutlineItem[],
      idMap: Map<string, string>,
      removed: ReadonlySet<string> = new Set(),
    ) => {
      const remapped = remapOutlineRefs(
        {
          stories: target.stories,
          check: target.check,
          ignoredGaps: target.ignoredGaps,
        },
        idMap,
        removed,
      );
      const saved = await updateReqDoc(target.id, {
        outline,
        stories: remapped.stories,
        check: remapped.check,
        ignoredGaps: remapped.ignoredGaps,
      });
      patchDoc(saved);
      return saved;
    },
    [patchDoc],
  );

  const confirmDeleteOutlinePoint = useCallback(async () => {
    const current = docRef.current;
    const pointId = confirmDeletePointId;
    if (!current || !pointId) return;
    const result = removeOutlinePoint(current.outline, pointId);
    if (result.error) {
      showToast(result.error, 'error');
      setConfirmDeletePointId(null);
      return;
    }
    await persistOutlineRemap(current, result.outline, result.idMap, result.removedIds);
    pushActivity(`已删除需求点 ${pointId}，同父级序号已顺延`, 'done');
    setConfirmDeletePointId(null);
    setChangePoint(null);
    showToast('需求点已删除', 'success');
  }, [confirmDeletePointId, persistOutlineRemap, pushActivity]);

  const reviseOutlinePoint = useCallback(async () => {
    const current = docRef.current;
    const model = requireModel();
    if (!current || !model || !changePoint) return;
    const content = changeDraft.trim();
    if (!content) {
      showToast('请填写需求内容', 'error');
      return;
    }
    const promptText = realPrompt?.decompose.trim() ?? '';
    if (!promptText) {
      showToast(`没有读到「${REQ_ANALYSIS_PROMPT_FILE}」的「## 拆解需求」段落`, 'error');
      return;
    }
    const anchor = current.outline.find((item) => item.id === changePoint.pointId);
    const parent = current.outline.find((item) => item.id === changePoint.parentId);
    if (!anchor?.parentId || !parent) {
      showToast('找不到锚点需求点', 'error');
      return;
    }
    const afterId = changePoint.pointId;
    // 先本地写入原文，保证确认后列表立刻可见；模型再按需改标题/类型或拆出新子点
    const local = updateOutlinePointText(current.outline, afterId, {
      quote: content.slice(0, 2000),
      body: content,
    });
    if (local.error) {
      showToast(local.error, 'error');
      return;
    }
    const savedLocal = await updateReqDoc(current.id, { outline: local.outline });
    patchDoc(savedLocal);
    setChangePoint(null);
    setChangeDraft('');
    setError('');
    setAnswer('');
    pushActivity(`已写入需求点原文 ${afterId}`, 'done');
    pushActivity(`变更需求点 ${afterId}（模型整理）`, 'stage');
    beginRun('change-point', '变更需求点', 100, '正在根据需求内容整理子点');
    const controller = new AbortController();
    runAbortRef.current = controller;
    let outcome: 'done' | 'stopped' | 'error' = 'done';
    try {
      const outlineText = formatOutlineForPrompt(savedLocal.outline);
      const system = [
        promptText,
        '',
        REQ_TOOL_GUIDE,
        '',
        '## 本轮任务',
        `锚点 ${afterId} 的原文已按用户内容写入。请继续：`,
        `- 若标题或类型（查询/修改）需随内容调整：调用 req_update_outline_point（id 固定为 ${afterId}）；原文 quote/body 以用户内容为准，不要擅自删减用户已写的条目；`,
        `- 若用户内容里还含有其它独立能力点：调用 req_insert_outline_after，afterId 固定为 ${afterId}，插到锚点下方；`,
        `- 若只需保留当前锚点、无需新增：可以不调工具，直接简短说明即可。`,
        '不要改其它无关子点，不要写用户故事，不要调用 req_set_outline。',
        '',
        '## 需求条目',
        outlineText,
      ].join('\n');
      const user = [
        `锚点子点：${afterId} ${anchor.title}（${anchor.kind === 'mutate' ? '修改' : '查询'}）`,
        `已写入原文：${content.slice(0, 2000)}`,
        `所属条目：${parent.id} ${parent.title}`,
        parent.body || parent.quote
          ? `\n## 条目原文（参考）\n\n${(parent.body || parent.quote).slice(0, 4000)}`
          : '',
        '',
        '## 用户需求内容',
        '',
        content,
      ]
        .filter(Boolean)
        .join('\n');

      setRunPercent(10, '正在整理需求点');
      for await (const chunk of streamChatWithTools(
        model,
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ] as ChatMessage[],
        controller.signal,
        {
          tools: REQ_ANALYSIS_TOOLS.filter(
            (tool) =>
              tool.function.name === 'req_insert_outline_after' ||
              tool.function.name === 'req_update_outline_point',
          ),
          maxToolRounds: 8,
          runTool: (name, args) => runReqAnalysisTool(name, args, makeToolContext(savedLocal, 0)),
        },
      )) {
        if (chunk.type === 'content') {
          setAnswer((prev) => prev + chunk.delta);
          pulseRun(90, 1);
        } else if (chunk.type === 'tool' && chunk.status === 'running') {
          pushActivity(`调用 ${chunk.name}`, 'tool', briefText(chunk.args));
          pulseRun(90, 1);
        } else if (chunk.type === 'tool' && chunk.status === 'done') {
          pushActivity(`${chunk.name} 返回`, 'tool', briefText(chunk.result, 120));
          pulseRun(90, 2);
        }
      }
      if (controller.signal.aborted) {
        pushActivity('已中断：已写入的需求点保留', 'info');
        return;
      }
      setRunPercent(100, '需求点已更新');
      pushActivity(`已变更需求点 ${afterId}`, 'done');
      showToast('需求点已更新', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        outcome = 'stopped';
        pushActivity('已中断：已写入的需求点保留', 'info');
      } else {
        outcome = 'error';
        setError(message);
        pushActivity(`变更需求点失败：${message}`, 'error');
      }
    } finally {
      if (controller.signal.aborted) outcome = 'stopped';
      finishRun(
        'change-point',
        outcome,
        outcome === 'done'
          ? '需求点已更新'
          : outcome === 'stopped'
            ? '已中断：已写入的需求点保留'
            : '变更需求点失败',
      );
    }
  }, [
    beginRun,
    changeDraft,
    changePoint,
    finishRun,
    makeToolContext,
    patchDoc,
    pushActivity,
    realPrompt,
    requireModel,
  ]);

  /* ------------------------------ 生成用户故事 ------------------------------ */

  const generateStories = useCallback(async () => {
    const current = docRef.current;
    const model = requireModel();
    if (!current || !model) return;
    if (!current.outline.length) {
      showToast('还没有需求条目，请先点「拆解需求」', 'info');
      return;
    }
    if (current.status === 'draft') {
      showToast('请先成功拆解需求，再生成用户故事', 'info');
      return;
    }
    const promptText = (realPrompt?.stories || realPrompt?.decompose || '').trim();
    if (!promptText) {
      showToast(`没有读到「${REQ_ANALYSIS_PROMPT_FILE}」的「## 生成用户故事」段落`, 'error');
      return;
    }
    const coverageTargets = outlineCoverageItems(current.outline);
    if (!coverageTargets.length) {
      showToast('还没有可挂故事的需求点，请先拆解出查询/修改子点', 'info');
      return;
    }

    setError('');
    setAnswer('');
    pushActivity('开始生成用户故事', 'stage');
    beginRun('stories', '生成用户故事', 100, '正在按需求点生成');
    const controller = new AbortController();
    runAbortRef.current = controller;
    let outcome: 'done' | 'stopped' | 'error' = 'done';

    const runStoryRound = async (opts: {
      label: string;
      user: string;
      batchIndex: number;
      softCap: number;
      progressMsg: string;
    }): Promise<number> => {
      const before = docRef.current?.stories.length ?? 0;
      const outlineText = formatOutlineForPrompt(docRef.current?.outline ?? []);
      const priorMemory = buildPriorMemoryBlock(opts.user);
      const system = [
        promptText,
        '',
        REQ_TOOL_GUIDE,
        priorMemory ? `\n${priorMemory}` : '',
        '',
        '## 需求条目（sourceRefs 只能引用这些 id；本步只用 req_set_stories，不要改条目）',
        outlineText,
      ]
        .filter(Boolean)
        .join('\n');
      setRunPercent(Math.min(opts.softCap, Math.max(5, opts.softCap - 8)), opts.progressMsg);
      const stopHb = startRunHeartbeat(opts.softCap);
      let batchAnswer = '';
      try {
        for await (const chunk of streamChatWithTools(
          model,
          [
            { role: 'system', content: system },
            { role: 'user', content: opts.user },
          ] as ChatMessage[],
          controller.signal,
          {
            tools: REQ_ANALYSIS_TOOLS.filter((tool) => tool.function.name === 'req_set_stories'),
            maxToolRounds: 20,
            runTool: (name, args) =>
              runReqAnalysisTool(name, args, makeToolContext(current, opts.batchIndex)),
          },
        )) {
          if (chunk.type === 'content') {
            batchAnswer += chunk.delta;
            setAnswer((prev) => prev + chunk.delta);
            pulseRun(opts.softCap, 1);
          } else if (chunk.type === 'tool' && chunk.status === 'running') {
            pushActivity(`调用 ${chunk.name}`, 'tool', briefText(chunk.args));
            pulseRun(opts.softCap, 1);
          } else if (chunk.type === 'tool' && chunk.status === 'done') {
            pushActivity(`${chunk.name} 返回`, 'tool', briefText(chunk.result, 120));
            pulseRun(opts.softCap, 2);
          }
        }
      } finally {
        stopHb();
      }
      if ((docRef.current?.stories.length ?? 0) === before) {
        const fallback = parseStoriesFallback(batchAnswer);
        if (fallback.length) {
          const merged = mergeStories(docRef.current?.stories ?? [], fallback);
          const saved = await updateReqDoc(current.id, { stories: merged });
          patchDoc(saved);
          pushActivity(`模型没调工具，已从回答里兜底解析 ${fallback.length} 个故事`, 'info');
        } else {
          pushActivity(`${opts.label}没有拿到结构化故事`, 'error');
        }
      }
      return Math.max(0, (docRef.current?.stories.length ?? 0) - before);
    };

    try {
      const started = await updateReqDoc(current.id, {
        progress: {
          stage: 'stories',
          done: 0,
          total: 100,
          message: '正在按需求点生成用户故事',
          at: new Date().toISOString(),
        },
      });
      patchDoc(started);

      const content = await readReqSource(current.sourcePath);
      if (!content.trim()) throw new Error('来源文档是空的');

      const reset = await updateReqDoc(current.id, {
        replaceStories: true,
        stories: [],
        check: null,
        ignoredGaps: [],
        testPoints: null,
        status: 'decomposed',
      });
      patchDoc(reset);
      const batches = batchOutlineForStoryGen(reset.outline, 12);
      pushActivity(
        `按需求点生成：${outlineCoverageItems(reset.outline).length} 个覆盖目标 · ${batches.length} 批`,
      );
      setTab('stories');
      setRunPercent(5, `共 ${batches.length} 批，按需求点生成`);

      for (let i = 0; i < batches.length; i++) {
        if (controller.signal.aborted) break;
        const batch = batches[i]!;
        const batchStart = 5 + Math.floor((i / Math.max(1, batches.length)) * 70);
        const batchEnd = 5 + Math.floor(((i + 1) / Math.max(1, batches.length)) * 70);
        const softCap = Math.max(batchStart + 1, Math.min(batchEnd - 1, 74));
        const parentLabel = batch.parent
          ? `${batch.parent.id} ${batch.parent.title}`
          : '其它需求点';
        const mustIds = batch.mustCover.map((item) => item.id).join('、');
        await savePatch(
          {
            progress: {
              stage: 'stories',
              done: batchStart,
              total: 100,
              message: `正在生成第 ${i + 1}/${batches.length} 批（${parentLabel}）`,
              at: new Date().toISOString(),
            },
          },
          docRef.current,
        ).catch(() => undefined);

        const batchStartedAt = Date.now();
        pushActivity(
          `第 ${i + 1}/${batches.length} 批开始`,
          'info',
          `${parentLabel} · 须挂 ${batch.mustCover.length} 个点`,
        );
        const parentBody = (batch.parent?.body || batch.parent?.quote || '').trim();
        const user = [
          `按需求点生成用户故事：第 ${i + 1}/${batches.length} 批。`,
          `所属条目：${parentLabel}`,
          '',
          '## 本批必须挂上的需求点（每个 id 至少出现在一条故事的 sourceRefs 里；可多点并一条故事，不得漏 id）',
          formatMustCoverForPrompt(batch.mustCover),
          '',
          `必须覆盖的 id：${mustIds}`,
          parentBody ? `\n## 条目原文（依据）\n\n${parentBody.slice(0, 6000)}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        const added = await runStoryRound({
          label: `第 ${i + 1} 批`,
          user,
          batchIndex: i,
          softCap,
          progressMsg: `正在生成第 ${i + 1}/${batches.length} 批故事`,
        });
        pushActivity(
          `第 ${i + 1}/${batches.length} 批完成`,
          'done',
          `故事变化 +${added} · 耗时 ${elapsedText(batchStartedAt)}`,
        );
        setRunPercent(batchEnd, `第 ${i + 1}/${batches.length} 批已写入`);
      }

      if (controller.signal.aborted) {
        pushActivity('已中断：已经写入的故事保留', 'info');
        return;
      }

      // 未挂 id 补一轮
      let leftover = uncoveredOutlineItems(
        docRef.current?.outline ?? [],
        docRef.current?.stories ?? [],
      );
      if (leftover.length) {
        pushActivity(`补挂未覆盖需求点 ${leftover.length} 个`, 'stage');
        setRunPercent(76, `正在补挂 ${leftover.length} 个未覆盖需求点`);
        await runStoryRound({
          label: '补挂未覆盖',
          user: [
            '以下查改子点尚未被任何故事的 sourceRefs 引用。请用 req_set_stories 为每个 id 新建故事或并入已有故事（补写带原 id），不得漏 id；不要改需求条目。',
            '',
            '## 未挂上的需求点',
            formatMustCoverForPrompt(leftover),
            '',
            `必须覆盖的 id：${leftover.map((item) => item.id).join('、')}`,
          ].join('\n'),
          batchIndex: 90,
          softCap: 84,
          progressMsg: '正在补挂未覆盖需求点',
        });
        leftover = uncoveredOutlineItems(
          docRef.current?.outline ?? [],
          docRef.current?.stories ?? [],
        );
      }

      // 二次卡控：对照原始需求
      const sourceChunks = splitRequirementSections(content);
      const gateChunks = sourceChunks.length
        ? sourceChunks
        : [{ index: 0, title: '', text: content }];
      pushActivity('二次卡控：对照原始需求查漏', 'stage');
      for (let gi = 0; gi < gateChunks.length; gi++) {
        if (controller.signal.aborted) break;
        const part = gateChunks[gi]!;
        const gateStart = 85 + Math.floor((gi / Math.max(1, gateChunks.length)) * 10);
        const softCap = Math.min(94, gateStart + 3);
        const storiesBrief = (docRef.current?.stories ?? [])
          .map((s) => `- ${s.id || '（新）'} ${s.title} · refs=${s.sourceRefs.join('、') || '无'}`)
          .join('\n');
        setRunPercent(
          gateStart,
          `原文卡控 ${gi + 1}/${gateChunks.length}${part.title ? `（${part.title}）` : ''}`,
        );
        pushActivity(
          `原文卡控第 ${gi + 1}/${gateChunks.length} 段`,
          'info',
          part.title || `${part.text.length} 字`,
        );
        await runStoryRound({
          label: `原文卡控 ${gi + 1}`,
          user: [
            `二次卡控：对照本段原始需求，找出原文里有、但当前故事尚未覆盖的能力。`,
            `有则用 req_set_stories 补故事或并入已有故事的 sourceRefs（能对上的挂真实子点 id）；对不上条目的写进回答「待确认」，不要调用 req_set_outline、不要另造条目标题。`,
            '',
            '## 当前用户故事（摘要）',
            storiesBrief || '（尚无故事）',
            '',
            formatReqSectionOrderBlock(content) ? `${formatReqSectionOrderBlock(content)}\n` : '',
            `## 原始需求（第 ${part.index + 1}/${gateChunks.length} 段${
              part.title ? ` · ${part.title}` : ''
            }）`,
            '',
            part.text,
          ]
            .filter(Boolean)
            .join('\n'),
          batchIndex: 91 + gi,
          softCap,
          progressMsg: `原文卡控 ${gi + 1}/${gateChunks.length}`,
        });
      }

      if (controller.signal.aborted) {
        pushActivity('已中断：已经写入的故事保留', 'info');
        return;
      }

      leftover = uncoveredOutlineItems(
        docRef.current?.outline ?? [],
        docRef.current?.stories ?? [],
      );
      setRunPercent(96, '正在保存用户故事');
      const done = await updateReqDoc(current.id, {
        status: 'decomposed',
        progress: {
          stage: 'done',
          done: 100,
          total: 100,
          message: '用户故事已生成',
          at: new Date().toISOString(),
        },
      });
      patchDoc(done);
      const covered = outlineCoverageItems(done.outline).length - leftover.length;
      const total = outlineCoverageItems(done.outline).length;
      pushActivity(
        `生成用户故事完成：${done.stories.length} 个故事 · 需求点 ${covered}/${total} 已挂`,
        'done',
      );
      setTab('stories');
      setRunPercent(100, '用户故事已生成');
      if (leftover.length) {
        const ids = leftover.map((item) => item.id).join('、');
        pushActivity(`仍有 ${leftover.length} 个需求点未挂：${ids}`, 'info');
        showToast(`用户故事已生成，仍有 ${leftover.length} 个需求点未挂`, 'info');
      } else {
        showToast('用户故事已生成，需求点已挂全', 'success');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        outcome = 'stopped';
        pushActivity('已中断：已经写入的故事保留', 'info');
      } else {
        outcome = 'error';
        setError(message);
        pushActivity(`生成用户故事失败：${message}`, 'error');
        await updateReqDoc(current.id, {
          replaceStories: true,
          stories: [],
          check: null,
          ignoredGaps: [],
          testPoints: null,
          status: 'decomposed',
        })
          .then((saved) => patchDoc(saved))
          .catch(() => undefined);
      }
    } finally {
      if (controller.signal.aborted) outcome = 'stopped';
      finishRun(
        'stories',
        outcome,
        outcome === 'done'
          ? '用户故事已生成'
          : outcome === 'stopped'
            ? '已中断：已经写入的故事保留'
            : '生成用户故事失败，详见活动日志',
      );
    }
  }, [
    beginRun,
    buildPriorMemoryBlock,
    finishRun,
    makeToolContext,
    patchDoc,
    pushActivity,
    realPrompt,
    requireModel,
    savePatch,
  ]);

  /* ------------------------------ 体检 ------------------------------ */

  /**
   * 审查（规则 + 模型）。
   * - auto：拆解完成后自动接续（同一时间线）
   * - fullScan：显式全量再挖；默认复审只刷新上轮清单、禁止模型新开条
   */
  const runAudit = useCallback(
    async (input: boolean | { auto?: boolean; fullScan?: boolean } = false) => {
      const auto = typeof input === 'boolean' ? input : Boolean(input.auto);
      const fullScan = typeof input === 'object' && Boolean(input.fullScan);
      const current = docRef.current;
      if (!current) return;
      if (!current.stories.length || current.status === 'draft') {
        if (!auto) showToast('请先成功生成用户故事，再审查', 'info');
        return;
      }
      const isRereview = Boolean(
        (current.check?.gaps?.length ?? 0) > 0 || (current.ignoredGaps?.length ?? 0) > 0,
      );
      const allowNew = fullScan || !isRereview;
      auditAllowNewRef.current = allowNew;
      auditSuppressedRef.current = 0;
      const prevGaps = filterMainConfirmGaps(current.check?.gaps ?? []);
      auditPrevGapsRef.current = prevGaps;

      setError('');
      if (!auto) setAnswer('');
      pushActivity(
        auto
          ? '继续审查用户故事'
          : fullScan
            ? '开始全量扫描用户故事'
            : allowNew
              ? '开始审查用户故事'
              : '开始复审用户故事',
        'stage',
        auto
          ? '拆解完成后自动接续'
          : allowNew
            ? '全量检查，可发现新待确认'
            : '只刷新上轮清单，不新增待确认',
      );
      beginRun('audit', allowNew ? '审查用户故事' : '复审用户故事', 100, '正在跑规则体检');
      const controller = new AbortController();
      runAbortRef.current = controller;
      const result: { status: 'done' | 'stopped' | 'error'; message: string } = {
        status: 'done',
        message: '审查完成',
      };
      try {
        const auditStartedAt = Date.now();
        setRunPercent(8, '正在跑规则体检');
        const rule = auditStories(current);
        // 规则只刷新「未覆盖」；上轮模型待确认先原样保留，等模型 saveCheck 再合并
        const uncoveredRec = reconcileAuditGaps(
          prevGaps.filter((g) => g.type === 'uncovered-outline'),
          filterMainConfirmGaps(rule.gaps),
          current.ignoredGaps,
          { allowNew: true },
        );
        const keptPending = prevGaps.filter((g) => g.type !== 'uncovered-outline');
        const ruleGaps = [...keptPending, ...uncoveredRec.gaps];
        const withRule = await updateReqDoc(current.id, {
          check: {
            ...rule,
            gaps: ruleGaps,
          },
          progress: {
            stage: 'audit',
            done: 18,
            total: 100,
            message: '规则体检完成，等待模型评审',
            at: new Date().toISOString(),
          },
        });
        patchDoc(withRule);
        pushActivity(
          `规则体检：覆盖率 ${Math.round(rule.coverage.rate * 100)}%，${ruleGaps.length} 项待确认`,
          'info',
          `${current.outline.length} 条需求条目 · ${current.stories.length} 个故事 · 耗时 ${elapsedText(auditStartedAt)}`,
        );
        setRunPercent(18, '规则体检完成，等待模型评审');

        const reviewText = reviewPrompt?.review.trim() ?? '';
        const model = modelReady ? settings : null;
        if (!model || !reviewText) {
          pushActivity(
            !model
              ? '没有配置模型，只保留规则结果'
              : '「用户故事审查提示词.md」缺少「## 审查」段落，只保留规则结果',
            'info',
          );
          result.message = '没有配置模型，只保留规则结果';
          await updateReqDoc(current.id, {
            status: 'checked',
            progress: {
              stage: 'done',
              done: 100,
              total: 100,
              message: result.message,
              at: new Date().toISOString(),
            },
          })
            .then(patchDoc)
            .catch(() => undefined);
          setTab('check');
          return;
        }

        let checkSaved = false;
        const ctx = makeToolContext(current, 90);
        const saveCheck = ctx.saveCheck;
        ctx.saveCheck = async (report) => {
          checkSaved = true;
          setRunPercent(96, '正在写入审查结果');
          const filtered = {
            ...report,
            gaps: filterMainConfirmGaps(report.gaps),
          };
          // reconcile（含忽略 / 上轮合并）在 makeToolContext.saveCheck 里做
          const saved = await saveCheck(filtered);
          pushActivity(`模型体检：${saved.check?.gaps.length ?? 0} 项待确认`, 'done');
          return saved;
        };

        const latest = docRef.current ?? withRule;
        const source = await readReqSourceExcerpt(latest.sourcePath);
        if (!source.text) {
          pushActivity('没有读到原始需求，只能依据需求条目摘句审查', 'info');
        }
        pushActivity(
          '提交模型审查',
          'tool',
          `模型 ${model.model} · ${latest.stories.length} 个故事 · 原文 ${source.text.length} 字`,
        );
        setRunPercent(22, '正在提交模型审查');
        const historyBlock = formatAuditHistoryForPrompt({
          pending: filterIgnoredFromGaps(prevGaps, latest.ignoredGaps),
          ignored: latest.ignoredGaps ?? [],
        });
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
          ...(historyBlock ? ['', historyBlock] : []),
        ].join('\n');

        const auditSoftCap = 90;
        const stopHb = startRunHeartbeat(auditSoftCap);
        try {
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
            if (chunk.type === 'content') {
              setAnswer((prev) => prev + chunk.delta);
              pulseRun(auditSoftCap, 1);
            } else if (chunk.type === 'tool' && chunk.status === 'running') {
              pushActivity(`调用 ${chunk.name}`, 'tool', briefText(chunk.args));
              setRunPercent(94, '模型正在提交审查结果');
            } else if (chunk.type === 'tool' && chunk.status === 'done') {
              pushActivity(`${chunk.name} 返回`, 'tool', briefText(chunk.result, 120));
              setRunPercent(97, '审查结果已返回');
            }
          }
        } finally {
          stopHb();
        }

        if (!checkSaved) {
          pushActivity('模型没有提交体检结果，当前只保留规则结果', 'error');
          showToast('模型没有提交体检结果，只保留了规则检查', 'error');
        }
        setRunPercent(100, checkSaved ? '模型评审完成' : '已保留规则结果');
        const pendingN = docRef.current?.check?.gaps.length ?? 0;
        const ignoredN = docRef.current?.ignoredGaps?.length ?? 0;
        const suppressedN = auditSuppressedRef.current;
        if (checkSaved) {
          if (allowNew) {
            result.message = fullScan
              ? `全量扫描完成，待确认 ${pendingN}`
              : `全量审查完成，待确认 ${pendingN}`;
            showToast(result.message, 'success');
          } else {
            result.message =
              suppressedN > 0
                ? `复审未新增；待确认 ${pendingN} · 已忽略 ${ignoredN}（已抑制 ${suppressedN} 条新报）`
                : `复审未新增；待确认 ${pendingN} · 已忽略 ${ignoredN}`;
            showToast(result.message, 'success');
          }
          pushActivity(result.message, 'done');
        } else {
          result.message = '模型没提交结果，已保留规则结果';
        }
        await updateReqDoc(current.id, {
          status: 'checked',
          progress: {
            stage: 'done',
            done: 100,
            total: 100,
            message: result.message,
            at: new Date().toISOString(),
          },
        })
          .then(patchDoc)
          .catch(() => undefined);
        setTab('check');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (controller.signal.aborted) {
          result.status = 'stopped';
          pushActivity('已中断：规则体检结果已保留', 'info');
        } else {
          result.status = 'error';
          setError(message);
          pushActivity(`体检失败：${message}`, 'error');
        }
      } finally {
        if (controller.signal.aborted) result.status = 'stopped';
        finishRun(
          'audit',
          result.status,
          result.status === 'error' ? '审查失败，详见活动日志' : result.message,
        );
      }
    },
    [
      beginRun,
      finishRun,
      makeToolContext,
      modelReady,
      patchDoc,
      pushActivity,
      reportRun,
      reviewPrompt,
      settings,
    ],
  );

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
    pushActivity('开始补写选中条目', 'stage', `勾选 ${gaps.length} 个缺口`);
    beginRun('fix', '补写选中条目', 100, `正在按 ${gaps.length} 个勾选缺口补写`);
    const fixStartedAt = Date.now();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const result: { status: 'done' | 'stopped' | 'error'; message: string } = {
      status: 'done',
      message: '补写完成',
    };
    try {
      setRunPercent(5, `正在按 ${gaps.length} 个勾选缺口补写`);
      pushActivity(
        `按 ${gaps.length} 个勾选缺口补写`,
        'info',
        gaps.map((gap) => `[${gap.severity}] ${gap.storyId || '全局'}｜${gap.title}`).join('；'),
      );
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
              gap.detail ? `  疑问：${gap.detail}` : '',
              gap.suggestion ? `  建议：${gap.suggestion}` : '',
              gap.conclusion?.trim() ? `  结论：${gap.conclusion.trim()}` : '',
              gap.outlineId ? `  需求点：${gap.outlineId}` : '',
            ]
              .filter(Boolean)
              .join('\n');
          })
          .join('\n'),
        '',
        '说明：若某条带了「结论」，优先按结论改故事；结论与原文冲突时以原文为准并在回答里说明。',
      ].join('\n');

      const ctx = makeToolContext(current, 90);
      let submitted = false;
      const saveStories = ctx.saveStories;
      ctx.saveStories = async (stories) => {
        submitted = true;
        setRunPercent(90, '正在写入补写结果');
        return saveStories(stories);
      };

      setRunPercent(12, '正在提交模型补写');
      const stopHb = startRunHeartbeat(88);
      try {
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
          if (chunk.type === 'content') {
            setAnswer((prev) => prev + chunk.delta);
            pulseRun(88, 1);
          } else if (chunk.type === 'tool' && chunk.status === 'running') {
            pushActivity(`调用 ${chunk.name}`, 'tool', briefText(chunk.args));
            setRunPercent(90, '模型正在提交补写');
          } else if (chunk.type === 'tool' && chunk.status === 'done') {
            pushActivity(`${chunk.name} 返回`, 'tool', briefText(chunk.result, 120));
            setRunPercent(94, '补写结果已返回');
          }
        }
      } finally {
        stopHb();
      }

      if (!submitted) {
        result.status = 'error';
        result.message = '模型没有提交补写结果，故事集保持不变';
        pushActivity('模型没有提交补写结果，故事集保持不变', 'error');
        showToast('模型没有提交补写结果', 'error');
        return;
      }
      setRunPercent(94, '已写入补写结果，正在重算覆盖率');
      // 故事变了：按规则重算覆盖率，旧体检结论不再作数
      const latest = docRef.current;
      if (latest) {
        const rule = auditStories(latest);
        const saved = await updateReqDoc(latest.id, { check: rule, status: 'decomposed' });
        patchDoc(saved);
      }
      const coverage = Math.round((docRef.current?.check?.coverage.rate ?? 0) * 100);
      pushActivity(
        '补写完成，已按规则重算覆盖率；建议再跑一次体检',
        'done',
        `覆盖率 ${coverage}% · 耗时 ${elapsedText(fixStartedAt)}`,
      );
      await savePatch(
        {
          progress: {
            stage: 'done',
            done: 100,
            total: 100,
            message: '补写完成',
            at: new Date().toISOString(),
          },
        },
        docRef.current,
      ).catch(() => undefined);
      setTab('check');
      showToast('补写完成，建议再跑一次体检', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        result.status = 'stopped';
        pushActivity('已中断：已经写入的改动保留', 'info');
      } else {
        result.status = 'error';
        result.message = message;
        setError(message);
        pushActivity(`补写失败：${message}`, 'error');
      }
    } finally {
      if (controller.signal.aborted) result.status = 'stopped';
      finishRun(
        'fix',
        result.status,
        result.status === 'error' ? `补写失败：${result.message}` : result.message,
      );
    }
  }, [
    beginRun,
    finishRun,
    makeToolContext,
    patchDoc,
    pushActivity,
    reportRun,
    requireModel,
    reviewPrompt,
    savePatch,
  ]);

  /* ------------------------------ 生成测试点 ------------------------------ */

  const runTestPoints = useCallback(async () => {
    const current = docRef.current;
    const model = requireModel();
    if (!current || !model) return;
    if (!current.stories.length || current.status === 'draft') {
      showToast('请先成功生成用户故事，再生成测试点', 'info');
      return;
    }
    const generateText = testPointsPrompt?.generate.trim() ?? '';
    if (!generateText) {
      showToast(`没有读到「${TEST_POINTS_PROMPT_FILE}」的「## 生成」段落`, 'error');
      return;
    }
    setError('');
    setAnswer('');
    // 日志不清空：新一轮插一条分隔线，前面几轮的记录留着对照
    pushActivity(
      '开始生成测试点',
      'stage',
      `基于 ${current.stories.length} 个用户故事，五维覆盖 P0–P3`,
    );
    beginRun('testpoints', '生成测试点', 100, '正在整理用户故事，等待模型生成');
    // 点下去就先切到「测试点」Tab：生成过程与结果都在这一屏，不用等跑完才跳
    setTab('points');
    // 落一份进度：刷新页面或切走再回来也能看出「正在生成测试点」
    await savePatch(
      {
        progress: {
          stage: 'points',
          done: 5,
          total: 100,
          message: '正在生成测试点',
          at: new Date().toISOString(),
        },
      },
      current,
    ).catch(() => undefined);
    const testStartedAt = Date.now();
    setRunPercent(8, '正在整理用户故事');
    pushActivity(
      '整理用户故事，提交模型生成',
      'info',
      `${current.outline.length} 条需求条目 · ${current.stories.length} 个故事 · 模型 ${model.model}`,
    );
    const controller = new AbortController();
    runAbortRef.current = controller;
    const result: { status: 'done' | 'stopped' | 'error'; message: string } = {
      status: 'done',
      message: '测试点已生成',
    };
    try {
      const ctx = makeToolContext(current, 90);
      let submitted = false;
      const saveTestPoints = ctx.saveTestPoints;
      ctx.saveTestPoints = async (report) => {
        submitted = true;
        setRunPercent(90, '正在写入测试点');
        const saved = await saveTestPoints(report);
        pushActivity(`测试点已写入：${saved.testPoints?.points.length ?? 0} 条`, 'done');
        return saved;
      };

      const user = [
        `## 分析标题\n${current.title || '未命名分析'}`,
        '',
        '## 需求点（按条目；未挂故事的子点也需覆盖）',
        formatOutlinePointsForTestPoints(current.outline),
        '',
        `## 用户故事（${current.stories.length} 条）`,
        '```json',
        JSON.stringify(current.stories, null, 2),
        '```',
      ].join('\n');

      setRunPercent(15, '正在提交模型生成');
      let text = '';
      const stopHb = startRunHeartbeat(88);
      try {
        for await (const chunk of streamChatWithTools(
          model,
          [
            { role: 'system', content: `${generateText}\n\n${REQ_TOOL_GUIDE}` },
            { role: 'user', content: user },
          ] as ChatMessage[],
          controller.signal,
          {
            tools: REQ_ANALYSIS_TOOLS.filter(
              (tool) => tool.function.name === 'req_save_test_points',
            ),
            maxToolRounds: 8,
            runTool: (name, args) => runReqAnalysisTool(name, args, ctx),
          },
        )) {
          if (chunk.type === 'content') {
            text += chunk.delta;
            setAnswer((prev) => prev + chunk.delta);
            pulseRun(88, 1);
          } else if (chunk.type === 'tool' && chunk.status === 'running') {
            pushActivity(`调用 ${chunk.name}`, 'tool', briefText(chunk.args));
            setRunPercent(90, '模型正在提交测试点');
          } else if (chunk.type === 'tool' && chunk.status === 'done') {
            pushActivity(`${chunk.name} 返回`, 'tool', briefText(chunk.result, 120));
            setRunPercent(94, '测试点已返回');
          }
        }
      } finally {
        stopHb();
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
        result.status = 'error';
        result.message = '模型没有提交测试点，原结果保持不变';
        pushActivity('模型没有提交测试点，原结果保持不变', 'error');
        showToast('模型没有提交测试点，原结果保持不变', 'error');
      } else {
        const report = docRef.current?.testPoints;
        const points = report?.points ?? [];
        const byPriority = (key: string) => points.filter((p) => p.priority === key).length;
        pushActivity(
          `测试点完成：${points.length} 条`,
          'done',
          `P0 ${byPriority('P0')} / P1 ${byPriority('P1')} / P2 ${byPriority('P2')} / P3 ${byPriority('P3')} · 耗时 ${elapsedText(testStartedAt)}`,
        );
        setRunPercent(100, `已生成 ${points.length} 条`);
        result.message = `测试点已生成 ${points.length} 条`;
        await savePatch(
          {
            progress: {
              stage: 'done',
              done: 100,
              total: 100,
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
        result.status = 'stopped';
        pushActivity('已中断：已经生成的测试点保留', 'info');
      } else {
        result.status = 'error';
        result.message = message;
        setError(message);
        pushActivity(`生成测试点失败：${message}`, 'error');
      }
    } finally {
      if (controller.signal.aborted) result.status = 'stopped';
      finishRun(
        'testpoints',
        result.status,
        result.status === 'error' ? `生成测试点失败：${result.message}` : result.message,
      );
    }
  }, [
    beginRun,
    finishRun,
    makeToolContext,
    pushActivity,
    reportRun,
    requireModel,
    savePatch,
    testPointsPrompt,
  ]);

  /** 导出 XMind；浏览器端打包，失败只提示不打断页面 */
  const exportTestPointsXMind = useCallback(async () => {
    const current = docRef.current;
    if (!current?.testPoints) {
      showToast('还没有测试点可导出', 'info');
      return;
    }
    try {
      let titles = idealReqTitlesRef.current;
      if (!titles.length) titles = await syncIdealTitlesFromSource(current);
      const name = await downloadTestPointsXMind(current, titles);
      pushActivity(`已导出 ${name}`, 'done');
    } catch (err) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [pushActivity, syncIdealTitlesFromSource]);

  const exportTestPointsMarkdown = useCallback(async () => {
    const current = docRef.current;
    if (!current?.testPoints) {
      showToast('还没有测试点可导出', 'info');
      return;
    }
    let titles = idealReqTitlesRef.current;
    if (!titles.length) titles = await syncIdealTitlesFromSource(current);
    const name = downloadTestPointsMarkdown(current, titles);
    pushActivity(`已导出 ${name}`, 'done');
  }, [pushActivity, syncIdealTitlesFromSource]);

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

  const removeDoc = useCallback(async () => {
    const current = docRef.current;
    if (!current) return;
    try {
      await deleteReqDoc(current.id);
      removeViewJson(activityKey(current.id));
      removeViewJson(runKey(current.id));
      removeViewJson(`reqanalysis.idealTitles.${current.id}`);
      if (sourceRefBackfillRef.current === current.id) sourceRefBackfillRef.current = '';
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

  /** 导出给产品确认的短清单；有勾选只导已选 */
  const downloadPendingConfirm = useCallback(() => {
    const current = docRef.current;
    if (!current?.check) return;
    const selectedIds = current.check.gaps.filter((g) => g.selected).map((g) => g.id);
    const outlineBodies = new Map(
      current.outline.map((item) => [
        item.id,
        (item.body || item.quote || item.title || '').trim(),
      ]),
    );
    const name = downloadPendingConfirmMarkdown(current, current.check, {
      gapIds: selectedIds.length ? selectedIds : undefined,
      outlineBodies,
      outlineTitles: outlineTitleMap,
    });
    showToast(`已导出 ${name}`, 'success');
  }, [outlineTitleMap]);

  const stop = useCallback(() => {
    // 切页回来时任务还在后台跑：中断走模块级 controller，不依赖本组件是否挂载
    runAbortRef.current?.abort();
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
                              {reqSourceFileName(item)}
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
                        aria-label={`删除 ${reqSourceFileName(item)}`}
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
                hint="上面选一份需求文档，系统会新建一份分析；先拆解需求条目，再生成用户故事。"
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
                        aria-label={`选中 ${reqSourceFileName(item)} 的全部故事`}
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
                          {reqSourceFileName(item)}
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
                        打开分析
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
              {doc ? `用户故事 · ${reqSourceFileName(doc)}` : '用户故事'}
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
                                  text={reqSourceFileName(item)}
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
                <button
                  type="button"
                  className="flex w-full items-center justify-between border-b border-stone-100 px-3.5 py-2.5 text-left hover:bg-stone-50/80"
                  onClick={() => {
                    setPromptCardOpen((open) => {
                      const next = !open;
                      writeViewText(PROMPT_CARD_PREF, next ? '1' : '0');
                      return next;
                    });
                  }}
                >
                  <p className={SECTION_TITLE}>提示词</p>
                  <span className="text-[11px] text-stone-400">
                    {promptCardOpen ? '收起' : '展开'}
                  </span>
                </button>
                {promptCardOpen ? (
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
                ) : null}
              </section>

              <section className="rounded-xl border border-stone-200 bg-white">
                <div className="border-b border-stone-100 px-3.5 py-2.5">
                  <p className={SECTION_TITLE}>动作</p>
                </div>
                <div className="space-y-2 px-3.5 py-3">
                  <MultiSelectDropdown
                    options={priorMemoryOptions}
                    values={doc?.priorMemoryDocIds ?? []}
                    placeholder={
                      !doc
                        ? '请先打开分析'
                        : priorMemoryOptions.length === 0
                          ? '暂无同产品历史分析'
                          : '选择历史分析'
                    }
                    disabled={!doc || priorMemoryOptions.length === 0 || Boolean(busy)}
                    chips
                    searchable
                    searchPlaceholder="搜索历史版本…"
                    onChange={(values) => {
                      if (!doc) return;
                      void updateReqDoc(doc.id, { priorMemoryDocIds: values })
                        .then((saved) => patchDoc(saved))
                        .catch((err) => {
                          const message = err instanceof Error ? err.message : String(err);
                          showToast(message, 'error');
                        });
                    }}
                  />
                  <button
                    type="button"
                    className={`${BTN_PRIMARY} w-full`}
                    disabled={!doc || Boolean(busy) || !doc.sourcePath || !outlinePromptReady}
                    onClick={() => {
                      const hasPoints = (doc?.outline ?? []).some((item) => item.kind);
                      if (hasPoints || (doc?.stories.length ?? 0) > 0) setConfirmOutline(true);
                      else void decomposeOutline();
                    }}
                  >
                    {busy === 'decompose'
                      ? '拆解需求中…'
                      : (doc?.outline ?? []).some((item) => item.kind) ||
                          (doc?.stories.length ?? 0) > 0
                        ? '重新拆解需求'
                        : '拆解需求'}
                  </button>
                  <button
                    type="button"
                    className={`${BTN_SECONDARY} w-full`}
                    disabled={
                      !doc ||
                      Boolean(busy) ||
                      !doc.sourcePath ||
                      !doc.outline.length ||
                      doc.status === 'draft' ||
                      !storiesPromptReady
                    }
                    onClick={() => {
                      if (doc?.stories.length) setConfirmStories(true);
                      else void generateStories();
                    }}
                  >
                    {busy === 'stories'
                      ? '生成故事中…'
                      : doc?.stories.length
                        ? '重新生成用户故事'
                        : '生成用户故事'}
                  </button>
                  {reviewGate.on ? (
                    <button
                      type="button"
                      className={`${BTN_SECONDARY} w-full`}
                      disabled={
                        !doc || Boolean(busy) || !doc.stories.length || doc.status === 'draft'
                      }
                      onClick={() => void runAudit()}
                    >
                      {busy === 'audit'
                        ? '审查中…'
                        : doc?.check || (doc?.ignoredGaps?.length ?? 0) > 0
                          ? '复审用户故事'
                          : '用户故事审查'}
                    </button>
                  ) : null}
                  {tpGate.on ? (
                    <button
                      type="button"
                      className={`${BTN_SECONDARY} w-full`}
                      disabled={
                        !doc || Boolean(busy) || !doc.stories.length || doc.status === 'draft'
                      }
                      onClick={() => {
                        if (doc?.testPoints?.points.length) setConfirmTestPoints(true);
                        else void runTestPoints();
                      }}
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
                    activity.map((item) =>
                      item.kind === 'stage' ? (
                        <div key={item.id} className="flex items-center gap-2 pt-1.5 first:pt-0">
                          <span className="h-px flex-1 bg-stone-200" aria-hidden="true" />
                          <span className="shrink-0 text-[10px] font-medium text-stone-500">
                            {item.text}
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums text-stone-300">
                            {clockOf(item.at)}
                          </span>
                          <span className="h-px flex-1 bg-stone-200" aria-hidden="true" />
                        </div>
                      ) : (
                        <div key={item.id} className="flex gap-1.5 text-[11px] leading-relaxed">
                          <span className="mt-px shrink-0 text-[10px] tabular-nums text-stone-300">
                            {clockOf(item.at)}
                          </span>
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
                          <span className="min-w-0 flex-1">
                            <span
                              className={
                                item.kind === 'error'
                                  ? 'text-red-600'
                                  : item.kind === 'done'
                                    ? 'text-stone-700'
                                    : 'text-stone-500'
                              }
                            >
                              {item.text}
                            </span>
                            {item.detail ? (
                              <span className="mt-0.5 block break-all text-[10px] leading-relaxed text-stone-400">
                                {item.detail}
                              </span>
                            ) : null}
                          </span>
                        </div>
                      ),
                    )
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

              {/* 切走期间跑完的任务：回到页面给一行结论，省得猜「刚才跑完没有」 */}
              {finishedRun && !busy ? (
                <div
                  className={`mb-2 flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
                    finishedRun.status === 'done'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : finishedRun.status === 'error'
                        ? 'border-red-200 bg-red-50 text-red-700'
                        : 'border-amber-200 bg-amber-50 text-amber-700'
                  }`}
                >
                  <span className="break-all">
                    <span className="font-medium">
                      {finishedRun.label}
                      {finishedRun.status === 'done'
                        ? '已完成'
                        : finishedRun.status === 'error'
                          ? '失败'
                          : '已中断'}
                    </span>
                    <span className="ml-1.5 opacity-80">{finishedRun.message}</span>
                    {finishedRun.finishedAt ? (
                      <span className="ml-1.5 opacity-60">
                        · {formatWhen(new Date(finishedRun.finishedAt).toISOString())}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
                    aria-label="关闭上次任务提示"
                    onClick={dismissRun}
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
                        <OverflowHint
                          text={reqSourceFileName(doc)}
                          matchAnchorWidth
                          className="min-w-0 flex-1 truncate px-1 py-0.5 text-[15px] font-semibold text-stone-800"
                        />
                        {busy ? (
                          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-stone-500">
                            <span className="tw-lib-spin" aria-hidden="true" />
                            {runProgress
                              ? runProgress.message
                              : busy === 'decompose'
                                ? '拆解需求中'
                                : busy === 'stories'
                                  ? '生成故事中'
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
                          {
                            id: 'outline',
                            label: '需求条目',
                            count: outlineGroups.length || doc.outline.length,
                          },
                          { id: 'stories', label: '用户故事', count: doc.stories.length },
                          {
                            id: 'check',
                            label: '审查结果',
                            count: checkGaps.length + ignoredGaps.length,
                          },
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
                      storiesInDocOrder.length ? (
                        <ul className="space-y-2">
                          {storiesInDocOrder.map((story) => {
                            const index = doc.stories.findIndex((s) => s.id === story.id);
                            const storyIndex = index >= 0 ? index : 0;
                            return (
                              <ReqStoryCard
                                key={`${story.id}-${storyIndex}`}
                                story={story}
                                index={storyIndex}
                                total={doc.stories.length}
                                gaps={checkGaps.filter((gap) => gap.storyId === story.id)}
                                outlineTitles={outlineLabelMap}
                                outlineOptions={doc.outline}
                                completenessHints={storyCompletenessHints(story)}
                                busy={Boolean(busy)}
                                onSave={(next) => saveStory(storyIndex, next)}
                                onDelete={() => removeStory(storyIndex)}
                                onMove={(dir) => moveStory(storyIndex, dir)}
                                onJumpOutline={jumpToOutlinePoint}
                                domId={story.id ? `req-story-${story.id}` : undefined}
                              />
                            );
                          })}
                        </ul>
                      ) : (
                        <div className="flex items-center justify-center rounded-xl border border-stone-200 bg-white">
                          <PmEmptyState
                            icon="file"
                            title="还没有用户故事"
                            hint="点左侧「拆解需求」整理条目，再点「生成用户故事」。"
                          />
                        </div>
                      )
                    ) : null}

                    {tab === 'check' && reviewGate.on ? (
                      <StoryReviewReport
                        check={doc.check ? { ...doc.check, gaps: checkGaps } : null}
                        stories={doc.stories}
                        outlineTitles={outlineTitleMap}
                        ignoredGaps={ignoredGaps}
                        busy={Boolean(busy)}
                        onToggleGap={toggleGap}
                        onToggleAll={toggleAllGaps}
                        onFix={() => void fixSelected()}
                        onReview={() => void runAudit()}
                        onFullScan={() => void runAudit({ fullScan: true })}
                        onExport={downloadReview}
                        onExportPending={downloadPendingConfirm}
                        onIgnoreGap={(id) => void ignoreGapsByIds([id])}
                        onIgnoreSelected={() => {
                          const ids = checkGaps.filter((g) => g.selected).map((g) => g.id);
                          void ignoreGapsByIds(ids);
                        }}
                        onSaveGapConclusion={(gap, conclusion) =>
                          void saveGapConclusion(gap, conclusion)
                        }
                        onRestoreIgnored={(id) => void restoreIgnoredGap(id)}
                        onPromoteIgnored={(id) => void promoteIgnoredToStory(id)}
                      />
                    ) : null}

                    {tab === 'points' && tpGate.on ? (
                      <TestPointsPanel
                        doc={doc}
                        idealTitles={idealReqTitles}
                        generating={busy === 'testpoints'}
                        busy={Boolean(busy)}
                        promptReady={Boolean(testPointsPrompt?.generate.trim())}
                        onExportXmind={() => void exportTestPointsXMind()}
                        onExportMarkdown={() => void exportTestPointsMarkdown()}
                        onJumpToRequirement={jumpToRequirementOutline}
                      />
                    ) : null}

                    {tab === 'outline' ? (
                      outlineGroups.length ? (
                        <ul className="space-y-2">
                          {outlineGroups.map((group) => {
                            const open = Boolean(expandedOutline[group.parent.id]);
                            const allCovered =
                              group.totalPoints > 0 && group.coveredCount === group.totalPoints;
                            return (
                              <li
                                key={group.parent.id}
                                id={`req-outline-${group.parent.id}`}
                                className="rounded-xl border border-stone-200 bg-white"
                              >
                                <button
                                  type="button"
                                  className="flex w-full items-start gap-2 px-4 py-2.5 text-left"
                                  onClick={() =>
                                    setExpandedOutline((prev) => ({
                                      ...prev,
                                      [group.parent.id]: !prev[group.parent.id],
                                    }))
                                  }
                                >
                                  <span
                                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                      allCovered ? 'bg-emerald-500' : 'bg-amber-400'
                                    }`}
                                    aria-hidden="true"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm text-stone-800">
                                      <span className="mr-1.5 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-500">
                                        {group.parent.id}
                                      </span>
                                      {group.parent.title}
                                    </p>
                                    <p className="mt-0.5 text-[11px] text-stone-400">
                                      已整理需求点 {group.coveredCount}/{group.totalPoints} 已覆盖
                                      {group.coveringStories.length
                                        ? ` · ${group.coveringStories.length} 个故事`
                                        : ''}
                                    </p>
                                  </div>
                                  <span className="shrink-0 text-[11px] text-stone-400">
                                    {open ? '收起' : '展开'}
                                  </span>
                                </button>
                                {open ? (
                                  <div className="space-y-3 border-t border-stone-100 px-4 py-3">
                                    <div>
                                      <p className="text-[11px] font-semibold text-stone-500">
                                        已整理的需求点（{group.points.length}）
                                      </p>
                                      {group.points.length ? (
                                        <ul className="mt-1.5 space-y-1">
                                          {group.points.map((point) => {
                                            const covered = outlineRefs.has(point.id);
                                            const kind =
                                              point.kind === 'query'
                                                ? '查询'
                                                : point.kind === 'mutate'
                                                  ? '修改'
                                                  : '';
                                            const pointOpen = Boolean(
                                              expandedOutlinePoints[point.id],
                                            );
                                            const excerpt = outlinePointExcerpt(
                                              point,
                                              group.parent,
                                              group.points,
                                            );
                                            return (
                                              <li
                                                key={point.id}
                                                id={`req-outline-point-${point.id}`}
                                                className="rounded-md border border-transparent text-xs text-stone-700"
                                              >
                                                <div className="flex items-center gap-1">
                                                  <button
                                                    type="button"
                                                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-stone-50"
                                                    onClick={() =>
                                                      setExpandedOutlinePoints((prev) => ({
                                                        ...prev,
                                                        [point.id]: !prev[point.id],
                                                      }))
                                                    }
                                                  >
                                                    <span
                                                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                                        covered ? 'bg-emerald-500' : 'bg-amber-400'
                                                      }`}
                                                    />
                                                    <span className="font-mono text-[10px] text-stone-400">
                                                      {point.id}
                                                    </span>
                                                    {kind ? (
                                                      <span className="rounded bg-stone-100 px-1 text-[10px] text-stone-500">
                                                        {kind}
                                                      </span>
                                                    ) : null}
                                                    <span className="min-w-0 flex-1 truncate">
                                                      {point.title}
                                                    </span>
                                                    <span
                                                      className={
                                                        covered
                                                          ? 'shrink-0 text-emerald-600'
                                                          : 'shrink-0 text-amber-600'
                                                      }
                                                    >
                                                      {covered ? '已覆盖' : '未覆盖'}
                                                    </span>
                                                  </button>
                                                  <button
                                                    type="button"
                                                    disabled={Boolean(busy)}
                                                    className="shrink-0 rounded-md px-1.5 py-1 text-[10px] text-stone-500 hover:bg-stone-100 hover:text-[#3370ff] disabled:cursor-not-allowed disabled:opacity-40"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      openChangePoint(point, group.parent);
                                                    }}
                                                  >
                                                    变更需求点
                                                  </button>
                                                  <button
                                                    type="button"
                                                    disabled={Boolean(busy)}
                                                    className="shrink-0 rounded-md px-1.5 py-1 text-[10px] text-stone-500 hover:bg-stone-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      setConfirmDeletePointId(point.id);
                                                    }}
                                                  >
                                                    删除
                                                  </button>
                                                  <button
                                                    type="button"
                                                    className="shrink-0 rounded-md px-1.5 py-1 text-[10px] text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                                                    onClick={() =>
                                                      setExpandedOutlinePoints((prev) => ({
                                                        ...prev,
                                                        [point.id]: !prev[point.id],
                                                      }))
                                                    }
                                                  >
                                                    {pointOpen ? '收起' : '原文'}
                                                  </button>
                                                </div>
                                                {pointOpen ? (
                                                  <div className="mb-1 ml-4 mt-0.5">
                                                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-stone-50 px-2 py-1.5 text-[11px] leading-relaxed text-stone-600">
                                                      {excerpt.text || '（无原文切片）'}
                                                    </pre>
                                                  </div>
                                                ) : null}
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      ) : (
                                        <p className="mt-1 text-xs text-stone-400">
                                          尚无查询/修改子点；拆解时会按原文能力补上。
                                        </p>
                                      )}
                                    </div>
                                    <div>
                                      <p className="text-[11px] font-semibold text-stone-500">
                                        需求文档条目内容
                                      </p>
                                      <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-600">
                                        {group.parent.body ||
                                          group.parent.quote ||
                                          '（无原文切片）'}
                                      </pre>
                                    </div>
                                    {group.coveringStories.length ? (
                                      <div>
                                        <p className="text-[11px] font-semibold text-stone-500">
                                          覆盖故事
                                        </p>
                                        <ul className="mt-1.5 flex flex-wrap gap-1.5">
                                          {group.coveringStories.map((story) => (
                                            <button
                                              key={story.id}
                                              type="button"
                                              className="rounded-md border border-stone-200 bg-white px-2 py-0.5 text-[11px] text-stone-600 hover:border-[#3370ff] hover:text-[#3370ff]"
                                              onClick={() => {
                                                setTab('stories');
                                                requestAnimationFrame(() => {
                                                  document
                                                    .getElementById(`req-story-${story.id}`)
                                                    ?.scrollIntoView({
                                                      behavior: 'smooth',
                                                      block: 'nearest',
                                                    });
                                                });
                                              }}
                                            >
                                              {story.id} {story.title}
                                            </button>
                                          ))}
                                        </ul>
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <div className="flex items-center justify-center rounded-xl border border-stone-200 bg-white">
                          <PmEmptyState
                            icon="file"
                            title="还没有需求条目"
                            hint="拆解时会按需求文档结构播种条目，再整理查询/修改需求点。"
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

      <Dialog
        open={Boolean(changePoint)}
        onClose={() => {
          if (busy === 'change-point') return;
          setChangePoint(null);
          setChangeDraft('');
        }}
        className="relative z-110"
      >
        <DialogBackdrop
          transition
          className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
          aria-hidden="true"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="tw-dialog-panel-anim relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          >
            <button
              type="button"
              onClick={() => {
                setChangePoint(null);
                setChangeDraft('');
              }}
              className="absolute top-3.5 right-3.5 flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
              aria-label="关闭"
            >
              ✕
            </button>
            <DialogTitle className="pr-8 text-base font-semibold text-stone-900">
              变更需求点
              {changePoint ? (
                <span className="ml-2 font-mono text-xs font-normal text-stone-400">
                  {changePoint.pointId}
                </span>
              ) : null}
            </DialogTitle>
            <p className="mt-3 text-[11px] text-stone-400">
              编辑或补充需求内容后点确认，由模型更新当前点，必要时在下方新增子点。保存后除非重新拆解，否则审查与生成故事不会改回原文。
            </p>
            <textarea
              value={changeDraft}
              onChange={(e) => setChangeDraft(e.target.value)}
              spellCheck={false}
              placeholder="需求内容（可多行）"
              className="mt-2 min-h-[200px] w-full resize-y overflow-y-auto rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2.5 text-[12.5px] leading-relaxed text-stone-700 outline-none focus:border-[#4176e6]/40 focus:bg-white"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setChangePoint(null);
                  setChangeDraft('');
                }}
                className="h-8 rounded-lg border border-stone-200 px-3 text-sm text-stone-600 transition-colors hover:bg-stone-100"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!changeDraft.trim() || Boolean(busy)}
                onClick={() => void reviseOutlinePoint()}
                className="h-8 rounded-lg bg-[#4176e6] px-3.5 text-sm text-white transition-colors hover:bg-[#3566d0] disabled:cursor-not-allowed disabled:bg-stone-300"
              >
                确认
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(confirmDeletePointId)}
        title="删除需求点"
        message={`确认删除需求点「${
          confirmDeletePointId
            ? `${confirmDeletePointId} ${
                doc?.outline.find((item) => item.id === confirmDeletePointId)?.title ?? ''
              }`.trim()
            : ''
        }」？同父级后续子点序号会顺延；引用它的故事会去掉该引用。`}
        confirmLabel="删除"
        danger="solid"
        onClose={() => setConfirmDeletePointId(null)}
        onConfirm={() => void confirmDeleteOutlinePoint()}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="删除分析记录"
        message={`确认删除「${doc ? reqSourceFileName(doc) : ''}」？故事、需求条目、体检报告与测试点都会一起清掉，来源需求文档不受影响。`}
        confirmLabel="删除"
        danger="solid"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void removeDoc()}
      />

      <ConfirmDialog
        open={confirmOutline}
        title="重新拆解需求"
        message={`将按文档结构重新播种需求条目并整理查/改子点。当前 ${doc?.stories.length ?? 0} 个用户故事、审查结果与测试点会一并清空（条目 id 可能变化）。`}
        confirmLabel="重新拆解需求"
        onClose={() => setConfirmOutline(false)}
        onConfirm={() => {
          setConfirmOutline(false);
          void decomposeOutline();
        }}
      />

      <ConfirmDialog
        open={confirmStories}
        title="重新生成用户故事"
        message={`将覆盖当前 ${doc?.stories.length ?? 0} 个用户故事，并清空审查结果与测试点；需求条目保留。`}
        confirmLabel="重新生成用户故事"
        onClose={() => setConfirmStories(false)}
        onConfirm={() => {
          setConfirmStories(false);
          void generateStories();
        }}
      />

      <ConfirmDialog
        open={confirmTestPoints}
        title="重新生成测试点"
        message={`将覆盖当前 ${doc?.testPoints?.points.length ?? 0} 条测试点，按现有用户故事重新生成。`}
        confirmLabel="重新生成"
        onClose={() => setConfirmTestPoints(false)}
        onConfirm={() => {
          setConfirmTestPoints(false);
          void runTestPoints();
        }}
      />
    </div>
  );
}
