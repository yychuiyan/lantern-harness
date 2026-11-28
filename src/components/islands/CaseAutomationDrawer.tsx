import { useCallback, useEffect, useMemo, useState } from 'react';

import { loadBusinessMap, type BusinessFlow, type BusinessMapStore } from '../../lib/business-map';
import {
  applyCaseAutomation,
  assessCaseAutomation,
  createCaseAutomationFlow,
  fetchCaseAutomationFlows,
  fetchCaseAutomationIterations,
  getCaseAutomationBatch,
  getCaseAutomationSource,
  getCaseAutomationSelection,
  previewCaseAutomationFlow,
  startCaseAutomationBatch,
  type CaseAutomationAssessment,
  type CaseAutomationAssessmentItem,
  type CaseAutomationBatch,
  type CaseAutomationFlowCase,
  type CaseAutomationFlowDraft,
  type CaseAutomationIterationInfo,
} from '../../lib/case-automation';
import type { CaseExecutionCase, CaseExecutionDocument } from '../../lib/case-execution';
import { fetchProjects, updateProject, type UiAutoProject } from '../../lib/ui-auto';
import { writeViewText } from '../../lib/view-prefs';
import SelectDropdown from './SelectDropdown';
import SlideOverDrawer from './SlideOverDrawer';
import { showToast } from './Toast';

const DECISION_LABEL = {
  automatable: '可自动生成',
  needs_manual: '需人工执行',
  not_automatable: '不进 UI 自动化',
} as const;

const DECISION_TONE = {
  automatable: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  needs_manual: 'border-amber-200 bg-amber-50 text-amber-700',
  not_automatable: 'border-stone-200 bg-stone-50 text-stone-500',
} as const;

const SOURCE_STATUS_LABEL: Record<string, string> = {
  not_configured: '未评估',
  automatable: '可自动化',
  needs_manual: '需人工',
  needs_role: '待绑角色',
  not_automatable: '不可自动化',
  connected: '已接入',
  running: '运行中',
  passed: '已通过',
  failed: '异常',
  partial: '部分执行',
  stale: '已过期',
  not_applicable: '不适用',
};

const SOURCE_STATUS_TONE: Record<string, string> = {
  not_configured: 'border-stone-200 bg-stone-50 text-stone-500',
  automatable: 'border-sky-200 bg-sky-50 text-sky-700',
  needs_manual: 'border-amber-200 bg-amber-50 text-amber-700',
  needs_role: 'border-orange-200 bg-orange-50 text-orange-700',
  not_automatable: 'border-stone-200 bg-stone-50 text-stone-500',
  connected: 'border-blue-200 bg-blue-50 text-blue-700',
  running: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  passed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
  partial: 'border-orange-200 bg-orange-50 text-orange-700',
  stale: 'border-amber-200 bg-amber-50 text-amber-700',
  not_applicable: 'border-stone-200 bg-stone-50 text-stone-400',
};

const EXECUTION_LABEL = { auto: '自动执行', manual: '手动执行' } as const;
const STABILITY_LABEL = {
  stable: '稳定',
  relationship: '关联流程',
  exploratory: '探索型',
} as const;
const SCOPE_LABEL = {
  keep: '保留功能范围',
  move_to_api: '转接口测试',
  move_to_perf: '转性能测试',
  retire: '建议下线',
} as const;
const CHECKPOINT_LABEL: Record<string, string> = {
  pending: '待运行',
  passed: '通过',
  failed: '失败',
  blocked: '阻塞',
  not_reached: '未执行',
  skipped: '跳过',
};

type Tab = 'atomic' | 'flow';
type AtomicItem = NonNullable<CaseExecutionCase['automation']>['items'][number] & {
  sourceCaseId: string;
  sourceCaseNo: string;
  sourceTitle: string;
  module: string;
  priority: string;
};

function statusBadge(status: string, label = SOURCE_STATUS_LABEL[status] || status) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${
        SOURCE_STATUS_TONE[status] || SOURCE_STATUS_TONE.not_configured
      }`}
    >
      {label}
    </span>
  );
}

function splitStepText(value: string) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export default function CaseAutomationDrawer({
  open,
  casePath,
  initialCaseId = '',
  onClose,
  onApplied,
}: {
  open: boolean;
  casePath: string;
  initialCaseId?: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [tab, setTab] = useState<Tab>('atomic');
  const [document, setDocument] = useState<CaseExecutionDocument | null>(null);
  const [projects, setProjects] = useState<UiAutoProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [iterationInfo, setIterationInfo] = useState<CaseAutomationIterationInfo | null>(null);
  const [iteration, setIteration] = useState('');
  const [creatingIteration, setCreatingIteration] = useState(false);
  const [rememberedIteration, setRememberedIteration] = useState('');
  const [newIteration, setNewIteration] = useState('');
  const [selectedCases, setSelectedCases] = useState<Record<string, boolean>>({});
  const [assessmentRuns, setAssessmentRuns] = useState<CaseAutomationAssessment[]>([]);
  const [selectedAssessments, setSelectedAssessments] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<
    Record<string, NonNullable<UiAutoProject['roles']>[number]>
  >({});
  const [sourceQuery, setSourceQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [flows, setFlows] = useState<CaseAutomationFlowCase[]>([]);
  const [businessMap, setBusinessMap] = useState<BusinessMapStore | null>(null);
  const [flowSelected, setFlowSelected] = useState<Record<string, boolean>>({});
  const [flowOrder, setFlowOrder] = useState<string[]>([]);
  const [flowKind, setFlowKind] = useState<'smoke' | 'regression'>('smoke');
  const [flowTitle, setFlowTitle] = useState('');
  const [flowEnv, setFlowEnv] = useState('');
  const [businessSystemId, setBusinessSystemId] = useState('');
  const [businessFlowId, setBusinessFlowId] = useState('');
  const [autoSupplementBusinessMap, setAutoSupplementBusinessMap] = useState(true);
  const [flowQuery, setFlowQuery] = useState('');
  const [flowDraft, setFlowDraft] = useState<CaseAutomationFlowDraft | null>(null);
  const [createdFlow, setCreatedFlow] = useState<CaseAutomationFlowCase | null>(null);
  const [flowBusy, setFlowBusy] = useState(false);
  const [runningFlowId, setRunningFlowId] = useState('');
  const [flowRun, setFlowRun] = useState<CaseAutomationBatch | null>(null);

  const supportedProjects = useMemo(
    () =>
      projects.filter(
        (project) => project.kind === 'ui' && project.framework === 'playwright' && project.exists,
      ),
    [projects],
  );

  const reloadSource = useCallback(async () => {
    if (!casePath) return null;
    const next = await getCaseAutomationSource(casePath);
    setDocument(next);
    return next;
  }, [casePath]);

  const load = useCallback(async () => {
    if (!casePath) return;
    setBusy(true);
    setError('');
    setAssessmentRuns([]);
    setSelectedAssessments({});
    setFlowDraft(null);
    setCreatedFlow(null);
    setFlowSelected({});
    setFlowOrder([]);
    setFlowEnv('');
    setBusinessSystemId('');
    setBusinessFlowId('');
    setFlowTitle('');
    setRoleDrafts({});
    setFlowRun(null);
    setRunningFlowId('');
    try {
      const [file, projectData, selection] = await Promise.all([
        getCaseAutomationSource(casePath),
        fetchProjects(),
        getCaseAutomationSelection(casePath),
      ]);
      setDocument(file);
      setProjects(projectData.projects || []);
      setRememberedIteration(selection?.iteration || '');
      setProjectId(selection?.projectId || '');
      setIteration('');
      setCreatingIteration(false);
      const selectedIds =
        initialCaseId && file.cases.some((item) => item.id === initialCaseId)
          ? [initialCaseId]
          : file.cases.map((item) => item.id);
      setSelectedCases(Object.fromEntries(selectedIds.map((id) => [id, true])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [casePath, initialCaseId]);

  const loadFlows = useCallback(async () => {
    const [flowData, mapData] = await Promise.all([
      fetchCaseAutomationFlows(casePath).catch(() => ({ flows: [] })),
      loadBusinessMap().catch(() => null),
    ]);
    setFlows(flowData.flows || []);
    setBusinessMap(mapData);
  }, [casePath]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  useEffect(() => {
    if (open) void loadFlows();
  }, [loadFlows, open]);

  useEffect(() => {
    if (!open || !projectId) {
      setIterationInfo(null);
      setIteration('');
      return;
    }
    setError('');
    void fetchCaseAutomationIterations(projectId, casePath)
      .then((data) => {
        setIterationInfo(data);
        setIteration(data.suggestedIteration || rememberedIteration || '');
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [casePath, open, projectId, rememberedIteration]);

  const sourceCases = useMemo(() => document?.cases || [], [document]);
  const selectedSourceIds = sourceCases
    .filter((item) => selectedCases[item.id])
    .map((item) => item.id);
  const unassessedCount = sourceCases.filter(
    (item) => (item.automation?.status || 'not_configured') === 'not_configured',
  ).length;
  const assessment = useMemo<CaseAutomationAssessment | null>(
    () =>
      assessmentRuns.length
        ? {
            ...assessmentRuns[assessmentRuns.length - 1]!,
            id: 'batched',
            cases: assessmentRuns.flatMap((run) => run.cases),
          }
        : null,
    [assessmentRuns],
  );
  const assessmentCounts = useMemo(
    () => ({
      auto: assessment?.cases.filter((item) => item.executionMode === 'auto').length || 0,
      manual: assessment?.cases.filter((item) => item.executionMode === 'manual').length || 0,
      automatable: assessment?.cases.filter((item) => item.decision === 'automatable').length || 0,
      needsManual: assessment?.cases.filter((item) => item.decision === 'needs_manual').length || 0,
      notAutomatable:
        assessment?.cases.filter((item) => item.decision === 'not_automatable').length || 0,
      flowRequired: assessment?.cases.filter((item) => item.flowRequired).length || 0,
    }),
    [assessment],
  );
  const project = projects.find((item) => item.id === projectId) || null;
  const selectedAssessmentItems = useMemo(
    () =>
      (assessment?.cases || []).filter((item) =>
        item.automationCases.some(
          (automationCase) => selectedAssessments[automationCase.automationCaseId],
        ),
      ),
    [assessment, selectedAssessments],
  );
  const requiredRoles = useMemo(() => {
    const map = new Map<string, { roleId: string; roleName: string; reason: string }>();
    for (const item of selectedAssessmentItems) {
      const selectedCases = item.automationCases.filter(
        (automationCase) => selectedAssessments[automationCase.automationCaseId],
      );
      const roles = [
        ...item.requiredRoles,
        ...selectedCases.flatMap((automationCase) => [
          ...(automationCase.actorRoleId
            ? [
                {
                  roleId: automationCase.actorRoleId,
                  roleName: automationCase.actorRoleId,
                  reason: '',
                },
              ]
            : []),
          ...(automationCase.requiredRoleIds || []).map((roleId) => ({
            roleId,
            roleName: roleId,
            reason: '',
          })),
        ]),
      ];
      for (const role of roles) {
        if (!map.has(role.roleId)) map.set(role.roleId, role);
      }
    }
    return [...map.values()];
  }, [selectedAssessmentItems, selectedAssessments]);
  const missingRoleBindings = requiredRoles.filter((role) => {
    const bound = project?.roles?.find((item) => item.id === role.roleId);
    return !bound?.storageState || bound.status === 'invalid';
  });
  const selectedAutomationCount = Object.values(selectedAssessments).filter(Boolean).length;

  const atomicItems = useMemo<AtomicItem[]>(
    () =>
      sourceCases.flatMap((sourceCase) =>
        (sourceCase.automation?.items || [])
          .filter((item) => item.caseKind !== 'flow')
          .map((item) => ({
            ...item,
            sourceCaseId: sourceCase.id,
            sourceCaseNo: sourceCase.no,
            sourceTitle: sourceCase.title,
            module: sourceCase.module,
            priority: sourceCase.priority,
          })),
      ),
    [sourceCases],
  );
  const eligibleFlowItems = atomicItems.filter(
    (item) =>
      ['connected', 'passed'].includes(item.status) &&
      !item.error &&
      (item.status === 'passed' || Boolean(item.scriptPath)),
  );
  const selectedFlowItems = flowOrder
    .map((id) => eligibleFlowItems.find((item) => item.automationCaseId === id))
    .filter((item): item is AtomicItem => Boolean(item));
  const flowRoleIds = [
    ...new Set(
      selectedFlowItems.flatMap((item) => [
        ...(item.actorRoleId ? [item.actorRoleId] : []),
        ...(item.requiredRoleIds || []),
      ]),
    ),
  ];
  const flowRoles = flowRoleIds.map((roleId) => {
    const bound = project?.roles?.find((item) => item.id === roleId);
    const sourceItem = selectedFlowItems.find(
      (item) => item.actorRoleId === roleId || item.requiredRoleIds?.includes(roleId),
    );
    return {
      roleId,
      roleName: bound?.name || sourceItem?.actorRoleId || roleId,
      reason: sourceItem?.sourceTitle || '',
    };
  });
  const flowMissingRoleBindings = flowRoleIds.filter((roleId) => {
    const role = project?.roles?.find((item) => item.id === roleId);
    return !role?.storageState || role.status === 'invalid';
  });
  const selectedSystem = businessMap?.systems.find((item) => item.id === businessSystemId) || null;
  const businessFlowOptions = selectedSystem?.flows || [];
  const filteredSourceCases = sourceCases.filter((item) => {
    const status = item.automation?.status || 'not_configured';
    const matchQuery =
      !sourceQuery.trim() ||
      `${item.no} ${item.title} ${item.module} ${item.priority}`
        .toLowerCase()
        .includes(sourceQuery.trim().toLowerCase());
    const matchStatus =
      sourceFilter === 'all' ||
      (sourceFilter === 'manual' && item.automation?.status === 'needs_manual') ||
      (sourceFilter === 'auto' &&
        ['automatable', 'connected', 'passed', 'running', 'partial'].includes(status)) ||
      (sourceFilter === 'problem' && ['failed', 'stale', 'needs_role'].includes(status)) ||
      (sourceFilter === 'not_configured' && status === 'not_configured');
    return matchQuery && matchStatus;
  });
  const filteredAssessmentCases = (assessment?.cases || []).filter((item) => {
    const matchQuery =
      !sourceQuery.trim() ||
      `${item.sourceCaseNo} ${item.sourceTitle}`
        .toLowerCase()
        .includes(sourceQuery.trim().toLowerCase());
    const matchFilter =
      sourceFilter === 'all' ||
      (sourceFilter === 'auto' && item.executionMode === 'auto') ||
      (sourceFilter === 'manual' && item.executionMode === 'manual') ||
      (sourceFilter === 'problem' && item.decision !== 'automatable');
    return matchQuery && matchFilter;
  });
  const filteredFlowItems = eligibleFlowItems.filter((item) => {
    if (!flowQuery.trim()) return true;
    return `${item.automationCaseId} ${item.title} ${item.sourceTitle} ${item.module}`
      .toLowerCase()
      .includes(flowQuery.trim().toLowerCase());
  });

  async function assess() {
    if (!projectId || !iteration || !selectedSourceIds.length) return;
    setBusy(true);
    setError('');
    setAssessmentRuns([]);
    setSelectedAssessments({});
    setFlowDraft(null);
    const batchSize = 20;
    const runs: CaseAutomationAssessment[] = [];
    const failures: string[] = [];
    try {
      for (let offset = 0; offset < selectedSourceIds.length; offset += batchSize) {
        const batch = selectedSourceIds.slice(offset, offset + batchSize);
        const batchNo = Math.floor(offset / batchSize) + 1;
        const batchCount = Math.ceil(selectedSourceIds.length / batchSize);
        setProgress(`正在评估第 ${batchNo}/${batchCount} 批 · ${batch.length} 条`);
        try {
          const data = await assessCaseAutomation({
            casePath,
            caseIds: batch,
            projectId,
            iteration,
          });
          runs.push(data.assessment);
        } catch (reason) {
          failures.push(
            `第 ${batchNo} 批：${reason instanceof Error ? reason.message : String(reason)}`,
          );
        }
      }
      if (!runs.length) throw new Error(failures[0] || '自动化评估失败');
      setAssessmentRuns(runs);
      setSelectedAssessments(
        Object.fromEntries(
          runs
            .flatMap((run) => run.cases)
            .flatMap((item) =>
              item.executionMode === 'auto'
                ? item.automationCases.map((automationCase) => [
                    automationCase.automationCaseId,
                    true,
                  ])
                : [],
            ),
        ),
      );
      if (failures.length) setError(`部分批次失败，可继续使用已完成结果：\n${failures.join('\n')}`);
      await reloadSource();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProgress('');
      setBusy(false);
    }
  }

  async function apply() {
    if (!assessmentRuns.length) return;
    setFlowDraft(null);
    setCreatedFlow(null);
    const automationIds = Object.keys(selectedAssessments).filter((id) => selectedAssessments[id]);
    if (!automationIds.length) {
      setError('请至少选择一条可自动化的原子用例');
      return;
    }
    if (missingRoleBindings.length) {
      setError(
        `请先绑定以下角色的 storageState：${missingRoleBindings
          .map((role) => role.roleName)
          .join('、')}`,
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      let generated = 0;
      for (const [index, run] of assessmentRuns.entries()) {
        const chosenIds = run.cases.flatMap((item) =>
          item.automationCases
            .filter((automationCase) => selectedAssessments[automationCase.automationCaseId])
            .map((automationCase) => automationCase.automationCaseId),
        );
        if (!chosenIds.length) continue;
        const sourceIds = run.cases
          .filter((item) =>
            item.automationCases.some((automationCase) =>
              chosenIds.includes(automationCase.automationCaseId),
            ),
          )
          .map((item) => item.sourceCaseId);
        setProgress(`正在写入第 ${index + 1}/${assessmentRuns.length} 批评估结果`);
        const result = await applyCaseAutomation({
          assessmentId: run.id,
          selectedSourceCaseIds: sourceIds,
          selectedAutomationCaseIds: chosenIds,
        });
        generated += result.links?.length ?? 0;
      }
      showToast(`已生成 ${generated} 条原子自动化用例`, 'success');
      await reloadSource();
      onApplied();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProgress('');
      setBusy(false);
    }
  }

  function roleDraft(role: { roleId: string; roleName: string }) {
    return (
      roleDrafts[role.roleId] ||
      project?.roles?.find((item) => item.id === role.roleId) || {
        id: role.roleId,
        name: role.roleName,
        description: '',
        usernameEnv: '',
        passwordEnv: '',
        storageState: '',
        status: 'unbound' as const,
        lastCheckedAt: '',
      }
    );
  }

  function updateRoleDraft(
    role: { roleId: string; roleName: string },
    field: 'description' | 'usernameEnv' | 'passwordEnv' | 'storageState',
    value: string,
  ) {
    const current = roleDraft(role);
    setRoleDrafts((drafts) => ({
      ...drafts,
      [role.roleId]: { ...current, [field]: value },
    }));
  }

  async function saveRole(role: { roleId: string; roleName: string }) {
    if (!project) return;
    const draft = roleDraft(role);
    setBusy(true);
    setError('');
    try {
      const nextRole = {
        ...draft,
        id: role.roleId,
        name: role.roleName,
        status: draft.storageState ? ('ready' as const) : ('unbound' as const),
      };
      const nextRoles = [
        ...(project.roles || []).filter((item) => item.id !== role.roleId),
        nextRole,
      ];
      const updated = await updateProject({ id: project.id, roles: nextRoles });
      setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setRoleDrafts((current) => ({ ...current, [role.roleId]: nextRole }));
      setFlowDraft(null);
      showToast(`角色「${role.roleName}」已保存`, 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function flowPayload() {
    return {
      casePath,
      projectId,
      iteration,
      automationCaseIds: selectedFlowItems.map((item) => item.automationCaseId),
      title: flowTitle.trim(),
      kind: flowKind,
      businessSystemId,
      businessFlowId,
      autoSupplementBusinessMap,
      expectedBusinessMapRevision: flowDraft?.mapPatch?.revisionBefore,
    };
  }

  async function previewFlow() {
    if (!projectId || !iteration || selectedFlowItems.length < 2) return;
    if (flowMissingRoleBindings.length) {
      setError(
        `请先绑定角色：${flowMissingRoleBindings
          .map((roleId) => project?.roles?.find((role) => role.id === roleId)?.name || roleId)
          .join('、')}`,
      );
      return;
    }
    setFlowBusy(true);
    setError('');
    setCreatedFlow(null);
    try {
      const draft = await previewCaseAutomationFlow(flowPayload());
      setFlowDraft(draft);
    } catch (reason) {
      setFlowDraft(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFlowBusy(false);
    }
  }

  async function createFlow() {
    if (!flowDraft) return;
    setFlowBusy(true);
    setError('');
    try {
      const result = await createCaseAutomationFlow(flowPayload());
      setCreatedFlow(result.flow);
      setFlowDraft(result.draft);
      await Promise.all([reloadSource(), loadFlows()]);
      onApplied();
      showToast('冒烟/回归流程用例已生成并写入 iteration 文件', 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFlowBusy(false);
    }
  }

  async function runFlow(flow: CaseAutomationFlowCase) {
    if (runningFlowId) return;
    setError('');
    setRunningFlowId(flow.flowCaseId);
    setFlowRun(null);
    try {
      const started = await startCaseAutomationBatch({
        automationCaseIds: [flow.flowCaseId],
        env: flowEnv.trim(),
      });
      setFlowRun(started.batch);
      void (async () => {
        try {
          let current = started.batch;
          while (['pending', 'running'].includes(current.status)) {
            await new Promise((resolve) => window.setTimeout(resolve, 1200));
            current = (await getCaseAutomationBatch(current.id)).batch;
            setFlowRun(current);
          }
          await loadFlows();
          onApplied();
          const failed = current.items.find((item) => ['failed', 'blocked'].includes(item.status));
          if (failed?.error) setError(`流程运行未通过：${failed.error}`);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          setRunningFlowId('');
        }
      })();
    } catch (reason) {
      setRunningFlowId('');
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function openGenerationSession(sessionId: string) {
    if (!projectId || !sessionId) return;
    writeViewText('ui-auto.project', projectId);
    writeViewText(`ui-auto.gen.session.${projectId}`, sessionId);
    const base = import.meta.env.BASE_URL || '/';
    window.location.href = `${base}test-automation/`;
  }

  function resetAssessmentState() {
    setAssessmentRuns([]);
    setSelectedAssessments({});
    setFlowDraft(null);
    setCreatedFlow(null);
  }

  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      title="功能用例转自动化"
      widthClass="max-w-5xl"
      bodyClassName="flex min-h-0 flex-col gap-4 overflow-hidden"
      footer={
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-stone-100 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <span className="min-w-0 truncate text-xs text-stone-500">
            {tab === 'atomic'
              ? assessment
                ? `自动 ${assessmentCounts.auto} · 手动 ${assessmentCounts.manual} · 已选原子 ${selectedAutomationCount}${missingRoleBindings.length ? ` · 缺角色 ${missingRoleBindings.length}` : ''}`
                : `已选 ${selectedSourceIds.length} / ${sourceCases.length} 条 · 未评估 ${unassessedCount} 条`
              : `已选 ${selectedFlowItems.length} 条原子用例 · 至少选 2 条${flowMissingRoleBindings.length ? ` · 缺角色 ${flowMissingRoleBindings.length}` : ''}`}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || flowBusy || Boolean(runningFlowId)}
              onClick={onClose}
              className="h-9 rounded-lg border border-stone-200 px-3 text-sm text-stone-600"
            >
              关闭
            </button>
            {tab === 'atomic' ? (
              assessment ? (
                <button
                  type="button"
                  disabled={busy || !selectedAutomationCount || missingRoleBindings.length > 0}
                  onClick={() => void apply()}
                  className="h-9 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white disabled:opacity-40"
                >
                  {busy ? progress || '正在生成…' : '生成原子自动化用例'}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || !projectId || !iteration || selectedSourceIds.length === 0}
                  onClick={() => void assess()}
                  className="h-9 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white disabled:opacity-40"
                >
                  {busy ? progress || '识别评估中…' : '开始识别评估'}
                </button>
              )
            ) : flowDraft ? (
              <button
                type="button"
                disabled={flowBusy || Boolean(createdFlow)}
                onClick={() => void createFlow()}
                className="h-9 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white disabled:opacity-40"
              >
                {flowBusy ? '正在生成流程…' : createdFlow ? '流程已生成' : '确认并生成流程'}
              </button>
            ) : (
              <button
                type="button"
                disabled={
                  flowBusy ||
                  !projectId ||
                  !iteration ||
                  selectedFlowItems.length < 2 ||
                  flowMissingRoleBindings.length > 0 ||
                  (autoSupplementBusinessMap && !businessSystemId)
                }
                onClick={() => void previewFlow()}
                className="h-9 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white disabled:opacity-40"
              >
                {flowBusy ? '正在生成预览…' : '预览流程与地图补全'}
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex shrink-0 gap-1 rounded-lg bg-stone-100 p-1">
        {[
          ['atomic', '原子自动化用例'],
          ['flow', '冒烟 / 回归流程'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value as Tab)}
            className={`h-8 flex-1 rounded-md text-sm font-medium transition ${
              tab === value
                ? 'bg-white text-stone-800 shadow-sm'
                : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <section className="grid shrink-0 gap-3 rounded-lg border border-stone-200 bg-stone-50 p-4 md:grid-cols-2">
        <label>
          <span className="mb-1 block text-xs font-medium text-stone-600">UI 自动化项目</span>
          <SelectDropdown
            value={projectId}
            onChange={(value) => {
              setProjectId(value);
              setIteration('');
              setFlowEnv('');
              setCreatingIteration(false);
              resetAssessmentState();
              setFlowSelected({});
              setFlowOrder([]);
              setRoleDrafts({});
            }}
            options={supportedProjects.map((item) => ({
              value: item.id,
              label: item.name,
              secondary: `${item.frameworkLabel} · ${item.baseURL || item.detectedBaseURL || '未配置地址'}`,
            }))}
            ariaLabel="选择 UI 自动化项目"
            searchable
            searchPlaceholder="搜索自动化项目…"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs font-medium text-stone-600">迭代版本</span>
          <SelectDropdown
            value={creatingIteration ? '__new__' : iteration}
            onChange={(value) => {
              if (value === '__new__') {
                setCreatingIteration(true);
                setIteration('');
                setNewIteration('');
              } else {
                setCreatingIteration(false);
                setIteration(value);
                setNewIteration('');
              }
              setFlowEnv('');
              resetAssessmentState();
            }}
            options={[
              ...(iterationInfo?.files || []).map((item) => ({
                value: item.name.replace(/\.spec\.ts$/i, ''),
                label: item.name.replace(/\.spec\.ts$/i, ''),
              })),
              { value: '__new__', label: '＋ 创建新迭代' },
            ]}
            ariaLabel="选择迭代版本"
            searchable
            searchPlaceholder="搜索迭代版本…"
            disabled={!projectId}
          />
        </label>
        {creatingIteration ? (
          <label className="md:col-span-2">
            <span className="mb-1 block text-xs font-medium text-stone-600">新迭代版本</span>
            <input
              value={newIteration}
              onChange={(event) => {
                setNewIteration(event.target.value);
                setIteration(event.target.value.trim());
              }}
              placeholder="例如 v1.12"
              className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm outline-none focus:border-[#4176e6]"
            />
            <span className="mt-1 block text-[11px] text-stone-400">
              将创建到 {iterationInfo?.iterationDir || 'tests/iteration'}/
              {newIteration.trim() || '<迭代>'}.spec.ts
            </span>
          </label>
        ) : null}
      </section>

      {!supportedProjects.length ? (
        <div className="shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-4 py-5 text-sm text-amber-800">
          没有可生成脚本的 UI 自动化项目。请先在「自动化项目」挂载 Playwright 项目。
        </div>
      ) : null}

      {error ? (
        <div className="max-h-28 shrink-0 overflow-y-auto whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {tab === 'atomic' ? (
        <>
          <div className="grid shrink-0 gap-2 md:grid-cols-[minmax(0,1fr)_180px]">
            <input
              value={sourceQuery}
              onChange={(event) => setSourceQuery(event.target.value)}
              placeholder="搜索用例编号、标题、模块或优先级"
              className="h-9 rounded-lg border border-stone-200 bg-white px-3 text-sm outline-none focus:border-[#4176e6]"
            />
            <SelectDropdown
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'auto', label: '自动执行' },
                { value: 'manual', label: '手动执行' },
                { value: 'problem', label: '需处理 / 异常' },
                { value: 'not_configured', label: '未评估' },
              ]}
              ariaLabel="按自动化状态筛选"
            />
          </div>

          {assessment && requiredRoles.length ? (
            <RoleBindingPanel
              roles={requiredRoles}
              project={project}
              drafts={roleDrafts}
              busy={busy}
              draftFor={roleDraft}
              onChange={updateRoleDraft}
              onSave={(role) => void saveRole(role)}
            />
          ) : null}

          {!assessment ? (
            <section className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-stone-800">评估范围</h3>
                  <p className="mt-1 text-xs leading-5 text-stone-500">
                    每批 20 条自动分片评估，失败批次可重试且不会覆盖已完成批次。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedCases(
                      Object.fromEntries(filteredSourceCases.map((item) => [item.id, true])),
                    )
                  }
                  className="shrink-0 text-xs text-[#4176e6] hover:underline"
                >
                  全选当前筛选
                </button>
              </div>
              <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {filteredSourceCases.map((item) => (
                  <label
                    key={item.id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-stone-200 px-3 py-2.5 hover:bg-stone-50"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(selectedCases[item.id])}
                      onChange={(event) =>
                        setSelectedCases((current) => ({
                          ...current,
                          [item.id]: event.target.checked,
                        }))
                      }
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800">
                          {item.no ? `#${item.no} ` : ''}
                          {item.title}
                        </span>
                        {statusBadge(item.automation?.status || 'not_configured')}
                      </span>
                      <span className="mt-1 block line-clamp-2 text-xs leading-5 text-stone-500">
                        {[item.module, item.priority, splitStepText(item.steps)[0]]
                          .filter(Boolean)
                          .join(' · ') || '缺少步骤与预期'}
                      </span>
                    </span>
                  </label>
                ))}
                {!sourceCases.length ? (
                  <div className="rounded-lg border border-dashed border-stone-200 px-4 py-10 text-center text-sm text-stone-400">
                    当前文件没有可评估用例
                  </div>
                ) : !filteredSourceCases.length ? (
                  <div className="rounded-lg border border-dashed border-stone-200 px-4 py-10 text-center text-sm text-stone-400">
                    没有符合筛选条件的用例
                  </div>
                ) : null}
              </div>
            </section>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <AssessmentPreview
                assessment={assessment}
                cases={filteredAssessmentCases}
                selected={selectedAssessments}
                counts={assessmentCounts}
                onToggle={(id) => {
                  setSelectedAssessments((current) => ({ ...current, [id]: !current[id] }));
                  setFlowDraft(null);
                }}
              />
            </div>
          )}
        </>
      ) : (
        <>
          {flowRoles.length ? (
            <RoleBindingPanel
              roles={flowRoles}
              project={project}
              drafts={roleDrafts}
              busy={busy || flowBusy}
              draftFor={roleDraft}
              onChange={updateRoleDraft}
              onSave={(role) => void saveRole(role)}
            />
          ) : null}
          <FlowPanel
            atomicItems={filteredFlowItems}
            eligibleCount={eligibleFlowItems.length}
            selected={flowSelected}
            selectedItems={selectedFlowItems}
            query={flowQuery}
            onQuery={setFlowQuery}
            onToggle={(id) => {
              const checked = Boolean(flowSelected[id]);
              setFlowSelected((current) => ({ ...current, [id]: !current[id] }));
              setFlowOrder((current) =>
                checked ? current.filter((item) => item !== id) : [...current, id],
              );
              setFlowDraft(null);
              setCreatedFlow(null);
            }}
            onMove={(id, delta) => {
              setFlowOrder((current) => {
                const index = current.indexOf(id);
                const next = index + delta;
                if (index < 0 || next < 0 || next >= current.length) return current;
                const copy = [...current];
                [copy[index], copy[next]] = [copy[next]!, copy[index]!];
                return copy;
              });
              setFlowDraft(null);
              setCreatedFlow(null);
            }}
            flowKind={flowKind}
            onKind={(value) => {
              setFlowKind(value);
              setFlowDraft(null);
              setCreatedFlow(null);
            }}
            flowTitle={flowTitle}
            onFlowTitle={(value) => {
              setFlowTitle(value);
              setFlowDraft(null);
              setCreatedFlow(null);
            }}
            flowEnv={flowEnv}
            onFlowEnv={setFlowEnv}
            businessMap={businessMap}
            businessSystemId={businessSystemId}
            onBusinessSystem={(value) => {
              setBusinessSystemId(value);
              setBusinessFlowId('');
              setFlowDraft(null);
              setCreatedFlow(null);
            }}
            businessFlowId={businessFlowId}
            onBusinessFlow={(value) => {
              setBusinessFlowId(value);
              setFlowDraft(null);
              setCreatedFlow(null);
            }}
            businessFlowOptions={businessFlowOptions}
            autoSupplementBusinessMap={autoSupplementBusinessMap}
            onAutoSupplement={(value) => {
              setAutoSupplementBusinessMap(value);
              setFlowDraft(null);
              setCreatedFlow(null);
            }}
            flowDraft={flowDraft}
            createdFlow={createdFlow}
            flows={flows}
            roleMissing={flowMissingRoleBindings}
            project={project}
            busy={flowBusy}
            runningFlowId={runningFlowId}
            flowRun={flowRun}
            onRun={(flow) => void runFlow(flow)}
            onOpenSession={openGenerationSession}
          />
        </>
      )}
    </SlideOverDrawer>
  );
}

function AssessmentPreview({
  assessment,
  cases,
  selected,
  counts,
  onToggle,
}: {
  assessment: CaseAutomationAssessment;
  cases: CaseAutomationAssessmentItem[];
  selected: Record<string, boolean>;
  counts: {
    auto: number;
    manual: number;
    automatable: number;
    needsManual: number;
    notAutomatable: number;
    flowRequired: number;
  };
  onToggle: (id: string) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-[#f5f8ff] px-3 py-2 text-xs text-stone-600">
        目标项目：{assessment.projectName} · 迭代 {assessment.iteration} ·{' '}
        {assessment.iterationFile}
      </div>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-700">
          自动 {counts.auto}
        </span>
        <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-700">
          手动 {counts.manual}
        </span>
        <span className="rounded-full bg-stone-100 px-2 py-1 text-stone-600">
          可自动化 {counts.automatable}
        </span>
        <span className="rounded-full bg-orange-50 px-2 py-1 text-orange-700">
          需流程 {counts.flowRequired}
        </span>
        <span className="rounded-full bg-stone-100 px-2 py-1 text-stone-500">
          需人工 {counts.needsManual} · 不适用 {counts.notAutomatable}
        </span>
      </div>
      {cases.map((item) => (
        <AssessmentCard
          key={item.sourceCaseId}
          item={item}
          selected={selected}
          onToggle={onToggle}
        />
      ))}
      {!cases.length ? (
        <div className="rounded-lg border border-dashed border-stone-200 px-4 py-10 text-center text-sm text-stone-400">
          没有符合当前筛选条件的评估结果
        </div>
      ) : null}
    </section>
  );
}

function AssessmentCard({
  item,
  selected,
  onToggle,
}: {
  item: CaseAutomationAssessmentItem;
  selected: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  const auto = item.executionMode === 'auto';
  return (
    <article className="rounded-xl border border-stone-200 bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-stone-800">
              {item.sourceTitle}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] ${DECISION_TONE[item.decision]}`}
            >
              {DECISION_LABEL[item.decision]}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] ${
                auto ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
              }`}
            >
              {EXECUTION_LABEL[item.executionMode]}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            {item.sourceCaseNo ? `#${item.sourceCaseNo} · ` : ''}
            {item.reason || '无评估说明'}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-stone-500">
            <span className="rounded bg-stone-100 px-1.5 py-0.5">
              稳定性：{STABILITY_LABEL[item.stability]}
            </span>
            <span className="rounded bg-stone-100 px-1.5 py-0.5">
              需流程：{item.flowRequired ? '是' : '否'}
            </span>
            <span className="rounded bg-stone-100 px-1.5 py-0.5">
              门禁：{item.gateEligible ? '可进入' : '不进入'}
            </span>
            <span className="rounded bg-stone-100 px-1.5 py-0.5">
              范围：{SCOPE_LABEL[item.scopeAction]}
            </span>
            {item.requiredRoles.length ? (
              <span className="rounded bg-stone-100 px-1.5 py-0.5">
                角色：{item.requiredRoles.map((role) => role.roleName).join('、')}
              </span>
            ) : null}
          </div>
          {item.risks.length ? (
            <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-[11px] leading-5 text-red-700">
              风险：{item.risks.join('；')}
            </p>
          ) : null}
        </div>
      </div>
      {item.executionMode === 'manual' ? (
        <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          手动执行原因：{item.manualReason || item.reason || '需人工补充前置条件'}
        </div>
      ) : null}
      {item.automationCases.length ? (
        <div className="mt-3 space-y-2">
          {item.automationCases.map((automationCase) => {
            const checked = Boolean(selected[automationCase.automationCaseId]);
            return (
              <label
                key={automationCase.automationCaseId}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition ${
                  checked
                    ? 'border-[#9cbaf2] bg-[#f7faff]'
                    : 'border-stone-200 bg-stone-50 hover:border-stone-300'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(automationCase.automationCaseId)}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-stone-700">
                      {automationCase.title}
                    </span>
                    <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[9px] text-stone-500 ring-1 ring-stone-200">
                      {automationCase.automationCaseId}
                    </span>
                    <span className="text-[10px] text-stone-400">
                      {automationCase.priority} · {automationCase.automationTag}
                    </span>
                    {automationCase.flowOnly ? (
                      <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-700">
                        仅流程运行
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block line-clamp-2 text-[11px] leading-5 text-stone-500">
                    {automationCase.steps.join(' → ') || '步骤待探索'}
                  </span>
                  <span className="mt-1 block text-[11px] text-emerald-700">
                    {automationCase.expected}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

function RoleBindingPanel({
  roles,
  project,
  drafts,
  busy,
  draftFor,
  onChange,
  onSave,
}: {
  roles: Array<{ roleId: string; roleName: string; reason: string }>;
  project: UiAutoProject | null;
  drafts: Record<string, NonNullable<UiAutoProject['roles']>[number]>;
  busy: boolean;
  draftFor: (role: {
    roleId: string;
    roleName: string;
  }) => NonNullable<UiAutoProject['roles']>[number];
  onChange: (
    role: { roleId: string; roleName: string },
    field: 'description' | 'usernameEnv' | 'passwordEnv' | 'storageState',
    value: string,
  ) => void;
  onSave: (role: { roleId: string; roleName: string }) => void;
}) {
  return (
    <section className="shrink-0 rounded-xl border border-orange-200 bg-orange-50/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-stone-800">角色与登录态</h3>
          <p className="mt-1 text-xs leading-5 text-stone-600">
            只保存环境变量名和 storageState 路径，不保存账号密码。每个角色独立 Browser Context。
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {roles.map((role) => {
          const draft = drafts[role.roleId] || draftFor(role);
          const bound = project?.roles?.find((item) => item.id === role.roleId);
          const savedReady = bound?.status === 'ready' && bound.storageState === draft.storageState;
          return (
            <div key={role.roleId} className="rounded-lg border border-orange-100 bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-medium text-stone-800">{role.roleName}</span>
                  <span className="ml-2 font-mono text-[10px] text-stone-400">{role.roleId}</span>
                </div>
                {statusBadge(
                  savedReady ? 'passed' : 'needs_role',
                  savedReady ? '已绑定' : draft.storageState ? '未验证' : '待绑定',
                )}
              </div>
              <p className="mt-1 text-[11px] leading-5 text-stone-500">
                {role.reason || '该用例执行需要此角色'}
              </p>
              <input
                value={draft.description}
                onChange={(event) => onChange(role, 'description', event.target.value)}
                placeholder="权限或职责说明，如可创建并提交工单"
                className="mt-2 h-8 w-full rounded-md border border-stone-200 px-2 text-[11px] outline-none focus:border-[#4176e6]"
              />
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                <input
                  value={draft.usernameEnv}
                  onChange={(event) => onChange(role, 'usernameEnv', event.target.value)}
                  placeholder="账号环境变量，如 CLERK_USER"
                  className="h-8 rounded-md border border-stone-200 px-2 font-mono text-[11px] outline-none focus:border-[#4176e6]"
                />
                <input
                  value={draft.passwordEnv}
                  onChange={(event) => onChange(role, 'passwordEnv', event.target.value)}
                  placeholder="密码环境变量，如 CLERK_PASS"
                  className="h-8 rounded-md border border-stone-200 px-2 font-mono text-[11px] outline-none focus:border-[#4176e6]"
                />
                <input
                  value={draft.storageState}
                  onChange={(event) => onChange(role, 'storageState', event.target.value)}
                  placeholder="storageState，如 auth/clerk.json"
                  className="h-8 rounded-md border border-stone-200 px-2 font-mono text-[11px] outline-none focus:border-[#4176e6]"
                />
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] text-stone-400">
                  {bound?.status === 'invalid'
                    ? `登录态无效：${bound.storageState}`
                    : bound?.storageState
                      ? `已保存：${bound.storageState}`
                      : 'storageState 缺失时不能生成或运行脚本'}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSave(role)}
                  className="h-7 rounded-md border border-[#b8cdf7] px-2.5 text-xs font-medium text-[#275fc8] hover:bg-[#f2f6ff] disabled:opacity-40"
                >
                  保存角色
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FlowPanel({
  atomicItems,
  eligibleCount,
  selected,
  selectedItems,
  query,
  onQuery,
  onToggle,
  onMove,
  flowKind,
  onKind,
  flowTitle,
  onFlowTitle,
  flowEnv,
  onFlowEnv,
  businessMap,
  businessSystemId,
  onBusinessSystem,
  businessFlowId,
  onBusinessFlow,
  businessFlowOptions,
  autoSupplementBusinessMap,
  onAutoSupplement,
  flowDraft,
  createdFlow,
  flows,
  roleMissing,
  project,
  busy,
  runningFlowId,
  flowRun,
  onRun,
  onOpenSession,
}: {
  atomicItems: AtomicItem[];
  eligibleCount: number;
  selected: Record<string, boolean>;
  selectedItems: AtomicItem[];
  query: string;
  onQuery: (value: string) => void;
  onToggle: (id: string) => void;
  onMove: (id: string, delta: number) => void;
  flowKind: 'smoke' | 'regression';
  onKind: (value: 'smoke' | 'regression') => void;
  flowTitle: string;
  onFlowTitle: (value: string) => void;
  flowEnv: string;
  onFlowEnv: (value: string) => void;
  businessMap: BusinessMapStore | null;
  businessSystemId: string;
  onBusinessSystem: (value: string) => void;
  businessFlowId: string;
  onBusinessFlow: (value: string) => void;
  businessFlowOptions: BusinessFlow[];
  autoSupplementBusinessMap: boolean;
  onAutoSupplement: (value: boolean) => void;
  flowDraft: CaseAutomationFlowDraft | null;
  createdFlow: CaseAutomationFlowCase | null;
  flows: CaseAutomationFlowCase[];
  roleMissing: string[];
  project: UiAutoProject | null;
  busy: boolean;
  runningFlowId: string;
  flowRun: CaseAutomationBatch | null;
  onRun: (flow: CaseAutomationFlowCase) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <section className="rounded-xl border border-stone-200 bg-white p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-stone-800">选择流程检查点</h3>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              只组合已接入的原子自动化用例。单条功能用例不需要流程；跨角色、跨页面或依赖前序数据时再补充。
            </p>
          </div>
          <span className="shrink-0 text-xs text-stone-400">
            可选 {eligibleCount} · 已选 {selectedItems.length}
          </span>
        </div>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索原子用例编号、标题或来源功能用例"
          className="mt-3 h-9 w-full rounded-lg border border-stone-200 px-3 text-sm outline-none focus:border-[#4176e6]"
        />
        <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
          {atomicItems.map((item) => {
            const checked = Boolean(selected[item.automationCaseId]);
            const missing = [
              ...(item.actorRoleId ? [item.actorRoleId] : []),
              ...(item.requiredRoleIds || []),
            ].some((roleId) => {
              const role = project?.roles?.find((entry) => entry.id === roleId);
              return !role?.storageState || role.status === 'invalid';
            });
            return (
              <label
                key={item.automationCaseId}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 ${
                  checked ? 'border-[#9cbaf2] bg-[#f7faff]' : 'border-stone-200 hover:bg-stone-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(item.automationCaseId)}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800">
                      {item.title}
                    </span>
                    {statusBadge(
                      missing ? 'needs_role' : item.status,
                      missing ? '缺角色' : SOURCE_STATUS_LABEL[item.status] || item.status,
                    )}
                  </span>
                  <span className="mt-1 block text-[11px] text-stone-500">
                    {item.automationCaseId} · 来源 {item.sourceCaseNo || item.sourceCaseId} ·{' '}
                    {item.sourceTitle}
                  </span>
                  <span className="mt-1 block text-[10px] text-stone-400">
                    {[item.module, item.priority, item.actorRoleId].filter(Boolean).join(' · ')}
                  </span>
                  {item.flowOnly ? (
                    <span className="mt-1 block text-[10px] text-amber-700">
                      依赖前序流程数据，只能通过冒烟/回归流程运行
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {!atomicItems.length ? (
            <div className="rounded-lg border border-dashed border-stone-200 px-4 py-8 text-center text-sm text-stone-400">
              {eligibleCount
                ? '没有符合搜索条件的原子用例'
                : '还没有已接入的原子自动化用例，请先在左侧生成并完成探索'}
            </div>
          ) : null}
        </div>
        {roleMissing.length ? (
          <div className="mt-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
            缺少角色登录态：
            {roleMissing
              .map((roleId) => project?.roles?.find((role) => role.id === roleId)?.name || roleId)
              .join('、')}
          </div>
        ) : null}
        {selectedItems.length ? (
          <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-2">
            <p className="text-[11px] font-medium text-stone-600">流程执行顺序</p>
            <div className="mt-1.5 space-y-1">
              {selectedItems.map((item, index) => (
                <div
                  key={item.automationCaseId}
                  className="flex items-center gap-2 rounded-md bg-white px-2 py-1.5 text-[11px]"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#edf3ff] font-semibold text-[#275fc8]">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-stone-700">{item.title}</span>
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => onMove(item.automationCaseId, -1)}
                    className="rounded px-1 text-stone-500 hover:bg-stone-100 disabled:opacity-20"
                    aria-label="上移"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === selectedItems.length - 1}
                    onClick={() => onMove(item.automationCaseId, 1)}
                    className="rounded px-1 text-stone-500 hover:bg-stone-100 disabled:opacity-20"
                    aria-label="下移"
                  >
                    ↓
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="grid gap-3 rounded-xl border border-stone-200 bg-stone-50 p-3 md:grid-cols-2">
        <label>
          <span className="mb-1 block text-xs font-medium text-stone-600">流程类型</span>
          <SelectDropdown
            value={flowKind}
            onChange={(value) => onKind(value === 'regression' ? 'regression' : 'smoke')}
            options={[
              { value: 'smoke', label: '冒烟：核心链路最少检查点' },
              { value: 'regression', label: '回归：完整业务链路' },
            ]}
            ariaLabel="流程类型"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs font-medium text-stone-600">流程标题</span>
          <input
            value={flowTitle}
            onChange={(event) => onFlowTitle(event.target.value)}
            placeholder={flowKind === 'smoke' ? '例如：工单受理并派发' : '例如：工单全生命周期回归'}
            className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm outline-none focus:border-[#4176e6]"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs font-medium text-stone-600">运行环境 ENV</span>
          <input
            value={flowEnv}
            onChange={(event) => onFlowEnv(event.target.value)}
            placeholder="留空使用项目默认 .env；例如 test / uat"
            className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm outline-none focus:border-[#4176e6]"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs font-medium text-stone-600">业务系统</span>
          <SelectDropdown
            value={businessSystemId}
            onChange={onBusinessSystem}
            options={[
              { value: '', label: '不关联业务地图' },
              ...(businessMap?.systems || []).map((system) => ({
                value: system.id,
                label: system.name,
                secondary: `${system.functions.length} 个功能 · ${system.flows.length} 条流程`,
              })),
            ]}
            ariaLabel="业务系统"
            searchable
            searchPlaceholder="搜索业务系统…"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs font-medium text-stone-600">已有业务流程</span>
          <SelectDropdown
            value={businessFlowId}
            onChange={onBusinessFlow}
            options={[
              { value: '', label: '新建流程' },
              ...businessFlowOptions.map((flow) => ({
                value: flow.id,
                label: flow.name,
                secondary: flow.result || `${flow.steps.length} 步`,
              })),
            ]}
            ariaLabel="已有业务流程"
            searchable
            searchPlaceholder="搜索业务流程…"
            disabled={!businessSystemId}
          />
        </label>
        <label className="flex items-start gap-2 rounded-lg border border-stone-200 bg-white p-3 md:col-span-2">
          <input
            type="checkbox"
            checked={autoSupplementBusinessMap}
            onChange={(event) => onAutoSupplement(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-medium text-stone-700">
              自动补齐业务地图目录、功能和流程步骤
            </span>
            <span className="mt-1 block text-xs leading-5 text-stone-500">
              只追加缺失内容，不覆盖人工锁定字段；生成前先展示补丁预览，业务地图 revision
              冲突时整批中止。
            </span>
          </span>
        </label>
        {autoSupplementBusinessMap && !businessSystemId ? (
          <p className="text-[11px] text-orange-700 md:col-span-2">
            要自动补齐业务地图，请先选择业务系统；如果本次只生成脚本，可取消上面的勾选。
          </p>
        ) : null}
      </section>

      {flowDraft ? (
        <FlowPreview draft={flowDraft} createdFlow={createdFlow} onOpenSession={onOpenSession} />
      ) : null}

      <section className="rounded-xl border border-stone-200 bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-stone-800">已生成的流程用例</h3>
          <span className="text-xs text-stone-400">{flows.length} 条</span>
        </div>
        <div className="mt-2 space-y-2">
          {flows.map((flow) => (
            <article key={flow.flowCaseId} className="rounded-lg border border-stone-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-stone-800">{flow.title}</span>
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] text-stone-600">
                  {flow.kind === 'smoke' ? '冒烟' : '回归'}
                </span>
                {statusBadge(flow.status === 'connected' ? 'connected' : flow.status)}
                {flow.gateEligible ? (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">
                    门禁可用
                  </span>
                ) : null}
              </div>
              <p className="mt-1 font-mono text-[10px] text-stone-400">
                {flow.flowCaseId} · {flow.scriptPath || flow.iterationFile}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                {flow.checkpoints.length} 个检查点 ·{' '}
                {flow.requiredRoles.map((role) => role.roleName).join('、')}
              </p>
              {flow.failureSummary ? (
                <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                  {flow.failureSummary}
                </p>
              ) : null}
              {flow.checkpointResults?.length ? (
                <div className="mt-2 grid gap-1 md:grid-cols-2">
                  {flow.checkpointResults.map((checkpoint) => (
                    <div
                      key={checkpoint.id}
                      className="flex items-center justify-between gap-2 rounded-md bg-stone-50 px-2 py-1.5 text-[10px]"
                    >
                      <span className="min-w-0 truncate text-stone-600">{checkpoint.title}</span>
                      <span
                        className={
                          checkpoint.status === 'passed'
                            ? 'text-emerald-700'
                            : checkpoint.status === 'failed' || checkpoint.status === 'blocked'
                              ? 'text-red-700'
                              : 'text-stone-400'
                        }
                      >
                        {CHECKPOINT_LABEL[checkpoint.status || 'pending']}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={busy || Boolean(runningFlowId)}
                  onClick={() => onRun(flow)}
                  className="mr-2 h-7 rounded-md border border-[#b8cdf7] px-2.5 text-xs font-medium text-[#275fc8] hover:bg-[#f2f6ff] disabled:opacity-40"
                >
                  {runningFlowId === flow.flowCaseId
                    ? `运行中${flowRun ? ` · ${flowRun.status}` : ''}`
                    : '运行流程'}
                </button>
                <button
                  type="button"
                  disabled={busy || !flow.uiSessionId}
                  onClick={() => onOpenSession(flow.uiSessionId)}
                  className="h-7 rounded-md border border-stone-200 px-2.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-40"
                >
                  打开生成会话
                </button>
              </div>
            </article>
          ))}
          {!flows.length ? (
            <div className="rounded-lg border border-dashed border-stone-200 px-4 py-8 text-center text-sm text-stone-400">
              还没有冒烟或回归流程用例
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function FlowPreview({
  draft,
  createdFlow,
  onOpenSession,
}: {
  draft: CaseAutomationFlowDraft;
  createdFlow: CaseAutomationFlowCase | null;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <section className="rounded-xl border border-[#b8cdf7] bg-[#f7faff] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-stone-800">
            {createdFlow ? '流程已生成' : '确认流程预览'}
          </h3>
          <p className="mt-1 font-mono text-[10px] text-stone-500">
            {draft.flowCaseId} · {draft.scriptPath}
          </p>
        </div>
        {createdFlow ? (
          <button
            type="button"
            onClick={() => onOpenSession(draft.uiSessionId || createdFlow.uiSessionId)}
            className="h-8 rounded-md bg-[#4176e6] px-3 text-xs font-medium text-white"
          >
            打开生成会话并试跑
          </button>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {draft.checkpoints.map((checkpoint, index) => (
          <div key={checkpoint.id} className="rounded-lg border border-white bg-white p-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#edf3ff] text-[10px] font-semibold text-[#275fc8]">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">
                {checkpoint.title}
              </span>
              <span className="text-[10px] text-stone-400">
                {checkpoint.actorRoleId || '未指定角色'}
              </span>
            </div>
          </div>
        ))}
      </div>
      {draft.mapPatch ? (
        <div className="mt-3 rounded-lg border border-sky-100 bg-white p-3">
          <p className="text-xs font-medium text-stone-700">业务地图补全预览</p>
          <div className="mt-2 grid gap-2 text-[11px] md:grid-cols-3">
            <PatchStat label="新增目录" value={draft.mapPatch.createdDirectories?.length || 0} />
            <PatchStat label="新增功能" value={draft.mapPatch.addedFunctions?.length || 0} />
            <PatchStat label="新增流程步骤" value={draft.mapPatch.addedStepTitles?.length || 0} />
          </div>
          {draft.mapPatch.createdDirectories?.length ? (
            <p className="mt-2 text-[11px] leading-5 text-stone-500">
              目录：{draft.mapPatch.createdDirectories.map((item) => item.name).join(' / ')}
            </p>
          ) : null}
          {draft.mapPatch.addedFunctions?.length ? (
            <p className="mt-1 text-[11px] leading-5 text-stone-500">
              功能：{draft.mapPatch.addedFunctions.map((item) => item.name).join('、')}
            </p>
          ) : null}
          {draft.mapPatch.addedStepTitles?.length ? (
            <p className="mt-1 text-[11px] leading-5 text-stone-500">
              步骤：{draft.mapPatch.addedStepTitles.join(' → ')}
            </p>
          ) : null}
        </div>
      ) : null}
      {draft.codePreview ? (
        <details className="mt-3 rounded-lg border border-stone-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-stone-700">
            查看生成的 Playwright 流程脚本
          </summary>
          <pre className="max-h-72 overflow-auto border-t border-stone-100 bg-stone-950 p-3 text-[10px] leading-5 text-stone-100">
            {draft.codePreview}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

function PatchStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-stone-50 px-2 py-2">
      <span className="block text-[10px] text-stone-400">{label}</span>
      <span className="mt-0.5 block text-sm font-semibold text-stone-700">{value}</span>
    </div>
  );
}
