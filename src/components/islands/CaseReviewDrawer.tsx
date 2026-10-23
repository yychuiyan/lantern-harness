/**
 * 用例评审抽屉：质量评审 / 用例表格 / 场景补全 三个 Tab。
 *
 * - 打开时读报告、提示词与需求上下文（对照需求按文件名自动匹配，不再手动选）；读文件拿用例行
 * - 评审与盲区都靠浏览器里的模型跑（`streamChatWithTools` + 两个提交工具），
 *   判定与分数最终由 `src/lib/case-review.ts` 的规则重算并落盘
 * - 补全写回不再走服务端追加：跳工作台，在那条用例绑定的会话里按文件表头补行
 * - 「错误无效 / 待修改」可以带着扣分原因跳到工作台，在那条用例绑定的会话里改文件
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  openBlindspotWritebackInChatSession,
  openCaseBatchFixInChatSession,
  openCaseFixInChatSession,
} from '../../lib/case-fix-jump';
import { caseFieldMap, describeFieldMap } from '../../lib/case-fields';
import { CASE_FIELDS } from '../../lib/export';
import { readViewPref, writeViewPref } from '../../lib/view-prefs';

type TabKey = 'quality' | 'table' | 'blindspot';

/** 文件名 / 需求标题归一化：去掉扩展名、空格与括号，便于粗匹配 */
function normalizeCaseName(value: string): string {
  return value
    .replace(/\.[^.]+$/, '')
    .replace(/[\s_\-—·()（）[\]【】]/g, '')
    .toLowerCase();
}

/**
 * 猜一份对照需求：用例文件「运管系统v1.10.0迭代.xlsx」对上需求分析「运管系统v1.10.0迭代」。
 * 只认「互相包含」，且要求被包含的那段至少 4 个字，宁可不挂也不乱挂。
 */
function guessRequirementId(docs: readonly ReqAnalysisDoc[], filePath: string): string {
  const base = normalizeCaseName(filePath.split('/').pop() ?? filePath);
  if (!base) return '';
  let best = '';
  let bestLen = 0;
  for (const doc of docs) {
    const title = normalizeCaseName(doc.title);
    if (title.length < 4) continue;
    if (!base.includes(title) && !title.includes(base)) continue;
    if (title.length > bestLen) {
      best = doc.id;
      bestLen = title.length;
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
  const abortRef = useRef<AbortController | null>(null);

  const modelReady = Boolean(settings?.baseURL && settings.apiKey && settings.model);

  /** 开始一次长任务：运行条亮起、日志清空、计时归零；target>0 时走确定进度条 */
  const beginRun = useCallback((label: string, first: string, target = 0) => {
    setRunLabel(label);
    setRunLog([first]);
    setReceived(0);
    setElapsed(0);
    setProgress('');
    setRunTarget(target);
  }, []);
  const addLog = useCallback((line: string) => {
    setRunLog((prev) => [...prev.slice(-11), line]);
  }, []);
  const endRun = useCallback(() => {
    setRunLabel('');
    setProgress('');
    setElapsed(0);
    setRunTarget(0);
  }, []);

  /** 停止：中断当前模型的流式请求；已经拿到的结果不落盘 */
  const onStop = useCallback(() => {
    if (!abortRef.current) return;
    abortRef.current.abort();
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
        setError('评审服务没起来：确认已用 `lantern dev` 启动（插件依赖本地中间件）。');
      }
      // 两份报告存在同一个 store，任一中间件可用就能读（只开场景补全时也要读得到）
      const storeReady = revHealth || blHealth;
      const [fileData, entryRes] = await Promise.all([
        readCaseFile(path),
        storeReady ? fetchCaseReviewEntry(path) : Promise.resolve({ entry: null, stale: false }),
      ]);
      setFile(fileData);
      // 旧报告的两处口径问题在读的时候对齐：判定按分数重算、空标题按编号从文件回填
      setEntry(
        entryRes.entry?.review
          ? {
              ...entryRes.entry,
              review: normalizeReport(entryRes.entry.review, fileData.rows),
            }
          : entryRes.entry,
      );
      setStale(entryRes.stale);

      if (revHealth && reviewOn) {
        setReviewPrompt(await fetchCaseReviewPrompt());
      }
      if (blHealth && blindspotOn) {
        const prompt = await fetchBlindspotPrompt();
        setBlindspotPrompt(prompt);
      }
      // 只开「场景补全」时也要挂需求：两个服务都能读，读不到就当没需求
      if (revHealth || blHealth) {
        try {
          setDocs(await listReqDocs());
        } catch {
          setDocs([]);
        }
      } else {
        setDocs([]);
      }
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [path, reviewOn, blindspotOn]);

  useEffect(() => {
    if (!open) return;
    // 首次打开用记住的 Tab；记住的那个插件被关掉时退回可用的一档
    const remembered = readViewPref<TabKey>(
      'caseReview.tab',
      ['quality', 'table', 'blindspot'],
      'quality',
    );
    const usable =
      remembered === 'blindspot' ? blindspotOn : remembered === 'quality' ? reviewOn : true;
    setTab(usable ? remembered : reviewOn ? 'quality' : 'blindspot');
    // 换文件 = 重新猜对照需求
    setReqId('');
    void load();
  }, [open, load, reviewOn, blindspotOn, setTab]);

  /**
   * 对照需求：按文件名自动匹配一份需求分析。
   * 匹配不到就保持空（覆盖率不计），界面上不提示、也不让手动选。
   */
  useEffect(() => {
    if (reqId && docs.some((d) => d.id === reqId)) return;
    const guess = guessRequirementId(docs, path);
    if (guess) setReqId(guess);
  }, [docs, path, reqId]);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open]);

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
    ) => {
      if (!settings) throw new Error('还没读到模型设置');
      const controller = new AbortController();
      abortRef.current = controller;
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
                addLog(`模型交回 ${cases.length} 条判定（累计 ${total} 条）`);
              },
              onBlindspots: (items, summary) => {
                collect.items.push(...items);
                if (summary) collect.summary = summary;
                const total = collect.cases.length + collect.items.length;
                setReceived(total);
                addLog(`模型交回 ${items.length} 条盲区（累计 ${total} 条）`);
              },
            }),
        },
      )) {
        if (chunk.type === 'content') {
          tail = `${tail}${chunk.delta}`.slice(-400);
          setProgress(tail);
        }
      }
    },
    [settings, addLog],
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
    const audit = auditCases(file.rows, requirementText);
    if (!file.rows.length) {
      setError(
        '这个文件里没解析到用例行：确认第一行是表头，且有编号与标题列（「测试项目 / 用例名称」这类叫法也认）。',
      );
      return;
    }
    setReviewRunning(true);
    setError('');
    beginRun('评审用例', `开始评审 ${file.rows.length} 条用例（规则 + 模型）`);
    try {
      if (!modelReady) {
        addLog('没有配置模型，只跑规则判定');
        const report = ruleReviewReport(audit);
        const saved = await saveCaseReviewEntry(path, { review: report });
        setEntry(saved);
        setStale(false);
        onSaved?.();
        setNotice('没有配置模型，已保存纯规则结果。');
        return;
      }
      const section = reviewPrompt?.review?.trim();
      if (!section)
        throw new Error(
          '没有读到「用例质量评审提示词.md」的「评审」段，先到插件页把插件关掉再打开重新生成。',
        );
      addLog(`规则体检完成：${audit.cases.length} 条，按五维拼提示词`);
      const casesText = payloadOfRows(file.rows, file.headers);
      const system = section
        .replaceAll('{{cases}}', `见用户消息里的 ${file.rows.length} 条用例`)
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
        `## 待评审用例（${file.rows.length} 条）`,
        casesText,
      ].join('\n');

      const collect = { cases: [] as CaseVerdict[], items: [] as BlindspotItem[], summary: '' };
      addLog('提示词已就绪，等待模型返回…');
      await runModel(system, user, collect);
      if (!collect.cases.length)
        throw new Error('模型没有提交判定结果，可以重试一次或换成更擅长的模型。');
      addLog('正在按规则复算分数并落盘…');
      const report = mergeModelReview(audit, collect.cases, collect.summary);
      const saved = await saveCaseReviewEntry(path, { review: report });
      setEntry(saved);
      setStale(false);
      onSaved?.();
      setNotice(
        `评审完成：${report.cases.length} 条，可用 ${report.counts.usable} · 待修改 ${report.counts.revise} · 错误无效 ${report.counts.invalid}。`,
      );
    } catch (err) {
      if (abortRef.current?.signal.aborted) {
        setNotice('已停止评审，本次结果没有保存；已有报告保持不变。');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setReviewRunning(false);
      endRun();
      abortRef.current = null;
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
  ]);

  const onDetect = useCallback(async () => {
    if (!file) return;
    setDetectRunning(true);
    setError('');
    beginRun('探测场景盲区', `开始对照需求检查 ${file.rows.length} 条用例的盲区`);
    try {
      if (!modelReady) throw new Error('场景探测需要模型，请先在设置里配置。');
      const section = blindspotPrompt?.detect?.trim();
      if (!section)
        throw new Error(
          '没有读到「场景遗漏补全提示词.md」的「探测」段，先到插件页把插件关掉再打开重新生成。',
        );
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
      ].join('\n');

      const collect = { cases: [] as CaseVerdict[], items: [] as BlindspotItem[], summary: '' };
      addLog(
        `上下文：需求${requirementText ? '已挂' : '未挂'} · 四类盲区 · ${file.rows.length} 条已有用例`,
      );
      await runModel(system, user, collect);
      if (!collect.items.length) throw new Error('模型没有提交盲区条目，可以重试一次。');

      addLog('正在去重并落盘探测结果…');

      // 新探测结果：保留已补全条目的标记，其余按 id 去重
      const prev = new Map(
        (entry?.blindspot?.items ?? []).map((x) => [`${x.category}|${x.title}`, x]),
      );
      const seen = new Set<string>();
      const items: BlindspotItem[] = [];
      for (const item of collect.items) {
        const key = `${item.category}|${item.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const old = prev.get(key);
        items.push({
          ...item,
          id: old?.id || item.id || `bs_${Math.random().toString(16).slice(2, 18)}`,
          added: old?.added ?? false,
          caseNo: old?.caseNo ?? '',
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
      setEntry(saved);
      setStale(false);
      onSaved?.();
      setNotice(`探测完成：${items.length} 条盲区。`);
    } catch (err) {
      if (abortRef.current?.signal.aborted) {
        setNotice('已停止探测，本次结果没有保存。');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setDetectRunning(false);
      endRun();
      abortRef.current = null;
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
    const picked = blindspot.items.filter((x) => selected.has(x.id));
    if (!picked.length) return;
    setCompleting(true);
    setError('');
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
          added: old.added,
          caseNo: old.caseNo,
        };
      });
      const saved = await saveCaseReviewEntry(path, {
        blindspot: { ...blindspot, items, summary: collect.summary || blindspot.summary },
      });
      setEntry(saved);
      onSaved?.();
      setNotice(`已补全 ${collect.items.length} 条，确认后可写回用例文件。`);
    } catch (err) {
      if (abortRef.current?.signal.aborted) {
        setNotice('已停止补全，本次结果没有保存。');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setCompleting(false);
      endRun();
      abortRef.current = null;
    }
  }, [blindspot, selected, modelReady, blindspotPrompt, runModel, path, onSaved, beginRun, endRun]);

  /**
   * 写回：不再服务端追加，改成跳到这条用例绑定的工作台会话，
   * 由模型按文件表头把勾选的盲区补进原文件（写前备份）。
   */
  const onWriteback = useCallback(() => {
    if (!blindspot) return;
    const picked = blindspot.items.filter((x) => selected.has(x.id) && !x.added);
    if (!picked.length) return;
    setError('');
    void openBlindspotWritebackInChatSession({
      path,
      name: path.split('/').pop() ?? path,
      items: picked,
      requirementTitle,
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [blindspot, selected, path, requirementTitle]);

  const onToggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onToggleCategory = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  /** 「错误无效 / 待修改」→ 工作台：在这条用例绑定的会话里改文件，没有会话就新建 */
  const onFixCase = useCallback(
    (verdict: CaseVerdict) => {
      void openCaseFixInChatSession({
        path,
        name: path.split('/').pop() ?? path,
        verdict,
        requirementTitle,
      }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [path, requirementTitle],
  );

  /** 批量修改：当前筛选出的非「可用」用例一起交给工作台改 */
  const onFixBatch = useCallback(
    (items: CaseVerdict[]) => {
      if (!items.length) return;
      void openCaseBatchFixInChatSession({
        path,
        name: path.split('/').pop() ?? path,
        verdicts: items,
        requirementTitle,
      }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [path, requirementTitle],
  );

  /** 需要动手改的条数：与「质量评审」结论卡同一份数据 */
  const needFix = review ? review.counts.revise + review.counts.invalid : 0;

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'quality', label: `质量评审${review ? ` · 需改 ${needFix}` : ''}` },
    { key: 'table', label: `用例表格${file ? ` ${file.rows.length}` : ''}` },
    {
      key: 'blindspot',
      label: `场景补全${blindspot?.items.length ? ` ${blindspot.items.length}` : ''}`,
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

      {/* 运行条：正在评审 / 探测 / 补全时一直可见（切 Tab 也不丢），带计时、已收条数、日志与停止 */}
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
            <button
              type="button"
              onClick={onStop}
              className="ml-auto h-6 shrink-0 rounded-md border border-rose-200 px-2 text-[11px] text-rose-600 transition-colors hover:bg-rose-50"
            >
              停止
            </button>
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
          onExport={() => downloadReviewMarkdown(fileName, review, blindspot)}
        />
      ) : tab === 'table' ? (
        <CaseReviewTable file={file} audit={ruleAudit} review={review} fileName={fileName} />
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
