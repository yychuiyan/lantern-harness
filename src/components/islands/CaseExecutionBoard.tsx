import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

import { hydrateAppConfig } from '../../lib/app-config';
import { listCaseExec, type CaseExecList } from '../../lib/case-exec';
import {
  cancelCaseExecutionLogin,
  checkCaseExecutionAuth,
  completeCaseExecutionLogin,
  confirmCaseExecution,
  fetchCaseExecutionHealth,
  getCaseExecutionDocument,
  getCaseExecutionRun,
  listCaseExecutionFiles,
  listCaseExecutionRuns,
  normalizeCaseExecutionStatus,
  startCaseExecution,
  startCaseExecutionLogin,
  stopCaseExecution,
  summarizeCaseExecution,
  syncCaseExecutionStats,
  updateCaseExecutionFields,
  watchCaseExecutionRun,
  type CaseExecutionCase,
  type CaseExecutionDocument,
  type CaseExecutionFile,
  type CaseExecutionRun,
} from '../../lib/case-execution';
import { openDefectWorkbench, type DefectTemplate } from '../../lib/defect-workbench';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import ConfirmDialog from './ConfirmDialog';
import DatePicker from './DatePicker';
import OverflowHint from './OverflowHint';
import SelectDropdown from './SelectDropdown';
import SlideOverDrawer from './SlideOverDrawer';
import { showToast } from './Toast';

const STATUS_TONE: Record<string, string> = {
  通过: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  不通过: 'border-red-200 bg-red-50 text-red-700',
  阻塞: 'border-amber-200 bg-amber-50 text-amber-700',
  跳过: 'border-stone-200 bg-stone-50 text-stone-600',
  待验证: 'border-sky-200 bg-sky-50 text-sky-700',
};

function statusTone(status: string) {
  return STATUS_TONE[status] || 'border-stone-200 bg-stone-50 text-stone-500';
}

function displayCaseStatus(raw: string) {
  return raw.trim() ? normalizeCaseExecutionStatus(raw) : '未执行';
}

function needsDefect(raw: string) {
  const status = normalizeCaseExecutionStatus(raw);
  return status === '不通过' || status === '阻塞';
}

function httpUrl(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function isWideCaseField(name: string, value: string) {
  return value.length > 80 || /标题|步骤|预期|条件|实际|备注|内容|说明|描述/.test(name);
}

function rawCaseFields(item: CaseExecutionCase) {
  if (item.fields?.length) return item.fields;
  return [
    ['用例编号', item.no],
    ['用例标题', item.title],
    ['所属模块', item.module],
    ['优先级', item.priority],
    ['前置条件', item.precondition],
    ['测试步骤', item.steps],
    ['预期结果', item.expected],
    ['用例状态', item.status],
    ['实际结果', item.actual],
    ['执行人', item.executor],
    ['执行时间', item.executedAt],
    ['执行证据', item.evidence],
    ['缺陷编号', item.defectNo],
    ['缺陷地址', item.defectUrl],
  ]
    .map(([name, value]) => ({ name, value }))
    .filter((field) => field.value);
}

function AutoGrowTextarea({
  value,
  onChange,
  onBlur,
  disabled,
  className,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  disabled?: boolean;
  className: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fitToContent = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fitToContent(el);
    const frame = window.requestAnimationFrame(() => fitToContent(el));
    const onResize = () => fitToContent(el);
    window.addEventListener('resize', onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [fitToContent, value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onInput={(event) => {
        fitToContent(event.currentTarget);
        onChange(event.currentTarget.value);
      }}
      onBlur={onBlur}
      disabled={disabled}
      rows={2}
      className={`${className} min-h-[4.25rem] resize-none overflow-hidden`}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  );
}

function runActive(run: CaseExecutionRun | null) {
  return run?.status === 'running';
}

function failureContext(
  document: CaseExecutionDocument,
  item: CaseExecutionCase,
  run: CaseExecutionRun | null,
  status: string,
  actualResult: string,
  targetUrl: string,
) {
  return [
    `用例文件：${document.path}`,
    `用例编号：${item.no || '未填写'}`,
    `用例标题：${item.title}`,
    `模块：${item.module || '未填写'}`,
    `优先级：${item.priority || '未填写'}`,
    `目标地址：${targetUrl || run?.target.url || '未填写'}`,
    `执行结论：${status}`,
    `前置条件：\n${item.precondition || '无'}`,
    `测试步骤：\n${item.steps || '无'}`,
    `预期结果：\n${item.expected || '无'}`,
    `实际结果：\n${actualResult || run?.result?.actualResult || '无'}`,
    `判定依据：\n${run?.result?.rationale || '人工记录'}`,
    ...(run?.result?.blocker ? [`阻塞原因：\n${run.result.blocker}`] : []),
    ...(run?.result?.unverified?.length
      ? [`未验证项：\n${run.result.unverified.map((item) => `- ${item}`).join('\n')}`]
      : []),
    ...(run?.events.some((event) => event.type === 'screenshot')
      ? [
          `执行证据：\n${run.events
            .filter((event) => event.type === 'screenshot')
            .map((event) => event.url)
            .filter(Boolean)
            .join('\n')}`,
        ]
      : []),
  ].join('\n\n');
}

export default function CaseExecutionBoard() {
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  const [live, setLive] = useState<boolean | null>(null);
  const [files, setFiles] = useState<CaseExecutionFile[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [document, setDocument] = useState<CaseExecutionDocument | null>(null);
  const [runs, setRuns] = useState<CaseExecutionRun[]>([]);
  const [targetUrl, setTargetUrl] = useState('');
  const [storageStatePath, setStorageStatePath] = useState('');
  const [hasSavedAuth, setHasSavedAuth] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeRun, setActiveRun] = useState<CaseExecutionRun | null>(null);
  const [manualRow, setManualRow] = useState<CaseExecutionCase | null>(null);
  const [resultStatus, setResultStatus] = useState('待验证');
  const [resultText, setResultText] = useState('');
  const [defectNo, setDefectNo] = useState('');
  const [defectUrl, setDefectUrl] = useState('');
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle',
  );
  const [defectPick, setDefectPick] = useState<{
    templates: DefectTemplate[];
    context: string;
  } | null>(null);
  const [defectBusy, setDefectBusy] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsData, setStatsData] = useState<CaseExecList | null>(null);
  const [statsProject, setStatsProject] = useState('');
  const [statsDate, setStatsDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [statsPreview, setStatsPreview] = useState<Awaited<
    ReturnType<typeof syncCaseExecutionStats>
  > | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const sourceRef = useRef<(() => void) | null>(null);
  const fileHashRef = useRef('');
  const fieldDraftsRef = useRef<Record<string, string>>({});
  const pendingValuesRef = useRef(new Map<string, string>());
  const saveTimerRef = useRef<number | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const autoConfirmedRunsRef = useRef(new Set<string>());
  const draftCaseKeyRef = useRef('');

  const fileOptions = useMemo(
    () =>
      files.map((file) => ({
        value: file.path,
        label: file.name,
        secondary: `${file.caseCount} 条用例 · ${
          file.executable
            ? '可执行'
            : file.ext === '.xls'
              ? '需另存为 xlsx'
              : file.executionIssue || file.error || '不可执行'
        }`,
      })),
    [files],
  );
  const activeCase = activeRun
    ? document?.cases.find((item) => item.rowIndex === activeRun.rowIndex) || activeRun.case
    : manualRow;
  const activeCaseFields = useMemo(() => {
    return activeCase ? rawCaseFields(activeCase) : [];
  }, [activeCase]);
  const statusHeader = document?.columns.status || '';
  const actualHeader = document?.columns.actual || '';
  const defectHeader = document?.columns.defectNo || '';
  const defectUrlHeader = document?.columns.defectUrl || '缺陷地址';
  const expectedHeader = document?.columns.expected || '';
  const priorityHeader = document?.columns.priority || '';
  const editableCaseFields = useMemo(() => {
    const executionHeaders = new Set(
      [statusHeader, actualHeader, defectHeader, defectUrlHeader, priorityHeader].filter(Boolean),
    );
    return activeCaseFields.filter((field) => !executionHeaders.has(field.name));
  }, [activeCaseFields, actualHeader, defectHeader, defectUrlHeader, priorityHeader, statusHeader]);
  const priorityValue =
    fieldDrafts[priorityHeader] ??
    activeCaseFields.find((field) => field.name === priorityHeader)?.value ??
    '';
  const shortFields = useMemo(() => new Set(['用例编号', '需求编号', '模块', '子模块']), []);
  const boardRunLocked = Boolean(activeRun);
  const hasTarget = Boolean(targetUrl.trim());
  const hasAuth = Boolean(hasSavedAuth || storageStatePath.trim());
  const configReady = hasTarget && hasAuth;
  const caseControlsDisabled = activeRun?.status === 'running';
  const configHint = `测试地址：${hasTarget ? '已填写' : '未填写'}；登录态：${
    hasAuth ? '已准备' : '未准备'
  }`;
  const caseMetrics = useMemo(
    () => summarizeCaseExecution(document?.cases || []),
    [document?.cases],
  );
  const metrics = [
    {
      label: '总数',
      value: caseMetrics.total,
      className: 'text-stone-900',
    },
    {
      label: '已执行',
      value: caseMetrics.executed,
      className: 'text-[#275fc8]',
    },
    {
      label: '未执行',
      value: caseMetrics.pending,
      className: 'text-stone-700',
    },
    {
      label: '通过',
      value: caseMetrics.passed,
      className: 'text-emerald-600',
    },
    {
      label: '未通过',
      value: caseMetrics.failed,
      className: 'text-red-600',
    },
    {
      label: '阻塞',
      value: caseMetrics.blocked,
      className: 'text-amber-600',
    },
    {
      label: '跳过',
      value: caseMetrics.skipped,
      className: 'text-stone-600',
    },
  ];

  const latestRunForCase = useCallback(
    (item: CaseExecutionCase) =>
      runs.find((run) => run.rowIndex === item.rowIndex && run.casePath === document?.path) || null,
    [document?.path, runs],
  );

  const refreshFiles = useCallback(async () => {
    const next = await listCaseExecutionFiles();
    setFiles(next);
    setSelectedPath((current) => {
      if (current && next.some((item) => item.path === current)) return current;
      return next.find((item) => item.executable)?.path || next[0]?.path || '';
    });
  }, []);

  const refreshDocument = useCallback(async (path: string) => {
    if (!path) {
      setDocument(null);
      setRuns([]);
      fileHashRef.current = '';
      return;
    }
    const [nextDocument, nextRuns] = await Promise.all([
      getCaseExecutionDocument(path),
      listCaseExecutionRuns(path),
    ]);
    setDocument(nextDocument);
    setRuns(nextRuns);
    fileHashRef.current = nextDocument.fileHash;
  }, []);

  useEffect(() => {
    const off = onPluginEnabledChanged((map) => setPluginOn(Boolean(map.caseExecution)));
    void hydrateAppConfig().then(() => {
      setPluginOn(isPluginEnabled('caseExecution'));
      setPluginReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!pluginReady || !pluginOn) return;
    void (async () => {
      const ok = await fetchCaseExecutionHealth();
      setLive(ok);
      if (!ok) return;
      try {
        await refreshFiles();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
  }, [pluginOn, pluginReady, refreshFiles]);

  useEffect(() => {
    if (!selectedPath) return;
    setError('');
    void refreshDocument(selectedPath).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refreshDocument, selectedPath]);

  useEffect(() => {
    if (!drawerOpen || !activeCase) {
      if (!drawerOpen) draftCaseKeyRef.current = '';
      return;
    }
    const key = `${activeRun?.casePath || document?.path || ''}:${activeCase.rowIndex}`;
    if (draftCaseKeyRef.current === key) return;
    draftCaseKeyRef.current = key;
    const executionHeaders = new Set([statusHeader, actualHeader, defectHeader].filter(Boolean));
    const next = Object.fromEntries(
      rawCaseFields(activeCase)
        .filter((field) => !executionHeaders.has(field.name))
        .map((field) => [field.name, field.value]),
    );
    fieldDraftsRef.current = next;
    setFieldDrafts(next);
    pendingValuesRef.current.clear();
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    setSaveState('idle');
  }, [
    activeCase,
    activeRun?.casePath,
    actualHeader,
    defectHeader,
    document?.path,
    drawerOpen,
    statusHeader,
  ]);

  useEffect(() => {
    if (!targetUrl.trim()) {
      setHasSavedAuth(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void checkCaseExecutionAuth(targetUrl)
        .then(setHasSavedAuth)
        .catch(() => setHasSavedAuth(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [targetUrl]);

  useEffect(() => {
    return () => sourceRef.current?.();
  }, []);

  async function startLogin() {
    if (!targetUrl.trim()) {
      setConfigOpen(true);
      setError('请先填写测试地址');
      return;
    }
    setAuthBusy(true);
    setError('');
    try {
      await startCaseExecutionLogin(targetUrl.trim());
      showToast('登录窗口已打开，请完成验证后回到页面保存登录态');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAuthBusy(false);
    }
  }

  async function completeLogin() {
    setAuthBusy(true);
    setError('');
    try {
      await completeCaseExecutionLogin();
      setHasSavedAuth(true);
      showToast('登录态已保存', 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAuthBusy(false);
    }
  }

  async function cancelLogin() {
    setAuthBusy(true);
    try {
      await cancelCaseExecutionLogin();
    } finally {
      setAuthBusy(false);
    }
  }

  function scheduleAutoSave() {
    setSaveState('pending');
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushAutoSave();
    }, 650);
  }

  function queueFieldSave(header: string, value: string) {
    if (!header) return;
    pendingValuesRef.current.set(header, value);
    scheduleAutoSave();
  }

  function updateDraftField(header: string, value: string) {
    const next = { ...fieldDraftsRef.current, [header]: value };
    fieldDraftsRef.current = next;
    setFieldDrafts(next);
    queueFieldSave(header, value);
  }

  async function flushAutoSave() {
    if (!document || !activeCase || !pendingValuesRef.current.size) return;
    const casePath = document.path;
    const rowIndex = activeCase.rowIndex;
    const updates = [...pendingValuesRef.current.entries()].map(([header, value]) => ({
      header,
      value,
    }));
    pendingValuesRef.current.clear();
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaveState('saving');
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        const saved = await updateCaseExecutionFields({
          casePath,
          expectedFileHash: fileHashRef.current || document.fileHash,
          rowIndex,
          updates,
        });
        fileHashRef.current = saved.fileHash;
        await refreshDocument(casePath);
        setError('');
        setSaveState('saved');
      } catch (reason) {
        setSaveState('error');
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }

  function updateCaseStatusFromTable(item: CaseExecutionCase, value: string) {
    const header = document?.columns.status;
    if (!document || !header || boardRunLocked) return;
    const casePath = document.path;
    setDocument((current) =>
      current
        ? {
            ...current,
            cases: current.cases.map((row) =>
              row.rowIndex === item.rowIndex
                ? {
                    ...row,
                    status: value,
                    fields: row.fields?.map((field) =>
                      field.name === header ? { ...field, value } : field,
                    ),
                  }
                : row,
            ),
          }
        : current,
    );
    setSaveState('saving');
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        const saved = await updateCaseExecutionFields({
          casePath,
          expectedFileHash: fileHashRef.current || document.fileHash,
          rowIndex: item.rowIndex,
          updates: [{ header, value }],
        });
        fileHashRef.current = saved.fileHash;
        await refreshDocument(casePath);
        setSaveState('saved');
        setError('');
      } catch (reason) {
        setSaveState('error');
        setError(reason instanceof Error ? reason.message : String(reason));
        await refreshDocument(casePath);
      }
    });
  }

  async function autoApplyRunResult(run: CaseExecutionRun) {
    if (
      !run.result ||
      autoConfirmedRunsRef.current.has(run.id) ||
      !['awaiting_confirmation', 'stopped', 'error'].includes(run.status)
    ) {
      return;
    }
    autoConfirmedRunsRef.current.add(run.id);
    setSaveState('saving');
    try {
      const updated = await confirmCaseExecution(run.id, {
        status: run.result.status,
        actualResult: run.result.actualResult,
        defectNo: run.case.defectNo,
      });
      setActiveRun(updated);
      setRuns((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
      setResultStatus(updated.confirmed?.status || run.result.status);
      setResultText(updated.confirmed?.actualResult || run.result.actualResult);
      setDefectNo(run.case.defectNo || '');
      if (updated.confirmed?.fileHash) fileHashRef.current = updated.confirmed.fileHash;
      await refreshDocument(run.casePath);
      setSaveState('saved');
      showToast('AI 执行结果已自动保存到用例文件', 'success');
    } catch (reason) {
      autoConfirmedRunsRef.current.delete(run.id);
      setSaveState('error');
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function attachRun(run: CaseExecutionRun) {
    setActiveRun(run);
    setDrawerOpen(true);
    sourceRef.current?.();
    sourceRef.current = watchCaseExecutionRun(
      run.id,
      run.seq,
      (event) => {
        setActiveRun((current) =>
          current && current.id === run.id
            ? {
                ...current,
                events: [...current.events, event],
                seq: Math.max(current.seq, event.seq),
              }
            : current,
        );
      },
      () => {
        void getCaseExecutionRun(run.id).then((latest) => {
          setActiveRun(latest);
          if (latest.result) {
            setResultStatus(latest.result.status);
            setResultText(latest.result.actualResult);
          }
          setRuns((current) => [latest, ...current.filter((item) => item.id !== latest.id)]);
          if (latest.result) void autoApplyRunResult(latest);
        });
      },
    );
  }

  async function executeCase(item: CaseExecutionCase) {
    if (!document || !targetUrl.trim()) {
      setConfigOpen(true);
      setError('请先选择用例文件并填写测试地址');
      return;
    }
    if (!hasSavedAuth && !storageStatePath.trim()) {
      setConfigOpen(true);
      setError('请先填写登录态文件路径，或点「打开登录页面」完成手动登录');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const run = await startCaseExecution({
        casePath: document.path,
        rowIndex: item.rowIndex,
        url: targetUrl.trim(),
        storageStatePath: storageStatePath.trim() || undefined,
      });
      setResultStatus('待验证');
      setResultText('');
      setDefectNo('');
      setDefectUrl(item.defectUrl);
      attachRun(run);
      setRuns((current) => [run, ...current]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function openCaseDetails(item: CaseExecutionCase, requireExecutable = false) {
    if (requireExecutable && !document?.executable) {
      setError(document?.executionIssue || '该用例文件暂不可执行');
      return;
    }
    setActiveRun(null);
    setManualRow(item);
    setResultStatus(normalizeCaseExecutionStatus(item.status));
    setResultText(item.actual);
    setDefectNo(item.defectNo);
    setDefectUrl(item.defectUrl);
    setDrawerOpen(true);
  }

  function openManual(item: CaseExecutionCase) {
    openCaseDetails(item, true);
  }

  async function stopCurrent() {
    if (!activeRun) return;
    setStopConfirm(false);
    try {
      const stopped = await stopCaseExecution(activeRun.id);
      setActiveRun(stopped);
      if (stopped.result) {
        setResultStatus(stopped.result.status);
        setResultText(stopped.result.actualResult);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function openDefectChooser(
    target = activeCase,
    run = activeRun,
    status = resultStatus,
    actual = resultText,
  ) {
    if (!document || !target) return;
    setDefectBusy(true);
    try {
      const response = await fetch('/__tb_defect_submit/templates');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '缺陷规则读取失败');
      const templates = (data.templates || []) as DefectTemplate[];
      if (!templates.length) {
        throw new Error('还没有缺陷规则，请先在「缺陷规则」页面创建');
      }
      setDefectPick({
        templates,
        context: failureContext(document, target, run, status, actual || target.actual, targetUrl),
      });
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      setDefectBusy(false);
    }
  }

  async function openStats() {
    if (!document) return;
    setBusy(true);
    try {
      setStatsData(await listCaseExec());
      setStatsProject(document.path.split(/[\\/]/).pop()?.split('_')[0] || '');
      setStatsPreview(null);
      setStatsOpen(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function previewStats() {
    if (!document || !statsProject.trim()) return;
    try {
      setStatsPreview(
        await syncCaseExecutionStats({
          casePath: document.path,
          project: statsProject.trim(),
          date: statsDate,
          mode: 'preview',
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function applyStats(mode: 'skip' | 'overwrite') {
    if (!document || !statsProject.trim()) return;
    setBusy(true);
    try {
      const result = await syncCaseExecutionStats({
        casePath: document.path,
        project: statsProject.trim(),
        date: statsDate,
        mode,
      });
      setStatsPreview(result);
      showToast(result.skipped ? '已跳过已有统计' : '用例执行统计已同步', 'success');
      setStatsOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!pluginReady) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white px-5 py-16 text-center text-sm text-stone-500">
        正在读取插件状态…
      </div>
    );
  }
  if (!pluginOn) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        {pluginDisabledMessage('caseExecution')}
      </div>
    );
  }
  if (live === null) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white px-5 py-16 text-center text-sm text-stone-500">
        正在连接用例执行服务…
      </div>
    );
  }
  if (!live) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-900">
        用例执行需要本地服务，当前未就绪。
      </div>
    );
  }

  return (
    <>
      <section className="flex h-[calc(100vh-4rem)] min-h-[640px] flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
        <div className="shrink-0 border-b border-stone-100 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[240px] max-w-[460px] flex-1">
              <SelectDropdown
                value={selectedPath}
                onChange={setSelectedPath}
                options={fileOptions}
                disabled={boardRunLocked}
                searchable
                searchPlaceholder="搜索用例文件…"
                ariaLabel="选择用例文件"
              />
            </div>
            <button
              type="button"
              onClick={() => setConfigOpen((open) => !open)}
              aria-expanded={configOpen}
              data-hint={configHint}
              className="flex h-8 min-w-[136px] flex-1 items-center justify-center gap-2 rounded-lg border border-stone-200 px-3 text-xs font-medium text-stone-700 hover:bg-stone-100 md:max-w-[220px]"
            >
              <span
                className={`h-2 w-2 rounded-full ${configReady ? 'bg-emerald-500' : 'bg-amber-500'}`}
              />
              执行配置
              <span className={`text-[10px] ${configOpen ? 'rotate-180' : ''}`}>⌄</span>
            </button>
            {activeRun ? (
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className={`h-8 whitespace-nowrap rounded-lg border px-3 text-xs font-medium ${
                  runActive(activeRun)
                    ? 'border-[#b8cdf7] bg-[#f2f6ff] text-[#275fc8] hover:bg-[#e8f0fe]'
                    : 'border-stone-200 text-stone-700 hover:bg-stone-100'
                }`}
              >
                {runActive(activeRun) ? '查看进度' : '查看结果'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void openStats()}
              disabled={!document?.executable}
              className="h-8 whitespace-nowrap rounded-lg border border-stone-200 px-3 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-40"
            >
              同步统计
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
            {metrics.map((metric) => (
              <span
                key={metric.label}
                className="inline-flex items-center gap-1.5 whitespace-nowrap"
                data-hint={metric.label === '已执行' ? '不包含待验证' : undefined}
              >
                <span>{metric.label}</span>
                <span className={`font-semibold tabular-nums ${metric.className}`}>
                  {metric.value}
                </span>
              </span>
            ))}
            <span className="ml-auto inline-flex items-center gap-2 whitespace-nowrap">
              <span>执行率</span>
              <span className="font-semibold tabular-nums text-stone-800">
                {caseMetrics.executionRate}%
              </span>
              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-stone-200">
                <span
                  className="block h-full rounded-full bg-[#4176e6] transition-[width] duration-300"
                  style={{ width: `${caseMetrics.executionRate}%` }}
                />
              </span>
            </span>
          </div>

          {configOpen ? (
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <input
                value={targetUrl}
                onChange={(event) => setTargetUrl(event.target.value)}
                aria-label="测试地址"
                placeholder="测试地址：https://业务系统地址"
                className="h-9 w-full rounded-lg border border-stone-200 px-3 text-sm outline-none focus:border-[#4176e6]"
              />
              <input
                value={storageStatePath}
                onChange={(event) => setStorageStatePath(event.target.value)}
                aria-label="登录态文件"
                placeholder={
                  hasSavedAuth
                    ? '已保存当前地址登录态，可留空'
                    : '登录态文件：/path/to/storageState.json'
                }
                className="h-9 w-full rounded-lg border border-stone-200 px-3 text-sm outline-none focus:border-[#4176e6]"
              />
              <div className="flex flex-wrap items-center gap-1.5 md:col-span-2 md:justify-end">
                <button
                  type="button"
                  onClick={() => void startLogin()}
                  disabled={authBusy || !targetUrl.trim()}
                  className="h-8 whitespace-nowrap rounded-lg border border-stone-200 px-3 text-xs font-medium hover:bg-stone-100 disabled:opacity-40"
                >
                  打开登录页面
                </button>
                <button
                  type="button"
                  onClick={() => void completeLogin()}
                  disabled={authBusy}
                  className="h-8 whitespace-nowrap rounded-lg border border-stone-200 px-3 text-xs font-medium hover:bg-stone-100 disabled:opacity-40"
                >
                  保存登录态
                </button>
                <button
                  type="button"
                  onClick={() => void cancelLogin()}
                  disabled={authBusy}
                  className="h-8 whitespace-nowrap rounded-lg border border-stone-200 px-3 text-xs font-medium text-stone-500 hover:bg-stone-100 disabled:opacity-40"
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}
          {document && !document.executable ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {document.executionIssue || '该用例文件暂不能执行。'}
            </p>
          ) : null}
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[730px] table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-stone-50 text-xs text-stone-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">用例</th>
                <th className="w-[110px] px-3 py-2 text-center font-medium">执行结果</th>
                <th className="w-[150px] px-3 py-2 text-center font-medium">缺陷地址</th>
                <th className="w-[230px] px-3 py-2 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {document?.cases.map((item) => (
                <tr
                  key={item.id}
                  tabIndex={boardRunLocked ? -1 : 0}
                  aria-label={`查看用例：${item.title || '未命名用例'}`}
                  onClick={() => {
                    if (!boardRunLocked) openCaseDetails(item);
                  }}
                  onKeyDown={(event) => {
                    if (boardRunLocked || event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openCaseDetails(item);
                  }}
                  className={`border-t border-stone-100 hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#4176e6]/50 focus-visible:outline-none ${
                    boardRunLocked ? '' : 'cursor-pointer'
                  }`}
                >
                  <td className="px-3 py-2 align-top">
                    <OverflowHint
                      text={
                        [item.no ? `#${item.no}` : '', item.module || '', item.priority || '']
                          .filter(Boolean)
                          .join(' · ') || '未编号'
                      }
                      className="block truncate text-[11px] text-stone-400"
                    />
                    <OverflowHint
                      text={item.title || '未命名用例'}
                      className="mt-0.5 block truncate font-medium text-stone-800"
                    />
                    <OverflowHint
                      text={item.steps || item.expected || '无步骤'}
                      className="mt-1 block truncate text-[11px] text-stone-400"
                    />
                  </td>
                  <td
                    className="px-3 py-2 text-center align-middle"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {document?.columns.status ? (
                      <SelectDropdown
                        value={displayCaseStatus(item.status)}
                        onChange={(value) => updateCaseStatusFromTable(item, value)}
                        options={[
                          ...(displayCaseStatus(item.status) === '未执行'
                            ? [{ value: '未执行', label: '未执行' }]
                            : []),
                          ...(
                            document.statuses || ['待验证', '通过', '不通过', '阻塞', '跳过']
                          ).map((value) => ({ value, label: value })),
                        ]}
                        ariaLabel={`选择用例状态：${item.title || '未命名用例'}`}
                        disabled={boardRunLocked}
                        unstyled
                        fitContent
                        menuMatchTrigger={false}
                        menuMinWidth={120}
                        triggerClassName={`h-6 cursor-pointer whitespace-nowrap rounded-full border px-2 text-[11px] font-medium shadow-sm transition-colors hover:opacity-80 focus-visible:ring-2 focus-visible:ring-[#4176e6]/40 ${statusTone(displayCaseStatus(item.status))} disabled:opacity-50`}
                        renderTrigger={() => (
                          <span className="inline-flex items-center gap-1">
                            {displayCaseStatus(item.status)}
                            <span aria-hidden="true" className="text-[9px] opacity-70">
                              ▼
                            </span>
                          </span>
                        )}
                      />
                    ) : (
                      <span
                        className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${statusTone(displayCaseStatus(item.status))}`}
                      >
                        {displayCaseStatus(item.status)}
                      </span>
                    )}
                  </td>
                  <td
                    className="px-3 py-2 text-center align-middle"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {httpUrl(item.defectUrl) ? (
                      <a
                        href={httpUrl(item.defectUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-1 truncate text-xs font-medium text-[#4176e6] hover:underline"
                      >
                        打开缺陷
                      </a>
                    ) : (
                      <span className="text-xs text-stone-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center align-middle">
                    <div
                      className="flex justify-center gap-1.5"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        disabled={busy || !document?.executable || boardRunLocked}
                        onClick={() => void executeCase(item)}
                        className="h-7 rounded-md bg-[#4176e6] px-2.5 text-xs font-medium text-white hover:bg-[#3565c7] disabled:opacity-40"
                      >
                        AI执行
                      </button>
                      <button
                        type="button"
                        disabled={busy || !document?.executable || boardRunLocked}
                        onClick={() => openManual(item)}
                        className="h-7 rounded-md border border-stone-200 px-2.5 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-40"
                      >
                        手动记录
                      </button>
                      {needsDefect(item.status) ? (
                        <button
                          type="button"
                          disabled={busy || defectBusy || boardRunLocked}
                          onClick={() => {
                            const latest = latestRunForCase(item);
                            void openDefectChooser(
                              item,
                              latest,
                              normalizeCaseExecutionStatus(item.status),
                              latest?.confirmed?.actualResult || item.actual,
                            );
                          }}
                          className="h-7 rounded-md border border-red-200 px-2.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
                        >
                          创建缺陷
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!document?.cases.length ? (
            <div className="px-4 py-20 text-center text-sm text-stone-400">暂无可执行用例</div>
          ) : null}
        </div>
      </section>

      <SlideOverDrawer
        open={drawerOpen}
        onClose={() => {
          void flushAutoSave();
          setDrawerOpen(false);
        }}
        title={
          activeRun
            ? activeRun.status === 'running'
              ? 'AI 正在执行用例'
              : '用例详情与执行结果'
            : '用例详情与执行结果'
        }
        widthClass="max-w-3xl"
        escDisabled={false}
        bodyClassName="flex flex-col gap-4"
        footer={
          activeRun?.status === 'running' ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStopConfirm(true)}
                className="mr-auto h-8 rounded-lg border border-red-200 px-3 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                停止执行
              </button>
            </div>
          ) : undefined
        }
      >
        {activeCase ? (
          <>
            <div className="rounded-lg bg-stone-50 p-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-400">
                <span>{activeCase.no ? `#${activeCase.no}` : '未编号'}</span>
                {activeCase.module ? <span>· {activeCase.module}</span> : null}
                {activeCase.priority ? <span>· {activeCase.priority}</span> : null}
              </div>
              <div className="mt-1 text-sm font-semibold text-stone-900">{activeCase.title}</div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-stone-700">字段内容</h3>
                <span
                  className={`text-[11px] ${
                    saveState === 'error'
                      ? 'text-red-600'
                      : saveState === 'saved'
                        ? 'text-emerald-600'
                        : 'text-stone-400'
                  }`}
                >
                  {saveState === 'pending'
                    ? '等待自动保存'
                    : saveState === 'saving'
                      ? '正在保存…'
                      : saveState === 'saved'
                        ? '已自动保存'
                        : saveState === 'error'
                          ? '保存失败'
                          : `${activeCaseFields.length} 个字段`}
                </span>
              </div>
              <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
                {editableCaseFields.map((field, index) => {
                  const value = fieldDrafts[field.name] ?? field.value;
                  const wide = isWideCaseField(field.name, value);
                  return (
                    <Fragment key={`${field.name}-${index}`}>
                      <label className={`block ${wide ? 'md:col-span-2' : ''}`}>
                        <span className="mb-1 block text-[11px] font-medium text-stone-400">
                          {field.name}
                        </span>
                        {shortFields.has(field.name) ? (
                          <input
                            value={value}
                            onChange={(event) => updateDraftField(field.name, event.target.value)}
                            onBlur={() => void flushAutoSave()}
                            disabled={caseControlsDisabled}
                            className="h-9 w-full rounded-md border border-stone-200 bg-white px-2.5 text-sm text-stone-700 outline-none focus:border-[#4176e6] disabled:opacity-60"
                          />
                        ) : (
                          <AutoGrowTextarea
                            value={value}
                            onChange={(next) => updateDraftField(field.name, next)}
                            onBlur={() => void flushAutoSave()}
                            disabled={caseControlsDisabled}
                            className="w-full rounded-md border border-stone-200 bg-white px-2.5 py-2 text-sm leading-6 text-stone-700 outline-none focus:border-[#4176e6] disabled:opacity-60"
                          />
                        )}
                      </label>
                      {actualHeader && field.name === expectedHeader ? (
                        <label className="block md:col-span-2">
                          <span className="mb-1 block text-[11px] font-medium text-stone-400">
                            {actualHeader}
                          </span>
                          <AutoGrowTextarea
                            value={resultText}
                            onChange={(next) => {
                              setResultText(next);
                              queueFieldSave(actualHeader, next);
                            }}
                            onBlur={() => void flushAutoSave()}
                            disabled={caseControlsDisabled}
                            className="w-full rounded-md border border-stone-200 bg-white px-2.5 py-2 text-sm leading-6 text-stone-700 outline-none focus:border-[#4176e6] disabled:opacity-60"
                            placeholder="记录实际操作、页面现象和与预期的差异"
                          />
                        </label>
                      ) : null}
                      {field.name === expectedHeader ? (
                        <label className="block md:col-span-2">
                          <span className="mb-1 block text-[11px] font-medium text-stone-400">
                            缺陷地址
                          </span>
                          <input
                            type="url"
                            value={defectUrl}
                            onChange={(event) => {
                              setDefectUrl(event.target.value);
                              queueFieldSave(defectUrlHeader, event.target.value);
                            }}
                            onBlur={() => void flushAutoSave()}
                            disabled={caseControlsDisabled}
                            className="h-9 w-full rounded-md border border-stone-200 bg-white px-2.5 text-sm text-stone-700 outline-none focus:border-[#4176e6] disabled:opacity-60"
                            placeholder="https://缺陷管理平台/..."
                          />
                        </label>
                      ) : null}
                    </Fragment>
                  );
                })}
                {actualHeader &&
                !editableCaseFields.some((field) => field.name === expectedHeader) ? (
                  <label className="block md:col-span-2">
                    <span className="mb-1 block text-[11px] font-medium text-stone-400">
                      {actualHeader}
                    </span>
                    <AutoGrowTextarea
                      value={resultText}
                      onChange={(next) => {
                        setResultText(next);
                        queueFieldSave(actualHeader, next);
                      }}
                      onBlur={() => void flushAutoSave()}
                      disabled={caseControlsDisabled}
                      className="w-full rounded-md border border-stone-200 bg-white px-2.5 py-2 text-sm leading-6 text-stone-700 outline-none focus:border-[#4176e6] disabled:opacity-60"
                      placeholder="记录实际操作、页面现象和与预期的差异"
                    />
                  </label>
                ) : null}
                {!editableCaseFields.some((field) => field.name === expectedHeader) ? (
                  <label className="block md:col-span-2">
                    <span className="mb-1 block text-[11px] font-medium text-stone-400">
                      缺陷地址
                    </span>
                    <input
                      type="url"
                      value={defectUrl}
                      onChange={(event) => {
                        setDefectUrl(event.target.value);
                        queueFieldSave(defectUrlHeader, event.target.value);
                      }}
                      onBlur={() => void flushAutoSave()}
                      disabled={caseControlsDisabled}
                      className="h-9 w-full rounded-md border border-stone-200 bg-white px-2.5 text-sm text-stone-700 outline-none focus:border-[#4176e6] disabled:opacity-60"
                      placeholder="https://缺陷管理平台/..."
                    />
                  </label>
                ) : null}
              </div>
            </div>
            {activeRun ? (
              <div className="rounded-lg border border-stone-200 p-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-stone-700">{activeRun.progress.label}</span>
                  <span className="text-stone-400">
                    {activeRun.progress.elapsedSeconds}s · {activeRun.progress.toolCount} 次操作
                  </span>
                </div>
                <div className="mt-3 max-h-56 space-y-2 overflow-y-auto">
                  {activeRun.events.slice(-40).map((event) => (
                    <div
                      key={`${event.seq}-${event.type}`}
                      className="rounded-md bg-stone-50 px-2.5 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-stone-700">{event.title}</span>
                        <span className="text-stone-400">{event.detail || ''}</span>
                      </div>
                      {event.url && event.type === 'screenshot' ? (
                        <a
                          href={event.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-block text-[#4176e6]"
                        >
                          查看截图
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-stone-700">执行信息</h3>
                <span className="text-[11px] text-stone-400">
                  {activeRun?.status === 'running' ? '执行完成后可编辑' : '修改后自动保存到文件'}
                </span>
              </div>
              {!document?.executable ? (
                <p className="rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
                  {document?.executionIssue ||
                    '该文件缺少执行列；其他已有字段仍可编辑，补齐后可记录完整执行结果。'}
                </p>
              ) : null}
              <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
                {priorityHeader ? (
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-stone-600">
                      {priorityHeader}
                    </span>
                    <input
                      value={priorityValue}
                      onChange={(event) => updateDraftField(priorityHeader, event.target.value)}
                      onBlur={() => void flushAutoSave()}
                      disabled={caseControlsDisabled}
                      className="h-9 w-full rounded-lg border border-stone-200 px-3 text-sm outline-none focus:border-[#4176e6] disabled:opacity-60"
                    />
                  </label>
                ) : null}
                {statusHeader ? (
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-stone-600">
                      {statusHeader}
                    </span>
                    <SelectDropdown
                      value={resultStatus}
                      onChange={(value) => {
                        setResultStatus(value);
                        queueFieldSave(statusHeader, value);
                      }}
                      ariaLabel={`选择${statusHeader}`}
                      disabled={caseControlsDisabled}
                      options={(
                        document?.statuses || ['待验证', '通过', '不通过', '阻塞', '跳过']
                      ).map((value) => ({ value, label: value }))}
                    />
                  </label>
                ) : null}
                {defectHeader ? (
                  <label className="block md:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-stone-600">
                      {defectHeader}（可选）
                    </span>
                    <input
                      value={defectNo}
                      onChange={(event) => {
                        setDefectNo(event.target.value);
                        queueFieldSave(defectHeader, event.target.value);
                      }}
                      onBlur={() => void flushAutoSave()}
                      disabled={caseControlsDisabled}
                      className="h-9 w-full rounded-lg border border-stone-200 px-3 text-sm outline-none focus:border-[#4176e6] disabled:opacity-60"
                      placeholder="后续提交缺陷后回填"
                    />
                  </label>
                ) : null}
              </div>
            </div>
            {activeRun?.result?.rationale ? (
              <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">
                <div className="font-medium">AI 判定依据</div>
                <p className="mt-1 whitespace-pre-wrap">{activeRun.result.rationale}</p>
                {activeRun.result.blocker ? (
                  <p className="mt-1 text-amber-700">阻塞原因：{activeRun.result.blocker}</p>
                ) : null}
              </div>
            ) : null}
            {activeRun?.status !== 'running' &&
            (resultStatus === '不通过' || resultStatus === '阻塞') ? (
              <button
                type="button"
                onClick={() => void openDefectChooser()}
                disabled={defectBusy}
                className="h-9 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
              >
                {resultStatus === '阻塞' ? '仍要创建缺陷' : '创建缺陷'}
              </button>
            ) : null}
          </>
        ) : null}
      </SlideOverDrawer>

      <Dialog
        open={Boolean(defectPick)}
        onClose={() => setDefectPick(null)}
        className="relative z-110"
      >
        <DialogBackdrop className="fixed inset-0 bg-black/30" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="w-full max-w-md rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
            <DialogTitle className="text-base font-semibold text-stone-900">
              选择缺陷规则
            </DialogTitle>
            <p className="mt-1 text-xs text-stone-500">
              选择后将进入缺陷提交工作台，不会自动提交。
            </p>
            <div className="mt-4 space-y-2">
              {defectPick?.templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => void openDefectWorkbench(template, defectPick.context)}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2.5 text-left text-sm hover:border-[#4176e6] hover:bg-[#f7f9ff]"
                >
                  <span className="block font-medium text-stone-800">{template.name}</span>
                  <span className="mt-0.5 block text-xs text-stone-500">
                    {template.config.target.sheetTitle ||
                      template.config.target.platform ||
                      '缺陷入口'}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setDefectPick(null)}
                className="h-8 rounded-lg border border-stone-200 px-3 text-xs text-stone-600"
              >
                取消
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <Dialog open={statsOpen} onClose={() => setStatsOpen(false)} className="relative z-110">
        <DialogBackdrop className="fixed inset-0 bg-black/30" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="w-full max-w-lg rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
            <DialogTitle className="text-base font-semibold text-stone-900">
              同步到用例执行统计
            </DialogTitle>
            <p className="mt-1 text-xs text-stone-500">
              同步不会自动覆盖手工统计，覆盖前会再次确认。
            </p>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-xs text-stone-600">
                统计项目
                <input
                  list="case-execution-stats-projects"
                  value={statsProject}
                  onChange={(event) => setStatsProject(event.target.value)}
                  className="h-9 rounded-lg border border-stone-200 px-3 text-sm"
                  placeholder="选择或输入项目名称"
                />
                <datalist id="case-execution-stats-projects">
                  {(statsData?.projects || []).map((project) => (
                    <option key={project} value={project} />
                  ))}
                </datalist>
              </label>
              <label className="grid gap-1 text-xs text-stone-600">
                统计日期
                <DatePicker
                  value={statsDate}
                  onChange={setStatsDate}
                  className="h-9 rounded-lg border border-stone-200 px-3 text-sm"
                />
              </label>
              {statsPreview ? (
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                  <div>总数：{statsPreview.preview.total}</div>
                  <div>已执行：{statsPreview.preview.executed}</div>
                  <div>剩余：{statsPreview.preview.pending}</div>
                  {statsPreview.preview.existing ? (
                    <div className="mt-1 text-amber-700">该日期已有手工统计，不会自动覆盖。</div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStatsOpen(false)}
                className="h-8 rounded-lg border border-stone-200 px-3 text-xs text-stone-600"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void previewStats()}
                className="h-8 rounded-lg border border-stone-200 px-3 text-xs text-stone-700"
              >
                预览
              </button>
              {statsPreview?.preview.existing ? (
                <button
                  type="button"
                  onClick={() => void applyStats('skip')}
                  className="h-8 rounded-lg border border-stone-200 px-3 text-xs text-stone-700"
                >
                  跳过
                </button>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  void applyStats(statsPreview?.preview.existing ? 'overwrite' : 'skip')
                }
                className="h-8 rounded-lg bg-[#4176e6] px-3 text-xs text-white"
              >
                同步
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <ConfirmDialog
        open={stopConfirm}
        title="停止用例执行"
        message="停止后可以重新执行，已产生的截图和日志会保留。"
        confirmLabel="停止"
        danger
        onClose={() => setStopConfirm(false)}
        onConfirm={() => void stopCurrent()}
      />
    </>
  );
}
