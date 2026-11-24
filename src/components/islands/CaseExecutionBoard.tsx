import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

import { hydrateAppConfig } from '../../lib/app-config';
import { listCaseExec, type CaseExecList } from '../../lib/case-exec';
import {
  defectLinks,
  fetchCaseExecutionHealth,
  getCaseExecutionDocument,
  listCaseExecutionFiles,
  normalizeCaseExecutionStatus,
  summarizeCaseExecution,
  syncCaseExecutionStats,
  updateCaseExecutionFields,
  type CaseExecutionCase,
  type CaseExecutionDocument,
  type CaseExecutionFile,
} from '../../lib/case-execution';
import {
  getCaseAutomationBatch,
  startCaseAutomationBatch,
  stopCaseAutomationBatch,
  type CaseAutomationBatch,
} from '../../lib/case-automation';
import { openDefectWorkbench, type DefectTemplate } from '../../lib/defect-workbench';
import { isPluginEnabled, onPluginEnabledChanged, pluginDisabledMessage } from '../../lib/plugins';
import {
  readViewJson,
  readViewPref,
  readViewText,
  writeViewJson,
  writeViewPref,
  writeViewText,
} from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import DatePicker from './DatePicker';
import OverflowHint from './OverflowHint';
import SelectDropdown from './SelectDropdown';
import SlideOverDrawer from './SlideOverDrawer';
import CaseAutomationDrawer from './CaseAutomationDrawer';
import {
  ColumnResizeHandle,
  useColumnWidths,
  useScrollEdges,
  type ColumnSpec,
} from './ColumnResize';
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

const AUTOMATION_TONE: Record<string, string> = {
  automatable: 'border-sky-200 bg-sky-50 text-sky-700',
  needs_manual: 'border-amber-200 bg-amber-50 text-amber-700',
  not_automatable: 'border-stone-200 bg-stone-50 text-stone-500',
  connected: 'border-blue-200 bg-blue-50 text-blue-700',
  running: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  passed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
  partial: 'border-orange-200 bg-orange-50 text-orange-700',
  stale: 'border-amber-200 bg-amber-50 text-amber-700',
  not_configured: 'border-stone-200 bg-stone-50 text-stone-400',
  not_applicable: 'border-stone-200 bg-stone-50 text-stone-400',
};

const AUTOMATION_LABEL: Record<string, string> = {
  automatable: '可自动化',
  needs_manual: '需人工',
  not_automatable: '不可自动化',
  connected: '已接入',
  running: '运行中',
  passed: '已通过',
  failed: '异常',
  partial: '部分执行',
  stale: '已过期',
  not_configured: '未评估',
  not_applicable: '不适用',
};

const CASE_EXECUTION_COLUMNS: ColumnSpec[] = [
  { key: 'case', width: 360, min: 220 },
  { key: 'status', width: 110, min: 90 },
  { key: 'automation', width: 125, min: 105 },
  { key: 'defect', width: 150, min: 120 },
  { key: 'filler', filler: true },
  { key: 'action', width: 230, min: 210 },
];

type ExecutionFilter = 'all' | 'executed' | 'pending' | 'passed' | 'failed' | 'blocked' | 'skipped';

const EXECUTION_FILTER_VALUES = [
  'all',
  'executed',
  'pending',
  'passed',
  'failed',
  'blocked',
  'skipped',
] as const satisfies readonly ExecutionFilter[];

const AUTOMATION_FILTER_VALUES = [
  'all',
  'unconnected',
  'pending',
  'active',
  'passed',
  'issue',
] as const;

const CASE_FILE_PREF = 'caseExecution.file';
const EXECUTION_FILTER_PREF = 'caseExecution.executionFilter';
const AUTOMATION_FILTER_PREF = 'caseExecution.automationFilter';
const CASE_SCROLL_PREF = 'caseExecution.scrollByFile';

function automationMeta(item: CaseExecutionCase, unavailable = false) {
  const status = unavailable ? 'not_applicable' : item.automation?.status || 'not_configured';
  return {
    status,
    label: AUTOMATION_LABEL[status] || status,
    tone: AUTOMATION_TONE[status] || AUTOMATION_TONE.not_configured,
    total: item.automation?.total || 0,
    passed: item.automation?.passed || 0,
  };
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
    ['缺陷标题', item.defectTitle],
    ['缺陷信息', item.defectUrl],
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

function failureContext(
  document: CaseExecutionDocument,
  item: CaseExecutionCase,
  status: string,
  actualResult: string,
) {
  return [
    `用例文件：${document.path}`,
    `用例编号：${item.no || '未填写'}`,
    `用例标题：${item.title}`,
    `模块：${item.module || '未填写'}`,
    `优先级：${item.priority || '未填写'}`,
    `执行结论：${status}`,
    `前置条件：\n${item.precondition || '无'}`,
    `测试步骤：\n${item.steps || '无'}`,
    `预期结果：\n${item.expected || '无'}`,
    `实际结果：\n${actualResult || '无'}`,
    '判定依据：人工记录',
  ].join('\n\n');
}

function DefectInfoEditor({
  title,
  values,
  disabled,
  onTitleChange,
  onChange,
  onBlur,
}: {
  title: string;
  values: string[];
  disabled: boolean;
  onTitleChange: (value: string) => void;
  onChange: (values: string[]) => void;
  onBlur: () => void;
}) {
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  return (
    <div className="space-y-2 md:col-span-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-stone-400">缺陷信息</span>
        <button
          type="button"
          disabled={disabled || values.length >= 50}
          onClick={() => onChange([...values, ''])}
          className="text-xs text-[#4176e6] disabled:opacity-40"
        >
          添加缺陷地址
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-stone-400">缺陷标题</span>
          <input
            value={title}
            disabled={disabled}
            onChange={(event) => onTitleChange(event.target.value)}
            onBlur={onBlur}
            className="h-9 w-full rounded-md border border-stone-200 bg-white px-2.5 text-sm text-stone-700 outline-none focus:border-[#4176e6] disabled:opacity-60"
            placeholder="填写缺陷标题"
          />
        </label>
        {values.map((value, index) => (
          <label key={index} className={`block ${index ? 'md:col-start-2' : ''}`}>
            <span className="mb-1 block text-[11px] font-medium text-stone-400">
              缺陷地址 {index + 1}
            </span>
            <div className="flex items-center gap-2">
              <input
                type="url"
                aria-label={`缺陷地址 ${index + 1}`}
                value={value}
                disabled={disabled}
                onChange={(event) =>
                  onChange(values.map((item, i) => (i === index ? event.target.value : item)))
                }
                onBlur={onBlur}
                className="h-9 min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-2.5 text-sm text-stone-700 outline-none focus:border-[#4176e6] disabled:opacity-60"
                placeholder="https://缺陷管理平台/..."
              />
              {httpUrl(value) ? (
                <a
                  href={httpUrl(value)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-[#4176e6]"
                >
                  打开
                </a>
              ) : null}
              <button
                type="button"
                disabled={disabled}
                aria-label={`删除缺陷地址 ${index + 1}`}
                onClick={() => setRemoveIndex(index)}
                className="text-xs text-red-600"
              >
                删除
              </button>
            </div>
          </label>
        ))}
      </div>
      <ConfirmDialog
        open={removeIndex !== null}
        title="删除缺陷地址"
        message={`删除「${removeIndex === null ? '' : values[removeIndex] || '空地址'}」？`}
        danger
        onClose={() => setRemoveIndex(null)}
        onConfirm={() => {
          const next = values.filter((_, i) => i !== removeIndex);
          onChange(next.length ? next : ['']);
          setRemoveIndex(null);
        }}
      />
    </div>
  );
}

export default function CaseExecutionBoard() {
  const [pluginReady, setPluginReady] = useState(false);
  const [pluginOn, setPluginOn] = useState(true);
  const [live, setLive] = useState<boolean | null>(null);
  const [files, setFiles] = useState<CaseExecutionFile[]>([]);
  const [selectedPath, setSelectedPath] = useState(() => readViewText(CASE_FILE_PREF));
  const [document, setDocument] = useState<CaseExecutionDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [manualRow, setManualRow] = useState<CaseExecutionCase | null>(null);
  const [resultStatus, setResultStatus] = useState('待验证');
  const [resultText, setResultText] = useState('');
  const [defectNo, setDefectNo] = useState('');
  const [defectTitle, setDefectTitle] = useState('');
  const [defectUrls, setDefectUrls] = useState<string[]>(['']);
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
  const [executionFilter, setExecutionFilter] = useState<ExecutionFilter>(() =>
    readViewPref(EXECUTION_FILTER_PREF, EXECUTION_FILTER_VALUES, 'all'),
  );
  const [automationFilter, setAutomationFilter] = useState(() =>
    readViewPref(AUTOMATION_FILTER_PREF, AUTOMATION_FILTER_VALUES, 'all'),
  );
  const [automationAssessOpen, setAutomationAssessOpen] = useState(false);
  const [automationAssessCaseId, setAutomationAssessCaseId] = useState('');
  const [automationRunOpen, setAutomationRunOpen] = useState(false);
  const [automationSelected, setAutomationSelected] = useState<Record<string, boolean>>({});
  const [automationEnv, setAutomationEnv] = useState('');
  const [automationBatch, setAutomationBatch] = useState<CaseAutomationBatch | null>(null);
  const [automationBusy, setAutomationBusy] = useState(false);
  const fileHashesRef = useRef(new Map<string, string>());
  const selectedPathRef = useRef(selectedPath);
  const fieldDraftsRef = useRef<Record<string, string>>({});
  const pendingValuesRef = useRef(new Map<string, string>());
  const saveTimerRef = useRef<number | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const draftCaseKeyRef = useRef('');
  const cols = useColumnWidths('lh:case-execution:cols', CASE_EXECUTION_COLUMNS);
  const rememberScrollEdges = useScrollEdges('case-execution');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSaveTimerRef = useRef<number | null>(null);
  const restoredScrollPathRef = useRef('');
  const setScrollContainerRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element;
      rememberScrollEdges(element);
    },
    [rememberScrollEdges],
  );
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
  const activeCase = manualRow;
  const activeCaseFields = useMemo(() => {
    return activeCase ? rawCaseFields(activeCase) : [];
  }, [activeCase]);
  const statusHeader = document?.columns.status || '';
  const actualHeader = document?.columns.actual || '';
  const defectHeader = document?.columns.defectNo || '';
  const defectTitleHeader = document?.columns.defectTitle || '缺陷标题';
  const defectUrlHeader = document?.columns.defectUrl || '缺陷信息';
  const expectedHeader = document?.columns.expected || '';
  const priorityHeader = document?.columns.priority || '';
  const editableCaseFields = useMemo(() => {
    const executionHeaders = new Set(
      [
        statusHeader,
        actualHeader,
        defectHeader,
        defectTitleHeader,
        defectUrlHeader,
        priorityHeader,
      ].filter(Boolean),
    );
    return activeCaseFields.filter((field) => !executionHeaders.has(field.name));
  }, [
    activeCaseFields,
    actualHeader,
    defectHeader,
    defectTitleHeader,
    defectUrlHeader,
    priorityHeader,
    statusHeader,
  ]);
  const expectedFieldIndex = editableCaseFields.findIndex((field) => field.name === expectedHeader);
  const caseFieldsBeforeExpected =
    expectedFieldIndex >= 0
      ? editableCaseFields.slice(0, expectedFieldIndex + 1)
      : editableCaseFields;
  const caseFieldsAfterExpected =
    expectedFieldIndex >= 0 ? editableCaseFields.slice(expectedFieldIndex + 1) : [];
  const priorityValue =
    fieldDrafts[priorityHeader] ??
    activeCaseFields.find((field) => field.name === priorityHeader)?.value ??
    '';
  const shortFields = useMemo(() => new Set(['用例编号', '需求编号', '模块', '子模块']), []);
  const caseControlsDisabled = false;
  const caseMetrics = useMemo(
    () => summarizeCaseExecution(document?.cases || []),
    [document?.cases],
  );
  const metrics = [
    {
      label: '总数',
      value: caseMetrics.total,
      className: 'text-stone-900',
      filter: 'all',
    },
    {
      label: '已执行',
      value: caseMetrics.executed,
      className: 'text-[#275fc8]',
      filter: 'executed',
    },
    {
      label: '未执行',
      value: caseMetrics.pending,
      className: 'text-stone-700',
      filter: 'pending',
    },
    {
      label: '通过',
      value: caseMetrics.passed,
      className: 'text-emerald-600',
      filter: 'passed',
    },
    {
      label: '未通过',
      value: caseMetrics.failed,
      className: 'text-red-600',
      filter: 'failed',
    },
    {
      label: '阻塞',
      value: caseMetrics.blocked,
      className: 'text-amber-600',
      filter: 'blocked',
    },
    {
      label: '跳过',
      value: caseMetrics.skipped,
      className: 'text-stone-600',
      filter: 'skipped',
    },
  ] satisfies Array<{
    label: string;
    value: number;
    className: string;
    filter: ExecutionFilter;
  }>;
  const automationFile = Boolean(document?.path.split('/').includes('自动化测试'));
  const filteredCases = useMemo(() => {
    const rows = (document?.cases || []).filter((item) => {
      const status = normalizeCaseExecutionStatus(item.status);
      if (executionFilter === 'all') return true;
      if (executionFilter === 'executed') return status !== '待验证';
      if (executionFilter === 'pending') return status === '待验证';
      if (executionFilter === 'passed') return status === '通过';
      if (executionFilter === 'failed') return status === '不通过';
      if (executionFilter === 'blocked') return status === '阻塞';
      if (executionFilter === 'skipped') return status === '跳过';
      return true;
    });
    if (automationFilter === 'all') return rows;
    return rows.filter((item) => {
      const status = automationMeta(item, automationFile).status;
      if (automationFilter === 'unconnected')
        return ['not_configured', 'automatable'].includes(status);
      if (automationFilter === 'pending')
        return ['needs_manual', 'not_automatable'].includes(status);
      if (automationFilter === 'active')
        return ['connected', 'running', 'partial'].includes(status);
      if (automationFilter === 'passed') return status === 'passed';
      if (automationFilter === 'issue') return ['failed', 'stale'].includes(status);
      return true;
    });
  }, [automationFile, automationFilter, document?.cases, executionFilter]);
  useEffect(() => {
    const path = document?.path;
    if (!path || path !== selectedPath || restoredScrollPathRef.current === path) return;
    const timer = window.setTimeout(() => {
      const element = scrollRef.current;
      if (!element) return;
      const positions = readViewJson<Record<string, number>>(CASE_SCROLL_PREF, {});
      const saved = Number(positions[path]);
      element.scrollTop = Number.isFinite(saved) && saved > 0 ? Math.round(saved) : 0;
      restoredScrollPathRef.current = path;
    }, 80);
    return () => window.clearTimeout(timer);
  }, [document?.path, filteredCases.length, selectedPath]);
  const runnableAutomationItems = useMemo(
    () =>
      (document?.cases || []).flatMap((item) =>
        (item.automation?.items || [])
          .filter(
            (entry) =>
              entry.scriptPath && ['connected', 'failed', 'passed', 'stale'].includes(entry.status),
          )
          .map((entry) => ({ ...entry, sourceTitle: item.title })),
      ),
    [document?.cases],
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
      return;
    }
    const nextDocument = await getCaseExecutionDocument(path);
    fileHashesRef.current.set(path, nextDocument.fileHash);
    if (selectedPathRef.current === path) setDocument(nextDocument);
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
    selectedPathRef.current = selectedPath;
    if (!selectedPath) return;
    setError('');
    void refreshDocument(selectedPath).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refreshDocument, selectedPath]);

  useEffect(() => {
    writeViewText(CASE_FILE_PREF, selectedPath);
    restoredScrollPathRef.current = '';
  }, [selectedPath]);

  useEffect(() => {
    writeViewPref(EXECUTION_FILTER_PREF, executionFilter);
  }, [executionFilter]);

  useEffect(() => {
    writeViewPref(AUTOMATION_FILTER_PREF, automationFilter);
  }, [automationFilter]);

  useEffect(
    () => () => {
      if (scrollSaveTimerRef.current !== null) {
        window.clearTimeout(scrollSaveTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!drawerOpen || !activeCase) {
      if (!drawerOpen) draftCaseKeyRef.current = '';
      return;
    }
    const key = `${document?.path || ''}:${activeCase.rowIndex}`;
    if (draftCaseKeyRef.current === key) return;
    draftCaseKeyRef.current = key;
    const executionHeaders = new Set(
      [statusHeader, actualHeader, defectHeader, defectTitleHeader, defectUrlHeader].filter(
        Boolean,
      ),
    );
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
    actualHeader,
    defectHeader,
    defectTitleHeader,
    defectUrlHeader,
    document?.path,
    drawerOpen,
    statusHeader,
  ]);

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
    const statusUpdate = updates.find((update) => update.header === statusHeader);
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
          expectedFileHash: fileHashesRef.current.get(casePath) || document.fileHash,
          rowIndex,
          updates,
        });
        fileHashesRef.current.set(casePath, saved.fileHash);
        await refreshDocument(casePath);
        setError('');
        setSaveState('saved');
        if (statusUpdate) {
          showToast(`执行结果已更新为「${statusUpdate.value}」`, 'success');
        }
      } catch (reason) {
        setSaveState('error');
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }

  function updateCaseStatusFromTable(item: CaseExecutionCase, value: string) {
    const header = document?.columns.status;
    if (!document || !header) return;
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
          expectedFileHash: fileHashesRef.current.get(casePath) || document.fileHash,
          rowIndex: item.rowIndex,
          updates: [{ header, value }],
        });
        fileHashesRef.current.set(casePath, saved.fileHash);
        await refreshDocument(casePath);
        setSaveState('saved');
        setError('');
        showToast(`执行结果已更新为「${value}」`, 'success');
      } catch (reason) {
        setSaveState('error');
        setError(reason instanceof Error ? reason.message : String(reason));
        await refreshDocument(casePath);
      }
    });
  }

  function openCaseDetails(item: CaseExecutionCase, requireExecutable = false) {
    if (requireExecutable && !document?.executable) {
      setError(document?.executionIssue || '该用例文件暂不可执行');
      return;
    }
    setManualRow(item);
    setResultStatus(normalizeCaseExecutionStatus(item.status));
    setResultText(item.actual);
    setDefectNo(item.defectNo);
    setDefectTitle(item.defectTitle);
    setDefectUrls(defectLinks(item.defectUrl).length ? defectLinks(item.defectUrl) : ['']);
    setDrawerOpen(true);
  }

  function openManual(item: CaseExecutionCase) {
    openCaseDetails(item, true);
  }

  async function openDefectChooser(
    target = activeCase,
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
        context: failureContext(document, target, status, actual || target.actual),
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

  function rememberVerticalScroll(event: UIEvent<HTMLDivElement>) {
    const path = selectedPath;
    if (!path) return;
    const top = Math.max(0, Math.round(event.currentTarget.scrollTop));
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
    }
    scrollSaveTimerRef.current = window.setTimeout(() => {
      scrollSaveTimerRef.current = null;
      const positions = readViewJson<Record<string, number>>(CASE_SCROLL_PREF, {});
      writeViewJson(CASE_SCROLL_PREF, { ...positions, [path]: top });
    }, 120);
  }

  function openAutomationRun() {
    const selected: Record<string, boolean> = {};
    for (const item of runnableAutomationItems) selected[item.automationCaseId] = true;
    setAutomationSelected(selected);
    setAutomationBatch(null);
    setAutomationEnv('');
    setAutomationRunOpen(true);
  }

  async function runAutomationBatch() {
    const ids = Object.keys(automationSelected).filter((id) => automationSelected[id]);
    if (!ids.length) {
      setError('请至少选择一条已接入的自动化用例');
      return;
    }
    setAutomationBusy(true);
    setError('');
    try {
      let batch = (await startCaseAutomationBatch({ automationCaseIds: ids, env: automationEnv }))
        .batch;
      setAutomationBatch(batch);
      while (batch.status === 'running' || batch.status === 'pending') {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        batch = (await getCaseAutomationBatch(batch.id)).batch;
        setAutomationBatch({ ...batch });
      }
      if (selectedPath) await refreshDocument(selectedPath);
      showToast(
        batch.status === 'completed' ? '自动化运行结束' : '自动化运行已停止',
        batch.status === 'completed' ? 'success' : undefined,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAutomationBusy(false);
    }
  }

  async function stopAutomationBatch() {
    if (!automationBatch || automationBusy === false) return;
    try {
      const stopped = await stopCaseAutomationBatch(automationBatch.id);
      setAutomationBatch(stopped.batch);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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

  function renderCaseField(field: { name: string; value: string }, index: number) {
    const value = fieldDrafts[field.name] ?? field.value;
    const wide = isWideCaseField(field.name, value);
    return (
      <label key={`${field.name}-${index}`} className={`block ${wide ? 'md:col-span-2' : ''}`}>
        <span className="mb-1 block text-[11px] font-medium text-stone-400">{field.name}</span>
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
    );
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
                searchable
                searchPlaceholder="搜索用例文件…"
                ariaLabel="选择用例文件"
              />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <div className="w-44 shrink-0">
                <SelectDropdown
                  className="!block w-full"
                  value={automationFilter}
                  onChange={setAutomationFilter}
                  options={[
                    { value: 'all', label: '全部自动化状态' },
                    { value: 'unconnected', label: '未接入' },
                    { value: 'pending', label: '待处理' },
                    { value: 'active', label: '进行中' },
                    { value: 'passed', label: '已通过' },
                    { value: 'issue', label: '异常或过期' },
                  ]}
                  ariaLabel="筛选自动化状态"
                  compact
                  menuMatchTrigger={false}
                  menuMinWidth={176}
                />
              </div>
              <button
                type="button"
                onClick={() => void openStats()}
                disabled={!document?.executable}
                className="h-8 whitespace-nowrap rounded-lg border border-stone-200 px-3 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-40"
              >
                同步统计
              </button>
              <button
                type="button"
                disabled={!document?.cases.length}
                onClick={() => {
                  setAutomationAssessCaseId('');
                  setAutomationAssessOpen(true);
                }}
                className="tw-btn tw-btn-ghost h-8 whitespace-nowrap text-xs"
                title="选择当前文件中的用例进行自动化识别评估"
              >
                自动化评估
              </button>
              <button
                type="button"
                disabled={!runnableAutomationItems.length}
                onClick={openAutomationRun}
                className="tw-btn tw-btn-ghost h-8 whitespace-nowrap text-xs"
                title={
                  runnableAutomationItems.length
                    ? `运行 ${runnableAutomationItems.length} 条已接入自动化用例`
                    : '先为功能用例生成并写入自动化脚本'
                }
              >
                运行自动化
              </button>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
            {metrics.map((metric) => {
              const active = executionFilter === metric.filter;
              return (
                <button
                  key={metric.label}
                  type="button"
                  aria-pressed={active}
                  title={
                    metric.filter === 'all'
                      ? '显示全部用例'
                      : `筛选${metric.label}用例；再次点击取消筛选`
                  }
                  onClick={() =>
                    setExecutionFilter((current) =>
                      metric.filter === 'all' || current === metric.filter ? 'all' : metric.filter,
                    )
                  }
                  className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 transition-colors ${
                    active
                      ? 'bg-white text-stone-800 shadow-sm ring-1 ring-stone-200'
                      : 'hover:bg-white/70'
                  }`}
                  data-hint={metric.label === '已执行' ? '不包含待验证' : undefined}
                >
                  <span>{metric.label}</span>
                  <span className={`font-semibold tabular-nums ${metric.className}`}>
                    {metric.value}
                  </span>
                </button>
              );
            })}
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

          {document?.provenance?.stale ? (
            <p className="mt-2 text-xs text-amber-700">
              需求基线已变化：历史结果保留，需更新基线并人工复核。
            </p>
          ) : null}
          {document && !document.executable ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {document.executionIssue || '该用例文件暂不能执行。'}
            </p>
          ) : null}
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>

        <div
          ref={setScrollContainerRef}
          onScroll={rememberVerticalScroll}
          className="tw-scroll-x min-h-0 flex-1 overflow-auto"
        >
          <table className="tw-sticky-table table-fixed text-sm" style={cols.tableStyle}>
            <colgroup>
              {CASE_EXECUTION_COLUMNS.map((column) => (
                <col
                  key={column.key}
                  style={cols.widthOf(column.key) ? { width: cols.widthOf(column.key) } : undefined}
                />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-stone-50 text-xs text-stone-500">
              <tr>
                <th className="relative px-3 py-2 text-left font-medium">
                  用例
                  <ColumnResizeHandle {...cols.resizeProps('case')} />
                </th>
                <th className="relative px-3 py-2 text-center font-medium">
                  执行结果
                  <ColumnResizeHandle {...cols.resizeProps('status')} />
                </th>
                <th className="relative px-3 py-2 text-center font-medium">
                  自动化状态
                  <ColumnResizeHandle {...cols.resizeProps('automation')} />
                </th>
                <th className="relative px-3 py-2 text-center font-medium">
                  缺陷信息
                  <ColumnResizeHandle {...cols.resizeProps('defect')} />
                </th>
                <th aria-hidden="true" />
                <th className="relative px-3 py-2 text-center font-medium">
                  操作
                  <ColumnResizeHandle {...cols.resizeProps('action')} />
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredCases.map((item) => (
                <tr
                  key={item.id}
                  tabIndex={0}
                  aria-label={`查看用例：${item.title || '未命名用例'}`}
                  onClick={() => openCaseDetails(item)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openCaseDetails(item);
                  }}
                  className="cursor-pointer border-t border-stone-100 hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#4176e6]/50 focus-visible:outline-none"
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
                    {(() => {
                      const meta = automationMeta(item, automationFile);
                      return (
                        <span
                          className={`inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${meta.tone}`}
                          title={
                            meta.status === 'passed'
                              ? `${meta.passed}/${meta.total} 条自动化用例通过`
                              : AUTOMATION_LABEL[meta.status] || meta.status
                          }
                        >
                          {meta.label}
                          {meta.total ? ` ${meta.passed}/${meta.total}` : ''}
                        </span>
                      );
                    })()}
                  </td>
                  <td
                    className="px-3 py-2 text-center align-middle"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {(() => {
                      const links = defectLinks(item.defectUrl);
                      const titles = String(item.defectTitle || '')
                        .split(/\r?\n/)
                        .map((value) => value.trim())
                        .filter(Boolean);
                      if (!links.length) return <span className="text-xs text-stone-400">—</span>;
                      return (
                        <div className="flex w-full min-w-0 flex-col items-center gap-1">
                          {links.map((link, linkIndex) => {
                            const title =
                              titles[linkIndex] ||
                              (linkIndex === 0 ? titles[0] : '') ||
                              `缺陷 ${linkIndex + 1}`;
                            return (
                              <a
                                key={link}
                                href={httpUrl(link)}
                                target="_blank"
                                rel="noreferrer"
                                className="block w-full min-w-0 truncate text-xs font-medium text-[#4176e6] hover:underline"
                              >
                                <OverflowHint text={title} className="block truncate" />
                              </a>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </td>
                  <td aria-hidden="true" />
                  <td className="px-3 py-2 text-center align-middle">
                    <div
                      className="flex justify-center gap-1.5"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      {!automationFile ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setAutomationAssessCaseId(item.id);
                            setAutomationAssessOpen(true);
                          }}
                          className="h-7 rounded-md border border-[#b8cdf7] px-2.5 text-xs font-medium text-[#275fc8] hover:bg-[#f2f6ff] disabled:opacity-40"
                        >
                          {(item.automation?.status || 'not_configured') === 'not_configured'
                            ? '评估'
                            : '重新评估'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy || !document?.executable}
                        onClick={() => openManual(item)}
                        className="h-7 rounded-md border border-stone-200 px-2.5 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-40"
                      >
                        手动记录
                      </button>
                      {needsDefect(item.status) ? (
                        <button
                          type="button"
                          disabled={busy || defectBusy}
                          onClick={() => {
                            void openDefectChooser(
                              item,
                              normalizeCaseExecutionStatus(item.status),
                              item.actual,
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
          ) : !filteredCases.length ? (
            <div className="px-4 py-20 text-center text-sm text-stone-400">
              没有符合当前筛选条件的用例
            </div>
          ) : null}
        </div>
      </section>

      <CaseAutomationDrawer
        open={automationAssessOpen}
        casePath={selectedPath}
        initialCaseId={automationAssessCaseId}
        onClose={() => {
          setAutomationAssessOpen(false);
          setAutomationAssessCaseId('');
          if (selectedPath) void refreshDocument(selectedPath);
        }}
        onApplied={() => {
          if (selectedPath) void refreshDocument(selectedPath);
        }}
      />

      <SlideOverDrawer
        open={automationRunOpen}
        onClose={() => {
          if (automationBusy) return;
          setAutomationRunOpen(false);
        }}
        title="运行已接入自动化"
        widthClass="max-w-2xl"
        bodyClassName="space-y-4"
        footer={
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-stone-500">
              {automationBatch
                ? `${automationBatch.items.filter((item) => item.status === 'passed').length}/${automationBatch.items.length} 通过`
                : `已选择 ${Object.values(automationSelected).filter(Boolean).length} 条`}
            </span>
            <div className="flex gap-2">
              {automationBatch && ['running', 'pending'].includes(automationBatch.status) ? (
                <button
                  type="button"
                  onClick={() => void stopAutomationBatch()}
                  className="h-9 rounded-lg border border-[#f0c6c6] px-3 text-sm text-red-600 hover:bg-red-50"
                >
                  停止
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={automationBusy}
                    onClick={() => setAutomationRunOpen(false)}
                    className="h-9 rounded-lg border border-stone-200 px-3 text-sm text-stone-600"
                  >
                    关闭
                  </button>
                  <button
                    type="button"
                    disabled={automationBusy || !runnableAutomationItems.length}
                    onClick={() => void runAutomationBatch()}
                    className="h-9 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white disabled:opacity-40"
                  >
                    {automationBusy ? '运行中…' : '开始运行'}
                  </button>
                </>
              )}
            </div>
          </div>
        }
      >
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-600">
          只运行已经写入 Playwright iteration 文件的自动化测试块。每个测试按 automationCaseId
          独立回写，不会把同一文件里的其他用例结果混入。
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-stone-600">运行环境 ENV</span>
          <input
            value={automationEnv}
            onChange={(event) => setAutomationEnv(event.target.value)}
            placeholder="留空使用项目默认 .env；例如 test / uat"
            className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm outline-none focus:border-[#4176e6]"
          />
        </label>
        {runnableAutomationItems.length ? (
          <div className="space-y-2">
            {runnableAutomationItems.map((item) => (
              <label
                key={item.automationCaseId}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-stone-200 p-3 hover:bg-stone-50"
              >
                <input
                  type="checkbox"
                  checked={Boolean(automationSelected[item.automationCaseId])}
                  disabled={automationBusy}
                  onChange={(event) =>
                    setAutomationSelected((current) => ({
                      ...current,
                      [item.automationCaseId]: event.target.checked,
                    }))
                  }
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-stone-800">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-stone-400">
                    {item.sourceTitle} · {item.projectName} · {item.iteration} · {item.tag}
                  </span>
                  <span className="mt-1 block text-[11px] text-stone-500">
                    {AUTOMATION_LABEL[item.status] || item.status}
                    {item.error ? ` · ${item.error}` : ''}
                  </span>
                </span>
                {item.reportUrl ? (
                  <a
                    href={item.reportUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-[#4176e6]"
                  >
                    报告
                  </a>
                ) : null}
              </label>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-stone-200 px-4 py-10 text-center text-sm text-stone-400">
            当前文件还没有已写入项目的自动化脚本。
          </div>
        )}
        {automationBatch ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-stone-700">运行进度</h3>
            {automationBatch.error ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {automationBatch.error}
              </div>
            ) : null}
            {automationBatch.items.map((item) => (
              <div
                key={item.automationCaseId}
                className="flex items-center justify-between gap-3 rounded-md bg-stone-50 px-3 py-2 text-xs"
              >
                <span className="truncate text-stone-600">{item.automationCaseId}</span>
                <span
                  className={
                    item.status === 'passed'
                      ? 'text-emerald-600'
                      : item.status === 'failed'
                        ? 'text-red-600'
                        : 'text-stone-500'
                  }
                >
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </SlideOverDrawer>

      <SlideOverDrawer
        open={drawerOpen}
        onClose={() => {
          void flushAutoSave();
          setDrawerOpen(false);
        }}
        title="用例详情与执行结果"
        widthClass="max-w-3xl"
        escDisabled={false}
        bodyClassName="flex flex-col gap-4 !pb-10"
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
                {caseFieldsBeforeExpected.map(renderCaseField)}
                {actualHeader ? (
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
                <div className="space-y-3 border-t border-stone-100 pt-4 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-stone-700">执行信息</h3>
                    <span className="text-[11px] text-stone-400">修改后自动保存到文件</span>
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
                {caseFieldsAfterExpected.map(renderCaseField)}
                <DefectInfoEditor
                  title={defectTitle}
                  values={defectUrls}
                  disabled={caseControlsDisabled}
                  onTitleChange={(value) => {
                    setDefectTitle(value);
                    queueFieldSave(defectTitleHeader, value);
                  }}
                  onChange={(values) => {
                    setDefectUrls(values);
                    queueFieldSave(defectUrlHeader, values.filter((v) => v.trim()).join('\n'));
                  }}
                  onBlur={() => void flushAutoSave()}
                />
              </div>
            </div>
            {activeCase.automation?.items?.length ? (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-stone-700">自动化关联</h3>
                {activeCase.automation.items.map((item) => (
                  <div
                    key={item.automationCaseId}
                    className="rounded-lg border border-stone-200 px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-stone-800">{item.title}</span>
                      <span className="text-[11px] text-stone-400">{item.iteration}</span>
                    </div>
                    <div className="mt-1 text-xs text-stone-500">
                      {item.projectName || item.projectId}
                      {item.iterationFile ? ` · ${item.iterationFile}` : ''}
                    </div>
                    {item.error ? <p className="mt-1 text-xs text-red-600">{item.error}</p> : null}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                      <span>{AUTOMATION_LABEL[item.status] || item.status}</span>
                      {item.logUrl ? (
                        <a
                          href={item.logUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#4176e6]"
                        >
                          查看日志
                        </a>
                      ) : null}
                      {item.reportUrl ? (
                        <a
                          href={item.reportUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#4176e6]"
                        >
                          查看报告
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {resultStatus === '不通过' || resultStatus === '阻塞' ? (
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
    </>
  );
}
