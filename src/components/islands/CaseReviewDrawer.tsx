/**
 * 用例评审抽屉：质量评审 / 用例表格 / 场景补全 三个 Tab。
 *
 * - 打开时读报告、提示词与需求上下文（对照需求按文件名自动匹配，不再手动选）；读文件拿用例行
 * - 评审与盲区都靠浏览器里的模型跑（`streamChatWithTools` + 两个提交工具），
 *   判定与分数最终由 `src/lib/case-review.ts` 的规则重算并落盘
 * - 补全写回不再走服务端追加：跳工作台，在那条用例绑定的会话里按文件表头补行
 * - 「错误无效 / 待修改」可以带着扣分原因跳到工作台，在那条用例绑定的会话里改文件
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import SlideOverDrawer from './SlideOverDrawer';
import CaseQualityPanel from './CaseQualityPanel';
import CaseBlindspotPanel from './CaseBlindspotPanel';
import CaseReviewTable from './CaseReviewTable';
import { hydrateAppConfig } from '../../lib/app-config';
import { loadSettings, onSettingsChanged, type LLMSettings } from '../../lib/settings';
import { streamChatWithTools, type ChatMessage } from '../../lib/llm';
import { readCaseFile, type CaseFileData, type CaseRow } from '../../lib/case-file';
import {
  auditCases,
  blindspotIdentityKey,
  caseIdentityKey,
  collectAutoFixedKeys,
  collectIgnoredKeys,
  countNeedFix,
  downloadReviewMarkdown,
  fetchBlindspotHealth,
  fetchBlindspotPrompt,
  fetchCaseReviewEntry,
  fetchCaseReviewHealth,
  fetchCaseReviewPrompt,
  mergeModelReview,
  normalizeReport,
  ruleReviewReport,
  saveCaseReviewEntry,
  stitchPartialReview,
  type BlindspotItem,
  type BlindspotReport,
  type CaseReviewEntry,
  type CaseReviewPrompt,
  type BlindspotPrompt,
  type CaseVerdict,
} from '../../lib/case-review';
import {
  CASE_REVIEW_TOOL_GUIDE,
  CASE_REVIEW_TOOLS,
  runCaseReviewTool,
} from '../../lib/case-review-tools';
import { listReqDocs, type ReqAnalysisDoc } from '../../lib/req-analysis';
import { caseFileMatchesReqTitle, caseReqMatchKey } from '../../lib/case-gen-run';
import {
  openBlindspotWritebackInChatSession,
  openCaseBatchFixInChatSession,
  openCaseFixInChatSession,
} from '../../lib/case-fix-jump';
import { caseFieldMap, describeFieldMap } from '../../lib/case-fields';
import { CASE_FIELDS } from '../../lib/export';
import { readViewPref, writeViewPref } from '../../lib/view-prefs';

type TabKey = 'quality' | 'table' | 'blindspot';

/**
 * 模块级会话：关抽屉 / 切菜单只卸 React 岛屿，模块还在。
 * 后台评审继续写这里；再打开同一文件直接接上，不重新空白加载。
 */
interface CaseReviewSession {
  path: string;
  entry: CaseReviewEntry | null;
  file: CaseFileData | null;
  stale: boolean;
  docs: ReqAnalysisDoc[];
  reqId: string;
  selected: string[];
  reviewPrompt: CaseReviewPrompt | null;
  blindspotPrompt: BlindspotPrompt | null;
  error: string;
  notice: string;
  reviewRunning: boolean;
  detectRunning: boolean;
  completing: boolean;
  runLabel: string;
  runLog: string[];
  received: number;
  runTarget: number;
  progress: string;
  runStartedAt: number;
}

const sessions = new Map<string, CaseReviewSession>();
const sessionSubs = new Set<() => void>();
/** 放模块级：切走再回来，「停止」仍能停掉后台流 */
const runAbortRef: { current: AbortController | null } = { current: null };

function emptySession(path: string): CaseReviewSession {
  return {
    path,
    entry: null,
    file: null,
    stale: false,
    docs: [],
    reqId: '',
    selected: [],
    reviewPrompt: null,
    blindspotPrompt: null,
    error: '',
    notice: '',
    reviewRunning: false,
    detectRunning: false,
    completing: false,
    runLabel: '',
    runLog: [],
    received: 0,
    runTarget: 0,
    progress: '',
    runStartedAt: 0,
  };
}

function patchSession(path: string, patch: Partial<CaseReviewSession>): void {
  if (!path) return;
  const prev = sessions.get(path) ?? emptySession(path);
  sessions.set(path, { ...prev, ...patch, path });
  for (const fn of sessionSubs) fn();
}

function subscribeSession(fn: () => void): () => void {
  sessionSubs.add(fn);
  return () => {
    sessionSubs.delete(fn);
  };
}

/** 文件名 / 需求标题归一化：去掉扩展名、空格与括号，便于粗匹配 */
function normalizeCaseName(value: string): string {
  return value
    .replace(/\.[^.]+$/, '')
    .replace(/[\s_\-—·()（）[\]【】]/g, '')
    .toLowerCase();
}

/**
 * 猜一份对照需求：优先按「前缀 + 版本号」对齐（不含「版本 / 迭代版本」），
 * 再退回整名互相包含；宁可不挂也不乱挂。
 */
function guessRequirementId(docs: readonly ReqAnalysisDoc[], filePath: string): string {
  const fileName = filePath.split('/').pop() ?? filePath;
  const base = normalizeCaseName(fileName);
  if (!base) return '';
  let best = '';
  let bestLen = 0;
  for (const doc of docs) {
    const titleFull = normalizeCaseName(doc.title);
    const sourceFull = normalizeCaseName(doc.sourceTitle || '');
    const stemHit =
      caseFileMatchesReqTitle(fileName, doc.title) ||
      caseFileMatchesReqTitle(fileName, doc.sourceTitle || '');
    const fullHit =
      (titleFull.length >= 4 && (base.includes(titleFull) || titleFull.includes(base))) ||
      (sourceFull.length >= 4 && (base.includes(sourceFull) || sourceFull.includes(base)));
    if (!stemHit && !fullHit) continue;
    const score = Math.max(
      caseReqMatchKey(doc.title).length,
      caseReqMatchKey(doc.sourceTitle || '').length,
      titleFull.length,
    );
    if (score > bestLen) {
      best = doc.id;
      bestLen = score;
    }
  }
  return best;
}

interface Props {
  open: boolean;
  path: string;
  reviewOn: boolean;
  blindspotOn: boolean;
  onClose: () => void;
  /** 报告变化后让列表刷新评审列 */
  onSaved?: () => void;
}

export default function CaseReviewDrawer({
  open,
  path,
  reviewOn,
  blindspotOn,
  onClose,
  onSaved,
}: Props) {
  /** Tab 按空间记住：下次打开同一份（或另一份）用例仍停在那个 Tab */
  const [tab, setTabState] = useState<TabKey>(() =>
    readViewPref<TabKey>('caseReview.tab', ['quality', 'table', 'blindspot'], 'quality'),
  );
  const setTab = useCallback((next: TabKey) => {
    setTabState(next);
    writeViewPref('caseReview.tab', next);
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [entry, setEntry] = useState<CaseReviewEntry | null>(null);
  const [stale, setStale] = useState(false);
  const [file, setFile] = useState<CaseFileData | null>(null);
  const [reviewPrompt, setReviewPrompt] = useState<CaseReviewPrompt | null>(null);
  const [blindspotPrompt, setBlindspotPrompt] = useState<BlindspotPrompt | null>(null);
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [reviewRunning, setReviewRunning] = useState(false);
  const [detectRunning, setDetectRunning] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [progress, setProgress] = useState('');
  /** 正在跑的任务名（评审 / 探测 / 补全）：顶部运行条与「停止」按钮共用 */
  const [runLabel, setRunLabel] = useState('');
  /** 已跑秒数：每秒 +1，让用户知道没卡住 */
  const [elapsed, setElapsed] = useState(0);
  /** 关键节点日志：规则体检 / 模型开始返回 / 收到多少条 / 落盘完成 */
  const [runLog, setRunLog] = useState<string[]>([]);
  /** 模型已交回多少条结果（逐条判定 / 盲区条目） */
  const [received, setReceived] = useState(0);
  /** 本次任务的目标条数（>0 时进度条按 received/target 推进，否则走不确定动画） */
  const [runTarget, setRunTarget] = useState(0);
  const [docs, setDocs] = useState<ReqAnalysisDoc[]>([]);
  /** 对照需求：按文件名自动匹配，界面上不再给选择器 */
  const [reqId, setReqId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const modelReady = Boolean(settings?.baseURL && settings.apiKey && settings.model);

  /** 把当前 UI 快照推进模块会话（关抽屉 / 切页后还能接上） */
  const pullSession = useCallback((s: CaseReviewSession) => {
    setEntry(s.entry);
    setFile(s.file);
    setStale(s.stale);
    setDocs(s.docs);
    setReqId(s.reqId);
    setSelected(new Set(s.selected));
    setReviewPrompt(s.reviewPrompt);
    setBlindspotPrompt(s.blindspotPrompt);
    setError(s.error);
    setNotice(s.notice);
    setReviewRunning(s.reviewRunning);
    setDetectRunning(s.detectRunning);
    setCompleting(s.completing);
    setRunLabel(s.runLabel);
    setRunLog(s.runLog);
    setReceived(s.received);
    setRunTarget(s.runTarget);
    setProgress(s.progress);
    setElapsed(s.runStartedAt ? Math.round((Date.now() - s.runStartedAt) / 1000) : 0);
    setLoading(false);
  }, []);

  /** 开始一次长任务：运行条亮起、日志清空、计时归零；target>0 时走确定进度条 */
  const beginRun = useCallback(
    (label: string, first: string, target = 0) => {
      const started = Date.now();
      setRunLabel(label);
      setRunLog([first]);
      setReceived(0);
      setElapsed(0);
      setProgress('');
      setRunTarget(target);
      patchSession(path, {
        runLabel: label,
        runLog: [first],
        received: 0,
        progress: '',
        runTarget: target,
        runStartedAt: started,
        error: '',
      });
    },
    [path],
  );
  const addLog = useCallback(
    (line: string) => {
      setRunLog((prev) => {
        const next = [...prev.slice(-11), line];
        patchSession(path, { runLog: next });
        return next;
      });
    },
    [path],
  );
  const endRun = useCallback(() => {
    setRunLabel('');
    setProgress('');
    setElapsed(0);
    setRunTarget(0);
    patchSession(path, {
      runLabel: '',
      progress: '',
      runTarget: 0,
      runStartedAt: 0,
      reviewRunning: false,
      detectRunning: false,
      completing: false,
    });
  }, [path]);

  /** 停止：中断当前模型的流式请求；已经拿到的结果不落盘 */
  const onStop = useCallback(() => {
    const ctrl = runAbortRef.current;
    if (!ctrl) {
      addLog('当前没有可中断的请求');
      return;
    }
    if (ctrl.signal.aborted) return;
    ctrl.abort();
    addLog('已请求停止，正在收尾…');
  }, [addLog]);

  useEffect(() => {
    if (!runLabel) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runLabel]);

  const requirementText = useMemo(() => {
    const doc = docs.find((d) => d.id === reqId);
    if (!doc) return '';
    const lines: string[] = [`# ${doc.title}`];
    for (const item of doc.outline)
      lines.push(`- ${item.title}${item.quote ? `：${item.quote}` : ''}`);
    for (const story of doc.stories) {
      lines.push(
        `- ${story.id} ${story.title}（${story.role}）${story.goal ? `：${story.goal}` : ''}${
          story.acceptance.length
            ? `；验收：${story.acceptance.map((a) => `${a.given} ${a.when} 则 ${a.then}`).join(' / ')}`
            : ''
        }`,
      );
    }
    return lines.join('\n');
  }, [docs, reqId]);

  useEffect(() => {
    void hydrateAppConfig()
      .then(() => setSettings(loadSettings()))
      .catch(() => setSettings(loadSettings()));
    return onSettingsChanged(() => setSettings(loadSettings()));
  }, []);

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const [revHealth, blHealth] = await Promise.all([
        reviewOn ? fetchCaseReviewHealth() : Promise.resolve(false),
        blindspotOn ? fetchBlindspotHealth() : Promise.resolve(false),
      ]);
      if (!revHealth && !blHealth) {
        const msg = '评审服务没起来：确认已用 `lantern dev` 启动（插件依赖本地中间件）。';
        setError(msg);
        patchSession(path, { error: msg });
      }
      // 两份报告存在同一个 store，任一中间件可用就能读（只开场景补全时也要读得到）
      const storeReady = revHealth || blHealth;
      const [fileData, entryRes] = await Promise.all([
        readCaseFile(path),
        storeReady ? fetchCaseReviewEntry(path) : Promise.resolve({ entry: null, stale: false }),
      ]);
      // 旧报告的两处口径问题在读的时候对齐：判定按分数重算、空标题按编号从文件回填；
      // 缺 contentFp 时用当前行作基线，并落盘，否则下次打开会按改后内容重算基线、认不出已改。
      let nextEntry = entryRes.entry?.review
        ? {
            ...entryRes.entry,
            review: normalizeReport(entryRes.entry.review, fileData.rows),
          }
        : entryRes.entry;
      if (nextEntry?.review && entryRes.entry?.review && storeReady) {
        const prevFp = new Map(
          entryRes.entry.review.cases.map((c) => [caseIdentityKey(c), c.contentFp] as const),
        );
        const gainedFp = nextEntry.review.cases.some((c) => {
          const key = caseIdentityKey(c);
          return Boolean(c.contentFp && key && !prevFp.get(key));
        });
        if (gainedFp) {
          try {
            const saved = await saveCaseReviewEntry(path, { review: nextEntry.review });
            nextEntry = saved;
          } catch {
            // 落盘失败仍用内存基线，本轮对比可用
          }
        }
      }
      setFile(fileData);
      setEntry(nextEntry);
      setStale(entryRes.stale);

      let nextReviewPrompt: CaseReviewPrompt | null = null;
      let nextBlindspotPrompt: BlindspotPrompt | null = null;
      let nextDocs: ReqAnalysisDoc[] = [];
      if (revHealth && reviewOn) {
        nextReviewPrompt = await fetchCaseReviewPrompt();
        setReviewPrompt(nextReviewPrompt);
      }
      if (blHealth && blindspotOn) {
        nextBlindspotPrompt = await fetchBlindspotPrompt();
        setBlindspotPrompt(nextBlindspotPrompt);
      }
      // 只开「场景补全」时也要挂需求：两个服务都能读，读不到就当没需求
      if (revHealth || blHealth) {
        try {
          nextDocs = await listReqDocs();
        } catch {
          nextDocs = [];
        }
      }
      setDocs(nextDocs);
      const guess = guessRequirementId(nextDocs, path);
      setReqId(guess);
      setSelected(new Set());
      patchSession(path, {
        file: fileData,
        entry: nextEntry,
        stale: entryRes.stale,
        docs: nextDocs,
        reqId: guess,
        selected: [],
        reviewPrompt: nextReviewPrompt,
        blindspotPrompt: nextBlindspotPrompt,
        error: !revHealth && !blHealth ? (sessions.get(path)?.error ?? '') : '',
        notice: '',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      patchSession(path, { error: msg });
    } finally {
      setLoading(false);
    }
  }, [path, reviewOn, blindspotOn]);

  /** 只重读用例文件（保留评审会话）；工作台改完回来才能靠 contentFp 认出「已修改」 */
  const refreshFile = useCallback(async () => {
    if (!path) return;
    try {
      const [fileData, entryRes] = await Promise.all([
        readCaseFile(path),
        fetchCaseReviewEntry(path).catch(() => ({
          entry: null as CaseReviewEntry | null,
          stale: false,
        })),
      ]);
      setFile(fileData);
      setStale(entryRes.stale);
      patchSession(path, { file: fileData, stale: entryRes.stale });
    } catch {
      // 软刷新失败不打断当前会话
    }
  }, [path]);

  useEffect(() => {
    if (!open || !path) return;
    // 首次打开用记住的 Tab；记住的那个插件被关掉时退回可用的一档
    const remembered = readViewPref<TabKey>(
      'caseReview.tab',
      ['quality', 'table', 'blindspot'],
      'quality',
    );
    const usable =
      remembered === 'blindspot' ? blindspotOn : remembered === 'quality' ? reviewOn : true;
    setTab(usable ? remembered : reviewOn ? 'quality' : 'blindspot');
    // 已有模块会话 → 接上进度；但仍重读文件，否则改完回来仍按旧行显示「待修改」
    const hit = sessions.get(path);
    if (hit?.file) {
      pullSession(hit);
      void refreshFile();
      return;
    }
    void load();
  }, [open, path, load, refreshFile, reviewOn, blindspotOn, setTab, pullSession]);

  /** 抽屉挂着时订阅模块会话：后台任务在切走期间的进度会推回来 */
  useEffect(() => {
    if (!open || !path) return;
    return subscribeSession(() => {
      const s = sessions.get(path);
      if (s) pullSession(s);
    });
  }, [open, path, pullSession]);

  /**
   * 对照需求：按「前缀+版本号」对齐（再退回整名包含）自动匹配一份需求分析。
   * 匹配不到就保持空（覆盖率不计），也不让手动选。
   */
  useEffect(() => {
    if (reqId && docs.some((d) => d.id === reqId)) return;
    const guess = guessRequirementId(docs, path);
    if (guess) {
      setReqId(guess);
      patchSession(path, { reqId: guess });
    }
  }, [docs, path, reqId]);

  const appendHeaders = useMemo(
    () => (file?.headers.length ? file.headers : [...CASE_FIELDS]),
    [file],
  );

  /** 字段对照：告诉模型文件里哪一列才是标题 / 步骤 / 预期（模板表头可能是别名） */
  const fieldsText = useMemo(
    () => (file?.headers.length ? describeFieldMap(caseFieldMap(file.headers)) : ''),
    [file],
  );

  /** 自动匹配到的对照需求标题（不在界面上展示选择器，只用于提示词与补全面板右侧） */
  const requirementTitle = useMemo(
    () => docs.find((d) => d.id === reqId)?.title ?? '',
    [docs, reqId],
  );

  const ruleAudit = useMemo(
    () => (file ? auditCases(file.rows, requirementText) : null),
    [file, requirementText],
  );

  const review = entry?.review ?? null;
  const blindspot = entry?.blindspot ?? null;

  const runModel = useCallback(
    async (
      system: string,
      user: string,
      collect: { cases: CaseVerdict[]; items: BlindspotItem[]; summary: string },
      signal?: AbortSignal,
    ) => {
      if (!settings) throw new Error('还没读到模型设置');
      // 优先用任务开始时挂上的 controller，便于一点「停止评审」就能打断准备阶段
      const controller = runAbortRef.current ?? new AbortController();
      runAbortRef.current = controller;
      if (signal?.aborted || controller.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      let tail = '';
      for await (const chunk of streamChatWithTools(
        settings,
        [
          { role: 'system', content: `${system}\n\n${CASE_REVIEW_TOOL_GUIDE}` },
          { role: 'user', content: user },
        ] as ChatMessage[],
        controller.signal,
        {
          tools: CASE_REVIEW_TOOLS,
          runTool: (name, args) =>
            runCaseReviewTool(name, args, {
              onCases: (cases, summary) => {
                collect.cases.push(...cases);
                if (summary) collect.summary = summary;
                const total = collect.cases.length + collect.items.length;
                setReceived(total);
                patchSession(path, { received: total });
                addLog(`模型交回 ${cases.length} 条判定（累计 ${total} 条）`);
              },
              onBlindspots: (items, summary) => {
                collect.items.push(...items);
                if (summary) collect.summary = summary;
                const total = collect.cases.length + collect.items.length;
                setReceived(total);
                patchSession(path, { received: total });
                addLog(`模型交回 ${items.length} 条盲区（累计 ${total} 条）`);
              },
            }),
        },
      )) {
        if (chunk.type === 'content') {
          tail = `${tail}${chunk.delta}`.slice(-400);
          setProgress(tail);
          patchSession(path, { progress: tail });
        }
      }
    },
    [settings, addLog, path],
  );

  const payloadOfRows = useCallback((rows: readonly CaseRow[], headers: readonly string[]) => {
    const fields = headers.length ? headers : CASE_FIELDS;
    return rows
      .map((row, i) => {
        const lines = [`### ${i + 1}`];
        for (const f of fields) {
          const v = String(row[f] ?? '').trim();
          if (v) lines.push(`${f}：${v}`);
        }
        return lines.join('\n');
      })
      .join('\n\n');
  }, []);

  const onRunReview = useCallback(async () => {
    if (!file) return;
    const fullAudit = auditCases(file.rows, requirementText);
    if (!file.rows.length) {
      setError(
        '这个文件里没解析到用例行：确认第一行是表头，且有编号与标题列（「测试项目 / 用例名称」这类叫法也认）。',
      );
      return;
    }
    const prevCases = entry?.review ? normalizeReport(entry.review, file.rows).cases : [];
    const prevByKey = new Map(
      prevCases.map((c) => [caseIdentityKey(c), c] as const).filter(([k]) => k),
    );
    const ignoredKeys = collectIgnoredKeys(prevCases);
    const modifiedKeys = collectAutoFixedKeys(prevCases, file.rows);
    // 有报告且存在已修改 → 只重审这些；否则全量（仍剔除已忽略）
    const partialMode = prevCases.length > 0 && modifiedKeys.size > 0;
    const pendingIdx: number[] = [];
    file.rows.forEach((_, i) => {
      const c = fullAudit.cases[i];
      const key = c ? caseIdentityKey(c) : '';
      if (key && ignoredKeys.has(key)) return;
      if (partialMode && !(key && modifiedKeys.has(key))) return;
      pendingIdx.push(i);
    });
    const pendingRows = pendingIdx.map((i) => file.rows[i]!);
    const reviewedKeys = new Set(
      pendingIdx.map((i) => caseIdentityKey(fullAudit.cases[i]!)).filter(Boolean),
    );
    const pendingAudit = auditCases(pendingRows, requirementText);
    const controller = new AbortController();
    runAbortRef.current = controller;
    setReviewRunning(true);
    setError('');
    patchSession(path, { reviewRunning: true, error: '' });
    const scopeNote = partialMode
      ? `重审已修改 ${pendingRows.length} 条`
      : ignoredKeys.size
        ? `全量 ${pendingRows.length} 条（已忽略 ${ignoredKeys.size} 条不送评）`
        : `全量 ${pendingRows.length} 条`;
    beginRun('评审用例', `开始评审：${scopeNote}（规则 + 模型）`, Math.max(pendingRows.length, 1));
    try {
      if (!pendingRows.length) {
        const msg = ignoredKeys.size
          ? `没有待评用例（${ignoredKeys.size} 条已忽略）。取消忽略后再评，或先改文件产生「已修改」。`
          : '没有待评用例。';
        addLog(msg);
        setNotice(msg);
        patchSession(path, { notice: msg });
        return;
      }
      const finish = async (partial: ReturnType<typeof ruleReviewReport>) => {
        const report = stitchPartialReview(
          fullAudit.cases,
          partial,
          reviewedKeys,
          prevByKey,
          fullAudit.metrics,
        );
        const saved = await saveCaseReviewEntry(path, { review: report });
        const doneNotice = `评审完成：${report.cases.length} 条，可用 ${report.counts.usable} · 待修改 ${report.counts.revise} · 错误无效 ${report.counts.invalid}${
          partialMode ? `（本轮重审已修改 ${reviewedKeys.size} 条）` : ''
        }${ignoredKeys.size ? ` · 忽略 ${ignoredKeys.size}` : ''}。`;
        setEntry(saved);
        setStale(false);
        setNotice(doneNotice);
        patchSession(path, { entry: saved, stale: false, notice: doneNotice });
        onSaved?.();
      };
      if (!modelReady) {
        addLog(`没有配置模型，只跑规则判定（${scopeNote}）`);
        await finish(ruleReviewReport(pendingAudit));
        return;
      }
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const section = reviewPrompt?.review?.trim();
      if (!section)
        throw new Error(
          '没有读到「用例质量评审提示词.md」的「评审」段，先到插件页把插件关掉再打开重新生成。',
        );
      addLog(`规则体检完成：待评 ${pendingAudit.cases.length} 条（${scopeNote}），按五维拼提示词`);
      const casesText = payloadOfRows(pendingRows, file.headers);
      const system = section
        .replaceAll('{{cases}}', `见用户消息里的 ${pendingRows.length} 条用例`)
        .replaceAll('{{requirement}}', requirementText || '（未挂对照需求）')
        .replaceAll('{{template}}', appendHeaders.join(' / '))
        .replaceAll('{{fields}}', fieldsText);
      const user = [
        '## 对照需求',
        requirementText || '（未挂对照需求，只按用例自身结构评）',
        '',
        '## 用例字段',
        appendHeaders.join(' / '),
        '',
        '## 字段对照',
        fieldsText || '（按文件里的实际表头读）',
        '',
        `## 待评审用例（${pendingRows.length} 条）`,
        casesText,
        ignoredKeys.size || (prevCases.length && !partialMode)
          ? [
              '',
              '## 说明',
              partialMode
                ? `本轮只复查已修改的 ${reviewedKeys.size} 条；其余沿用上次判定，请勿评未列出的用例。`
                : ignoredKeys.size
                  ? `另有 ${ignoredKeys.size} 条用户已忽略，不在本次列表中。`
                  : '',
            ]
              .filter(Boolean)
              .join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const collect = { cases: [] as CaseVerdict[], items: [] as BlindspotItem[], summary: '' };
      addLog('提示词已就绪，等待模型返回…');
      await runModel(system, user, collect, controller.signal);
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!collect.cases.length)
        throw new Error('模型没有提交判定结果，可以重试一次或换成更擅长的模型。');
      addLog('正在按规则复算分数并落盘…');
      await finish(mergeModelReview(pendingAudit, collect.cases, collect.summary));
    } catch (err) {
      const aborted =
        controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        const msg = '已停止评审，本次结果没有保存；已有报告保持不变。';
        setNotice(msg);
        patchSession(path, { notice: msg });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        patchSession(path, { error: msg });
      }
    } finally {
      setReviewRunning(false);
      endRun();
      if (runAbortRef.current === controller) runAbortRef.current = null;
    }
  }, [
    file,
    requirementText,
    modelReady,
    reviewPrompt,
    payloadOfRows,
    appendHeaders,
    fieldsText,
    runModel,
    path,
    onSaved,
    beginRun,
    addLog,
    endRun,
    entry,
  ]);

  const onDetect = useCallback(async () => {
    if (!file) return;
    setDetectRunning(true);
    setError('');
    patchSession(path, { detectRunning: true, error: '' });
    beginRun('探测场景盲区', `开始对照需求检查 ${file.rows.length} 条用例的盲区`);
    try {
      if (!modelReady) throw new Error('场景探测需要模型，请先在设置里配置。');
      const section = blindspotPrompt?.detect?.trim();
      if (!section)
        throw new Error(
          '没有读到「场景遗漏补全提示词.md」的「探测」段，先到插件页把插件关掉再打开重新生成。',
        );
      const doneItems = (entry?.blindspot?.items ?? []).filter((x) => x.added);
      const doneKeys = new Set(doneItems.map((x) => blindspotIdentityKey(x)));
      const system = section.replaceAll('{{cases}}', `见用户消息里的 ${file.rows.length} 条用例`);
      const user = [
        '## 对照需求',
        requirementText || '（未挂对照需求）',
        '',
        '## 字段对照',
        fieldsText || '（按文件里的实际表头读）',
        '',
        `## 已有用例（${file.rows.length} 条）`,
        payloadOfRows(file.rows, file.headers),
        doneItems.length
          ? [
              '',
              '## 以下场景已写回用例文件，不要再报为盲区',
              ...doneItems.map(
                (x, i) =>
                  `${i + 1}. [${x.category}] ${x.title}${x.reqAnchor ? `（归属 ${x.reqAnchor}）` : ''}`,
              ),
            ].join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const collect = { cases: [] as CaseVerdict[], items: [] as BlindspotItem[], summary: '' };
      addLog(
        `上下文：需求${requirementText ? '已挂' : '未挂'} · 四类盲区 · ${file.rows.length} 条已有用例${
          doneKeys.size ? ` · 跳过已写回 ${doneKeys.size}` : ''
        }`,
      );
      await runModel(system, user, collect);
      if (!collect.items.length) throw new Error('模型没有提交盲区条目，可以重试一次。');

      addLog('正在去重并落盘探测结果…');

      // 新探测结果：丢掉已确认写回的标题；新条目一律未修改
      const prev = new Map(
        (entry?.blindspot?.items ?? []).map((x) => [blindspotIdentityKey(x), x]),
      );
      const seen = new Set<string>();
      const items: BlindspotItem[] = [];
      let skippedDone = 0;
      for (const item of collect.items) {
        const key = blindspotIdentityKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        if (doneKeys.has(key)) {
          skippedDone += 1;
          continue;
        }
        const old = prev.get(key);
        items.push({
          ...item,
          id: old?.id || item.id || `bs_${Math.random().toString(16).slice(2, 18)}`,
          reqAnchor: item.reqAnchor?.trim() || old?.reqAnchor || '',
          added: false,
          caseNo: '',
        });
      }
      const report: BlindspotReport = {
        at: new Date().toISOString(),
        context: {
          reqRef: reqId,
          reqTitle: docs.find((d) => d.id === reqId)?.title ?? '',
        },
        items,
        summary: collect.summary,
      };
      const saved = await saveCaseReviewEntry(path, { blindspot: report });
      const doneNotice = `探测完成：${items.length} 条盲区${
        skippedDone ? `（已去掉 ${skippedDone} 条已写回）` : ''
      }。`;
      setEntry(saved);
      setStale(false);
      setNotice(doneNotice);
      patchSession(path, { entry: saved, stale: false, notice: doneNotice });
      onSaved?.();
    } catch (err) {
      if (runAbortRef.current?.signal.aborted) {
        const msg = '已停止探测，本次结果没有保存。';
        setNotice(msg);
        patchSession(path, { notice: msg });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        patchSession(path, { error: msg });
      }
    } finally {
      setDetectRunning(false);
      endRun();
      runAbortRef.current = null;
    }
  }, [
    file,
    modelReady,
    blindspotPrompt,
    requirementText,
    fieldsText,
    payloadOfRows,
    entry,
    reqId,
    docs,
    runModel,
    path,
    onSaved,
    beginRun,
    addLog,
    endRun,
  ]);

  const onComplete = useCallback(async () => {
    if (!blindspot) return;
    const picked = blindspot.items.filter((x) => selected.has(x.id) && !x.added);
    if (!picked.length) return;
    setCompleting(true);
    setError('');
    patchSession(path, { completing: true, error: '' });
    beginRun(
      '补全选中条目',
      `把 ${picked.length} 条盲区补全为完整用例（前置 / 步骤 / 预期）`,
      picked.length,
    );
    try {
      if (!modelReady) throw new Error('补全需要模型，请先在设置里配置。');
      const section = blindspotPrompt?.complete?.trim();
      if (!section)
        throw new Error(
          '没有读到「场景遗漏补全提示词.md」的「补全」段，先到插件页把插件关掉再打开重新生成。',
        );
      const system = section.replaceAll('{{selected}}', `见用户消息里的 ${picked.length} 条`);
      const user = [
        '## 需要补全的条目',
        JSON.stringify(
          picked.map((x) => ({
            id: x.id,
            category: x.category,
            title: x.title,
            why: x.why,
            precondition: x.precondition,
            steps: x.steps,
            expected: x.expected,
            priority: x.priority,
            reqAnchor: x.reqAnchor,
          })),
          null,
          2,
        ),
      ].join('\n');

      const collect = { cases: [] as CaseVerdict[], items: [] as BlindspotItem[], summary: '' };
      await runModel(system, user, collect);
      if (!collect.items.length) throw new Error('模型没有返回补全结果，可以重试一次。');
      const byId = new Map(collect.items.map((x) => [x.id, x]));
      const items = blindspot.items.map((old) => {
        const hit = byId.get(old.id);
        if (!hit) return old;
        return {
          ...old,
          ...hit,
          id: old.id,
          category: old.category,
          // 补全阶段不要冲掉探测时标好的归属需求
          reqAnchor: hit.reqAnchor?.trim() || old.reqAnchor,
          added: old.added,
          caseNo: old.caseNo,
        };
      });
      const saved = await saveCaseReviewEntry(path, {
        blindspot: { ...blindspot, items, summary: collect.summary || blindspot.summary },
      });
      const doneNotice = `已补全 ${collect.items.length} 条，确认后可写回用例文件。`;
      setEntry(saved);
      setNotice(doneNotice);
      patchSession(path, { entry: saved, notice: doneNotice });
      onSaved?.();
    } catch (err) {
      if (runAbortRef.current?.signal.aborted) {
        const msg = '已停止补全，本次结果没有保存。';
        setNotice(msg);
        patchSession(path, { notice: msg });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        patchSession(path, { error: msg });
      }
    } finally {
      setCompleting(false);
      endRun();
      runAbortRef.current = null;
    }
  }, [blindspot, selected, modelReady, blindspotPrompt, runModel, path, onSaved, beginRun, endRun]);

  /**
   * 写回：先把勾选条目标「已修改」落盘，再跳工作台会话，
   * 由模型按归属需求插到对应分组下（写前备份，不是整批追加到末尾）。
   */
  const onWriteback = useCallback(() => {
    if (!blindspot) return;
    const picked = blindspot.items.filter((x) => selected.has(x.id) && !x.added);
    if (!picked.length) return;
    setError('');
    const pickedIds = new Set(picked.map((x) => x.id));
    void (async () => {
      try {
        const items = blindspot.items.map((x) => (pickedIds.has(x.id) ? { ...x, added: true } : x));
        const next: BlindspotReport = { ...blindspot, items };
        const saved = await saveCaseReviewEntry(path, { blindspot: next });
        setEntry(saved);
        patchSession(path, { entry: saved });
        setSelected((prev) => {
          const n = new Set(prev);
          for (const id of pickedIds) n.delete(id);
          patchSession(path, { selected: [...n] });
          return n;
        });
        onSaved?.();
        await openBlindspotWritebackInChatSession({
          path,
          name: path.split('/').pop() ?? path,
          items: picked,
          requirementTitle,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [blindspot, selected, path, requirementTitle, onSaved]);

  const onToggle = useCallback(
    (id: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        patchSession(path, { selected: [...next] });
        return next;
      });
    },
    [path],
  );

  const onToggleCategory = useCallback(
    (ids: string[], on: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        patchSession(path, { selected: [...next] });
        return next;
      });
    },
    [path],
  );

  /** 正文相对评审指纹已变（或显式 fixed）→ 视为已修改 */
  const autoFixedKeys = useMemo(
    () => (review && file ? collectAutoFixedKeys(review.cases, file.rows) : new Set<string>()),
    [review, file],
  );

  /** 「错误无效 / 待修改」→ 工作台：只跳转；正文改过后自动识别为已修改 */
  const onFixCase = useCallback(
    (verdict: CaseVerdict) => {
      const key = caseIdentityKey(verdict);
      if (verdict.ignored || verdict.fixed || (key && autoFixedKeys.has(key))) return;
      setError('');
      void openCaseFixInChatSession({
        path,
        name: path.split('/').pop() ?? path,
        verdict,
        requirementTitle,
      }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [path, requirementTitle, autoFixedKeys],
  );

  /** 批量修改：当前筛选出的非「可用」、未「已修改」、未忽略用例一起交给工作台 */
  const onFixBatch = useCallback(
    (items: CaseVerdict[]) => {
      const targets = items.filter((x) => {
        const key = caseIdentityKey(x);
        return !x.ignored && !x.fixed && !(key && autoFixedKeys.has(key)) && x.verdict !== 'usable';
      });
      if (!targets.length) return;
      setError('');
      void openCaseBatchFixInChatSession({
        path,
        name: path.split('/').pop() ?? path,
        verdicts: targets,
        requirementTitle,
      }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [path, requirementTitle, autoFixedKeys],
  );

  const patchIgnored = useCallback(
    async (targets: CaseVerdict[], ignored: boolean) => {
      if (!review || !targets.length) return;
      const keys = new Set(targets.map((t) => caseIdentityKey(t)).filter(Boolean));
      if (!keys.size) return;
      const cases = review.cases.map((c) => {
        if (!keys.has(caseIdentityKey(c))) return c;
        const next = { ...c };
        if (ignored) next.ignored = true;
        else delete next.ignored;
        return next;
      });
      const counts: Record<'usable' | 'revise' | 'invalid', number> = {
        usable: 0,
        revise: 0,
        invalid: 0,
      };
      for (const c of cases) {
        if (c.ignored) continue;
        counts[c.verdict] += 1;
      }
      const saved = await saveCaseReviewEntry(path, { review: { ...review, cases, counts } });
      setEntry(saved);
      patchSession(path, { entry: saved });
      onSaved?.();
    },
    [review, path, onSaved],
  );

  const onIgnoreCase = useCallback(
    (verdict: CaseVerdict) => {
      if (verdict.ignored || verdict.verdict === 'usable') return;
      setError('');
      void patchIgnored([verdict], true).catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    },
    [patchIgnored],
  );

  const onUnignoreCase = useCallback(
    (verdict: CaseVerdict) => {
      if (!verdict.ignored) return;
      setError('');
      void patchIgnored([verdict], false).catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    },
    [patchIgnored],
  );

  /** 需要动手改的条数：排除已标 / 自动识别的「已修改」与忽略 */
  const needFix = review ? countNeedFix(review.cases, autoFixedKeys) : 0;
  const blindspotPending = blindspot ? blindspot.items.filter((x) => !x.added).length : 0;

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'quality', label: `质量评审${review ? ` · 需改 ${needFix}` : ''}` },
    { key: 'table', label: `用例表格${file ? ` ${file.rows.length}` : ''}` },
    {
      key: 'blindspot',
      label: `场景补全${blindspotPending ? ` ${blindspotPending}` : ''}`,
    },
  ];

  const fileName = path.split('/').pop() ?? path;

  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      title={`用例评审 · ${fileName}`}
      widthClass="max-w-5xl"
    >
      {/* 插件关着时 Tab 会禁用：说清原因，否则只看得到点不动的灰按钮 */}
      {!reviewOn || !blindspotOn ? (
        <p className="text-[11px] text-stone-400">
          未启用
          {!reviewOn ? '「用例质量评审」' : ''}
          {!reviewOn && !blindspotOn ? ' / ' : ''}
          {!blindspotOn ? '「场景遗漏补全」' : ''}
          插件：到插件页开启后才能用对应 Tab。
        </p>
      ) : null}
      {/* Tab 与「已挂」同排：需求紧跟切换按钮，长名字截断，不另起一行 */}
      <div className="flex items-center gap-2">
        <div className="flex shrink-0 items-center gap-1 rounded-lg bg-stone-100 p-0.5">
          {tabs.map((t) => {
            const disabled =
              (t.key === 'quality' && !reviewOn) || (t.key === 'blindspot' && !blindspotOn);
            return (
              <button
                key={t.key}
                type="button"
                disabled={disabled}
                onClick={() => setTab(t.key)}
                className={`h-7 rounded-md px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  tab === t.key
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {/* 自动挂上的对照需求：贴着 Tab 组显示；没匹配到时提示「覆盖率不计」，避免被当成正常状态 */}
        {requirementTitle ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-stone-400">
            已挂：{requirementTitle}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-amber-700">
            未匹配到需求（覆盖率不计）
          </span>
        )}
      </div>

      {/* 运行条：正在评审 / 探测 / 补全时一直可见（切 Tab 也不丢）；停止仍用质量评审 Tab 上的按钮 */}
      {runLabel ? (
        <div className="rounded-lg border border-stone-200 bg-white px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className="tw-lib-spin shrink-0"
              style={{ width: 14, height: 14, borderWidth: 2 }}
              aria-hidden="true"
            />
            <span className="font-medium text-stone-700">{runLabel}中…</span>
            <span className="tabular-nums text-stone-500">{elapsed}s</span>
            {received ? (
              <span className="text-stone-500">
                已收到 {received} 条{runTarget ? ` / ${runTarget}` : ''}
              </span>
            ) : null}
          </div>
          <div
            className="tw-run-track mt-2"
            role="progressbar"
            aria-label={`${runLabel}进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              runTarget > 0
                ? Math.round((Math.min(received, runTarget) / runTarget) * 100)
                : undefined
            }
          >
            {runTarget > 0 ? (
              <div
                className="tw-run-fill"
                style={{
                  width: `${Math.round((Math.min(received, runTarget) / runTarget) * 100)}%`,
                }}
              />
            ) : (
              <div className="tw-run-fill tw-run-fill--indeterminate" />
            )}
          </div>
          <div className="mt-1.5 space-y-0.5">
            {runLog.slice(-3).map((line, i) => (
              <div key={`${i}-${line}`} className="truncate text-[10px] text-stone-400">
                · {line}
              </div>
            ))}
            {progress ? (
              <div className="line-clamp-2 text-[10px] leading-4 text-stone-500">{progress}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {stale ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
          文件在评审后改过，结论可能已过期；重新评审可刷新。
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[11px] text-emerald-700">
          {notice}
        </p>
      ) : null}
      {/* 错误统一在抽屉级显示：切 Tab 不会把「为什么失败」弄丢 */}
      {error && file ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] whitespace-pre-wrap text-rose-700">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="py-10 text-center text-xs text-stone-400">读取中…</p>
      ) : error && !file ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-6 text-center text-xs text-rose-700 whitespace-pre-wrap">
          {error}
        </div>
      ) : tab === 'quality' ? (
        <CaseQualityPanel
          review={review}
          running={reviewRunning}
          modelReady={modelReady}
          onRun={onRunReview}
          onStop={onStop}
          onFix={onFixCase}
          onFixBatch={onFixBatch}
          onIgnore={onIgnoreCase}
          onUnignore={onUnignoreCase}
          autoFixedKeys={autoFixedKeys}
          onExport={() => downloadReviewMarkdown(fileName, review, blindspot)}
        />
      ) : tab === 'table' ? (
        <CaseReviewTable
          file={file}
          audit={ruleAudit}
          review={review}
          fileName={fileName}
          autoFixedKeys={autoFixedKeys}
        />
      ) : (
        <CaseBlindspotPanel
          report={blindspot}
          loading={loading}
          running={detectRunning}
          completing={completing}
          modelReady={modelReady}
          onStop={onStop}
          selected={selected}
          onToggle={onToggle}
          onToggleCategory={onToggleCategory}
          onDetect={onDetect}
          onComplete={onComplete}
          onWriteback={onWriteback}
          onExport={() => downloadReviewMarkdown(fileName, review, blindspot)}
        />
      )}
    </SlideOverDrawer>
  );
}
