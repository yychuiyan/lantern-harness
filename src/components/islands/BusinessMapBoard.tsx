import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from '@headlessui/react';

import {
  applyBusinessProposals,
  BusinessMapApiError,
  createBusinessFlow,
  createBusinessFunction,
  createBusinessMapDemo,
  createBusinessSystem,
  deleteBusinessFlow,
  deleteBusinessFunction,
  deleteBusinessSystem,
  functionFlowRefs,
  ignoreBusinessProposals,
  loadBusinessMap,
  localPublishCheck,
  normalizeStep,
  renumberBusinessSteps,
  insertBusinessStep,
  participantSystems,
  pendingProposals,
  publishBusinessSystem,
  updateBusinessFlow,
  updateBusinessFunction,
  updateBusinessSystem,
  type BusinessFlow,
  type BusinessFlowStep,
  type BusinessFunction,
  type BusinessEvidence,
  type BusinessMapStore,
  type BusinessProposal,
  type BusinessSystem,
  type PublishCheck,
} from '../../lib/business-map';
import BusinessMapAnalysisDialog from './BusinessMapAnalysisDialog';
import BusinessMapProposalDetails from './BusinessMapProposalDetails';
import BusinessMapSystems from './BusinessMapSystems';
import BusinessMapOverview from './BusinessMapOverview';
import SelectDropdown from './SelectDropdown';
import {
  filterBusinessFunctions,
  FUNCTION_FILTERS,
  type BusinessFunctionFilter,
} from '../../lib/business-map-view';
import ConfirmDialog from './ConfirmDialog';
import { PmIcon } from './PmShared';
import { showToast } from './Toast';

type MainView = 'overview' | 'functions' | 'flows';
type DetailTab = 'overview' | 'rules' | 'evidence';
type AiPhase = 'sources' | 'review';

interface FunctionDraft {
  id: string;
  code: string;
  name: string;
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
  loginState: string;
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
  loginState: '',
};

const EMPTY_FUNCTION: FunctionDraft = {
  id: '',
  code: '',
  name: '',
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
    loginState: system.loginState,
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

function proposalActionLabel(action: BusinessProposal['action']) {
  return action === 'add' ? '新增' : action === 'update' ? '更新' : '删除';
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
  const [store, setStore] = useState<BusinessMapStore | null>(null);
  const [systemId, setSystemId] = useState('');
  const [systemQuery, setSystemQuery] = useState('');
  const [view, setView] = useState<MainView>('overview');
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('全部');
  const [functionFilter, setFunctionFilter] = useState<BusinessFunctionFilter>('all');
  const [selectedFunctionId, setSelectedFunctionId] = useState('');
  const [selectedFlowId, setSelectedFlowId] = useState('');
  const [selectedStepId, setSelectedStepId] = useState('');
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [detailOpen, setDetailOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 1120,
  );
  const [functionDraft, setFunctionDraft] = useState<FunctionDraft | null>(null);
  const [functionIsNew, setFunctionIsNew] = useState(false);
  const [stepDraft, setStepDraft] = useState<BusinessFlowStep | null>(null);
  const [busy, setBusy] = useState('');
  const [fatal, setFatal] = useState('');
  const [systemModal, setSystemModal] = useState<'create' | 'edit' | null>(null);
  const [systemDraft, setSystemDraft] = useState<SystemDraft>(EMPTY_SYSTEM);
  const [systemNameError, setSystemNameError] = useState('');
  const systemNameRef = useRef<HTMLInputElement | null>(null);
  const flowNameRef = useRef<HTMLInputElement | null>(null);
  const [flowModal, setFlowModal] = useState(false);
  const [flowEditing, setFlowEditing] = useState(false);
  const [flowDraft, setFlowDraft] = useState({ name: '', result: '' });
  const [aiOpen, setAiOpen] = useState(false);
  const [analysisFunctionId, setAnalysisFunctionId] = useState('');
  const [aiPhase, setAiPhase] = useState<AiPhase>('sources');
  const [selectedProposals, setSelectedProposals] = useState<Set<string>>(new Set());
  const [publishOpen, setPublishOpen] = useState(false);
  const [remoteCheck, setRemoteCheck] = useState<PublishCheck | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const aiPresence = useAnimatedPresence(aiOpen);
  const publishPresence = useAnimatedPresence(publishOpen);
  const detailPresence = useAnimatedPresence(detailOpen);

  const currentSystem = useMemo(
    () => store?.systems.find((item) => item.id === systemId) || null,
    [store, systemId],
  );
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
  const pending = pendingProposals(currentSystem);

  useEffect(() => {
    let alive = true;
    void loadBusinessMap()
      .then((loaded) => {
        if (!alive) return;
        setStore(loaded);
        setSystemId('');
        setSelectedFunctionId('');
        setSelectedFlowId('');
      })
      .catch((error) => setFatal(errorMessage(error)))
      .finally(() => {
        if (alive) setBusy('');
      });
    return () => {
      alive = false;
    };
  }, []);

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
  }, [currentSystem, selectedFlowId, selectedFunctionId]);

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

  const domains = useMemo(
    () => [...new Set((currentSystem?.functions || []).map((item) => item.domain))],
    [currentSystem],
  );
  const filteredFunctions = useMemo(
    () =>
      currentSystem ? filterBusinessFunctions(currentSystem, functionFilter, domain, query) : [],
    [currentSystem, functionFilter, domain, query],
  );
  const publishCheck = useMemo(
    () => (currentSystem ? localPublishCheck(currentSystem) : null),
    [currentSystem],
  );

  useEffect(() => {
    if (view !== 'functions' || functionDraft) return;
    if (!filteredFunctions.some((item) => item.id === selectedFunctionId))
      setSelectedFunctionId(filteredFunctions[0]?.id || '');
  }, [filteredFunctions, functionDraft, selectedFunctionId, view]);

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
    setDetailOpen(window.innerWidth > 1120);
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
    setSystemId(id);
    setSelectedFunctionId(system.functions[0]?.id || '');
    setSelectedFlowId(system.flows[0]?.id || '');
    setSelectedStepId(system.flows[0]?.steps[0]?.id || '');
    setFunctionDraft(null);
    setStepDraft(null);
    setQuery('');
    setDomain('全部');
    setView('overview');
    setFunctionFilter('all');
    setDetailOpen(window.innerWidth > 1120);
  }

  function openCreateSystem() {
    setSystemDraft(EMPTY_SYSTEM);
    setSystemNameError('');
    setSystemModal('create');
  }

  function openEditSystem() {
    if (!currentSystem) return;
    setSystemDraft(systemToDraft(currentSystem));
    setSystemNameError('');
    setSystemModal('edit');
  }

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
        setView('overview');
        setFunctionFilter('all');
        setQuery('');
        setDomain('全部');
        setDetailOpen(window.innerWidth > 1120);
        const created = result.store.systems.find((item) => item.id === result.systemId);
        if (created) {
          setSelectedFunctionId(created.functions[0]?.id || '');
          setSelectedFlowId(created.flows[0]?.id || '');
        }
        showToast('业务系统已创建');
      } else if (currentSystem) {
        const next = await updateBusinessSystem(store.revision, currentSystem.id, systemDraft);
        applyStore(next, currentSystem.id);
        showToast('系统设置已保存');
      }
      setSystemModal(null);
    });
  }

  function removeSystem() {
    if (!store || !currentSystem) return;
    const id = currentSystem.id;
    const name = currentSystem.name;
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
        showToast('业务系统已删除');
      },
    });
  }

  function startNewFunction() {
    setFunctionFilter('all');
    setQuery('');
    const usedCodes = new Set(currentSystem?.functions.map((item) => item.code));
    let sequence = 1;
    while (usedCodes.has(`F-${String(sequence).padStart(3, '0')}`)) sequence += 1;
    const suggested = `F-${String(sequence).padStart(3, '0')}`;
    setFunctionIsNew(true);
    setFunctionDraft({
      ...EMPTY_FUNCTION,
      code: suggested,
      domain: domain === '全部' ? '受理域' : domain,
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
        const result = await createBusinessFunction(store.revision, currentSystem.id, payload);
        applyStore(result.store, currentSystem.id);
        setSelectedFunctionId(result.item.id);
        showToast('功能已新建');
      } else if (currentFunction) {
        const result = await updateBusinessFunction(
          store.revision,
          currentSystem.id,
          currentFunction.id,
          payload,
        );
        applyStore(result.store, currentSystem.id);
        setSelectedFunctionId(result.item.id);
        showToast('功能已保存，相关字段已标记为人工确认');
      }
      setFunctionDraft(null);
    });
  }

  function removeCurrentFunction() {
    if (!store || !currentSystem || !currentFunction) return;
    const id = currentFunction.id;
    const name = currentFunction.name;
    setConfirm({
      title: '删除功能',
      message: `删除「${name}」后，流程中引用它的步骤会变为未关联。`,
      confirmLabel: '删除功能',
      danger: true,
      onConfirm: async () => {
        const next = await deleteBusinessFunction(store.revision, currentSystem.id, id);
        applyStore(next, currentSystem.id);
        setFunctionDraft(null);
        showToast('功能已删除');
      },
    });
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
        showToast('流程设置已保存');
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
      showToast('流程已创建，请添加步骤');
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
      showToast('流程步骤已保存');
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
      showToast('步骤顺序已更新');
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
        showToast('流程步骤已删除');
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
        showToast('业务流程已删除');
      },
    });
  }

  function openAi(phase: AiPhase = 'sources', functionId = '') {
    if (!currentSystem) {
      showToast('请先创建业务系统', 'error');
      return;
    }
    setAiPhase(phase);
    setAnalysisFunctionId(functionId);
    setSelectedProposals(
      new Set(
        pending
          .filter((item) => item.risk !== '高' && item.action !== 'delete')
          .map((item) => item.id),
      ),
    );
    setAiOpen(true);
  }

  function toggleProposal(id: string) {
    setSelectedProposals((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleProposalGroup(items: BusinessProposal[]) {
    setSelectedProposals((current) => {
      const next = new Set(current);
      const allSelected = items.every((item) => next.has(item.id));
      items.forEach((item) => {
        if (allSelected) next.delete(item.id);
        else next.add(item.id);
      });
      return next;
    });
  }

  function applySelectedProposals() {
    if (!store || !currentSystem || !selectedProposals.size) {
      showToast('至少选择一项候选内容', 'error');
      return;
    }
    void execute('应用识别结果', async () => {
      const next = await applyBusinessProposals(store.revision, currentSystem.id, [
        ...selectedProposals,
      ]);
      applyStore(next, currentSystem.id);
      setAiOpen(false);
      setSelectedProposals(new Set());
      showToast(`已应用 ${selectedProposals.size} 项到草稿`);
    });
  }

  function ignoreSelectedProposals() {
    if (!store || !currentSystem || !selectedProposals.size) return;
    void execute('忽略识别结果', async () => {
      const next = await ignoreBusinessProposals(store.revision, currentSystem.id, [
        ...selectedProposals,
      ]);
      applyStore(next, currentSystem.id);
      setAiOpen(false);
      setSelectedProposals(new Set());
      showToast('已忽略所选识别结果');
    });
  }

  function openPublish() {
    setRemoteCheck(null);
    setPublishOpen(true);
  }

  function publish() {
    if (!store || !currentSystem) return;
    void execute('发布业务地图', async () => {
      try {
        const result = await publishBusinessSystem(store.revision, currentSystem.id);
        applyStore(result.store, currentSystem.id);
        setRemoteCheck(result.check);
        setPublishOpen(false);
        showToast('业务地图已发布');
      } catch (error) {
        if (error instanceof BusinessMapApiError && error.check) {
          setRemoteCheck(error.check);
        }
        throw error;
      }
    });
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
          onCreate={openCreateSystem}
          busy={!!busy}
          onDemo={() =>
            void execute('创建示例', async () => {
              const result = await createBusinessMapDemo(store.revision);
              applyStore(result.store, result.systemId);
              setView('overview');
              showToast('示例业务地图已创建');
            })
          }
        />
        {systemModal ? renderSystemModal() : null}
      </div>
    );
  }

  const selectedCount = selectedProposals.size;
  const visibleProposals = pending;
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
              disabled={!!busy}
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
          <label>
            <span>本地源码目录</span>
            <input
              name="systemSourceDir"
              value={systemDraft.sourceDir}
              onChange={(event) =>
                setSystemDraft({ ...systemDraft, sourceDir: event.target.value })
              }
              placeholder="/repos/work-order"
            />
          </label>
          <label>
            <span>登录态文件</span>
            <input
              name="systemLoginState"
              value={systemDraft.loginState}
              onChange={(event) =>
                setSystemDraft({ ...systemDraft, loginState: event.target.value })
              }
              placeholder="例如：.auth/state.json"
            />
          </label>
          <div className="tw-bm-form-note">
            源码目录只会被读取，并忽略 .git、node_modules、构建产物和二进制文件。
          </div>
        </div>
      </Modal>
    );
  }

  function renderAiDrawer(closing = false) {
    if (aiPhase !== 'review')
      return (
        <BusinessMapAnalysisDialog
          system={currentSystem!}
          revision={store!.revision}
          initialFunctionId={analysisFunctionId}
          closing={closing}
          onClose={() => setAiOpen(false)}
          onChanged={() => {
            void loadBusinessMap()
              .then((next) => applyStore(next, currentSystem!.id))
              .catch((error) => showToast(errorMessage(error), 'error'));
          }}
          onReview={() => {
            void loadBusinessMap()
              .then((next) => {
                applyStore(next, currentSystem!.id);
                setSelectedProposals(
                  new Set(
                    pendingProposals(next.systems.find((item) => item.id === currentSystem!.id))
                      .filter((item) => item.risk !== '高' && item.action !== 'delete')
                      .map((item) => item.id),
                  ),
                );
                setAiPhase('review');
              })
              .catch((error) => showToast(errorMessage(error), 'error'));
          }}
        />
      );
    return (
      <Dialog open onClose={() => setAiOpen(false)} className="tw-bm-theme relative z-110">
        <DialogBackdrop className={`tw-bm-overlay ${closing ? 'is-closing' : ''}`} />
        <DialogPanel
          as="aside"
          className={`tw-bm-sheet tw-bm-ai-sheet ${closing ? 'is-closing' : ''}`}
          aria-label="识别来源与提案审核"
        >
          <header className="tw-bm-sheet-head">
            <div className="tw-bm-sheet-top">
              <span className="tw-bm-badge accent">AI 识别</span>
              <span className="spacer" />
              <button
                className="tw-bm-icon-btn"
                type="button"
                onClick={() => setAiOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <h2>审核 AI 识别结果</h2>
            <p>核对来源和变更；删除与覆盖人工内容需要逐项确认。</p>
          </header>

          {aiPhase === 'review' ? (
            <>
              <div className="tw-bm-sheet-body">
                <div className="tw-bm-review-summary">
                  <strong>
                    还剩 {visibleProposals.length} 项识别内容，已选择 {selectedCount} 项
                  </strong>
                  <p>应用后只进入待发布草稿，人工确认字段不会被静默覆盖。</p>
                </div>
                {[
                  ['function', '功能识别'],
                  ['flow', '流程建议'],
                ].map(([type, label]) => {
                  const items = visibleProposals.filter((item) => item.targetType === type);
                  if (!items.length) return null;
                  return (
                    <section className="tw-bm-review-group" key={type}>
                      <header>
                        <h3>{label}</h3>
                        <span className="tw-bm-badge">{items.length} 项</span>
                        <span className="spacer" />
                        <button type="button" onClick={() => toggleProposalGroup(items)}>
                          全选此类
                        </button>
                      </header>
                      {items.map((item) => (
                        <div
                          className={`tw-bm-review-item ${selectedProposals.has(item.id) ? 'is-checked' : ''}`}
                          key={item.id}
                        >
                          <input
                            id={`proposal-${item.id}`}
                            name={`proposal-${item.id}`}
                            aria-label={`选择提案：${item.title}`}
                            type="checkbox"
                            checked={selectedProposals.has(item.id)}
                            onChange={() => toggleProposal(item.id)}
                          />
                          <div>
                            <label htmlFor={`proposal-${item.id}`}>
                              <strong>
                                {proposalActionLabel(item.action)} · {item.title}
                              </strong>
                            </label>
                            <p>{item.detail}</p>
                            <div className="meta">
                              <span
                                className={`tw-bm-badge ${item.risk === '高' ? 'warn' : item.risk === '中' ? 'teal' : ''}`}
                              >
                                风险 {item.risk}
                              </span>
                              <span className="tw-bm-badge">
                                置信度 {confidenceLabel(item.confidence)}
                              </span>
                              <span>{item.source}</span>
                            </div>
                            <BusinessMapProposalDetails proposal={item} system={currentSystem!} />
                          </div>
                        </div>
                      ))}
                    </section>
                  );
                })}
                {!visibleProposals.length ? (
                  <div className="tw-bm-empty-inline">没有待审核的 AI 识别结果。</div>
                ) : null}
              </div>
              <footer className="tw-bm-sheet-foot">
                <button className="tw-bm-btn" type="button" onClick={() => setAiPhase('sources')}>
                  返回设置
                </button>
                <span className="spacer" />
                <button
                  className="tw-bm-btn danger"
                  type="button"
                  disabled={!!busy || !selectedCount}
                  onClick={ignoreSelectedProposals}
                >
                  忽略所选
                </button>
                <button
                  className="tw-bm-btn primary"
                  type="button"
                  disabled={!!busy || !selectedCount}
                  onClick={applySelectedProposals}
                >
                  应用所选 {selectedCount} 项
                </button>
              </footer>
            </>
          ) : null}
        </DialogPanel>
      </Dialog>
    );
  }

  function renderPublish(closing = false) {
    const check = remoteCheck || publishCheck || localPublishCheck(currentSystem!);
    return (
      <Dialog open onClose={() => setPublishOpen(false)} className="tw-bm-theme relative z-110">
        <DialogBackdrop className={`tw-bm-overlay ${closing ? 'is-closing' : ''}`} />
        <DialogPanel
          as="aside"
          className={`tw-bm-sheet narrow ${closing ? 'is-closing' : ''}`}
          aria-label="发布检查"
        >
          <header className="tw-bm-sheet-head">
            <div className="tw-bm-sheet-top">
              <span className="tw-bm-badge accent">发布检查</span>
              <span className="spacer" />
              <button
                className="tw-bm-icon-btn"
                type="button"
                onClick={() => setPublishOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <h2>发布当前业务地图</h2>
            <p>检查的是地图完整度，不是被分析系统本身是否存在缺陷。</p>
          </header>
          <div className="tw-bm-sheet-body">
            <div className="tw-bm-publish-score">
              <span>{check.score}</span>
              <div>
                <strong>{check.ok ? '可以发布' : '还有问题需要处理'}</strong>
                <p>
                  {currentSystem!.functions.length} 个功能 · {currentSystem!.flows.length} 条流程
                </p>
              </div>
            </div>
            <div className="tw-bm-publish-explain">
              <p>发布不会修改目标系统，而是把当前地图标记为一个可引用的正式版本。</p>
              <p>有阻断项时只能保留草稿；全部通过后才写入发布版本。</p>
              <p>发布后继续修改功能或流程，系统会自动回到「待发布」。</p>
            </div>
            <div className="tw-bm-checklist">
              {check.items.map((item) => (
                <button
                  type="button"
                  key={item.code}
                  onClick={() => {
                    if (item.code === 'pending_proposals') {
                      setPublishOpen(false);
                      openAi('review');
                    } else if (item.ref === 'flows') {
                      setPublishOpen(false);
                      setView('flows');
                    } else if (item.ref === 'functions') {
                      setPublishOpen(false);
                      setView('functions');
                    }
                  }}
                >
                  <span className={`check-icon ${item.level}`}>
                    {item.level === 'ok' ? '✓' : '!'}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.level === 'block'
                        ? '阻断发布，请先处理'
                        : item.level === 'warn'
                          ? '不阻断，建议补充'
                          : '结构校验通过'}
                    </small>
                  </span>
                  <i>→</i>
                </button>
              ))}
            </div>
            <div className="tw-bm-form-note">
              发布后生成新版本；人工确认字段会成为锁定字段，重新识别只追加建议。
            </div>
          </div>
          <footer className="tw-bm-sheet-foot">
            <button className="tw-bm-btn" type="button" onClick={() => setPublishOpen(false)}>
              取消
            </button>
            <span className="spacer" />
            <button
              className="tw-bm-btn primary"
              type="button"
              disabled={!!busy || !check.ok}
              onClick={publish}
            >
              发布新版本
            </button>
          </footer>
        </DialogPanel>
      </Dialog>
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

  return (
    <div className="tw-bm-page tw-bm-redesign">
      <header className="tw-bm-system-head">
        <button className="tw-bm-back-btn" type="button" onClick={() => setSystemId('')}>
          <PmIcon name="arrowLeft" size={14} />
          全部系统
        </button>
        <span className="tw-pm-page-ico" aria-hidden="true">
          <PmIcon name="folder" size={18} />
        </span>
        <div className="tw-bm-system-head-title">
          <h1 className="tw-page-title">{currentSystem.name}</h1>
          <p className="tw-page-desc">
            {currentSystem.functions.length} 个功能 · {currentSystem.flows.length} 条流程 ·{' '}
            {pending.length} 项待审核
          </p>
        </div>
        <span className="spacer" />
        <span
          className={`tw-bm-topbar-status ${currentSystem.status === 'published' ? 'is-published' : ''}`}
        >
          {currentSystem.status === 'published' ? '已发布' : '待发布'}
        </span>
        <button className="tw-bm-btn" type="button" onClick={openEditSystem}>
          <PmIcon name="sliders" size={14} />
          系统设置
        </button>
        <button className="tw-bm-btn" type="button" onClick={() => openAi('sources')}>
          AI 自动识别
        </button>
        <button className="tw-bm-btn" type="button" onClick={openPublish}>
          发布检查
        </button>
      </header>

      <nav className="tw-bm-system-nav" aria-label="系统视图">
        {(
          [
            { value: 'overview', label: '系统概览' },
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
              else if (tab.value === 'flows') showFlows();
              else setView('overview');
            }}
          >
            {tab.label}
            {tab.value !== 'overview' ? (
              <span>
                {tab.value === 'functions'
                  ? currentSystem.functions.length
                  : currentSystem.flows.length}
              </span>
            ) : null}
          </button>
        ))}
        <span className="spacer" />
        {pending.length ? (
          <button type="button" className="tw-bm-nav-review" onClick={() => openAi('review')}>
            {pending.length} 项提案待审核
            <PmIcon name="chevronRight" size={14} />
          </button>
        ) : null}
      </nav>

      {view === 'overview' ? (
        <BusinessMapOverview
          system={currentSystem}
          onFunctions={showFunctions}
          onFlows={showFlows}
          onNewFunction={startNewFunction}
          onNewFlow={() => openFlowModal()}
          onReview={() => openAi('review')}
          onPublish={openPublish}
          onAnalyze={() => openAi('sources')}
        />
      ) : (
        <div className="tw-bm-workbench">
          <aside className="tw-bm-context">
            <div className="tw-bm-context-head">
              <div>
                <strong>{view === 'functions' ? '业务域与功能' : '流程目录'}</strong>
                <span>
                  {view === 'functions'
                    ? `${domains.length} 个业务域`
                    : `${currentSystem.flows.length} 条业务流程`}
                </span>
              </div>
            </div>
            <label className="tw-bm-search">
              <PmIcon name="search" size={14} />
              <input
                aria-label={view === 'functions' ? '搜索功能' : '搜索流程'}
                name="businessMapSearch"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={view === 'functions' ? '筛选功能' : '筛选流程'}
              />
            </label>
            <div className="tw-bm-tree">
              {view === 'functions' ? (
                <>
                  <button
                    type="button"
                    className={`tw-bm-tree-domain ${domain === '全部' ? 'active' : ''}`}
                    onClick={() => setDomain('全部')}
                  >
                    <span>全部功能</span>
                    <small>{currentSystem.functions.length}</small>
                  </button>
                  {domains.map((name) => {
                    const items = currentSystem.functions.filter((item) => item.domain === name);
                    return (
                      <section key={name}>
                        <button
                          type="button"
                          className={`tw-bm-tree-domain ${domain === name ? 'active' : ''}`}
                          onClick={() => setDomain(name)}
                        >
                          <span>{name}</span>
                          <small>{items.length}</small>
                        </button>
                        {items
                          .filter((item) =>
                            filteredFunctions.some((filtered) => filtered.id === item.id),
                          )
                          .map((item) => (
                            <button
                              type="button"
                              key={item.id}
                              className={`tw-bm-tree-item ${item.id === selectedFunctionId && !functionDraft ? 'active' : ''}`}
                              onClick={() => {
                                setSelectedFunctionId(item.id);
                                setFunctionDraft(null);
                                setDetailTab('overview');
                                setDetailOpen(true);
                              }}
                            >
                              <span>{item.name}</span>
                              <i
                                className={
                                  item.confirmed
                                    ? 'confirmed'
                                    : item.confidence === 'low'
                                      ? 'warn'
                                      : 'ai'
                                }
                              />
                            </button>
                          ))}
                      </section>
                    );
                  })}
                </>
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
                        setDetailOpen(true);
                      }}
                    >
                      <span className="flow-no">{flow.code.replace('P', '')}</span>
                      <span>
                        {flow.name}
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
            {pending.length ? (
              <div className="tw-bm-pending-box">
                <strong>AI 识别尚未确认</strong>
                <p>{pending.length} 项候选内容等待审核，确认前不会进入正式地图。</p>
                <button
                  className="tw-bm-btn primary small"
                  type="button"
                  onClick={() => openAi('review')}
                >
                  查看识别结果
                </button>
              </div>
            ) : null}
          </aside>

          <main className="tw-bm-main">
            <header className="tw-bm-main-head">
              <div>
                <h1>{view === 'functions' ? '功能目录' : '业务流程'}</h1>
                <p>
                  {view === 'functions'
                    ? '先找到功能，再查看它服务哪条业务、由什么证据支撑。'
                    : '按实际执行顺序维护步骤；跨系统依赖直接挂在对应步骤下。'}
                </p>
              </div>
              <span className="spacer" />
              {view === 'functions' ? (
                <button className="tw-bm-btn primary" type="button" onClick={startNewFunction}>
                  ＋ 新建功能
                </button>
              ) : (
                <button className="tw-bm-btn primary" type="button" onClick={() => openFlowModal()}>
                  ＋ 新建流程
                </button>
              )}
            </header>

            {view === 'functions' ? (
              <div className="tw-bm-main-body">
                <div className="tw-bm-catalog-toolbar">
                  <SelectDropdown
                    compact
                    ariaLabel="功能维护状态筛选"
                    options={FUNCTION_FILTERS}
                    value={functionFilter}
                    onChange={setFunctionFilter}
                  />
                  <span className="tw-bm-catalog-scope">
                    {domain === '全部' ? '全部业务域' : domain}
                  </span>
                  {domain !== '全部' || query || functionFilter !== 'all' ? (
                    <button
                      type="button"
                      className="tw-bm-text-action"
                      onClick={() => {
                        setDomain('全部');
                        setQuery('');
                        setFunctionFilter('all');
                      }}
                    >
                      重置筛选
                    </button>
                  ) : null}
                  <span className="spacer" />
                  <span aria-live="polite">{filteredFunctions.length} 个功能</span>
                </div>
                <section className="tw-bm-function-list">
                  <header>
                    <span>功能</span>
                    <span>作用</span>
                    <span>关联流程</span>
                    <span>证据</span>
                  </header>
                  {filteredFunctions.map((item) => {
                    const refs = functionFlowRefs(currentSystem, item.id);
                    const flowCodes = [...new Set(refs.map((ref) => ref.flow.code))];
                    return (
                      <button
                        type="button"
                        key={item.id}
                        className={item.id === selectedFunctionId && !functionDraft ? 'active' : ''}
                        onClick={() => {
                          setSelectedFunctionId(item.id);
                          setFunctionDraft(null);
                          setDetailTab('overview');
                          setDetailOpen(true);
                        }}
                      >
                        <span className="name">
                          <strong>
                            {item.name}
                            {item.confirmed ? (
                              <i className="tw-bm-badge ok">已确认</i>
                            ) : (
                              <i className="tw-bm-badge warn">待确认</i>
                            )}
                          </strong>
                          <small>
                            {item.code} · {item.domain} / {item.module}
                          </small>
                        </span>
                        <span className="purpose">{item.purpose || '尚未填写功能作用'}</span>
                        <span className="flows">
                          {flowCodes.length ? flowCodes.join(' · ') : '未关联'}
                        </span>
                        <span className="evidence">
                          {item.evidence.slice(0, 4).map((evidence, index) => (
                            <i
                              className={sourceTone(evidence.type)}
                              key={`${evidence.title}-${index}`}
                            />
                          ))}
                          <small>{item.evidence.length} 条</small>
                        </span>
                      </button>
                    );
                  })}
                  {!filteredFunctions.length ? (
                    <div className="tw-bm-empty-inline">
                      <strong>没有匹配的功能</strong>
                      <p>
                        {currentSystem.functions.length
                          ? '调整搜索或维护状态筛选，查看其他功能。'
                          : '从一项真实业务能力开始整理。'}
                      </p>
                      {currentSystem.functions.length ? (
                        <button type="button" className="tw-bm-btn" onClick={() => showFunctions()}>
                          查看全部功能
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="tw-bm-btn primary"
                          onClick={startNewFunction}
                        >
                          新建功能
                        </button>
                      )}
                    </div>
                  ) : null}
                </section>
              </div>
            ) : (
              <div className="tw-bm-main-body">
                {currentFlow ? (
                  <>
                    <div className="tw-bm-flow-toolbar">
                      <div>
                        <h2>{currentFlow.name}</h2>
                        <span
                          className={`tw-bm-badge ${flowStatus(currentFlow) === '待补全' ? 'warn' : 'ok'}`}
                        >
                          {flowStatus(currentFlow)}
                        </span>
                      </div>
                      <span className="spacer" />
                      <button
                        className="tw-bm-btn"
                        type="button"
                        onClick={() => openFlowModal(true)}
                      >
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
                    <section className="tw-bm-flow-card">
                      <header>
                        <div>
                          <span>最终业务结果</span>
                          <strong>{currentFlow.result || '尚未填写最终结果'}</strong>
                        </div>
                        <div>
                          <strong>{currentFlow.steps.length}</strong>
                          <span>步骤</span>
                        </div>
                        <div>
                          <strong>{participantSystems(currentFlow).length}</strong>
                          <span>参与系统</span>
                        </div>
                        <div>
                          <strong>{currentFlow.steps.filter((step) => step.branch).length}</strong>
                          <span>分支</span>
                        </div>
                      </header>
                      <div className="tw-bm-participants">
                        <span>参与系统</span>
                        {participantSystems(currentFlow).map((system) => (
                          <span className="tw-bm-system-pill" key={system}>
                            {system}
                          </span>
                        ))}
                      </div>
                      <div className="tw-bm-flow-sequence">
                        {currentFlow.steps.map((step) => {
                          const fnItem = currentSystem.functions.find(
                            (item) => item.id === step.functionId,
                          );
                          return (
                            <div className="tw-bm-step-wrap" key={step.id}>
                              <button
                                type="button"
                                className={`tw-bm-flow-step ${step.id === currentStep?.id ? 'active' : ''} ${step.manual ? 'manual' : ''}`}
                                onClick={() => {
                                  setSelectedStepId(step.id);
                                  setStepDraft({ ...step, dependencies: [...step.dependencies] });
                                  setDetailOpen(true);
                                }}
                              >
                                <span className="step-no">{step.n}</span>
                                <span className="step-main">
                                  <strong>{step.title}</strong>
                                  <small>
                                    <span className="tw-bm-system-pill">{step.system}</span>
                                    {step.role} · {step.manual ? '人工环节' : '系统动作'}
                                  </small>
                                </span>
                                <span className="step-function">
                                  {fnItem?.name || '未关联功能'}
                                </span>
                                <span className="step-io">
                                  {step.input || step.output
                                    ? `${step.input || '输入'} → ${step.output || '输出'}`
                                    : '尚未填写输入输出'}
                                  <small>下一步：{step.next || '未设置'}</small>
                                </span>
                                <span className="step-edit">编辑 ›</span>
                              </button>
                              {step.dependencies.map((dep, index) => (
                                <div className="tw-bm-dependency" key={`${dep.system}-${index}`}>
                                  <span>↳</span>
                                  <span className="tw-bm-system-pill">{dep.system}</span>
                                  <span>{dep.label}</span>
                                </div>
                              ))}
                              {step.branch ? (
                                <div
                                  className={`tw-bm-branch ${step.branchBroken ? 'broken' : ''}`}
                                >
                                  <span>⑂</span>
                                  <span>{step.branch}</span>
                                  <i>{step.branchBroken ? '未连接' : '已连接'}</i>
                                </div>
                              ) : null}
                              {step.n < currentFlow.steps.length ? (
                                <button
                                  className="tw-bm-insert-step"
                                  type="button"
                                  onClick={() => addStep(step.id)}
                                >
                                  ＋ 在第 {step.n} 步后添加
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                        {!currentFlow.steps.length ? (
                          <div className="tw-bm-empty-inline">
                            <strong>流程还没有步骤</strong>
                            <p>按“触发 → 关键动作 → 结束状态”添加第一步。</p>
                            <button
                              className="tw-bm-btn primary small"
                              type="button"
                              onClick={() => addStep()}
                            >
                              ＋ 添加步骤
                            </button>
                          </div>
                        ) : null}
                      </div>
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
                        : '新建流程后，可以按角色和参与系统维护纵向步骤。'}
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
              onClick={() => setDetailOpen(false)}
            />
          ) : null}
          {detailPresence.mounted ? (
            <aside className={`tw-bm-detail ${detailPresence.closing ? 'is-closing' : ''}`}>
              {view === 'functions' ? (
                functionDraft ? (
                  <>
                    <header className="tw-bm-detail-head">
                      <div className="tw-bm-detail-titlebar">
                        <span className="tw-bm-badge warn">
                          {functionIsNew ? '新建' : '编辑中'}
                        </span>
                        <span className="spacer" />
                        <button
                          className="tw-bm-detail-close"
                          type="button"
                          onClick={() => setDetailOpen(false)}
                          aria-label="关闭详情"
                        >
                          ×
                        </button>
                      </div>
                      <h2>{functionIsNew ? '新建功能' : '编辑功能'}</h2>
                      <p>保存后进入待发布草稿；人工填写字段会被保护。</p>
                    </header>
                    <div className="tw-bm-detail-body">
                      <div className="tw-bm-form compact">
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
                          <span>一句话作用</span>
                          <textarea
                            name="functionPurpose"
                            rows={3}
                            value={functionDraft.purpose}
                            onChange={(event) =>
                              setFunctionDraft({ ...functionDraft, purpose: event.target.value })
                            }
                          />
                        </label>
                        <div className="two">
                          <label>
                            <span>业务域</span>
                            <input
                              name="functionDomain"
                              value={functionDraft.domain}
                              onChange={(event) =>
                                setFunctionDraft({ ...functionDraft, domain: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            <span>模块</span>
                            <input
                              name="functionModule"
                              value={functionDraft.module}
                              onChange={(event) =>
                                setFunctionDraft({ ...functionDraft, module: event.target.value })
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
                              setFunctionDraft({ ...functionDraft, roles: event.target.value })
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
                          <span>业务规则（一行一条）</span>
                          <textarea
                            name="functionRules"
                            rows={4}
                            value={functionDraft.rules}
                            onChange={(event) =>
                              setFunctionDraft({ ...functionDraft, rules: event.target.value })
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
                                setFunctionDraft({ ...functionDraft, inputs: event.target.value })
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
                                setFunctionDraft({ ...functionDraft, outputs: event.target.value })
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
                              setFunctionDraft({ ...functionDraft, writes: event.target.value })
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
                              setFunctionDraft({ ...functionDraft, exceptions: event.target.value })
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
                        <label>
                          <span>证据（格式：page/doc/code|标题|位置）</span>
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
                      {!functionIsNew ? (
                        <button
                          className="tw-bm-btn danger"
                          type="button"
                          onClick={removeCurrentFunction}
                        >
                          删除
                        </button>
                      ) : null}
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
                        <span className="tw-bm-badge accent">{currentFunction.domain}</span>
                        <span className="tw-bm-badge">{currentFunction.status}</span>
                        <span className="spacer" />
                        <button
                          className="tw-bm-detail-close"
                          type="button"
                          onClick={() => setDetailOpen(false)}
                          aria-label="关闭详情"
                        >
                          ×
                        </button>
                      </div>
                      <h2>{currentFunction.name}</h2>
                      <p>
                        {currentFunction.code} · {currentFunction.module} ·{' '}
                        {selectedFunctionRefGroups.length} 条流程引用
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
                              <strong>{currentFunction.roles.join('、') || '未填写'}</strong>
                              <span>入口</span>
                              <strong>{currentFunction.entry || '未填写'}</strong>
                              <span>输入</span>
                              <strong>{currentFunction.inputs.join('、') || '未填写'}</strong>
                              <span>输出</span>
                              <strong>{currentFunction.outputs.join('、') || '未填写'}</strong>
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
                              <div
                                className="tw-bm-evidence-item"
                                key={`${evidence.title}-${index}`}
                              >
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
                      <button className="tw-bm-btn" type="button" onClick={() => openAi('sources')}>
                        ＋ 证据
                      </button>
                      <span className="spacer" />
                      <button
                        className="tw-bm-btn"
                        type="button"
                        onClick={() => openAi('sources', currentFunction.id)}
                      >
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
                      onClick={() => setDetailOpen(false)}
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
                        onClick={() => setDetailOpen(false)}
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
                    onClick={() => setDetailOpen(false)}
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
      )}

      {systemModal ? renderSystemModal() : null}
      {flowModal ? renderFlowModal() : null}
      {aiPresence.mounted ? renderAiDrawer(aiPresence.closing) : null}
      {publishPresence.mounted ? renderPublish(publishPresence.closing) : null}
      {confirm ? renderConfirm() : null}
    </div>
  );
}
