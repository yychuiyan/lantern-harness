import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  DialogDescription,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
} from '@headlessui/react';

import {
  BusinessMapApiError,
  createBusinessDirectory,
  createBusinessFlow,
  createBusinessFunction,
  createBusinessMapDemo,
  createBusinessSystem,
  copyBusinessSystem,
  deleteBusinessFlow,
  deleteBusinessDirectory,
  deleteBusinessFunction,
  deleteBusinessSystem,
  functionFlowRefs,
  loadBusinessMap,
  moveBusinessTreeNode,
  normalizeStep,
  pickBusinessSourceDirectory,
  renumberBusinessSteps,
  insertBusinessStep,
  participantSystems,
  updateBusinessFlow,
  updateBusinessDirectory,
  updateBusinessFunction,
  updateBusinessSystem,
  type BusinessFlow,
  type BusinessFlowStep,
  type BusinessDirectory,
  type BusinessFunction,
  type BusinessEvidence,
  type BusinessLoginCopyMode,
  type BusinessMapStore,
  type BusinessSystem,
} from '../../lib/business-map';
import BusinessMapAssistantDialog from './BusinessMapAssistantDialog';
import BusinessFlowDiagram from './BusinessFlowDiagram';
import {
  loadBusinessMenuOutline,
  type BusinessMenuOutline,
} from '../../lib/business-map-assistant';
import type { BusinessFlowLaneMode } from '../../lib/business-flow-diagram';
import BusinessMapLoginSettings, {
  type BusinessLoginSettingsHandle,
} from './BusinessMapLoginSettings';
import BusinessMapSystems from './BusinessMapSystems';
import BusinessMapFunctionTree, { directoryPath } from './BusinessMapFunctionTree';
import SelectDropdown from './SelectDropdown';
import OverflowHint from './OverflowHint';
import {
  businessDirectoryUsesDropdown,
  businessPromotedFunctionIds,
  type BusinessFunctionFilter,
} from '../../lib/business-map-view';
import {
  readBusinessMapMemory,
  writeBusinessMapMemory,
  type BusinessMapDetailTab,
  type BusinessMapMainView,
  type BusinessMapMenuKind,
} from '../../lib/business-map-memory';
import { readViewText, writeViewText } from '../../lib/view-prefs';
import ConfirmDialog from './ConfirmDialog';
import { PmIcon } from './PmShared';
import { showToast } from './Toast';

type MainView = BusinessMapMainView;
type DetailTab = BusinessMapDetailTab;

interface FunctionDraft {
  id: string;
  code: string;
  name: string;
  directoryId: string;
  order: number;
  domain: string;
  module: string;
  status: BusinessFunction['status'];
  purpose: string;
  roles: string;
  entry: string;
  inputs: string;
  outputs: string;
  rules: string;
  writes: string;
  exceptions: string;
  implementation: string;
  evidenceText: string;
}

interface SystemDraft {
  name: string;
  description: string;
  entryUrl: string;
  sourceDir: string;
}

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
}

function useAnimatedPresence(open: boolean, duration = 180) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      timerRef.current = null;
    }, duration);
  }, [duration, mounted, open]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return { mounted, closing };
}

const EMPTY_SYSTEM: SystemDraft = {
  name: '',
  description: '',
  entryUrl: '',
  sourceDir: '',
};

const BUSINESS_CONTEXT_MIN_WIDTH = 260;
const BUSINESS_CONTEXT_MAX_WIDTH = 460;
const BUSINESS_CONTEXT_DEFAULT_WIDTH = 320;
const BUSINESS_CONTEXT_WIDTH_KEY = 'business-map.context-width';

function clampBusinessContextWidth(value: number) {
  return Math.min(
    BUSINESS_CONTEXT_MAX_WIDTH,
    Math.max(BUSINESS_CONTEXT_MIN_WIDTH, Math.round(value)),
  );
}

function readBusinessContextWidth() {
  const saved = Number(readViewText(BUSINESS_CONTEXT_WIDTH_KEY));
  return Number.isFinite(saved) && saved > 0
    ? clampBusinessContextWidth(saved)
    : BUSINESS_CONTEXT_DEFAULT_WIDTH;
}

const EMPTY_FUNCTION: FunctionDraft = {
  id: '',
  code: '',
  name: '',
  directoryId: '',
  order: 0,
  domain: '受理域',
  module: '未归类',
  status: '在用',
  purpose: '',
  roles: '',
  entry: '',
  inputs: '',
  outputs: '',
  rules: '',
  writes: '',
  exceptions: '',
  implementation: '',
  evidenceText: '',
};

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joins(value: string[] | undefined): string {
  return (value || []).join('\n');
}

function functionToDraft(item: BusinessFunction): FunctionDraft {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    directoryId: item.directoryId,
    order: item.order,
    domain: item.domain,
    module: item.module,
    status: item.status,
    purpose: item.purpose,
    roles: joins(item.roles),
    entry: item.entry,
    inputs: joins(item.inputs),
    outputs: joins(item.outputs),
    rules: joins(item.rules),
    writes: joins(item.writes),
    exceptions: joins(item.exceptions),
    implementation: joins(item.implementation),
    evidenceText: item.evidence
      .map((evidence) => `${evidence.type}|${evidence.title}|${evidence.ref}`)
      .join('\n'),
  };
}

function draftToEvidence(value: string, original: BusinessEvidence[] = []): BusinessEvidence[] {
  return lines(value).map((line) => {
    const [rawType, rawTitle, rawRef] = line.split('|').map((item) => item.trim());
    const type = (
      ['page', 'doc', 'code', 'manual'].includes(rawType) ? rawType : 'manual'
    ) as BusinessEvidence['type'];
    const title = rawTitle || rawRef || line;
    const existing = original.find(
      (item) => item.type === type && item.title === title && item.ref === (rawRef || ''),
    );
    if (existing) return existing;
    return {
      id: '',
      type,
      title,
      ref: rawRef || '',
      note: '',
      confidence: type === 'manual' ? 'medium' : 'high',
    };
  });
}

function draftToFunction(
  draft: FunctionDraft,
  original?: BusinessFunction | null,
): Partial<BusinessFunction> {
  return {
    code: draft.code,
    name: draft.name,
    directoryId: draft.directoryId,
    order: draft.order,
    domain: draft.domain,
    module: draft.module,
    status: draft.status,
    purpose: draft.purpose,
    roles: lines(draft.roles),
    entry: draft.entry,
    inputs: lines(draft.inputs),
    outputs: lines(draft.outputs),
    rules: lines(draft.rules),
    writes: lines(draft.writes),
    exceptions: lines(draft.exceptions),
    implementation: lines(draft.implementation),
    evidence: draftToEvidence(draft.evidenceText, original?.evidence),
    confidence: original?.confidence || 'low',
    source: original && original.source !== 'manual' ? 'mixed' : 'manual',
    confirmed: true,
  };
}

function systemToDraft(system: BusinessSystem): SystemDraft {
  return {
    name: system.name,
    description: system.description,
    entryUrl: system.entryUrl,
    sourceDir: system.sourceDir,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceTone(type: string) {
  if (type === 'page') return 'page';
  if (type === 'doc') return 'doc';
  if (type === 'code') return 'code';
  return 'manual';
}

function confidenceLabel(value: BusinessFunction['confidence']) {
  return value === 'high' ? '较高' : value === 'low' ? '待补' : '中等';
}

function flowStatus(flow: BusinessFlow): BusinessFlow['status'] {
  if (!flow.steps.length) return '草稿';
  return flow.steps.some((step) => step.branchBroken || (!step.manual && !step.functionId))
    ? '待补全'
    : '健康';
}

/**
 * 业务地图弹窗。结构对齐平台 ConfirmDialog：Headless UI Dialog 自动 portal 到 body，
 * 并给其余节点加 inert/aria-hidden，天然阻断背景点击与 Tab 逃逸；
 * ESC 关闭、关闭后回焦触发按钮也由 Dialog 负责，这里只管 120ms 淡出后再卸载。
 */
function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  className = '',
  initialFocus,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
  /** 打开时先聚焦的字段；不传则落到面板内第一个可聚焦元素 */
  initialFocus?: MutableRefObject<HTMLElement | null>;
}) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  function requestClose() {
    if (closing) return;
    setClosing(true);
    timerRef.current = window.setTimeout(onClose, 120);
  }

  return (
    <Dialog
      open
      onClose={requestClose}
      initialFocus={initialFocus}
      className="tw-bm-theme relative z-110"
    >
      <DialogBackdrop
        className={`tw-bm-modal-backdrop ${closing ? 'is-closing' : ''}`}
        aria-hidden="true"
      />
      <div className="tw-bm-modal-layer">
        <DialogPanel
          className={`tw-bm-modal ${closing ? 'is-closing' : ''} ${className}`}
          aria-label={title}
        >
          <header className="tw-bm-modal-head">
            <div>
              <DialogTitle as="h2">{title}</DialogTitle>
              {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
            </div>
            <button
              className="tw-bm-icon-btn"
              type="button"
              onClick={requestClose}
              aria-label="关闭"
            >
              ×
            </button>
          </header>
          <div className="tw-bm-modal-body">{children}</div>
          {footer ? (
            <footer
              className="tw-bm-modal-foot"
              onClickCapture={(event) => {
                if ((event.target as HTMLElement).closest('[data-modal-dismiss]')) {
                  event.preventDefault();
                  event.stopPropagation();
                  requestClose();
                }
              }}
            >
              {footer}
            </footer>
          ) : null}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

export default function BusinessMapBoard() {
  const [initialMemory] = useState(() => readBusinessMapMemory());
  const [store, setStore] = useState<BusinessMapStore | null>(null);
  const [menuNavigation, setMenuNavigation] = useState<BusinessMenuOutline['navigation']>([]);
  const [systemId, setSystemId] = useState(initialMemory?.systemId || '');
  const [systemQuery, setSystemQuery] = useState(initialMemory?.systemQuery || '');
  const [view, setView] = useState<MainView>(initialMemory?.view || 'functions');
  const [query, setQuery] = useState(initialMemory?.query || '');
  const [domain, setDomain] = useState(initialMemory?.domain || '全部');
  const [functionFilter, setFunctionFilter] = useState<BusinessFunctionFilter>(
    initialMemory?.functionFilter || 'all',
  );
  const [selectedFunctionId, setSelectedFunctionId] = useState(
    initialMemory?.selectedFunctionId || '',
  );
  const [selectedDirectoryId, setSelectedDirectoryId] = useState(
    initialMemory?.selectedDirectoryId || '',
  );
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(() => new Set());
  const [selectedFlowId, setSelectedFlowId] = useState(initialMemory?.selectedFlowId || '');
  const [selectedStepId, setSelectedStepId] = useState(initialMemory?.selectedStepId || '');
  const [detailTab, setDetailTab] = useState<DetailTab>(initialMemory?.detailTab || 'overview');
  const [contextWidth, setContextWidth] = useState(readBusinessContextWidth);
  const [contextResizing, setContextResizing] = useState(false);
  const [detailOpen, setDetailOpen] = useState(() => {
    if (initialMemory?.view === 'flows') return false;
    return initialMemory?.detailOpen ?? (typeof window === 'undefined' || window.innerWidth > 1120);
  });
  const [selectedMenuKind, setSelectedMenuKind] = useState<BusinessMapMenuKind>(
    () => initialMemory?.selectedMenuKind || 'directory',
  );
  const [functionDraft, setFunctionDraft] = useState<FunctionDraft | null>(null);
  const [functionIsNew, setFunctionIsNew] = useState(false);
  const [directoryEditor, setDirectoryEditor] = useState<{
    mode: 'create' | 'rename';
    id: string;
    parentId: string;
    name: string;
  } | null>(null);
  const [stepDraft, setStepDraft] = useState<BusinessFlowStep | null>(null);
  const [busy, setBusy] = useState('');
  const [fatal, setFatal] = useState('');
  const [systemModal, setSystemModal] = useState<'create' | 'edit' | null>(null);
  const [copyTargetId, setCopyTargetId] = useState('');
  const [loginCopyMode, setLoginCopyMode] = useState<BusinessLoginCopyMode>('configuration');
  const [settingsSystemId, setSettingsSystemId] = useState('');
  const [systemDraft, setSystemDraft] = useState<SystemDraft>(EMPTY_SYSTEM);
  const [systemNameError, setSystemNameError] = useState('');
  const [sourceDirError, setSourceDirError] = useState('');
  const [pickingSourceDir, setPickingSourceDir] = useState(false);
  const systemNameRef = useRef<HTMLInputElement | null>(null);
  const flowNameRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [flowModal, setFlowModal] = useState(false);
  const [flowEditing, setFlowEditing] = useState(false);
  const [flowDraft, setFlowDraft] = useState({ name: '', result: '' });
  const [flowLaneMode, setFlowLaneMode] = useState<BusinessFlowLaneMode>('system');
  const [aiOpen, setAiOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [functionScrollRequest, setFunctionScrollRequest] = useState(0);
  const aiPresence = useAnimatedPresence(aiOpen);
  const detailPresence = useAnimatedPresence(detailOpen);
  const mainBodyRef = useRef<HTMLDivElement | null>(null);
  const contextResizeRef = useRef<{
    startX: number;
    startWidth: number;
    currentWidth: number;
  } | null>(null);

  const currentSystem = useMemo(
    () => store?.systems.find((item) => item.id === systemId) || null,
    [store, systemId],
  );
  const settingsSystem = store?.systems.find((item) => item.id === settingsSystemId) || null;
  const copyTargetSystem = store?.systems.find((item) => item.id === copyTargetId) || null;
  const filteredFlows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (currentSystem?.flows || []).filter((item) =>
      term ? [item.code, item.name, item.result].join(' ').toLowerCase().includes(term) : true,
    );
  }, [currentSystem, query]);
  const currentFunction = useMemo(
    () => currentSystem?.functions.find((item) => item.id === selectedFunctionId) || null,
    [currentSystem, selectedFunctionId],
  );
  const promotedFunctionIds = useMemo(
    () =>
      currentSystem
        ? businessPromotedFunctionIds(
            currentSystem.directories,
            currentSystem.functions,
            menuNavigation,
          )
        : new Set<string>(),
    [currentSystem, menuNavigation],
  );
  const selectedRootFunction =
    currentFunction && promotedFunctionIds.has(currentFunction.id) ? currentFunction : null;
  const currentFunctionDirectoryPath = useMemo(
    () =>
      currentSystem && currentFunction?.directoryId
        ? directoryPath(currentSystem.directories, currentFunction.directoryId)
        : [],
    [currentFunction, currentSystem],
  );
  const selectedDirectory = useMemo(
    () => currentSystem?.directories.find((item) => item.id === selectedDirectoryId) || null,
    [currentSystem, selectedDirectoryId],
  );
  const selectedDirectoryPath = useMemo(
    () =>
      currentSystem && selectedDirectoryId
        ? directoryPath(currentSystem.directories, selectedDirectoryId)
        : [],
    [currentSystem, selectedDirectoryId],
  );
  const selectedDirectoryChildren = useMemo(
    () =>
      (currentSystem?.directories || [])
        .filter((item) => item.parentId === selectedDirectoryId)
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name)),
    [currentSystem, selectedDirectoryId],
  );
  const selectedDirectoryFunctions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (currentSystem?.functions || [])
      .filter((item) => item.directoryId === selectedDirectoryId)
      .filter((item) =>
        term
          ? [item.code, item.name, item.purpose, item.entry].join(' ').toLowerCase().includes(term)
          : true,
      )
      .sort((left, right) => left.order - right.order || left.code.localeCompare(right.code));
  }, [currentSystem, query, selectedDirectoryId]);
  const currentFlow = useMemo(() => {
    const candidates = view === 'flows' ? filteredFlows : currentSystem?.flows || [];
    return candidates.find((item) => item.id === selectedFlowId) || candidates[0] || null;
  }, [currentSystem, filteredFlows, selectedFlowId, view]);
  const currentStep = useMemo(
    () =>
      (selectedStepId
        ? currentFlow?.steps.find((item) => item.id === selectedStepId)
        : currentFlow?.steps[0]) || null,
    [currentFlow, selectedStepId],
  );

  useEffect(() => {
    let alive = true;
    void loadBusinessMap()
      .then((loaded) => {
        if (!alive) return;
        setStore(loaded);
        const rememberedSystem = loaded.systems.find((item) => item.id === initialMemory?.systemId);
        setSystemId(rememberedSystem?.id || '');
        if (!rememberedSystem) {
          setSelectedFunctionId('');
          setSelectedFlowId('');
          setSelectedStepId('');
          return;
        }
        setSelectedFunctionId(
          rememberedSystem.functions.some((item) => item.id === initialMemory?.selectedFunctionId)
            ? initialMemory?.selectedFunctionId || ''
            : rememberedSystem.functions[0]?.id || '',
        );
        const restoredDirectoryId = rememberedSystem.directories?.some(
          (item) => item.id === initialMemory?.selectedDirectoryId,
        )
          ? initialMemory?.selectedDirectoryId || ''
          : rememberedSystem.directories?.find((item) => !item.parentId)?.id || '';
        setSelectedDirectoryId(restoredDirectoryId);
        setExpandedDirectoryIds(
          new Set(
            directoryPath(rememberedSystem.directories, restoredDirectoryId)
              .filter((directory) =>
                businessDirectoryUsesDropdown(
                  directory,
                  rememberedSystem.directories,
                  rememberedSystem.functions,
                ),
              )
              .map((directory) => directory.id),
          ),
        );
        const rememberedFlow = rememberedSystem.flows.find(
          (item) => item.id === initialMemory?.selectedFlowId,
        );
        const restoredFlow = rememberedFlow || rememberedSystem.flows[0];
        setSelectedFlowId(restoredFlow?.id || '');
        setSelectedStepId(
          restoredFlow?.steps.some((item) => item.id === initialMemory?.selectedStepId)
            ? initialMemory?.selectedStepId || ''
            : restoredFlow?.steps[0]?.id || '',
        );
      })
      .catch((error) => setFatal(errorMessage(error)))
      .finally(() => {
        if (alive) setBusy('');
      });
    return () => {
      alive = false;
    };
  }, [initialMemory]);

  useEffect(() => {
    if (!store) return;
    writeBusinessMapMemory({
      systemId,
      view,
      systemQuery,
      query,
      domain,
      functionFilter,
      selectedFunctionId,
      selectedDirectoryId,
      selectedMenuKind,
      selectedFlowId,
      selectedStepId,
      detailTab,
      detailOpen,
    });
  }, [
    detailOpen,
    detailTab,
    domain,
    functionFilter,
    query,
    selectedFlowId,
    selectedDirectoryId,
    selectedMenuKind,
    selectedFunctionId,
    selectedStepId,
    store,
    systemId,
    systemQuery,
    view,
  ]);

  useEffect(() => {
    let alive = true;
    setMenuNavigation([]);
    if (!systemId)
      return () => {
        alive = false;
      };
    void loadBusinessMenuOutline(systemId)
      .then((outline) => {
        if (alive) setMenuNavigation(outline.navigation);
      })
      .catch(() => {
        if (alive) setMenuNavigation([]);
      });
    return () => {
      alive = false;
    };
  }, [systemId]);

  useEffect(() => {
    if (!currentSystem) return;
    if (
      selectedFunctionId &&
      !currentSystem.functions.some((item) => item.id === selectedFunctionId)
    ) {
      setSelectedFunctionId(currentSystem.functions[0]?.id || '');
    }
    if (!currentSystem.flows.some((item) => item.id === selectedFlowId)) {
      setSelectedFlowId(currentSystem.flows[0]?.id || '');
    }
    if (
      selectedDirectoryId &&
      !currentSystem.directories.some((item) => item.id === selectedDirectoryId)
    ) {
      setSelectedDirectoryId(currentSystem.directories.find((item) => !item.parentId)?.id || '');
    }
  }, [currentSystem, selectedDirectoryId, selectedFlowId, selectedFunctionId]);

  useEffect(() => {
    if (!currentFlow) {
      setSelectedStepId('');
      setStepDraft(null);
      return;
    }
    // 新增步骤尚未落盘，不得回退到首步骤并覆盖正在编辑的草稿。
    if (
      selectedStepId.startsWith('temp_') &&
      !currentFlow.steps.some((step) => step.id === selectedStepId)
    )
      return;
    const step =
      currentFlow.steps.find((item) => item.id === selectedStepId) || currentFlow.steps[0] || null;
    setSelectedStepId(step?.id || '');
    setStepDraft(step ? { ...step, dependencies: [...step.dependencies] } : null);
  }, [currentFlow, selectedStepId]);

  const filteredFunctions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (currentSystem?.functions || [])
      .filter((item) => !selectedDirectoryId || item.directoryId === selectedDirectoryId)
      .filter((item) =>
        term
          ? [item.code, item.name, item.purpose, item.entry].join(' ').toLowerCase().includes(term)
          : true,
      );
  }, [currentSystem, query, selectedDirectoryId]);
  useEffect(() => {
    if (view !== 'functions' || functionDraft) return;
    if (selectedRootFunction) return;
    if (!filteredFunctions.some((item) => item.id === selectedFunctionId))
      setSelectedFunctionId(filteredFunctions[0]?.id || '');
  }, [filteredFunctions, functionDraft, selectedFunctionId, selectedRootFunction, view]);

  useEffect(() => {
    if (!functionScrollRequest || view !== 'functions' || !selectedFunctionId) return;
    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        const container = mainBodyRef.current;
        const card = Array.from(
          container?.querySelectorAll<HTMLElement>('[data-business-function-card]') || [],
        ).find((item) => item.dataset.businessFunctionCard === selectedFunctionId);
        if (!container || !card) return;
        const containerRect = container.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const visibleTop = containerRect.top + 12;
        const visibleBottom = containerRect.bottom - 12;
        if (cardRect.top >= visibleTop && cardRect.bottom <= visibleBottom) return;
        const centeredTop =
          container.scrollTop +
          cardRect.top -
          containerRect.top -
          Math.max(12, (container.clientHeight - cardRect.height) / 2);
        container.scrollTo({ top: Math.max(0, centeredTop), behavior: 'smooth' });
      });
    });
    return () => {
      cancelAnimationFrame(outerFrame);
      if (innerFrame) cancelAnimationFrame(innerFrame);
    };
  }, [functionScrollRequest, selectedFunctionId, view]);

  function showFunctions(filter: BusinessFunctionFilter = 'all', nextDomain = '全部') {
    setFunctionFilter(filter);
    setDomain(nextDomain);
    setQuery('');
    setView('functions');
    setDetailOpen(window.innerWidth > 1120);
  }

  function showFlows(id?: string) {
    setQuery('');
    setView('flows');
    const flow = currentSystem?.flows.find((item) => item.id === id) || currentSystem?.flows[0];
    setSelectedFlowId(flow?.id || '');
    setSelectedStepId(flow?.steps[0]?.id || '');
    setDetailOpen(false);
  }

  function applyStore(next: BusinessMapStore, nextSystemId = systemId) {
    setStore(next);
    const target = nextSystemId
      ? next.systems.find((item) => item.id === nextSystemId) || null
      : null;
    setSystemId(target?.id || '');
    if (target && !target.functions.some((item) => item.id === selectedFunctionId)) {
      setSelectedFunctionId(target.functions[0]?.id || '');
    }
    if (
      target &&
      selectedDirectoryId &&
      !target.directories.some((item) => item.id === selectedDirectoryId)
    ) {
      setSelectedDirectoryId(target.directories.find((item) => !item.parentId)?.id || '');
    }
    if (target && !target.flows.some((item) => item.id === selectedFlowId)) {
      setSelectedFlowId(target.flows[0]?.id || '');
    }
  }

  async function execute(label: string, action: () => Promise<void> | void) {
    if (busy) return;
    setBusy(label);
    try {
      await action();
    } catch (error) {
      if (error instanceof BusinessMapApiError && error.code === 'revision_conflict') {
        const latest = await loadBusinessMap().catch(() => null);
        if (latest) setStore(latest);
        showToast('业务地图已被其他页面修改，已刷新到最新版本', 'error');
      } else {
        showToast(errorMessage(error), 'error');
      }
    } finally {
      setBusy('');
    }
  }

  function selectSystem(id: string) {
    const system = store?.systems.find((item) => item.id === id);
    if (!system) return;
    const nextView = view;
    const firstDirectoryId = system.directories.find((item) => !item.parentId)?.id || '';
    setSystemId(id);
    setSelectedFunctionId(system.functions[0]?.id || '');
    setSelectedMenuKind('directory');
    setSelectedDirectoryId(firstDirectoryId);
    setExpandedDirectoryIds(
      new Set(
        directoryPath(system.directories, firstDirectoryId)
          .filter((directory) =>
            businessDirectoryUsesDropdown(directory, system.directories, system.functions),
          )
          .map((directory) => directory.id),
      ),
    );
    setSelectedFlowId(system.flows[0]?.id || '');
    setSelectedStepId(system.flows[0]?.steps[0]?.id || '');
    setFunctionDraft(null);
    setStepDraft(null);
    setQuery('');
    setDomain('全部');
    setView(nextView);
    setFunctionFilter('all');
    setDetailOpen(nextView === 'functions' && window.innerWidth > 1120);
  }

  function openCreateSystem() {
    setSystemDraft(EMPTY_SYSTEM);
    setSystemNameError('');
    setSourceDirError('');
    setSystemModal('create');
  }

  function openSystemSettings(id: string) {
    const target = store?.systems.find((item) => item.id === id);
    if (!target) return;
    setSettingsSystemId(id);
    setSystemDraft(systemToDraft(target));
    setSystemNameError('');
    setSourceDirError('');
    setSystemModal('edit');
  }

  async function browseSourceDir() {
    setSourceDirError('');
    setPickingSourceDir(true);
    try {
      const dir = await pickBusinessSourceDirectory();
      if (dir) setSystemDraft((current) => ({ ...current, sourceDir: dir }));
    } catch (error) {
      setSourceDirError(errorMessage(error));
    } finally {
      setPickingSourceDir(false);
    }
  }

  const loginSettingsRef = useRef<BusinessLoginSettingsHandle>(null);

  function saveSystem() {
    if (!store) return;
    if (!systemDraft.name.trim()) {
      setSystemNameError('请输入系统名称');
      systemNameRef.current?.focus();
      return;
    }
    setSystemNameError('');
    void execute('保存系统', async () => {
      if (systemModal === 'create') {
        const result = await createBusinessSystem(store.revision, {
          ...systemDraft,
          docs: { requirements: true, knowledge: true, scope: '当前系统关联文档' },
        });
        applyStore(result.store, result.systemId);
        setView('functions');
        setFunctionFilter('all');
        setQuery('');
        setDomain('全部');
        setDetailOpen(window.innerWidth > 1120);
        const created = result.store.systems.find((item) => item.id === result.systemId);
        if (created) {
          setSelectedFunctionId(created.functions[0]?.id || '');
          setSelectedDirectoryId(created.directories.find((item) => !item.parentId)?.id || '');
          setSelectedFlowId(created.flows[0]?.id || '');
        }
        showToast('业务系统已创建', 'success');
      } else if (settingsSystem) {
        await loginSettingsRef.current?.save();
        const next = await updateBusinessSystem(store.revision, settingsSystem.id, systemDraft);
        applyStore(next);
        showToast('系统设置已保存', 'success');
      }
      setSystemModal(null);
    });
  }

  function removeSystem() {
    if (!store || !settingsSystem) return;
    const id = settingsSystem.id;
    const name = settingsSystem.name;
    setSystemModal(null);
    setConfirm({
      title: '删除业务系统',
      message: `将删除「${name}」及其全部功能、流程和待审核提案。此操作无法撤销。`,
      confirmLabel: '删除系统',
      danger: true,
      onConfirm: async () => {
        const next = await deleteBusinessSystem(store.revision, id);
        applyStore(next, '');
        setSystemModal(null);
        showToast('业务系统已删除', 'success');
      },
    });
  }

  function selectFunction(id: string) {
    const fn = currentSystem?.functions.find((item) => item.id === id);
    const promoted =
      currentSystem &&
      businessPromotedFunctionIds(
        currentSystem.directories,
        currentSystem.functions,
        menuNavigation,
      ).has(id);
    setSelectedFunctionId(id);
    setSelectedMenuKind('function');
    if (fn?.directoryId && !promoted) {
      setFunctionScrollRequest((current) => current + 1);
      setSelectedDirectoryId(fn.directoryId);
      setExpandedDirectoryIds((current) => {
        const next = new Set(current);
        for (const directory of directoryPath(currentSystem?.directories || [], fn.directoryId))
          next.add(directory.id);
        return next;
      });
    } else {
      setSelectedDirectoryId('');
    }
    setFunctionDraft(null);
    setDetailTab('overview');
    setDetailOpen(true);
  }

  function openCreateDirectory(parentId = '') {
    setDirectoryEditor({ mode: 'create', id: '', parentId, name: '' });
  }

  function toggleDirectory(id: string) {
    setExpandedDirectoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openRenameDirectory(directory: BusinessDirectory) {
    setDirectoryEditor({
      mode: 'rename',
      id: directory.id,
      parentId: directory.parentId,
      name: directory.name,
    });
  }

  function saveDirectory() {
    if (!store || !currentSystem || !directoryEditor) return;
    const name = directoryEditor.name.trim();
    if (!name) {
      showToast('目录名称不能为空', 'error');
      return;
    }
    void execute('保存目录', async () => {
      if (directoryEditor.mode === 'create') {
        const result = await createBusinessDirectory(store.revision, currentSystem.id, {
          name,
          parentId: directoryEditor.parentId,
        });
        applyStore(result.store, currentSystem.id);
        setSelectedDirectoryId(result.item.id);
        if (directoryEditor.parentId)
          setExpandedDirectoryIds(
            (current) => new Set([...current, directoryEditor.parentId, result.item.id]),
          );
        showToast('功能目录已新建', 'success');
      } else {
        const result = await updateBusinessDirectory(
          store.revision,
          currentSystem.id,
          directoryEditor.id,
          { name },
        );
        applyStore(result.store, currentSystem.id);
        showToast('目录名称已更新', 'success');
      }
      setDirectoryEditor(null);
    });
  }

  function moveTreeNode(move: {
    kind: 'directory' | 'function';
    id: string;
    parentId: string;
    beforeId?: string;
    rootMenu?: boolean;
    menuOrder?: number;
  }) {
    if (!store || !currentSystem) return;
    void execute('移动目录节点', async () => {
      const next = await moveBusinessTreeNode(store.revision, currentSystem.id, move);
      applyStore(next, currentSystem.id);
      if (move.parentId) setExpandedDirectoryIds((current) => new Set([...current, move.parentId]));
      showToast('目录结构已更新', 'success');
    });
  }

  function unlockFunctionMenu(fn: BusinessFunction) {
    if (!store || !currentSystem) return;
    void execute('恢复自动菜单归属', async () => {
      const next = await moveBusinessTreeNode(store.revision, currentSystem.id, {
        kind: 'function',
        id: fn.id,
        parentId: fn.directoryId,
        unlockMenu: true,
      });
      applyStore(next, currentSystem.id);
      showToast('已恢复自动菜单归属', 'success');
    });
  }

  function removeDirectory(directory: BusinessDirectory) {
    if (!store || !currentSystem) return;
    const descendantIds = new Set<string>([directory.id]);
    const queue = [directory.id];
    while (queue.length) {
      const parentId = queue.shift();
      for (const item of currentSystem.directories) {
        if (item.parentId === parentId && !descendantIds.has(item.id)) {
          descendantIds.add(item.id);
          queue.push(item.id);
        }
      }
    }
    const affectedFunctions = currentSystem.functions.filter((item) =>
      descendantIds.has(item.directoryId),
    );
    const affectedIds = new Set(affectedFunctions.map((item) => item.id));
    const affectedFlows = currentSystem.flows.filter((flow) =>
      flow.steps.some((step) => affectedIds.has(step.functionId)),
    );
    setConfirm({
      title: '删除功能目录',
      message:
        descendantIds.size === 1 && !affectedFunctions.length
          ? `删除目录「${directory.name}」？`
          : `删除「${directory.name}」将同时删除 ${descendantIds.size} 个目录、${affectedFunctions.length} 个功能；${affectedFlows.length} 条流程中的关联功能会被清空，步骤标题保留。此操作无法撤销。`,
      confirmLabel:
        descendantIds.size > 1 || affectedFunctions.length ? '确认级联删除' : '删除目录',
      danger: true,
      onConfirm: async () => {
        const next = await deleteBusinessDirectory(
          store.revision,
          currentSystem.id,
          directory.id,
          descendantIds.size > 1 || affectedFunctions.length > 0,
        );
        applyStore(next, currentSystem.id);
        setSelectedDirectoryId(directory.parentId || '');
        setSelectedFunctionId('');
        setSelectedMenuKind('directory');
        showToast('功能目录已删除', 'success');
      },
    });
  }

  function startNewFunction(directoryId = selectedDirectoryId) {
    setFunctionFilter('all');
    setQuery('');
    const usedCodes = new Set(currentSystem?.functions.map((item) => item.code));
    let sequence = 1;
    while (usedCodes.has(`F-${String(sequence).padStart(3, '0')}`)) sequence += 1;
    const suggested = `F-${String(sequence).padStart(3, '0')}`;
    const targetDirectory = currentSystem?.directories.find((item) => item.id === directoryId);
    setFunctionIsNew(true);
    setFunctionDraft({
      ...EMPTY_FUNCTION,
      code: suggested,
      directoryId,
      domain: targetDirectory?.name || '未归类',
      module: targetDirectory?.name || '未归类',
    });
    setView('functions');
    setDetailTab('overview');
    setDetailOpen(true);
  }

  function editCurrentFunction() {
    if (!currentFunction) return;
    setFunctionIsNew(false);
    setFunctionDraft(functionToDraft(currentFunction));
    setDetailOpen(true);
  }

  function saveFunctionDraft() {
    if (!store || !currentSystem || !functionDraft) return;
    if (!functionDraft.name.trim()) {
      showToast('功能名称不能为空', 'error');
      return;
    }
    void execute('保存功能', async () => {
      const payload = draftToFunction(functionDraft, functionIsNew ? null : currentFunction);
      if (functionIsNew) {
        const result = await createBusinessFunction(store.revision, currentSystem.id, {
          ...payload,
          menuRoot: !functionDraft.directoryId,
        });
        applyStore(result.store, currentSystem.id);
        setSelectedFunctionId(result.item.id);
        setSelectedMenuKind('function');
        setExpandedDirectoryIds((current) => new Set([...current, functionDraft.directoryId]));
        showToast('功能已新建', 'success');
      } else if (currentFunction) {
        const result = await updateBusinessFunction(
          store.revision,
          currentSystem.id,
          currentFunction.id,
          payload,
        );
        applyStore(result.store, currentSystem.id);
        setSelectedFunctionId(result.item.id);
        setSelectedMenuKind('function');
        showToast('功能已保存，相关字段已标记为人工确认', 'success');
      }
      setFunctionDraft(null);
    });
  }

  function removeCurrentFunction() {
    if (!store || !currentSystem || !currentFunction) return;
    const id = currentFunction.id;
    const name = currentFunction.name;
    setConfirm({
      title: '删除菜单',
      message: `删除菜单「${name}」后，流程中引用它的步骤会变为未关联。`,
      confirmLabel: '删除菜单',
      danger: true,
      onConfirm: async () => {
        const next = await deleteBusinessFunction(store.revision, currentSystem.id, id);
        applyStore(next, currentSystem.id);
        setFunctionDraft(null);
        setSelectedFunctionId('');
        setSelectedMenuKind('directory');
        showToast('功能已删除', 'success');
      },
    });
  }

  function removeSelectedMenu() {
    if (selectedMenuKind === 'function' && currentFunction) {
      removeCurrentFunction();
      return;
    }
    if (selectedDirectory) removeDirectory(selectedDirectory);
  }

  function openFlowModal(editing = false) {
    setFlowEditing(editing);
    setFlowDraft(
      editing && currentFlow
        ? { name: currentFlow.name, result: currentFlow.result }
        : { name: '', result: '' },
    );
    setFlowModal(true);
  }

  function createFlow() {
    if (!store || !currentSystem) return;
    if (!flowDraft.name.trim()) {
      showToast('请填写流程名称', 'error');
      return;
    }
    void execute('保存流程', async () => {
      if (flowEditing && currentFlow) {
        const result = await updateBusinessFlow(
          store.revision,
          currentSystem.id,
          currentFlow.id,
          flowDraft,
        );
        applyStore(result.store, currentSystem.id);
        setFlowModal(false);
        showToast('流程设置已保存', 'success');
        return;
      }
      const result = await createBusinessFlow(store.revision, currentSystem.id, {
        name: flowDraft.name,
        result: flowDraft.result,
        steps: [],
      });
      applyStore(result.store, currentSystem.id);
      setView('flows');
      setSelectedFlowId(result.item.id);
      setFlowModal(false);
      showToast('流程已创建，请添加步骤', 'success');
    });
  }

  function saveStepDraft() {
    if (!store || !currentSystem || !currentFlow || !stepDraft) return;
    if (!stepDraft.title.trim()) {
      showToast('步骤名称不能为空', 'error');
      return;
    }
    void execute('保存步骤', async () => {
      const normalized = currentFlow.steps.some((item) => item.id === stepDraft.id)
        ? currentFlow.steps.map((item) => (item.id === stepDraft.id ? stepDraft : item))
        : insertBusinessStep(currentFlow.steps, stepDraft);
      const result = await updateBusinessFlow(store.revision, currentSystem.id, currentFlow.id, {
        steps: normalized,
        status: normalized.some((item) => item.branchBroken) ? '待补全' : '健康',
      });
      applyStore(result.store, currentSystem.id);
      setSelectedStepId(stepDraft.id);
      showToast('流程步骤已保存', 'success');
    });
  }

  function addStep(afterStepId?: string) {
    if (!currentFlow) {
      showToast('请先新建一条流程', 'error');
      return;
    }
    const position = afterStepId
      ? currentFlow.steps.findIndex((step) => step.id === afterStepId) + 1
      : currentFlow.steps.length;
    const step = normalizeStep(
      {
        id: `temp_${Date.now().toString(36)}`,
        n: position + 1,
        title: '新步骤',
        role: '待填写',
        system: currentSystem?.name || '',
        functionId: currentSystem?.functions[0]?.id || '',
        input: '',
        output: '',
        next: currentFlow.steps[position] ? String(currentFlow.steps[position].n) : '结束',
        branch: '',
        dependencies: [],
        evidence: [],
      },
      position,
    );
    setDetailOpen(true);
    setStepDraft(step);
    setSelectedStepId(step.id);
  }

  function moveStep(direction: -1 | 1) {
    if (!store || !currentSystem || !currentFlow || !stepDraft) return;
    const index = currentFlow.steps.findIndex((item) => item.id === stepDraft.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= currentFlow.steps.length) return;
    const steps = currentFlow.steps.map((step) => (step.id === stepDraft.id ? stepDraft : step));
    [steps[index], steps[target]] = [steps[target], steps[index]];
    const normalized = renumberBusinessSteps(currentFlow.steps, steps);
    void execute('调整步骤顺序', async () => {
      const result = await updateBusinessFlow(store.revision, currentSystem.id, currentFlow.id, {
        steps: normalized,
      });
      applyStore(result.store, currentSystem.id);
      showToast('步骤顺序已更新', 'success');
    });
  }

  function removeStep() {
    if (!store || !currentSystem || !currentFlow || !stepDraft) return;
    const flow = currentFlow;
    const step = stepDraft;
    setConfirm({
      title: '删除流程步骤',
      message: `删除第 ${step.n} 步「${step.title}」？后续步骤会自动重新编号。`,
      confirmLabel: '删除步骤',
      danger: true,
      onConfirm: async () => {
        const steps = renumberBusinessSteps(
          flow.steps,
          flow.steps.filter((item) => item.id !== step.id),
        );
        const result = await updateBusinessFlow(store.revision, currentSystem.id, flow.id, {
          steps,
          status: steps.some((item) => item.branchBroken) ? '待补全' : '健康',
        });
        applyStore(result.store, currentSystem.id);
        setSelectedStepId(steps[0]?.id || '');
        showToast('流程步骤已删除', 'success');
      },
    });
  }

  function removeCurrentFlow() {
    if (!store || !currentSystem || !currentFlow) return;
    const flow = currentFlow;
    setConfirm({
      title: '删除业务流程',
      message: `将删除「${flow.name}」及其全部步骤。功能不会被删除。`,
      confirmLabel: '删除流程',
      danger: true,
      onConfirm: async () => {
        const next = await deleteBusinessFlow(store.revision, currentSystem.id, flow.id);
        applyStore(next, currentSystem.id);
        showToast('业务流程已删除', 'success');
      },
    });
  }

  function openAi() {
    if (!currentSystem) {
      showToast('请先创建业务系统', 'error');
      return;
    }
    setAiOpen(true);
  }

  function closeDetail() {
    setDetailOpen(false);
    if (view !== 'flows' || !currentStep) return;
    window.requestAnimationFrame(() => {
      const node = [...document.querySelectorAll<HTMLElement>('[data-flow-step-id]')].find(
        (item) => item.dataset.flowStepId === currentStep.id,
      );
      node?.focus({ preventScroll: true });
    });
  }

  function saveContextWidth(width: number) {
    const next = clampBusinessContextWidth(width);
    setContextWidth(next);
    writeViewText(BUSINESS_CONTEXT_WIDTH_KEY, String(next));
  }

  function startContextResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    contextResizeRef.current = {
      startX: event.clientX,
      startWidth: contextWidth,
      currentWidth: contextWidth,
    };
    setContextResizing(true);
  }

  function moveContextResize(event: ReactPointerEvent<HTMLDivElement>) {
    const start = contextResizeRef.current;
    if (!start) return;
    const next = clampBusinessContextWidth(start.startWidth + event.clientX - start.startX);
    start.currentWidth = next;
    setContextWidth(next);
  }

  function finishContextResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = contextResizeRef.current;
    if (!resize) return;
    contextResizeRef.current = null;
    setContextResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    writeViewText(BUSINESS_CONTEXT_WIDTH_KEY, String(resize.currentWidth));
  }

  function resizeContextByKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    let next = contextWidth;
    if (event.key === 'ArrowLeft') next -= 16;
    else if (event.key === 'ArrowRight') next += 16;
    else if (event.key === 'Home') next = BUSINESS_CONTEXT_MIN_WIDTH;
    else if (event.key === 'End') next = BUSINESS_CONTEXT_MAX_WIDTH;
    else return;
    event.preventDefault();
    saveContextWidth(next);
  }

  if (busy === '加载' || (!store && !fatal)) {
    return (
      <div
        className="tw-bm-loading tw-hydrate-pending"
        role="status"
        aria-busy="true"
        aria-label="正在读取业务地图"
      >
        <div className="tw-bm-loading-heading" />
        <div className="tw-bm-loading-toolbar" />
        <div className="tw-bm-loading-card">
          <div />
          <div />
          <div />
        </div>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="tw-bm-state is-error">
        <strong>业务地图加载失败</strong>
        <p>{fatal}</p>
        <button className="tw-bm-btn primary" type="button" onClick={() => location.reload()}>
          重新加载
        </button>
      </div>
    );
  }

  if (!store) return null;

  if (!currentSystem) {
    return (
      <div className="tw-bm-page tw-bm-redesign">
        <BusinessMapSystems
          systems={store.systems}
          query={systemQuery}
          onQuery={setSystemQuery}
          onSelect={selectSystem}
          onSettings={openSystemSettings}
          onCopy={(id) => {
            setCopyTargetId(id);
            setLoginCopyMode('configuration');
          }}
          onCreate={openCreateSystem}
          busy={!!busy}
          onDemo={() =>
            void execute('创建示例', async () => {
              const result = await createBusinessMapDemo(store.revision);
              applyStore(result.store, result.systemId);
              setView('functions');
              showToast('示例业务地图已创建', 'success');
            })
          }
        />
        {systemModal ? renderSystemModal() : null}
        {copyTargetSystem ? renderCopySystem() : null}
        {confirm ? renderConfirm() : null}
      </div>
    );
  }

  const selectedFunctionRefs = currentFunction
    ? functionFlowRefs(currentSystem, currentFunction.id)
    : [];
  const selectedFunctionRefGroups = [...new Set(selectedFunctionRefs.map((ref) => ref.flow.id))]
    .map((flowId) => {
      const refs = selectedFunctionRefs.filter((ref) => ref.flow.id === flowId);
      return { flow: refs[0]?.flow, steps: refs.map((ref) => ref.step) };
    })
    .filter((group) => Boolean(group.flow));

  function renderSystemModal() {
    return (
      <Modal
        title={systemModal === 'create' ? '新建业务系统' : '系统设置'}
        subtitle="一个业务系统对应一个主要入口和一个源码目录。"
        className="tw-bm-system-modal"
        initialFocus={systemNameRef}
        onClose={() => setSystemModal(null)}
        footer={
          <>
            {systemModal === 'edit' ? (
              <button className="tw-bm-btn danger ghost" type="button" onClick={removeSystem}>
                删除系统
              </button>
            ) : null}
            <span className="spacer" />
            <button
              className="tw-bm-btn"
              type="button"
              data-modal-dismiss
              onClick={() => setSystemModal(null)}
            >
              取消
            </button>
            <button
              className="tw-bm-btn primary"
              type="button"
              disabled={!!busy || pickingSourceDir}
              onClick={saveSystem}
            >
              {systemModal === 'create' ? '创建系统' : '保存设置'}
            </button>
          </>
        }
      >
        <div className="tw-bm-form">
          <div className="tw-bm-field">
            <label htmlFor="bm-system-name">
              系统名称
              <span className="tw-bm-required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id="bm-system-name"
              name="systemName"
              ref={systemNameRef}
              required
              aria-required="true"
              aria-invalid={systemNameError ? true : undefined}
              aria-describedby={systemNameError ? 'bm-system-name-error' : undefined}
              value={systemDraft.name}
              onChange={(event) => {
                setSystemNameError('');
                setSystemDraft({ ...systemDraft, name: event.target.value });
              }}
              placeholder="例如：12345 工单系统"
            />
            {systemNameError ? (
              <p className="tw-bm-field-error" id="bm-system-name-error" role="alert">
                {systemNameError}
              </p>
            ) : null}
          </div>
          <label>
            <span>系统说明</span>
            <textarea
              name="systemDescription"
              rows={3}
              value={systemDraft.description}
              onChange={(event) =>
                setSystemDraft({ ...systemDraft, description: event.target.value })
              }
              placeholder="这个系统主要解决什么业务问题"
            />
          </label>
          <label>
            <span>系统入口</span>
            <input
              name="systemEntryUrl"
              value={systemDraft.entryUrl}
              onChange={(event) => setSystemDraft({ ...systemDraft, entryUrl: event.target.value })}
              placeholder="https://..."
            />
          </label>
          <div className="tw-bm-field">
            <label htmlFor="bm-system-source-dir">本地源码目录</label>
            <div className="tw-bm-path-field">
              <input
                id="bm-system-source-dir"
                name="systemSourceDir"
                value={systemDraft.sourceDir}
                onChange={(event) => {
                  setSourceDirError('');
                  setSystemDraft({ ...systemDraft, sourceDir: event.target.value });
                }}
                placeholder="/repos/work-order"
                spellCheck={false}
                aria-invalid={sourceDirError ? true : undefined}
                aria-describedby={sourceDirError ? 'bm-source-dir-error' : undefined}
              />
              <button
                className="tw-bm-btn"
                type="button"
                disabled={!!busy || pickingSourceDir}
                onClick={() => void browseSourceDir()}
              >
                <PmIcon name="folder" size={14} />
                {pickingSourceDir ? '选择中…' : '浏览…'}
              </button>
            </div>
            {sourceDirError ? (
              <p className="tw-bm-field-error" id="bm-source-dir-error" role="alert">
                {sourceDirError}
              </p>
            ) : null}
          </div>
          <div className="tw-bm-form-note">
            源码目录只会被读取，并忽略 .git、node_modules、构建产物和二进制文件。
          </div>
          {systemModal === 'edit' && settingsSystem ? (
            <BusinessMapLoginSettings
              ref={loginSettingsRef}
              systemId={settingsSystem.id}
              entryChanged={systemDraft.entryUrl !== settingsSystem.entryUrl}
            />
          ) : (
            <p className="tw-bm-form-note">
              创建系统后，可在「系统设置 → 登录配置」维护账号密码、SSO 或手动登录。
            </p>
          )}
        </div>
      </Modal>
    );
  }

  function renderCopySystem() {
    if (!copyTargetSystem || !store) return null;
    const options: Array<{
      value: BusinessLoginCopyMode;
      title: string;
      detail: string;
    }> = [
      {
        value: 'configuration',
        title: '仅复制登录配置',
        detail: '保留登录方式、地址、选择器和 SSO 参数；不复制已保存密码与登录态。',
      },
      {
        value: 'credentials',
        title: '复制登录配置和账号密码',
        detail: '适合创建同一系统的测试副本；仍不会复制 Cookie、浏览器状态或登录成功状态。',
      },
      {
        value: 'none',
        title: '不复制登录配置',
        detail: '副本只保留系统名称、说明、入口、源码目录和文档范围，登录方式保持未配置。',
      },
    ];
    return (
      <Modal
        title="复制业务系统"
        subtitle="只复制系统级配置；功能、流程、证据和历史数据不会复制。"
        className="tw-bm-copy-modal"
        onClose={() => setCopyTargetId('')}
        footer={
          <>
            <button className="tw-bm-btn" type="button" data-modal-dismiss>
              取消
            </button>
            <button
              className="tw-bm-btn primary"
              type="button"
              disabled={!!busy}
              onClick={() => {
                const targetId = copyTargetSystem.id;
                const mode = loginCopyMode;
                setCopyTargetId('');
                void execute('复制系统', async () => {
                  const result = await copyBusinessSystem(store.revision, targetId, mode);
                  applyStore(result.store, '');
                  const loginResult =
                    mode === 'credentials'
                      ? '已复制登录账号密码，未复制登录态'
                      : mode === 'configuration'
                        ? '仅复制登录配置，未复制密码和登录态'
                        : '未复制登录配置';
                  showToast(`系统配置已复制；${loginResult}`, 'success');
                });
              }}
            >
              {busy === '复制系统' ? '正在复制…' : '创建副本'}
            </button>
          </>
        }
      >
        <div className="tw-bm-copy-summary">
          <span>来源系统</span>
          <strong>{copyTargetSystem.name}</strong>
          <small>{copyTargetSystem.entryUrl || '尚未配置系统入口'}</small>
        </div>
        <fieldset className="tw-bm-copy-options">
          <legend>登录配置</legend>
          {options.map((option) => (
            <label
              key={option.value}
              className={`tw-bm-copy-option ${loginCopyMode === option.value ? 'is-selected' : ''}`}
            >
              <input
                type="radio"
                name="loginCopyMode"
                value={option.value}
                checked={loginCopyMode === option.value}
                onChange={() => setLoginCopyMode(option.value)}
              />
              <span>
                <strong>{option.title}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          ))}
        </fieldset>
      </Modal>
    );
  }

  function renderAiDrawer(closing = false) {
    return (
      <BusinessMapAssistantDialog
        system={currentSystem!}
        revision={store!.revision}
        closing={closing}
        onClose={() => setAiOpen(false)}
        onChanged={() => {
          void loadBusinessMap()
            .then((next) => applyStore(next, currentSystem!.id))
            .catch((error) => showToast(errorMessage(error), 'error'));
        }}
        onApplied={() => {
          void loadBusinessMap()
            .then((next) => applyStore(next, currentSystem!.id))
            .catch((error) => showToast(errorMessage(error), 'error'));
        }}
      />
    );
  }

  function renderFlowModal() {
    return (
      <Modal
        title={flowEditing ? '编辑业务流程' : '新建业务流程'}
        subtitle="先填写流程名称和最终结果，步骤可以创建后继续补充。"
        initialFocus={flowNameRef}
        onClose={() => setFlowModal(false)}
        footer={
          <>
            <span className="spacer" />
            <button
              className="tw-bm-btn"
              type="button"
              data-modal-dismiss
              onClick={() => setFlowModal(false)}
            >
              取消
            </button>
            <button
              className="tw-bm-btn primary"
              type="button"
              disabled={!!busy}
              onClick={createFlow}
            >
              {flowEditing ? '保存流程' : '创建流程'}
            </button>
          </>
        }
      >
        <div className="tw-bm-form">
          <label>
            <span>流程名称</span>
            <input
              name="flowName"
              ref={flowNameRef}
              value={flowDraft.name}
              onChange={(event) => setFlowDraft({ ...flowDraft, name: event.target.value })}
              placeholder="例如：投诉受理到派发签收"
            />
          </label>
          <label>
            <span>最终业务结果</span>
            <textarea
              name="flowResult"
              rows={3}
              value={flowDraft.result}
              onChange={(event) => setFlowDraft({ ...flowDraft, result: event.target.value })}
              placeholder="例如：工单状态为已签收，承办单位明确"
            />
          </label>
        </div>
      </Modal>
    );
  }

  function renderConfirm() {
    if (!confirm) return null;
    return (
      <ConfirmDialog
        open
        title={confirm.title}
        message={confirm.message}
        confirmLabel={confirm.confirmLabel}
        danger={confirm.danger ? 'solid' : false}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm.onConfirm;
          setConfirm(null);
          void execute(confirm.title, action);
        }}
      />
    );
  }

  function renderFunctionNode(item: BusinessFunction) {
    const refs = functionFlowRefs(currentSystem!, item.id);
    return (
      <button
        type="button"
        key={item.id}
        data-business-function-card={item.id}
        className={`tw-bm-function-node ${item.id === selectedFunctionId && !functionDraft ? 'active' : ''}`}
        onClick={() => selectFunction(item.id)}
      >
        <span className="tw-bm-function-node-head">
          <strong>
            <OverflowHint text={item.name} />
          </strong>
          <i className={item.confirmed ? 'confirmed' : 'ai'} />
        </span>
        <span className="tw-bm-function-node-purpose">{item.purpose || '尚未填写功能作用'}</span>
        <span className="tw-bm-function-node-meta">
          <small>{item.code}</small>
          <small>{refs.length} 个流程步骤</small>
          <small>{item.evidence.length} 条证据</small>
        </span>
      </button>
    );
  }

  function renderDirectoryModal() {
    if (!directoryEditor) return null;
    const creatingChild = directoryEditor.mode === 'create' && Boolean(directoryEditor.parentId);
    const parentPath = directoryEditor.parentId
      ? directoryPath(currentSystem?.directories || [], directoryEditor.parentId)
          .map((item) => item.name)
          .join(' / ')
      : '根目录';
    return (
      <Modal
        title={
          directoryEditor.mode === 'create'
            ? creatingChild
              ? '新建子目录'
              : '新建功能目录'
            : '重命名功能目录'
        }
        subtitle={
          directoryEditor.mode === 'create' && !creatingChild
            ? '将在功能目录树根级平铺显示'
            : `位置：${parentPath}`
        }
        onClose={() => setDirectoryEditor(null)}
        footer={
          <>
            <span className="spacer" />
            <button
              className="tw-bm-btn"
              type="button"
              data-modal-dismiss
              onClick={() => setDirectoryEditor(null)}
            >
              取消
            </button>
            <button
              className="tw-bm-btn primary"
              type="button"
              disabled={!!busy}
              onClick={saveDirectory}
            >
              保存目录
            </button>
          </>
        }
      >
        <div className="tw-bm-form">
          <label>
            <span>目录名称</span>
            <input
              name="directoryName"
              autoFocus
              value={directoryEditor.name}
              onChange={(event) =>
                setDirectoryEditor({ ...directoryEditor, name: event.target.value })
              }
              placeholder="例如：工单受理"
            />
          </label>
        </div>
      </Modal>
    );
  }

  return (
    <div className="tw-bm-page tw-bm-redesign">
      <header className="tw-bm-system-head">
        <div className="tw-bm-system-identity">
          <button
            className="tw-bm-back-btn"
            type="button"
            onClick={() => setSystemId('')}
            title="返回全部系统"
            aria-label="返回全部系统"
          >
            <PmIcon name="arrowLeft" size={14} />
            全部系统
          </button>
        </div>

        <nav className="tw-bm-system-tabs" aria-label="系统视图">
          {(
            [
              { value: 'functions', label: '功能目录' },
              { value: 'flows', label: '业务流程' },
            ] as const
          ).map((tab) => (
            <button
              type="button"
              key={tab.value}
              aria-current={view === tab.value ? 'page' : undefined}
              className={view === tab.value ? 'active' : ''}
              onClick={() => {
                if (tab.value === 'functions') showFunctions();
                else showFlows();
              }}
            >
              {tab.label}
              <span>
                {tab.value === 'functions'
                  ? currentSystem.functions.length
                  : currentSystem.flows.length}
              </span>
            </button>
          ))}
        </nav>

        <span className="spacer" />
        <div className="tw-bm-system-tools">
          <SelectDropdown
            ariaLabel="切换业务系统"
            className="tw-bm-system-switcher-field"
            value={currentSystem.id}
            onChange={selectSystem}
            options={store.systems.map((system) => ({
              value: system.id,
              label: system.name,
              secondary: system.description || system.entryUrl || undefined,
            }))}
            compact
            searchable={store.systems.length > 6}
            triggerClassName="tw-bm-system-switcher-trigger"
            renderOptionPrefix={() => <PmIcon name="folder" size={14} />}
            renderTrigger={(option, state) => (
              <>
                <span className="tw-bm-system-switcher-icon" aria-hidden="true">
                  <PmIcon name="folder" size={16} />
                </span>
                <span className="tw-bm-system-switcher-copy">
                  <OverflowHint
                    text={option?.label || currentSystem.name}
                    className="tw-bm-system-switcher-name"
                  />
                </span>
                <span
                  className={`tw-bm-system-switcher-chevron ${state.open ? 'is-open' : ''}`}
                  aria-hidden="true"
                >
                  <PmIcon name="chevronDown" size={14} />
                </span>
              </>
            )}
          />
          <div className="tw-bm-system-actions" role="group" aria-label="系统操作">
            <button type="button" className="is-ai" onClick={() => openAi()}>
              <PmIcon name="chat" size={14} />
              <span className="tw-bm-system-action-label">AI 助手</span>
            </button>
          </div>
        </div>
      </header>

      <div
        className={`tw-bm-workbench ${detailOpen ? 'has-detail' : ''} ${
          contextResizing ? 'is-resizing' : ''
        }`}
        style={
          {
            '--tw-bm-context-width': `${contextWidth}px`,
          } as CSSProperties
        }
      >
        <aside className="tw-bm-context">
          <div className="tw-bm-context-head">
            <div>
              <strong>{view === 'functions' ? '功能目录' : '业务流程'}</strong>
              <span>
                {view === 'functions'
                  ? `${currentSystem.directories.length} 目录 · ${currentSystem.functions.length} 功能`
                  : `${currentSystem.flows.length} 条流程`}
              </span>
            </div>
            {view === 'functions' ? (
              <Menu>
                <MenuButton
                  type="button"
                  className="tw-bm-tree-head-action"
                  title="新建"
                  aria-label="新建目录或独立功能"
                >
                  ＋
                </MenuButton>
                <MenuItems
                  transition
                  anchor={{ to: 'bottom end', gap: 6 }}
                  className="tw-bm-tree-menu tw-menu-anim tw-bm-create-menu"
                >
                  <MenuItem as="button" type="button" onClick={() => openCreateDirectory('')}>
                    <PmIcon name="folder" size={14} />
                    <span>新建根目录</span>
                  </MenuItem>
                  <MenuItem as="button" type="button" onClick={() => startNewFunction('')}>
                    <PmIcon name="file" size={14} />
                    <span>新建独立功能</span>
                  </MenuItem>
                </MenuItems>
              </Menu>
            ) : (
              <button
                type="button"
                className="tw-bm-context-create"
                onClick={() => openFlowModal()}
              >
                <PmIcon name="plus" size={13} />
                新建流程
              </button>
            )}
          </div>
          <div className="tw-bm-context-search-wrap">
            <label className="tw-bm-search tw-bm-context-search">
              <PmIcon name="search" size={14} />
              <input
                ref={searchInputRef}
                aria-label={view === 'functions' ? '搜索功能' : '搜索流程'}
                name="businessMapSearch"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={view === 'functions' ? '搜索目录或功能' : '搜索流程'}
              />
              {query ? (
                <button
                  type="button"
                  className="tw-bm-search-clear"
                  aria-label={`清空${view === 'functions' ? '功能' : '流程'}搜索`}
                  onClick={(event) => {
                    event.preventDefault();
                    setQuery('');
                    searchInputRef.current?.focus();
                  }}
                >
                  ×
                </button>
              ) : null}
            </label>
          </div>
          <div className="tw-bm-tree">
            {view === 'functions' ? (
              <BusinessMapFunctionTree
                directories={currentSystem.directories}
                functions={currentSystem.functions}
                query={query}
                menuNavigation={menuNavigation}
                selectedDirectoryId={selectedDirectoryId}
                selectedFunctionId={selectedFunctionId}
                expandedIds={expandedDirectoryIds}
                onSelectDirectory={(id) => {
                  setSelectedFunctionId('');
                  setSelectedMenuKind('directory');
                  setSelectedDirectoryId(id);
                  setQuery('');
                  setView('functions');
                }}
                onSelectFunction={selectFunction}
                onToggleDirectory={toggleDirectory}
                onCreateDirectory={(parentId) => openCreateDirectory(parentId)}
                onRenameDirectory={openRenameDirectory}
                onCreateFunction={(directoryId) => startNewFunction(directoryId)}
                onUnlockMenu={unlockFunctionMenu}
                onMove={moveTreeNode}
              />
            ) : (
              <>
                {filteredFlows.map((flow) => (
                  <button
                    type="button"
                    key={flow.id}
                    className={`tw-bm-tree-item flow ${flow.id === currentFlow?.id ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedFlowId(flow.id);
                      setSelectedStepId(flow.steps[0]?.id || '');
                      setDetailOpen(false);
                    }}
                  >
                    <span className="flow-no">{flow.code.replace('P', '')}</span>
                    <span className="tw-bm-flow-list-copy">
                      <OverflowHint text={flow.name} className="tw-bm-flow-list-name" />
                      <small>
                        {flow.steps.length} 步 · {flowStatus(flow)}
                      </small>
                    </span>
                    {flowStatus(flow) === '待补全' ? <i className="warn" /> : null}
                  </button>
                ))}
              </>
            )}
          </div>
          <div
            className="tw-bm-context-resizer"
            role="separator"
            aria-label="调整业务流程侧栏宽度"
            aria-orientation="vertical"
            aria-valuemin={BUSINESS_CONTEXT_MIN_WIDTH}
            aria-valuemax={BUSINESS_CONTEXT_MAX_WIDTH}
            aria-valuenow={contextWidth}
            aria-valuetext={`${contextWidth} 像素`}
            title="拖动调整侧栏宽度，双击恢复默认"
            tabIndex={0}
            onPointerDown={startContextResize}
            onPointerMove={moveContextResize}
            onPointerUp={finishContextResize}
            onPointerCancel={finishContextResize}
            onKeyDown={resizeContextByKeyboard}
            onDoubleClick={() => saveContextWidth(BUSINESS_CONTEXT_DEFAULT_WIDTH)}
          />
        </aside>

        <main className="tw-bm-main">
          {view === 'functions' ? (
            <header className="tw-bm-main-head">
              <div>
                <h1>{selectedRootFunction?.name || selectedDirectory?.name || '功能目录'}</h1>
                <p>
                  {selectedRootFunction
                    ? `${selectedRootFunction.code} · 独立菜单 · ${selectedRootFunction.status}`
                    : selectedDirectoryPath.map((item) => item.name).join(' / ') ||
                      '按真实菜单建立目录，再维护目录下的业务功能。'}
                </p>
              </div>
              <span className="spacer" />
              <div className="tw-bm-main-actions">
                {selectedDirectory ? (
                  <button
                    className="tw-bm-btn primary"
                    type="button"
                    onClick={() => startNewFunction(selectedDirectoryId)}
                  >
                    ＋ 新建功能
                  </button>
                ) : null}
                <button
                  className="tw-bm-btn danger ghost"
                  type="button"
                  disabled={!selectedDirectory && !currentFunction}
                  onClick={removeSelectedMenu}
                >
                  <PmIcon name="trash" size={14} />
                  删除菜单
                </button>
              </div>
            </header>
          ) : null}

          {view === 'functions' ? (
            selectedRootFunction ? (
              <div ref={mainBodyRef} className="tw-bm-main-body tw-bm-single-function-view">
                <div className="tw-bm-catalog-toolbar">
                  <span>独立菜单 · 1 个功能</span>
                </div>
                <section className="tw-bm-directory-board">
                  <div className="tw-bm-directory-section">
                    <header>
                      <strong>功能</strong>
                      <span>当前菜单直接对应的功能</span>
                    </header>
                    <div className="tw-bm-function-grid">
                      {renderFunctionNode(selectedRootFunction)}
                    </div>
                  </div>
                </section>
              </div>
            ) : (
              <div ref={mainBodyRef} className="tw-bm-main-body">
                <div className="tw-bm-catalog-toolbar">
                  <span>
                    {selectedDirectoryChildren.length} 个子目录 ·{' '}
                    {selectedDirectoryFunctions.length} 个功能
                  </span>
                  <span className="spacer" />
                  {query ? (
                    <button
                      type="button"
                      className="tw-bm-text-action"
                      onClick={() => setQuery('')}
                    >
                      清空搜索
                    </button>
                  ) : null}
                </div>
                <section className="tw-bm-directory-board">
                  {selectedDirectoryChildren.length ? (
                    <div className="tw-bm-directory-section">
                      <header>
                        <strong>子目录</strong>
                        <span>拖拽目录可调整层级和顺序</span>
                      </header>
                      <div className="tw-bm-directory-grid">
                        {selectedDirectoryChildren.map((directory) => {
                          const functionCount = currentSystem.functions.filter(
                            (item) => item.directoryId === directory.id,
                          ).length;
                          const childCount = currentSystem.directories.filter(
                            (item) => item.parentId === directory.id,
                          ).length;
                          return (
                            <button
                              type="button"
                              key={directory.id}
                              className="tw-bm-directory-card"
                              onClick={() => {
                                setSelectedFunctionId('');
                                setSelectedMenuKind('directory');
                                setSelectedDirectoryId(directory.id);
                                setExpandedDirectoryIds((current) => {
                                  const next = new Set(current);
                                  for (const item of directoryPath(
                                    currentSystem.directories,
                                    directory.id,
                                  ))
                                    next.add(item.id);
                                  return next;
                                });
                              }}
                            >
                              <PmIcon name="folder" size={16} />
                              <span>
                                <strong>
                                  <OverflowHint text={directory.name} />
                                </strong>
                                <small>
                                  {childCount} 个子目录 · {functionCount} 个功能
                                </small>
                              </span>
                              <PmIcon name="chevronRight" size={14} />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  <div className="tw-bm-directory-section">
                    <header>
                      <strong>功能</strong>
                      <span>功能必须有页面、文档或明确人工说明作为依据</span>
                    </header>
                    <div className="tw-bm-function-grid">
                      {selectedDirectoryFunctions.map((item) => renderFunctionNode(item))}
                    </div>
                    {!selectedDirectoryFunctions.length ? (
                      <div className="tw-bm-empty-inline">
                        <strong>{query ? '没有匹配的功能' : '这个目录还没有功能'}</strong>
                        <p>
                          {query
                            ? '清空搜索或切换到其他目录。'
                            : '可以手工新建，或稍后让 AI 根据菜单页面识别。'}
                        </p>
                        {!query ? (
                          <button
                            type="button"
                            className="tw-bm-btn primary"
                            onClick={() => startNewFunction(selectedDirectoryId)}
                          >
                            新建功能
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>
            )
          ) : (
            <div className="tw-bm-main-body tw-bm-flow-main-body">
              {currentFlow ? (
                <>
                  <div className="tw-bm-flow-toolbar">
                    <div className="tw-bm-flow-title-group">
                      <span className="tw-bm-flow-code">{currentFlow.code}</span>
                      <h2>{currentFlow.name}</h2>
                      <span
                        className={`tw-bm-badge ${flowStatus(currentFlow) === '待补全' ? 'warn' : 'ok'}`}
                      >
                        {flowStatus(currentFlow)}
                      </span>
                    </div>
                    <span className="spacer" />
                    {currentStep && !detailOpen ? (
                      <button
                        className="tw-bm-btn"
                        type="button"
                        onClick={() => setDetailOpen(true)}
                      >
                        <PmIcon name="pencil" size={14} />
                        步骤详情
                      </button>
                    ) : null}
                    <button className="tw-bm-btn" type="button" onClick={() => openFlowModal(true)}>
                      编辑流程
                    </button>
                    <button className="tw-bm-btn" type="button" onClick={() => addStep()}>
                      ＋ 添加步骤
                    </button>
                    <button
                      className="tw-bm-btn danger ghost"
                      type="button"
                      onClick={removeCurrentFlow}
                    >
                      删除流程
                    </button>
                  </div>
                  <section className="tw-bm-flow-board">
                    <header className="tw-bm-flow-board-head">
                      <div className="tw-bm-flow-outcome">
                        <span>最终业务结果</span>
                        <strong>
                          <OverflowHint text={currentFlow.result || '尚未填写最终结果'} clamp="y" />
                        </strong>
                      </div>
                      <dl className="tw-bm-flow-stats">
                        <div>
                          <dd>{currentFlow.steps.length}</dd>
                          <dt>步骤</dt>
                        </div>
                        <div>
                          <dd>{participantSystems(currentFlow).length}</dd>
                          <dt>参与系统</dt>
                        </div>
                        <div>
                          <dd>{currentFlow.steps.filter((step) => step.branch).length}</dd>
                          <dt>分支说明</dt>
                        </div>
                        <div
                          className={
                            currentFlow.steps.some((step) => step.branchBroken) ? 'warn' : ''
                          }
                        >
                          <dd>{currentFlow.steps.filter((step) => step.branchBroken).length}</dd>
                          <dt>待连接</dt>
                        </div>
                      </dl>
                    </header>
                    <div className="tw-bm-flow-board-tools">
                      <span className="tw-bm-flow-tool-label">泳道分组</span>
                      <div
                        className="tw-bm-flow-lane-switch"
                        role="group"
                        aria-label="泳道分组方式"
                      >
                        <button
                          type="button"
                          className={flowLaneMode === 'system' ? 'active' : ''}
                          aria-pressed={flowLaneMode === 'system'}
                          onClick={() => setFlowLaneMode('system')}
                        >
                          参与系统
                        </button>
                        <button
                          type="button"
                          className={flowLaneMode === 'role' ? 'active' : ''}
                          aria-pressed={flowLaneMode === 'role'}
                          onClick={() => setFlowLaneMode('role')}
                        >
                          执行角色
                        </button>
                      </div>
                      <span className="spacer" />
                      <span className="tw-bm-flow-guide">
                        <i aria-hidden="true" />
                        拖动画布浏览；点击节点查看或编辑
                      </span>
                    </div>
                    {currentFlow.steps.length ? (
                      <BusinessFlowDiagram
                        flow={currentFlow}
                        functions={currentSystem.functions}
                        laneMode={flowLaneMode}
                        selectedStepId={currentStep?.id || ''}
                        detailOpen={detailOpen}
                        onSelectStep={(stepId) => {
                          if (stepId === currentStep?.id && detailOpen) {
                            closeDetail();
                            return;
                          }
                          setSelectedStepId(stepId);
                          setDetailOpen(true);
                        }}
                        onAddStep={addStep}
                      />
                    ) : (
                      <div className="tw-bm-flow-board-empty">
                        <strong>流程还没有步骤</strong>
                        <p>从触发动作开始，把角色、系统和产出依次接到泳道链路中。</p>
                        <button
                          className="tw-bm-btn primary"
                          type="button"
                          onClick={() => addStep()}
                        >
                          <PmIcon name="plus" size={14} />
                          添加第一步
                        </button>
                      </div>
                    )}
                  </section>
                </>
              ) : (
                <div className="tw-bm-empty-inline tall">
                  <strong>
                    {currentSystem.flows.length ? '没有匹配的业务流程' : '还没有业务流程'}
                  </strong>
                  <p>
                    {currentSystem.flows.length
                      ? '调整搜索条件，查看其他流程。'
                      : '新建流程后，用泳道图串起角色、系统和关键步骤。'}
                  </p>
                  {query ? (
                    <button type="button" className="tw-bm-btn" onClick={() => setQuery('')}>
                      清空流程搜索
                    </button>
                  ) : null}
                  <button
                    className="tw-bm-btn primary"
                    type="button"
                    onClick={() => openFlowModal()}
                  >
                    ＋ 新建流程
                  </button>
                </div>
              )}
            </div>
          )}
        </main>

        {detailPresence.mounted ? (
          <button
            className={`tw-bm-detail-scrim ${detailPresence.closing ? 'is-closing' : ''}`}
            type="button"
            aria-label="关闭详情"
            onClick={closeDetail}
          />
        ) : null}
        {detailPresence.mounted ? (
          <aside
            id="business-flow-step-detail"
            className={`tw-bm-detail ${detailPresence.closing ? 'is-closing' : ''}`}
          >
            {view === 'functions' ? (
              functionDraft ? (
                <>
                  <header className="tw-bm-detail-head">
                    <div className="tw-bm-detail-titlebar">
                      <span className="tw-bm-badge warn">{functionIsNew ? '新建' : '编辑中'}</span>
                      <span className="spacer" />
                      <button
                        className="tw-bm-detail-close"
                        type="button"
                        onClick={closeDetail}
                        aria-label="关闭详情"
                      >
                        ×
                      </button>
                    </div>
                    <h2>{functionIsNew ? '新建功能' : '编辑功能'}</h2>
                    <p>维护目录中的功能节点；复杂规则和实现信息可按需展开。</p>
                  </header>
                  <div className="tw-bm-detail-body">
                    <div className="tw-bm-form compact">
                      <label>
                        <span>所属目录</span>
                        <SelectDropdown
                          ariaLabel="所属目录"
                          value={functionDraft.directoryId}
                          onChange={(directoryId) =>
                            setFunctionDraft({ ...functionDraft, directoryId })
                          }
                          options={[
                            { value: '', label: '未归档（根目录）' },
                            ...currentSystem.directories.map((directory) => ({
                              value: directory.id,
                              label: directoryPath(currentSystem.directories, directory.id)
                                .map((item) => item.name)
                                .join(' / '),
                            })),
                          ]}
                          searchable
                          searchPlaceholder="搜索目录"
                          showCheck
                          className="tw-bm-field-select"
                        />
                      </label>
                      <label>
                        <span>功能名称</span>
                        <input
                          name="functionName"
                          value={functionDraft.name}
                          onChange={(event) =>
                            setFunctionDraft({ ...functionDraft, name: event.target.value })
                          }
                          autoFocus
                        />
                      </label>
                      <label>
                        <span>功能作用</span>
                        <textarea
                          name="functionPurpose"
                          rows={3}
                          value={functionDraft.purpose}
                          onChange={(event) =>
                            setFunctionDraft({ ...functionDraft, purpose: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>入口</span>
                        <input
                          name="functionEntry"
                          value={functionDraft.entry}
                          onChange={(event) =>
                            setFunctionDraft({ ...functionDraft, entry: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>证据（格式：page/doc/code/manual|标题|位置）</span>
                        <textarea
                          name="functionEvidence"
                          rows={4}
                          value={functionDraft.evidenceText}
                          onChange={(event) =>
                            setFunctionDraft({
                              ...functionDraft,
                              evidenceText: event.target.value,
                            })
                          }
                          placeholder="page|办理页|/order/detail"
                        />
                      </label>
                      <details className="tw-bm-function-more">
                        <summary>更多业务字段</summary>
                        <div className="tw-bm-form compact">
                          <div className="two">
                            <label>
                              <span>兼容业务域</span>
                              <input
                                name="functionDomain"
                                value={functionDraft.domain}
                                onChange={(event) =>
                                  setFunctionDraft({
                                    ...functionDraft,
                                    domain: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <label>
                              <span>兼容模块</span>
                              <input
                                name="functionModule"
                                value={functionDraft.module}
                                onChange={(event) =>
                                  setFunctionDraft({
                                    ...functionDraft,
                                    module: event.target.value,
                                  })
                                }
                              />
                            </label>
                          </div>
                          <label>
                            <span>使用角色（一行一个）</span>
                            <textarea
                              name="functionRoles"
                              rows={2}
                              value={functionDraft.roles}
                              onChange={(event) =>
                                setFunctionDraft({
                                  ...functionDraft,
                                  roles: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>业务规则（一行一条）</span>
                            <textarea
                              name="functionRules"
                              rows={4}
                              value={functionDraft.rules}
                              onChange={(event) =>
                                setFunctionDraft({
                                  ...functionDraft,
                                  rules: event.target.value,
                                })
                              }
                            />
                          </label>
                          <div className="two">
                            <label>
                              <span>输入</span>
                              <textarea
                                name="functionInputs"
                                rows={3}
                                value={functionDraft.inputs}
                                onChange={(event) =>
                                  setFunctionDraft({
                                    ...functionDraft,
                                    inputs: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <label>
                              <span>输出</span>
                              <textarea
                                name="functionOutputs"
                                rows={3}
                                value={functionDraft.outputs}
                                onChange={(event) =>
                                  setFunctionDraft({
                                    ...functionDraft,
                                    outputs: event.target.value,
                                  })
                                }
                              />
                            </label>
                          </div>
                          <label>
                            <span>落库口径（一行一条）</span>
                            <textarea
                              name="functionWrites"
                              rows={3}
                              value={functionDraft.writes}
                              onChange={(event) =>
                                setFunctionDraft({
                                  ...functionDraft,
                                  writes: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>异常与待确认（一行一条）</span>
                            <textarea
                              name="functionExceptions"
                              rows={3}
                              value={functionDraft.exceptions}
                              onChange={(event) =>
                                setFunctionDraft({
                                  ...functionDraft,
                                  exceptions: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>实现说明（一行一条）</span>
                            <textarea
                              name="functionImplementation"
                              rows={3}
                              value={functionDraft.implementation}
                              onChange={(event) =>
                                setFunctionDraft({
                                  ...functionDraft,
                                  implementation: event.target.value,
                                })
                              }
                            />
                          </label>
                        </div>
                      </details>
                    </div>
                  </div>
                  <footer className="tw-bm-detail-foot">
                    <button
                      className="tw-bm-btn"
                      type="button"
                      onClick={() => {
                        setFunctionDraft(null);
                        setFunctionIsNew(false);
                      }}
                    >
                      取消
                    </button>
                    <span className="spacer" />
                    <button
                      className="tw-bm-btn primary"
                      type="button"
                      disabled={!!busy}
                      onClick={saveFunctionDraft}
                    >
                      保存功能
                    </button>
                  </footer>
                </>
              ) : currentFunction ? (
                <>
                  <header className="tw-bm-detail-head">
                    <div className="tw-bm-detail-titlebar">
                      <span className="tw-bm-badge accent">
                        {currentFunctionDirectoryPath.at(-1)?.name || '未归档'}
                      </span>
                      <span className="tw-bm-badge">{currentFunction.status}</span>
                      <span className="spacer" />
                      <button
                        className="tw-bm-detail-close"
                        type="button"
                        onClick={closeDetail}
                        aria-label="关闭详情"
                      >
                        ×
                      </button>
                    </div>
                    <h2>{currentFunction.name}</h2>
                    <p>
                      {currentFunction.code} ·{' '}
                      {currentFunctionDirectoryPath.map((item) => item.name).join(' / ') ||
                        '未归档'}{' '}
                      · {selectedFunctionRefGroups.length} 条流程引用
                    </p>
                  </header>
                  <div className="tw-bm-detail-tabs">
                    {[
                      ['overview', '概览'],
                      ['rules', '规则与落库'],
                      ['evidence', '实现与证据'],
                    ].map(([key, label]) => (
                      <button
                        type="button"
                        key={key}
                        className={detailTab === key ? 'active' : ''}
                        onClick={() => setDetailTab(key as DetailTab)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="tw-bm-detail-body">
                    {detailTab === 'overview' ? (
                      <>
                        <section>
                          <h3>它解决什么问题</h3>
                          <p>{currentFunction.purpose || '尚未填写功能作用。'}</p>
                        </section>
                        <section>
                          <h3>使用方式</h3>
                          <div className="tw-bm-kv">
                            <span>使用角色</span>
                            <strong>
                              <OverflowHint
                                text={currentFunction.roles.join('、') || '未填写'}
                                className="tw-bm-kv-value"
                              />
                            </strong>
                            <span>入口</span>
                            <strong>
                              <OverflowHint
                                text={currentFunction.entry || '未填写'}
                                className="tw-bm-kv-value"
                              />
                            </strong>
                            <span>输入</span>
                            <strong>
                              <OverflowHint
                                text={currentFunction.inputs.join('、') || '未填写'}
                                className="tw-bm-kv-value"
                              />
                            </strong>
                            <span>输出</span>
                            <strong>
                              <OverflowHint
                                text={currentFunction.outputs.join('、') || '未填写'}
                                className="tw-bm-kv-value"
                              />
                            </strong>
                          </div>
                        </section>
                        <section>
                          <h3>关联流程</h3>
                          {selectedFunctionRefGroups.map((group) => (
                            <button
                              className="tw-bm-ref-flow"
                              type="button"
                              key={group.flow!.id}
                              onClick={() => {
                                setView('flows');
                                setSelectedFlowId(group.flow!.id);
                                setSelectedStepId(group.steps[0]?.id || '');
                              }}
                            >
                              <strong>
                                {group.flow!.code} · {group.flow!.name}
                              </strong>
                              <span>
                                {group.steps.length} 个步骤引用 · 第{' '}
                                {group.steps.map((step) => step.n).join(' / ')} 步 →
                              </span>
                            </button>
                          ))}
                          {!selectedFunctionRefGroups.length ? (
                            <div className="tw-bm-form-note">当前还没有流程引用这个功能。</div>
                          ) : null}
                        </section>
                      </>
                    ) : null}
                    {detailTab === 'rules' ? (
                      <>
                        <section>
                          <h3>业务规则</h3>
                          <ul>
                            {currentFunction.rules.map((rule) => (
                              <li key={rule}>{rule}</li>
                            ))}
                          </ul>
                          {!currentFunction.rules.length ? <p>尚未填写业务规则。</p> : null}
                        </section>
                        <section>
                          <h3>落库口径</h3>
                          <ul>
                            {currentFunction.writes.map((write) => (
                              <li key={write}>{write}</li>
                            ))}
                          </ul>
                          {!currentFunction.writes.length ? <p>尚未确认落库口径。</p> : null}
                        </section>
                        <section>
                          <h3>异常与待确认</h3>
                          <ul>
                            {currentFunction.exceptions.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                          {!currentFunction.exceptions.length ? <p>暂无登记异常。</p> : null}
                        </section>
                      </>
                    ) : null}
                    {detailTab === 'evidence' ? (
                      <>
                        <section>
                          <h3>证据与置信度</h3>
                          <div className="tw-bm-kv">
                            <span>来源</span>
                            <strong>
                              {currentFunction.source === 'mixed'
                                ? 'AI + 人工确认'
                                : currentFunction.source === 'ai'
                                  ? 'AI 识别'
                                  : '人工维护'}
                            </strong>
                            <span>置信度</span>
                            <strong>{confidenceLabel(currentFunction.confidence)}</strong>
                          </div>
                        </section>
                        <section>
                          <h3>当前证据</h3>
                          {currentFunction.evidence.map((evidence, index) => (
                            <div className="tw-bm-evidence-item" key={`${evidence.title}-${index}`}>
                              <i className={sourceTone(evidence.type)} />
                              <div>
                                <strong>{evidence.title}</strong>
                                <span>{evidence.ref || evidence.note || evidence.type}</span>
                              </div>
                            </div>
                          ))}
                          {!currentFunction.evidence.length ? <p>尚未登记证据。</p> : null}
                        </section>
                        {currentFunction.implementation.length ? (
                          <section>
                            <h3>实现位置</h3>
                            <ul>
                              {currentFunction.implementation.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          </section>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <footer className="tw-bm-detail-foot">
                    <button className="tw-bm-btn" type="button" onClick={() => openAi()}>
                      ＋ 证据
                    </button>
                    <span className="spacer" />
                    <button className="tw-bm-btn" type="button" onClick={() => openAi()}>
                      AI 补充
                    </button>
                    <button className="tw-bm-btn" type="button" onClick={editCurrentFunction}>
                      编辑
                    </button>
                    <button
                      className="tw-bm-btn primary"
                      type="button"
                      onClick={editCurrentFunction}
                    >
                      确认并维护
                    </button>
                  </footer>
                </>
              ) : (
                <div className="tw-bm-detail-empty">
                  <button
                    className="tw-bm-detail-close"
                    type="button"
                    onClick={closeDetail}
                    aria-label="关闭详情"
                  >
                    ×
                  </button>
                  <span>◇</span>
                  <strong>选择一个功能</strong>
                  <p>查看作用、规则、落库口径和证据。</p>
                </div>
              )
            ) : stepDraft ? (
              <>
                <header className="tw-bm-detail-head">
                  <div className="tw-bm-detail-titlebar">
                    <span className="tw-bm-badge accent">
                      {currentFlow?.code} · 第 {stepDraft.n} 步
                    </span>
                    {stepDraft.manual ? <span className="tw-bm-badge warn">人工</span> : null}
                    <span className="spacer" />
                    <button
                      className="tw-bm-detail-close"
                      type="button"
                      onClick={closeDetail}
                      aria-label="关闭详情"
                    >
                      ×
                    </button>
                  </div>
                  <h2>{stepDraft.title}</h2>
                  <p>
                    {stepDraft.system} · {stepDraft.role}
                  </p>
                </header>
                <div className="tw-bm-detail-body">
                  <div className="tw-bm-form compact">
                    <label>
                      <span>步骤名称</span>
                      <input
                        name="stepTitle"
                        value={stepDraft.title}
                        onChange={(event) =>
                          setStepDraft({ ...stepDraft, title: event.target.value })
                        }
                      />
                    </label>
                    <div className="two">
                      <label>
                        <span>执行角色</span>
                        <input
                          name="stepRole"
                          value={stepDraft.role}
                          onChange={(event) =>
                            setStepDraft({ ...stepDraft, role: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>参与系统</span>
                        <input
                          name="stepSystem"
                          value={stepDraft.system}
                          onChange={(event) =>
                            setStepDraft({ ...stepDraft, system: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <label>
                      <span>承载功能</span>
                      <SelectDropdown
                        ariaLabel="承载功能"
                        value={stepDraft.functionId}
                        onChange={(functionId) => setStepDraft({ ...stepDraft, functionId })}
                        options={[
                          { value: '', label: '未关联' },
                          ...currentSystem.functions.map((item) => ({
                            value: item.id,
                            label: `${item.code} · ${item.name}`,
                          })),
                        ]}
                        searchable
                        searchPlaceholder="搜索功能名称或编号"
                        showCheck
                        className="tw-bm-field-select"
                      />
                    </label>
                    <div className="two">
                      <label>
                        <span>输入</span>
                        <input
                          name="stepInput"
                          value={stepDraft.input}
                          onChange={(event) =>
                            setStepDraft({ ...stepDraft, input: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>输出</span>
                        <input
                          name="stepOutput"
                          value={stepDraft.output}
                          onChange={(event) =>
                            setStepDraft({ ...stepDraft, output: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <div className="two">
                      <label>
                        <span>下一步</span>
                        <input
                          name="stepNext"
                          value={stepDraft.next}
                          onChange={(event) =>
                            setStepDraft({ ...stepDraft, next: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>人工环节</span>
                        <SelectDropdown
                          ariaLabel="人工环节"
                          value={stepDraft.manual ? 'yes' : 'no'}
                          onChange={(value) =>
                            setStepDraft({ ...stepDraft, manual: value === 'yes' })
                          }
                          options={[
                            { value: 'no', label: '否' },
                            { value: 'yes', label: '是' },
                          ]}
                          showCheck
                          className="tw-bm-field-select"
                        />
                      </label>
                    </div>
                    <label>
                      <span>异常分支</span>
                      <textarea
                        name="stepBranch"
                        rows={3}
                        value={stepDraft.branch}
                        onChange={(event) =>
                          setStepDraft({
                            ...stepDraft,
                            branch: event.target.value,
                            branchBroken: event.target.value ? stepDraft.branchBroken : false,
                          })
                        }
                        placeholder="例如：材料不齐 → 退回申请人"
                      />
                    </label>
                    {stepDraft.branch ? (
                      <label>
                        <span>分支连接状态</span>
                        <SelectDropdown
                          ariaLabel="分支连接状态"
                          value={stepDraft.branchBroken ? 'broken' : 'connected'}
                          onChange={(value) =>
                            setStepDraft({ ...stepDraft, branchBroken: value === 'broken' })
                          }
                          options={[
                            { value: 'broken', label: '待补全' },
                            { value: 'connected', label: '已连接' },
                          ]}
                          showCheck
                          className="tw-bm-field-select"
                        />
                      </label>
                    ) : null}
                    <label>
                      <span>系统依赖（一行一个，格式：系统|说明）</span>
                      <textarea
                        name="stepDependencies"
                        rows={3}
                        value={stepDraft.dependencies
                          .map((dep) => `${dep.system}|${dep.label}`)
                          .join('\n')}
                        onChange={(event) =>
                          setStepDraft({
                            ...stepDraft,
                            dependencies: lines(event.target.value).map((line) => {
                              const [system, ...rest] = line.split('|');
                              return { system: system.trim(), label: rest.join('|').trim() };
                            }),
                          })
                        }
                        placeholder="系统设置|读取归口字典"
                      />
                    </label>
                  </div>
                </div>
                <footer className="tw-bm-detail-foot">
                  <button
                    className="tw-bm-btn"
                    type="button"
                    disabled={
                      !!busy ||
                      !currentFlow?.steps.some((step) => step.id === stepDraft.id) ||
                      stepDraft.n <= 1
                    }
                    onClick={() => moveStep(-1)}
                  >
                    ↑ 上移
                  </button>
                  <button
                    className="tw-bm-btn"
                    type="button"
                    disabled={
                      !!busy ||
                      !currentFlow?.steps.some((step) => step.id === stepDraft.id) ||
                      stepDraft.n >= currentFlow.steps.length
                    }
                    onClick={() => moveStep(1)}
                  >
                    ↓ 下移
                  </button>
                  <span className="spacer" />
                  <button
                    className="tw-bm-btn danger"
                    type="button"
                    onClick={() => {
                      if (stepDraft.id.startsWith('temp_')) {
                        setSelectedStepId(currentFlow?.steps[0]?.id || '');
                        setStepDraft(currentFlow?.steps[0] || null);
                      } else removeStep();
                    }}
                  >
                    {stepDraft.id.startsWith('temp_') ? '取消新增' : '删除'}
                  </button>
                  <button
                    className="tw-bm-btn primary"
                    type="button"
                    disabled={!!busy}
                    onClick={saveStepDraft}
                  >
                    保存步骤
                  </button>
                </footer>
              </>
            ) : (
              <div className="tw-bm-detail-empty">
                <button
                  type="button"
                  className="tw-bm-detail-close"
                  onClick={closeDetail}
                  aria-label="关闭详情"
                >
                  ×
                </button>
                <span>◇</span>
                <strong>选择一个流程步骤</strong>
                <p>在这里修改角色、参与系统、承载功能和系统依赖。</p>
              </div>
            )}
          </aside>
        ) : null}
      </div>

      {systemModal ? renderSystemModal() : null}
      {flowModal ? renderFlowModal() : null}
      {directoryEditor ? renderDirectoryModal() : null}
      {aiPresence.mounted ? renderAiDrawer(aiPresence.closing) : null}
      {confirm ? renderConfirm() : null}
    </div>
  );
}
